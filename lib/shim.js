export function remoteShim(options) {
	var KEYS_CURRENT = ["dsh-device-switch:current", "dsh-remote:current"];
	var KEYS_DEVICES = ["dsh-device-switch:devices", "dsh-remote:devices"];
	var SLOT = "__DSH_REMOTE_SHIM__";
	/** 发布设备表用的**隐藏 JSON 节点** id（元素是 `script type="application/json"`；不渲染、不占位）。
	 *  与模块常量 `SHIM_DEVICES_NODE_ID` 逐字一致（自测有用例盯这条）。
	 *  写法注意：本函数里**任何注释都不许出现带尖括号的 script / link 字样** —— 自测有一条
	 *  "注入文本自包含、不引外部资源"的文本断言。 */
	var DEVICES_NODE_ID = "dsh-remote-devices";
	var PREFIX = "/dev/";
	var ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
	var root = globalThis;
	var config = options !== null && typeof options === "object" ? options : {};
	var defaults = Array.isArray(config.devices) ? config.devices : [];
	var localName = typeof config.localName === "string" && config.localName !== "" ? config.localName : "本机";
	var helloPath = typeof config.helloPath === "string" && config.helloPath !== "" ? config.helloPath : "/plugin/remote/hello";
	// 自检问的是状态接口（宿主注入时按当前 enabled 现算，见 currentShimScript）。
	var statePath = typeof config.statePath === "string" && config.statePath !== "" ? config.statePath : "/plugin/remote/state";
	var hostEnabled = config.enabled !== false;
	var sentinelKey = typeof config.sentinelKey === "string" && config.sentinelKey !== "" ? config.sentinelKey : "dsh-remote:soft-off";
	// edge 上 /plugin/ 被拦时记一笔：之后不再请求 state（避免每次加载刷一条 403）。
	var stateBlockedKey = "dsh-remote:state-blocked";
	// "强制激活"标记的键（与客户端半用同一个键名）：读到非空 → 忽略 payload.enabled 与哨兵。
	var forceActiveKey = typeof config.forceActiveKey === "string" && config.forceActiveKey !== ""
		? config.forceActiveKey
		: "dsh-remote:force-active";

	var installed = root[SLOT];
	if (installed !== null && typeof installed === "object" && installed.installed === true) {
		// **配置热重载**：宿主半换了设备表 / 本机名之后会**重新注入同一份脚本**（新 payload 进同一个窗口）。
		// 这里不重复 patch、不重复挂 UI，只把"发布的设备表"按新配置同步刷新一遍
		// （客户端半列设备就靠它，见下面的 publishDeviceTable）。
		try {
			if (typeof installed.refreshDevices === "function") installed.refreshDevices(config);
		} catch (error) {
			/* 刷新失败不影响已经就位的那一套 */
		}
		return installed;
	}

	/**
	 * 本垫片的幂等槽位。**在两条通道（patch 与自除）之前就建好**，
	 * 这样自检路径也拿得到它（`enabled:false` 时用一个惰性槽位顶上）。
	 */
	var slot = { installed: true, selected: "", patched: [] };
	root[SLOT] = slot;

	//#region 存储

	function normalizeId(value) {
		if (typeof value !== "string") return "";
		var trimmed = value.trim();
		return ID_PATTERN.test(trimmed) ? trimmed : "";
	}

	function readStored(key) {
		try {
			var storage = root.localStorage;
			if (storage === null || typeof storage !== "object") return null;
			var value = storage.getItem(key);
			return typeof value === "string" ? value : null;
		} catch (error) {
			return null;
		}
	}

	function writeStored(key, value) {
		try {
			var storage = root.localStorage;
			if (storage === null || typeof storage !== "object") return false;
			if (value === "") storage.removeItem(key);
			else storage.setItem(key, value);
			return true;
		} catch (error) {
			return false;
		}
	}

	/** sessionStorage 读：读不到 / 不可用一律当"没设过"（绝不让存储异常影响页面）。 */
	function readSession(key) {
		try {
			var storage = root.sessionStorage;
			if (storage === null || typeof storage !== "object") return "";
			var value = storage.getItem(key);
			return typeof value === "string" ? value : "";
		} catch (error) {
			return "";
		}
	}

	/** sessionStorage 写（空串 = 删键）；返回是否真的写成功（不可用时 false）。 */
	function writeSession(key, value) {
		try {
			var storage = root.sessionStorage;
			if (storage === null || typeof storage !== "object") return false;
			if (value === "") storage.removeItem(key);
			else storage.setItem(key, value);
			return true;
		} catch (error) {
			return false;
		}
	}

	/** sessionStorage 的哨兵：读不到 / 不可用一律当"没设过"。 */
	function readSentinel() {
		return readSession(sentinelKey);
	}

	function writeSentinel(value) {
		return writeSession(sentinelKey, value);
	}

	/**
	 * "强制激活"标记：非空 = 这次加载忽略 payload.enabled 与哨兵，直接走正常模式。
	 * 读不到（sessionStorage 不可用）时按"没有"处理。
	 */
	function readForceActive() {
		return readSession(forceActiveKey) !== "";
	}

	/** 置 / 清"强制激活"标记；返回是否真的写成功（写不进去时调用方要自己决定降级）。 */
	function writeForceActive(on) {
		return writeSession(forceActiveKey, on === true ? "1" : "");
	}

	/**
	 * 把四个键一起清掉（"当前设备"+"设备列表"，主键与别名）。
	 * 停用后重开不能继续跑远端，靠的就是这一步。
	 */
	function clearStoredSelection() {
		writeAll(KEYS_CURRENT, "");
		writeAll(KEYS_DEVICES, "");
	}

	/** 多个键里第一个有值的（主键优先，别名兜底：客户端半用哪个都行）。 */
	function readFirst(keys) {
		for (var index = 0; index < keys.length; index += 1) {
			var value = readStored(keys[index]);
			if (value !== null) return value;
		}
		return null;
	}

	/** 写入所有键（空串 = 删除该键）。 */
	function writeAll(keys, value) {
		var wrote = false;
		for (var index = 0; index < keys.length; index += 1) {
			if (writeStored(keys[index], value)) wrote = true;
		}
		return wrote;
	}

	//#endregion

	//#region 自愈（同步判据：选中的 id 不在设备表 ⇒ 清键 + 刷一次）

	/**
	 * **这一段是 2026-10-17 那个致死缺陷的补丁**（真机复现；几刀按用户要求一路瘦身）：
	 *
	 * 用户在家里那台**关机**时，把本窗口切到它 ⇒ 页面由本机服务、但所有 `/api` 都被上面的
	 * `rewriteUrl()` 改写成 `/dev/<那台>/api/…` ⇒ 全部失败 ⇒ **App 壳渲染不出来（纯白屏，
	 * 或长时间"正在加载设置…"）**；而切设备的入口（客户端半注入的侧栏那一行 + `shell.overlay`
	 * 浮层）**长在 App 的 DOM 里** ⇒ 一点入口都没有，用户只能跑去把那台机器开机救活。
	 * 根因是"按要求去掉右下角胶囊"时，把**唯一独立于 App DOM** 的逃生口一起拆了。
	 *
	 * 剩下的补救只有一条 —— {@link selfHealStart}：选中的 id **不在本机配置的设备表里**
	 * ⇒ 立刻清键 + 刷新一次回本机。它是**同步判据**，不依赖 App 是否渲染，也不插任何 DOM。
	 *
	 * **历史上那几块东西都已按用户要求整段删掉**：
	 *  ① `GET /plugin/remote/live` 探针 + "连续两次 `reachable === false` ⇒ 自动回本机"：
	 *     他不要"我自己切过去又被你弹回来"；
	 *  ② 右下角兜底浮层 + "白屏判据"（`visibleTextLength` / `looksBlank` / 4 秒后出现）：
	 *     他实测白屏最多 15 秒后 App 总会渲染出来，那块浮层属多余；
	 *  ③ **左上角那颗常驻小按钮**（`← 本机`，纯原生 DOM）：真机白屏已从 15 秒
	 *     降到 2–3 秒、界面基本都会渲染出来，正常切换器就够用 —— 他实测后认为多余且丑。
	 * 于是垫片里**一个定时器都不用、一个 DOM 节点都不插**。
	 *
	 * **防误伤**：只在"当前选中的是**对端**（非空 id）"时动手 —— 本机态（键为空）一个字节都不碰。
	 */
	/** 自动重置的冷却时间（ms）：一次重置后这么久之内不再自动重置（防"重置 → 刷新 → 重置"回环）。 */
	var AUTO_RESET_COOLDOWN_MS = 60000;
	/** 自动重置的冷却标记（**localStorage**：必须跨 `location.reload()` 存活，`sessionStorage` 会被刷新清掉）。 */
	var AUTO_RESET_KEY = "dsh-remote:auto-reset";
	var selfHealRan = false;

	/** 垫片自己的诊断日志（只走 console.debug，每个决策最多一条）。 */
	function shimLog(message) {
		try {
			var console_ = root.console;
			if (console_ !== null && console_ !== undefined && typeof console_.debug === "function") {
				console_.debug("[dsh-remote/shim] " + message);
			}
		} catch (error) {
			/* 没有 console：什么都不做 */
		}
	}

	/** 设备条目数组 → 只取 id（诊断用）。 */
	function idsOf(list) {
		var out = [];
		var items = Array.isArray(list) ? list : [];
		for (var index = 0; index < items.length; index += 1) {
			var entry = items[index];
			if (entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id !== "") out.push(entry.id);
		}
		return out;
	}

	/** 配置里的设备 id 表（**只看配置了这一边**：垫片 payload 的 `devices` ∪ 存储里的设备表）。 */
	function configuredIds() {
		var ids = [];
		function add(value) {
			var id = normalizeId(value);
			if (id === "") return;
			for (var index = 0; index < ids.length; index += 1) if (ids[index] === id) return;
			ids.push(id);
		}
		for (var index = 0; index < defaults.length; index += 1) add(defaults[index] === null || defaults[index] === undefined ? "" : defaults[index].id);
		var raw = readFirst(KEYS_DEVICES);
		if (raw !== null) {
			var parsed = null;
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				parsed = null;
			}
			if (Array.isArray(parsed)) for (var at = 0; at < parsed.length; at += 1) add(parsed[at] === null || parsed[at] === undefined ? "" : parsed[at].id);
		}
		return ids;
	}

	/** 选中的 id 在不在配置里。 */
	function isConfigured(id) {
		if (typeof id !== "string" || id === "") return false;
		var ids = configuredIds();
		for (var index = 0; index < ids.length; index += 1) if (ids[index] === id) return true;
		return false;
	}

	/** 当前选中的是**对端**吗（选中为空 = 本机 ⇒ 这套东西一概不动手）。 */
	function remoteSelected() {
		return normalizeId(readFirst(KEYS_CURRENT)) !== "";
	}

	/** localStorage 里那个"自动重置了多少次 / 上次什么时候"的标记（坏数据一律当没设过）。 */
	function readResetMark() {
		var raw = readStored(AUTO_RESET_KEY);
		if (raw === null || raw === "") return null;
		var parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			return null;
		}
		if (parsed === null || typeof parsed !== "object") return null;
		var at = Number(parsed.at);
		var count = Number(parsed.count);
		return { at: isFinite(at) ? at : 0, count: isFinite(count) ? count : 0 };
	}

	/**
	 * **自动重置到本机**：清掉"当前设备"两个键 → 带哨兵刷新一次。
	 *
	 * 防回环（硬要求，顺序不许换）：
	 *  ① 先把冷却标记**写进 localStorage**（`{at,count}`，跨 reload 存活）—— 写不进去（存储被禁）
	 *     就**绝不重置、绝不刷新**（否则每次加载都会再来一遍 = 无限刷新，这正是 4.1 惰性自愈里
	 *     那条 "`force-active` 写不进去就绝不刷新" 的同一条道理）；
	 *  ② 标记在位且距上次 < {@link AUTO_RESET_COOLDOWN_MS} ⇒ 这次**什么都不做**；
	 *  ③ 同一次页面生命周期（`sessionStorage`）里最多重置 **1** 次 —— 刷新后 `sessionStorage`
	 *     仍在（同标签页），所以"重置后仍然连不上"不会变成第二次重置；
	 *  ④ 刷新本身复用 {@link reloadOnce}（`sessionStorage` 哨兵：同一窗口最多刷一次）。
	 *
	 * @param reason - 写进诊断日志的原因（每个决策最多一条）。
	 * @returns 是否真的做了重置（含是否刷新成功）。
	 */
	function resetToLocal(reason) {
		if (remoteSelected() !== true) return false; // 本机态绝不动手
		if (selfHealRan === true) return false;
		var mark = readResetMark();
		var now = Date.now();
		if (mark !== null && now - mark.at < AUTO_RESET_COOLDOWN_MS) return false;
		var payload = JSON.stringify({ at: now, count: (mark === null ? 0 : mark.count) + 1 });
		if (writeStored(AUTO_RESET_KEY, payload) !== true) {
			// 标记写不进去 ⇒ 不重置（宁可不救，也绝不做"刷新 → 又重置"的死循环）。
			shimLog("当前设备不可用，但冷却标记写不进 localStorage ⇒ 放弃自动重置（" + reason + "）");
			return false;
		}
		selfHealRan = true;
		writeAll(KEYS_CURRENT, "");
		shimLog("当前设备不可用 ⇒ 已清掉选中设备并刷新回本机（" + reason + "）");
		return reloadOnce();
	}

	/**
	 * **自愈第一条（同步、页面加载就开始）**：当前选中的 id **不在本机配置的设备表里** ⇒
	 * 立刻清掉 `KEYS_CURRENT` 两个键 + 刷新一次回本机。
	 *
	 * 什么时候会这样：设备被删掉 / id 被改名 / 从别的机器（或备份）带过来的键指向一个
	 * 这台机器根本没有的设备。这种情况**没有任何修复的可能**（`/dev/<id>/…` 那条路由压根不存在），
	 * 而且用户看不到任何入口去改（白屏）——所以启动时就顺手救回来。
	 *
	 * **两条防误伤**（与 `configuredIds()` 的注释配套）：
	 *  ① 选中为空（本机）⇒ 不动；
	 *  ② 配置表**一台设备都没有**（`configuredIds()` 为空）⇒ 不动 —— 那种情况我们没有
	 *     "这个 id 是脏的"的依据（老窗口里客户端半的设备表可能还没写回存储），宁可不动。
	 * @returns 是否真的做了重置。
	 */
	function selfHealStart() {
		if (typeof selected !== "string" || selected === "") return false;
		if (configuredIds().length === 0) return false;
		if (isConfigured(selected) === true) return false;
		// **0.13.4：注入的 payload 可能是旧的**（桌面壳把注入行缓存到窗口生命周期，
		// 运行中新增的设备不会出现在 payload 里）⇒ 重置前先向宿主问一次实时设备表，
		// 免得把"其实存在、只是表旧了"的设备判成脏数据、把用户刚点的切换弹回本机。
		confirmMissingDevice(selected);
		return false;
	}

	/**
	 * {@link selfHealStart} 的**异步二次确认**：拿 `GET /plugin/remote/state` 的实时设备表再判一次。
	 * - 表里有这台 ⇒ 不重置，并把设备表写回 localStorage（下次启动 `configuredIds()` 就能看到它）；
	 * - 表里确实没有 / 拿不到 state ⇒ 按原逻辑 {@link resetToLocal}（宁可不救，也绝不白屏）。
	 */
	function confirmMissingDevice(id) {
		var reason = '选中的设备 "' + id + '" 不在本机配置的设备表里';
		var f = root.fetch;
		if (typeof f !== "function") {
			resetToLocal(reason);
			return;
		}
		var result = null;
		try {
			result = f.call(root, statePath, { method: "GET", credentials: "same-origin", cache: "no-store" });
		} catch (error) {
			resetToLocal(reason);
			return;
		}
		if (result === null || typeof result !== "object" || typeof result.then !== "function") {
			resetToLocal(reason);
			return;
		}
		result
			.then(function (response) {
				if (response === null || typeof response !== "object" || response.ok !== true || typeof response.json !== "function") throw new Error("state 不可用");
				return response.json();
			})
			.then(function (state) {
				var list = state !== null && typeof state === "object" && Array.isArray(state.devices) ? state.devices : [];
				var table = [];
				var found = false;
				for (var index = 0; index < list.length; index += 1) {
					var entry = list[index];
					if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id === "") continue;
					var synced = { id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id };
					var syncedHotkey = typeof entry.hotkeyEffective === "string" && entry.hotkeyEffective !== ""
						? entry.hotkeyEffective
						: (typeof entry.hotkey === "string" ? entry.hotkey : "");
					if (syncedHotkey !== "" && syncedHotkey !== "off") synced.hotkey = syncedHotkey;
					table.push(synced);
					if (entry.id === id) found = true;
				}
				if (found === true) {
					try {
						writeAll(KEYS_DEVICES, JSON.stringify(table));
					} catch (error) {
						/* 写不进 localStorage 也不影响本次选择 */
					}
					return;
				}
				resetToLocal(reason);
			}, function () {
				resetToLocal(reason);
			});
	}

	/**
	 * **自愈第二条（可达性，0.12.0 恢复；只给"没有别的出口"的会话）**：
	 * 当前选中的是**对端**，且连续 {@link HEAL_FAILS_TO_RESET} 次聚合里那台
	 * `reachable === false` ⇒ 走上面那个 {@link resetToLocal}（清 `KEYS_CURRENT` 两键 + 冷却
	 * + 哨兵刷新，**一套既有机制，不另造**）。
	 *
	 * 为什么只在**非回环会话**里开（用户明确要求，别扩大）：
	 *  - 手机 / 浏览器经「对外端口」（edge）打开本机页面时，切设备的入口（客户端半的侧栏那一行
	 *    + 浮层）**长在 App 的 DOM 里**，而对端关机时页面所有 `/api` 都被改写成 `/dev/<那台>/…`
	 *    ⇒ 壳渲染不出来 ⇒ 用户一个入口都没有（**垫片是唯一不依赖 App DOM 的出路**）；
	 *  - 桌面壳（`dsh-app://app/`）/ 本机浏览器（127.0.0.1）有自己的退路，而且用户明确不要
	 *    "我自己切过去又被弹回来" ⇒ **一个字节都不碰**。
	 *
	 * 取数走 {@link HEAL_VIEW_PATH}（`/dsh-remote-view`，**非 `/plugin/` 前缀**）：edge 只拦
	 * `/plugin/`，所以这是走 edge 的浏览器里唯一读得到的聚合口（`/plugin/remote/live` 那边永远 403）。
	 * **未知 ≠ 不可达**：读不到 / 形状不认识 / 表里没有这台 ⇒ 计数清零，绝不当成"连不上"。
	 */
	/** 聚合口（非 `/plugin/` 前缀 ⇒ 能穿过 edge；与模块常量 VIEW_PATH 逐字一致，自测盯这条）。 */
	var HEAL_VIEW_PATH = "/dsh-remote-view";
	/** 探测间隔（与宿主半轮询对端、客户端半取数同一个数：2 秒）。 */
	var HEAL_POLL_MS = 2000;
	/** 连续几次聚合都说"这台不可达"才动手（只有 1 次可能只是抖了一下）。 */
	var HEAL_FAILS_TO_RESET = 2;
	var healTimer = null;
	var healFails = 0;

	/** 这个会话"没有别的出口"吗：**非回环**且是 http(s)（桌面壳是 `dsh-app:`，不算）。 */
	function healAllowed() {
		if (remoteSelected() !== true) return false; // 本机态：一个字节都不碰
		var location = root.location;
		if (location === null || typeof location !== "object") return false; // 拿不到 ⇒ 不动手
		var protocol = typeof location.protocol === "string" ? location.protocol.toLowerCase() : "";
		if (protocol !== "http:" && protocol !== "https:") return false;
		var hostname = typeof location.hostname === "string" ? location.hostname.trim().toLowerCase() : "";
		if (hostname === "") return false;
		if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return false;
		return true;
	}

	/** 停掉那条探测（幂等；没起过就什么都不做）。 */
	function healStop() {
		if (healTimer === null) return;
		try {
			if (typeof root.clearInterval === "function") root.clearInterval(healTimer);
		} catch (error) {
			/* 忽略 */
		}
		healTimer = null;
	}

	/** 一份聚合 → 计数：只认"表里明确有这台 + `reachable === false`"，其余（含未知）一律清零。 */
	function healObserve(id, view) {
		var peers = view !== null && typeof view === "object" && Array.isArray(view.peers) ? view.peers : null;
		if (peers === null) {
			healFails = 0;
			return;
		}
		var found = null;
		for (var index = 0; index < peers.length; index += 1) {
			var peer = peers[index];
			if (peer === null || typeof peer !== "object") continue;
			if (normalizeId(peer.id) === id) {
				found = peer;
				break;
			}
		}
		if (found === null || found.reachable !== false) {
			healFails = 0;
			return;
		}
		healFails += 1;
		if (healFails < HEAL_FAILS_TO_RESET) return;
		healStop(); // 这次加载只决定一次；冷却 + 哨兵由 resetToLocal 自己管
		resetToLocal("当前设备连续 " + String(HEAL_FAILS_TO_RESET) + " 次被聚合判为不可达");
	}

	/** 探一次聚合（用**未包装的 fetch**：这条路径不是 `/api`，不该被改写掺和）。 */
	function healTick() {
		try {
			if (healAllowed() !== true) {
				healStop();
				return;
			}
			var id = normalizeId(readFirst(KEYS_CURRENT));
			if (id === "") {
				healStop();
				return;
			}
			var original = root.fetch;
			if (typeof original !== "function") return;
			var result = original.call(root, HEAL_VIEW_PATH, { method: "GET", credentials: "same-origin", cache: "no-store" });
			if (result === null || typeof result !== "object" || typeof result.then !== "function") return;
			result.then(function (response) {
				// 读不到 / 没拿到 200（含 403：会话不可信）⇒ 未知，计数清零，绝不当成"连不上"。
				if (response === null || typeof response !== "object" || response.ok !== true) {
					healFails = 0;
					return undefined;
				}
				if (typeof response.json !== "function") {
					healFails = 0;
					return undefined;
				}
				return response.json().then(function (view) {
					// 期间用户可能自己切走了：一律以**现在**的选中为准。
					if (normalizeId(readFirst(KEYS_CURRENT)) !== id) {
						healFails = 0;
						return;
					}
					healObserve(id, view);
				}, function () {
					healFails = 0;
				});
			}, function () {
				healFails = 0;
			});
		} catch (error) {
			healFails = 0;
		}
	}

	/** 起这条探测（幂等；条件不满足就**一个定时器都不登记**）。 */
	function healStart() {
		if (healTimer !== null) return false;
		if (healAllowed() !== true) return false;
		var every = root.setInterval;
		if (typeof every !== "function") return false;
		try {
		} catch (error) { /* 忽略 */ }
		healFails = 0;
		healTimer = every(healTick, HEAL_POLL_MS);
		healTick();
		return true;
	}

	//#endregion

	//#region 报到 + 自检（注入是否生效 / 插件是否已停用）

	function reportHello() {
		try {
			var original = root.fetch;
			if (typeof original !== "function") return;
			var result = original.call(root, helloPath, { method: "POST", credentials: "same-origin", cache: "no-store" });
			if (result !== null && typeof result === "object" && typeof result.then === "function") {
				result.then(function () {}, function () {});
			}
		} catch (error) {
			/* 报到失败绝不能影响页面 */
		}
	}


	/**
	 * 还原被改写过的网络原语（尽力而为：每一步独立 try）。
	 * `slot.patched` 记着这次到底 patch 了哪几个。
	 */
	function restorePrimitives() {
		for (var index = 0; index < slot.patched.length; index += 1) {
			var which = slot.patched[index];
			try {
				if (which === "fetch" && typeof root.fetch === "function" && typeof root.fetch.__dshRemoteOriginal === "function") {
					root.fetch = root.fetch.__dshRemoteOriginal;
				} else if (which === "websocket" && typeof root.WebSocket === "function" && typeof root.WebSocket.__dshRemoteOriginal === "function") {
					root.WebSocket = root.WebSocket.__dshRemoteOriginal;
				} else if (which === "xhr" && typeof root.XMLHttpRequest === "function") {
					var xhr = root.XMLHttpRequest;
					if (xhr.prototype !== null && xhr.prototype !== undefined && typeof xhr.prototype.open === "function"
						&& typeof xhr.prototype.open.__dshRemoteOriginal === "function") {
						xhr.prototype.open = xhr.prototype.open.__dshRemoteOriginal;
					}
				}
			} catch (error) {
				/* 还原失败就保持现状：页面继续按已改写的原语工作，一样能用 */
			}
		}
	}

	/** 带哨兵地刷新一次：同一窗口最多刷一次，避免"停用状态下无限刷新"。 */
	function reloadOnce() {
		if (readSentinel() !== "") return false;
		writeSentinel("1");
		try {
			root.location.reload();
			return true;
		} catch (error) {
			/* 下面兜底 */
		}
		try {
			root.location.href = root.location.href;
			return true;
		} catch (error) {
			return false;
		}
	}

	/** 自除：回到"本机直连、垫片一个节点都不插"的干净状态，然后刷新一次。 */
	function softOff() {
		try {
			clearStoredSelection();
			healStop(); // 插件都停了，那条可达性探测也一起停（不再打任何请求）
			// 停用 / 卸载：把发布出去的设备表一起撤掉（删隐藏节点 + 清全局），不留脏数据。
			retractDeviceTable();
			restorePrimitives();
			slot.selected = "";
			slot.patched = [];
			reloadOnce();
		} catch (error) {
			/* 自除失败绝不能把页面弄坏 */
		}
	}

	/**
	 * **惰性自愈**：本次加载因为 payload 里的 `enabled:false` 或哨兵在位而没走正常模式
	 * （不 patch、不挂胶囊，已经错过挂载时机），但自检发现宿主其实 `enabled:true`。
	 *
	 * 动作顺序不许换：置 `force-active` 标记（下次加载忽略 payload/哨兵、直接走正常模式）
	 * → 清哨兵 → 带防循环保护地刷一次。
	 *
	 * **防循环的第一道**：`force-active` 写不进去（sessionStorage 被禁 / 不可用）时**绝不刷新** ——
	 * 否则每次加载都会再走一遍自愈，变成"无限刷新"。此时降级为"等用户手动重载一次"
	 * （修复前的行为：需要再点一次「重载窗口」）。
	 * 写得进去时最多刷一次：刷新后的那个窗口同步阶段必然读到标记、走正常模式并把它用掉，
	 * 于是不会再来自愈；哨兵的第二道保护由 `reloadOnce` 提供。
	 * @returns 是否真的刷新了。
	 */
	function healLazy() {
		if (!writeForceActive(true)) return false;
		writeSentinel("");
		return reloadOnce();
	}

	/**
	 * 异步自检：同步 patch **之后**才跑，绝不阻塞首屏请求。
	 * 只有拿到明确的 `enabled:false`，或 404（插件已被卸载 / 路由没了）才自除；
	 * 其余一切情况（网络失败、非 JSON、没有这个字段）都安静地什么都不做。
	 */
	function checkHostState() {
		try {
			// 之前已经确认这个来源拿不到 state（例如经 edge 打开）：安静跳过。
			if (readSession(stateBlockedKey) !== "") return;
			var original = root.fetch;
			if (typeof original !== "function") return;
			var result = original.call(root, statePath, { method: "GET", credentials: "same-origin", cache: "no-store" });
			if (result === null || typeof result !== "object" || typeof result.then !== "function") return;
			result.then(function (response) {
				if (response === null || typeof response !== "object") return undefined;
				var status = typeof response.status === "number" ? response.status : 0;
				if (status === 404) {
					softOff();
					return undefined;
				}
				// 403/401：页面是站在某台机器的 edge 上打开的（edge 把 /plugin/ 前缀拦掉，永远问不到状态）。
				// 拿不到状态不等于停用：如果注入时的 payload 说宿主开着，就按开启处理（清哨兵 + 自愈刷新一次），
				// 否则这个窗口会永远停在"惰性"里——设备选择器能切、页面却不会改道。
				if (status === 403 || status === 401) {
					writeSession(stateBlockedKey, "1");
					if (hostEnabled === true) {
						writeSentinel("");
						if (lazy === true) healLazy();
					}
					return undefined;
				}
				if (typeof response.json !== "function") return undefined;
				return response.json().then(function (state) {
					if (state === null || typeof state !== "object") return;
					writeSession(stateBlockedKey, "");
					if (state.enabled === false) {
						softOff();
						return;
					}
					if (state.enabled === true) {
						writeSentinel("");
						// 宿主是开着的，但本次是惰性的（错过挂载时机）→ 自愈：置标记 + 刷一次。
						if (lazy === true) healLazy();
					}
				}, function () {});
			}, function () {});
		} catch (error) {
			/* 自检失败绝不能影响页面 */
		}
	}

	//#endregion

	/**
	 * 本次加载是不是"惰性"：不同步 patch、不挂胶囊，只剩自检这一件事。
	 * 两种原因：payload 里的 `enabled === false`（宿主注入时就是停用的），或哨兵在位
	 * （这个窗口已经为"停用"刷过一次）；唯一的例外是 `force-active` 标记 —— 它压倒一切，
	 * 强制走正常模式（这样"开启后一次刷新胶囊就回来"）。自检的惰性自愈要用这个判断。
	 */
	var forcedActive = readForceActive();
	var lazy = forcedActive !== true && (hostEnabled !== true || readSentinel() !== "");

	/**
	 * 停用（`enabled:false`）时脚本只剩"自检"这一件事：**不同步 patch、不挂胶囊**。
	 * 直接返回一个惰性槽位，让页面保持"本机直连、没有胶囊"的干净状态。
	 * 宿主注入时给的 `enabled` 可能不是最新的（桌面壳把注入行缓存到窗口生命周期），
	 * 所以这里仍然跑自检：在老窗口里它会发现 `enabled:false` 并自除 + 刷新一次；
	 * 反过来，如果发现宿主其实开着，就置 `force-active` 并刷一次（惰性自愈）。
	 */
	if (lazy === true) {
		try {
			if (root.console !== null && root.console !== undefined && typeof root.console.warn === "function") {
				root.console.warn("[dsh-remote] shim lazy（payload enabled=" + String(hostEnabled) + " / sentinel=" + (readSentinel() !== "") + "）：不 patch，只在后台自检");
			}
		} catch (error) {
			/* 忽略 */
		}
		checkHostState();
		return slot;
	}

	// 走到这里就是"正常模式"（含 force-active 强制激活）：标记用掉就删，它只该生效一次
	// ——否则关停时客户端半还得再清一次它，且可能让下一次加载莫名其妙地又强制激活一遍。
	if (forcedActive === true) writeForceActive(false);

	var selected = normalizeId(readFirst(KEYS_CURRENT));
	slot.selected = selected;
	// 诊断用：在 console 里一眼能看出这次加载垫片是"正常模式"还是"惰性"（edge 上问不到状态时很重要）。
	try {
		if (root.console !== null && root.console !== undefined && typeof root.console.info === "function") {
			root.console.info("[dsh-remote] shim active · selected=" + (selected === "" ? "(本机)" : selected));
		}
	} catch (error) {
		/* 忽略 */
	}
	reportHello();

	//#region 左上角那颗常驻按钮 —— **已整段删除**（2026-10-17 第三刀）

	/**
	 * 这里以前是那颗**左上角常驻「← 本机」小按钮**（纯原生 DOM，DOM id `dsh-remote-` + `local`）：
	 * "当前设备"键非空就挂、点一下清键 + 刷新；配套的绘制 / 显隐 / 摘除辅助函数与
	 * `dispose` 卸载钩子**全在那一刀里一起删掉了**（不留死代码）。
	 *
	 * **删掉的理由（用户真机实测）**：白屏已从 15 秒降到 2–3 秒、界面基本都会渲染出来，
	 * 正常切换器（客户端半的侧栏那一行 + 浮层）就够用，那颗按钮多余且丑。
	 *
	 * ⇒ 垫片现在**一个 DOM 节点都不插**：这颗按钮是最后一块垫片 UI（它的前身「右下角胶囊面板」
	 * 在更早的一刀里就整段删掉了 —— 挂载 / 摘除 / 元素 id 那几样连名字都不在源码里了）。
	 * 请求改写（`prefixPath()` / `rewriteUrl()` /
	 * fetch / WebSocket / XHR 三处 patch）与自愈（见上面的 `resetToLocal` / `selfHealStart` /
	 * `healStart`）一个字节都没动。
	 */

	//#endregion

	//#region 无声发布设备表（全局快照 + 隐藏 JSON 节点）——**不画任何可见 UI**

	/**
	 * 垫片唯一的"对外输出"：把这份设备表**无声发布**出去，让客户端半（浮层 / 侧栏那一行）能列设备、
	 * 能切设备。**为什么非得这样**：客户端半原来唯一的设备表来源是垫片画在 DOM 里的
	 * 那些设备按钮（右下角胶囊面板）；胶囊面板整段删除后这条来源断了，而
	 * `GET /plugin/remote/live` 在**任何走 edge 的浏览器**里都是 403（那条路由只认回环），
	 * 于是浮层里只剩「本机」。这两种发布**互为兜底**、都是同源且**不走网络**的：
	 *
	 *   ① `globalThis.__DSH_REMOTE_DEVICES__ = [{id,name,current}, …]`（本机那条 `id` 是空串）；
	 *   ② 一个**隐藏的 JSON 节点**：元素是 `script`、`type="application/json"`、
	 *      `id="dsh-remote-devices"`，内容 `{"devices":[…]}`，挂 `document.documentElement`。
	 *
	 * 为什么挂 documentElement 而不是 body：script 元素本来就不渲染（再钉 `hidden` + `display:none`
	 * 双保险），而且 body 必须保持**一个子节点都没有** —— 那是"垫片不插任何可见 DOM"这条不变式的
	 * 断言口径（自测 K1 ④ 的 `body.children.length === 0`）。
	 *
	 * 边界（谁不受影响）：不发任何网络请求（数据全来自注入 payload + localStorage 的当前设备键），
	 * 不碰 `prefixPath()` / `rewriteUrl()` / 三处 patch / `KEYS_CURRENT` 的读写语义。
	 */
	var devicesNode;

	/** 一份设备表配置 → 发布条目（本机 id 空串在最前；非法 id / 重复 id 丢掉）。 */
	function entriesFromDevices(devices, name) {
		var out = [{ id: "", name: typeof name === "string" && name !== "" ? name : localName }];
		var seen = {};
		var list = Array.isArray(devices) ? devices : [];
		for (var index = 0; index < list.length; index += 1) {
			var entry = list[index];
			if (entry === null || typeof entry !== "object") continue;
			var id = normalizeId(entry.id);
			if (id === "" || seen[id] === true) continue;
			seen[id] = true;
			var item = { id: id, name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id };
			var hotkey = typeof entry.hotkey === "string" ? entry.hotkey.trim() : "";
			if (hotkey !== "") item.hotkey = hotkey;
			out.push(item);
		}
		return out;
	}

	/** 建 / 取那个隐藏 JSON 节点（幂等：同一个节点只建一次，内容整体刷新）。 */
	function publishDevicesNode(published) {
		try {
			var doc = root.document;
			if (doc === null || typeof doc !== "object" || typeof doc.createElement !== "function") return;
			var node = devicesNode;
			if (node === null || node === undefined || node.parentNode === null || node.parentNode === undefined) {
				if (typeof doc.getElementById === "function") {
					var existing = doc.getElementById(DEVICES_NODE_ID);
					if (existing !== null && existing !== undefined) node = existing;
				}
			}
			if (node === null || node === undefined) {
				var host = doc.documentElement !== null && doc.documentElement !== undefined
					? doc.documentElement
					: (doc.head !== null && doc.head !== undefined ? doc.head : doc.body);
				if (host === null || host === undefined || typeof host.appendChild !== "function") return;
				node = doc.createElement("script");
				node.type = "application/json";
				node.id = DEVICES_NODE_ID;
				if (typeof node.setAttribute === "function") {
					node.setAttribute("type", "application/json");
					node.setAttribute("id", DEVICES_NODE_ID);
				}
				host.appendChild(node);
			}
			devicesNode = node;
			node.textContent = JSON.stringify({ devices: published });
			// 双保险：这种节点本来就不可见、不占位，这里再把这条钉死（`hidden` + `display:none`）。
			node.hidden = true;
			if (node.style !== null && node.style !== undefined && typeof node.style === "object") node.style.display = "none";
		} catch (error) {
			/* 发布失败只影响"能不能列设备"，绝不影响请求改写与自愈 */
		}
	}

	/** 发布（或刷新）设备表：全局快照 + 隐藏 JSON 节点，两份一起写。 */
	function publishDeviceTable(entries) {
		var current = normalizeId(readFirst(KEYS_CURRENT));
		var published = [];
		var list = Array.isArray(entries) ? entries : [];
		for (var index = 0; index < list.length; index += 1) {
			var entry = list[index];
			if (entry === null || typeof entry !== "object") continue;
			var id = normalizeId(entry.id);
			var item = {
				id: id,
				name: typeof entry.name === "string" && entry.name !== "" ? entry.name : (id === "" ? localName : id),
				// `current` 只是**参考值**（客户端半以自己读到的 `KEYS_CURRENT` 为准）。
				current: id === current,
			};
			var hotkey = typeof entry.hotkey === "string" ? entry.hotkey.trim() : "";
			if (hotkey !== "") item.hotkey = hotkey;
			published.push(item);
		}
		try {
			root.__DSH_REMOTE_DEVICES__ = published;
		} catch (error) {
			/* 写不进全局也还有 JSON 节点 */
		}
		try {
			var view = root.window;
			if (view !== null && view !== undefined && view !== root) view.__DSH_REMOTE_DEVICES__ = published;
		} catch (error) {
			/* 同上 */
		}
		publishDevicesNode(published);
	}

	/** 撤销发布：删隐藏节点 + 清全局（`softOff()` / 卸载路径用；幂等，没发布过就是空操作）。 */
	function retractDeviceTable() {
		try {
			if (root.__DSH_REMOTE_DEVICES__ !== undefined) delete root.__DSH_REMOTE_DEVICES__;
		} catch (error) {
			try {
				root.__DSH_REMOTE_DEVICES__ = undefined;
			} catch (inner) {
				/* 连写都写不进去：只能算了 */
			}
		}
		try {
			var view = root.window;
			if (view !== null && view !== undefined && view !== root && view.__DSH_REMOTE_DEVICES__ !== undefined) {
				delete view.__DSH_REMOTE_DEVICES__;
			}
		} catch (error) {
			/* 忽略 */
		}
		try {
			var node = devicesNode;
			if (node === null || node === undefined) {
				var doc = root.document;
				if (doc !== null && typeof doc === "object" && typeof doc.getElementById === "function") {
					node = doc.getElementById(DEVICES_NODE_ID);
				}
			}
			if (node !== null && node !== undefined) {
				var parent = node.parentNode;
				if (parent !== null && parent !== undefined && typeof parent.removeChild === "function") parent.removeChild(node);
				else if (typeof node.remove === "function") node.remove();
			}
		} catch (error) {
			/* 摘不掉也不能影响页面 */
		}
		devicesNode = null;
	}

	// 正常模式（含 force-active）才发布：惰性路径早就 return 了，那个窗口本来就不该有设备表。
	publishDeviceTable(buildEntries());
	/** 配置热重载：宿主半重新注入的新 payload 带着新设备表 ⇒ 只刷新"发布"这一件事。 */
	slot.refreshDevices = function (nextOptions) {
		try {
			var next = nextOptions !== null && typeof nextOptions === "object" ? nextOptions : null;
			if (next === null || !Array.isArray(next.devices)) return;
			var name = typeof next.localName === "string" && next.localName !== "" ? next.localName : localName;
			publishDeviceTable(entriesFromDevices(next.devices, name));
		} catch (error) {
			/* 刷新失败就保持老的那份发布 */
		}
	};
	/** 卸载路径（宿主半 / 客户端半想主动收走时）：见 retractDeviceTable。 */
	slot.retractDevices = retractDeviceTable;

	//#endregion

	/** 自测要用：两条自愈有没有动过手、还登记着几个定时器。 */
	slot.checks = function () {
		return {
			selfHealRan: selfHealRan,
			/** 只可能有那一个"可达性自愈"探测（**非回环会话**里才登记）：
			 *  本机态 / 回环会话 / 桌面壳（`dsh-app:`）恒为空数组，这条不变式由自测盯着。 */
			timers: healTimer === null ? [] : [healTimer],
		};
	};

	//#region URL 改写

	function hasScheme(value) {
		return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
	}

	/**
	 * "本机"的 authority 集合：当前文档的 host，加上 `__DSH_TRANSPORT__.streamBaseUrl`（桌面壳在
	 * 注入行之前就写好了它，值为本机 Host 的 origin）与 `document.baseURI` 的 host。
	 * 只**读** `__DSH_TRANSPORT__`，绝不改写它（I2）。
	 */
	function localHosts() {
		var hosts = [];
		function add(value) {
			if (typeof value !== "string" || value === "") return;
			for (var index = 0; index < hosts.length; index += 1) if (hosts[index] === value) return;
			hosts.push(value);
		}
		var location = root.location;
		if (location !== null && typeof location === "object") add(location.host);
		var transport = root.__DSH_TRANSPORT__;
		var base = transport !== null && typeof transport === "object" && typeof transport.streamBaseUrl === "string" ? transport.streamBaseUrl : "";
		if (base === "") {
			var doc = root.document;
			if (doc !== null && typeof doc === "object" && typeof doc.baseURI === "string") base = doc.baseURI;
		}
		if (base !== "" && typeof root.URL === "function" && location !== null && typeof location === "object" && typeof location.href === "string") {
			try {
				add(new root.URL(base, location.href).host);
			} catch (error) {
				/* 解析不了就算了，不影响其它 host */
			}
		}
		return hosts;
	}

	/** `/api…` → `/dev/<selected>/api…`；其它路径返回 null（原样放行）。 */
	function prefixPath(pathname) {
		if (typeof pathname !== "string" || pathname === "") return null;
		if (pathname === "/api" || pathname.slice(0, 5) === "/api/") return PREFIX + selected + pathname;
		return null;
	}

	/**
	 * 把一次请求 URL 改写到代理前缀下。
	 * - 字符串/URL 的**相对**写法 → 返回路径形式（如 `"/dev/home/api/sessions"`）
	 * - **绝对**写法 → 保留 scheme 与 host:port，只换路径
	 * - 不同源、或不是 api 路径 → 返回 null（调用方原样透传）
	 */
	function rewriteUrl(raw) {
		if (typeof raw !== "string" || raw === "") return null;
		var location = root.location;
		if (typeof root.URL !== "function" || location === null || typeof location !== "object" || typeof location.href !== "string") return null;
		var parsed = null;
		try {
			parsed = new root.URL(raw, location.href);
		} catch (error) {
			parsed = null;
		}
		if (parsed !== null) {
			var hosts = localHosts();
			var sameHost = false;
			for (var index = 0; index < hosts.length; index += 1) {
				if (hosts[index] === parsed.host) {
					sameHost = true;
					break;
				}
			}
			if (sameHost) {
				var path = prefixPath(parsed.pathname);
				if (path !== null) {
					if (hasScheme(raw)) return parsed.protocol + "//" + parsed.host + path + parsed.search + parsed.hash;
					return path + parsed.search + parsed.hash;
				}
			}
		}
		// 兜底：解析不出来（或 host 对不上）时，只认"相对写法 + 明显是 api 路径"的输入。
		if (!hasScheme(raw)) {
			var bare = raw.slice(0, 2) === "./" ? raw.slice(2) : raw;
			if (bare === "api" || bare.slice(0, 4) === "api/") return PREFIX + selected + "/" + bare;
		}
		return null;
	}

	//#endregion

	/**
	 * 0.25.8：远程模式下把 `<img src="/api/…">` 也改写到 `/dev/<id>/…`。
	 * 图片由浏览器直接加载，不经过 fetch/XHR 补丁，所以远程看别人的会话时
	 * 消息里的工作区图片会去**本机**找文件（404）——这里补上 DOM 侧改写。
	 */
	function patchImages() {
		var doc = root.document;
		if (doc === null || doc === undefined || typeof doc.createElement !== "function") return false;
		function rewrite(img) {
			try {
				if (img === null || img === undefined || typeof img.getAttribute !== "function") return;
				var original = img.getAttribute("data-dsh-remote-original");
				var current = img.getAttribute("src");
				if (original === null) {
					if (current === null || current === "") return;
					var next = rewriteUrl(current);
					if (next === null) return;
					img.setAttribute("data-dsh-remote-original", current);
					img.setAttribute("src", next);
					return;
				}
				var target = rewriteUrl(original);
				if (target !== null && current !== target) img.setAttribute("src", target);
			} catch (error) {
				/* 忽略 */
			}
		}
		function scan(node) {
			try {
				if (node === null || node === undefined) return;
				if (node.nodeType === 1 && node.tagName === "IMG") rewrite(node);
				var images = typeof node.querySelectorAll === "function" ? node.querySelectorAll("img") : null;
				if (images !== null) for (var index = 0; index < images.length; index += 1) rewrite(images[index]);
			} catch (error) {
				/* 忽略 */
			}
		}
		scan(doc.documentElement);
		var Observer = root.MutationObserver;
		if (typeof Observer !== "function") return true;
		try {
			var observer = new Observer(function (records) {
				for (var index = 0; index < records.length; index += 1) {
					var record = records[index];
					if (record.type === "attributes" && record.target) rewrite(record.target);
					else if (record.addedNodes) for (var at = 0; at < record.addedNodes.length; at += 1) scan(record.addedNodes[at]);
				}
			});
			observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
		} catch (error) {
			/* 忽略 */
		}
		return true;
	}

	//#region fetch / WebSocket / XHR 改写（幂等）

	function rebuildRequest(target, request) {
		var RequestCtor = root.Request;
		if (typeof RequestCtor !== "function") return target;
		try {
			return new RequestCtor(target, request);
		} catch (error) {
			/* 继续手工重建 */
		}
		try {
			var init = {
				method: request.method,
				headers: request.headers,
				mode: request.mode,
				credentials: request.credentials,
				cache: request.cache,
				redirect: request.redirect,
				referrer: request.referrer,
				referrerPolicy: request.referrerPolicy,
				integrity: request.integrity,
				keepalive: request.keepalive,
				signal: request.signal,
			};
			if (request.body !== null && request.body !== undefined) {
				init.body = request.body;
				init.duplex = "half";
			}
			return new RequestCtor(target, init);
		} catch (error) {
			/* 再退一步：退回纯 URL 字符串（fetch 的第二个参数仍然生效） */
		}
		return target;
	}

	function patchFetch() {
		var original = root.fetch;
		if (typeof original !== "function" || original.__dshRemotePatched === true) return false;
		function patchedFetch(input, init) {
			var self = this === undefined || this === null ? root : this;
			try {
				var replacement = null;
				if (typeof input === "string") {
					replacement = rewriteUrl(input);
				} else if (input !== null && typeof input === "object") {
					if (typeof input.url === "string" && typeof root.Request === "function") {
						var target = rewriteUrl(input.url);
						if (target !== null) replacement = rebuildRequest(target, input);
					} else if (typeof input.href === "string") {
						replacement = rewriteUrl(input.href);
					}
				}
				if (replacement !== null) return original.call(self, replacement, init);
			} catch (error) {
				/* 垫片绝不能把请求弄挂：改写失败就照原样发 */
			}
			return original.call(self, input, init);
		}
		patchedFetch.__dshRemotePatched = true;
		patchedFetch.__dshRemoteOriginal = original;
		root.fetch = patchedFetch;
		return true;
	}

	function patchWebSocket() {
		var Original = root.WebSocket;
		if (typeof Original !== "function" || Original.__dshRemotePatched === true) return false;
		function PatchedWebSocket(url, protocols) {
			var finalUrl = url;
			try {
				var raw = typeof url === "string" ? url : (url !== null && typeof url === "object" && typeof url.href === "string" ? url.href : null);
				var target = raw === null ? null : rewriteUrl(raw);
				if (target !== null) finalUrl = target;
			} catch (error) {
				finalUrl = url;
			}
			if (protocols === undefined) return new Original(finalUrl);
			return new Original(finalUrl, protocols);
		}
		PatchedWebSocket.prototype = Original.prototype;
		var constants = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
		for (var index = 0; index < constants.length; index += 1) {
			var key = constants[index];
			if (Original[key] !== undefined) PatchedWebSocket[key] = Original[key];
		}
		PatchedWebSocket.__dshRemotePatched = true;
		PatchedWebSocket.__dshRemoteOriginal = Original;
		root.WebSocket = PatchedWebSocket;
		return true;
	}

	function patchXhr() {
		var Original = root.XMLHttpRequest;
		if (typeof Original !== "function" || Original.prototype === null || Original.prototype === undefined) return false;
		var originalOpen = Original.prototype.open;
		if (typeof originalOpen !== "function" || originalOpen.__dshRemotePatched === true) return false;
		function patchedOpen(method, url) {
			var finalUrl = url;
			try {
				var raw = typeof url === "string" ? url : (url !== null && typeof url === "object" && typeof url.href === "string" ? url.href : null);
				var target = raw === null ? null : rewriteUrl(raw);
				if (target !== null) finalUrl = target;
			} catch (error) {
				finalUrl = url;
			}
			var rest = Array.prototype.slice.call(arguments, 2);
			return originalOpen.apply(this, [method, finalUrl].concat(rest));
		}
		patchedOpen.__dshRemotePatched = true;
		// 自除时要靠它还原（见 restorePrimitives / softOff）。
		patchedOpen.__dshRemoteOriginal = originalOpen;
		try {
			Original.prototype.open = patchedOpen;
		} catch (error) {
			return false;
		}
		return true;
	}

	if (selected !== "") {
		if (patchFetch()) slot.patched.push("fetch");
		if (patchWebSocket()) slot.patched.push("websocket");
		if (patchXhr()) slot.patched.push("xhr");
		if (patchImages()) slot.patched.push("images");
	}

	//#endregion

	//#region 设备列表（构表：给"无声发布设备表"用；垫片自己不画任何 UI）

	function loadDevices() {
		var list = [];
		var seen = {};
		function push(entry) {
			if (entry === null || typeof entry !== "object") return;
			var id = normalizeId(entry.id);
			if (id === "" || seen[id] === true) return;
			seen[id] = true;
			var name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id;
			list.push({ id: id, name: name });
		}
		var parsed = null;
		var raw = readFirst(KEYS_DEVICES);
		if (raw !== null) {
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				parsed = null;
			}
		}
		var source = Array.isArray(parsed) ? parsed : defaults;
		for (var index = 0; index < source.length; index += 1) push(source[index]);
		// 选中了一台当前列表里没有的设备（配置改过 / 设备被删）：也让它出现在发布的设备表里，好切回来。
		if (selected !== "" && seen[selected] !== true) list.push({ id: selected, name: selected });
		return list;
	}

	/** 条目：本机（id 为空串）在最前，其后是所有设备。 */
	/**
	 * 发布给前端设备表的构造：**以宿主注入的 payload 为准**。
	 * 旧版 localStorage 里的 `KEYS_DEVICES` 可能残留"自指设备"（这台机器自己那一条），
	 * 若把它也发布出去，切换菜单里就会多出一台和"本机"同名的设备（0.13.6 修复）。
	 * payload 为空（老宿主/老窗口）时才退回 localStorage，保持兼容。
	 */
	function buildEntries() {
		var entries = [{ id: "", name: localName }];
		var list = [];
		for (var at = 0; at < defaults.length; at += 1) {
			var entry = defaults[at];
			if (entry === null || typeof entry !== "object") continue;
			var entryId = normalizeId(entry.id);
			if (entryId === "") continue;
			list.push({ id: entryId, name: typeof entry.name === "string" && entry.name !== "" ? entry.name : entryId });
		}
		if (list.length === 0) {
			var legacy = loadDevices();
			for (var index = 0; index < legacy.length; index += 1) list.push(legacy[index]);
		}
		for (var index2 = 0; index2 < list.length; index2 += 1) entries.push(list[index2]);
		return entries;
	}


	// 同步 patch 都已经就位了，现在才异步自检（时序：绝不让首屏请求等这次探测）。
	checkHostState();
	// 自愈：立刻做一次**同步判据**（选中的 id 在不在配置里），不在就清键 + 刷一次回本机。
	selfHealStart();
	// 自愈第二条（0.12.0）：**非回环会话**（手机 / 浏览器走 edge）才起那条可达性探测。
	// 桌面壳（`dsh-app:`）与本机 127.0.0.1 一律不起（用户明确不要"切过去又被弹回来"）。
	healStart();

	return slot;
}
