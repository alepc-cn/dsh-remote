import { createHash } from "node:crypto";

export const AUTH_COOKIE_PREFIX = "dsh-auth-";

export function base64Url(buffer) {
	return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function cookieNameFor(authority) {
	return AUTH_COOKIE_PREFIX + base64Url(createHash("sha256").update(authority).digest());
}

export function readCookie(cookieHeader, wanted) {
	if (typeof cookieHeader !== "string" || cookieHeader === "") return undefined;
	for (const segment of cookieHeader.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1 || segment.slice(0, at).trim() !== wanted) continue;
		const value = segment.slice(at + 1).trim();
		return value === "" ? undefined : value;
	}
	return undefined;
}

export function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

export function unrefTimer(timer) {
	if (timer !== null && timer !== undefined && typeof timer.unref === "function") timer.unref();
	return timer;
}

export function warn(ctx, message) {
	try {
		const logger = ctx && ctx.logger;
		if (logger && typeof logger.warn === "function") logger.warn(`[dsh-remote] ${message}`);
		else console.warn(`[dsh-remote] ${message}`);
	} catch {
		/* 日志失败绝不能影响请求处理 */
	}
}

export function info(ctx, message) {
	try {
		const logger = ctx && ctx.logger;
		if (logger && typeof logger.info === "function") logger.info(`[dsh-remote] ${message}`);
		else console.log(`[dsh-remote] ${message}`);
	} catch {
		/* 日志失败绝不能影响装配 */
	}
}

export function plainValue(value) {
	return String(value).replaceAll("<", "\uFF1C").replaceAll(">", "\uFF1E");
}

export function toPort(value) {
	const port = typeof value === "number" ? value : Number(String(value ?? "").trim());
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

export function deviceIdOf(device) {
	if (device !== null && typeof device === "object") return typeof device.id === "string" ? device.id : "";
	return typeof device === "string" ? device : "";
}

export function authorityOf(device) {
	return device !== null && typeof device === "object" && typeof device.authority === "string" ? device.authority : "";
}


/**
 * 0.27.0：配对密钥（长期有效、由本插件自己生成，替代每次 DSH 重启都轮换的 token）。
 * 32 字节 base64url = 43 个字符。
 */
export function normalizeDeviceKey(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return /^[A-Za-z0-9_-]{43}$/u.test(trimmed) ? trimmed : undefined;
}
