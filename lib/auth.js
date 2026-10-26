/**
 * 0.28.0：跨机认证（单一路径）。
 *
 * 模型（用户定稿）：
 * 1. **首次配对**：调用方带「配对密钥」+「自己的 hostname」来；对端核对密钥，
 *    一致 ⇒ 把 (来源 IP, hostname) 写入白名单，并给调用方发一张"门卡"（DSH 会话 cookie，由 edge 维护）；
 * 2. **后续**：只凭 (来源 IP, hostname) 命中白名单即可；门卡过期由 edge 自动兑换新的。
 *
 * 因此本文件只负责两件事：
 * - 出站：{@link peerHeaders} 给跨机请求加身份头（hostname 每次带；密钥只在"还没配对成功"时带一次）；
 * - 入站：白名单的规范化/匹配/记录与密钥轮换（{@link rotateDeviceKey}）。
 *
 * 旧 token 路径（token 兑换 cookie / 浏览器 cookie 互通）已**删除**，不做兼容。
 */

import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";

import { messageOf } from "./util.js";

/** 出站身份头：调用方 hostname（每次都要带，edge 用它 + 来源 IP 做白名单匹配）。 */
export const PEER_HOST_HEADER = "x-dsh-remote-host";
/** 出站配对密钥头：只在设备还没配对成功时带。 */
export const PEER_KEY_HEADER = "x-dsh-remote-key";

/**
 * 跨机请求要带的身份头。
 * @param {object} runtime 插件运行时
 * @param {object} device 归一化后的设备（含 key / paired）
 * @returns {object} 可直接展开到请求头里
 */
export function peerHeaders(runtime, device) {
	let hostname = runtime !== null && runtime !== undefined && runtime.facts !== null && runtime.facts !== undefined
		? String(runtime.facts.hostname ?? "")
		: "";
	if (hostname === "") hostname = osHostname();
	const headers = {};
	if (hostname !== "") headers[PEER_HOST_HEADER] = hostname;
	if (device !== null && device !== undefined && device.paired !== true && typeof device.key === "string" && device.key !== "") {
		headers[PEER_KEY_HEADER] = device.key;
	}
	return headers;
}

/** 设备这次成功连上了 ⇒ 记为已配对（持久化，之后不再带密钥）。 */
export function markPaired(runtime, device) {
	if (runtime === null || typeof runtime !== "object" || runtime.data === null || typeof runtime.data !== "object") return;

	if (device === null || device === undefined || device.paired === true) return false;
	const entry = runtime.data.devices.find((item) => item !== null && typeof item === "object" && item.id === device.id);
	if (entry === undefined) return false;
	entry.paired = true;
	device.paired = true;
	try {
		persist(runtime);
	} catch {
		/* 持久化失败只影响下次启动，不影响本次 */
	}
	return true;
}

/** 设备被拒（401/403）⇒ 清掉配对标记，下次请求重新带密钥。 */
export function unmarkPaired(runtime, device) {
	if (runtime === null || typeof runtime !== "object" || runtime.data === null || typeof runtime.data !== "object") return;

	if (device === null || device === undefined) return false;
	const entry = runtime.data.devices.find((item) => item !== null && typeof item === "object" && item.id === device.id);
	let changed = false;
	if (device.paired === true) {
		device.paired = false;
		changed = true;
	}
	if (entry !== undefined && entry.paired !== undefined) {
		delete entry.paired;
		changed = true;
	}
	if (changed === true) {
		try {
			persist(runtime);
		} catch {
			/* 忽略 */
		}
	}
	return changed;
}

/** 白名单条目规范化：只留 ip / hostname / name / pairedAt。 */
export function normalizeClients(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	const seen = new Set();
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const ip = typeof item.ip === "string" ? item.ip.trim() : "";
		const hostname = typeof item.hostname === "string" ? item.hostname.trim() : "";
		if (ip === "" || hostname === "") continue;
		const key = ip + "\u0000" + hostname;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			ip,
			hostname,
			name: typeof item.name === "string" ? item.name : hostname,
			pairedAt: typeof item.pairedAt === "string" ? item.pairedAt : "",
		});
	}
	return out;
}

export function isClientAllowed(runtime, ip, hostname) {
	const clients = normalizeClients(runtime.data.edge === undefined || runtime.data.edge === null ? [] : runtime.data.edge.clients);
	return clients.some((item) => item.ip === ip && item.hostname === hostname);
}

export function rememberClient(runtime, ip, hostname, name) {
	if (ip === "" || hostname === "") return false;
	if (runtime.data.edge === null || runtime.data.edge === undefined || typeof runtime.data.edge !== "object") {
		runtime.data.edge = { enabled: false, port: undefined };
	}
	const clients = normalizeClients(runtime.data.edge.clients);
	if (clients.some((item) => item.ip === ip && item.hostname === hostname)) {
		runtime.data.edge.clients = clients;
		return false;
	}
	clients.push({ ip, hostname, name: typeof name === "string" && name !== "" ? name : hostname, pairedAt: new Date().toISOString() });
	runtime.data.edge.clients = clients;
	try {
		persist(runtime);
	} catch (error) {
		// 内存里已经放行，只是重启后需要重新配对
	}
	return true;
}

/**
 * 轮换本机密钥：
 * - 生成新密钥并落盘；
 * - **清空白名单**（已配对的机器全部失效，必须用新密钥重新配对）；
 * - 清掉 edge 缓存的门卡。
 */
export function rotateDeviceKey(runtime) {
	const next = randomBytes(32).toString("base64url");
	runtime.data.deviceKey = next;
	if (runtime.data.edge === null || runtime.data.edge === undefined || typeof runtime.data.edge !== "object") {
		runtime.data.edge = { enabled: false, port: undefined };
	}
	runtime.data.edge.clients = [];
	if (runtime.edge !== null && runtime.edge !== undefined) runtime.edge.cookie = undefined;
	try {
		persist(runtime);
	} catch (error) {
		throw new Error(`保存新密钥失败：${messageOf(error)}`);
	}
	return next;
}

/** 由宿主注入的持久化函数（避免 auth ↔ data 循环 import）。 */
let persist = () => {};
export function configureAuth(deps) {
	if (deps !== null && deps !== undefined && typeof deps.persistDataFile === "function") persist = deps.persistDataFile;
}
