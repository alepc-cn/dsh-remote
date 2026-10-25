/**
 * 凭据 / 会话层：token 存储（凭据服务优先、数据文件退化）、远端会话 cookie jar、
 * token 兑换，以及 401/403 的提示与恢复。
 *
 * 从 lib/index.js 原样搬出（重构第 9 刀，行为一个字节都没改）。搬出的符号：
 *  - 存取器：createTokenStore / createSessionStore
 *  - ref 迁移与结算：migrateAuthorityRefs / copyAuthorityCredentials / migrateFileTokens /
 *    scheduleSeedTokenSettlement
 *  - 会话引导：sessionPairFromSetCookie / exchangeToken / tokenFor / ensureSession /
 *    forgetSession / captureSession / cookieHeaderFor
 *  - 401/403：authRejectMessage / noteAuthRejected / clearAuthNotice
 *
 * 依赖：node:http / node:https；authorityOf / deviceIdOf / tokenRefFor / sessionRefFor /
 * legacyTokenRefFor / legacySessionRefFor / cookieNameFor / readCookie / unrefTimer /
 * messageOf / warn / info 来自 ./util.js；persistDataFile 来自 ./data.js（单向依赖，无环）。
 * 常量 AUTH_RETRY_MS / CONNECT_TIMEOUT_MS / SEED_TOKEN_SETTLE_MS / TOKEN_ABSENCE_TTL_MS /
 * USER_AGENT 由宿主半通过 configureStore() 注入 —— 本文件**不 import ./index.js**（避免循环引用）。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { persistDataFile } from "./data.js";
import {
	authorityOf, cookieNameFor, deviceIdOf, info, legacySessionRefFor, legacyTokenRefFor,
	messageOf, readCookie, sessionRefFor, tokenRefFor, unrefTimer, warn,
} from "./util.js";

/**
 * 宿主半（./index.js）注入的依赖 —— 同 ./data.js：依赖注入而不是 import ./index.js。
 * 由 index.js 在模块求值末尾调用 configureStore() 注入；本文件的函数只在**调用时**访问这些绑定。
 */
let AUTH_RETRY_MS, CONNECT_TIMEOUT_MS, SEED_TOKEN_SETTLE_MS, TOKEN_ABSENCE_TTL_MS, USER_AGENT;
export function configureStore(deps) {
	({ AUTH_RETRY_MS, CONNECT_TIMEOUT_MS, SEED_TOKEN_SETTLE_MS, TOKEN_ABSENCE_TTL_MS, USER_AGENT } = deps);
}

//#region token 存储（凭据服务优先，数据文件只做退化）

/**
 * 造一个 token 存取器。
 * - `credentials` 模式：每条设备一个 ref（`DSH_REMOTE_TOKEN_<sha256(id) 前 16 位>`），
 *   值落在 `$DSH_HOME/.credentials.yaml`，数据文件里只留 id/name/url；
 * - `file` 模式（凭据服务不可用）：退化到数据文件的 `tokens` 字段，并收紧文件权限，
 *   体检页与 README 都明确标注"token 明文存储"。
 */
function createTokenStore(runtime) {
	const usable = () => runtime.credentials !== undefined && runtime.credentials !== null;
	/**
	 * 凭据 ref：**优先 authority**（0.13.1 的修法）；拿不到 authority（坏条目/字符串 id）才退回
	 * 旧的 id ref，保证任何调用形态都不丢值。
	 */
	const refOf = (device) => {
		const authority = authorityOf(device);
		return authority === "" ? legacyTokenRefFor(deviceIdOf(device)) : tokenRefFor(authority);
	};
	return {
		mode: () => (usable() ? "credentials" : "file"),
		ref: (device) => (usable() ? refOf(device) : deviceIdOf(device)),
		async get(device) {
			const deviceId = deviceIdOf(device);
			if (usable()) {
				try {
					const ref = refOf(device);
					const hit = await runtime.credentials.resolve(ref);
					const value = hit !== null && typeof hit === "object" && typeof hit.value === "string" ? hit.value : "";
					return value === "" ? undefined : value;
				} catch (error) {
					warn(runtime.ctx, `读取凭据 ${refOf(device)} 失败：${messageOf(error)}`);
					return undefined;
				}
			}
			// 退化路线（凭据服务不可用）：数据文件的 tokens 字段仍按设备 id 存（沿用老形态）。
			// 种子里带过来的 token 先只放在内存里（见 scheduleSeedTokenSettlement：确认凭据服务
			// 不可用后才落盘，避免白白写一次明文）。
			const fromFile = runtime.fileTokens[deviceId];
			if (typeof fromFile === "string" && fromFile !== "") return fromFile;
			const fromSeed = runtime.seedTokens[deviceId];
			return typeof fromSeed === "string" && fromSeed !== "" ? fromSeed : undefined;
		},
		async set(device, token) {
			const deviceId = deviceIdOf(device);
			const value = typeof token === "string" ? token.trim() : "";
			if (value === "") return this.remove(device);
			if (usable()) {
				await runtime.credentials.set(refOf(device), value);
				return;
			}
			delete runtime.seedTokens[deviceId];
			runtime.fileTokens[deviceId] = value;
			runtime.tokenPlaintext = true;
		},
		async remove(device) {
			const deviceId = deviceIdOf(device);
			delete runtime.seedTokens[deviceId];
			if (usable()) {
				try {
					await runtime.credentials.unset(refOf(device));
				} catch (error) {
					warn(runtime.ctx, `移除凭据 ${refOf(device)} 失败：${messageOf(error)}`);
				}
				return;
			}
			delete runtime.fileTokens[deviceId];
		},
	};
}

/**
 * **远端会话 cookie** 的存储（0.8.1）：跟 token 同一套路线 ——
 *  - `credentials` 模式：`ctx.credentials` 里 `DSH_REMOTE_SESSION_<sha256(id) 前 16 位>` 记录；
 *  - `file` 模式：数据文件的 `sessions` 字段（明文，权限照 token 那套收紧）。
 *
 * 为什么非要有：cookie 以前只活在进程内存（`runtime.sessions`）里，**本机 DSH 一重启就没了**，
 * 于是每次都要拿 token 重新兑换 —— 而"对方也重启过"时 token 早已作废，症状就是"切过去一直连接中"
 * （2026-10-13 实战）。存下来之后，只要 cookie 没过期就能直接用 ——
 * 这跟"网页端把 cookie 存在浏览器里"是同一个效果（用户 2026-10-13 的原话）。
 */
function createSessionStore(runtime) {
	const usable = () => runtime.credentials !== undefined && runtime.credentials !== null;
	const refOf = (device) => {
		const authority = authorityOf(device);
		return authority === "" ? legacySessionRefFor(deviceIdOf(device)) : sessionRefFor(authority);
	};
	return {
		mode: () => (usable() ? "credentials" : "file"),
		ref: (device) => (usable() ? refOf(device) : deviceIdOf(device)),
		async get(device) {
			const deviceId = deviceIdOf(device);
			if (usable()) {
				try {
					const hit = await runtime.credentials.resolve(refOf(device));
					const value = hit !== null && typeof hit === "object" && typeof hit.value === "string" ? hit.value : "";
					return value === "" ? undefined : value;
				} catch (error) {
					warn(runtime.ctx, `读取凭据 ${refOf(device)} 失败：${messageOf(error)}`);
					return undefined;
				}
			}
			const fromFile = runtime.fileSessions[deviceId];
			return typeof fromFile === "string" && fromFile !== "" ? fromFile : undefined;
		},
		async set(device, cookie) {
			const deviceId = deviceIdOf(device);
			const value = typeof cookie === "string" ? cookie.trim() : "";
			if (value === "") return this.remove(device);
			if (usable()) {
				try {
					await runtime.credentials.set(refOf(device), value);
				} catch (error) {
					warn(runtime.ctx, `写入凭据 ${refOf(device)} 失败（这次的会话只留在内存里）：${messageOf(error)}`);
				}
				return;
			}
			runtime.fileSessions[deviceId] = value;
			runtime.sessionPlaintext = true;
			try {
				persistDataFile(runtime);
			} catch (error) {
				warn(runtime.ctx, `写数据文件的 sessions 字段失败（这次的会话只留在内存里）：${messageOf(error)}`);
			}
		},
		async remove(device) {
			const deviceId = deviceIdOf(device);
			if (usable()) {
				try {
					await runtime.credentials.unset(refOf(device));
				} catch (error) {
					warn(runtime.ctx, `移除凭据 ${refOf(device)} 失败：${messageOf(error)}`);
				}
				return;
			}
			if (runtime.fileSessions[deviceId] !== undefined) {
				delete runtime.fileSessions[deviceId];
				try {
					persistDataFile(runtime);
				} catch (error) {
					warn(runtime.ctx, `重写数据文件失败：${messageOf(error)}`);
				}
			}
		},
	};
}

/**
 * 0.13.1：把 0.12.x **按设备 id** 存下的 token / 会话 cookie **复制**到按 authority 的新 ref。
 *
 * - 新 ref 已有值 ⇒ 什么都不做（幂等；第二次启动不会再写一次）；
 * - 旧 ref 有值、新 ref 空 ⇒ 读旧值写新 ref；**旧 ref 不删**（安全回退，用户改回旧版也还在）；
 * - 任何一条读/写失败只 warn，**不阻塞启动**（认证退化成"这台要重新填一次 token"）。
 *
 * @returns 实际写入的条数（给自测断言"第二次启动不再写"用）。
 */
async function migrateAuthorityRefs(runtime, reason) {
	if (runtime.credentials === undefined || runtime.credentials === null) return 0;
	const devices = Array.isArray(runtime.devices) ? runtime.devices : [];
	if (devices.length === 0) return 0;
	const readValue = async (ref) => {
		const hit = await runtime.credentials.resolve(ref);
		return hit !== null && typeof hit === "object" && typeof hit.value === "string" ? hit.value.trim() : "";
	};
	let moved = 0;
	for (const device of devices) {
		const authority = authorityOf(device);
		const deviceId = deviceIdOf(device);
		if (authority === "" || deviceId === "") continue;
		const pairs = [
			["token", tokenRefFor(authority), legacyTokenRefFor(deviceId)],
			["会话 cookie", sessionRefFor(authority), legacySessionRefFor(deviceId)],
		];
		for (const [label, ref, oldRef] of pairs) {
			try {
				if ((await readValue(ref)) !== "") continue;
				const oldValue = await readValue(oldRef);
				if (oldValue === "") continue;
				await runtime.credentials.set(ref, oldValue);
				moved += 1;
			} catch (error) {
				warn(runtime.ctx, `迁移设备 "${deviceId}" 的${label}（${oldRef} → ${ref}）失败，继续用旧 ref：${messageOf(error)}`);
			}
		}
	}
	if (moved > 0) {
		info(runtime.ctx, `已把 ${String(moved)} 条 token/会话按 authority 复制到新 ref（${reason === undefined || reason === "" ? "启动" : String(reason)}；旧 ref 保留不删）`);
	}
	return moved;
}

/**
 * 0.13.1：同一台机器**换地址**（authority A → B）时，把 token / 会话 cookie 复制到 B 的 ref。
 * - 新 ref 已有值 ⇒ 不动；旧 ref 无值 ⇒ 不动；旧 ref 不删（改回旧地址还能用）。
 * - 失败只 warn（最坏就是"这台要重新认证一次"，符合预期）。
 */
async function copyAuthorityCredentials(runtime, fromAuthority, toAuthority) {
	if (runtime.credentials === undefined || runtime.credentials === null) return 0;
	if (fromAuthority === "" || toAuthority === "" || fromAuthority === toAuthority) return 0;
	const readValue = async (ref) => {
		const hit = await runtime.credentials.resolve(ref);
		return hit !== null && typeof hit === "object" && typeof hit.value === "string" ? hit.value.trim() : "";
	};
	let moved = 0;
	const pairs = [
		["token", tokenRefFor(toAuthority), tokenRefFor(fromAuthority)],
		["会话 cookie", sessionRefFor(toAuthority), sessionRefFor(fromAuthority)],
	];
	for (const [label, ref, oldRef] of pairs) {
		try {
			if ((await readValue(ref)) !== "") continue;
			const oldValue = await readValue(oldRef);
			if (oldValue === "") continue;
			await runtime.credentials.set(ref, oldValue);
			moved += 1;
		} catch (error) {
			warn(runtime.ctx, `设备换地址时复制${label}失败（${oldRef} → ${ref}）：${messageOf(error)}`);
		}
	}
	if (moved > 0) info(runtime.ctx, `设备换地址：已把 ${String(moved)} 条 token/会话从 ${fromAuthority} 复制到 ${toAuthority}（旧 ref 保留）`);
	return moved;
}

/**
 * 凭据服务可用后，把数据文件 / 种子里带过来的明文 token 搬进凭据服务并把它从文件里删掉。
 * 让"先退化成文件、后来有了凭据服务"的部署自动收敛，而不是一直明文躺着。
 */
async function migrateFileTokens(runtime) {
	if (runtime.credentials === undefined || runtime.credentials === null) return;
	const ids = [...new Set([...Object.keys(runtime.fileTokens), ...Object.keys(runtime.seedTokens)])];
	if (ids.length === 0) return;
	const moved = [];
	for (const id of ids) {
		const token = runtime.fileTokens[id] ?? runtime.seedTokens[id];
		if (typeof token !== "string" || token === "") continue;
		// 0.13.1：凭据 ref 按 authority；找不到设备（已删）才退回旧的 id ref。
		const device = runtime.devices.find((entry) => entry.id === id);
		const ref = device !== undefined && authorityOf(device) !== "" ? tokenRefFor(authorityOf(device)) : legacyTokenRefFor(id);
		try {
			await runtime.credentials.set(ref, token);
			delete runtime.fileTokens[id];
			delete runtime.seedTokens[id];
			runtime.tokenCache.delete(id);
			moved.push(id);
		} catch (error) {
			warn(runtime.ctx, `把设备 "${id}" 的明文 token 迁进凭据服务失败（继续明文保存）：${messageOf(error)}`);
		}
	}
	if (moved.length > 0) {
		info(runtime.ctx, `已把 ${String(moved.length)} 台设备的 token 从数据文件迁进凭据服务（数据文件里不再有明文）`);
		try {
			persistDataFile(runtime);
		} catch (error) {
			warn(runtime.ctx, `迁移后重写数据文件失败：${messageOf(error)}`);
		}
	}
}

/** 种子里带过来的 token 落在哪：确认凭据服务在场就迁走，否则（延迟一会儿后）落进数据文件。 */
function scheduleSeedTokenSettlement(runtime) {
	if (Object.keys(runtime.seedTokens).length === 0) return;
	const timer = setTimeout(() => {
		runtime.timers.delete(timer);
		if (Object.keys(runtime.seedTokens).length === 0) return;
		if (runtime.credentials !== undefined && runtime.credentials !== null) {
			void migrateFileTokens(runtime);
			return;
		}
		for (const [id, token] of Object.entries(runtime.seedTokens)) runtime.fileTokens[id] = token;
		runtime.seedTokens = Object.create(null);
		try {
			persistDataFile(runtime);
			warn(runtime.ctx, `profile 配置里种子的 token 已迁进数据文件（凭据服务不可用）：token 明文存储，请留意 ${runtime.dataPath} 的权限收紧结果。`);
		} catch (error) {
			warn(runtime.ctx, `种子 token 落盘失败：${messageOf(error)}`);
		}
	}, SEED_TOKEN_SETTLE_MS);
	unrefTimer(timer);
	runtime.timers.add(timer);
}

//#endregion

//#region 会话（cookie jar + token 引导）

/**
 * 向远端发起一次 token 兑换：`GET <base>/?token=…`。
 * 远端返回 303 + `Set-Cookie: dsh-auth-<hash>=…`；这里只取 cookie，不跟随跳转。
 * @returns 会话 cookie 值；没有就是 undefined。
 */
/**
 * 从上游 `set-cookie` 里挑出会话 cookie，返回 **`name=value` 整对**（找不到返回 undefined）。
 *
 * **名字以服务器给的为准**：对外入口会把 Host 统一改写成 `127.0.0.1:<内部端口>`，
 * 被连接方签发的 cookie 名字会跟着变成那个 authority 的派生名 —— 再用 `device.authority` 派生名去筛，
 * 就会一个都收不到（罐子永远空 → 每个请求都不带 cookie → 远端回 401）。0.10.2 修的就是这一刀。
 */
function sessionPairFromSetCookie(headers) {
	for (const header of headers) {
		const first = String(header).split(";", 1)[0];
		const at = first.indexOf("=");
		if (at <= 0) continue;
		const name = first.slice(0, at).trim();
		const value = first.slice(at + 1).trim();
		if (name === "" || value === "") continue;
		if (name.startsWith("dsh-auth-")) return `${name}=${value}`;
	}
	return undefined;
}

function exchangeToken(device, token) {
	return new Promise((resolve, reject) => {
		const url = new URL(`${device.origin}${device.basePath}/`);
		url.searchParams.set("token", token);
		const send = device.protocol === "https:" ? httpsRequest : httpRequest;
		const upstream = send({
			protocol: url.protocol,
			hostname: device.hostname,
			port: device.port === "" ? undefined : device.port,
			path: `${url.pathname}${url.search}`,
			method: "GET",
			headers: {
				host: device.authority,
				origin: device.origin,
				accept: "text/html",
				"user-agent": USER_AGENT,
			},
		}, (response) => {
			const headers = response.headers["set-cookie"] ?? [];
			response.resume();
			const pair = sessionPairFromSetCookie(headers);
			response.on("error", reject);
			response.on("end", () => {
				resolve(pair);
			});
		});
		const timer = setTimeout(() => {
			upstream.destroy(new Error(`token 兑换超时（${String(CONNECT_TIMEOUT_MS)} ms）`));
		}, CONNECT_TIMEOUT_MS);
		unrefTimer(timer);
		upstream.on("close", () => {
			clearTimeout(timer);
		});
		upstream.on("error", reject);
		upstream.end();
	});
}

/**
 * 取该设备的 token（带缓存）：命中缓存直接用；"确定没有"这个结论只缓存 10 秒，
 * 这样用户在设置页刚补上的 token 会很快生效。
 */
async function tokenFor(runtime, device) {
	const hit = runtime.tokenCache.get(device.id);
	if (hit !== undefined && (hit.value !== null || Date.now() < hit.expiresAt)) return hit.value === null ? undefined : hit.value;
	let value;
	try {
		value = await runtime.tokens.get(device);
	} catch (error) {
		warn(runtime.ctx, `读取设备 "${device.id}" 的 token 失败：${messageOf(error)}`);
		value = undefined;
	}
	const normalized = typeof value === "string" && value !== "" ? value : null;
	runtime.tokenCache.set(device.id, {
		value: normalized,
		expiresAt: normalized === null ? Date.now() + TOKEN_ABSENCE_TTL_MS : Number.POSITIVE_INFINITY,
	});
	return normalized === null ? undefined : normalized;
}

/**
 * 确保该设备有一份可用的宿主侧会话（没有配 token 时什么都不做）。
 * 并发调用共享同一次兑换；失败进入冷却期，避免每请求都打远端。
 * 本版没有"首页"请求了，所以由**第一个需要代理的请求**触发（约多一个 RTT，之后走 jar）。
 */
async function ensureSession(device, runtime) {
	if (runtime.sessions.has(device.id)) return;
	const store = runtime.sessionStore;
	// 0.8.1：先看**落盘**的那份会话 —— 本机重启后直接接着用，不必再拿 token 兑换一次。
	// （这正是"网页端 cookie 存在浏览器里"的等价物；见 createSessionStore 的说明。）
	if (store !== undefined && store !== null) {
		const persisted = await store.get(device);
		if (typeof persisted === "string" && persisted !== "") {
			runtime.sessions.set(device.id, persisted);
			return;
		}
	}
	const token = await tokenFor(runtime, device);
	if (token === undefined) return;
	const failedAt = runtime.authFailures.get(device.id);
	if (failedAt !== undefined && Date.now() - failedAt < AUTH_RETRY_MS) return;
	const running = runtime.pendingSessions.get(device.id);
	if (running !== undefined) {
		await running.catch(() => {});
		return;
	}
	const pending = (async () => {
		try {
			const value = await exchangeToken(device, token);
			if (value === undefined) {
				runtime.authFailures.set(device.id, Date.now());
				warn(runtime.ctx, `设备 "${device.id}" 的 token 兑换没有拿到会话 cookie（token 是否已过期？）`);
				return;
			}
			runtime.sessions.set(device.id, value);
			runtime.authFailures.delete(device.id);
			if (store !== undefined && store !== null) void store.set(device, value);
		} catch (error) {
			runtime.authFailures.set(device.id, Date.now());
			warn(runtime.ctx, `设备 "${device.id}" 的 token 兑换失败：${messageOf(error)}`);
		}
	})();
	runtime.pendingSessions.set(device.id, pending);
	try {
		await pending;
	} finally {
		runtime.pendingSessions.delete(device.id);
	}
}

/**
 * 丢掉这台设备的宿主侧会话（内存 + 落盘）。两处用得上：
 *  ① 远端回 **401/403**（这份 cookie 已经不被认了：过期 / 身份记录被换 / 对端重启过 / authority 变了）；
 *  ② 设备被删掉。
 * 以前缺这一步：401 之后一直拿旧 cookie 打，症状是"切过去一直连接中"（2026-10-13 实战）。
 * **0.13.1 起改 token 不再调用它**：换 token 时保留旧 cookie（见 upsertDevice），等真实 401/403 再说。
 * @param {object|string} device 设备对象（新代码）或设备 id（旧调用形态）
 */
function forgetSession(runtime, device, reason) {
	const deviceId = deviceIdOf(device);
	const had = runtime.sessions.delete(deviceId);
	runtime.authFailures.delete(deviceId);
	runtime.tokenCache.delete(deviceId);
	const store = runtime.sessionStore;
	if (store !== undefined && store !== null) void store.remove(device);
	if (had === true && reason !== "") {
		warn(runtime.ctx, `设备 "${deviceId}" 的会话 cookie 已丢弃（${reason}），下一次请求会用最新 token 重新兑换`);
	}
}

/** 从上游 `set-cookie` 里抓该设备的会话 cookie 存进 jar。 */
function captureSession(device, setCookieHeaders, runtime) {
	// 名字以服务器给的为准（见 sessionPairFromSetCookie 的说明）：对外入口改写 Host 后仍能收到会话。
	const pair = sessionPairFromSetCookie(setCookieHeaders);
	if (pair === undefined) return;
	runtime.sessions.set(device.id, pair);
	// 0.8.1：远端重新发过 cookie 就顺手落盘（覆盖旧的）。
	const store = runtime.sessionStore;
	if (store !== undefined && store !== null) void store.set(device, pair);
}

/**
 * 决定这次请求往上游带哪个 Cookie。
 * 优先宿主侧 jar（桌面窗口里浏览器侧根本拿不到远端的 set-cookie），
 * 其次才是浏览器带来的、**名字正好等于本设备派生名**的那一个 —— 顺带保证
 * 本机自己的 `dsh-auth-<本机authority hash>` 绝不会被发到别的机器上。
 */
function cookieHeaderFor(device, clientCookie, runtime) {
	const cookieName = cookieNameFor(device.authority);
	// 罐子里存的是**服务器给的名字**（0.10.2 起是 `name=value` 整对），直接原样发。
	const jar = runtime.sessions.get(device.id);
	if (jar !== undefined) return jar;
	const value = readCookie(clientCookie, cookieName);
	return value === undefined ? undefined : `${cookieName}=${value}`;
}

/**
 * 0.13.1：401/403 给**人看得懂**的一句话（写进 state.devices[].lastError 与 notes，日志同义）。
 * 不打印 token / cookie 全文，只提 HTTP 状态。
 */
function authRejectMessage(status) {
	const code = Number.isFinite(status) && status > 0 ? String(status) : "401/403";
	return `对端拒绝了会话/令牌（HTTP ${code}）：可能对端重启过，请在那台机器设置页重新复制 token 填过来`;
}

/**
 * 记下"这台设备最近被对端拒绝了一次"（401/403）。
 * - 只在状态变化时打日志（跨机实时状态每 5 秒轮询一次，别把日志刷爆）；
 * - **不动 reach.reachable**：对端是活的、只是认证不认 —— 不能因此被判"不可达"而禁止切换。
 * - 0.13.2：允许传一句**更具体**的提示（体太大无法重放时用它替掉默认那句）。
 */
function noteAuthRejected(runtime, device, status, messageOverride) {
	if (runtime === null || typeof runtime !== "object") return;
	const deviceId = deviceIdOf(device);
	if (deviceId === "") return;
	if (!(runtime.authNotices instanceof Map)) runtime.authNotices = new Map();
	const message = typeof messageOverride === "string" && messageOverride !== ""
		? messageOverride
		: authRejectMessage(status);
	const previous = runtime.authNotices.get(deviceId);
	runtime.authNotices.set(deviceId, { status: Number(status), message, at: Date.now() });
	if (previous === undefined || previous.status !== status || previous.message !== message) {
		warn(runtime.ctx, `设备 "${deviceId}"：${message}`);
	}
}

/** 认证恢复了（拿到非 401/403 的响应）⇒ 清掉那条提示。 */
function clearAuthNotice(runtime, deviceId) {
	if (runtime === null || typeof runtime !== "object" || !(runtime.authNotices instanceof Map)) return;
	if (runtime.authNotices.delete(deviceId)) {
		info(runtime.ctx, `设备 "${deviceId}"：认证已恢复（不再提示重新填 token）`);
	}
}

//#endregion

export {
	authRejectMessage, captureSession, clearAuthNotice, cookieHeaderFor, copyAuthorityCredentials,
	createSessionStore, createTokenStore, ensureSession, forgetSession, migrateAuthorityRefs,
	migrateFileTokens, noteAuthRejected, scheduleSeedTokenSettlement, sessionPairFromSetCookie,
};
