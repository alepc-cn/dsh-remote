/**
 * 设备解析与归一化 + 本机身份（纯逻辑：只读本机网卡/主机名，不碰网络与文件）。
 *
 * 从 lib/index.js 原样搬出（重构第 10 刀，行为一个字节都没改）。搬出的符号：
 *  - 设备解析与归一化：parseDeviceUrl / normalizeDeviceEntry / normalizeDevices
 *  - 本机身份：collectHostFacts / deviceMatchesLocal / resolveLocalDevice / localEntryName
 *  - 基础工具里与设备 / 主机相关的：IPV4_PATTERN / isIpv4 / normalizeHostToken / slugifyDeviceId
 *    （原先散在「基础工具」region，调用方几乎都在设备/本机身份这一侧；isIpv4 在 index 的
 *      本机地址枚举里还有一处复用，所以 index 反向 import 它。）
 *
 * 依赖：node:os（networkInterfaces / hostname）；warn / toPort 来自 ./util.js。
 * 还有一项由宿主半通过 configureDevices() **注入**（本文件**不 import ./index.js**，否则成环）：
 *  - DEVICE_ID_PATTERN：id 的安全性正则，同时被设置页校验、attach 的 DI 名单与自测共用，
 *    所以留在 index.js，搬过来的 normalizeDeviceEntry / slugifyDeviceId 通过注入使用它。
 */

import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from "node:os";

import { normalizeDeviceKey, toPort, warn } from "./util.js";

/**
 * 宿主半（./index.js）注入的依赖 —— 用依赖注入而不是 import ./index.js，
 * 避免 index ↔ 本文件 的 ESM 循环引用（也避免为了内部符号去扩大 index.js 的 export 面）。
 * 由 index.js 在模块求值末尾调用 configureDevices() 注入；本文件的函数只在**调用时**访问这些绑定。
 */
let DEVICE_ID_PATTERN;
export function configureDevices(deps) {
	({ DEVICE_ID_PATTERN } = deps);
}

//#region 设备解析与归一化

/**
 * 解析并校验一条设备的 url。
 * @returns 成功时 `{ url, protocol, hostname, port, authority, origin, basePath }`，失败时 `{ error }`。
 */
function parseDeviceUrl(rawUrl) {
	const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
	if (text === "") return { error: "url 不能为空" };
	let parsed;
	try {
		parsed = new URL(text);
	} catch (error) {
		return { error: `url 无法解析（${text}）` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { error: `url 只支持 http/https（${parsed.protocol}）` };
	}
	return {
		url: text,
		protocol: parsed.protocol,
		hostname: parsed.hostname,
		port: parsed.port,
		/** 改写到远端的 Host 头，也是 cookie 名派生的输入。 */
		authority: parsed.host,
		/** 改写到远端的 Origin 头。 */
		origin: parsed.origin,
		/** 若设备挂在某个子路径下（如 nginx 的 /dsh），保留；通常为空串。 */
		basePath: parsed.pathname.replace(/\/+$/u, ""),
	};
}

/**
 * 归一化一条设备（数据文件 / 配置种子都走这里）。
 * 坏条目告警后跳过，绝不因为一条坏数据拖垮整个插件。
 * @returns 归一化后的设备对象，或 undefined。
 */
function normalizeDeviceEntry(ctx, entry, seen) {
	if (entry === null || typeof entry !== "object") return undefined;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	const rawUrl = typeof entry.url === "string" ? entry.url.trim() : "";
	if (id === "" || rawUrl === "") {
		warn(ctx, `跳过设备条目：缺少 id 或 url（${JSON.stringify(entry)}）`);
		return undefined;
	}
	if (!DEVICE_ID_PATTERN.test(id)) {
		warn(ctx, `跳过设备 "${id}"：id 只允许 A-Za-z0-9._~-`);
		return undefined;
	}
	if (seen !== undefined && seen.has(id)) {
		warn(ctx, `跳过设备 "${id}"：id 重复`);
		return undefined;
	}
	const parsed = parseDeviceUrl(rawUrl);
	if (parsed.error !== undefined) {
		warn(ctx, `跳过设备 "${id}"：${parsed.error}`);
		return undefined;
	}
	if (seen !== undefined) seen.add(id);
	return {
		id,
		name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id,
		rawUrl,
		protocol: parsed.protocol,
		hostname: parsed.hostname,
		port: parsed.port,
		authority: parsed.authority,
		origin: parsed.origin,
		basePath: parsed.basePath,
		key: normalizeDeviceKey(entry.key),
		paired: entry.paired === true,
	};
}

/**
 * 归一化 `config.devices`（保留 device-switch 的同名导出，selftest 与"配置种子"都用它）。
 * @returns 归一化后的设备数组。
 */
function normalizeDevices(ctx, config) {
	const raw = config && Array.isArray(config.devices) ? config.devices : [];
	const devices = [];
	const seen = new Set();
	for (const entry of raw) {
		const device = normalizeDeviceEntry(ctx, entry, seen);
		if (device !== undefined) devices.push(device);
	}
	return devices;
}

//#endregion

//#region 本机身份（自验证；数据文件里的 current 只做兜底）

/**
 * 取"本机事实"。**可注入**：`apply(ctx, config, { hostFacts })`，默认就是本函数 ——
 * 自测可以传假值（真实网卡与主机名换台机器就变，不能用来做断言）。
 * @param ctx - 宿主 Cordis 上下文（含 webServer）。
 * @returns `{ port, host, hostname, ips }`。
 */
function collectHostFacts(ctx) {
	const webServer = ctx !== null && typeof ctx === "object" && ctx.webServer !== null && typeof ctx.webServer === "object"
		? ctx.webServer
		: {};
	let ips = [];
	try {
		for (const list of Object.values(osNetworkInterfaces() ?? {})) {
			for (const entry of Array.isArray(list) ? list : []) {
				if (entry === null || typeof entry !== "object") continue;
				if (entry.internal === true) continue;
				if (entry.family !== "IPv4" && entry.family !== 4) continue;
				const address = typeof entry.address === "string" ? entry.address.trim() : "";
				if (address === "" || ips.includes(address)) continue;
				ips.push(address);
			}
		}
	} catch {
		ips = [];
	}
	let hostname = "";
	try {
		hostname = osHostname();
	} catch {
		hostname = "";
	}
	return {
		port: toPort(webServer.port),
		host: typeof webServer.host === "string" ? webServer.host.trim() : "",
		hostname: typeof hostname === "string" ? hostname.trim() : "",
		ips,
	};
}

/**
 * 一台设备是不是"我这台机器"（URL 自验证）。
 *
 * **0.10.3 起以 hostname 为主**：host 命中本机地址（非回环 IPv4 ∪ `webServer.host` 当它是具体 IPv4）
 * 或等于 `os.hostname()`（大小写不敏感）就算 —— 不再要求端口相等（启用对外入口时设备表里写的是
 * **对外端口**，而 DSH 自己的端口是另一个，早先的"端口必须相等"会让本机自己都认不出来）。
 *
 * 唯一的例外：**回环地址**（`127.0.0.1` / `::1` / `localhost`）仍要看端口 ——
 * `127.0.0.1:<别的端口>` 很可能是本机**另一个服务**，不能凭 hostname 就认成本机。
 */
function deviceMatchesLocal(device, facts) {
	if (device === null || typeof device !== "object") return false;
	if (facts === null || typeof facts !== "object") return false;
	const wanted = normalizeHostToken(device.hostname);
	if (wanted === "") return false;

	const localHost = normalizeHostToken(facts.host);
	const addresses = new Set();
	for (const entry of Array.isArray(facts.ips) ? facts.ips : []) addresses.add(normalizeHostToken(entry));
	// webServer.host 也是本机事实：它是具体 IPv4 时算地址；`0.0.0.0` 是"所有网卡"的绑定写法，不是地址。
	if (isIpv4(localHost) && localHost !== "0.0.0.0") addresses.add(localHost);

	const names = new Set();
	const hostname = normalizeHostToken(facts.hostname);
	if (hostname !== "") names.add(hostname);
	if (localHost !== "" && !isIpv4(localHost)) names.add(localHost);

	const hit = addresses.has(wanted) || names.has(wanted);
	if (hit !== true) return false;
	if (wanted === "127.0.0.1" || wanted === "::1" || wanted === "localhost") {
		const ownPort = toPort(facts.port);
		if (ownPort === undefined) return false;
		const effectivePort = device.port === "" || device.port === undefined || device.port === null
			? (device.protocol === "https:" ? 443 : 80)
			: toPort(device.port);
		return effectivePort !== undefined && effectivePort === ownPort;
	}
	return true;
}

/**
 * 认领"本机"那一台：先用 URL 与本机事实自动匹配（**多条命中取第一条**），
 * 一条都没命中才回退 `current`（以及设备上的 `local: true`，只为兼容旧配置）。
 * @returns `{ device, via }`，`via` 是 `"auto" | "config" | "none"`。
 */
function resolveLocalDevice(devices, current, facts) {
	for (const device of Array.isArray(devices) ? devices : []) {
		if (deviceMatchesLocal(device, facts)) return { device, via: "auto" };
	}
	const id = typeof current === "string" ? current.trim() : "";
	for (const device of Array.isArray(devices) ? devices : []) {
		if (device.local === true || (id !== "" && device.id === id)) return { device, via: "config" };
	}
	return { device: undefined, via: "none" };
}

/**
 * 菜单里"本机"那一项的文案。
 * - 认领到具体设备：`<device.name>（本机 <hostname>）`；
 * - 没认领到任何设备：`本机（<hostname>）`。
 */
function localEntryName(device, facts) {
	const hostname = facts !== null && typeof facts === "object" && typeof facts.hostname === "string" ? facts.hostname.trim() : "";
	if (device === undefined || device === null) return hostname === "" ? "本机" : `本机（${hostname}）`;
	return hostname === "" ? `${device.name}（本机）` : `${device.name}（本机 ${hostname}）`;
}

//#endregion

//#region 基础工具（设备 / 主机相关）

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** 是不是一个合法的点分十进制 IPv4。 */
function isIpv4(value) {
	const match = IPV4_PATTERN.exec(String(value ?? "").trim());
	if (match === null) return false;
	return [match[1], match[2], match[3], match[4]].every((part) => Number(part) <= 255);
}

/** host 比较用的归一：小写、去 IPv6 方括号、去末尾的点（`My-PC.` 与 `my-pc` 等价）。 */
function normalizeHostToken(value) {
	return String(value ?? "").trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
}

/** 由设备名派生一个合法的设备 id（新增设备时 `id` 缺省）。 */
function slugifyDeviceId(value) {
	const slug = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._~-]+/gu, "-")
		.replace(/-{2,}/gu, "-")
		.replace(/^[-.]+/u, "")
		.replace(/[-.]+$/u, "")
		.slice(0, 48);
	return DEVICE_ID_PATTERN.test(slug) ? slug : "";
}

//#endregion

export {
	collectHostFacts, deviceMatchesLocal, isIpv4, localEntryName, normalizeDeviceEntry,
	normalizeDevices, parseDeviceUrl, resolveLocalDevice, slugifyDeviceId,
};
