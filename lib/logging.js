import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export /** `$DSH_HOME` = `process.env.DSH_HOME` 或 `%USERPROFILE%\.dsh`。 */
function dshHome() {
	const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
	if (fromEnv !== "") return fromEnv;
	try {
		return join(homedir(), ".dsh");
	} catch {
		return ".dsh";
	}
}

/**
 * ===== 诊断日志（0.15.0） =====
 * 目标：出问题时能直接导出日志随问题反馈；日志**绝不包含** token / cookie / 密钥。
 * 文件：`$DSH_HOME/dsh-remote.log`（JSON Lines，每行一条）；2MB 轮转，保留 3 份。
 * 级别：error < warn < info < debug，默认 info；环境变量 `DSH_REMOTE_LOG_LEVEL` 可覆盖。
 */
export const LOG_FILE_NAME = "dsh-remote.log";
export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_KEEP = 3;
export const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function logLevelThreshold() {
	const raw = String(process.env.DSH_REMOTE_LOG_LEVEL ?? "info").trim().toLowerCase();
	return Object.hasOwn(LOG_LEVELS, raw) ? LOG_LEVELS[raw] : LOG_LEVELS.info;
}

/** 日志文件的绝对路径（`$DSH_HOME/dsh-remote.log`）。 */
export function resolveLogFile() {
	return join(dshHome(), LOG_FILE_NAME);
}

/** 脱敏：URL 里的 token 参数、Bearer/token 头、43 位 token 形态一律变 `***`。 */
export function redactSecret(value) {
	return String(value)
		.replace(/([?&](?:token|access_token|api_key|apikey|key|secret)=)[^&\s"']+/giu, "$1***")
		.replace(/\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/giu, "***")
		.replace(/\b[A-Za-z0-9_-]{43}\b/gu, "***");
}

/** 字段脱敏（递归；token/cookie/secret/password/authorization 整字段打码）。 */
export function redactFields(value, depth) {
	const level = depth === undefined ? 0 : depth;
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return redactSecret(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (level >= 4) return "…";
	if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactFields(entry, level + 1));
	if (typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).slice(0, 40)) {
			if (/token|cookie|secret|password|authorization/iu.test(key)) {
				out[key] = "***";
				continue;
			}
			out[key] = redactFields(value[key], level + 1);
		}
		return out;
	}
	return "…";
}

/** 超过 2MB 就轮转：.log → .log.1 → .log.2 …（最多保留 LOG_KEEP 份）。 */
export function rotateLogIfNeeded(file) {
	try {
		if (statSync(file).size < LOG_MAX_BYTES) return;
		for (let index = LOG_KEEP; index >= 1; index -= 1) {
			const from = index === 1 ? file : `${file}.${index - 1}`;
			const to = `${file}.${index}`;
			try {
				if (statSync(from).isFile()) renameSync(from, to);
			} catch {
				/* 不存在的文件跳过 */
			}
		}
	} catch {
		/* 文件还不存在：不用轮转 */
	}
}

/** 追加一条日志；任何失败都吞掉，绝不影响插件功能。 */
export function appendLog(level, tag, message, fields) {
	const rank = Object.hasOwn(LOG_LEVELS, level) ? LOG_LEVELS[level] : LOG_LEVELS.info;
	if (rank > logLevelThreshold()) return;
	try {
		const file = resolveLogFile();
		rotateLogIfNeeded(file);
		const record = {
			at: new Date().toISOString(),
			level: level,
			tag: String(tag),
			message: redactSecret(message === undefined || message === null ? "" : message),
		};
		if (fields !== undefined) record.fields = redactFields(fields);
		appendFileSync(file, JSON.stringify(record) + "\n");
	} catch {
		/* 日志失败不影响功能 */
	}
}


/** 读日志尾部（下载接口用；最多 512KB）。 */
export function readLogTail(maxBytes) {
	const limit = maxBytes === undefined ? 512 * 1024 : maxBytes;
	try {
		const text = readFileSync(resolveLogFile(), "utf8");
		if (text.length <= limit) return text;
		return text.slice(text.length - limit);
	} catch {
		return "";
	}
}