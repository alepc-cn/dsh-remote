/**
 * 新能力：「另存为…」（本机 / 跨设备下载）与「分叉到…」（本机源会话 → 目标机会话）的
 * 实现与 Remote RPC 辅助（postRemoteRpc / 多段响应解析 / 下载窗口流式读）。
 *
 * 从 lib/index.js 原样搬出（重构第 6 刀，行为一个字节都没改；原 region
 * 「新能力：文件『另存为…』与会话『分叉到…』」整体搬迁）。
 *
 * 依赖：node:http / node:https；warn / info / messageOf / plainValue / unrefTimer 来自 ./util.js；
 * writeText / writeJson 来自 ./proxy.js；常量、会话/cookie 辅助、workspaceFiles 服务名等由宿主半
 * （./index.js）通过 configureAttach() 注入，**不 import ./index.js** —— 避免循环引用。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { info, messageOf, plainValue, unrefTimer, warn } from "./util.js";

import { peerHeaders, markPaired, unmarkPaired } from "./auth.js";
import { writeJson, writeText } from "./proxy.js";

/**
 * 宿主半（./index.js）注入的依赖 —— 用依赖注入而不是 import ./index.js，
 * 避免 index ↔ 本文件 的 ESM 循环引用（也避免为了内部符号去扩大 index.js 的 export 面）。
 * 由 index.js 在模块求值末尾调用 configureAttach() 注入；本文件的函数只在**调用时**访问这些绑定。
 */
// 能力常量：DEVICE_ID_PATTERN / DOWNLOAD_CHUNK_BYTES / FORK_MAX_SEED_BYTES / FORK_MAX_TAIL / FORK_UNTITLED_TITLE / MAX_DOWNLOAD_WINDOWS / MAX_PATH_CHARS / MAX_SESSION_ID_CHARS / MAX_SOURCE_TITLE_CHARS / MULTIPART_OVERHEAD_BYTES / REMOTE_RPC_CHANNEL / REMOTE_RPC_MAX_BYTES / REMOTE_RPC_TIMEOUT_MS / TYPERT_SERVICE / USER_AGENT / WORKSPACE_FILES_SERVICE / WORKSPACE_FILE_SCOPE_LOOKUP / SESSION_CREATE_ENDPOINT / SESSION_PAGE_ENDPOINT / SESSION_PROJECTIONS_ENDPOINT / SESSION_PROMPT_ENDPOINT / SESSION_RENAME_ENDPOINT / WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT / WORKSPACE_FILES_STAT_ENDPOINT / WORKSPACE_FILES_READ_BYTES_ENDPOINT
// 会话 / cookie / 本机服务：authorizeTrustedRequest / cookieHeaderFor / ensureSession / isHtmlContentType / markReach / mintLocalSessionCookie / readAccess / readJsonBody / serviceOf
// 分叉条数（数据文件）：effectiveForkTail / normalizeForkTail
let DEVICE_ID_PATTERN, DOWNLOAD_CHUNK_BYTES, FORK_MAX_SEED_BYTES, FORK_MAX_TAIL,
	FORK_UNTITLED_TITLE, MAX_DOWNLOAD_WINDOWS, MAX_PATH_CHARS, MAX_SESSION_ID_CHARS,
	MAX_SOURCE_TITLE_CHARS, MULTIPART_OVERHEAD_BYTES, REMOTE_RPC_CHANNEL, REMOTE_RPC_MAX_BYTES,
	REMOTE_RPC_TIMEOUT_MS, TYPERT_SERVICE, USER_AGENT, WORKSPACE_FILES_SERVICE,
	WORKSPACE_FILE_SCOPE_LOOKUP, SESSION_CREATE_ENDPOINT, SESSION_PAGE_ENDPOINT, SESSION_PROJECTIONS_ENDPOINT,
	SESSION_PROMPT_ENDPOINT, SESSION_RENAME_ENDPOINT, WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT, WORKSPACE_FILES_STAT_ENDPOINT,
	WORKSPACE_FILES_READ_BYTES_ENDPOINT, authorizeTrustedRequest,
	isHtmlContentType, markReach, mintLocalSessionCookie, readAccess,
	readJsonBody, serviceOf, effectiveForkTail, normalizeForkTail;
export function configureAttach(deps) {
	({
		DEVICE_ID_PATTERN, DOWNLOAD_CHUNK_BYTES, FORK_MAX_SEED_BYTES, FORK_MAX_TAIL,
		FORK_UNTITLED_TITLE, MAX_DOWNLOAD_WINDOWS, MAX_PATH_CHARS, MAX_SESSION_ID_CHARS,
		MAX_SOURCE_TITLE_CHARS, MULTIPART_OVERHEAD_BYTES, REMOTE_RPC_CHANNEL, REMOTE_RPC_MAX_BYTES,
		REMOTE_RPC_TIMEOUT_MS, TYPERT_SERVICE, USER_AGENT, WORKSPACE_FILES_SERVICE,
		WORKSPACE_FILE_SCOPE_LOOKUP, SESSION_CREATE_ENDPOINT, SESSION_PAGE_ENDPOINT, SESSION_PROJECTIONS_ENDPOINT,
		SESSION_PROMPT_ENDPOINT, SESSION_RENAME_ENDPOINT, WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT, WORKSPACE_FILES_STAT_ENDPOINT,
		WORKSPACE_FILES_READ_BYTES_ENDPOINT, authorizeTrustedRequest,
		isHtmlContentType, markReach, mintLocalSessionCookie, readAccess,
		readJsonBody, serviceOf, effectiveForkTail, normalizeForkTail
	} = deps);
}

//#region 新能力：文件「另存为…」与会话「分叉到…」
//
// 两条能力都建在**官方 workspaceFiles**上（见 REMOTE_RPC_CHANNEL 的注释与 README 的"冻结契约"）：
//  - 另存为：`stat` 拿大小与类型 → `readBytes` 按窗口读字节 → 流式回本机。
//    **device 为空**时不打任何网络：直接进程内调本机的 `workspaceFiles` 服务（同一个服务、
//    同一套按 session 授权的闸门）；**device 有值**才走目标机的 Remote RPC。
//  - 分叉：本机读源会话尾页（进程内 ctx.sessionController 优先，退回本机 HTTP）→ 目标机
//    `session/create`（不传工作区、不传模型）→ `session/prompt`（mode: "queue"）把种子发过去。
// 两条都：受 `enabled` 门控、错误一律中文、绝不 text/html（I1）。
// 鉴权：另存为走官方"可信请求"判定（browser 可用），其余（含分叉）仅回环。

/** 记一次"新能力"的运行结果（体检页要报最近一次失败原因）。 */
function noteOp(runtime, op, ok, detail) {
	const entry = runtime.ops[op];
	if (entry === undefined) return;
	entry.attempts += 1;
	if (ok === true) {
		entry.lastOkAt = new Date().toISOString();
		entry.lastError = null;
		entry.lastErrorAt = null;
		return;
	}
	entry.lastError = detail === undefined || detail === null || detail === "" ? "（无详情）" : String(detail);
	entry.lastErrorAt = new Date().toISOString();
}

/** 体检里那一句话：某项能力是否可用 + 最近一次失败原因。 */
function opNote(runtime, op, label) {
	const entry = runtime.ops[op];
	const enabled = runtime.data.enabled === true;
	if (entry === undefined) return `${label}：状态未知。`;
	if (entry.lastError === null) {
		return enabled
			? `${label}可用（enabled=true）。${entry.attempts === 0 ? "还没有用过。" : `已用过 ${String(entry.attempts)} 次，最近一次成功：${String(entry.lastOkAt)}。`}`
			: `${label}当前不可用（enabled=false，软开关与 /dev/** 一致）；设置页/体检仍可读。`;
	}
	return `${label}最近一次失败（${String(entry.lastErrorAt)}）：${entry.lastError}`;
}

/** 一个单调递增的 rpcId（Connection 只要求它是字符串，用来对齐请求与响应）。 */
function nextRpcId(runtime) {
	runtime.rpcSeq += 1;
	return `dsh-remote-${String(runtime.rpcSeq)}`;
}

/** content-type 的"本质类型"（去参数、小写）。 */
function essentialType(value) {
	return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** 取路径的 basename（同时认 `/` 与 `\`：目标机可能是 Windows）。 */
function basenameOf(filePath) {
	const raw = String(filePath ?? "").replace(/[\\/]+$/u, "");
	const at = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
	const base = at === -1 ? raw : raw.slice(at + 1);
	return base === "" ? "download.bin" : base;
}

/**
 * RFC 5987 的 `ext-value` 编码：`attr-char` 之外的字节一律 `%XX`。
 * `encodeURIComponent` 会漏掉 `!'()*`，那几个必须自己补上。
 */
function encodeRfc5987(value) {
	return encodeURIComponent(String(value)).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `Content-Disposition: attachment`：ASCII 回退名 + RFC 5987 的 `filename*`（中文名走后者）。
 * 回退名把非 ASCII 与引号/反斜杠换成 `_`，保证老客户端也能存出一个合法文件名。
 */
function contentDispositionFor(filePath) {
	const base = basenameOf(filePath);
	const fallback = base.replace(/[^\u0020-\u007e]/gu, "_").replace(/["\\]/gu, "_");
	return `attachment; filename="${fallback === "" ? "download.bin" : fallback}"; filename*=UTF-8''${encodeRfc5987(base)}`;
}

/**
 * 向一台设备发一次**一元 Remote RPC**，拿到原始响应（不解析）。
 * 复用代理那一套：token 兑换（ensureSession）→ 宿主侧 cookie jar → Host/Origin 改写。
 * @param options - `{ cookie?, skipSession?, maxBytes?, timeoutMs? }`（本机 HTTP 回退用 cookie 直给）。
 * @returns `{ ok, status, headers, body, truncated, error }`；`ok:false` = 连响应都没拿到。
 */
async function postRemoteRpc(runtime, device, endpoint, args, options) {
	const settings = options !== null && typeof options === "object" ? options : {};
	const maxBytes = Number.isSafeInteger(settings.maxBytes) && settings.maxBytes > 0 ? settings.maxBytes : REMOTE_RPC_MAX_BYTES;
	const timeoutMs = Number.isSafeInteger(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : REMOTE_RPC_TIMEOUT_MS;
	// 0.28.0：跨机请求只带身份头；显式 cookie 只用于本机回退那条路。
	const cookie = typeof settings.cookie === "string" && settings.cookie !== "" ? settings.cookie : undefined;
	const envelope = {
		type: "client-request",
		rpcId: nextRpcId(runtime),
		method: endpoint,
		payload: { args },
	};
	const payload = Buffer.from(JSON.stringify(envelope), "utf8");
	let target;
	try {
		target = new URL(`${device.origin}${device.basePath}${REMOTE_RPC_CHANNEL}/${endpoint}`);
	} catch (error) {
		return { ok: false, status: 0, headers: {}, body: Buffer.alloc(0), truncated: false, error: `无法构成目标地址：${messageOf(error)}` };
	}
	return new Promise((resolve) => {
		let settled = false;
		let upstream = null;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				if (upstream !== null) upstream.destroy(new Error("客户端超时"));
			} catch {
				/* 已经结束 */
			}
			finish({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), truncated: false, error: `目标机 "${device.id}" 响应超时（${String(timeoutMs)} ms）` });
		}, timeoutMs);
		unrefTimer(timer);
		const headers = {
			host: device.authority,
			origin: device.origin,
			"user-agent": USER_AGENT,
			accept: "application/json, multipart/form-data",
			"content-type": "application/json",
			"content-length": String(payload.length),
			"cache-control": "no-store",
		};
		if (cookie !== undefined) headers.cookie = cookie;
		else Object.assign(headers, peerHeaders(runtime, device));
		const send = device.protocol === "https:" ? httpsRequest : httpRequest;
		try {
			upstream = send({
				protocol: target.protocol,
				hostname: device.hostname,
				port: device.port === "" ? undefined : device.port,
				path: `${target.pathname}${target.search}`,
				method: "POST",
				headers,
			}, (response) => {
				const chunks = [];
				let size = 0;
				let truncated = false;
				response.on("data", (chunk) => {
					if (truncated) return;
					size += chunk.length;
					if (size > maxBytes) {
						truncated = true;
						chunks.length = 0;
						response.destroy();
						finish({ ok: true, status: response.statusCode ?? 0, headers: response.headers, body: Buffer.alloc(0), truncated: true, error: null });
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					finish({ ok: true, status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), truncated: false, error: null });
				});
				response.on("error", (error) => finish({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), truncated: false, error: messageOf(error) }));
			});
		} catch (error) {
			finish({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), truncated: false, error: `建立上游请求失败：${messageOf(error)}` });
			return;
		}
		upstream.on("error", (error) => finish({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), truncated: false, error: messageOf(error) }));
		upstream.end(payload);
	});
}

/**
 * 解析一个已经 JSON 解析过的 RPC 响应信封 → `{ ok:true, value }` 或 `{ ok:false, code, message }`。
 * 信封形状由 Connection 的 `fullResponse` 决定：`{ type:"server-response", rpcId, result }`。
 */
function parseRpcResult(parsed) {
	const result = parsed !== null && typeof parsed === "object" ? parsed.result : undefined;
	if (result === null || typeof result !== "object") return { ok: false, code: "bad-envelope", message: "响应里没有 result 字段" };
	if (result.ok === true) return { ok: true, value: result.value };
	const error = result.error !== null && typeof result.error === "object" ? result.error : {};
	return {
		ok: false,
		code: typeof error.code === "string" ? error.code : "unknown",
		message: typeof error.message === "string" ? error.message : "",
		details: error.details,
	};
}

/**
 * 解析一个纯 JSON 的 RPC 响应（没有二进制附件的那种）。
 * @returns `{ ok:true, value }` 或 `{ ok:false, code, message }`（code 里 `http-<状态码>` / `html` / `bad-json` 是本层加的）。
 */
function parseRpcText(response, label) {
	const type = essentialType(response.headers["content-type"]);
	if (response.truncated === true) return { ok: false, code: "too-large", message: `${label}：目标机响应过大（超过 ${String(REMOTE_RPC_MAX_BYTES)} 字节）` };
	if (isHtmlContentType(type)) return { ok: false, code: "html", message: `${label}：目标机返回了 HTML（I1：本插件不透传 HTML）` };
	if (response.status < 200 || response.status >= 300) {
		const text = response.body.toString("utf8").trim().slice(0, 200);
		return { ok: false, code: `http-${String(response.status)}`, message: `${label}：目标机返回 HTTP ${String(response.status)}${text === "" ? "" : `（${text}）`}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(response.body.toString("utf8"));
	} catch {
		return { ok: false, code: "bad-json", message: `${label}：目标机返回的不是 JSON（content-type: ${type === "" ? "缺失" : type}）` };
	}
	return parseRpcResult(parsed);
}

/** 从 `content-type` 里取 multipart 的 boundary（没有就返回 null）。 */
function multipartBoundary(contentType) {
	const match = /boundary="?([^";]+)"?/iu.exec(String(contentType ?? ""));
	if (match === null) return null;
	const value = match[1].trim();
	return value === "" ? null : value;
}

/**
 * 极小的 `multipart/form-data` 解析器（零依赖）。
 * 每个响应只装着一小段：`metadata`（JSON 信封）+ 一个 `bytes-<n>`（窗口字节），所以整段缓冲是可接受的；
 * **整份文件**绝不会进内存（下载是一窗口一次请求）。
 * @returns `{ parts }`（`name → Buffer`）或 `{ error }`。
 */
function parseMultipart(body, boundary) {
	const delimiter = Buffer.from(`--${boundary}`);
	const parts = new Map();
	let at = body.indexOf(delimiter);
	if (at === -1) return { error: "响应体里找不到 multipart 边界" };
	while (at !== -1) {
		let cursor = at + delimiter.length;
		if (body.slice(cursor, cursor + 2).toString("latin1") === "--") break; // 结束段
		if (body.slice(cursor, cursor + 2).toString("latin1") === "\r\n") cursor += 2;
		const headerEnd = body.indexOf("\r\n\r\n", cursor);
		if (headerEnd === -1) return { error: "multipart 分段缺少头部结束标记" };
		const headerText = body.slice(cursor, headerEnd).toString("latin1");
		const next = body.indexOf(delimiter, headerEnd + 4);
		// 段数据与下一个边界之间的 CRLF 不属于数据。
		const dataEnd = next === -1 ? body.length : Math.max(headerEnd + 4, next - 2);
		const nameMatch = /name="([^"]*)"/iu.exec(headerText);
		if (nameMatch !== null) parts.set(nameMatch[1], body.slice(headerEnd + 4, dataEnd));
		at = next;
	}
	if (parts.size === 0) return { error: "multipart 里没有任何分段" };
	return { parts };
}

/**
 * 解析 `workspaceFiles/readBytes` 的响应：multipart（`metadata` + `bytes-<n>`）或纯 JSON。
 * @returns `{ ok:true, frame, bytes }` 或 `{ ok:false, code, message }`。
 */
function parseReadBytesResponse(response, label) {
	const type = essentialType(response.headers["content-type"]);
	if (response.ok !== true) return { ok: false, code: "unreachable", message: `${label}：${response.error}` };
	if (isHtmlContentType(type)) return { ok: false, code: "html", message: `${label}：目标机返回了 HTML（I1：本插件不透传 HTML）` };
	if (response.status < 200 || response.status >= 300) {
		// 失败也可能是 multipart / JSON：尽量把目标机的错误原因翻出来。
		const detail = parseRpcText(response, label);
		return { ok: false, code: detail.code, message: detail.message };
	}
	if (type !== "multipart/form-data") {
		const parsedText = parseRpcText(response, label);
		if (parsedText.ok !== true) return parsedText;
		return { ok: true, frame: parsedText.value, bytes: Buffer.alloc(0) };
	}
	const boundary = multipartBoundary(response.headers["content-type"]);
	if (boundary === null) return { ok: false, code: "bad-multipart", message: `${label}：multipart 响应缺少 boundary` };
	const parsed = parseMultipart(response.body, boundary);
	if (parsed.error !== undefined) return { ok: false, code: "bad-multipart", message: `${label}：${parsed.error}` };
	const metaBuffer = parsed.parts.get("metadata");
	if (metaBuffer === undefined) return { ok: false, code: "bad-multipart", message: `${label}：multipart 里没有 metadata 段` };
	let envelope;
	try {
		envelope = JSON.parse(metaBuffer.toString("utf8"));
	} catch (error) {
		return { ok: false, code: "bad-json", message: `${label}：metadata 不是合法 JSON（${messageOf(error)}）` };
	}
	const result = parseRpcResult(envelope);
	if (result.ok !== true) return result;
	const table = Array.isArray(envelope.attachments) ? envelope.attachments : [];
	let bytes = Buffer.alloc(0);
	for (const entry of table) {
		if (entry === null || typeof entry !== "object") continue;
		const bucket = parsed.parts.get(String(entry.part));
		if (bucket === undefined) continue;
		// readBytes 的附件挂在 value.data 上（gateway 的 codec 写的是 path:["data"]）。
		if (Array.isArray(entry.path) && entry.path.length === 1 && entry.path[0] === "data") {
			bytes = bucket;
			break;
		}
		if (bytes.length === 0) bytes = bucket;
	}
	return { ok: true, frame: result.value, bytes };
}

/** Remote 错误码 → 中文说明（未知码原样带上；消息里的尖括号会转全角，保证响应体没有裸 `<`）。 */
function remoteErrorText(label, code, message) {
	const known = {
		"workspace-file/not-found": "目标机上找不到这个文件",
		"workspace-file/not-regular-file": "目标机上这个路径不是普通文件（目录 / 符号链接 / 其它类型）",
		"workspace-file/outside-workspace": "路径越过了目标机的工作区（目录列举限定在工作区内）",
		"workspace-file/too-large": "文件（或这一窗口）超过了目标机的读取上限",
		"workspace-file/not-text": "目标机认为这不是文本文件（按字节读取不受影响）",
		"gateway/lookup-not-found": "目标机上找不到这个 session（这个文件地址属于另一台机器/另一条会话）",
		"gateway/arguments-invalid": "参数形状不被目标机接受",
		"gateway/bad-request": "目标机认为参数不合法",
		"gateway/definition-unavailable": "目标机上这个 Remote 定义已被撤回",
		"gateway/input-invalid": "参数没通过目标机的校验",
		"session/not-found": "目标机上找不到这条会话",
		"session/projections-unavailable": "目标机读不到会话投影（asOfSeq）",
		"gateway/internal": "目标机内部错误",
		"http-401": "目标机拒绝了这次调用（HTTP 401）：token 可能已失效或没配 —— 请在设置页给这台设备补/换 token",
		"http-403": "目标机拒绝了这次调用（HTTP 403）：Host/Origin 不在那台机器的 trustedHosts 里，或 token 不属于它",
		"http-404": "目标机没有这个 Remote endpoint（HTTP 404）：那台机器的 DSH 版本可能没有这个接口",
		"http-415": "目标机拒绝了请求体类型（HTTP 415）",
		unreachable: "目标机不可达",
	};
	const base = known[code] !== undefined ? known[code] : `目标机返回错误 ${String(code)}`;
	const detail = typeof message === "string" && message !== "" ? `（${plainValue(message)}）` : "";
	return `${label}：${base}${detail}`;
}

/** Remote 错误码 → 回给本机客户端的 HTTP 状态码（尽量与目标机的语义对齐）。 */
function statusForRpcCode(code) {
	if (code === "workspace-file/not-found" || code === "gateway/lookup-not-found" || code === "http-404" || code === "session/not-found") return 404;
	if (code === "http-401") return 401;
	if (code === "http-403") return 403;
	if (code === "workspace-file/not-regular-file" || code === "workspace-file/too-large" || code === "workspace-file/outside-workspace"
		|| code === "gateway/bad-request" || code === "gateway/arguments-invalid" || code === "gateway/input-invalid" || code === "http-415") return 400;
	return 502;
}

/** 目标机不可达/超时时的统一文案（区分"连不上"与"业务失败"）。 */
function unreachableText(label, device, response) {
	return `${label}：${plainValue(device.name)} (${plainValue(device.id)}) 不可达 —— ${plainValue(response.error ?? "未知原因")}`;
}

/** 记一次 RPC 的可达性（体检页的 reachable/lastError 也吃这条数据）。 */
function markRpcReach(runtime, device, response) {
	if (response.ok !== true) {
		markReach(runtime, device.id, false, response.error ?? "请求失败");
		return;
	}
	const ok = response.status < 500;
	markReach(runtime, device.id, ok, ok ? null : `HTTP ${String(response.status)}`);
}

/** 本机 HTTP API 的基地址（只走回环；拿不到端口就没有回退路线）。 */
function localBaseUrl(runtime) {
	const access = readAccess(runtime);
	if (access.port === null || access.port === undefined) return undefined;
	return `http://127.0.0.1:${String(access.port)}`;
}

/** 造一个"伪设备"指向本机 DSH（只为复用 postRemoteRpc 的请求拼装，不进设备表）。 */
function localPseudoDevice(base) {
	const parsed = new URL(base);
	return {
		id: "__local__",
		name: "本机",
		rawUrl: base,
		protocol: parsed.protocol,
		hostname: parsed.hostname,
		port: parsed.port,
		authority: parsed.host,
		origin: parsed.origin,
		basePath: "",
	};
}

/**
 * 读**本机**某条会话的尾页记录。
 * 优先用进程内的 `ctx.sessionController`（`projections` 拿 asOfSeq，`page` 拿尾页）；
 * 拿不到就退回本机 HTTP 的同一对 Remote endpoint（`POST /api/session/...`，cookie 用进程 token 兑换）。
 * @returns `{ ok:true, records, asOfSeq, via }` 或 `{ ok:false, error }`。
 */
async function readLocalSessionTail(runtime, sessionId, tailN) {
	const controller = runtime.sessionController;
	const usable = controller !== null && controller !== undefined
		&& typeof controller.projections === "function" && typeof controller.page === "function";
	let inProcessError = "";
	if (usable) {
		try {
			// 进程内调用同样要传 AbortSignal：`@Remote` 包装会直接解引用它，缺了就抛
			// "Cannot read properties of undefined (reading 'throwIfAborted')"。
			const signal = new AbortController().signal;
			const projections = await controller.projections({ sessionId }, signal);
			if (projections === null || projections === undefined) return { ok: false, error: `本机没有这条会话（${plainValue(sessionId)}）` };
			const asOfSeq = Number(projections.asOfSeq);
			if (!Number.isSafeInteger(asOfSeq)) return { ok: false, error: `本机会话投影没有给出可用的 asOfSeq（${JSON.stringify(projections.asOfSeq)}）` };
			const page = await controller.page({
				address: { kind: "session", sessionId },
				throughSeq: asOfSeq,
				maxMessages: tailN,
			}, signal);
			const records = page !== null && typeof page === "object" && Array.isArray(page.records) ? page.records : [];
			return { ok: true, records, asOfSeq, via: "ctx.sessionController" };
		} catch (error) {
			// 进程内失败**不致命**：记下来，继续走下面的本机 HTTP 回退。
			// （早先这里直接 return ok:false，真机上首跑必失败 —— 2026-10-13 实测发现。）
			inProcessError = `读本机会话失败（ctx.sessionController）：${messageOf(error)}`;
			warn(runtime.ctx, inProcessError);
		}
	}
	// ---- 回退：本机 HTTP（同一个 /api 通道；cookie 由进程 token 兑换一次）----
	// 进程内那条路失败的原文也带上，排错时两条都看得到。
	const both = inProcessError === "" ? "" : inProcessError + "；";
	const base = localBaseUrl(runtime);
	if (base === undefined) return { ok: false, error: `${both}读本机会话失败：ctx.sessionController 不可用，而且拿不到本机 webserver 端口，无法退回 HTTP 路线` };
	const cookie = await mintLocalSessionCookie(runtime, base);
	const pseudo = localPseudoDevice(base);
	const projectionsLabel = `读本机会话失败（本机 HTTP ${SESSION_PROJECTIONS_ENDPOINT}）`;
	const pageLabel = `读本机会话失败（本机 HTTP ${SESSION_PAGE_ENDPOINT}）`;
	// 注意：`session/projections` 与 `session/page` 在**线路上**都只有一个 wire 字段 `request`
	// （见 session-controller 的 descriptor：参数名 request、wire 名 request），所以 args 必须是
	// `{ request: {…} }`；进程内调用则直接传那个 request 对象本身。
	const projectionsResponse = await postRemoteRpc(runtime, pseudo, SESSION_PROJECTIONS_ENDPOINT, { request: { sessionId } }, { cookie, skipSession: true });
	if (projectionsResponse.ok !== true) return { ok: false, error: `${both}${projectionsLabel}：${projectionsResponse.error}` };
	const projections = parseRpcText(projectionsResponse, projectionsLabel);
	if (projections.ok !== true) return { ok: false, error: both + remoteErrorText(projectionsLabel, projections.code, projections.message) };
	if (projections.value === null || projections.value === undefined) return { ok: false, error: `本机没有这条会话（${plainValue(sessionId)}）` };
	const asOfSeq = Number(projections.value.asOfSeq);
	if (!Number.isSafeInteger(asOfSeq)) return { ok: false, error: `本机会话投影没有给出可用的 asOfSeq（${JSON.stringify(projections.value.asOfSeq)}）` };
	const pageResponse = await postRemoteRpc(runtime, pseudo, SESSION_PAGE_ENDPOINT, {
		request: {
			address: { kind: "session", sessionId },
			throughSeq: asOfSeq,
			maxMessages: tailN,
		},
	}, { cookie, skipSession: true });
	if (pageResponse.ok !== true) return { ok: false, error: `${both}${pageLabel}：${pageResponse.error}` };
	const page = parseRpcText(pageResponse, pageLabel);
	if (page.ok !== true) return { ok: false, error: both + remoteErrorText(pageLabel, page.code, page.message) };
	const records = page.value !== null && typeof page.value === "object" && Array.isArray(page.value.records) ? page.value.records : [];
	return { ok: true, records, asOfSeq, via: "本机 HTTP /api" };
}

/** 一个 content 块 → 一行摘要（工具调用/图片只留一行，不逐字带过去）。 */
function blockSummary(block) {
	if (block === null || typeof block !== "object") return "";
	const type = typeof block.type === "string" ? block.type : "";
	if (type === "text") return typeof block.text === "string" ? block.text : "";
	if (type === "image") return "[图片]";
	if (type === "file") return "[文件]";
	if (type === "tool-call" || type === "tool_use" || type === "tool-use" || type === "tool/result") {
		const name = typeof block.name === "string" && block.name !== "" ? block.name : (typeof block.toolName === "string" ? block.toolName : "");
		return name === "" ? "[工具调用]" : `[工具调用：${name}]`;
	}
	return type === "" ? "" : `[${type}]`;
}

/** 把 content 块数组拼成一段文本。 */
function contentText(blocks) {
	if (!Array.isArray(blocks)) return "";
	const lines = [];
	for (const block of blocks) {
		const line = blockSummary(block).trim();
		if (line !== "") lines.push(line);
	}
	return lines.join("\n");
}

/**
 * 一条历史记录 → `{ role, text }`（只认 `user/message` / `assistant/message`）。
 * 事件形状来自 session-controller 的宿主实现：`user/message` 用 `data.content`，
 * `assistant/message` 用 `data.message.content`（两者的块都是 `{type, text}` 之类）。
 */
function messageOfRecord(record) {
	if (record === null || typeof record !== "object") return null;
	const event = record.event !== null && typeof record.event === "object" ? record.event : record;
	const type = typeof event.type === "string" ? event.type : "";
	const data = event.data !== null && typeof event.data === "object" ? event.data : {};
	if (type === "user/message") {
		const text = contentText(data.content);
		return text === "" ? null : { role: "用户", text };
	}
	if (type === "assistant/message") {
		const message = data.message !== null && typeof data.message === "object" ? data.message : {};
		let text = contentText(message.content);
		if (text === "") text = contentText(data.content);
		return text === "" ? null : { role: "助手", text };
	}
	return null;
}

/** 把尾页记录拼成种子文本（`role: text`）；超上限就从**最新**那头保留并写明截断。 */
function buildSeedContext(records) {
	const lines = [];
	for (const record of records) {
		const message = messageOfRecord(record);
		if (message === null) continue;
		lines.push(`${message.role}: ${message.text}`);
	}
	let text = lines.join("\n\n");
	let truncated = false;
	while (Buffer.byteLength(text, "utf8") > FORK_MAX_SEED_BYTES && lines.length > 1) {
		lines.shift();
		truncated = true;
		text = lines.join("\n\n");
	}
	if (Buffer.byteLength(text, "utf8") > FORK_MAX_SEED_BYTES) {
		// 单条消息本身就超限：只能按字节硬切（从尾部保留）。
		const buffer = Buffer.from(text, "utf8").subarray(-FORK_MAX_SEED_BYTES);
		text = buffer.toString("utf8").replace(/^\uFFFD/u, "");
		truncated = true;
	}
	if (truncated) text = "（更早的内容因为长度上限被截断）\n\n" + text;
	return { text, messages: lines.length, truncated };
}

/** 分叉时发给目标机的第一段话（口径见 README，别改措辞）。 */
function forkSeedPrompt(contextText) {
	// 结尾那句是用户明确要求的口径：**只了解信息，不要开始干活** —— 少了它，目标机上的
	// agent 会把整段上下文当成任务，思考几分钟再给一大篇回复（2026-10-13 用户实测反馈）。
	return [
		"[来自另一台设备的会话分叉]",
		"以下是我在另一台机器上的会话上下文（仅文字，不含文件）。",
		"",
		contextText,
		"",
		"---",
		"以上只是背景信息：请只了解即可，**不用回复、不要执行任何动作、不要开始工作**。",
	].join("\n");
}

/**
 * 「分叉到…」标题里那个**本机名字**（用户口径：`<源会话标题> - 来自<本机设备名>`）。
 * 依次退：被认领的本机设备 `name` → 它的 `id` → `os.hostname()` → `"本机"`；**绝不返回空串**。
 * （本机认领逻辑见 `resolveLocalDevice` / `deviceMatchesLocal`；没认领到设备是正常情况。）
 */
export function localForkDeviceName(runtime) {
	const device = runtime !== null && typeof runtime === "object" ? runtime.localDevice : undefined;
	if (device !== undefined && device !== null) {
		if (typeof device.name === "string" && device.name.trim() !== "") return device.name.trim();
		if (typeof device.id === "string" && device.id.trim() !== "") return device.id.trim();
	}
	const facts = runtime !== null && typeof runtime === "object" ? runtime.facts : undefined;
	const hostname = facts !== null && typeof facts === "object" && typeof facts.hostname === "string" ? facts.hostname.trim() : "";
	return hostname === "" ? "本机" : hostname;
}

/**
 * 洗一遍客户端半给的 `sourceTitle`：控制字符（含 NUL）换空格、去首尾空白、限长。
 * 拿不到 / 不是字符串 / 洗完是空 → `""`（由 `forkSessionTitle` 兜底成「未命名会话」）。
 */
export function cleanSourceTitle(value) {
	if (typeof value !== "string") return "";
	// 标题最终会进目标机的事件流与侧栏，控制字符在这里就剔干净。
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
	return Array.from(cleaned).slice(0, MAX_SOURCE_TITLE_CHARS).join("").trim();
}

/**
 * 目标机上给新会话起的标题：**`<源标题> - 来自<本机名>`**（用户原话："要用当前的会话名称-来自某设备"）。
 * 源标题为空 → 用「未命名会话」；本机名拿不到 → 用「本机」。两边都不会出现空串或 `undefined`。
 */
export function forkSessionTitle(sourceTitle, localName) {
	const cleaned = cleanSourceTitle(sourceTitle);
	const base = cleaned === "" ? FORK_UNTITLED_TITLE : cleaned;
	const name = typeof localName === "string" && localName.trim() !== "" ? localName.trim() : "本机";
	return `${base} - 来自${name}`;
}

/**
 * 取**目标机**的默认工作区（`workspace/initializeDefault`，零参数 → args 必须是 `{}`）。
 * 结果形状（抽自 `@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js`）：
 * `undefined | { workspace: { workspaceId, path, title, sessionIds, createdAt, updatedAt } }`。
 * 拿不到**绝不是**分叉的失败：调用方退回"不指定工作区"（= 目标机进程目录那条老路）。
 * @returns `{ workspaceId, cwd, error }`；`workspaceId === ""` 表示要退回，`error` 是要写进日志的原因。
 */
async function resolveTargetDefaultWorkspace(runtime, device, label) {
	const response = await postRemoteRpc(runtime, device, WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT, {}, {});
	markRpcReach(runtime, device, response);
	if (response.ok !== true) return { workspaceId: "", cwd: "", error: unreachableText(label, device, response) };
	const parsed = parseRpcText(response, `${label}（${WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT}）`);
	if (parsed.ok !== true) {
		return { workspaceId: "", cwd: "", error: remoteErrorText(`${label}（${WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT}）`, parsed.code, parsed.message) };
	}
	const value = parsed.value;
	const workspace = value !== null && typeof value === "object" ? value.workspace : undefined;
	const workspaceId = workspace !== null && typeof workspace === "object" && typeof workspace.workspaceId === "string" ? workspace.workspaceId.trim() : "";
	if (workspaceId === "") {
		return {
			workspaceId: "",
			cwd: "",
			error: `${label}：目标机 ${plainValue(device.id)} 的 ${WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT} 没给出默认工作区（那台机器首次使用还没落定目录）`,
		};
	}
	const cwd = typeof workspace.path === "string" ? workspace.path.trim() : "";
	return { workspaceId, cwd, error: null };
}

/** 找一个设备（必须是配置里的设备，且不是被认领的"本机"）。 */
function resolveRemoteDevice(runtime, id) {
	if (id === "") return { error: "缺少 device 参数（必须是配置里的一台设备的 id）" };
	if (!DEVICE_ID_PATTERN.test(id)) return { error: `device 参数不合法（只允许 A-Za-z0-9._~-，收到 ${JSON.stringify(id)}）` };
	const device = runtime.devices.find((entry) => entry.id === id);
	if (device === undefined) return { error: `unknown device: ${id}（这台设备不在配置里）` };
	if (device === runtime.localDevice) return { error: `设备 "${id}" 被认领为本机：本机文件不需要另存为/分叉（先切回本机再用本地功能）` };
	return { device };
}

/** 从服务抛出的错误里取 Remote 错误码（官方 `RemoteError` 的 `code`；形状不认识就返回空串）。 */
function errorCodeOf(error) {
	if (error === null || typeof error !== "object") return "";
	return typeof error.code === "string" ? error.code : "";
}

/**
 * Remote 错误码 → 中文说明（**本机**文件读取的版本；措辞与"目标机"那条区分开，
 * 排错时一眼能看出文件到底是在哪台机器上找的）。
 */
function localErrorText(code, message) {
	const known = {
		"workspace-file/not-found": "本机上找不到这个文件",
		"workspace-file/not-regular-file": "本机上这个路径不是普通文件（目录 / 符号链接 / 其它类型）",
		"workspace-file/outside-workspace": "路径越过了本机的工作区（目录列举限定在工作区内）",
		"workspace-file/too-large": "文件（或这一窗口）超过了本机的读取上限",
		"workspace-file/not-text": "本机认为这不是文本文件（按字节读取不受影响）",
		"workspace-file/unknown-workspace": "这个文件地址没有授权会话（session），本机无法据此定位文件",
		"gateway/lookup-not-found": "本机上找不到这个 session",
		"gateway/bad-request": "本机认为参数不合法",
		"gateway/arguments-invalid": "参数形状不被本机接受",
		"gateway/input-invalid": "参数没通过本机的校验",
		"gateway/definition-unavailable": "本机上这个 workspaceFiles 定义已被撤回",
		"gateway/internal": "本机内部错误",
	};
	const base = known[code] !== undefined ? known[code] : `本机返回错误 ${String(code)}`;
	const detail = typeof message === "string" && message !== "" ? `（${plainValue(message)}）` : "";
	return `${base}${detail}`;
}

/** 本机读的失败码 → HTTP 状态码：认得的复用目标机那套，其余一律 500（不是"网关"）。 */
function statusForLocalCode(code) {
	const mapped = statusForRpcCode(code);
	return mapped === 502 ? 500 : mapped;
}

/**
 * 打开**本机**的一份文件（`device` 缺失/为空时走这条）。
 *
 * 用的就是官方那个"按 session 授权读工作区文件"的服务：进程内调 `ctx.workspaceFiles`
 * （`@deepseek-ai/dsh-api-workspace-files` 的 `WorkspaceFiles`），session → `{sessionId, workspaceRoot}`
 * 由官方的 `typert.lookups` 的 `workspaceFileScope` 解析（**会话不存在/不可见 → 解析不出来 → 404**，
 * 这正是"用会话的工作区授权范围来约束"的那一步）。四道闸门（空路径、lstat、普通文件、
 * 末端符号链接）全在服务里，本插件**不自己发明**：它做的事只是把官方判定翻译成中文 + HTTP 码。
 * 与目标机那条代理路线是**同一个服务**，所以两条路的权限语义天然一致。
 *
 * 进程内调用 Remote 必须传 `AbortSignal`（官方 `@Remote` 包装会直接解引用它），
 * 而且这里把它接到响应断开上：浏览器取消下载 → 立刻取消这次文件读取。
 * @returns `{ ok:true, total, describe, read }` 或 `{ ok:false, status, message }`（message 已含 label）。
 */
function openLocalDownloadSource(runtime, label, sessionId, filePath, signal) {
	const typert = serviceOf(runtime.ctx, TYPERT_SERVICE);
	const workspaceFiles = serviceOf(runtime.ctx, WORKSPACE_FILES_SERVICE);
	const lookups = typert === undefined ? undefined : typert.lookups;
	const lookup = lookups === undefined || lookups === null || typeof lookups.get !== "function"
		? undefined
		: lookups.get(WORKSPACE_FILE_SCOPE_LOOKUP);
	const usable = typeof lookup?.resolve === "function"
		&& typeof workspaceFiles?.stat === "function" && typeof workspaceFiles?.readBytes === "function";
	if (usable !== true) {
		return {
			ok: false,
			status: 403,
			message: `${label}：本机文件读取不可用 —— 这台机器的组合里没有 ${WORKSPACE_FILES_SERVICE} / ${TYPERT_SERVICE} 服务`
				+ "（官方「按 session 授权读工作区文件」的那一套），本插件不会绕过它去直接读本机磁盘。",
		};
	}
	return (async () => {
		let scope;
		try {
			scope = await lookup.resolve(sessionId);
		} catch (error) {
			return { ok: false, status: 500, message: `${label}：解析本机会话失败（${plainValue(messageOf(error))}）` };
		}
		if (scope === undefined || scope === null) {
			return {
				ok: false,
				status: 404,
				message: `${label}：本机上找不到这个 session（${plainValue(sessionId)}）—— 本机文件读取按会话授权`
					+ "（官方 workspaceFileScope：会话头里的 cwd 就是工作区根），会话不存在/不可见就没有授权范围。",
			};
		}
		let stat;
		try {
			stat = await workspaceFiles.stat(scope, filePath, signal);
		} catch (error) {
			const code = errorCodeOf(error);
			return { ok: false, status: statusForLocalCode(code), message: `${label}：${localErrorText(code, messageOf(error))}` };
		}
		const frame = stat !== null && typeof stat === "object" ? stat : {};
		const total = Number.isSafeInteger(frame.bytes) && frame.bytes >= 0 ? frame.bytes : undefined;
		return {
			ok: true,
			total,
			describe: `本机的 ${plainValue(filePath)}`,
			read: async (offset) => {
				let window_;
				try {
					window_ = await workspaceFiles.readBytes(scope, filePath, { range: { offset, length: DOWNLOAD_CHUNK_BYTES } }, signal);
				} catch (error) {
					const code = errorCodeOf(error);
					return { ok: false, message: `${label}：${localErrorText(code, messageOf(error))}` };
				}
				return { ok: true, bytes: bytesOf(window_), eof: window_ !== null && typeof window_ === "object" && window_.eof === true };
			},
		};
	})();
}

/** 把 Uint8Array / Buffer 视图归一成 `Buffer`（零拷贝：只换视图，不复制字节）。 */
function bytesOf(windowFrame) {
	const data = windowFrame !== null && typeof windowFrame === "object" ? windowFrame.data : undefined;
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (data === undefined || data === null) return Buffer.alloc(0);
	try {
		return Buffer.from(data);
	} catch {
		return Buffer.alloc(0);
	}
}

/**
 * 打开**目标机**上的一份文件（`device` 有值时走这条，行为与旧版完全一致）：
 * `workspaceFiles/stat` 拿大小与类型 → `workspaceFiles/readBytes` 一窗口一次请求。
 * @returns `{ ok:true, total, describe, read }` 或 `{ ok:false, status, message }`。
 */
async function openRemoteDownloadSource(runtime, device, label, sessionId, devicePath) {
	// ---- 1. stat：拿大小（Content-Length）与类型（目录要报明确错误）----
	const statResponse = await postRemoteRpc(runtime, device, WORKSPACE_FILES_STAT_ENDPOINT, { workspaceFileScopeId: sessionId, path: devicePath }, {});
	markRpcReach(runtime, device, statResponse);
	if (statResponse.ok !== true) {
		return { ok: false, status: 502, message: unreachableText(label, device, statResponse) };
	}
	const stat = parseRpcText(statResponse, `${label}（${WORKSPACE_FILES_STAT_ENDPOINT}）`);
	if (stat.ok !== true) {
		return {
			ok: false,
			status: statusForRpcCode(stat.code),
			message: remoteErrorText(`${label}（${WORKSPACE_FILES_STAT_ENDPOINT}）`, stat.code, stat.message),
		};
	}
	const frame = stat.value !== null && typeof stat.value === "object" ? stat.value : {};
	const total = Number.isSafeInteger(frame.bytes) && frame.bytes >= 0 ? frame.bytes : undefined;
	return {
		ok: true,
		total,
		describe: `设备 "${device.id}" 的 ${plainValue(devicePath)}`,
		read: async (offset) => {
			const window_ = await postRemoteRpc(runtime, device, WORKSPACE_FILES_READ_BYTES_ENDPOINT, {
				workspaceFileScopeId: sessionId,
				path: devicePath,
				options: { range: { offset, length: DOWNLOAD_CHUNK_BYTES } },
			}, { maxBytes: DOWNLOAD_CHUNK_BYTES + MULTIPART_OVERHEAD_BYTES });
			markRpcReach(runtime, device, window_);
			if (window_.ok !== true) return { ok: false, message: unreachableText(label, device, window_) };
			const read = parseReadBytesResponse(window_, `${label}（${WORKSPACE_FILES_READ_BYTES_ENDPOINT}）`);
			if (read.ok !== true) {
				return { ok: false, message: remoteErrorText(`${label}（${WORKSPACE_FILES_READ_BYTES_ENDPOINT}）`, read.code, read.message) };
			}
			const readFrame = read.frame !== null && typeof read.frame === "object" ? read.frame : {};
			return { ok: true, bytes: read.bytes, eof: readFrame.eof === true };
		},
	};
}

/**
 * `GET /plugin/remote/download?device=&path=<路径>&session=<会话 id>`（受 enabled 门控）。
 *
 * 模型只有一句：**页面由哪台机器提供，文件就在哪台机器上。**
 *  - `device` 缺失/为空 → **本机文件**（这台机器的 `workspaceFiles` 按 session 授权读）；
 *  - `device` 有值 → 代理到那台设备（桌面 App 切了远端时用）。
 * 两条路只差在"怎么 stat / 怎么读一个窗口"，下面写响应头与按窗口流式回写的那段是**同一份代码**，
 * 响应头也沿用同一套（`application/octet-stream` + `nosniff` + RFC 5987 的 Content-Disposition）。
 *
 * 鉴权见 {@link authorizeTrustedRequest}（官方"可信请求"判定，不是"仅回环"）。
 * 响应一律不是 text/html：成功是 `application/octet-stream`，失败是 `text/plain`。
 */
async function handleDownloadRequest(runtime, req, res, parsed) {
	const label = "另存为";
	if (runtime.data.enabled !== true) {
		noteOp(runtime, "download", false, "插件已停用（enabled=false）");
		writeText(res, 403, `dsh-remote：${label}不可用 —— 插件已停用（enabled=false），与 /dev/** 一致；设置页照常可读，改回 true 即可恢复。\n`);
		return;
	}
	// ---- 0. 鉴权：官方"可信请求"判定（旧版的"仅回环"在这里被替换掉，见函数注释）----
	const trusted = authorizeTrustedRequest(runtime, req, label);
	if (trusted.ok !== true) {
		noteOp(runtime, "download", false, trusted.reason);
		writeText(res, trusted.status, `dsh-remote：${trusted.reason}\n`);
		return;
	}
	const deviceId = (parsed.searchParams.get("device") ?? "").trim();
	const devicePath = parsed.searchParams.get("path") ?? "";
	const sessionId = (parsed.searchParams.get("session") ?? "").trim();
	// device 空 = "页面所在这台机器"（浏览器打开另一台机器的 DSH 页面时就是这个分支）。
	const local = deviceId === "";
	let device = null;
	if (local !== true) {
		const resolved = resolveRemoteDevice(runtime, deviceId);
		if (resolved.error !== undefined) {
			noteOp(runtime, "download", false, resolved.error);
			writeText(res, 400, `dsh-remote：${label}参数错误 —— ${resolved.error}\n`);
			return;
		}
		device = resolved.device;
	}
	if (devicePath === "") {
		noteOp(runtime, "download", false, "缺少 path 参数");
		writeText(res, 400, `dsh-remote：${label}参数错误 —— 缺少 path 参数（工作区相对路径或绝对路径）。\n`);
		return;
	}
	if (devicePath.includes("\u0000")) {
		noteOp(runtime, "download", false, "path 含 NUL");
		writeText(res, 400, `dsh-remote：${label}参数错误 —— path 里含 NUL 字节。\n`);
		return;
	}
	if (devicePath.length > MAX_PATH_CHARS) {
		noteOp(runtime, "download", false, "path 过长");
		writeText(res, 400, `dsh-remote：${label}参数错误 —— path 过长（上限 ${String(MAX_PATH_CHARS)} 字符）。\n`);
		return;
	}
	if (sessionId === "") {
		noteOp(runtime, "download", false, "缺少 session 参数");
		writeText(res, 400, [
			`dsh-remote：${label}参数错误 —— 缺少 session 参数。`,
			"",
			"文件读取按 session 授权（官方 workspaceFiles 的 lookup workspaceFileScope：会话头里的",
			"cwd 就是工作区根），所以必须带上文件所在会话的 id：客户端半从槽位的**标准 prop**",
			"`sessionId` 取（ownerProp 只有 `absolutePath`；两者都不是资源地址，客户端半不解析",
			"`dsh-resource://…`）。本机与目标机走的是**同一个服务**，授权范围一致。",
			"",
		].join("\n"));
		return;
	}
	if (sessionId.includes("\u0000") || sessionId.length > MAX_SESSION_ID_CHARS) {
		noteOp(runtime, "download", false, "session 参数不合法");
		writeText(res, 400, `dsh-remote：${label}参数错误 —— session 参数不合法（非空、不含 NUL、不超过 ${String(MAX_SESSION_ID_CHARS)} 字符）。\n`);
		return;
	}

	// 本机那条路要把 AbortSignal 接到浏览器断开上（响应结束/断开 → 取消这次文件读取）。
	const readAbort = new AbortController();
	res.on("close", () => {
		try {
			readAbort.abort();
		} catch {
			/* 已经中止过 */
		}
	});

	// ---- 1. 打开来源：本机（device 为空）或那台设备（device 有值）----
	// stat 顺带给出大小（Content-Length）与类型（目录要报明确错误）。
	const source = local === true
		? await openLocalDownloadSource(runtime, label, sessionId, devicePath, readAbort.signal)
		: await openRemoteDownloadSource(runtime, device, label, sessionId, devicePath);
	if (source.ok !== true) {
		noteOp(runtime, "download", false, source.message);
		writeText(res, source.status, `dsh-remote：${source.message}\n`);
		return;
	}
	const total = source.total;

	// ---- 2. 先写响应头（浏览器据此决定文件名与保存），再按窗口流式写字节 ----
	const headers = {
		"content-type": "application/octet-stream",
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
		"content-disposition": contentDispositionFor(devicePath),
	};
	if (total !== undefined) headers["content-length"] = String(total);
	try {
		res.writeHead(200, headers);
	} catch (error) {
		noteOp(runtime, "download", false, `写响应头失败：${messageOf(error)}`);
		res.destroy();
		return;
	}

	let offset = 0;
	let written = 0;
	let windows = 0;
	let aborted = false;
	res.on("close", () => {
		if (res.writableEnded !== true) aborted = true;
	});
	const failStream = (message) => {
		noteOp(runtime, "download", false, message);
		warn(runtime.ctx, `${label}中断：${message}`);
		try {
			res.destroy();
		} catch {
			/* 已经断了 */
		}
	};
	while (aborted !== true) {
		windows += 1;
		if (windows > MAX_DOWNLOAD_WINDOWS) {
			failStream(`窗口数超过上限 ${String(MAX_DOWNLOAD_WINDOWS)}（疑似来源不推进 offset）`);
			return;
		}
		const window = await source.read(offset);
		if (window.ok !== true) {
			failStream(window.message);
			return;
		}
		const bytes = window.bytes;
		if (bytes.length > 0) {
			if (!res.write(bytes)) {
				await new Promise((resolve) => {
					const done = () => resolve();
					res.once("drain", done);
					res.once("close", done);
				});
			}
			written += bytes.length;
			offset += bytes.length;
		}
		if (window.eof === true) break;
		if (bytes.length === 0) break; // 来源给了空窗口却不说 eof：别在这里死循环
		if (total !== undefined && offset >= total) break;
	}
	if (aborted === true) {
		warn(runtime.ctx, `${label}：本机侧已断开，停止读取（已写 ${String(written)} 字节）`);
		return;
	}
	try {
		res.end();
	} catch {
		/* 已经结束 */
	}
	noteOp(runtime, "download", true, null);
	info(runtime.ctx, `${label}完成：${source.describe} → ${String(written)} 字节（${String(windows)} 个窗口）`);
}

/**
 * `POST /plugin/remote/fork`（仅回环；受 enabled 门控）。
 * 请求体 `{ targetDeviceId, sourceSessionId, sourceTitle?, tailN? }` →
 * `{ ok:true, targetDeviceId, newSessionId, title, workspaceId, cwd, workspaceFallback, renameError, ... }`。
 * 只带**文字上下文**，不带文件；不改本机会话、不切换设备（用户明确要求不自动切换）。
 * 顺序固定：目标机默认工作区（`workspace/initializeDefault`）→ `session/create` → `session/rename` → `session/prompt`。
 * 工作区与改名都是**尽力而为**：拿不到工作区退回老行为（`workspaceFallback:true`）、改名失败照发上下文（`renameError`）。
 */
async function handleForkRequest(runtime, req, res, headOnly) {
	const label = "分叉到";
	if (runtime.data.enabled !== true) {
		noteOp(runtime, "fork", false, "插件已停用（enabled=false）");
		writeJson(res, 403, { ok: false, error: `${label}不可用 —— 插件已停用（enabled=false），与 /dev/** 一致；设置页照常可读，改回 true 即可恢复。` }, headOnly);
		return;
	}
	const body = await readJsonBody(req);
	if (body.error !== undefined) {
		noteOp(runtime, "fork", false, body.error);
		writeJson(res, 400, { ok: false, error: body.error }, headOnly);
		return;
	}
	const payload = body.value !== null && typeof body.value === "object" ? body.value : {};
	const targetDeviceId = typeof payload.targetDeviceId === "string" ? payload.targetDeviceId.trim() : "";
	const sourceSessionId = typeof payload.sourceSessionId === "string" ? payload.sourceSessionId.trim() : "";
	// 条数优先级：请求体里的 tailN（老客户端 / 显式指定）→ 设置页「配置」块存的值 → 缺省。
	let tailN = effectiveForkTail(runtime);
	if (payload.tailN !== undefined && payload.tailN !== null) {
		const explicit = normalizeForkTail(payload.tailN);
		if (explicit === undefined) {
			noteOp(runtime, "fork", false, "tailN 不合法");
			writeJson(res, 400, { ok: false, error: `tailN 必须是 1..${String(FORK_MAX_TAIL)} 的整数（收到 ${JSON.stringify(payload.tailN)}）` }, headOnly);
			return;
		}
		tailN = explicit;
	}
	const resolved = resolveRemoteDevice(runtime, targetDeviceId);
	if (resolved.error !== undefined) {
		noteOp(runtime, "fork", false, resolved.error);
		writeJson(res, 400, { ok: false, error: `targetDeviceId 参数错误 —— ${resolved.error}` }, headOnly);
		return;
	}
	const device = resolved.device;
	if (sourceSessionId === "") {
		noteOp(runtime, "fork", false, "缺少 sourceSessionId");
		writeJson(res, 400, { ok: false, error: "缺少 sourceSessionId：请在会话「…」菜单里点「分叉到…」（拿不到当前会话 id 时不会猜）" }, headOnly);
		return;
	}
	if (sourceSessionId.includes("\u0000") || sourceSessionId.length > MAX_SESSION_ID_CHARS) {
		noteOp(runtime, "fork", false, "sourceSessionId 不合法");
		writeJson(res, 400, { ok: false, error: `sourceSessionId 不合法（非空、不含 NUL、不超过 ${String(MAX_SESSION_ID_CHARS)} 字符）` }, headOnly);
		return;
	}

	// ---- 1. 读本机源会话的尾页 ----
	const tail = await readLocalSessionTail(runtime, sourceSessionId, tailN);
	if (tail.ok !== true) {
		noteOp(runtime, "fork", false, tail.error);
		writeJson(res, 404, { ok: false, error: tail.error, targetDeviceId: device.id }, headOnly);
		return;
	}
	const seed = buildSeedContext(tail.records);
	if (seed.text.trim() === "") {
		const message = `本机会话 ${plainValue(sourceSessionId)} 最近 ${String(tailN)} 条消息里没有可带走的文字（空会话？）`;
		noteOp(runtime, "fork", false, message);
		writeJson(res, 400, { ok: false, error: message, targetDeviceId: device.id }, headOnly);
		return;
	}

	// 新会话标题：`<源会话标题> - 来自<本机设备名>`（源标题来自客户端半槽位 ownerProps 的 displayTitle）。
	const sourceTitle = cleanSourceTitle(payload.sourceTitle);
	const localName = localForkDeviceName(runtime);
	const requestedTitle = forkSessionTitle(sourceTitle, localName);

	// ---- 2. 先取**目标机**的默认工作区（失败/为空都只降级，绝不挡分叉）----
	const workspace = await resolveTargetDefaultWorkspace(runtime, device, label);
	const workspaceFallback = workspace.workspaceId === "";
	if (workspaceFallback) warn(runtime.ctx, `${label}：${workspace.error}；这次分叉不指定工作区（新会话落在目标机自己的默认 cwd）`);
	const workspaceNote = workspaceFallback
		? { workspaceFallback: true, workspaceId: null, cwd: null }
		: { workspaceFallback: false, workspaceId: workspace.workspaceId, cwd: workspace.cwd === "" ? null : workspace.cwd };

	// ---- 3. 在目标机新建会话：明确指定**目标机的默认工作区**（`SessionCreateRequest` 优先用 workspaceId，
	//         它与互斥的 `cwd` 不能同时给，两个都给会被目标机按 gateway/bad-request 拒掉）----
	const createResponse = await postRemoteRpc(runtime, device, SESSION_CREATE_ENDPOINT, {
		request: workspaceFallback ? {} : { workspaceId: workspace.workspaceId },
	}, {});
	markRpcReach(runtime, device, createResponse);
	if (createResponse.ok !== true) {
		const message = unreachableText(label, device, createResponse);
		noteOp(runtime, "fork", false, message);
		writeJson(res, 502, { ok: false, stage: "create", error: message, targetDeviceId: device.id, ...workspaceNote }, headOnly);
		return;
	}
	if (createResponse.status === 401 || createResponse.status === 403) {
		const message = `${label}：目标机 "${device.id}" 拒绝了这次调用（HTTP ${String(createResponse.status)}）—— token 可能已失效，请在设置页给这台设备补/换 token。`;
		noteOp(runtime, "fork", false, message);
		writeJson(res, 401, { ok: false, stage: "create", error: message, targetDeviceId: device.id, ...workspaceNote }, headOnly);
		return;
	}
	const created = parseRpcText(createResponse, `${label}（${SESSION_CREATE_ENDPOINT}）`);
	if (created.ok !== true) {
		const message = remoteErrorText(`${label}（${SESSION_CREATE_ENDPOINT}）`, created.code, created.message);
		noteOp(runtime, "fork", false, message);
		writeJson(res, statusForRpcCode(created.code), { ok: false, stage: "create", error: message, targetDeviceId: device.id, ...workspaceNote }, headOnly);
		return;
	}
	const createdValue = created.value !== null && typeof created.value === "object" ? created.value : {};
	const newSessionId = typeof createdValue.sessionId === "string" ? createdValue.sessionId : "";
	if (newSessionId === "") {
		const message = `${label}：目标机 ${plainValue(device.id)} 创建会话后没有返回 sessionId`;
		noteOp(runtime, "fork", false, message);
		writeJson(res, 502, { ok: false, stage: "create", error: message, targetDeviceId: device.id, ...workspaceNote }, headOnly);
		return;
	}

	// ---- 4. 给新会话改名（`session/rename`，args 恰好 `{ request: { sessionId, title } }`）----
	//         会话已经建好了：改名失败只记 `renameError` + 一条 warn，**不**让整个分叉失败。
	const renameResponse = await postRemoteRpc(runtime, device, SESSION_RENAME_ENDPOINT, {
		request: { sessionId: newSessionId, title: requestedTitle },
	}, {});
	markRpcReach(runtime, device, renameResponse);
	let title = requestedTitle;
	let renameError = null;
	if (renameResponse.ok !== true) {
		renameError = unreachableText(label, device, renameResponse);
	} else {
		const renamed = parseRpcText(renameResponse, `${label}（${SESSION_RENAME_ENDPOINT}）`);
		if (renamed.ok !== true) {
			renameError = remoteErrorText(`${label}（${SESSION_RENAME_ENDPOINT}）`, renamed.code, renamed.message);
		} else if (renamed.value !== null && typeof renamed.value === "object" && typeof renamed.value.title === "string" && renamed.value.title !== "") {
			// 目标机归一化后的标题（它自己的 title 服务会压空白/截断），以它为准。
			title = renamed.value.title;
		}
	}
	if (renameError !== null) {
		warn(runtime.ctx, `${label}：给新会话 ${plainValue(newSessionId)} 改名失败（会话已建好，继续发上下文）—— ${renameError}`);
	}

	// ---- 5. 把种子当作第一条消息发过去（mode: "queue"）----
	const promptResponse = await postRemoteRpc(runtime, device, SESSION_PROMPT_ENDPOINT, {
		request: {
			requestId: nextRpcId(runtime),
			sessionId: newSessionId,
			mode: "queue",
			content: [{ type: "text", text: forkSeedPrompt(seed.text) }],
		},
	}, {});
	markRpcReach(runtime, device, promptResponse);
	if (promptResponse.ok !== true) {
		const message = `${unreachableText(label, device, promptResponse)}（会话 ${plainValue(newSessionId)} 已创建，但种子没发出去）`;
		noteOp(runtime, "fork", false, message);
		writeJson(res, 502, { ok: false, stage: "prompt", error: message, targetDeviceId: device.id, newSessionId, title, renameError, ...workspaceNote }, headOnly);
		return;
	}
	const prompted = parseRpcText(promptResponse, `${label}（${SESSION_PROMPT_ENDPOINT}）`);
	if (prompted.ok !== true) {
		const message = `${remoteErrorText(`${label}（${SESSION_PROMPT_ENDPOINT}）`, prompted.code, prompted.message)}（会话 ${plainValue(newSessionId)} 已创建，但种子没发出去）`;
		noteOp(runtime, "fork", false, message);
		writeJson(res, statusForRpcCode(prompted.code), { ok: false, stage: "prompt", error: message, targetDeviceId: device.id, newSessionId, title, renameError, ...workspaceNote }, headOnly);
		return;
	}
	noteOp(runtime, "fork", true, null);
	info(runtime.ctx, `${label}完成：本机会话 "${sourceSessionId}"（${String(seed.messages)} 条消息 / ${String(Buffer.byteLength(seed.text, "utf8"))} 字节，来源 ${String(tail.via)}）→ 设备 "${device.id}" 的新会话 "${newSessionId}"，标题 "${title}"，工作区 ${workspaceFallback ? "（退回目标机默认 cwd）" : `"${workspace.workspaceId}"`}${renameError === null ? "" : "（改名失败）"}`);
	writeJson(res, 200, {
		ok: true,
		targetDeviceId: device.id,
		targetDeviceName: device.name,
		newSessionId,
		title,
		sourceTitle,
		localName,
		renameError,
		messages: seed.messages,
		bytes: Buffer.byteLength(seed.text, "utf8"),
		via: tail.via,
		...workspaceNote,
	}, headOnly);
}

//#endregion

export {
	basenameOf,
	blockSummary,
	buildSeedContext,
	bytesOf,
	contentDispositionFor,
	contentText,
	encodeRfc5987,
	errorCodeOf,
	forkSeedPrompt,
	handleDownloadRequest,
	handleForkRequest,
	localErrorText,
	localPseudoDevice,
	messageOfRecord,
	multipartBoundary,
	opNote,
	parseMultipart,
	parseRpcResult,
	parseRpcText,
	postRemoteRpc,
	remoteErrorText,
	statusForLocalCode,
};
