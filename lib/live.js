/**
 * 跨机实时状态（生产 + 聚合）：本机会话状态生产、对端轮询、聚合与未读落盘。
 *
 * 从 lib/index.js 原样搬出（重构第 7 刀，行为一个字节都没改；原 region
 * 「跨机实时状态（生产 + 聚合）」整体搬迁）。
 *
 * 依赖：node:http / node:https / node:fs / node:path；dshHome 来自 ./logging.js；
 * warn / info / messageOf / unrefTimer 来自 ./util.js；writeText / writeJson 来自 ./proxy.js；
 * 其余（LIVE_* 常量、会话/cookie 辅助、可达性账本等）由宿主半（./index.js）通过
 * configureLive() 注入，**不 import ./index.js** —— 避免循环引用。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";

import { dshHome } from "./logging.js";
import { info, messageOf, unrefTimer, warn } from "./util.js";

import { writeJson, writeText } from "./proxy.js";

/**
 * 宿主半（./index.js）注入的依赖 —— 用依赖注入而不是 import ./index.js，
 * 避免 index ↔ 本文件 的 ESM 循环引用（也避免为了内部符号去扩大 index.js 的 export 面）。
 * 由 index.js 在模块求值末尾调用 configureLive() 注入；本文件的函数只在**调用时**访问这些绑定。
 */
// LIVE_* 常量：LIVE_APPROVAL_ASKED / LIVE_APPROVAL_DECIDED / LIVE_ASK_TOOL / LIVE_FILE_NAME / LIVE_PENDING_EVENT / LIVE_POLL_MS / LIVE_SEEN_PATH / LIVE_TAIL_N / PEER_LIVE_MAX_BYTES / PEER_LIVE_PATH / PEER_LIVE_SEEN_PATH / PEER_LIVE_TIMEOUT_MS / VIEW_PATH / VERSION / USER_AGENT
// 设备 / 会话 cookie / 请求体：authorizeTrustedRequest / captureSession / clearAuthNotice / cookieHeaderFor / deviceMatchesLocal / ensureSession / forgetSession / inlineJson / noteAuthRejected / readJsonBody
// 可达性账本 / 数据文件热重载：markReach / maybeReloadData / probeBackoffDue
let LIVE_APPROVAL_ASKED, LIVE_APPROVAL_DECIDED, LIVE_ASK_TOOL, LIVE_FILE_NAME,
	LIVE_PENDING_EVENT, LIVE_POLL_MS, LIVE_SEEN_PATH, LIVE_TAIL_N,
	PEER_LIVE_MAX_BYTES, PEER_LIVE_PATH, PEER_LIVE_SEEN_PATH, PEER_LIVE_TIMEOUT_MS,
	VIEW_PATH, VERSION, USER_AGENT, authorizeTrustedRequest,
	captureSession, clearAuthNotice, cookieHeaderFor, deviceMatchesLocal,
	ensureSession, forgetSession, inlineJson, noteAuthRejected,
	readJsonBody, markReach, maybeReloadData, probeBackoffDue;
export function configureLive(deps) {
	({
		LIVE_APPROVAL_ASKED, LIVE_APPROVAL_DECIDED, LIVE_ASK_TOOL, LIVE_FILE_NAME,
		LIVE_PENDING_EVENT, LIVE_POLL_MS, LIVE_SEEN_PATH, LIVE_TAIL_N,
		PEER_LIVE_MAX_BYTES, PEER_LIVE_PATH, PEER_LIVE_SEEN_PATH, PEER_LIVE_TIMEOUT_MS,
		VIEW_PATH, VERSION, USER_AGENT, authorizeTrustedRequest,
		captureSession, clearAuthNotice, cookieHeaderFor, deviceMatchesLocal,
		ensureSession, forgetSession, inlineJson, noteAuthRejected,
		readJsonBody, markReach, maybeReloadData, probeBackoffDue
	} = deps);
}

//#region 跨机实时状态（生产 + 聚合）

/**
 * 跨机实时状态：**生产**（本机 running/pending/unread）+ **聚合**（本机 + 每台对端）。
 *
 * 形状（客户端半下一刀照这个写；见 README）：
 *  - 本机页面口（**回环守卫**，与 `/plugin/remote/state` 同一套，见 handlePluginRequest 顶部那道）：
 *      `GET  /plugin/remote/live`      → `{ at, self:{name,live}, peers:[{id,name,reachable,lastError,live|null}] }`
 *      `POST /plugin/remote/live/seen` body `{id}`（缺省/空串/未知/本机 id = 本机）→ 清 unread，回**同一形状**
 *  - 跨机取数口（**非 `/plugin/` 前缀**，守卫 = 官方"可信请求"判定 {@link authorizeTrustedRequest}）：
 *      `GET  /dsh-remote-live`         → `{ at, live }` —— 只有**这台机器自己**（绝不回聚合结果，避免递归）
 *      `POST /dsh-remote-live/seen`    → 清本机 unread，回 `{ at, live }`
 *
 * 生产者的语义与探针插件（`@local/dsh-device-panel`）**逐条一致**（这边是拷贝并改名，不 import）：
 *  - `running` = `ctx.sessionController.list()` 里 `running === true` 的条数（灰圈的权威来源）；
 *  - `pending` = `running === true` 里**卡在等用户回答/批准**的**会话条数**（琥珀）；
 *    判据来自尾页事件、**不是** `projections.values.userQuestions.active`（真机实测那个源恒为 0，
 *    见 {@link livePendingOfItem} 的注释）；只对 running 的会话读尾页，任何一步失败都算 0、绝不抛；
 *  - `unread`  = running 由 >0 变 0 的那一瞬置 true 并**立刻落盘**，一直亮到客户端调 `seen` 清掉；
 *  - **首轮 `prevRunning === null` 不判完成**（否则重启就亮绿）；抛错只记一次日志、保持上一轮数值、绝不抛。
 *
 * 本机 unread 落盘走**独立文件** `$DSH_HOME/dsh-remote-live.json`（只有 `unread`/`doneAt`），
 * 与探针插件的 `dsh-device-panel-live.json` 互不干扰。
 *
 * 可达性语义（**关键**，页面据此决定画不画点/画不画红）：
 *  - 拿到**任何 HTTP 响应**（含 404/403 —— 对端还没升级时就是 404）⇒ `reachable:true`、`live:null`（不画点，**不画红**）；
 *  - 只有**超时/连接失败**这类网络错误 ⇒ `reachable:false` + `lastError`（才画红）；
 *  - 被认领为"本机"的那条设备**不进 peers**（本机自己永远不是红）。
 */

/** 本机未读落盘路径（`config.liveFile` 只为自测/特殊部署预留，与 `config.dataFile` 同一口径）。 */
function resolveLivePath(config) {
	const override = config !== null && typeof config === "object" && typeof config.liveFile === "string" ? config.liveFile.trim() : "";
	if (override !== "") return override;
	return join(dshHome(), LIVE_FILE_NAME);
}

/** 一个空的本机状态 + 对端缓存（`apply` 时放进 `runtime.live`）。 */
function createLiveState() {
	return {
		/** 会话服务（拿到 `list()` 才轮询）。 */
		controller: null,
		/** 轮询定时器。 */
		timer: null,
		/** 上一轮 list() 还在飞（慢响应时别叠请求）。 */
		busy: false,
		/** 对端那一轮还在飞。 */
		peersBusy: false,
		/** 上一轮的 running 条数（`null` = 还没有基准，首轮不判完成）。 */
		prevRunning: null,
		running: 0,
		pending: 0,
		/** 上一轮"琥珀"判定键（`"<sessionId>*"`），只在结果变化时写一条日志（别每 5 秒刷屏）。 */
		pendingKey: "",
		/** 累计读过多少次会话尾页（`page()` 调用计数；琥珀判定的开销就是它，自测也拿它断言）。 */
		pageCalls: 0,
		unread: false,
		doneAt: 0,
		/** 最近一次成功取数的时刻（0 = 还没成功过）。 */
		at: 0,
		/** 最近一次失败原因（同样的错只记一次日志）。 */
		lastError: "",
		/** 对端最近一次结果：id → `{ reachable, lastError, live|null }`。 */
		peers: new Map(),
	};
}

/** 取（必要时补）`runtime.live`；容错，绝不因为形状不对抛。 */
function liveStateOf(runtime) {
	if (runtime === null || typeof runtime !== "object") return createLiveState();
	if (runtime.live === null || runtime.live === undefined || typeof runtime.live !== "object") runtime.live = createLiveState();
	const state = runtime.live;
	if (!(state.peers instanceof Map)) state.peers = new Map();
	return state;
}

/** 未读标记的最终路径（`config.liveFile` 覆盖优先，否则 `$DSH_HOME/dsh-remote-live.json`）。 */
function liveFilePath(runtime) {
	const override = runtime !== null && typeof runtime === "object" && typeof runtime.livePath === "string" ? runtime.livePath.trim() : "";
	return override === "" ? join(dshHome(), LIVE_FILE_NAME) : override;
}

/** 读回上次的 unread/doneAt（没有文件 = 首次运行，全当没有）。失败静默。 */
function loadLiveUnread(runtime) {
	const state = liveStateOf(runtime);
	try {
		const parsed = JSON.parse(readFileSync(liveFilePath(runtime), "utf8"));
		if (parsed === null || typeof parsed !== "object") return;
		if (parsed.unread === true) state.unread = true;
		const doneAt = Number(parsed.doneAt);
		if (Number.isFinite(doneAt) && doneAt > 0) state.doneAt = doneAt;
		if (state.unread === true) info(runtime.ctx, `跨机实时状态：启动读回本机未读完成（doneAt=${String(state.doneAt)}），绿点不丢`);
	} catch {
		/* 没有文件 / 坏了：当没有 */
	}
}

/** 落盘 unread/doneAt。失败只告警（只是重启后绿点会丢），绝不影响功能。 */
function saveLiveUnread(runtime) {
	const state = liveStateOf(runtime);
	try {
		const path = liveFilePath(runtime);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ unread: state.unread === true, doneAt: liveStampOf(state.doneAt) }), "utf8");
		return true;
	} catch (error) {
		warn(runtime.ctx, `跨机实时状态：写入未读标记 ${liveFilePath(runtime)} 失败（重启后绿点会丢）：${messageOf(error)}`);
		return false;
	}
}

/** 计数清洗：非有限数 / 负数一律当 0。 */
function liveCountOf(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** 时间戳清洗：非有限数 / 非正数一律当 0。 */
function liveStampOf(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** 回给客户端的那 5 个字段（`self.live`、`peers[].live` 与跨机取数口的 `live` 是**同一个形状**）。 */
function liveViewOf(state) {
	return {
		running: liveCountOf(state.running),
		pending: liveCountOf(state.pending),
		unread: state.unread === true,
		doneAt: liveStampOf(state.doneAt),
		at: liveStampOf(state.at),
	};
}

/**
 * 从对端响应里洗出 `live`。只有"200 + 合法 JSON + `live` 是对象"才认；
 * 其余（404/403/HTML/半截 JSON/形状不对）一律 `null` —— 页面就"不画点"。
 */
function liveViewFromPeerBody(result) {
	if (result === null || typeof result !== "object" || result.status !== 200) return null;
	const value = result.json;
	if (value === null || typeof value !== "object") return null;
	const live = value.live;
	if (live === null || typeof live !== "object") return null;
	return {
		running: liveCountOf(live.running),
		pending: liveCountOf(live.pending),
		unread: live.unread === true,
		doneAt: liveStampOf(live.doneAt),
		at: liveStampOf(live.at),
	};
}

/** 一条会话尾页的**角色**：`""` = 没卡住（或尾页空旷/形状不认识）。 */
const LIVE_ROLE_NONE = "";
/** 这条会话尾页的最后一条是一条**没结算的** `ask_user_question` 调用。 */
const LIVE_ROLE_ASK = "ask";
/** 这条会话尾页里有一个**没结算的** `approval/asked`。 */
const LIVE_ROLE_APPROVAL = "approval";

/** 一条尾页记录的事件对象（形状不认识就返回 null）。 */
function liveTailEventOf(record) {
	if (record === null || typeof record !== "object") return null;
	const event = record.event;
	if (event === null || typeof event !== "object") return null;
	return event;
}

/**
 * 尾页记录 → "这条会话是不是卡在等用户"的角色。**只在"结算了没有"上判断**。
 *
 * 真机实测（2026-10-17 00:36）三种卡片的尾巴：
 *  1. 提问卡（单选/多选）⇒ 尾页**最后一条**是 `tool/call` + `data.name === "ask_user_question"`
 *     （计划批准也是这个工具）；结算 = 后面跟一条**同 `callId`** 的 `tool/result`。
 *  2. 权限审批卡 ⇒ 尾页出现 `approval/asked`（`data.id` / `data.callId`），**它之后没有**
 *     同 id 的 `approval/decided`（官方 `SessionEventMap` 里的结算事件就叫这个名字，`{ id, outcome }`）。
 *
 * 记录按 `seq` 升序（page 的语义）⇒ 一遍扫下来，每个 `approval/asked` 都记着"还没结算"，
 * 遇到同 id 的 `approval/decided` 就划掉；最后**还有没划掉的**才算卡住。
 * 任何形状不认识 ⇒ `""`（宁可不画琥珀，也绝不瞎画）。
 */
function liveTailRoleOf(records) {
	if (!Array.isArray(records)) return LIVE_ROLE_NONE;
	/** 最后一次 ask_user_question 工具调用的 callId（还没看到结算就一直挂着）。 */
	let askCallId = "";
	/** 还没结算的 approval/asked id。 */
	const undecided = new Set();
	/** 被同 callId 的 tool/result 结算掉的 ask 调用。 */
	const answered = new Set();
	for (const record of records) {
		const event = liveTailEventOf(record);
		if (event === null || typeof event.type !== "string") continue;
		const data = event.data !== null && typeof event.data === "object" ? event.data : {};
		if (event.type === LIVE_PENDING_EVENT && data.name === LIVE_ASK_TOOL) {
			askCallId = typeof data.callId === "string" ? data.callId : "";
			continue;
		}
		if (event.type === "tool/result") {
			// 只认同 callId 的结算；callId 认不出来时**不当成结算**（保守：继续算卡住）。
			const callId = typeof data.callId === "string" && data.callId !== ""
				? data.callId
				: (data.message !== null && typeof data.message === "object" && typeof data.message.toolCallId === "string" ? data.message.toolCallId : "");
			if (callId !== "" && callId === askCallId) answered.add(callId);
			continue;
		}
		if (event.type === LIVE_APPROVAL_ASKED) {
			// id 优先，退回 callId：两个都是官方 schema 里的字段，任缺其一都不算"问过"。
			const id = typeof data.id === "string" && data.id !== "" ? data.id : (typeof data.callId === "string" ? data.callId : "");
			if (id !== "") undecided.add(id);
			continue;
		}
		if (event.type === LIVE_APPROVAL_DECIDED) {
			const id = typeof data.id === "string" ? data.id : "";
			if (id !== "") undecided.delete(id);
		}
	}
	if (askCallId !== "" && !answered.has(askCallId)) return LIVE_ROLE_ASK;
	if (undecided.size > 0) return LIVE_ROLE_APPROVAL;
	return LIVE_ROLE_NONE;
}

/**
 * 一条 `running === true` 的 list 行 → 它是不是**卡在等用户回答/批准**（琥珀）。
 *
 * 为什么不用 `item.projections.values.userQuestions.active`：2026-10-17 真机实测（三张卡
 * ——单选提问 / 多选提问 / 权限审批——同时开着，`session/list` 123 条、4 条 `running=true`）
 * 里**每一条**的 `active` 都是 0；单独调 `session/projections` 拿实时值同样是 0。
 * 所以那个源判不出琥珀，尾页事件才是真信号（见 {@link liveTailRoleOf}）。
 *
 * 三步：`projections()` 拿 `asOfSeq` → `page({ address, throughSeq: asOfSeq, maxMessages })`
 * 读尾页（**只有带 `throughSeq` 才有 records**）→ 看尾页角色。
 * 任何一步抛错 / 形状不认识 / 没有 asOfSeq ⇒ **0**（宁可不画琥珀，也绝不瞎画、绝不抛）。
 */
async function livePendingOfItem(runtime, item) {
	const sessionId = item !== null && typeof item === "object" ? item.sessionId : undefined;
	if (typeof sessionId !== "string" || sessionId === "") return 0;
	const controller = runtime !== null && typeof runtime === "object" ? runtime.sessionController : undefined;
	if (controller === null || controller === undefined) return 0;
	if (typeof controller.projections !== "function" || typeof controller.page !== "function") return 0;
	try {
		const state = liveStateOf(runtime);
		const signal = new AbortController().signal;
		const projections = await controller.projections({ sessionId }, signal);
		const asOfSeq = projections !== null && typeof projections === "object" ? Number(projections.asOfSeq) : Number.NaN;
		if (!Number.isSafeInteger(asOfSeq)) return 0;
		state.pageCalls += 1;
		const page = await controller.page({
			address: { kind: "session", sessionId },
			throughSeq: asOfSeq,
			maxMessages: LIVE_TAIL_N,
		}, signal);
		const records = page !== null && typeof page === "object" && Array.isArray(page.records) ? page.records : [];
		return liveTailRoleOf(records) === LIVE_ROLE_NONE ? 0 : 1;
	} catch {
		// 失败安全：拿不到就当"没卡住"（这一条贡献 0），绝不往上抛。
		return 0;
	}
}

/** 取一轮**本机**状态（list 在进程内调，同样必须传 AbortSignal）。**绝不抛**。 */
async function pollLocalLive(runtime) {
	const state = liveStateOf(runtime);
	if (state.controller === null || state.busy === true) return;
	state.busy = true;
	try {
		const result = await state.controller.list({}, new AbortController().signal);
		const items = result !== null && typeof result === "object" && Array.isArray(result.items) ? result.items : [];
		const runningItems = [];
		for (const item of items) {
			if (item !== null && typeof item === "object" && item.running === true) runningItems.push(item);
		}
		const running = runningItems.length;
		// 琥珀 = running 里"卡在等用户回答/批准"的**会话条数**（只对这些读尾页，通常 0–3 条）。
		// 每一条都自己吞错（贡献 0），所以 123 条列表里只有几条会产生额外调用。
		const roles = await Promise.all(runningItems.map((item) => livePendingOfItem(runtime, item)));
		let pending = 0;
		const beenWaiting = [];
		for (let index = 0; index < roles.length; index += 1) {
			if (roles[index] !== 1) continue;
			pending += 1;
			const id = runningItems[index].sessionId;
			if (typeof id === "string") beenWaiting.push(id);
		}
		state.lastError = "";
		// 琥珀只在**结果变化**时写一条日志（别每 5 秒刷屏）。
		const pendingKey = pending === 0 ? "" : beenWaiting.slice().sort().join("*");
		if (pendingKey !== state.pendingKey) {
			state.pendingKey = pendingKey;
			info(runtime.ctx, pending === 0
				? "跨机实时状态：没有会话卡在等用户回答/批准（琥珀灭）"
				: `跨机实时状态：${String(pending)} 条会话卡在等用户回答/批准（琥珀亮）：${beenWaiting.join(", ")}`);
		}
		// "刚跑完"：有上一轮基准、上一轮在跑、这一轮不跑了 ⇒ 亮绿（**立刻落盘**）。
		// 首轮 `prevRunning === null` **不判完成**（否则重启就亮绿）。
		if (state.prevRunning !== null && state.prevRunning > 0 && running === 0) {
			state.unread = true;
			state.doneAt = Date.now();
			saveLiveUnread(runtime);
			info(runtime.ctx, `跨机实时状态：本机未读完成（running ${String(state.prevRunning)} → 0），等客户端调 ${LIVE_SEEN_PATH} 才清`);
		}
		state.prevRunning = running;
		state.running = running;
		state.pending = pending;
		state.at = Date.now();
	} catch (error) {
		// 取数失败**不能**当成"跑完了"（一次抖动就误报绿）：保持上一轮数值，同样的错只记一次日志。
		const message = messageOf(error);
		if (message !== state.lastError) {
			state.lastError = message;
			warn(runtime.ctx, `跨机实时状态：本机 sessionController.list() 失败（保持上一轮数值）：${message}`);
		}
	} finally {
		state.busy = false;
	}
}

/** 当前要轮询的对端 = 设备表里除"被认领为这台机器"的那条之外的全部。 */
function livePeerDevices(runtime) {
	const local = runtime !== null && typeof runtime === "object" ? runtime.localDevice : undefined;
	const devices = runtime !== null && typeof runtime === "object" && Array.isArray(runtime.devices) ? runtime.devices : [];
	return devices.filter((device) => device !== local && deviceMatchesLocal(device, runtime.facts) !== true);
}

/** 聚合里的对端节点（id/name 取设备配置；还没轮询过 = 乐观 `true` + `live:null`，绝不无端画红）。 */
function livePeerEntries(runtime) {
	const state = liveStateOf(runtime);
	return livePeerDevices(runtime).map((device) => {
		const seen = state.peers.get(device.id);
		return {
			id: device.id,
			name: typeof device.name === "string" && device.name !== "" ? device.name : device.id,
			reachable: seen === undefined ? true : seen.reachable === true,
			lastError: seen !== undefined && typeof seen.lastError === "string" ? seen.lastError : "",
			live: seen !== undefined && seen.live !== null && typeof seen.live === "object" ? seen.live : null,
		};
	});
}

/**
 * 本机在**设备配置里**的名字（被 `resolveLocalDevice` 认领的那条设备，auto 分支通常就是「设备A」）。
 * 没认领到设备 / 名字是空的 ⇒ 空串（客户端半退回写死的「本机」，绝不编名字）。
 */
function liveSelfNameOf(runtime) {
	const device = runtime !== null && typeof runtime === "object" ? runtime.localDevice : undefined;
	if (device === null || device === undefined || typeof device !== "object") return "";
	return typeof device.name === "string" ? device.name.trim() : "";
}

/**
 * 本机页面口 `GET /plugin/remote/live` 的聚合体（`at` = 构造这一刻）。
 * `self.name` = 本机被认领的那条设备的名字（**只加字段**，`self.live` 与 `peers[]` 形状一个字没动）。
 */
function buildLiveAggregate(runtime) {
	return {
		at: Date.now(),
		self: { name: liveSelfNameOf(runtime), live: liveViewOf(liveStateOf(runtime)) },
		peers: livePeerEntries(runtime),
	};
}

/** 跨机取数口的响应体：**只有这台机器自己**（绝不回聚合结果，避免递归取数）。 */
function buildSelfLivePayload(runtime) {
	return { at: Date.now(), live: liveViewOf(liveStateOf(runtime)) };
}

/**
 * 浏览器口 `GET /dsh-remote-view` 的响应体：**与页面口同形**的聚合 + **一个** `version` 字段。
 *
 * `version` = 本机 dsh-remote 的版本号（{@link VERSION}）；客户端半拿它与自己的版本常量对账，
 * 不一致只在 title / 日志里提示（**不改状态点的颜色**，见 `lib/client.js`）。
 * 刻意用「同一个 builder + 追加一个键」实现：`self` / `peers` 的形状与页面口**逐字段一致**，
 * 客户端半两条路由共用一个形状判据（`isLiveShape`）。
 */
function buildLiveView(runtime) {
	return { ...buildLiveAggregate(runtime), version: VERSION };
}

/**
 * **带凭据的 server-to-server 请求**（把 `probeDevice` 里那套泛化出来，见其调用处）。
 *
 * 相对 `probeDevice` 泛化了三点：
 *  1. `path` 参数化（`probeDevice` 硬编码 `GET /`）：按 `device.basePath` 拼前缀，通常就是原样；
 *  2. `{ method, body }`：body 是任意可 JSON 化的值（自动带 `content-type: application/json` 与 content-length）；
 *  3. **保留响应体**（限长）并尽力 `JSON.parse` 成 `json`（对端还没升级时是 HTML/404，`json` 就是 `null`）。
 *
 * 与 `probeDevice` 同源的语义：Host/Origin 改写成设备的 authority/origin（对端的可信栅栏过得去）、
 * 带宿主侧会话 cookie（没配 token 时就是空手，对端回 401，也算"拿到了 HTTP 响应"）、
 * 401 时丢掉缓存会话让下次重新兑换、可达性记进 `markReach`（体检页复用同一份账）。
 *
 * **超时**：连接/首字节 `timeoutMs`（缺省 {@link PEER_LIVE_TIMEOUT_MS}）—— 到点 destroy 上游并当网络错误。
 * **限长**：最多收 `maxBytes`（缺省 {@link PEER_LIVE_MAX_BYTES}）字节，超了立刻截断并 destroy（`truncated:true`）。
 *
 * @returns `{ ok, status, ms, error, body, json, truncated }`。`status === null` 表示**网络错误**
 *   （超时/连接失败 —— 这才是"不可达"）；非 null 表示拿到了任何 HTTP 响应（含 404/403）。
 */
function fetchPeerPath(runtime, device, path, options) {
	// 兜底：设备条目无效（缺 id / 不是对象）时**绝不抛**（`ensureSession` 里会解引用 device.id，
	// 一次漏网就是宿主进程级的未处理拒绝），当成"网络不可达"直接回报。
	if (device === null || typeof device !== "object" || typeof device.id !== "string" || device.id === "") {
		return Promise.resolve({ ok: false, status: null, ms: 0, error: "设备条目无效（缺少 id）", body: null, json: null, truncated: false });
	}
	const opts = options !== null && typeof options === "object" ? options : {};
	const method = typeof opts.method === "string" && opts.method.trim() !== "" ? opts.method.trim().toUpperCase() : "GET";
	const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : PEER_LIVE_TIMEOUT_MS;
	const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : PEER_LIVE_MAX_BYTES;
	let payload = null;
	if (method !== "GET" && method !== "HEAD" && opts.body !== undefined && opts.body !== null) {
		try {
			payload = Buffer.from(inlineJson(opts.body), "utf8");
		} catch {
			payload = Buffer.from("{}", "utf8");
		}
	}
	const started = Date.now();
	return new Promise((resolve) => {
		let settled = false;
		let upstreamHost = null;
		const finish = (status, error, body, truncated) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const ms = Date.now() - started;
			if (status === null) {
				const reason = error === null || error === undefined || error === "" ? "网络不可达" : String(error);
				markReach(runtime, device.id, false, reason);
				resolve({ ok: false, status: null, ms, error: reason, body: null, json: null, truncated: truncated === true });
				return;
			}
			markReach(runtime, device.id, true, null);
			const text = body === null ? null : body.toString("utf8");
			let json = null;
			if (text !== null && text !== "") {
				try {
					json = JSON.parse(text);
				} catch {
					json = null;
				}
			}
			resolve({ ok: true, status, ms, error: null, body: text, json, truncated: truncated === true });
		};
		const timer = setTimeout(() => {
			try {
				if (upstreamHost !== null) upstreamHost.destroy(new Error(`连接超时（${String(timeoutMs)} ms）`));
			} catch {
				/* 忽略 */
			}
			finish(null, `连接超时（${String(timeoutMs)} ms）`);
		}, timeoutMs);
		unrefTimer(timer);
		ensureSession(device, runtime).then(() => {
			let target;
			try {
				target = new URL(`${device.origin}${device.basePath}${path}`);
			} catch (error) {
				finish(null, messageOf(error));
				return;
			}
			const send = device.protocol === "https:" ? httpsRequest : httpRequest;
			/** 当前这一发（重试时换新的；旧发的迟到事件靠 `current` 忽略）。 */
			let current = null;
			let attempt = 0;
			const attemptFetch = () => {
				const cookie = cookieHeaderFor(device, undefined, runtime);
				const headers = { host: device.authority, origin: device.origin, "user-agent": USER_AGENT, accept: "application/json" };
				if (cookie !== undefined) headers.cookie = cookie;
				if (payload !== null) {
					headers["content-type"] = "application/json";
					headers["content-length"] = String(payload.length);
				}
				let request;
				try {
					request = send({
						protocol: target.protocol,
						hostname: device.hostname,
						port: device.port === "" ? undefined : device.port,
						path: `${target.pathname}${target.search}`,
						method,
						headers,
					}, (response) => {
						if (current !== request) {
							response.resume();
							return;
						}
						const status = response.statusCode ?? 0;
						// 0.13.1：401/403 ⇒ 丢掉旧会话、用 token 重兑一次再试一次（请求体已缓冲，可安全重发）。
						if ((status === 401 || status === 403) && attempt === 0) {
							attempt += 1;
							response.resume();
							forgetSession(runtime, device, `跨机取数收到 HTTP ${String(status)}`);
							void ensureSession(device, runtime).then(attemptFetch, attemptFetch);
							return;
						}
						if (status === 401 || status === 403) noteAuthRejected(runtime, device, status);
						else clearAuthNotice(runtime, device.id);
						const setCookie = response.headers["set-cookie"];
						if (Array.isArray(setCookie) && setCookie.length > 0) captureSession(device, setCookie, runtime);
						const chunks = [];
						let size = 0;
						let truncated = false;
						response.on("data", (chunk) => {
							if (truncated) return;
							size += chunk.length;
							if (size > maxBytes) {
								// 限长：只留够 maxBytes 的那一段，立刻 destroy（不把对端的大响应读进内存）。
								truncated = true;
								chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
								const body = Buffer.concat(chunks);
								response.destroy();
								finish(status, null, body, true);
								return;
							}
							chunks.push(chunk);
						});
						// 截断过 / 已结束后到达的 end/error 都会被 finish 的幂等挡掉。
						response.on("end", () => finish(status, null, Buffer.concat(chunks), truncated));
						response.on("error", () => finish(status, null, Buffer.concat(chunks), truncated));
					});
				} catch (error) {
					finish(null, messageOf(error));
					return;
				}
				current = request;
				upstreamHost = request;
				request.on("error", (error) => {
					if (current !== request) return;
					finish(null, messageOf(error));
				});
				request.end(payload === null ? undefined : payload);
			};
			attemptFetch();
		}, (error) => finish(null, messageOf(error)));
	});
}

/** 问一台对端。可达性语义见本 region 顶部说明。 */
async function pollOnePeerLive(runtime, device) {
	const result = await fetchPeerPath(runtime, device, PEER_LIVE_PATH);
	const state = liveStateOf(runtime);
	if (result.status === null) {
		const reason = result.error === null ? "网络不可达" : String(result.error);
		state.peers.set(device.id, { reachable: false, lastError: reason, live: null });
		markReach(runtime, device.id, false, reason);
		return;
	}
	markReach(runtime, device.id, true, null);
	// 拿到了任何 HTTP 响应（含 404/403 = 对端还没升级）⇒ reachable=true；拿不到合法 live 就 null。
	state.peers.set(device.id, { reachable: true, lastError: "", live: liveViewFromPeerBody(result) });
}

/** 并发问一遍所有对端（每 5 秒一次；慢的一台不拖住别的）。 */
async function pollPeerLives(runtime) {
	const state = liveStateOf(runtime);
	if (state.peersBusy === true) return;
	state.peersBusy = true;
	try {
		await Promise.all(
			livePeerDevices(runtime)
				.filter((device) => probeBackoffDue(runtime, device.id))
				.map((device) => pollOnePeerLive(runtime, device)),
		);
	} finally {
		state.peersBusy = false;
	}
}

/** 清**这台机器自己**的未读。返回是否真的变了。 */
function clearLocalLiveUnread(runtime) {
	const state = liveStateOf(runtime);
	if (state.unread !== true) return false;
	state.unread = false;
	saveLiveUnread(runtime);
	return true;
}

/**
 * `POST /plugin/remote/live/seen`：`id` 空 / 未知 / 指向被认领为本机的那条 → 清**本机**未读；
 * 否则把"清未读"转给那台对端（`POST <对端>/dsh-remote-live/seen`）—— unread 住在对端自己的盘上，
 * 本机不能替它清，只能请它清（拿回来的就是它清完后的 `live`）。
 * @returns `{ ok, local, error }`（失败也只影响这一条，聚合照回，绝不抛）。
 */
async function markLiveSeen(runtime, rawId) {
	const state = liveStateOf(runtime);
	const id = typeof rawId === "string" ? rawId.trim() : "";
	const device = id === "" ? undefined : runtime.devices.find((entry) => entry.id === id);
	if (device === undefined || device === runtime.localDevice) {
		return { ok: true, local: true, error: null, cleared: clearLocalLiveUnread(runtime) };
	}
	const result = await fetchPeerPath(runtime, device, PEER_LIVE_SEEN_PATH, { method: "POST", body: {} });
	if (result.status === null) {
		const reason = result.error === null ? "网络不可达" : String(result.error);
		state.peers.set(device.id, { reachable: false, lastError: reason, live: null });
		return { ok: false, local: false, error: reason, cleared: false };
	}
	state.peers.set(device.id, { reachable: true, lastError: "", live: liveViewFromPeerBody(result) });
	return { ok: true, local: false, error: null, cleared: true };
}

/** 本机页面口：聚合读取 + 清未读（回环守卫已由 handlePluginRequest 顶部那道把住）。 */
async function handleLocalLiveRequest(runtime, req, res, method, headOnly, isSeen) {
	if (isSeen !== true) {
		if (method !== "GET" && method !== "HEAD") {
			writeJson(res, 405, { ok: false, error: `live 只支持 GET/HEAD（收到 ${method}）` }, headOnly);
			return;
		}
		writeJson(res, 200, buildLiveAggregate(runtime), headOnly);
		return;
	}
	if (method !== "POST") {
		writeJson(res, 405, { ok: false, error: `live/seen 只支持 POST（收到 ${method}）` }, headOnly);
		return;
	}
	const body = await readJsonBody(req);
	if (body.error !== undefined) {
		writeJson(res, 400, { ok: false, error: body.error }, headOnly);
		return;
	}
	const id = typeof body.value.id === "string" ? body.value.id : "";
	const outcome = await markLiveSeen(runtime, id);
	if (outcome.ok !== true) warn(runtime.ctx, `跨机实时状态：清对端 "${id === "" ? "?" : id}" 的未读失败：${String(outcome.error)}`);
	// **同形状**返回最新聚合（客户端半只认一种形状：`self` 对象 + `peers` 数组，`self.name` 是 0.11.0 加的字段）。
	writeJson(res, 200, buildLiveAggregate(runtime), headOnly);
}

/**
 * 跨机取数口的总入口（`/dsh-remote-live`，**非 `/plugin/` 前缀**所以能穿过对端 edge）。
 * 守卫 = 官方的"可信请求"判定（{@link authorizeTrustedRequest}），不是"仅回环"：
 * 来取数的是**别的机器上的本插件**，请求天然不来自回环，但会带 Host=本机 authority + 会话 cookie。
 */
async function handlePeerLiveRequest(runtime, req, res) {
	const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
	const headOnly = method === "HEAD";
	const trusted = authorizeTrustedRequest(runtime, req, "跨机实时状态");
	if (trusted.ok !== true) {
		writeText(res, trusted.status, `dsh-remote：${trusted.reason}\n`, headOnly);
		return;
	}
	maybeReloadData(runtime, false);
	let pathname = PEER_LIVE_PATH;
	try {
		pathname = new URL(typeof req.url === "string" && req.url !== "" ? req.url : "/", "http://local.invalid").pathname;
	} catch {
		pathname = PEER_LIVE_PATH;
	}
	if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.replace(/\/+$/u, "");
	if (pathname === PEER_LIVE_SEEN_PATH) {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `跨机取数 seen 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		// body 不参与语义，读掉即可（别让连接挂着）。
		await readJsonBody(req);
		clearLocalLiveUnread(runtime);
		writeJson(res, 200, buildSelfLivePayload(runtime), headOnly);
		return;
	}
	if (pathname === PEER_LIVE_PATH) {
		if (method !== "GET" && method !== "HEAD") {
			writeJson(res, 405, { ok: false, error: `跨机取数只支持 GET/HEAD（收到 ${method}）` }, headOnly);
			return;
		}
		writeJson(res, 200, buildSelfLivePayload(runtime), headOnly);
		return;
	}
	writeJson(res, 404, { ok: false, error: `unknown route: ${method} ${pathname}` }, headOnly);
}

/**
 * **浏览器口**的总入口（`/dsh-remote-view`，**非 `/plugin/` 前缀**所以能穿过 edge）。
 *
 * 守卫 = 官方的"可信请求"判定（{@link authorizeTrustedRequest}），**不是**"仅回环"：
 * 来取数的是**浏览器 / 手机**（经本机对外端口打开这个页面），它天然不来自回环，
 * 但带着 Host=本机 authority + `dsh-auth-*` 会话 cookie —— 与「另存为」那条路由同一把尺子。
 *
 * 只支持 GET/HEAD；返回 {@link buildLiveView}（与 `/plugin/remote/live` 同形的聚合 + `version`）。
 * 语义上与 `/dsh-remote-live` **完全不同**：那条只回本机自己、供别的机器取数，一个字都没动。
 */
async function handleViewRequest(runtime, req, res) {
	const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
	const headOnly = method === "HEAD";
	const trusted = authorizeTrustedRequest(runtime, req, "浏览器实时状态");
	if (trusted.ok !== true) {
		writeText(res, trusted.status, `dsh-remote：${trusted.reason}\n`, headOnly);
		return;
	}
	maybeReloadData(runtime, false);
	let pathname = VIEW_PATH;
	try {
		pathname = new URL(typeof req.url === "string" && req.url !== "" ? req.url : "/", "http://local.invalid").pathname;
	} catch {
		pathname = VIEW_PATH;
	}
	if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.replace(/\/+$/u, "");
	if (pathname !== VIEW_PATH) {
		writeJson(res, 404, { ok: false, error: `unknown route: ${method} ${pathname}` }, headOnly);
		return;
	}
	if (method !== "GET" && method !== "HEAD") {
		writeJson(res, 405, { ok: false, error: `浏览器实时状态只支持 GET/HEAD（收到 ${method}）` }, headOnly);
		return;
	}
	writeJson(res, 200, buildLiveView(runtime), headOnly);
}

/** 起轮询（只起一次；定时器 unref，不拖着进程）。本机状态与对端**同一拍、并发**。 */
function startLivePolling(runtime) {
	const state = liveStateOf(runtime);
	if (state.timer !== null) return;
	const interval = Number.isFinite(runtime.livePollMs) && runtime.livePollMs > 0 ? runtime.livePollMs : LIVE_POLL_MS;
	state.timer = setInterval(() => {
		void pollLocalLive(runtime);
		void pollPeerLives(runtime);
	}, interval);
	unrefTimer(state.timer);
	void pollLocalLive(runtime);
	void pollPeerLives(runtime);
	info(runtime.ctx, `跨机实时状态已启动：每 ${String(interval)} ms 采一次本机状态与 ${String(livePeerDevices(runtime).length)} 台对端`);
}

/** 停轮询（插件卸载时；在 `apply` 里由 ctx.effect 的清理函数调用）。 */
function stopLivePolling(runtime) {
	const state = liveStateOf(runtime);
	if (state.timer === null) return;
	clearInterval(state.timer);
	state.timer = null;
}

//#endregion

export {
	buildLiveAggregate,
	buildLiveView,
	buildSelfLivePayload,
	clearLocalLiveUnread,
	createLiveState,
	fetchPeerPath,
	handleLocalLiveRequest,
	handlePeerLiveRequest,
	handleViewRequest,
	livePendingOfItem,
	liveSelfNameOf,
	liveStateOf,
	liveTailRoleOf,
	liveViewFromPeerBody,
	liveViewOf,
	loadLiveUnread,
	markLiveSeen,
	pollLocalLive,
	pollPeerLives,
	resolveLivePath,
	saveLiveUnread,
	startLivePolling,
	stopLivePolling,
};
