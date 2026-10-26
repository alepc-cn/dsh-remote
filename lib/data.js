/**
 * 数据文件层（`$DSH_HOME/remote-devices.json`）：读 / 渲染 / 落盘 / 热重载 / 权限收紧，
 * 外加「分叉带走的条数」这个数据文件字段（`forkTailN`）的规范化与生效值。
 *
 * 从 lib/index.js 原样搬出（重构第 8 刀，行为一个字节都没改）。搬出的符号：
 *  - 常量：DATA_FILE_NAME / DATA_TOKENS_FIELD / DATA_SESSIONS_FIELD / DATA_EDGE_FIELD /
 *    DATA_FORK_TAIL_FIELD / DATA_RELOAD_MIN_INTERVAL_MS
 *  - 「分叉带走的条数」：FORK_DEFAULT_TAIL / FORK_MAX_TAIL / FORK_MIN_TAIL /
 *    normalizeForkTail / effectiveForkTail
 *  - 路径与记录形状：resolveDataPath / cleanStoredDevice
 *  - 读写与热重载：readDataFile / renderDataFile / hardenDataFile / persistDataFile /
 *    adoptData / maybeReloadData
 *
 * 依赖：node:fs / node:path / node:child_process；toPort / warn / info / messageOf 来自
 * ./util.js，dshHome 来自 ./logging.js，syncEdge 来自 ./edge.js（全是单向依赖，无环）。
 *
 * 还有两项由宿主半通过 configureData() **注入**（本文件**不 import ./index.js**）：
 *  - refreshDevices：index.js 的「重算设备表 + 同步路由」（热重载后要重算路由）；
 *  - migrateFileTokens：./store.js 的「把明文 token 迁进凭据服务」。data ↔ store 互相需要的
 *    只有这一处，所以走注入而不是 import —— 两个模块之间没有任何循环引用。
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { syncEdge } from "./edge.js";
import { dshHome } from "./logging.js";
import { info, messageOf, toPort, warn } from "./util.js";

/**
 * 宿主半（./index.js）注入的依赖 —— 用依赖注入而不是 import ./index.js，
 * 避免 index ↔ 本文件 的 ESM 循环引用（也避免为了内部符号去扩大 index.js 的 export 面）。
 * 由 index.js 在模块求值末尾调用 configureData() 注入；本文件的函数只在**调用时**访问这些绑定。
 */
let migrateFileTokens, refreshDevices;
export function configureData(deps) {
	({ migrateFileTokens, refreshDevices } = deps);
}

// ---- 数据文件字段名 / 热重载间隔（{@link renderDataFile} 与 {@link readDataFile} 共用） ----

/** 设备数据文件名（放在 `$DSH_HOME` 下，绝不写 profile patch）。 */
const DATA_FILE_NAME = "remote-devices.json";
/** 数据文件里 tokens 字段只用于"凭据服务不可用"的退化路线（见 README）。 */
const DATA_TOKENS_FIELD = "tokens";
/** 数据文件里 sessions 字段同理（0.8.1：远端会话 cookie 的退化落点）。 */
const DATA_SESSIONS_FIELD = "sessions";
/** 数据文件里「对外入口」字段（0.10.0）：`{ enabled, port }`。 */
const DATA_EDGE_FIELD = "edge";
/** 数据文件里「分叉带走的条数」字段（缺省不写这个键 = 用 {@link FORK_DEFAULT_TAIL}）。 */
const DATA_FORK_TAIL_FIELD = "forkTailN";
/** 数据文件热重载的最小间隔（手改文件后最多 1 秒生效）。 */
const DATA_RELOAD_MIN_INTERVAL_MS = 1_000;

// ---- 「分叉带走的条数」：数据文件里 `forkTailN` 字段的规范形式与生效值 ----

/** 分叉时回看的消息条数：缺省、下限与上限（可在设置页「配置」块里改，存数据文件、立即生效）。 */
const FORK_DEFAULT_TAIL = 20;
const FORK_MAX_TAIL = 200;
const FORK_MIN_TAIL = 1;

/**
 * 「分叉带走的条数」的规范形式：`FORK_MIN_TAIL..FORK_MAX_TAIL` 的**整数**。
 * 只认 number，与 `tailN` 的既有契约一致：小数 / 越界 / 字符串 / null 一律 `undefined`（= 不合法）。
 */
function normalizeForkTail(value) {
	if (!Number.isSafeInteger(value)) return undefined;
	return value >= FORK_MIN_TAIL && value <= FORK_MAX_TAIL ? value : undefined;
}

/** 生效的「分叉带走的条数」：数据文件里存的值 → 缺省 {@link FORK_DEFAULT_TAIL}。 */
function effectiveForkTail(runtime) {
	const stored = normalizeForkTail(runtime.data.forkTailN);
	return stored === undefined ? FORK_DEFAULT_TAIL : stored;
}

/** 数据文件的最终路径（`config.dataFile` 只为自测/特殊部署预留）。 */
function resolveDataPath(config) {
	const override = config !== null && typeof config === "object" && typeof config.dataFile === "string" ? config.dataFile.trim() : "";
	if (override !== "") return override;
	return join(dshHome(), DATA_FILE_NAME);
}

/** 设备数据文件里的一条记录（只保留契约里那三个字段）。 */
/**
 * 每台设备的快捷键：`""` = 默认（按顺序 Alt+1..9）、`"off"` = 关闭、其余为组合键
 * （例如 `alt+1`、`ctrl+alt+k`、`f2` 前必须带修饰键）。非法值返回 `undefined`。
 * 规范化：修饰键固定顺序 ctrl+alt+shift+meta，键名小写。
 */
function normalizeHotkey(value) {
	const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (raw === "" || raw === "off") return raw;
	const parts = raw.split("+").map((part) => part.trim()).filter((part) => part !== "");
	if (parts.length < 2) return undefined;
	const key = parts[parts.length - 1];
	const mods = parts.slice(0, -1);
	if (!/^[a-z0-9]$/u.test(key) && !/^f(?:[1-9]|1[0-2])$/u.test(key)) return undefined;
	const order = ["ctrl", "alt", "shift", "meta"];
	const modSet = new Set();
	for (const mod of mods) {
		if (!order.includes(mod)) return undefined;
		modSet.add(mod);
	}
	if (modSet.size < 1) return undefined;
	return order.filter((mod) => modSet.has(mod)).join("+") + "+" + key;
}

function cleanStoredDevice(entry) {
	const hotkey = normalizeHotkey(typeof entry.hotkey === "string" ? entry.hotkey : "");
	const out = {
		id: typeof entry.id === "string" ? entry.id.trim() : "",
		name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : "",
		url: typeof entry.url === "string" ? entry.url.trim() : "",
	};
	if (hotkey !== undefined && hotkey !== "") out.hotkey = hotkey;
	return out;
}

//#region 数据文件（$DSH_HOME/remote-devices.json）

/**
 * 读取数据文件。**同步**读：`apply()` 必须同步知道"启用/设备表"，
 * 否则 device-switch 那套"apply 之后路由就在"的语义会碎掉。
 * @returns `{ enabled, devices, current, tokens, existed }`，读不到/坏文件时返回 null。
 */
function readDataFile(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
		throw error;
	}
	const parsed = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("数据文件的根必须是 JSON 对象");
	}
	const devices = [];
	for (const entry of Array.isArray(parsed.devices) ? parsed.devices : []) {
		const device = cleanStoredDevice(entry === null || typeof entry !== "object" ? {} : entry);
		if (device.id !== "" && device.url !== "") devices.push(device);
	}
	const tokens = Object.create(null);
	const rawTokens = parsed[DATA_TOKENS_FIELD];
	if (rawTokens !== null && typeof rawTokens === "object" && !Array.isArray(rawTokens)) {
		for (const [key, value] of Object.entries(rawTokens)) {
			if (typeof value === "string" && value !== "") tokens[key] = value;
		}
	}
	const sessions = Object.create(null);
	const rawSessions = parsed[DATA_SESSIONS_FIELD];
	if (rawSessions !== null && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
		for (const [key, value] of Object.entries(rawSessions)) {
			if (typeof value === "string" && value !== "") sessions[key] = value;
		}
	}
	// 0.10.0：对外入口（{ enabled, port }）。
	const rawEdge = parsed[DATA_EDGE_FIELD];
	const edge = {
		enabled: rawEdge !== null && typeof rawEdge === "object" && !Array.isArray(rawEdge) && rawEdge.enabled === true,
		port: rawEdge !== null && typeof rawEdge === "object" && !Array.isArray(rawEdge) ? toPort(rawEdge.port) : undefined,
	};
	return {
		enabled: parsed.enabled !== false,
		devices,
		current: typeof parsed.current === "string" ? parsed.current.trim() : "",
		forkTailN: normalizeForkTail(parsed[DATA_FORK_TAIL_FIELD]),
		tokens,
		sessions,
		edge,
		localHotkey: normalizeHotkey(typeof parsed.localHotkey === "string" ? parsed.localHotkey : "") ?? "",
		localOrder: Number.isInteger(parsed.localOrder) && parsed.localOrder >= 0 ? parsed.localOrder : 0,
		existed: true,
	};
}

/** 数据文件的内容（**只有契约里那三个键**；token 只在退化路线下出现）。 */
function renderDataFile(runtime) {
	const payload = {
		enabled: runtime.data.enabled === true,
		devices: runtime.data.devices.map((entry) => cleanStoredDevice(entry)),
	};
	if (typeof runtime.data.current === "string" && runtime.data.current !== "") payload.current = runtime.data.current;
	const forkTail = normalizeForkTail(runtime.data.forkTailN);
	if (forkTail !== undefined) payload[DATA_FORK_TAIL_FIELD] = forkTail;
	if (runtime.tokens.mode() === "file" && Object.keys(runtime.fileTokens).length > 0) {
		payload[DATA_TOKENS_FIELD] = { ...runtime.fileTokens };
	}
	// 0.8.1：远端会话 cookie 的退化落点。主路线（凭据服务）下这里**一个字节都不写**。
	if (runtime.tokens.mode() === "file" && Object.keys(runtime.fileSessions).length > 0) {
		payload[DATA_SESSIONS_FIELD] = { ...runtime.fileSessions };
	}
	// 0.10.0：对外入口配置（只写真正的值，缺省不落键）。
	const edge = runtime.data.edge ?? {};
	if (edge.enabled === true || toPort(edge.port) !== undefined) {
		payload[DATA_EDGE_FIELD] = {
			enabled: edge.enabled === true,
			...(toPort(edge.port) === undefined ? {} : { port: toPort(edge.port) }),
		};
	}
	// 0.24.0：本机行的快捷键与位置（默认值不落键）。
	const localHotkey = normalizeHotkey(runtime.data.localHotkey);
	if (localHotkey !== undefined && localHotkey !== "") payload.localHotkey = localHotkey;
	if (Number.isInteger(runtime.data.localOrder) && runtime.data.localOrder > 0) payload.localOrder = runtime.data.localOrder;
	return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * 收紧数据文件权限。POSIX 上 `chmod 0600` 就是"仅当前用户可读"；
 * Windows 没有可检查的 mode（Node 的 chmod 只切只读位），所以额外尽力调一次 `icacls`
 * （去掉继承 + 只给当前用户完全控制），失败就如实记录在体检页里。
 * @returns 一句话说明，写进 `diagnostics.notes`。
 */
function hardenDataFile(path) {
	let note = "";
	if (process.platform !== "win32") {
		try {
			chmodSync(path, 0o600);
			return "已 chmod 600（仅属主可读）";
		} catch (error) {
			return `chmod 600 失败：${messageOf(error)}`;
		}
	}
	try {
		chmodSync(path, 0o600);
		note = "chmod 600";
	} catch (error) {
		note = `chmod 失败：${messageOf(error)}`;
	}
	const who = typeof process.env.USERNAME === "string" && process.env.USERNAME.trim() !== ""
		? process.env.USERNAME.trim()
		: (typeof process.env.USER === "string" ? process.env.USER.trim() : "");
	if (who !== "") {
		try {
			execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${who}:F`], { stdio: "ignore", timeout: 5_000, windowsHide: true });
			return `${note} + icacls（继承已去掉，只授 "${who}"）`;
		} catch (error) {
			return `${note}；icacls 收紧失败（Windows 上 chmod 不能真正收紧 ACL）：${messageOf(error)}`;
		}
	}
	return `${note}；Windows 上无法用 icacls 确认 ACL（USERNAME 为空）`;
}

/** 写数据文件（临时文件 + 改名，尽量原子），并回写 stamp 免得自己触发一次热重载。 */
function persistDataFile(runtime) {
	const path = runtime.dataPath;
	const text = renderDataFile(runtime);
	const temp = `${path}.tmp-${String(process.pid)}`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, path);
	let stamp = null;
	try {
		const stat = statSync(path);
		stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
	} catch {
		stamp = null;
	}
	runtime.dataStamp = stamp;
	// 只在"文件里真的要放明文 token"时收紧权限：主路线（凭据服务）下这个文件里没有机密，
	// 不必为它同步起一次 icacls 拖慢插件激活。
	const holdsPlaintext = runtime.tokens.mode() === "file"
		&& (Object.keys(runtime.fileTokens).length > 0 || Object.keys(runtime.seedTokens).length > 0
			|| Object.keys(runtime.fileSessions).length > 0);
	if (holdsPlaintext) runtime.hardeningNote = hardenDataFile(path);
	return text;
}

/** 把从文件里读到的东西装进运行时（含"凭据服务可用时把明文 token 迁走"）。 */
function adoptData(runtime, loaded) {
	runtime.data.enabled = loaded.enabled !== false;
	runtime.data.devices = loaded.devices.map((entry) => cleanStoredDevice(entry));
	runtime.data.current = typeof loaded.current === "string" ? loaded.current : "";
	runtime.data.forkTailN = normalizeForkTail(loaded.forkTailN);
	if (loaded.edge !== undefined && loaded.edge !== null && typeof loaded.edge === "object") {
		runtime.data.edge = { enabled: loaded.edge.enabled === true, port: toPort(loaded.edge.port) };
	}
	if (loaded.sessions !== undefined && typeof loaded.sessions === "object") {
		runtime.fileSessions = Object.create(null);
		for (const [key, value] of Object.entries(loaded.sessions)) {
			if (typeof value === "string" && value !== "") runtime.fileSessions[key] = value;
		}
	}
	// 0.24.0：本机行的快捷键与位置。
	const loadedLocalHotkey = normalizeHotkey(typeof loaded.localHotkey === "string" ? loaded.localHotkey : "");
	runtime.data.localHotkey = loadedLocalHotkey === undefined ? "" : loadedLocalHotkey;
	runtime.data.localOrder = Number.isInteger(loaded.localOrder) && loaded.localOrder >= 0 ? loaded.localOrder : 0;
	if (loaded.tokens !== undefined && typeof loaded.tokens === "object") {
		runtime.fileTokens = Object.create(null);
		for (const [key, value] of Object.entries(loaded.tokens)) {
			if (typeof value === "string" && value !== "") runtime.fileTokens[key] = value;
		}
	}
}

/**
 * 手改数据文件也活着生效：stat 一下，变了就整体重读（最多每 1 秒一次）。
 * @returns 是否真的重载了。
 */
function maybeReloadData(runtime, force) {
	const now = Date.now();
	if (force !== true && now - runtime.lastReloadCheckAt < DATA_RELOAD_MIN_INTERVAL_MS) return false;
	runtime.lastReloadCheckAt = now;
	let stat;
	try {
		stat = statSync(runtime.dataPath);
	} catch {
		return false; // 文件被删/读不到：保持内存状态，不因为一次误删把设备清空
	}
	const stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
	if (stamp === runtime.dataStamp) return false;
	let loaded;
	try {
		loaded = readDataFile(runtime.dataPath);
	} catch (error) {
		warn(runtime.ctx, `数据文件解析失败，继续用内存里的状态：${messageOf(error)}`);
		runtime.dataStamp = stamp;
		return false;
	}
	runtime.dataStamp = stamp;
	if (loaded === null) return false;
	adoptData(runtime, loaded);
	syncEdge(runtime);
	info(runtime.ctx, `数据文件变化已生效：enabled=${String(runtime.data.enabled)}，设备 ${String(runtime.devices.length)} 台（重算路由）`);
	refreshDevices(runtime);
	void migrateFileTokens(runtime);
	return true;
}

//#endregion

export {
	DATA_FILE_NAME, DATA_FORK_TAIL_FIELD, DATA_SESSIONS_FIELD, DATA_TOKENS_FIELD,
	FORK_DEFAULT_TAIL, FORK_MAX_TAIL, FORK_MIN_TAIL,
	adoptData, effectiveForkTail, maybeReloadData, normalizeForkTail, normalizeHotkey,
	persistDataFile, readDataFile, renderDataFile, resolveDataPath,
};
