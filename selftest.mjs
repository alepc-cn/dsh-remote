/**
 * @local/dsh-remote 自测（不需要安装插件、不改 profile、不重启任何东西）。
 *
 * 做法（沿用 @local/dsh-device-switch selftest.mjs 的骨架，把 150 条断言原样搬过来 +
 * 针对本版新增能力再加一组 G）：
 *  - 用一个**假 ctx** 实现 webServer.register / registerUpgrade / tapIndex /
 *    collectIndexInjections 与 effect / on / inject（匹配规则照抄真实现：exact 优先、
 *    前缀取最长，且 `pathname === prefix || startsWith(prefix + "/")`），
 *    并把 logger 的每条告警记进 `logs`，好断言 I1 的"写日志"。
 *  - 起一个真 node:http 服务器当"本机 DSH 服务"，把插件注册的路由接进去。
 *  - 起一个**假的远端 DSH** 当"别的机器"：复刻 Host/Origin 栅栏、`dsh-auth-*` cookie、
 *    `?token=` → 303 + Set-Cookie 的引导流程、401 文案、流式响应、WS 升级，且首页返回 HTML。
 *  - 另有一台指向**真实本机 DSH**（http://127.0.0.1:19387）的设备，验证真实转发语义。
 *  - 垫片脚本取出来在 node:vm 的沙箱里执行（假 localStorage / location / document / fetch /
 *    WebSocket / XMLHttpRequest），断言改写、幂等、胶囊与"报到"行为（D 组）。
 *  - 设备表全部落在**临时目录里的数据文件**（`config.dataFile`），profile 配置只当一次性种子；
 *    凭据服务用一个假的 `ctx.credentials`（G 组另外跑一遍"没有凭据服务"的退化路线）。
 *
 * 断言分组：T=数据文件/路由形状、A=I1、B=API 透传与 token、C=I2 注入、D=垫片单测、
 *          E=旧断言复核、F=本机自验证、G=新增（状态接口 / 设备 CRUD / enabled / mux 发现 /
 *          hello / I1 推广 / token 存储路线）。
 * 运行：<node.exe> selftest.mjs
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as netCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { apply, inject, internals, name as pluginName } from "./lib/index.js";

const log = (...args) => console.log(...args);
const section = (title) => log(`\n=== ${title} ===`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每次运行一个独立的临时目录（数据文件绝不碰 $DSH_HOME）。 */
const workDir = mkdtempSync(join(tmpdir(), "dsh-remote-selftest-"));
let dataSeq = 0;
const freshDataFile = () => join(workDir, `devices-${String((dataSeq += 1))}.json`);
const readJsonFile = (path) => JSON.parse(readFileSync(path, "utf8"));

//#region 假 ctx / 本机服务

/**
 * 与 @deepseek-ai/dsh-host-webserver 的 match() 同构：exact 优先，前缀最长优先。
 * 额外提供 connection / credentials / configEditor 三个 service 与 Cortis 的 `ctx.inject` / `ctx.get`；
 * `options.services` 里还能塞任意 service（本机文件读取用 `workspaceFiles` + `typert`）。
 */
function createRouter(options = {}) {
	const exact = new Map();
	const prefixes = new Map();
	const upgrades = new Map();
	const taps = [];
	const listeners = new Map();
	const effects = [];
	const logs = [];
	const pendingInjects = [];
	const services = {
		connection: options.connection ?? {
			trustedHosts: ["192.0.2.4", "203.0.113.1"],
			browserAuth: { maxAgeMilliseconds: 3_650 * 86_400_000 },
			authenticatedUrl: (base) => `${base}${base.includes("?") ? "&" : "?"}token=stub-launch-token`,
			// 官方的"可信请求"判定（真实现 = `@deepseek-ai/dsh-client-connection` 的
			// `HostConnectionService.requestRejection(req)`：Host/Origin 栅栏不过 → 403，
			// 栅栏过了但没有有效会话 cookie → 401，可信 → undefined）。
			// 这里缺省**可信**（等价于"回环 + 带有效 dsh-auth-* cookie"）；要测拒绝就自己传一个。
			requestRejection: () => undefined,
		},
		credentials: options.credentials,
		configEditor: options.configEditor,
		// 可选服务（本机文件读取用 `workspaceFiles` + `typert`，见 createLocalWorkspaceFiles）。
		...(options.services ?? {}),
	};
	const match = (pathname) => {
		const hit = exact.get(pathname);
		if (hit !== undefined) return hit;
		let best;
		for (const [prefix, route] of prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === undefined || prefix.length > best.path.length) best = route;
		}
		return best;
	};
	const record = (level, args) => {
		const line = args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
		logs.push(`${level}: ${line}`);
		log(`  [plugin ${level}]`, ...args);
	};
	const injectImpl = (deps, callback) => {
		const names = Array.isArray(deps) ? deps : Object.keys(deps);
		const run = () => callback(ctx, undefined);
		if (names.every((name) => services[name] !== undefined && services[name] !== null)) {
			run();
			return {};
		}
		pendingInjects.push({ names, run });
		return {};
	};
	const ctx = {
		logger: {
			warn: (...a) => record("warn", a),
			error: (...a) => record("error", a),
			info: (...a) => record("info", a),
		},
		webServer: {
			port: 0,
			host: "127.0.0.1",
			config: { host: "127.0.0.1", port: 0 },
			register: (route) => {
				const table = route.kind === "exact" ? exact : prefixes;
				if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`);
				table.set(route.path, route);
				return () => table.delete(route.path);
			},
			registerUpgrade: (route) => {
				if (upgrades.has(route.path)) throw new Error(`duplicate upgrade route ${route.path}`);
				upgrades.set(route.path, route);
				return () => upgrades.delete(route.path);
			},
			tapIndex: (transform) => {
				taps.push(transform);
				return () => {
					const at = taps.indexOf(transform);
					if (at !== -1) taps.splice(at, 1);
				};
			},
			collectIndexInjections: () => {
				const table = Array.isArray(options.injections) ? options.injections.map((row) => ({ ...row })) : [];
				emit("webserver/index-inject", table);
				return table;
			},
		},
		effect: (factory, label) => {
			const disposer = factory();
			effects.push({ label, dispose: typeof disposer === "function" ? disposer : () => {} });
			return disposer;
		},
		on: (event, listener) => {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return () => {
				const at = list.indexOf(listener);
				if (at !== -1) list.splice(at, 1);
			};
		},
		inject: injectImpl,
		/** 真 Cordis 读服务走 `ctx.get(name)`（插件用 serviceOf 两者都认）；这里照做。 */
		get: (name) => services[name],
		_provide: (name, value) => {
			services[name] = value;
			for (const entry of [...pendingInjects]) {
				if (!entry.names.every((dep) => services[dep] !== undefined && services[dep] !== null)) continue;
				pendingInjects.splice(pendingInjects.indexOf(entry), 1);
				entry.run();
			}
		},
	};
	for (const name_ of ["connection", "credentials", "configEditor", "sessionController", ...Object.keys(options.services ?? {})]) {
		Object.defineProperty(ctx, name_, { get: () => services[name_], enumerable: true });
	}
	const emit = (event, argument) => {
		for (const listener of listeners.get(event) ?? []) listener(argument);
	};
	return {
		ctx,
		match,
		exact,
		prefixes,
		upgrades,
		taps,
		listeners,
		effects,
		logs,
		emit,
		services,
		devPrefixes: () => [...prefixes.keys()].filter((path) => path.startsWith("/dev/")),
	};
}

/** 把路由表接进一个真 HTTP 服务器（这就是"本机 DSH 服务"）。 */
async function startFakeHost(router) {
	const server = createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://local.invalid").pathname;
		const route = router.match(pathname);
		if (route === undefined) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("no route (fallback)");
			return;
		}
		Promise.resolve(route.handler(req, res)).catch((error) => {
			if (!res.headersSent) res.writeHead(500);
			res.end(String(error));
		});
	});
	server.on("upgrade", (req, socket, head) => {
		const pathname = new URL(req.url ?? "/", "http://local.invalid").pathname;
		const route = router.upgrades.get(pathname);
		if (route === undefined) {
			socket.destroy();
			return;
		}
		Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy());
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	router.ctx.webServer.port = port;
	router.ctx.webServer.config.port = port;
	return { server, port, close: () => new Promise((resolve) => server.close(resolve)) };
}

//#endregion

//#region 假的本机文件读取（workspaceFiles + typert）

/**
 * 假的**本机**文件读取服务，照官方 `@deepseek-ai/dsh-api-workspace-files` 的契约做：
 *  - `typert.lookups.get("workspaceFileScope").resolve(sessionId)` → `{ sessionId, workspaceRoot }`；
 *    会话不存在/不可见 → `undefined`（官方就是靠这一步把"按 session 授权"落到工作区根上）；
 *  - `workspaceFiles.stat(scope, path, signal)` / `readBytes(scope, path, options, signal)`：
 *    只认普通文件（`null` 当目录），`range.offset/length` 是 0 起算的字节窗口；
 *  - 失败一律是带 `code` 的 Error（真实现是 `RemoteError`，码名完全相同）；
 *  - **`signal` 必须是 AbortSignal**：真实现里 `@Remote` 包装会直接解引用它（缺了就抛
 *    "Cannot read properties of undefined (reading 'throwIfAborted')"—— 这条实测记录在
 *    readLocalSessionTail 的注释里），所以假的也照这个要求卡，防止插件走上不传 signal 的老路。
 */
function createLocalWorkspaceFiles(options = {}) {
	const files = new Map();
	for (const [path, value] of Object.entries(options.files ?? {})) files.set(path, value === null ? null : Buffer.from(value));
	const sessions = new Set(options.sessions ?? ["sess-local"]);
	const workspaceRoot = options.workspaceRoot ?? "C:\\work";
	const calls = { resolve: [], stat: [], readBytes: [] };
	const failures = [];
	const isAbsolute = (path) => /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("/") || path.startsWith("\\");
	const keyOf = (path) => (isAbsolute(path) ? path : `${workspaceRoot}\\${path}`);
	function refusal(code, message) {
		const error = new Error(message);
		error.code = code;
		return error;
	}
	function requireSignal(signal, where) {
		if (signal === undefined || signal === null || typeof signal.throwIfAborted !== "function") {
			failures.push(`${where} 没有传 AbortSignal`);
			throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
		}
	}
	function entryOf(path) {
		const entry = files.get(keyOf(path));
		if (entry === undefined) throw refusal("workspace-file/not-found", `no entry at "${path}"`);
		if (entry === null) throw refusal("workspace-file/not-regular-file", `"${path}" is a directory`);
		return entry;
	}
	const typert = {
		lookups: {
			get: (key) => (key === internals.WORKSPACE_FILE_SCOPE_LOOKUP
				? {
						resolve: async (sessionId) => {
							calls.resolve.push(sessionId);
							return sessions.has(sessionId) ? { sessionId, workspaceRoot } : undefined;
						},
					}
				: undefined),
		},
	};
	const workspaceFiles = {
		async stat(scope, path, signal) {
			requireSignal(signal, "stat");
			calls.stat.push({ scope, path });
			const entry = entryOf(path);
			return { absolutePath: keyOf(path), version: "v1", bytes: entry.length };
		},
		async readBytes(scope, path, options, signal) {
			requireSignal(signal, "readBytes");
			calls.readBytes.push({ scope, path, options });
			const entry = entryOf(path);
			const range = options !== null && typeof options === "object" && options.range !== null && typeof options.range === "object" ? options.range : {};
			const offset = Number.isSafeInteger(range.offset) ? range.offset : 0;
			const length = Number.isSafeInteger(range.length) ? range.length : 2 * 1024 * 1024;
			const end = Math.min(offset + length, entry.length);
			const slice = entry.subarray(offset, end);
			// 刻意回一个**普通 Uint8Array**（不是 Buffer）：插件的 bytesOf 必须两种都认。
			const data = new Uint8Array(slice.byteLength);
			data.set(slice);
			return { offset, data, eof: end >= entry.length, absolutePath: keyOf(path), version: "v1", bytes: entry.length };
		},
	};
	return { typert, workspaceFiles, calls, failures, files, sessions, workspaceRoot };
}

//#endregion

//#region 假远端 DSH

const base64Url = (buffer) => buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";

function textFrame(text) {
	const payload = Buffer.from(text, "utf8");
	assert.ok(payload.length < 126, "自测只用短帧");
	return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/**
 * 复刻远端 DSH 的关键行为：
 *  - Host 必须是本 stub 的 authority，否则 403（信任栅栏）；
 *  - 带 Origin 时必须与 Host 同 host；
 *  - `/` + 正确的 `?token=` → 303 + Set-Cookie + location "./"；
 *  - `/` 或 `/index.html` 有会话 cookie → 200 **text/html**（0.1.0 就是把它代理进了窗口）；
 *  - `/api/*` 有会话 cookie → 200 JSON，否则 401 文案；
 *  - `/api/<namespace>/<method>` 是 **Connection 的一元 Remote RPC**（H 组用它做真字节下载与建会话）；
 *  - `/stream` → 分 3 块、间隔 120ms 的流式响应。
 */

/** 把几段拼成一个 multipart/form-data 响应体（够本 stub 用：只有 name / filename / contentType / data）。 */
function multipartBody(boundary, parts) {
	const chunks = [];
	for (const part of parts) {
		const disposition = `Content-Disposition: form-data; name="${part.name}"${part.filename === undefined ? "" : `; filename="${part.filename}"`}`;
		const type = part.contentType === undefined ? "" : `\r\nContent-Type: ${part.contentType}`;
		chunks.push(Buffer.from(`--${boundary}\r\n${disposition}${type}\r\n\r\n`, "utf8"));
		chunks.push(part.data);
		chunks.push(Buffer.from("\r\n", "utf8"));
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
	return Buffer.concat(chunks);
}

/**
 * 远端 /api 的 Remote RPC 处理器（H 组用）。
 * 只实现本插件真正会打的 endpoint，但**信封校验照做**（method 必须等于路径、payload 恰好一个 args 字段），
 * 这样"客户端半猜错路径/参数形状"会立刻变成测试失败，而不是悄悄通过。
 */
function createRemoteApi(options = {}) {
	const file = options.file ?? Buffer.from("hello remote file\n", "utf8");
	return {
		/** `path → { data }`（目录用 `{ directory: true }`）。 */
		files: options.files ?? new Map([["notes/中文 文件.md", { data: file }], ["big.bin", { data: Buffer.alloc(0) }]]),
		statCalls: [],
		readBytesCalls: [],
		createCalls: [],
		promptCalls: [],
	uploads: [],
		renameCalls: [],
		workspaceCalls: [],
		/** 被真正处理（不是 generic 兜底）的 endpoint 顺序 —— 分叉的"先工作区、后建会话、再改名、最后发种子"靠它验。 */
		callOrder: [],
		rpcIds: [],
		/** 置 true 时 session/create 回一个业务错误（测"创建失败"分支）。 */
		createError: false,
		/** 置 true 时 session/rename 回一个业务错误（测"改名失败也不挡分叉"分支）。 */
		renameError: false,
		/** 置 true 时 workspace/initializeDefault 回业务错误（老版本没这个 endpoint 的样子）。 */
		workspaceError: false,
		/** 置 true 时 workspace/initializeDefault 正常返回、但结果是 undefined（首次使用还没落定目录）。 */
		workspaceEmpty: false,
	};
}

/**
 * 目标机默认工作区的**样本**（形状逐字抄自 `@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js`
 * 里 `workspace/initializeDefault` 的 result schema：`{ workspace: { workspaceId, path, title, sessionIds, createdAt, updatedAt } }`）。
 */
const STUB_DEFAULT_WORKSPACE = {
	workspaceId: "ws-default",
	path: "C:\\Users\\<user>\\Documents\\deepseek-harness\\default-workspace",
	title: "default-workspace",
	sessionIds: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
};


function handleStubApi(api, authority, pathname, rawBody, res) {
	const endpoint = pathname.slice("/api/".length);
	let envelope = null;
	try {
		envelope = JSON.parse(rawBody === "" ? "{}" : rawBody);
	} catch {
		envelope = null;
	}
	const reply = (result, attachments) => {
		const rpcId = envelope !== null && typeof envelope.rpcId === "string" ? envelope.rpcId : "invalid-request";
		const body = { type: "server-response", rpcId, result };
		if (attachments === undefined || attachments.length === 0) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
			return;
		}
		const boundary = "----dshRemoteSelftestBoundary";
		// 真实现里 gateway 的 codec 会把字节值换成 null 占位、字节走附件（见 gateway 的 encodeRpcResult）。
		// 这里必须照做：否则 metadata 里会被 JSON.stringify(Buffer) 撑成 1.8 MB 的 {type:"Buffer",data:[…]}。
		const placeholder = (value) => {
			if (value === null || typeof value !== "object") return value;
			const copy = { ...value };
			for (const attachment of attachments) {
				if (Array.isArray(attachment.path) && attachment.path.length === 1) copy[attachment.path[0]] = null;
			}
			return copy;
		};
		const metadata = JSON.stringify({
			type: body.type,
			rpcId: body.rpcId,
			result: { ok: true, value: placeholder(body.result.value) },
			attachments: attachments.map((attachment, index) => ({ path: attachment.path, codec: "bytes", part: `bytes-${String(index)}` })),
		});
		const parts = [{ name: "metadata", data: Buffer.from(metadata, "utf8") }];
		attachments.forEach((attachment, index) => {
			parts.push({ name: `bytes-${String(index)}`, filename: "blob", contentType: "application/octet-stream", data: attachment.bytes });
		});
		res.writeHead(200, { "content-type": `multipart/form-data; boundary=${boundary}` });
		res.end(multipartBody(boundary, parts));
	};
	const fail = (code, message, details) => reply({ ok: false, error: { code, message, details: details ?? {} } });
	const generic = () => {
		// 旧行为：/api/** 上的**普通**请求（不是 Connection 的 client-request 信封）一律 200 JSON。
		// 既有的"API 透传"断言就靠它；只有真正的 Remote RPC 才走下面的分派。
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, path: pathname, seenHost: authority }));
	};

	if (envelope === null || envelope.type !== "client-request") {
		generic();
		return;
	}
	const known = ["workspaceFiles/stat", "workspaceFiles/readBytes", "session/create", "session/prompt", "session/rename", "workspace/initializeDefault"];
	if (!known.includes(endpoint)) {
		generic();
		return;
	}
	if (envelope.method !== endpoint || envelope.payload === null || typeof envelope.payload !== "object"
		|| Object.keys(envelope.payload).length !== 1 || typeof envelope.payload.args !== "object") {
		res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
		res.end(`bad client-request envelope for ${endpoint}\n`);
		return;
	}
	api.rpcIds.push(envelope.payload.rpcId ?? envelope.rpcId);
	api.callOrder.push(endpoint);
	const args = envelope.payload.args;

	if (endpoint === "workspaceFiles/stat") {
		api.statCalls.push(args);
		if (args.workspaceFileScopeId !== "sess-1") {
			fail("gateway/lookup-not-found", "lookup provider workspaceFileScope did not resolve the requested identity", { field: "workspaceFileScopeId" });
			return;
		}
		const entry = api.files.get(args.path);
		if (entry === undefined) {
			fail("workspace-file/not-found", `no such file: ${String(args.path)}`, {});
			return;
		}
		if (entry.directory === true) {
			fail("workspace-file/not-regular-file", "path is not a regular file", { kind: "directory" });
			return;
		}
		reply({ ok: true, value: { absolutePath: `/workspace/${String(args.path)}`, version: "v1", bytes: entry.data.length } });
		return;
	}
	if (endpoint === "workspaceFiles/readBytes") {
		api.readBytesCalls.push(args);
		const entry = api.files.get(args.path);
		if (entry === undefined) {
			fail("workspace-file/not-found", `no such file: ${String(args.path)}`, {});
			return;
		}
		const range = args.options !== null && typeof args.options === "object" && args.options.range !== null && typeof args.options.range === "object"
			? args.options.range
			: {};
		const offset = Number.isSafeInteger(range.offset) ? range.offset : 0;
		const length = Number.isSafeInteger(range.length) ? range.length : entry.data.length;
		const slice = entry.data.subarray(offset, offset + length);
		const eof = offset + slice.length >= entry.data.length;
		reply({
			ok: true,
			value: { offset, data: slice, eof, absolutePath: `/workspace/${String(args.path)}`, version: "v1", bytes: entry.data.length },
		}, [{ path: ["data"], bytes: slice }]);
		return;
	}
	if (endpoint === "session/create") {
		api.createCalls.push(args);
		if (api.createError === true) {
			fail("gateway/internal", "selftest: create refused", {});
			return;
		}
		reply({ ok: true, value: { sessionId: "new-sess-1" } });
		return;
	}
	if (endpoint === "session/prompt") {
		api.promptCalls.push(args);
		const request = args.request ?? {};
		if (typeof request.sessionId !== "string" || request.sessionId === "" || request.mode !== "queue"
			|| !Array.isArray(request.content) || request.content.length === 0) {
			fail("gateway/bad-request", "selftest: prompt request shape is wrong", {});
			return;
		}
		reply({ ok: true, value: { accepted: true } });
		return;
	}
	if (endpoint === "session/rename") {
		api.renameCalls.push(args);
		// 形状照 descriptor 严格校验（gateway 的 assertExactArguments 就是这么干的）：
		// 参数**恰好**一个 `request`，且 request 的键恰好是 `sessionId` + `title`。
		const keys = args !== null && typeof args === "object" ? Object.keys(args) : [];
		const request = keys.length === 1 && keys[0] === "request" && args.request !== null && typeof args.request === "object" ? args.request : null;
		const requestKeys = request === null ? [] : Object.keys(request).sort();
		if (request === null || JSON.stringify(requestKeys) !== JSON.stringify(["sessionId", "title"])
			|| typeof request.sessionId !== "string" || request.sessionId === ""
			|| typeof request.title !== "string" || request.title === "") {
			fail("gateway/arguments-invalid", "selftest: rename request shape is wrong", {});
			return;
		}
		if (api.renameError === true) {
			fail("session/title-invalid", "selftest: rename refused", {});
			return;
		}
		reply({ ok: true, value: { title: request.title, seq: 7 } });
		return;
	}
	if (endpoint === "workspace/initializeDefault") {
		api.workspaceCalls.push(args);
		// descriptor 是零参数：args 必须是空对象（多一个字段都会被 assertExactArguments 拒掉）。
		if (Object.keys(args).length !== 0) {
			fail("gateway/arguments-invalid", "selftest: initializeDefault takes no arguments", {});
			return;
		}
		if (api.workspaceError === true) {
			fail("gateway/definition-unavailable", "selftest: this host mounts no workspace controller", {});
			return;
		}
		if (api.workspaceEmpty === true) {
			// 真实现里"首次使用不合格"就是 `undefined`（JSON 里 value 字段直接消失）。
			reply({ ok: true, value: undefined });
			return;
		}
		reply({ ok: true, value: { workspace: STUB_DEFAULT_WORKSPACE } });
		return;
	}
	if (endpoint === "session/projections" || endpoint === "session/page") {
		// 本机 facade：H 组把"本机的 /api/session/*"注册在**假本机**上（见 registerLocalSessionApi），
		// 远端 stub 不提供这两个 endpoint（上面已经把它们挡在 generic 之外了）。
		generic();
		return;
	}
	generic();
}

async function startStubRemote({ token = "stub-token", secretCookie = "stub-session-value", files, cookieAuthority = "" } = {}) {
	const requests = [];
	const upgradesSeen = [];
	const handshakes = [];
	const api = createRemoteApi({ files });
	const indexHtml = "<!doctype html>\n<html lang=\"en\"><head><base href=\"./\">"
		+ "<meta charset=\"utf-8\"><title>remote dsh</title>"
		+ "<script type=\"module\" crossorigin src=\"./assets/index-remote.js\"></script></head>"
		+ "<body><div id=\"root\">REMOTE-INDEX-MARKER</div></body></html>";

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub.invalid");
		const authority = req.headers.host ?? "";
		const record = {
			method: req.method,
			url: req.url,
			host: authority,
			origin: req.headers.origin,
			cookie: req.headers.cookie,
			acceptEncoding: req.headers["accept-encoding"],
		};
		requests.push(record);
		// cookieAuthority 非空 = 模拟"服务器按自己的 authority 命名 cookie"（对外入口把 Host 改写掉之后就是这样）。
		const nameAuthority = cookieAuthority === "" ? authority : cookieAuthority;
		const cookieName = `dsh-auth-${base64Url(createHash("sha256").update(nameAuthority).digest())}`;
		const authed = typeof req.headers.cookie === "string"
			&& req.headers.cookie.split(";").some((part) => part.trim() === `${cookieName}=${secretCookie}`);
		const fenceOk = authority.endsWith(":") === false
			&& (req.headers.origin === undefined || new URL(req.headers.origin).host === authority);

		const unauthorized = (status = 401) => {
			res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
		};

		if (!fenceOk) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
			res.end("forbidden by host/origin fence\n");
			return;
		}
		if (url.pathname === "/stream") {
			if (!authed) return unauthorized();
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			res.write("chunk-1\n");
			setTimeout(() => {
				res.write("chunk-2\n");
				setTimeout(() => res.end("chunk-3\n"), 120);
			}, 120);
			return;
		}
		if (url.pathname === "/") {
			const tokens = url.searchParams.getAll("token");
			if (tokens.length > 0) {
				if (tokens.length === 1 && tokens[0] === token) {
					res.writeHead(303, {
						"cache-control": "no-store",
						location: "./",
						"set-cookie": `${cookieName}=${secretCookie}; Max-Age=315360000; Path=/; HttpOnly; SameSite=Strict`,
					});
					res.end();
					return;
				}
				return unauthorized();
			}
			if (!authed) return unauthorized();
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(indexHtml);
			return;
		}
		if (url.pathname === "/index.html") {
			// 真实现里 token 兑换只认 pathname === "/"：/index.html?token=… 会 401，
			// 这正是"宿主侧 cookie jar"必须存在的原因。
			if (!authed) return unauthorized();
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(indexHtml);
			return;
		}
		if (url.pathname === "/fake-html") {
			// content-type 撒谎成 JSON、响应体却是 HTML：I1 的第二道判定（嗅探）要能拦住。
			res.writeHead(200, { "content-type": "application/json" });
			// 0.10.8：前面塞 120 字节空白 —— **专测报告的"前置空白把判定挤出 64 字节嗅探窗口"**：
			// 老代码在前 64 字节全空白时判定退化成 maybe，响应体又在 4096 以内 → end 分支无条件放行。
			res.end("\n  " + " ".repeat(120) + "<!DOCTYPE html><html><head></head><body>SNEAKY-HTML</body></html>");
			return;
		}
		if (url.pathname === "/api/empty") {
			// 空响应体（附件上传/状态更新这类 POST 成功后的常态）：**绝不能被 I1 拦掉**。
			res.writeHead(200, { "content-type": "application/json" });
			res.end();
			return;
		}
		if (url.pathname === "/api/session/uploadFileBinary") {
			// 官方原始字节上传路由（0.11.0 跨机附件搬运走的就是它）：记录字节与元数据。
			const record = {
				sessionId: url.searchParams.get("sessionId"),
				name: url.searchParams.get("name"),
				contentType: req.headers["content-type"],
				authed,
				chunks: [],
			};
			req.on("data", (chunk) => record.chunks.push(chunk));
			req.on("end", () => {
				record.bytes = Buffer.concat(record.chunks);
				delete record.chunks;
				api.uploads.push(record);
				res.writeHead(200, { "content-type": "application/json" });
				// 真机形状（0.11.0 探针实测）：{ok:true, value:{receiptId, file:{attachmentId, name, bytes}}}
				res.end(JSON.stringify({
					ok: true,
					value: {
						receiptId: "receipt-1",
						file: { attachmentId: "sha256:deadbeef", name: record.name ?? "file", bytes: record.bytes.length },
					},
				}));
			});
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			if (!authed) {
				req.resume();
				return unauthorized();
			}
			const chunks = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				handleStubApi(api, authority, url.pathname, Buffer.concat(chunks).toString("utf8"), res);
			});
			return;
		}
		if (url.pathname === "/redirect-absolute") {
			res.writeHead(302, { location: `http://${authority}/somewhere` });
			res.end();
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("stub remote: not found\n");
	});

	server.on("upgrade", (req, socket) => {
		const authority = req.headers.host ?? "";
		upgradesSeen.push({
			url: req.url,
			host: authority,
			origin: req.headers.origin,
			cookie: req.headers.cookie,
			upgrade: req.headers.upgrade,
		});
		// cookieAuthority 非空 = 模拟"服务器按自己的 authority 命名 cookie"（对外入口把 Host 改写掉之后就是这样）。
		const nameAuthority = cookieAuthority === "" ? authority : cookieAuthority;
		const cookieName = `dsh-auth-${base64Url(createHash("sha256").update(nameAuthority).digest())}`;
		const authed = typeof req.headers.cookie === "string"
			&& req.headers.cookie.includes(`${cookieName}=${secretCookie}`);
		if (!authed) {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 9\r\n\r\nunauth'd\n");
			return;
		}
		const key = req.headers["sec-websocket-key"];
		const accept = createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
		const handshake = [
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n");
		handshakes.push(handshake);
		socket.write(handshake);
		socket.write(textFrame("pong"));
		socket.on("error", () => {});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		port,
		authority: `127.0.0.1:${port}`,
		indexHtml,
		requests,
		upgradesSeen,
		handshakes,
		api,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

//#endregion

//#region 客户端小工具

async function httpGet(url, headers = {}) {
	const response = await fetch(url, { redirect: "manual", headers });
	const body = await response.text();
	return { status: response.status, headers: response.headers, body };
}

/** 带 JSON body 的请求（设置页接口用）。 */
async function httpJson(url, options = {}) {
	const init = { redirect: "manual", ...options };
	if (init.body !== undefined && typeof init.body !== "string") {
		init.body = JSON.stringify(init.body);
		init.headers = { "content-type": "application/json", ...(init.headers ?? {}) };
	}
	const response = await fetch(url, init);
	const body = await response.text();
	let json = null;
	try {
		json = body.trim() === "" ? null : JSON.parse(body);
	} catch {
		json = null;
	}
	return { status: response.status, headers: response.headers, body, json };
}

/** 逐块记录到达时间的 GET，用来证明"没有被缓冲"。 */
function streamTimeline(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const chunks = [];
		const request = httpRequest(url, { method: "GET", headers }, (response) => {
			response.setEncoding("utf8");
			response.on("data", (chunk) => chunks.push({ at: Date.now() - started, chunk }));
			response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, chunks }));
		});
		request.on("error", reject);
		request.end();
	});
}

/**
 * 裸 TCP 升级探针。为什么不用 Node 自带的全局 WebSocket：
 * 实测（控制实验，见 device-switch 的 control-undici-websocket.mjs）这个 Node 24 版本里的
 * undici WebSocket 客户端对**同一个 stub 的握手**即使直连也会失败，并且它的失败路径还会用一个
 * 空消息 TypeError 盖掉真实原因；也就是说测的是那个客户端而不是本插件。裸 TCP 探针能逐字节核对
 * 101 与首帧是否被原样转发，证据反而更强。
 */
function rawUpgradeProbe({ port, path, key = randomBytes(16).toString("base64"), timeoutMs = 4000 }) {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port }, () => {
			socket.write([
				`GET ${path} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				"",
				"",
			].join("\r\n"));
		});
		let received = Buffer.alloc(0);
		let done = false;
		const finish = (error) => {
			if (done) return;
			done = true;
			socket.destroy();
			resolve({ key, received, error });
		};
		socket.on("data", (chunk) => {
			received = Buffer.concat([received, chunk]);
			if (received.includes(Buffer.from("pong"))) finish();
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => finish());
		setTimeout(() => finish(), timeoutMs);
	});
}

/** 不走真 socket 的一次请求（用来伪造 remoteAddress、body 之类真 socket 给不了的输入）。 */
function mockResponse() {
	const chunks = [];
	const state = { status: null, headers: {}, body: "", ended: false };
	const res = {
		headersSent: false,
		destroyed: false,
		writableEnded: false,
		writeHead(status, headers) {
			state.status = status;
			state.headers = headers ?? {};
			res.headersSent = true;
			return res;
		},
		write(chunk) {
			if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
			return true;
		},
		end(chunk) {
			if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
			res.headersSent = true;
			res.writableEnded = true;
			state.ended = true;
			state.body = Buffer.concat(chunks).toString("utf8");
		},
		destroy() {
			res.destroyed = true;
		},
		on() {
			return res;
		},
		once() {
			return res;
		},
		resume() {},
	};
	return { res, state };
}

function mockRequest({ method = "GET", url = "/", headers = {}, remoteAddress = "127.0.0.1", body = undefined }) {
	const emitter = new EventEmitter();
	const finalHeaders = { ...headers };
	if (body !== undefined && finalHeaders["content-length"] === undefined) finalHeaders["content-length"] = String(Buffer.byteLength(body));
	Object.assign(emitter, {
		method,
		url,
		headers: finalHeaders,
		socket: { remoteAddress },
		resume() {},
		destroy() {},
	});
	queueMicrotask(() => {
		if (body !== undefined) emitter.emit("data", Buffer.from(body));
		emitter.emit("end");
	});
	return emitter;
}

/** 直接调插件的路由处理器（不过 socket），用来精确控制 remoteAddress / body。 */
async function localExchange(router, options) {
	const req = mockRequest(options);
	const { res, state } = mockResponse();
	const pathname = new URL(options.url, "http://local.invalid").pathname;
	const route = router.match(pathname);
	if (route === undefined) return { status: 404, headers: {}, body: "no route" };
	await route.handler(req, res);
	return { status: state.status, headers: state.headers, body: state.body, state };
}

const checks = [];
/** 记录一条断言结果；不抛错，好让一轮跑完看到全部失败项。 */
function check(title, condition, detail = "") {
	checks.push({ title, ok: Boolean(condition) });
	log(`${condition ? "  PASS" : "  FAIL"}  ${title}${detail === "" ? "" : `  — ${detail}`}`);
}

/** 插件自己的响应一律不许是 text/html，且都要 nosniff（I1 的推广）。 */
function notHtml(label, exchange) {
	const type = String(exchange.headers["content-type"] ?? exchange.headers.get?.("content-type") ?? "");
	const body = exchange.body ?? "";
	const isJsonOrText = type.toLowerCase().startsWith("application/json") || type.toLowerCase().startsWith("text/plain");
	const nosniff = String(exchange.headers["x-content-type-options"] ?? exchange.headers.get?.("x-content-type-options") ?? "") === "nosniff";
	check(`I1 推广：${label} 不是 text/html（${type === "" ? "无 content-type" : type}）`, !internals.isHtmlContentType(type), type);
	check(`I1 推广：${label} 是 text/plain 或 application/json 且 nosniff`, isJsonOrText && nosniff, `${type} nosniff=${String(nosniff)}`);
	check(`I1 推广：${label} 响应体里没有 "<"`, !body.includes("<"), JSON.stringify(body.replace(/\s+/gu, " ").slice(0, 80)));
}

/**
 * 二进制响应（另存为下载）不能按文本判"没有 `<`"，所以单列一条：
 * 只看它**不是 HTML**、带 nosniff（成功时还必须是 application/octet-stream）。
 */
function notHtmlBinary(label, exchange) {
	const type = String(exchange.headers["content-type"] ?? exchange.headers.get?.("content-type") ?? "");
	const nosniff = String(exchange.headers["x-content-type-options"] ?? exchange.headers.get?.("x-content-type-options") ?? "") === "nosniff";
	check(`I1 推广：${label} 不是 text/html（${type === "" ? "无 content-type" : type}）`, !internals.isHtmlContentType(type), type);
	check(`I1 推广：${label} 带 nosniff`, nosniff, type);
}

/** 按**字节**取一次响应（另存为下载会回二进制，不能走 utf8 的 httpGet）。 */
function httpGetBuffer(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = httpRequest(url, { method: "GET", headers }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
		});
		request.on("error", reject);
		request.end();
	});
}

/** H 组用的"本机会话事件"样本（user/message 用 data.content，assistant/message 用 data.message.content）。 */
const LOCAL_RECORDS = [
	{ type: "event", event: { type: "user/message", seq: 40, time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我看看 notes/中文 文件.md" }] } } },
	{ type: "event", event: { type: "assistant/message", seq: 41, time: 2, data: { message: { content: [{ type: "text", text: "好的，先读一遍。" }, { type: "tool-call", name: "read" }] } } } },
	{ type: "event", event: { type: "assistant/message", seq: 42, time: 3, data: { message: { content: [{ type: "text", text: "读完了。" }] } } } },
];

/**
 * 在"假本机 DSH"上注册一对本机 Remote RPC 路由（`/api/session/projections` 与 `/api/session/page`）。
 * 这是「分叉到…」读**本机**源会话的 HTTP 回退路线（进程内 ctx.sessionController 不可用时走它）。
 * 信封校验照做：method 必须等于路径、payload 必须恰好一个 args 字段。
 */
function registerLocalSessionApi(router, options = {}) {
	const calls = { projections: [], pages: [] };
	const asOfSeq = options.asOfSeq === undefined ? 42 : options.asOfSeq;
	const records = options.records === undefined ? LOCAL_RECORDS : options.records;
	const make = (endpoint, build) => (req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			let envelope = null;
			try {
				envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				envelope = null;
			}
			// 形状照 descriptor 校验：`session/projections` 与 `session/page` 线路上的参数**只有一个**
			// `request` 字段（args 必须是 `{ request: {…} }`），形状不对就 400 —— 免得插件写错了也照样通过。
			const good = envelope !== null && envelope.type === "client-request" && envelope.method === endpoint
				&& envelope.payload !== null && typeof envelope.payload === "object"
				&& Object.keys(envelope.payload).length === 1 && typeof envelope.payload.args === "object"
				&& envelope.payload.args !== null && Object.keys(envelope.payload.args).length === 1
				&& typeof envelope.payload.args.request === "object" && envelope.payload.args.request !== null;
			if (!good) {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("bad client-request envelope\n");
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: build(envelope.payload.args.request) }));
		});
	};
	const disposers = [
		router.ctx.webServer.register({
			kind: "exact",
			path: "/api/session/projections",
			handler: make("session/projections", (args) => {
				calls.projections.push(args);
				return options.projectionsResult === undefined ? { ok: true, value: { asOfSeq, values: {} } } : options.projectionsResult;
			}),
		}),
		router.ctx.webServer.register({
			kind: "exact",
			path: "/api/session/page",
			handler: make("session/page", (args) => {
				calls.pages.push(args);
				return { ok: true, value: { records, hasMore: false } };
			}),
		}),
	];
	return {
		calls,
		dispose: () => {
			for (const dispose of disposers) dispose();
		},
	};
}

//#endregion

//#region 垫片沙箱（假 DOM / localStorage / location / 网络原语）

/** 极简 DOM：只实现垫片用到的那几个成员。 */
function createFakeDom() {
	const documentListeners = new Map();
	const createElement = (tag) => {
		const node = {
			tagName: String(tag).toUpperCase(),
			id: "",
			type: "",
			textContent: "",
			title: "",
			hidden: false,
			style: { cssText: "" },
			children: [],
			attributes: {},
			innerHTML: "",
			handlers: new Map(),
			setAttribute(name, value) { this.attributes[name] = String(value); },
			getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
			appendChild(child) {
				this.children.push(child);
				// 真 DOM 会把 parentNode 挂上（垫片的"摘掉自己画的胶囊"就靠它）。
				if (child !== null && typeof child === "object") child.parentNode = this;
				return child;
			},
			removeChild(child) {
				const at = this.children.indexOf(child);
				if (at === -1) throw new Error("removeChild: node is not a child of this node");
				this.children.splice(at, 1);
				if (child !== null && typeof child === "object") child.parentNode = null;
			},
			contains(other) { return other === this || this.children.some((child) => child.contains(other)); },
			addEventListener(type, handler) {
				const list = this.handlers.get(type) ?? [];
				list.push(handler);
				this.handlers.set(type, list);
			},
			dispatch(type, event) { for (const handler of this.handlers.get(type) ?? []) handler(event); },
			closest(selector) {
				if (/^button\[data-device-id\]$/u.test(selector) && this.tagName === "BUTTON" && this.getAttribute("data-device-id") !== null) return this;
				return null;
			},
		};
		return node;
	};
	const findById = (node, id) => {
		if (node === null || node === undefined) return null;
		if (node.id === id) return node;
		for (const child of node.children ?? []) {
			const hit = findById(child, id);
			if (hit !== null) return hit;
		}
		return null;
	};
	const body = createElement("body");
	const document = {
		readyState: "complete",
		// `body` 与 `getElementById` 都按**真浏览器**的形状给：垫片"一个 DOM 节点都不插"这条
		// 不变式要能直接断言 `body.children`（垫片历史上那几块 UI —— 右下角胶囊、兜底浮层、
		// 左上角按钮 —— 全都已整段删除）。
		body,
		documentElement: createElement("html"),
		baseURI: "http://127.0.0.1:19387/",
		createElement,
		getElementById: (id) => findById(body, id),
		addEventListener: (type, handler) => {
			const list = documentListeners.get(type) ?? [];
			list.push(handler);
			documentListeners.set(type, list);
		},
		dispatch(type, event) { for (const handler of documentListeners.get(type) ?? []) handler(event); },
	};
	return { document, body, findById: (id) => findById(body, id), findByIdIn: findById };
}

/**
 * 造一个可以跑垫片的 vm 沙箱：假 localStorage / sessionStorage / location / document 与假的
 * fetch / WebSocket / XMLHttpRequest（它们只把收到的 URL 记下来）。
 *
 * 垫片的**自检**（同步 patch 之后异步 GET 一次 `statePath`）也靠这里的假 fetch 喂：
 * `stateStatus=404` 模拟"插件已卸载"，`stateBody` 默认 `{enabled:true}`。
 */
function createShimSandbox({ current, devices, location, transport, baseURI, stateStatus = 200, stateBody = { enabled: true }, viewState } = {}) {
	const calls = { fetch: [], sockets: [], xhr: [], reloads: 0 };
	const storage = new Map();
	if (current !== undefined && current !== null) storage.set(internals.STORAGE_KEYS.current, current);
	if (devices !== undefined && devices !== null) storage.set(internals.STORAGE_KEYS.devices, JSON.stringify(devices));
	const localStorage = {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => { storage.set(key, String(value)); },
		removeItem: (key) => { storage.delete(key); },
	};
	const sessionStorage = {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => { storage.set(key, String(value)); },
		removeItem: (key) => { storage.delete(key); },
	};
	const originalFetch = function originalFetch(input, init) {
		const target = typeof input === "string" ? input : input.url;
		calls.fetch.push({ input, init, target });
		if (target === internals.STATE_PATH) {
			return Promise.resolve({
				ok: stateStatus < 400,
				status: stateStatus,
				url: target,
				json: () => Promise.resolve(stateBody),
			});
		}
		// 浏览器口（0.12.0 的可达性自愈探的就是它）：`viewState.peers` 可随时改（测"连续两次"）。
		if (viewState !== undefined && target === internals.VIEW_PATH) {
			const status = viewState.status === undefined ? 200 : viewState.status;
			if (status !== 200) {
				return Promise.resolve({ ok: false, status, url: target, json: () => Promise.resolve(null) });
			}
			return Promise.resolve({
				ok: true,
				status: 200,
				url: target,
				json: () => Promise.resolve({
					at: 1,
					self: { name: "本机", live: { running: 0, pending: 0, unread: false, doneAt: 0, at: 1 } },
					peers: Array.isArray(viewState.peers) ? viewState.peers : [],
					version: internals.VERSION,
				}),
			});
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			url: target,
		});
	};
	function OriginalWebSocket(url, protocols) {
		calls.sockets.push({ url, protocols });
		this.url = url;
		this.readyState = 1;
	}
	OriginalWebSocket.CONNECTING = 0;
	OriginalWebSocket.OPEN = 1;
	OriginalWebSocket.CLOSING = 2;
	OriginalWebSocket.CLOSED = 3;
	OriginalWebSocket.prototype.send = function send() {};
	OriginalWebSocket.prototype.close = function close() {};
	function OriginalXhr() {
		this.readyState = 0;
	}
	OriginalXhr.prototype.open = function open(method, url) {
		calls.xhr.push({ method, url });
	};
	const dom = createFakeDom();
	if (typeof baseURI === "string") dom.document.baseURI = baseURI;
	const targetLocation = location ?? {
		href: "http://127.0.0.1:19387/",
		host: "127.0.0.1:19387",
		hostname: "127.0.0.1",
		protocol: "http:",
		pathname: "/",
		reload() { calls.reloads += 1; },
	};
	// 自测传进来的 location 也一样能数刷新次数（可达性自愈要看"到底刷没刷"）。
	if (location !== undefined && location !== null && typeof location.reload === "function") {
		const inner = location.reload;
		location.reload = function patchedReload() {
			calls.reloads += 1;
			return inner.call(this);
		};
	}
	const sandbox = {
		console,
		URL,
		URLSearchParams,
		Request,
		Headers,
		AbortController,
		TextEncoder,
		location: targetLocation,
		localStorage,
		sessionStorage,
		document: dom.document,
		fetch: originalFetch,
		WebSocket: OriginalWebSocket,
		XMLHttpRequest: OriginalXhr,
	};
	if (transport !== undefined) sandbox.__DSH_TRANSPORT__ = transport;
	const context = createContext(sandbox);
	return {
		context,
		sandbox,
		calls,
		storage,
		dom,
		targetLocation,
		originalFetch,
		originalWebSocket: OriginalWebSocket,
		originalXhr: OriginalXhr,
	};
}

/** 跑一次垫片脚本（同一个 context 可以重复跑，用来验证幂等）。 */
function runShim(box, text) {
	runInContext(text, box.context);
}

/** 调一次沙箱里的 fetch，返回它**真正交给底层原始 fetch 的目标**。 */
function fetchTarget(box, input, init) {
	const before = box.calls.fetch.length;
	void box.sandbox.fetch(input, init);
	const record = box.calls.fetch[before];
	return typeof record.input === "string" ? record.input : record.input.url;
}

/**
 * 垫片历史上那颗「右下角设备切换胶囊」的 DOM id。**那段代码与这个常量在 0.12.0 已整段删除**
 * （宿主半不再导出它），所以这里是**测试本地的字面量**：专门用来盯"这些节点一个都不许出现"。
 */
const PILL_ELEMENT_ID = "dsh-remote-root";

/**
 * 「右下角设备切换胶囊」**整段删除**之后的契约：DOM 里不该有 shim 容器 / `-panel` / `-toggle`
 * 任何一个节点，body 下也不该多出任何该前缀的顶层节点（= 一点 UI 都不画）。
 * 删掉的只是**画 UI**：请求改写与 localStorage 键那两套照旧（各自由别的断言盯着）。
 */
function noShimUi(box) {
	const id = PILL_ELEMENT_ID;
	const topLevel = box.dom.body.children.filter((node) => typeof node.id === "string" && node.id.startsWith(id));
	return box.dom.findById(id) === null
		&& box.dom.findById(`${id}-panel`) === null
		&& box.dom.findById(`${id}-toggle`) === null
		&& topLevel.length === 0;
	// 注：**垫片一个可见 DOM 节点都不插**，所以"body 下什么都没有"另外由 K1 ④ 那条直接断言。
}

/**
 * 2026-10-17 那个致死缺陷补丁的自测夹具：给垫片沙箱装上**可控时钟**
 * （`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` / `Date.now`）。
 *
 * 为什么还要它：自愈的冷却标记写成 `{at: 0}`，而 `resetToLocal` 是拿 `Date.now()` 与它比 ——
 * 把 `Date.now()` 钉在虚拟的 0 上，"冷却窗口内不重复 reset"才是确定的（真实墙钟下这个用例必红）。
 * 0.12.0 起垫片在**非回环会话**里会登记一条 2 秒的可达性探测（`setInterval`），
 * 所以这里也提供 `setInterval` / `clearInterval`，并且 `advance()` 会按周期**重复**触发它。
 */
function withShimClock(box) {
	const handles = new Map();
	let next = 1;
	let now = 0;
	box.clock = {
		now: () => now,
		/** 推进虚拟时钟并**按到点顺序（同刻按登记顺序）**跑回调；周期定时器会自动续下一个到点。 */
		advance: async (ms) => {
			now += Number(ms) || 0;
			for (let guard = 0; guard < 500; guard += 1) {
				const due = [...handles.entries()].filter(([, entry]) => entry.at <= now).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (due === undefined) break;
				if (due[1].every > 0) due[1].at += due[1].every;
				else handles.delete(due[0]);
				due[1].fn();
				// 探测的回调里有 fetch → json() 两层 promise，多清几轮微任务再跑下一个到点。
				for (let round = 0; round < 6; round += 1) await Promise.resolve();
			}
		},
		pending: () => handles.size,
	};
	box.sandbox.setTimeout = (fn, ms) => {
		const handle = next;
		next += 1;
		handles.set(handle, { fn, at: now + (Number(ms) || 0), every: 0 });
		return handle;
	};
	box.sandbox.clearTimeout = (handle) => {
		handles.delete(handle);
	};
	box.sandbox.setInterval = (fn, ms) => {
		const handle = next;
		next += 1;
		const every = Number(ms) || 0;
		handles.set(handle, { fn, at: now + every, every });
		return handle;
	};
	box.sandbox.clearInterval = (handle) => {
		handles.delete(handle);
	};
	box.sandbox.Date = Object.assign(function FakeDate() {}, { now: () => now });
	return box;
}

/**
 * 把一次"活着的加载"配齐：起沙箱 → 跑垫片。
 *
 * **可控时钟仍然要给**：自愈里的冷却标记是 `{at: 0}`（`Date.now()` 与它比），钉住虚拟时钟
 * 才能确定地测"冷却窗口内不重复 reset"。0.12.0 起非回环会话里还会登记一条 2 秒探测，
 * 所以 `advance()` 在这里也是"让它探第 N 次"的手段（`location` / `viewState` 可透传）。
 */
function bootShimWithClock(options) {
	const box = withShimClock(createShimSandbox({
		current: options?.current,
		devices: options?.deviceSeed,
		location: options?.location,
		viewState: options?.viewState,
	}));
	runShim(box, internals.renderShimScript({
		devices: options?.devices ?? [{ id: "home", name: "设备B" }, { id: "office", name: "设备C" }],
		localName: "本机",
	}));
	box.slot = box.sandbox.__DSH_REMOTE_SHIM__;
	return box;
}

const SHIM_PAYLOAD = { devices: [{ id: "home", name: "设备B" }, { id: "company", name: "设备A" }], localName: "本机" };
const SHIM_TEXT = internals.renderShimScript(SHIM_PAYLOAD);

//#endregion

//#region 假的"本机 client bundle"（给 mux 路径的动态发现用）

/** 真源码里那一行（`@deepseek-ai/dsh-api-gateway/lib/client.js`）—— 逐字抄来当夹具。 */
const REAL_GATEWAY_LINE = "\t\tconst REMOTE_STREAM_MUX_PATH = \"/api/remote.mux\";";
const REAL_BUNDLE_FIXTURE = `// fixture: @deepseek-ai/dsh-api-gateway/lib/client.js（节选，逐字）\nfunction remoteStreamUrl() {\n${REAL_GATEWAY_LINE}\n\treturn REMOTE_STREAM_MUX_PATH;\n}\n`;

/**
 * 假的本机 HTTP：`/` 返回带 `plugins/??…` 的首页，`/plugins/…` 返回 bundle 文本。
 * 这就是"本机 client bundle"的替身（真实 DSH 用同一套 URL 形状与同样的一行常量）。
 */
async function startFakeLocalBundle({ withIndex = true, indexStatus = 200, bundle = REAL_BUNDLE_FIXTURE, bundleStatus = 200 } = {}) {
	const url = "/plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=abcdef123456";
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(req.url);
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		if (pathname === "/") {
			if (indexStatus !== 200) {
				res.writeHead(indexStatus, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh web authentication required\n");
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><html><head><link rel="preload" as="script" href="${url.slice(1)}"></head><body></body></html>`);
			return;
		}
		if (req.url === url) {
			if (bundleStatus !== 200) {
				res.writeHead(bundleStatus);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
			res.end(bundle);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: server.address().port, url, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

//#endregion

async function main() {
	log(`插件名: ${pluginName} / inject: ${JSON.stringify(inject)}`);
	log(`数据文件（本次临时目录）: ${workDir}`);

	// ------------------------------------------------------------------
	// T0 清单自洽：package.json 的声明与 lib/index.js 的常量不许漂移
	// ------------------------------------------------------------------
	section("T0 package.json：name/version/exports/dsh 声明与宿主半常量一致");
	const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
	check("package.json name 与 lib/index.js 的插件名一致",
		manifest.name === `@local/${pluginName}`, `${String(manifest.name)} / ${pluginName}`);
	check("internals.VERSION 与 package.json 的 version 一致（两处漂移会让体检页说谎）",
		internals.VERSION === manifest.version, `${internals.VERSION} vs ${String(manifest.version)}`);
	check("exports 含 \".\"、\"./client\"（指向 lib/client.js）与 \"./package.json\"",
		manifest.exports["."] === "./lib/index.js" && manifest.exports["./client"] === "./lib/client.js"
		&& manifest.exports["./package.json"] === "./package.json",
		JSON.stringify(manifest.exports));
	check("dsh 声明：bundle.patch 指向本包 patch、client.platform === \"web\"",
		manifest.dsh.bundle.patch === "./cordis.patch.yml" && manifest.dsh.client.platform === "web",
		JSON.stringify(manifest.dsh));
	check("type: module + main: lib/index.js（宿主半是 ESM 入口）",
		manifest.type === "module" && manifest.main === "lib/index.js");

	// ------------------------------------------------------------------
	// T1 数据文件一次性种子：坏条目跳过、其余保留、文件写出来且不含 token
	// ------------------------------------------------------------------
	section("T1 数据文件种子：坏条目被跳过、好条目写进 $DSH_HOME/remote-devices.json、token 不进 devices");
	const stub = await startStubRemote();
	const unreachable = await startStubRemote(); // 只用来拿一个立刻能关掉的端口
	const deadPort = unreachable.port;
	await unreachable.close();

	const dataFile = freshDataFile();
	const seedCredentials = {
		store: new Map(),
		setCalls: [],
		unsetCalls: [],
		async resolve(ref) {
			const value = this.store.get(ref);
			return value === undefined ? undefined : { value, source: "store" };
		},
		async set(ref, value) {
			this.setCalls.push([ref, value]);
			this.store.set(ref, value);
		},
		async unset(ref) {
			this.unsetCalls.push(ref);
			this.store.delete(ref);
		},
		async describe(ref) {
			return { configured: this.store.has(ref), writable: true };
		},
	};
	const router = createRouter({ credentials: seedCredentials });
	log(`  假远端 DSH 端口: ${stub.port}`);
	const seedConfig = {
		dataFile,
		devices: [
			{ id: "self", name: "假远端 <script>alert(1)</script>", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" },
			{ id: "ws", name: "假远端 WS", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" },
			{ id: "real", name: "本机 loopback", url: "http://127.0.0.1:19387" },
			{ id: "down", name: "连不上的台", url: `http://127.0.0.1:${deadPort}` },
			{ id: "bad id", name: "坏 id", url: "http://127.0.0.1:1" },
			{ id: "nourl", name: "缺 url" },
			{ id: "self", name: "重复 id", url: "http://127.0.0.1:1" },
		],
		current: "local",
	};
	apply(router.ctx, seedConfig, { muxPath: "/api/remote.mux" });
	await sleep(50); // 让种子 token 的落点判定与迁移跑完（SEED_TOKEN_SETTLE_MS=1000 之前先看内存）
	const host = await startFakeHost(router);
	log(`  本机服务(假 DSH) 端口: ${host.port}`);

	const seededFile = readJsonFile(dataFile);
	check("只注册 4 台合法设备（坏 id / 缺 url / 重复 id 被跳过）",
		router.devPrefixes().length === 4, router.devPrefixes().join(" | "));
	check("坏条目被跳过时都写了告警日志",
		router.logs.filter((line) => line.includes("跳过设备")).length >= 3,
		String(router.logs.filter((line) => line.includes("跳过设备")).length));
	check("数据文件被一次性写出来（$DSH_HOME/remote-devices.json 的替身）", seededFile.devices.length === 4,
		JSON.stringify(seededFile.devices.map((entry) => entry.id)));
	check("数据文件里只有 enabled/devices/current 三个键 + 没有 token 字段",
		Object.keys(seededFile).every((key) => ["enabled", "devices", "current"].includes(key))
		&& seededFile.tokens === undefined,
		Object.keys(seededFile).join(","));
	check("devices 条目只有 id/name/url 三个字段（token 绝不在数据文件里）",
		seededFile.devices.every((entry) => Object.keys(entry).every((key) => ["id", "name", "url"].includes(key))),
		JSON.stringify(seededFile.devices[0]));
	check("种子里的 token 走了凭据服务（每条设备一个 ref），没有明文落盘",
		seedCredentials.setCalls.length === 2
		&& seedCredentials.setCalls.every(([ref]) => ref.startsWith(internals.TOKEN_REF_PREFIX)),
		JSON.stringify(seedCredentials.setCalls.map(([ref]) => ref)));
	check("凭据 ref 名是 DSH_REMOTE_TOKEN_<sha256(authority) 前 16 位>（0.13.1：按 authority 存）",
		internals.tokenRefFor(`127.0.0.1:${String(stub.port)}`) === `${internals.TOKEN_REF_PREFIX}${createHash("sha256").update(`127.0.0.1:${String(stub.port)}`).digest("hex").slice(0, 16)}`,
		internals.tokenRefFor(`127.0.0.1:${String(stub.port)}`));
	check("原配置里的 local 字段不再进数据文件（本机只靠自验证 + current 兜底）",
		seededFile.devices.every((entry) => entry.local === undefined));

	// ------------------------------------------------------------------
	// T2 路由形状
	// ------------------------------------------------------------------
	section("T2 路由形状：prefix 不带尾斜杠、upgrade 是 exact 的 mux 路径");
	check("HTTP 前缀路由注册为 /dev/self（无尾斜杠）", router.prefixes.has("/dev/self"));
	check("upgrade 路由注册为 /dev/ws/api/remote.mux（mux 路径来自发现结果，不硬编码）",
		router.upgrades.has("/dev/ws/api/remote.mux"), [...router.upgrades.keys()].join(","));
	check("/dev/self/api/x 能匹配到 prefix 路由", router.match("/dev/self/api/x") === router.prefixes.get("/dev/self"));
	check("/dev/self 本身也匹配（用于补尾斜杠重定向）", router.match("/dev/self") === router.prefixes.get("/dev/self"));
	const trailingSlashMatcher = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);
	check("反例：prefix 写成 /dev/x/ 时 /dev/x/api/y 匹配不上（真实现规则）",
		trailingSlashMatcher("/dev/x/api/y", "/dev/x/") === false
		&& trailingSlashMatcher("/dev/x/api/y", "/dev/x") === true);
	check("设置页接口只占一条 prefix 路由，与 /dev/** 互不相干",
		router.prefixes.has(internals.PLUGIN_ROUTE) && router.devPrefixes().length === 4);

	// ------------------------------------------------------------------
	// A：I1
	// ------------------------------------------------------------------
	section("A（I1）上游返回 HTML 的 /dev/self/ → 绝不透传 text/html，改 404 纯文本 + 写日志");
	const indexAttempt = await httpGet(`http://127.0.0.1:${host.port}/dev/self/`);
	const indexType = String(indexAttempt.headers.get("content-type") ?? "");
	check("响应不是 text/html（I1）", !internals.isHtmlContentType(indexType), `status=${indexAttempt.status} type=${indexType}`);
	check("状态 404（按约定：这个响应不该进窗口）", indexAttempt.status === 404, `status=${indexAttempt.status}`);
	check("content-type 是 text/plain", indexType.toLowerCase().startsWith("text/plain"), indexType);
	check("响应体是纯文本：不含任何 HTML 文档/标签标记（doctype/html/head/body/base/script）",
		!/<!doctype|<html|<head|<body|<base|<script/iu.test(indexAttempt.body),
		JSON.stringify(indexAttempt.body.replace(/\s+/gu, " ").slice(0, 90)));
	check("最强形式：响应体里连一个 `<` 都没有（设备名里的 <script> 也被换成全角）",
		!indexAttempt.body.includes("<"),
		JSON.stringify(indexAttempt.body.replace(/\s+/gu, " ").slice(0, 120)));
	check("响应体不含远端首页的标记（REMOTE-INDEX-MARKER）", !indexAttempt.body.includes("REMOTE-INDEX-MARKER"));
	check("我们自己的响应体也不会被判定成 HTML（复用 I1 嗅探器自检）",
		internals.classifyBodyPrefix(Buffer.from(indexAttempt.body, "utf8")) === "no",
		internals.classifyBodyPrefix(Buffer.from(indexAttempt.body, "utf8")));
	check("日志里记录了 I1 拦截（含设备与请求路径）",
		router.logs.some((line) => line.includes("拦截 HTML 响应") && line.includes("self") && line.includes("/dev/self/")),
		router.logs.filter((line) => line.includes("拦截 HTML 响应")).at(-1) ?? "(无)");
	check("上游确实被请求过（是「拦下来的」，不是「没转发」）", stub.requests.some((request) => request.url === "/"));
	check("上游首页请求没有被强制 accept-encoding: identity（HTML 不再需要缓冲注入）",
		stub.requests.some((request) => request.url === "/" && request.acceptEncoding !== "identity"));

	section("A2（I1 第二道）content-type 撒谎成 JSON、响应体却是 HTML → 同样拦截；含**前置 120 字节空白**的变体（报告的绕过路径）");
	const sneaky = await httpGet(`http://127.0.0.1:${host.port}/dev/self/fake-html`);
	check("状态 404 且不是 text/html",
		sneaky.status === 404 && !internals.isHtmlContentType(String(sneaky.headers.get("content-type"))),
		`status=${sneaky.status} type=${sneaky.headers.get("content-type")}`);
	check("响应体不含 SNEAKY-HTML", !sneaky.body.includes("SNEAKY-HTML"));
	check("日志里记录了「响应体开头看起来是 HTML」",
		router.logs.some((line) => line.includes("拦截 HTML 响应") && line.includes("看起来是 HTML")));
	const emptyBody = await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/empty`);
	check("**空响应体**照样放行（附件上传那类 POST 成功后就是空体；这里被拦就会让上传失败）",
		emptyBody.status === 200 && emptyBody.body === "", `status=${emptyBody.status} body=${JSON.stringify(emptyBody.body.slice(0, 40))}`);

	section("A3（0.11.1 跨机附件搬运）消息里的**本机**路径 → 自动搬到对面并改写");
	// 0.11.1 起桥接**默认关闭**：用例先放标记文件打开它（跑完删掉）
	const bridgeMarker = join(dirname(dataFile), "dsh-remote-bridge.enabled");
	writeFileSync(bridgeMarker, "on", "utf8");
	const bridgeDir = mkdtempSync(join(workDir, "bridge-"));
	const bridgeFile = join(bridgeDir, "报告 草稿.md");
	writeFileSync(bridgeFile, "BRIDGE-CONTENT-1234", "utf8");
	const promptBody = {
		method: "session/prompt",
		payload: {
			args: {
				request: {
					requestId: "req-bridge-1",
					sessionId: "sess-bridge",
					mode: "queue",
					// 桌面端对带空格的路径会加引号（formatFileMention）：这里按真实写法测
					content: [{ type: "text", text: `看这个 @${'"'}${bridgeFile}${'"'} 谢谢` }],
				},
			},
		},
	};
	await httpJson(`http://127.0.0.1:${host.port}/dev/self/api/session/prompt`, { method: "POST", body: promptBody });
	await new Promise((resolve) => setTimeout(resolve, 80));
	const upload = stub.api.uploads.at(-1);
	check("搬运：本机文件字节原样投到对面的 /api/session/uploadFileBinary（octet-stream + sessionId + 带会话 cookie）",
		process.platform === "win32" && upload !== undefined
		&& upload.sessionId === "sess-bridge"
		&& upload.contentType === "application/octet-stream"
		&& upload.authed === true
		&& upload.bytes.toString("utf8") === "BRIDGE-CONTENT-1234",
		upload === undefined
			? "(对面没收到上传)"
			: `sessionId=${String(upload.sessionId)} type=${String(upload.contentType)} authed=${String(upload.authed)} bytes=${String(upload.bytes.length)}`);
	check("搬运：日志记下「本机路径 → 附件 <名字>（…，sha256:…）」",
		process.platform !== "win32" || router.logs.some((line) => line.includes("跨机搬运") && line.includes("sha256:deadbeef")),
		router.logs.filter((line) => line.includes("跨机搬运")).at(-1) ?? "(没有搬运日志)");
	check("搬运：**不再**追加内容段（0.11.2 起纯文本改写；追加 file 段会被网关 boundary 校验拒掉、把消息发废）",
		router.logs.every((line) => !line.includes("已挂")),
		router.logs.filter((line) => line.includes("跨机搬运")).at(-1) ?? "(没有搬运日志)");
	check("搬运：改写完成并报了字节数（说明重序列化后的体是正常的）",
		process.platform !== "win32" || router.logs.some((line) => line.includes("改写完成") && /[0-9]+ 字节/u.test(line)),
		router.logs.filter((line) => line.includes("改写完成")).at(-1) ?? "(没有改写日志)");
	check("搬运：对面确实收到了这次 prompt（转发没被桥接打断）",
		stub.requests.some((request) => request.method === "POST" && request.url === "/api/session/prompt"),
		JSON.stringify(stub.requests.map((request) => request.url).slice(-4)));
	// 默认关闭的行为：拿掉标记文件后，同样的请求必须**一个字都不改**
	rmSync(bridgeMarker, { force: true });
	const uploadsBefore = stub.api.uploads.length;
	await httpJson(`http://127.0.0.1:${host.port}/dev/self/api/session/prompt`, { method: "POST", body: promptBody });
	await new Promise((resolve) => setTimeout(resolve, 60));
	check("默认关闭：没有标记文件时桥接完全不动作（不上传、不报错、请求照常转发）",
		stub.api.uploads.length === uploadsBefore
		&& stub.requests.filter((request) => request.url === "/api/session/prompt").length === 2,


		`uploads=${String(stub.api.uploads.length)} prompt 次数=${String(stub.requests.filter((request) => request.url === "/api/session/prompt").length)}`);

	// 回归（0.11.10）：正文里的**裸路径**（前面没有 @）绝不搬运、绝不改写
	writeFileSync(bridgeMarker, "on", "utf8");
	const BS = String.fromCharCode(92);
	const barePath = ["C:", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"].join(BS);
	const uploadsBeforeBare = stub.api.uploads.length;
	const bareBody = {
		method: "session/prompt",
		payload: { args: { request: { requestId: "req-bare-1", sessionId: "sess-bridge", mode: "queue",
			content: [{ type: "text", text: `解释一下这个路径 ${barePath} 是干嘛的` }] } } },
	};
	await httpJson(`http://127.0.0.1:${host.port}/dev/self/api/session/prompt`, { method: "POST", body: bareBody });
	await new Promise((resolve) => setTimeout(resolve, 60));
	check("正文里的裸路径不搬运、不改写（只有 @ 文件提及才算附件）",
		stub.api.uploads.length === uploadsBeforeBare,
		`uploads=${String(stub.api.uploads.length)}`);
	rmSync(bridgeMarker, { force: true });

	// ------------------------------------------------------------------
	// B：API 透传 + token/jar
	// ------------------------------------------------------------------
	section("B /dev/self/api/whatever → 远端 /api/whatever 正常透传 200/JSON（Host/Origin 已改写）");
	const api = await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/whatever`);
	check("状态 200 且 JSON 里 seenHost 等于远端 authority",
		api.status === 200 && api.body.includes(stub.authority), `status=${api.status} body=${api.body.slice(0, 120)}`);
	check("content-type 是 JSON（未改写）", String(api.headers.get("content-type")).startsWith("application/json"));
	check("远端看到的是 /api/whatever（前缀已剥掉）", stub.requests.some((request) => request.url === "/api/whatever"));
	const apiRecord = stub.requests.find((request) => request.url === "/api/whatever");
	check("远端看到的 Host/Origin 已改写成它自己的 authority（E：Host/Origin 改写保留）",
		apiRecord?.host === stub.authority && apiRecord?.origin === `http://${stub.authority}`,
		`host=${apiRecord?.host} origin=${apiRecord?.origin}`);

	section("B2 token 兑换：宿主侧自己完成一次 GET /?token=，之后所有请求带会话 cookie");
	const exchange = stub.requests.find((request) => typeof request.url === "string" && request.url.includes("token=stub-token"));
	check("发生过一次 GET /?token=stub-token 的服务端兑换", exchange !== undefined,
		exchange === undefined ? "" : `host=${exchange.host} origin=${exchange.origin}`);
	check("兑换请求的 Host/Origin 已改写成远端 authority",
		exchange !== undefined && exchange.host === stub.authority && exchange.origin === `http://${stub.authority}`,
		exchange === undefined ? "" : `host=${exchange.host} origin=${exchange.origin}`);
	const withCookie = stub.requests.filter((request) => request.url === "/api/whatever" && typeof request.cookie === "string").at(-1);
	check("本次 API 请求带上了 dsh-auth-<远端 authority 派生名> 会话 cookie（jar 先生效）",
		withCookie !== undefined && withCookie.cookie === `${internals.cookieNameFor(stub.authority)}=stub-session-value`,
		withCookie?.cookie ?? "(none)");
	const exchangesBefore = stub.requests.filter((request) => typeof request.url === "string" && request.url.includes("token=")).length;
	const apiAgain = await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/again`);
	const exchangesAfter = stub.requests.filter((request) => typeof request.url === "string" && request.url.includes("token=")).length;
	check("第二次 API 请求仍 200（jar 持续生效）", apiAgain.status === 200, `status=${apiAgain.status}`);
	check("第二次没有再兑换 token（jar 命中就不重复打远端）", exchangesAfter === exchangesBefore,
		`${String(exchangesBefore)} → ${String(exchangesAfter)}`);

	section("E1 cookie 隔离：本机 authority 派生名绝不被发到远端");
	const localCookieName = internals.cookieNameFor("127.0.0.1:19387");
	const deviceCookieName = internals.cookieNameFor(stub.authority);
	check("两个派生名不同", localCookieName !== deviceCookieName,
		`local=${localCookieName.slice(0, 24)}… device=${deviceCookieName.slice(0, 24)}…`);
	await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/isolated`, {
		cookie: `${localCookieName}=LOCAL-SECRET; ${deviceCookieName}=client-value; other=1`,
	});
	const isolated = stub.requests.find((request) => request.url === "/api/isolated");
	check("远端只收到设备派生名（且优先用宿主 jar），没有本机 cookie、没有 other",
		isolated !== undefined && isolated.cookie === `${deviceCookieName}=stub-session-value`,
		isolated?.cookie ?? "(none)");
	check("curl 式检查：本机 cookie 值 LOCAL-SECRET 未出现在任何上游请求里",
		!stub.requests.some((request) => typeof request.cookie === "string" && request.cookie.includes("LOCAL-SECRET")));

	section("E2 流式：首块先到，不是攒完再发（且不被 I1 误伤）");
	const timeline = await streamTimeline(`http://127.0.0.1:${host.port}/dev/self/stream`);
	const times = timeline.chunks.map((entry) => entry.at);
	check("收到 3 块", timeline.chunks.length === 3, JSON.stringify(times));
	check("首块到达时间 << 末块（首块 ≈0ms，末块 ≈240ms）",
		times.length === 3 && times[0] < 120 && times[2] >= 200,
		`首块 ${String(times[0])}ms / 末块 ${String(times[2])}ms`);
	check("content-type 未被改写", String(timeline.headers["content-type"]).startsWith("text/event-stream"));

	section("E3 真实本机 DSH（http://127.0.0.1:19387）：无 token 时必须是 401，而不是 404/500");
	const realApi = await httpGet(`http://127.0.0.1:${host.port}/dev/real/api/whatever`);
	check("真实本机 /dev/real/api/whatever → 401", process.platform !== "win32" || realApi.status === 401, `status=${realApi.status}`);
	check("401 响应来自 DSH 的浏览器认证（说明真的转发到了本机 Host，而不是插件自己的错误页）",
		process.platform !== "win32" || /unauthorized|dsh web authentication required/u.test(realApi.body)
		&& !realApi.body.includes("dsh-remote"), realApi.body.trim().slice(0, 80));

	section("E4 设备不可达 → 502 纯文本中文说明（不再是 HTML 错误页），且本机服务不受影响");
	const down = await httpGet(`http://127.0.0.1:${host.port}/dev/down/api/x`);
	check("状态 502", down.status === 502, `status=${down.status}`);
	check("响应是 text/plain（本插件不产生 HTML —— I1 的延伸）",
		String(down.headers.get("content-type")).toLowerCase().startsWith("text/plain"),
		String(down.headers.get("content-type")));
	check("说明里含设备名/地址/原因",
		down.body.includes("连不上的台") && down.body.includes(`127.0.0.1:${deadPort}`) && down.body.includes("原因："),
		down.body.replace(/\s+/gu, " ").slice(0, 120));
	check("说明里不含 HTML 标签", !/<!doctype|<html|<base|<script/iu.test(down.body));
	check("说明里写清了「不会产生 HTML」这件事", down.body.includes("不产生 HTML"));
	check("随后本机服务仍能正常应答", (await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/after-down`)).status === 200);

	section("E5 /dev/<id> 无尾斜杠 → 302 补斜杠");
	const slash = await httpGet(`http://127.0.0.1:${host.port}/dev/self`);
	check("302 且 Location=/dev/self/", slash.status === 302 && slash.headers.get("location") === "/dev/self/",
		`status=${slash.status} location=${slash.headers.get("location")}`);

	section("E6 WebSocket 升级转发：101 与首帧逐字节透传 + 头改写 + 路径剥前缀");
	const upgrade = await rawUpgradeProbe({ port: host.port, path: "/dev/ws/api/remote.mux" });
	const raw = upgrade.received.toString("latin1");
	const expectedAccept = createHash("sha1").update(`${upgrade.key}${WEB_SOCKET_GUID}`).digest("base64");
	check("客户端收到 101 Switching Protocols", raw.startsWith("HTTP/1.1 101 Switching Protocols\r\n"), JSON.stringify(raw.slice(0, 60)));
	check("Sec-WebSocket-Accept 与客户端自己的 key 匹配（key/accept 配对没被打乱）",
		raw.includes(`Sec-WebSocket-Accept: ${expectedAccept}`), expectedAccept);
	check("远端 101 头被逐字节透传（与 stub 写出的字节完全一致）",
		raw.startsWith(stub.handshakes.at(-1) ?? "###"), JSON.stringify((stub.handshakes.at(-1) ?? "").slice(0, 60)));
	check("收到远端的首帧 'pong'（帧透传）",
		upgrade.received.includes(Buffer.concat([Buffer.from([0x81, 0x04]), Buffer.from("pong")])));
	const upgradeSeen = stub.upgradesSeen.at(-1);
	check("远端收到的请求行是 /api/remote.mux（/dev/ws 前缀已剥掉）", upgradeSeen?.url === "/api/remote.mux", upgradeSeen?.url);
	check("远端收到的 Host/Origin 已改写成它自己的 authority",
		upgradeSeen?.host === stub.authority && upgradeSeen?.origin === `http://${stub.authority}`,
		`host=${upgradeSeen?.host} origin=${upgradeSeen?.origin}`);
	check("远端收到的 Cookie 是设备派生的会话名（升级路径也走 jar/兑换）",
		typeof upgradeSeen?.cookie === "string" && upgradeSeen.cookie.startsWith(internals.cookieNameFor(stub.authority)),
		upgradeSeen?.cookie ?? "(none)");
	check("未改写 Upgrade/Connection 语义（远端看到 upgrade: websocket）", upgradeSeen?.upgrade === "websocket", upgradeSeen?.upgrade);
	// 2026-10-17 第二刀：这台设备在上面 E4 里刚被判过不可达 ⇒ 升级请求走**快失败**那条路
	//（账本新鲜时**不发上游连接**，直接优雅 destroy：一个字节都不回）。
	// 这里先用插件自己的连通性测试接口把账本**确定地**刷成"刚判过不可达"，用例才不依赖
	// "E4 到现在还没过 4 秒"这种时间巧合。
	const downProbe = await httpJson(`http://127.0.0.1:${host.port}${internals.PLUGIN_ROUTE}/test/down`, { method: "POST", body: {} });
	check("连通性测试接口确认这台连不上（账本里 reachable=false 且新鲜）",
		downProbe.status === 200 && downProbe.json.ok === false, JSON.stringify(downProbe.json));
	const upgradeDown = await rawUpgradeProbe({ port: host.port, path: "/dev/down/api/remote.mux" });
	check("刚判过不可达的设备：升级请求被**优雅关闭**（一个字节都不回 —— 既没把连接挂死，也不是 HTML）",
		upgradeDown.received.length === 0,
		JSON.stringify(upgradeDown.received.toString("latin1").slice(0, 60)));

	// ------------------------------------------------------------------
	// E6b（0.13.2）：升级路径的 401 —— **丢掉会话 → 重兑 → 重连一次 → 最终 101 透传**
	//
	// 两段响应都来自同一台上游：第一次 upgrade 不管带什么都回 401 响应头（模拟对端重启把会话丢了），
	// 插件应当 forgetSession + ensureSession（拿到**新** cookie）后自己重连一次；
	// 第二次只认最新那次兑换的 cookie ⇒ 101。客户端最终看到的应当只有 101（401 不外泄）。
	// ------------------------------------------------------------------
	{
		section("E6b WebSocket 升级的 401：丢掉会话 → 重兑 → 重连一次 → 最终 101 透传");
		let wsExchanges = 0;
		/** 每次升级带上来的 Cookie（按连接顺序）。 */
		const wsUpgradeCookies = [];
		/** 升级后的上游 socket：用例结束时必须显式销毁，否则 server.close() 会一直等它。 */
		const wsSockets = [];
		const wsCookieName = (authority) => `dsh-auth-${base64Url(createHash("sha256").update(authority).digest())}`;
		const wsRemote = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://ws.invalid");
			const name = wsCookieName(req.headers.host ?? "");
			if (url.pathname === "/" && url.searchParams.get("token") === "ws-token") {
				wsExchanges += 1;
				res.writeHead(303, {
					location: "./",
					"set-cookie": `${name}=ws-session-${String(wsExchanges)}; Max-Age=315360000; Path=/; HttpOnly`,
				});
				res.end();
				return;
			}
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
		});
		wsRemote.on("upgrade", (req, socket) => {
			wsSockets.push(socket);
			const name = wsCookieName(req.headers.host ?? "");
			const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
			wsUpgradeCookies.push(cookie);
			const latest = `${name}=ws-session-${String(wsExchanges)}`;
			const authed = cookie.split(";").map((part) => part.trim()).includes(latest);
			// 第一段响应：永远 401（401 只是响应头，升级本身没成）。
			if (wsUpgradeCookies.length === 1 || authed !== true) {
				socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 9\r\n\r\nunauth'd\n");
				return;
			}
			// 第二段响应：101（只发给带**新** cookie 的那一次重连）。
			const key = req.headers["sec-websocket-key"];
			const accept = createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
			socket.write([
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				"",
				"",
			].join("\r\n"));
			socket.write(textFrame("pong"));
			socket.on("error", () => {});
		});
		await new Promise((resolve) => wsRemote.listen(0, "127.0.0.1", resolve));
		const wsAuthority = `127.0.0.1:${String(wsRemote.address().port)}`;
		const wsCreds = {
			store: new Map(),
			async resolve(ref) { const value = this.store.get(ref); return value === undefined ? undefined : { value, source: "store" }; },
			async set(ref, value) { this.store.set(ref, value); },
			async unset(ref) { this.store.delete(ref); },
			async describe(ref) { return { configured: this.store.has(ref), writable: true }; },
		};
		const wsRouter = createRouter({ credentials: wsCreds });
		apply(wsRouter.ctx, {
			dataFile: freshDataFile(),
			devices: [{ id: "ws401", name: "WS 401", url: `http://${wsAuthority}`, token: "ws-token" }],
		}, { muxPath: "/api/remote.mux" });
		const wsHost = await startFakeHost(wsRouter);
		const wsProbe = await rawUpgradeProbe({ port: wsHost.port, path: "/dev/ws401/api/remote.mux" });
		const wsRaw = wsProbe.received.toString("latin1");
		const wsExpectedAccept = createHash("sha1").update(`${wsProbe.key}${WEB_SOCKET_GUID}`).digest("base64");

		check("上游一共被连接两次（第一次 401 之后确实重连了一次）",
			wsUpgradeCookies.length === 2, `upgrades=${String(wsUpgradeCookies.length)}`);
		check("第一次升级带的是第一次兑换的会话 cookie",
			wsUpgradeCookies[0] === `${wsCookieName(wsAuthority)}=ws-session-1`,
			wsUpgradeCookies[0] === undefined ? "(none)" : wsUpgradeCookies[0]);
		check("第一次 401 后丢掉旧会话、用 token **重兑了一次**（新会话号 = 2）",
			wsExchanges === 2, `exchanges=${String(wsExchanges)}`);
		check("重连带上了**新的** cookie（与第一次不同）",
			wsUpgradeCookies[1] === `${wsCookieName(wsAuthority)}=ws-session-2`
			&& wsUpgradeCookies[1] !== wsUpgradeCookies[0],
			wsUpgradeCookies[1] === undefined ? "(none)" : wsUpgradeCookies[1]);
		check("客户端只看到最终的 101 Switching Protocols（401 没有外泄）",
			wsRaw.startsWith("HTTP/1.1 101 Switching Protocols\r\n") && !wsRaw.startsWith("HTTP/1.1 401"),
			JSON.stringify(wsRaw.slice(0, 60)));
		check("101 的 Sec-WebSocket-Accept 仍是客户端自己的 key 算出来的（配对没被打乱）",
			wsRaw.includes(`Sec-WebSocket-Accept: ${wsExpectedAccept}`), wsExpectedAccept);
		check("101 之后帧照常透传（收到 pong）",
			wsProbe.received.includes(Buffer.concat([Buffer.from([0x81, 0x04]), Buffer.from("pong")])));
		// 升级后的 socket 不会自己结束：显式销毁，否则两个 server.close() 都会挂住。
		for (const wsSocket of wsSockets) {
			try {
				wsSocket.destroy();
			} catch {
				/* 已经关了 */
			}
		}
		await wsHost.close();
		await new Promise((resolve) => wsRemote.close(resolve));
	}

	// ------------------------------------------------------------------
	// PT（2026-10-17 第二刀）：代理的"快失败"与"只覆盖建连阶段"的超时
	//
	// 治的是用户实测的"切到关机设备后白屏 15 秒"：页面第一个请求就是 `/dev/<id>/api/…`，
	// 而对端关机时 Windows 的 TCP 建连要 15–21 秒才失败 ⇒ 壳一直不渲染。两条：
	//  ① 账本里**刚判过不可达**（距今 < REACH_FRESH_MS）⇒ 一条上游连接都不发，直接 502
	//     （upgrade 直接优雅 destroy），并顺手探一次这台设备；
	//  ② 上游请求加一个**只覆盖建连阶段**的超时（缺省 3 秒）：socket 建好就清掉 ——
	//     绝不能变成整请求超时（慢响应 / 长传输必须照常）。
	// 这里给 `proxyConnectTimeoutMs` / `reachFreshMs` 两个 deps 钩子把窗口缩小，跑得快且不靠巧合。
	// ------------------------------------------------------------------
	section("PT 代理快失败 + 只覆盖建连阶段的超时（治「切到关机设备白屏 15 秒」）");

	check("常量：建连超时缺省 3000ms；新鲜度窗口 = LIVE_POLL_MS 的 2 倍（≈4 秒）",
		internals.PROXY_CONNECT_TIMEOUT_MS === 3000
		&& internals.REACH_FRESH_MS === internals.LIVE_POLL_MS * 2
		&& internals.REACH_FRESH_MS === 4000,
		`connect=${String(internals.PROXY_CONNECT_TIMEOUT_MS)} fresh=${String(internals.REACH_FRESH_MS)} poll=${String(internals.LIVE_POLL_MS)}`);

	/** 占一个空闲端口再放掉（用来制造"一开始没人听，后来有人听"的同一个地址）。 */
	const freePort = async () => {
		const server = createServer(() => {});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		await new Promise((resolve) => server.close(resolve));
		return port;
	};
	/** 一台会计数的上游（任何路径都回 200 JSON）：如果代理真的发了上游连接，这里就能看见。 */
	const startCountingUpstream = async (port) => {
		const requests = [];
		const server = createServer((req, res) => {
			requests.push({ method: req.method, url: req.url });
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: true }));
		});
		await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
		return { requests, close: () => new Promise((resolve) => server.close(resolve)) };
	};
	/**
	 * 只接受 TCP、**一个字节都不回**的哑上游（TLS 握手会一直挂着 ⇒ 测"建连挂起"）。
	 * **必须是裸 net server**：用 node:http 的 createServer 会把 TLS ClientHello 当坏请求
	 * 直接回 400/断开，那样测到的就不是"握手挂起"而是"立刻失败"。
	 */
	const startSilentTcp = async () => {
		const sockets = [];
		const server = netCreateServer((socket) => {
			socket.on("error", () => { /* 对端主动断开不算错 */ });
			sockets.push(socket);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		return {
			port: server.address().port,
			sockets,
			close: () => new Promise((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(resolve);
			}),
		};
	};
	/** 连上之后**故意慢慢回**的上游（用来证明建连定时器已经清掉、不是整请求超时）。 */
	const startSlowUpstream = async (delayMs) => {
		const server = createServer((req, res) => {
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.write('{"slow":');
			setTimeout(() => { res.end("true}"); }, delayMs);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
	};

	const flakyPort = await freePort();
	const stalePort = await freePort();
	const slowUpstream = await startSlowUpstream(1000);
	const silentTcp = await startSilentTcp();
	const ptRouter = createRouter();
	apply(ptRouter.ctx, {
		dataFile: freshDataFile(),
		current: "local",
		devices: [
			{ id: "flaky", name: "先关后开的台", url: `http://127.0.0.1:${flakyPort}` },
			{ id: "stale", name: "结论过期的台", url: `http://127.0.0.1:${stalePort}` },
			{ id: "slow", name: "慢响应台", url: `http://127.0.0.1:${slowUpstream.port}` },
			{ id: "silent", name: "握手不回的台", url: `https://127.0.0.1:${silentTcp.port}` },
		],
		// 两个窗口都缩到"够快但留足余量"：2000ms 新鲜度让"标记落账 → 起计数上游 → 再发一次请求"
		// 这段（毫秒级）绝不会因为慢机器漂出窗口；500ms 建连超时对面 1000ms 才回，余量 500ms。
	}, { muxPath: "/api/remote.mux", proxyConnectTimeoutMs: 500, reachFreshMs: 2000 });
	const ptHost = await startFakeHost(ptRouter);
	const ptBase = `http://127.0.0.1:${ptHost.port}`;
	/** 读设置页的 state 接口，等到账本把某台设备记成可达（最长等 1 秒）。 */
	const waitReachable = async (id) => {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const snapshot = await httpJson(`${ptBase}${internals.PLUGIN_ROUTE}/state`);
			const entry = (snapshot.json?.devices ?? []).find((device) => device.id === id);
			if (entry?.reachable === true) return true;
			await sleep(25);
		}
		return false;
	};

	// ① 账本里**没有**结论 ⇒ 照常去连（真的连不上 ⇒ 502，同时把这台记进账本）。
	const flakyFirst = await httpGet(`${ptBase}/dev/flaky/api/x`);
	check("账本里还没有结论 ⇒ 照常发起上游连接（连不上就 502，并把结论记进账本）",
		flakyFirst.status === 502, `status=${String(flakyFirst.status)}`);
	// 这台"活"过来了（同一个端口上起一台会计数的上游）。
	const flakyUpstream = await startCountingUpstream(flakyPort);
	// ② 账本**刚判过不可达**（200ms 窗口内）⇒ 一条上游连接都不发，直接 502 纯文本。
	const fastFail = await httpGet(`${ptBase}/dev/flaky/api/x`);
	await sleep(150); // 等"顺手探一次"那次探测落地
	check("账本刚判过不可达 ⇒ **不发**这次请求的上游连接（对面收不到 /api/x），直接回 502",
		fastFail.status === 502 && flakyUpstream.requests.every((request) => request.url !== "/api/x"),
		`status=${String(fastFail.status)} 上游收到=${JSON.stringify(flakyUpstream.requests.map((request) => `${String(request.method)} ${String(request.url)}`))}`);
	check("502 是纯文本中文说明（I1：不吐 HTML），且写明「不可达」",
		String(fastFail.headers.get("content-type")).toLowerCase().startsWith("text/plain")
		&& fastFail.body.includes("不可达") && !fastFail.body.includes("<"),
		fastFail.body.replace(/\s+/gu, " ").slice(0, 100));
	check("快失败顺手探了一次这台设备（对面收到探测的 `GET /`）—— 它一恢复马上可用",
		flakyUpstream.requests.some((request) => request.method === "GET" && request.url === "/"),
		JSON.stringify(flakyUpstream.requests.map((request) => `${String(request.method)} ${String(request.url)}`)));
	check("探测已经把账本刷成可达（state 接口读得到）", await waitReachable("flaky"));
	const flakyAfter = await httpGet(`${ptBase}/dev/flaky/api/x`);
	check("账本刷新之后紧接着的请求**照常转发**（快失败不会把恢复了的设备继续拦着）",
		flakyAfter.status === 200
		&& flakyUpstream.requests.filter((request) => request.url === "/api/x").length === 1,
		`status=${String(flakyAfter.status)} /api/x 次数=${String(flakyUpstream.requests.filter((request) => request.url === "/api/x").length)}`);

	// ③ 账本结论**过期**（超过新鲜度窗口）⇒ 照常去连（绝不拿着过期结论拦路）。
	const staleFirst = await httpGet(`${ptBase}/dev/stale/api/x`);
	check("另一台先真连一次（连不上 ⇒ 502，账本记下 不可达）", staleFirst.status === 502, `status=${String(staleFirst.status)}`);
	const staleUpstream = await startCountingUpstream(stalePort);
	await sleep(2200); // > reachFreshMs（2000ms）
	const staleSecond = await httpGet(`${ptBase}/dev/stale/api/x`);
	check("账本结论已过期 ⇒ 照常发起上游连接（对面收到 /api/x，拿到 200）",
		staleSecond.status === 200 && staleUpstream.requests.some((request) => request.url === "/api/x"),
		`status=${String(staleSecond.status)} 上游收到=${JSON.stringify(staleUpstream.requests.map((request) => String(request.url)))}`);

	// ④ **只覆盖建连阶段**：连上之后 1000ms 才回的上游，用 500ms 的建连超时也照样正常返回。
	//    （如果那个定时器是"整请求超时"，这一条必红。）
	const slowStarted = Date.now();
	const slow = await httpGet(`${ptBase}/dev/slow/api/x`);
	const slowMs = Date.now() - slowStarted;
	check("连上之后的慢响应不受建连超时影响（500ms 建连超时 vs 对面 1000ms 才回 ⇒ 仍然 200）",
		slow.status === 200 && slow.body.includes('"slow":true') && slowMs >= 950,
		`status=${String(slow.status)} 耗时=${String(slowMs)}ms body=${JSON.stringify(slow.body.slice(0, 40))}`);

	// ⑤ upgrade 那条路的建连超时：TCP 连上了但 TLS 握手不回 ⇒ 到点回 HTTP 502（不是挂死）。
	// 502 里的中文说明是 UTF-8 字节（`rejectUpgrade` 按 utf8 写），所以这里按 utf8 解。
	const silentUpgrade = await rawUpgradeProbe({ port: ptHost.port, path: "/dev/silent/api/remote.mux", timeoutMs: 4000 });
	const silentUpgradeText = silentUpgrade.received.toString("utf8");
	check("升级请求的建连阶段挂起（TCP 连上、TLS 握手不回）⇒ 到点收到 HTTP 502 纯文本（不是把连接挂死）",
		silentUpgradeText.startsWith("HTTP/1.1 502 Bad Gateway")
		// 认准"建连超时"那句：要真的是那条定时器到点了，而不是别的错误路径碰巧也回了 502。
		&& silentUpgradeText.includes("建连超时")
		&& silentUpgradeText.includes("text/plain"),
		JSON.stringify(silentUpgradeText.slice(0, 120)));

	// ⑥ **缺省**那个 3 秒（不缩小窗口）：TCP 连上但 TLS 握手不回 ⇒ 约 3 秒就 502（不是原来的 15 秒）。
	const realSilent = await startSilentTcp();
	const realRouter = createRouter();
	apply(realRouter.ctx, {
		dataFile: freshDataFile(),
		current: "local",
		devices: [{ id: "tls", name: "不回握手的台", url: `https://127.0.0.1:${realSilent.port}` }],
	}, { muxPath: "/api/remote.mux" });
	const realHost = await startFakeHost(realRouter);
	const realStarted = Date.now();
	const realTimeout = await httpGet(`http://127.0.0.1:${realHost.port}/dev/tls/api/x`);
	const realMs = Date.now() - realStarted;
	check("缺省（3 秒）真的生效：建连挂起 ⇒ 约 3 秒就 502（不是 CONNECT_TIMEOUT_MS 的 15 秒）",
		realTimeout.status === 502 && realMs >= 2900 && realMs < 8000
		&& realTimeout.body.includes("建连超时"),
		`status=${String(realTimeout.status)} 耗时=${String(realMs)}ms body=${JSON.stringify(realTimeout.body.replace(/\s+/gu, " ").slice(0, 80))}`);
	check("超时后账本记成不可达（下一次同机请求才有资格快失败）",
		await (async () => {
			const snapshot = await httpJson(`http://127.0.0.1:${realHost.port}${internals.PLUGIN_ROUTE}/state`);
			const entry = (snapshot.json?.devices ?? []).find((device) => device.id === "tls");
			return entry?.reachable === false;
		})());

	await realHost.close();
	void realSilent.close();
	await ptHost.close();
	void flakyUpstream.close();
	void staleUpstream.close();
	void slowUpstream.close();
	void silentTcp.close();

	// ------------------------------------------------------------------
	// C：I2
	// ------------------------------------------------------------------
	section("C（I2）注入通道：只追加一条 script 行，不含 <base / __DSH_TRANSPORT__ / index 改写");
	const LOCAL_INDEX = "<!doctype html><html lang=\"en\"><head><title>local</title>"
		+ "<script type=\"module\" crossorigin src=\"./assets/index-5SrrfWpU.js\"></script></head>"
		+ "<body><div id=\"root\"></div></body></html>";
	const table = [];
	router.emit("webserver/index-inject", table);
	check("index-inject 表里正好一条 script 行（桌面壳走的就是这条路）",
		table.length === 1 && table[0].kind === "script" && table[0].placement === "head",
		JSON.stringify(table.map((row) => `${row.kind}/${row.placement}`)));
	const injectedText = typeof table[0]?.text === "string" ? table[0].text : "";
	check("注入文本带唯一标记（幂等靠它）", injectedText.startsWith(internals.SHIM_MARKER));
	check("注入文本是自包含 IIFE（不引外部资源：无 http(s):// 引用、无 <link/script src>）",
		injectedText.includes("(function remoteShim(") && !/https?:\/\//u.test(injectedText)
		&& !/<link|<script/iu.test(injectedText));
	// 0.12.0：胶囊那段死代码（`mount()` / `ELEMENT_ID` / `removePill()` / `escapeHtml` / 面板 DOM /
	// 「设备：」文案）**整段删除**了 —— 所以这里改成**反向断言**：这些字面量一个都不许再出现在注入文本里。
	// 覆盖没有降低：这正是"垫片不挂任何可见 UI"在**源码层面**的等价（更强的）口径。
	check("注入文本里**没有**任何胶囊/面板死代码（mount / ELEMENT_ID / removePill / escapeHtml / 「设备：」/ data-device-id）",
		!injectedText.includes("function mount") && !injectedText.includes("dsh-remote-root")
		&& !injectedText.includes("removePill") && !injectedText.includes("function escapeHtml")
		&& !injectedText.includes("\"设备：\"") && !injectedText.includes("data-device-id")
		&& !injectedText.includes("dsh-remote-root-panel") && !injectedText.includes("dsh-remote-root-toggle"),
		`mount=${String(injectedText.includes("function mount"))} root=${String(injectedText.includes("dsh-remote-root"))} removePill=${String(injectedText.includes("removePill"))} escapeHtml=${String(injectedText.includes("function escapeHtml"))} 设备：=${String(injectedText.includes("\"设备：\""))} data-device-id=${String(injectedText.includes("data-device-id"))}`);
	check("注入文本含三处垫片（fetch / WebSocket / XMLHttpRequest）",
		injectedText.includes("patchedFetch") && injectedText.includes("PatchedWebSocket") && injectedText.includes("patchedOpen"));
	check("注入文本读的是约定好的 localStorage 键（主键 + 别名都读都写）",
		injectedText.includes(internals.STORAGE_KEYS.current) && injectedText.includes(internals.STORAGE_KEYS.devices)
		&& injectedText.includes(internals.STORAGE_KEYS.currentAlias) && injectedText.includes(internals.STORAGE_KEYS.devicesAlias));
	check("注入文本含垫片报到（POST hello，fire-and-forget）",
		injectedText.includes(internals.HELLO_PATH) && injectedText.includes("reportHello")
		&& injectedText.includes('credentials: "same-origin"'));
	check("注入文本含垫片**自检**（问 /state：诚实取 JSON + same-origin + no-store）",
		injectedText.includes(internals.STATE_PATH) && injectedText.includes("checkHostState")
		&& injectedText.includes('cache: "no-store"') && injectedText.includes("response.json"));
	check("自检只认 `enabled === false`（严格比较，不认 falsy / 缺字段）与 HTTP 404（插件已卸载）",
		injectedText.includes("state.enabled === false") && injectedText.includes("state.enabled === true")
		&& injectedText.includes("status === 404"));
	check("自检的自除按下述顺序：清键 → 停可达性探测 → 撤设备表 → 还原原语 → 带哨兵刷新",
		(() => {
			const body = injectedText.slice(injectedText.indexOf("function softOff"));
			const order = ["clearStoredSelection", "healStop", "retractDeviceTable", "restorePrimitives", "reloadOnce"]
				.map((name) => body.indexOf(`${name}()`));
			return order.every((at) => at >= 0) && order.every((at, index) => index === 0 || order[index - 1] < at);
		})(), injectedText.slice(injectedText.indexOf("function softOff"), injectedText.indexOf("function softOff") + 260).replace(/\s+/gu, " "));
	check("清键确有四个键（主键 + 别名：current/devices 都清）",
		injectedText.includes("clearStoredSelection") && injectedText.includes("writeAll(KEYS_CURRENT, \"\")")
		&& injectedText.includes("writeAll(KEYS_DEVICES, \"\")"));
	check("哨兵：用 sessionStorage + 固定键名，且 `reloadOnce` 里先查哨兵再写",
		injectedText.includes("root.sessionStorage") && injectedText.includes(internals.SHIM_SELFTEST_SENTINEL_KEY)
		&& /function reloadOnce\(\)\s*\{\s*if \(readSentinel\(\) !== ""\) return false;\s*writeSentinel\("1"\);/.test(injectedText));
	check("`enabled:true` 时清掉哨兵（否则关停一次之后就再也刷不动了）",
		/state\.enabled === true[\s\S]{0,120}writeSentinel\(""\)/.test(injectedText));
	check("注入文本含「强制激活」标记键（与客户端半同一个键名，走 sessionStorage）",
		injectedText.includes(internals.SHIM_FORCE_ACTIVE_KEY) && injectedText.includes("root.sessionStorage")
		&& injectedText.includes("readForceActive") && injectedText.includes("writeForceActive")
		&& injectedText.includes("forceActiveKey"));
	// 跨半契约：两个键名必须**逐字**一致，而且客户端半的顺序是"清哨兵 → 置标记 → 刷新"。
	// （本 bug 的根因就是这两半对不上：哨兵没清、垫片同步阶段惰性返回、错过挂载时机。）
	const CLIENT_SOURCE_TEXT = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
	check("客户端半：键名与宿主半逐字一致，且顺序是「清哨兵 → 置 force-active → reloadPage」",
		CLIENT_SOURCE_TEXT.includes(`"${internals.SHIM_SELFTEST_SENTINEL_KEY}"`)
		&& CLIENT_SOURCE_TEXT.includes(`"${internals.SHIM_FORCE_ACTIVE_KEY}"`)
		&& CLIENT_SOURCE_TEXT.includes("globalThis.sessionStorage")
		&& (() => {
			const clearAt = CLIENT_SOURCE_TEXT.indexOf("clearSessionFlag(SOFT_SWITCH_SENTINEL_KEY)");
			const setAt = CLIENT_SOURCE_TEXT.indexOf("writeSessionFlag(FORCE_ACTIVE_KEY,");
			const reloadAt = CLIENT_SOURCE_TEXT.indexOf("reloadPage()", setAt);
			return clearAt >= 0 && setAt > clearAt && reloadAt > setAt;
		})(),
		`clearAt=${String(CLIENT_SOURCE_TEXT.indexOf("clearSessionFlag(SOFT_SWITCH_SENTINEL_KEY)"))} setAt=${String(CLIENT_SOURCE_TEXT.indexOf("writeSessionFlag(FORCE_ACTIVE_KEY,"))} reloadAt=${String(CLIENT_SOURCE_TEXT.indexOf("reloadPage()", CLIENT_SOURCE_TEXT.indexOf("writeSessionFlag(FORCE_ACTIVE_KEY,")))}`);
	check("同步判定：force-active 存在 → 走正常模式（忽略 payload.enabled 与哨兵），用掉即删",
		injectedText.includes('var lazy = forcedActive !== true && (hostEnabled !== true || readSentinel() !== "")')
		&& injectedText.includes("if (lazy === true) {")
		&& injectedText.includes("if (forcedActive === true) writeForceActive(false);")
		&& (() => {
			// 顺序：先读标记 → 再惰性判定 → 再"用掉即删" → 最后才是 patch/挂胶囊那条路。
			const order = ["var forcedActive = readForceActive();", "if (lazy === true) {",
				"if (forcedActive === true) writeForceActive(false);", "var selected = normalizeId(readFirst(KEYS_CURRENT));"]
				.map((needle) => injectedText.indexOf(needle));
			return order.every((at) => at >= 0) && order.every((at, index) => index === 0 || order[index - 1] < at);
		})(),
		injectedText.slice(injectedText.indexOf("var forcedActive = readForceActive();"), injectedText.indexOf("var forcedActive = readForceActive();") + 420).replace(/\s+/gu, " "));
	check("惰性自愈：写 force-active → 清哨兵 → reloadOnce（顺序不许换），写不进标记就绝不刷新",
		(() => {
			const body = injectedText.slice(injectedText.indexOf("function healLazy"));
			if (body === "") return false;
			const order = ["writeForceActive(true)", 'writeSentinel("")', "reloadOnce()"].map((needle) => body.indexOf(needle));
			return order.every((at) => at >= 0) && order.every((at, index) => index === 0 || order[index - 1] < at)
				&& /if \(!writeForceActive\(true\)\) return false;/.test(body);
		})(),
		injectedText.slice(injectedText.indexOf("function healLazy"), injectedText.indexOf("function healLazy") + 260).replace(/\s+/gu, " "));
	check("惰性自愈只在「本次惰性」时触发（live enabled:true + lazy）",
		/state\.enabled === true[\s\S]{0,200}if \(lazy === true\) healLazy\(\);/.test(injectedText));
	check("还原原语靠 __dshRemoteOriginal（fetch / WebSocket / XHR.open 三处都留了）",
		(injectedText.match(/__dshRemoteOriginal/g) ?? []).length >= 4,
		String((injectedText.match(/__dshRemoteOriginal/g) ?? []).length));

	const tapped = router.taps.reduce((html2, transform) => transform(html2), LOCAL_INDEX);
	check("tapIndex 之后本机首页含垫片", tapped.includes(internals.SHIM_MARKER));
	check("注入的是 <script> 行且内容与 index-inject 行完全一致",
		tapped.includes(`<script>${injectedText}</script>`));
	// 注入是纯追加：把注入的 <script>…</script> 整段删掉，剩下的必须与原 HTML 逐字节相同。
	const injectedMarkup = `<script>${injectedText}</script>`;
	check("注入是**纯追加**：把注入内容删掉后与原 HTML 逐字节相同",
		tapped.includes(injectedMarkup) && tapped.replace(injectedMarkup, "") === LOCAL_INDEX,
		`len ${String(LOCAL_INDEX.length)} → ${String(tapped.length)}`);
	check("本机页面既有内容一律没动（<title>/<div id=\"root\">/既有 module 脚本仍在）",
		tapped.includes("<title>local</title>") && tapped.includes("<div id=\"root\"></div>")
		&& tapped.includes("index-5SrrfWpU.js"));
	check("注入通道不含 <base（I2：0.1.0 的 <base> 注入已删除）", !/<base/iu.test(tapped));
	check("注入通道不覆盖 __DSH_TRANSPORT__（0.1.0 的覆盖已删除；垫片只读它的 streamBaseUrl）",
		!/__DSH_TRANSPORT__\s*=/u.test(injectedText) && !injectedText.includes("defineProperty")
		&& injectedText.includes("root.__DSH_TRANSPORT__"),
		`赋值出现=${String(/__DSH_TRANSPORT__\s*=/u.test(injectedText))}`);
	check("注入通道不含 __DSH_BOOT_READY__ / 远端 HTML 改写器（insertAfterHead 之外没有别的变换）",
		!tapped.includes("__DSH_BOOT_READY__") && !injectedText.includes("__DSH_BOOT_READY__"));
	check("本机首页没有被塞进远端 HTML（远端 index 标记不出现）",
		!tapped.includes("REMOTE-INDEX-MARKER") && !tapped.includes("remote dsh"));
	// 端到端闭环：把**真实注入的那条文本**（不是测试自造 payload）拿去沙箱里跑。
	const realBox = createShimSandbox({ current: "self" });
	runShim(realBox, injectedText);
	check("真实注入文本在沙箱里可用：选中 self 后 fetch(\"api/sessions\") → \"/dev/self/api/sessions\"",
		fetchTarget(realBox, "api/sessions") === "/dev/self/api/sessions", fetchTarget(realBox, "api/sessions"));
	check("真实注入文本**一点 UI 都不画**（右下角胶囊整段停用：容器 / 面板 / 胶囊都没有）",
		noShimUi(realBox),
		`container=${String(realBox.dom.findById(PILL_ELEMENT_ID) !== null)} panel=${String(realBox.dom.findById(`${PILL_ELEMENT_ID}-panel`) !== null)}`);
	check("真实注入文本里的设备表照旧来自宿主数据文件（4 台设备 + 本机，只是不再画出来）",
		["self", "ws", "real", "down"].every((id) => injectedText.includes(`"id":"${id}"`))
		&& injectedText.includes('"localName"')
		// `inlineJson` 把 `<` 转成 `\u003c`（防 `</script>` 提前闭合）；危险设备名照旧在 payload 里。
		&& injectedText.includes("\\u003cscript>alert(1)\\u003c/script>"),
		/"devices":\[[^\]]{0,120}/u.exec(injectedText)?.[0] ?? "(无)");
	const realSockets = realBox.calls.sockets.length;
	void new realBox.sandbox.WebSocket("ws://127.0.0.1:19387/api/remote.mux");
	check("真实注入文本同样改写 WebSocket（路径改到 /dev/self/，host:port 不变）",
		realBox.calls.sockets.length === realSockets + 1
		&& realBox.calls.sockets.at(-1)?.url === "ws://127.0.0.1:19387/dev/self/api/remote.mux",
		String(realBox.calls.sockets.at(-1)?.url));

	// ------------------------------------------------------------------
	// D：垫片单测
	// ------------------------------------------------------------------
	section("D1 未选中设备：垫片完全不 patch（fetch/WebSocket/XHR 保持原函数），也不挂任何 UI（胶囊已停用）");
	const idleBox = createShimSandbox({ transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" } });
	runShim(idleBox, SHIM_TEXT);
	check("未选中时不包装 fetch（同一个函数引用）", idleBox.sandbox.fetch === idleBox.originalFetch);
	check("未选中时不包装 WebSocket", idleBox.sandbox.WebSocket === idleBox.originalWebSocket);
	check("未选中时不包装 XMLHttpRequest.open",
		idleBox.sandbox.XMLHttpRequest.prototype.open === idleBox.originalXhr.prototype.open);
	check("未选中时 fetch 原样透传（不做任何改写）", fetchTarget(idleBox, "api/sessions") === "api/sessions");
	check("未选中时也不挂任何可见 UI（垫片不画 UI；切设备入口在侧栏那一行 + 浮层）", noShimUi(idleBox));
	const idleToggle = idleBox.dom.findById(`${PILL_ELEMENT_ID}-toggle`);
	check("历史胶囊的节点**根本不存在**（死代码已删，连落点都没有）", idleToggle === null, String(idleToggle));
	const idlePanel = idleBox.dom.findById(`${PILL_ELEMENT_ID}-panel`);
	check("面板节点也不存在（死代码已删：不建面板、不渲染设备表）", idlePanel === null, String(idlePanel));
	check("垫片加载后报到了（调用了一次未包装的 fetch POST /plugin/remote/hello）",
		idleBox.calls.fetch.some((call) => call.input === internals.HELLO_PATH && call.init?.method === "POST"),
		JSON.stringify(idleBox.calls.fetch.map((call) => call.input)));

	section("D2 选中 home：fetch/WebSocket/XHR 的 URL 改写到 /dev/home/…");
	const box = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }, { id: "company", name: "设备A" }],
		transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" },
	});
	runShim(box, SHIM_TEXT);
	check("选中时 fetch 被包装", box.sandbox.fetch !== box.originalFetch);
	check('fetch("api/sessions") → "/dev/home/api/sessions"',
		fetchTarget(box, "api/sessions") === "/dev/home/api/sessions", fetchTarget(box, "api/sessions"));
	check('fetch("/api/x") → "/dev/home/api/x"', fetchTarget(box, "/api/x") === "/dev/home/api/x", fetchTarget(box, "/api/x"));
	check('fetch("./api/x") → "/dev/home/api/x"', fetchTarget(box, "./api/x") === "/dev/home/api/x", fetchTarget(box, "./api/x"));
	check('fetch("http://127.0.0.1:19387/api/y") → 绝对形式 http://127.0.0.1:19387/dev/home/api/y（scheme/host:port 不变）',
		fetchTarget(box, "http://127.0.0.1:19387/api/y") === "http://127.0.0.1:19387/dev/home/api/y",
		fetchTarget(box, "http://127.0.0.1:19387/api/y"));
	check('fetch("/other") 原样（只改 api 路径）', fetchTarget(box, "/other") === "/other", fetchTarget(box, "/other"));
	check('fetch("http://example.com/api/z") 原样（不同源不改写）',
		fetchTarget(box, "http://example.com/api/z") === "http://example.com/api/z", fetchTarget(box, "http://example.com/api/z"));
	check("URL 对象入参也被改写（绝对形式）",
		fetchTarget(box, new URL("/api/u", "http://127.0.0.1:19387/")) === "http://127.0.0.1:19387/dev/home/api/u",
		fetchTarget(box, new URL("/api/u", "http://127.0.0.1:19387/")));
	const requestIn = new Request("http://127.0.0.1:19387/api/r", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{\"a\":1}",
	});
	const requestTargetSeen = fetchTarget(box, requestIn);
	const requestRecord = box.calls.fetch.at(-1).input;
	check("Request 对象入参：URL 被改写且 method/headers/body 保留",
		requestTargetSeen === "http://127.0.0.1:19387/dev/home/api/r"
		&& typeof requestRecord !== "string" && requestRecord.method === "POST"
		&& requestRecord.headers.get("content-type") === "application/json"
		&& requestRecord.url === "http://127.0.0.1:19387/dev/home/api/r",
		`${requestTargetSeen} ${typeof requestRecord === "string" ? requestRecord : requestRecord.method}`);
	void new box.sandbox.WebSocket("ws://127.0.0.1:19387/api/remote.mux");
	check('new WebSocket("ws://127.0.0.1:19387/api/remote.mux") → ws://127.0.0.1:19387/dev/home/api/remote.mux',
		box.calls.sockets.at(-1)?.url === "ws://127.0.0.1:19387/dev/home/api/remote.mux",
		String(box.calls.sockets.at(-1)?.url));
	check("WebSocket 常量仍然在位（CONNECTING..CLOSED）且 prototype 未被换掉",
		box.sandbox.WebSocket.CONNECTING === 0 && box.sandbox.WebSocket.OPEN === 1
		&& box.sandbox.WebSocket.CLOSED === 3
		&& box.sandbox.WebSocket.prototype === box.originalWebSocket.prototype);
	void new box.sandbox.WebSocket("ws://127.0.0.1:19387/api/remote.mux");
	check("原始 WebSocket 构造函数确实被调用（不是被吞掉）", box.calls.sockets.length >= 2, String(box.calls.sockets.length));
	check("WebSocket 相对路径入参也被改写",
		(() => {
			void new box.sandbox.WebSocket("/api/remote.mux");
			return box.calls.sockets.at(-1)?.url === "/dev/home/api/remote.mux";
		})(), String(box.calls.sockets.at(-1)?.url));
	const xhr = new box.sandbox.XMLHttpRequest();
	xhr.open("GET", "api/sessions");
	check('XMLHttpRequest.open("GET","api/sessions") → "/dev/home/api/sessions"',
		box.calls.xhr.at(-1)?.url === "/dev/home/api/sessions", String(box.calls.xhr.at(-1)?.url));
	const xhr2 = new box.sandbox.XMLHttpRequest();
	xhr2.open("POST", "/api/z", true, "u", "p");
	check("XMLHttpRequest.open 保留后面的 async/user/password 参数",
		box.calls.xhr.at(-1)?.url === "/dev/home/api/z" && box.calls.xhr.at(-1)?.method === "POST",
		`${String(box.calls.xhr.at(-1)?.method)} ${String(box.calls.xhr.at(-1)?.url)}`);
	check("选中设备时也不挂任何可见 UI，但改写照样按 selected 走（不画 UI ≠ 不切设备）",
		box.dom.findById(`${PILL_ELEMENT_ID}-toggle`) === null
		&& fetchTarget(box, "api/sessions") === "/dev/home/api/sessions",
		`toggle=${String(box.dom.findById(`${PILL_ELEMENT_ID}-toggle`))} target=${fetchTarget(box, "api/sessions")}`);
	check("选中设备时面板节点同样不存在（死代码已删：不建面板、没有 data-current 可看）",
		box.dom.findById(`${PILL_ELEMENT_ID}-panel`) === null && noShimUi(box));

	section("D3 幂等：同一份脚本执行两次不叠加包装");
	const fetchAfterFirst = box.sandbox.fetch;
	const socketAfterFirst = box.sandbox.WebSocket;
	const openAfterFirst = box.sandbox.XMLHttpRequest.prototype.open;
	const callsBefore = box.calls.fetch.length;
	runShim(box, SHIM_TEXT);
	check("二次执行后 fetch 仍是同一个包装函数", box.sandbox.fetch === fetchAfterFirst);
	check("二次执行后 WebSocket 仍是同一个包装函数", box.sandbox.WebSocket === socketAfterFirst);
	check("二次执行后 XMLHttpRequest.prototype.open 仍是同一个包装函数",
		box.sandbox.XMLHttpRequest.prototype.open === openAfterFirst);
	const twiceTarget = fetchTarget(box, "api/sessions");
	check("二次执行后改写结果不叠加（不会变成 /dev/home/dev/home/…）", twiceTarget === "/dev/home/api/sessions", twiceTarget);
	check("一次调用只落到原始 fetch 一次", box.calls.fetch.length === callsBefore + 1,
		`${String(callsBefore)} → ${String(box.calls.fetch.length)}`);
	check("胶囊没被挂出来（DOM id 幂等：两次执行后 shim 节点数仍为 0）",
		box.dom.body.children.filter((node) => node.id === PILL_ELEMENT_ID).length === 0 && noShimUi(box));

	section("D4 桌面形态：文档是 dsh-app://app/，流地址是本机 origin");
	const desktopReloads = { count: 0 };
	const desktopBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		location: {
			href: "dsh-app://app/",
			host: "app",
			hostname: "app",
			protocol: "dsh-app:",
			pathname: "/",
			reload() { desktopReloads.count += 1; },
		},
		transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" },
		baseURI: "dsh-app://app/",
	});
	runShim(desktopBox, SHIM_TEXT);
	check('桌面：fetch("api/sessions") → "/dev/home/api/sessions"（相对路径解析到 dsh-app://app/）',
		fetchTarget(desktopBox, "api/sessions") === "/dev/home/api/sessions", fetchTarget(desktopBox, "api/sessions"));
	check("桌面：fetch('/api/x') → '/dev/home/api/x'", fetchTarget(desktopBox, "/api/x") === "/dev/home/api/x", fetchTarget(desktopBox, "/api/x"));
	check("桌面：流 WebSocket 被改写（host 来自 __DSH_TRANSPORT__.streamBaseUrl）",
		(() => {
			void new desktopBox.sandbox.WebSocket("ws://127.0.0.1:19387/api/remote.mux");
			return desktopBox.calls.sockets.at(-1)?.url === "ws://127.0.0.1:19387/dev/home/api/remote.mux";
		})(), String(desktopBox.calls.sockets.at(-1)?.url));
	check("桌面：非本机 host 的 ws 不改写",
		(() => {
			void new desktopBox.sandbox.WebSocket("ws://198.51.100.9:19387/api/remote.mux");
			return desktopBox.calls.sockets.at(-1)?.url === "ws://198.51.100.9:19387/api/remote.mux";
		})(), String(desktopBox.calls.sockets.at(-1)?.url));
	check("桌面：垫片只『读』__DSH_TRANSPORT__，不覆盖它",
		desktopBox.sandbox.__DSH_TRANSPORT__?.streamBaseUrl === "http://127.0.0.1:19387"
		&& desktopBox.sandbox.__DSH_TRANSPORT__.ownsHost === true);

	section("D5 切换动作：胶囊 UI 停用 ⇒ 不再有可点的设备项（切设备入口交给侧栏那一行 + 浮层）");
	const switchBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }, { id: "company", name: "<script>alert(1)</script>" }],
	});
	const switchText = internals.renderShimScript({
		devices: [{ id: "home", name: "设备B" }, { id: "company", name: "<script>alert(1)</script>" }],
		localName: "本机",
	});
	runShim(switchBox, switchText);
	const switchPanel = switchBox.dom.findById(`${PILL_ELEMENT_ID}-panel`);
	check("胶囊那段代码**已整段删除**（注入文本里既没有 mount / escapeHtml，也没有「设备：」文案与 data-device-id）",
		switchPanel === null && !switchText.includes("function mount") && !switchText.includes("function escapeHtml")
		&& !switchText.includes("\"设备：\"") && !switchText.includes("data-device-id")
		&& !switchText.includes("dsh-remote-root"),
		`panel=${String(switchPanel)} mount=${String(switchText.includes("function mount"))} escapeHtml=${String(switchText.includes("function escapeHtml"))} root=${String(switchText.includes("dsh-remote-root"))}`);
	check("危险设备名没有被原样写进 DOM（面板整段停用 ⇒ 连落点都没有）",
		noShimUi(switchBox) && !String(switchBox.dom.body.innerHTML ?? "").includes("<script>alert(1)"),
		`shimUi=${String(!noShimUi(switchBox))}`);
	check("停用后垫片不再改写 localStorage 的 current（还是打开页面时那个 home）",
		switchBox.storage.get(internals.STORAGE_KEYS.current) === "home",
		String(switchBox.storage.get(internals.STORAGE_KEYS.current)));
	check("别名键也不会被凭空写上（垫片只在自除清键时才动它）",
		switchBox.storage.has(internals.STORAGE_KEYS.currentAlias) === false,
		String(switchBox.storage.get(internals.STORAGE_KEYS.currentAlias)));
	check("停用后不会自己刷新页面", switchBox.calls.reloads === 0, String(switchBox.calls.reloads));
	const idlePanelBox = createShimSandbox({ current: "home", devices: [{ id: "home", name: "设备B" }] });
	runShim(idlePanelBox, SHIM_TEXT);
	check("停用后连「点面板里的本机项」这条路径都不存在了（没有面板可点、键不变、也不 reload）",
		idlePanelBox.dom.findById(`${PILL_ELEMENT_ID}-panel`) === null
		&& idlePanelBox.calls.reloads === 0
		&& idlePanelBox.storage.get(internals.STORAGE_KEYS.current) === "home",
		`has=${String(idlePanelBox.storage.has(internals.STORAGE_KEYS.current))} reloads=${String(idlePanelBox.calls.reloads)}`);

	section("D6 垫片只在 localStorage 说明有设备时才动网络；devices 键可覆盖内置缺省");
	const localBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "覆盖后的名字" }],
		transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" },
	});
	runShim(localBox, SHIM_TEXT);
	check("devices 键照旧被读到（读到也不画了）：改写不受影响、UI 一个都不挂",
		fetchTarget(localBox, "api/sessions") === "/dev/home/api/sessions" && noShimUi(localBox),
		fetchTarget(localBox, "api/sessions"));
	check("选中的 id 不在列表里时（ghost）**照旧**改写到 /dev/ghost/（只是不再出现在任何面板里）",
		(() => {
			const strayBox = createShimSandbox({ current: "ghost" });
			runShim(strayBox, SHIM_TEXT);
			return fetchTarget(strayBox, "api/sessions") === "/dev/ghost/api/sessions" && noShimUi(strayBox);
		})());

	// ------------------------------------------------------------------
	// C2 / C3：去重与空配置
	// ------------------------------------------------------------------
	section("C2 两条注入通道同时存在时只注入一份；重复收集不推第二行");
	const twiceTapped = router.taps.reduce((html2, transform) => transform(html2),
		`<html><head>${`<script>${injectedText}</script>`}</head><body></body></html>`);
	check("两路同时存在时仍然只注入一份（marker 幂等）",
		twiceTapped.split(internals.SHIM_MARKER).length - 1 === 1,
		String(twiceTapped.split(internals.SHIM_MARKER).length - 1));
	const tableAgain = [];
	router.emit("webserver/index-inject", tableAgain);
	check("重复收集时不会推入第二行", tableAgain.length === 1);

	section("C3 空配置：除一条惰性垫片与自己那条设置页路由外完全惰性");
	const idleRouter = createRouter();
	const idleFile = freshDataFile();
	apply(idleRouter.ctx, { dataFile: idleFile }, { muxPath: "/api/remote.mux" });
	check("没有注册任何 /dev/** 路由", idleRouter.devPrefixes().length === 0 && idleRouter.upgrades.size === 0);
	// 跨机实时状态这一刀多注册了**一条**跨机取数口 `/dsh-remote-live`、0.12.0 又加了一条浏览器口
	// `/dsh-remote-view`（两条都**故意不带 /plugin/ 前缀**，否则会被对端 edge 的
	// EDGE_BLOCKED_PREFIXES=["/plugin/"] 403 掉；见宿主半「跨机实时状态」region）。
	// 所以这里断言"正好这三条、且就是这三条"，仍然挡住任何乱注册。
	check("只注册了设置页 + 跨机取数口 + 浏览器口那三条 prefix 路由",
		idleRouter.prefixes.size === 3
		&& idleRouter.prefixes.has(internals.PLUGIN_ROUTE)
		&& idleRouter.prefixes.has(internals.PEER_LIVE_ROOT)
		&& idleRouter.prefixes.has(internals.VIEW_PATH),
		[...idleRouter.prefixes.keys()].join(","));
	check("没有种子数据时不会凭空创建数据文件（不写 $DSH_HOME）", existsSync(idleFile) === false, idleFile);
	check("仍然注入垫片（无设备时它在页面上不 patch、不加 UI）",
		idleRouter.taps.length === 1 && idleRouter.effects.some((effect) => effect.label.includes("lifetime")));
	const emptyBox = createShimSandbox({});
	runShim(emptyBox, internals.renderShimScript({ devices: [], localName: "本机" }));
	check("空配置 + 未选中：不 patch、不加 UI（完全惰性）",
		emptyBox.sandbox.fetch === emptyBox.originalFetch
		&& emptyBox.sandbox.WebSocket === emptyBox.originalWebSocket
		&& emptyBox.dom.findById(PILL_ELEMENT_ID) === null);
	const idleHost = await startFakeHost(idleRouter);
	const idleGet = await httpGet(`http://127.0.0.1:${idleHost.port}/dev/anything/`);
	check("/dev/anything/ 落到 fallback（404），插件不拦", idleGet.status === 404, `status=${idleGet.status}`);
	const idleState = await httpJson(`http://127.0.0.1:${idleHost.port}${internals.PLUGIN_ROUTE}/state`);
	check("空设备表时状态接口仍然可用（enabled/version 在）",
		idleState.status === 200 && idleState.json.enabled === true && idleState.json.version === internals.VERSION,
		JSON.stringify(idleState.json).slice(0, 120));

	// ------------------------------------------------------------------
	// C4：垫片自检（停用 = 立刻回到本机、无胶囊）
	// ------------------------------------------------------------------
	section("C4 垫片自检：拿到 enabled:false / 404 才自除（清键 → 摘胶囊 → 还原原语 → 带哨兵刷新一次）");

	// ① 宿主注入时已经说了 enabled:false → 一次都不 patch、也不挂胶囊（干净状态）。
	const offBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" },
	});
	runShim(offBox, internals.renderShimScript({
		devices: [{ id: "home", name: "设备B" }],
		localName: "本机",
		statePath: internals.STATE_PATH,
		enabled: false,
		sentinelKey: internals.SHIM_SELFTEST_SENTINEL_KEY,
	}));
	check("注入时 enabled:false → 不同步 patch（fetch/WebSocket/XHR 都还是原函数）",
		offBox.sandbox.fetch === offBox.originalFetch
		&& offBox.sandbox.WebSocket === offBox.originalWebSocket
		&& offBox.sandbox.XMLHttpRequest.prototype.open === offBox.originalXhr.prototype.open);
	check("注入时 enabled:false → 也不挂胶囊", offBox.dom.findById(PILL_ELEMENT_ID) === null);
	check("注入时 enabled:false → 仍然问一次 /state（老窗口靠它自除）",
		offBox.calls.fetch.some((call) => call.input === internals.STATE_PATH && call.init?.method === "GET"));

	// ② 老窗口：注入行里还是 enabled:true（桌面壳缓存），宿主已经停用 → 异步自检必须自除并刷新一次。
	const staleBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		transport: { ownsHost: true, streamBaseUrl: "http://127.0.0.1:19387" },
		stateStatus: 200,
		stateBody: { enabled: false },
	});
	runShim(staleBox, SHIM_TEXT);
	check("前置条件：老窗口的垫片确实同步 patch 了 fetch（胶囊代码已整段删除 ⇒ 本来就没有任何 UI 可挂）",
		staleBox.sandbox.fetch !== staleBox.originalFetch && noShimUi(staleBox));
	const stalePill = staleBox.dom.findById(PILL_ELEMENT_ID);
	const stalePillIndexBefore = staleBox.dom.body.children.indexOf(stalePill);
	const staleBodyBefore = staleBox.dom.body.children.length;
	await sleep(0);
	check("自检拿到 enabled:false → 本来就没有 UI，自除后依然没有（干净）",
		staleBox.dom.findById(PILL_ELEMENT_ID) === null && noShimUi(staleBox));
	check("自检拿到 enabled:false → 被改写的三个原语都还原了",
		staleBox.sandbox.fetch === staleBox.originalFetch
		&& staleBox.sandbox.WebSocket === staleBox.originalWebSocket
		&& staleBox.sandbox.XMLHttpRequest.prototype.open === staleBox.originalXhr.prototype.open);
	check("自检拿到 enabled:false → 清掉 localStorage 的 current/devices（主键 + 别名四个键全没）",
		[internals.STORAGE_KEYS.current, internals.STORAGE_KEYS.devices,
			internals.STORAGE_KEYS.currentAlias, internals.STORAGE_KEYS.devicesAlias]
			.every((key) => staleBox.storage.has(key) === false),
		JSON.stringify([...staleBox.storage.keys()]));
	check("自检拿到 enabled:false → 带哨兵刷新了页面一次（哨兵写进 sessionStorage）",
		staleBox.calls.reloads === 1 && staleBox.storage.get(internals.SHIM_SELFTEST_SENTINEL_KEY) === "1",
		`reloads=${String(staleBox.calls.reloads)} sentinel=${String(staleBox.storage.get(internals.SHIM_SELFTEST_SENTINEL_KEY))}`);
	// 0.12.0：`removePill()` 已随死代码整段删除 ⇒ 这条改成"自除**不插任何节点**"的等价（更强的）断言：
	// body 一个子节点都没多、那个 id 也从来不存在（`removePill` 的活现在是"根本没人挂"）。
	check("自除对「本来就没有 UI」的窗口是空操作（幂等、不报错、DOM 一个节点都没多）",
		stalePill === null && stalePillIndexBefore === -1 && staleBox.dom.body.children.length === staleBodyBefore
		&& noShimUi(staleBox));

	// ③ 哨兵在位 = 这个窗口已经为"停用"刷过一次 → 同步阶段直接当没装，且不再刷第二次。
	const sentinelBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateBody: { enabled: false },
	});
	sentinelBox.storage.set(internals.SHIM_SELFTEST_SENTINEL_KEY, "1");
	runShim(sentinelBox, SHIM_TEXT);
	check("哨兵在位 → 同步阶段就当没装：不 patch、不挂胶囊、不刷新",
		sentinelBox.sandbox.fetch === sentinelBox.originalFetch
		&& sentinelBox.sandbox.WebSocket === sentinelBox.originalWebSocket
		&& sentinelBox.dom.findById(PILL_ELEMENT_ID) === null
		&& sentinelBox.calls.reloads === 0);
	await sleep(0);
	check("哨兵在位 + 自检又拿到 enabled:false → 绝不刷新第二次（防循环）",
		sentinelBox.calls.reloads === 0, String(sentinelBox.calls.reloads));

	// ④ 404（插件已被卸载 / 路由没了）走同一条自除路径。
	const goneBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateStatus: 404,
	});
	runShim(goneBox, SHIM_TEXT);
	await sleep(0);
	check("404 = 插件已被卸载 → 一样自除（清键 + 摘胶囊 + 还原 + 刷新一次）",
		goneBox.storage.has(internals.STORAGE_KEYS.current) === false
		&& goneBox.dom.findById(PILL_ELEMENT_ID) === null
		&& goneBox.sandbox.fetch === goneBox.originalFetch
		&& goneBox.calls.reloads === 1,
		`reloads=${String(goneBox.calls.reloads)}`);

	// ⑤ 惰性自愈：哨兵在位（"开启后的第一次加载"）但自检发现宿主其实开着 → 置 force-active + 刷一次。
	const healBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateStatus: 200,
		stateBody: { enabled: true },
	});
	healBox.storage.set(internals.SHIM_SELFTEST_SENTINEL_KEY, "1");
	runShim(healBox, SHIM_TEXT);
	check("前置条件：哨兵在位时同步阶段不 patch、不挂胶囊（= 错过挂载时机，胶囊得靠下一次加载）",
		healBox.sandbox.fetch === healBox.originalFetch
		&& healBox.sandbox.WebSocket === healBox.originalWebSocket
		&& healBox.dom.findById(PILL_ELEMENT_ID) === null);
	await sleep(0);
	check("惰性自愈：live enabled:true 且本次惰性 → 置 force-active 并刷新一次",
		healBox.storage.get(internals.SHIM_FORCE_ACTIVE_KEY) === "1" && healBox.calls.reloads === 1,
		`force-active=${String(healBox.storage.get(internals.SHIM_FORCE_ACTIVE_KEY))} reloads=${String(healBox.calls.reloads)}`);
	check("惰性自愈后哨兵仍在位（reloadOnce 重新武装 = 防循环的第二道）",
		healBox.storage.get(internals.SHIM_SELFTEST_SENTINEL_KEY) === "1",
		String(healBox.storage.get(internals.SHIM_SELFTEST_SENTINEL_KEY)));

	// ⑥ 自愈落地：同一个窗口刷新之后，force-active 压倒哨兵与 payload.enabled → 正常模式 + 用掉即删。
	const afterHealBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateStatus: 200,
		stateBody: { enabled: true },
	});
	// sessionStorage 跟着窗口走：把自愈写下的两个键搬进"刷新后的那个窗口"。
	for (const key of [internals.SHIM_FORCE_ACTIVE_KEY, internals.SHIM_SELFTEST_SENTINEL_KEY]) {
		const value = healBox.storage.get(key);
		if (value !== undefined) afterHealBox.storage.set(key, value);
	}
	runShim(afterHealBox, SHIM_TEXT);
	check("自愈后的下一次加载：force-active 让哨兵失效 → 同步 patch 生效（胶囊 UI 停用 ⇒ 不再挂）且不再刷新",
		afterHealBox.sandbox.fetch !== afterHealBox.originalFetch
		&& noShimUi(afterHealBox)
		&& afterHealBox.calls.reloads === 0,
		`reloads=${String(afterHealBox.calls.reloads)}`);
	check("force-active 用掉即删（只强制激活一次，不留残留）",
		afterHealBox.storage.has(internals.SHIM_FORCE_ACTIVE_KEY) === false);
	await sleep(0);
	check("落地后 live enabled:true 且不再惰性 → 只清哨兵、不刷新（全程总共只刷了 1 次）",
		afterHealBox.calls.reloads === 0 && afterHealBox.storage.has(internals.SHIM_SELFTEST_SENTINEL_KEY) === false,
		`reloads=${String(afterHealBox.calls.reloads)} sentinel=${String(afterHealBox.storage.get(internals.SHIM_SELFTEST_SENTINEL_KEY))}`);

	// ⑦ payload 还是停用的（桌面壳缓存住的旧注入行）+ force-active → 一样走正常模式。
	const forcedBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateStatus: 200,
		stateBody: { enabled: true },
	});
	forcedBox.storage.set(internals.SHIM_SELFTEST_SENTINEL_KEY, "1");
	forcedBox.storage.set(internals.SHIM_FORCE_ACTIVE_KEY, "1");
	runShim(forcedBox, internals.renderShimScript({
		devices: [{ id: "home", name: "设备B" }],
		localName: "本机",
		statePath: internals.STATE_PATH,
		enabled: false,
		sentinelKey: internals.SHIM_SELFTEST_SENTINEL_KEY,
		forceActiveKey: internals.SHIM_FORCE_ACTIVE_KEY,
	}));
	check("force-active 存在 → 忽略 payload.enabled:false 与哨兵：patch 生效 + 不挂 UI（停用）+ 删标记",
		forcedBox.sandbox.fetch !== forcedBox.originalFetch
		&& forcedBox.sandbox.WebSocket !== forcedBox.originalWebSocket
		// XHR 的原语是**同一个 prototype**，比对象引用恒为真；这里按行为断言（open 真的被改写）。
		&& (() => {
			const probe = new forcedBox.sandbox.XMLHttpRequest();
			probe.open("GET", "api/sessions");
			return forcedBox.calls.xhr.at(-1)?.url === "/dev/home/api/sessions";
		})()
		&& noShimUi(forcedBox)
		&& forcedBox.storage.has(internals.SHIM_FORCE_ACTIVE_KEY) === false,
		`fetch=${String(forcedBox.sandbox.fetch !== forcedBox.originalFetch)} ws=${String(forcedBox.sandbox.WebSocket !== forcedBox.originalWebSocket)} xhr=${String(forcedBox.calls.xhr.at(-1)?.url)} shimUi=${String(!noShimUi(forcedBox))} marker=${String(forcedBox.storage.get(internals.SHIM_FORCE_ACTIVE_KEY))}`);
	await sleep(0);
	check("强制激活落地后 live enabled:true → 不刷新，只把哨兵清掉",
		forcedBox.calls.reloads === 0 && forcedBox.storage.has(internals.SHIM_SELFTEST_SENTINEL_KEY) === false,
		`reloads=${String(forcedBox.calls.reloads)}`);

	// ⑧ 防循环第一道：force-active 写不进去（sessionStorage 不可写）时自愈**绝不刷新**。
	const noMarkerBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateStatus: 200,
		stateBody: { enabled: true },
	});
	noMarkerBox.storage.set(internals.SHIM_SELFTEST_SENTINEL_KEY, "1");
	noMarkerBox.sandbox.sessionStorage.setItem = function deniedSetItem() {
		throw new Error("sessionStorage denied");
	};
	runShim(noMarkerBox, SHIM_TEXT);
	await sleep(0);
	check("惰性自愈写不进 force-active → 绝不刷新（降级为手动重载，避免每次加载都刷成死循环）",
		noMarkerBox.calls.reloads === 0 && noMarkerBox.dom.findById(PILL_ELEMENT_ID) === null,
		`reloads=${String(noMarkerBox.calls.reloads)}`);

	// ⑨ enabled:true 的正常窗口（不惰性）与"探测失败"都必须安静。
	const fineBox = createShimSandbox({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		stateStatus: 200,
		stateBody: { enabled: true },
	});
	runShim(fineBox, SHIM_TEXT);
	await sleep(0);
	check("非惰性的正常窗口 + enabled:true → 不刷新、不写 force-active（自愈不越权）",
		fineBox.calls.reloads === 0 && fineBox.storage.has(internals.SHIM_FORCE_ACTIVE_KEY) === false,
		`reloads=${String(fineBox.calls.reloads)}`);
	const brokenProbeBox = createShimSandbox({ current: "home", devices: [{ id: "home", name: "设备B" }] });
	brokenProbeBox.sandbox.fetch = function brokenFetch() {
		return Promise.reject(new Error("network down"));
	};
	brokenProbeBox.originalFetch = brokenProbeBox.sandbox.fetch;
	delete brokenProbeBox.sandbox.sessionStorage;
	runShim(brokenProbeBox, SHIM_TEXT);
	await sleep(0);
	check("自检请求被拒（网络失败）→ 安静：不清键、不刷新（胶囊 UI 停用 ⇒ 也没有胶囊可摘）",
		brokenProbeBox.storage.get(internals.STORAGE_KEYS.current) === "home"
		&& noShimUi(brokenProbeBox)
		&& brokenProbeBox.calls.reloads === 0,
		`reloads=${String(brokenProbeBox.calls.reloads)}`);

	// ------------------------------------------------------------------
	// K1（2026-10-17）：自愈（那个致死缺陷的补丁）
	//
	// 背景：那台机器关机时切过去 ⇒ 所有 `/api` 被改写成 `/dev/<那台>/api/…` ⇒ 全部失败 ⇒
	// App 壳渲染不出来 ⇒ 切设备的入口（长在 App DOM 里）一个都点不到，用户只能等那台开机。
	// 修法：**只留同步判据** —— 选中的 id 不在本机配置的设备表里（脏 id / 从别的机器带过来的键）
	// 就清键 + 刷一次回本机（防回环 + 说不清就不动）。
	//
	// 2026-10-17 第二刀按用户要求**删掉了**上一刀那条"基于可达性的自动重置"：
	// `/plugin/remote/live` 探针 + `reachable === false` 连续 2 次 ⇒ 自动回本机（他不要
	// "我自己切过去又被你弹回来"）。所以本段的用例从 9 条减到 4 条，并且多了一条
	// "垫片从此不再打任何探测请求"的回归断言。
	// ------------------------------------------------------------------
	section("K1 自愈①：同步判据（选中的 id 不在本机设备表 ⇒ 清键 + 刷一次）；可达性探测只在非回环会话里开");

	check("自愈的判据键名与垫片函数体里的局部字面量逐字一致（垫片引用不了模块绑定，只能靠断言钉住）",
		SHIM_TEXT.includes('var AUTO_RESET_KEY = "dsh-remote:auto-reset";')
		&& SHIM_TEXT.includes('var AUTO_RESET_COOLDOWN_MS = 60000;'),
		`autoResetKey=${String(SHIM_TEXT.includes('var AUTO_RESET_KEY = "dsh-remote:auto-reset";'))}`);

	// ① 同步判据：选中的 id 不在本机配置的设备表里 ⇒ 立刻清键 + 刷一次。
	const ghostBox = bootShimWithClock({
		current: "ghost",
		devices: [{ id: "home", name: "设备B" }],
		deviceSeed: [{ id: "home", name: "设备B" }],
	});
	await new Promise((resolve) => setTimeout(resolve, 0)); // 0.13.4 ???????????
	check("选中的 id 不在设备表里 ⇒ 两个 current 键都被清掉",
		ghostBox.storage.get(internals.STORAGE_KEYS.current) === undefined
		&& ghostBox.storage.has(internals.STORAGE_KEYS.currentAlias) === false,
		`main=${String(ghostBox.storage.get(internals.STORAGE_KEYS.current))} alias=${String(ghostBox.storage.has(internals.STORAGE_KEYS.currentAlias))}`);
	check("选中的 id 不在设备表里 ⇒ **只**刷新一次（哨兵保证不自己刷成环）+ 标记落下",
		ghostBox.calls.reloads === 1 && ghostBox.slot.checks().selfHealRan === true,
		`reloads=${String(ghostBox.calls.reloads)} selfHealRan=${String(ghostBox.slot.checks().selfHealRan)}`);

	// ② 配置表为空（一台设备都没配）⇒ 没有"这个 id 是脏的"的依据 ⇒ 不动。
	const noTableBox = bootShimWithClock({ current: "ghost", devices: [] });
	check("设备表为空时选中的 id 也照旧不动（没有依据就不动；老用例 D6 的 ghost 分支仍是原行为）",
		noTableBox.calls.reloads === 0 && noTableBox.storage.get(internals.STORAGE_KEYS.current) === "ghost"
		&& noTableBox.slot.checks().selfHealRan === false,
		`reloads=${String(noTableBox.calls.reloads)}`);

	// ③ 选中为空（本机）⇒ 这条补丁一个字节都不许碰，而且**一个探测请求都不打**。
	const localBox2 = bootShimWithClock({ current: "" });
	check("选中为空（本机）⇒ 不自愈、不清键、不刷新（键保持空串 = 本机态）",
		localBox2.calls.reloads === 0
		&& String(localBox2.storage.get(internals.STORAGE_KEYS.current) ?? "") === ""
		&& localBox2.slot.checks().selfHealRan === false,
		`reloads=${String(localBox2.calls.reloads)}`);

	// ④ 垫片**只在非回环会话**里才登记那条可达性探测（见 K4）。**回环会话**（127.0.0.1 / localhost /
	//    ::1，桌面壳与"本机浏览器"就是这类）里：`/plugin/remote/live` 与 `/dsh-remote-view` **一条都不打**、
	//    一个定时器都不登记；垫片也**不插任何 DOM**（胶囊面板 / 左上角按钮都已整段删除）。
	const noProbeBox = bootShimWithClock({ current: "home" });
	check("回环会话：垫片**从不**请求 /plugin/remote/live 与 /dsh-remote-view（对端态也一样）、一个定时器都不登记、也不插任何 DOM",
		noProbeBox.calls.fetch.every((call) => call.input !== internals.LIVE_PATH && call.input !== internals.VIEW_PATH)
		&& noProbeBox.slot.checks().timers.length === 0
		&& noProbeBox.dom.body.children.length === 0
		&& !SHIM_TEXT.includes("schedule("),
		`fetch=${JSON.stringify(noProbeBox.calls.fetch.map((call) => call.input))} timers=${JSON.stringify(noProbeBox.slot.checks().timers)} bodyChildren=${String(noProbeBox.dom.body.children.length)}`);

	// ⑤ 防回环的第二道：冷却标记写不进去（localStorage 被禁）⇒ **绝不重置**。
	// 注意顺序：`setItem` 必须在**跑垫片之前**就换成抛异常的版本（`bootShimWithClock` 内部跑垫片）。
	const noMarkBox = withShimClock(createShimSandbox({ current: "ghost" }));
	noMarkBox.sandbox.localStorage.setItem = function deniedSetItem() {
		throw new Error("localStorage denied");
	};
	runShim(noMarkBox, internals.renderShimScript({ devices: [{ id: "home", name: "设备B" }], localName: "本机" }));
	check("冷却标记写不进 localStorage ⇒ 宁可不救也不重置（否则就是「刷新 → 又重置」的死循环）",
		noMarkBox.calls.reloads === 0 && noMarkBox.storage.get(internals.STORAGE_KEYS.current) === "ghost",
		`reloads=${String(noMarkBox.calls.reloads)}`);

	// ⑥ 防回环的第三道：冷却窗口内不重复 reset（标记刚写过）。
	const cookedBox = withShimClock(createShimSandbox({ current: "ghost" }));
	cookedBox.storage.set("dsh-remote:auto-reset", JSON.stringify({ at: 0, count: 1 }));
	runShim(cookedBox, internals.renderShimScript({ devices: [{ id: "home", name: "设备B" }], localName: "本机" }));
	check("60 秒冷却窗口内（标记刚写过）⇒ 不重复 reset（防回环）",
		cookedBox.calls.reloads === 0 && cookedBox.storage.get(internals.STORAGE_KEYS.current) === "ghost",
		`reloads=${String(cookedBox.calls.reloads)}`);

	// ------------------------------------------------------------------
	// K4（0.12.0）：**可达性自愈**——只给"没有别的出口"的会话（非回环 + http(s)）
	//
	// 背景：手机 / 浏览器经「对外端口」（edge）打开本机页面时，切设备入口（客户端半那一行 + 浮层）
	// 长在 App 的 DOM 里，而对端关机时页面所有 `/api` 都被改写成 `/dev/<那台>/…` ⇒ 壳渲染不出来
	// ⇒ 用户一个入口都没有（垫片是唯一不依赖 App DOM 的出路）。所以恢复"连续 2 次不可达 ⇒ 回本机"，
	// 但**只在非回环会话**里（桌面壳 `dsh-app://app/` 与 127.0.0.1 一律不动手：用户明确不要
	// "我自己切过去又被你弹回来"）。取数走 `/dsh-remote-view`（非 `/plugin/` ⇒ 能穿过 edge）。
	// 本组用例盯：非回环 2 次 ⇒ 清键 + 刷新一次；回环 / 桌面壳 ⇒ 一个定时器都不登记、一条都不打；
	// 未知（没数据 / 403）与"抖动"⇒ 计数清零、绝不重置；以及垫片本地的路径/间隔字面量。
	// ------------------------------------------------------------------
	section("K4 可达性自愈（0.12.0）：非回环会话连续 2 次不可达 ⇒ 清键 + 刷回本机；回环 / 桌面壳 / 未知一律不动");

	/** 非回环（域名）的 location：`http://nas.example.com/`（手机 / 浏览器经 edge 的样子）。 */
	const browserLocation = (hostname) => ({
		href: `http://${hostname}/`,
		host: hostname,
		hostname,
		protocol: "http:",
		pathname: "/",
		reload() {},
	});
	const unreachablePeers = (id) => [{ id, name: "设备B", reachable: false, lastError: "连接超时", live: null }];
	const currentKeysGone = (box) => box.storage.has(internals.STORAGE_KEYS.current) === false
		&& box.storage.has(internals.STORAGE_KEYS.currentAlias) === false;

	check("垫片本地的聚合口字面量与模块常量 VIEW_PATH 逐字一致（垫片引用不了模块绑定，只能靠断言钉住）",
		SHIM_TEXT.includes('var HEAL_VIEW_PATH = "/dsh-remote-view";') && internals.VIEW_PATH === "/dsh-remote-view",
		String(internals.VIEW_PATH));
	check("探测间隔与「连续几次」也都是钉死的常量（2 秒那一套 / 2 次）",
		SHIM_TEXT.includes("var HEAL_POLL_MS = 2000;") && SHIM_TEXT.includes("var HEAL_FAILS_TO_RESET = 2;"));

	// ① 非回环：第 1 次不可达不动手，第 2 次才清键 + 刷新一次。
	const upView = { peers: unreachablePeers("home") };
	const reachBox = bootShimWithClock({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		deviceSeed: [{ id: "home", name: "设备B" }],
		location: browserLocation("nas.example.com"),
		viewState: upView,
	});
	check("非回环会话：登记了一条探测（2 秒），并且立刻探了第 1 次",
		reachBox.slot.checks().timers.length === 1
		&& reachBox.calls.fetch.some((call) => call.input === internals.VIEW_PATH),
		`timers=${JSON.stringify(reachBox.slot.checks().timers)} fetch=${JSON.stringify(reachBox.calls.fetch.map((call) => call.input))}`);
	check("探测打的是 /dsh-remote-view（非 /plugin/ 前缀 ⇒ 能穿过 edge），**绝不打** /plugin/remote/live",
		reachBox.calls.fetch.every((call) => call.input !== internals.LIVE_PATH));
	check("非回环会话：**只有 1 次**不可达时不动手（不是「一次就弹回」）",
		reachBox.calls.reloads === 0 && reachBox.storage.get(internals.STORAGE_KEYS.current) === "home"
		&& reachBox.slot.checks().selfHealRan === false,
		`reloads=${String(reachBox.calls.reloads)}`);
	await reachBox.clock.advance(2000);
	check("连续 2 次不可达 ⇒ 清掉 current 两个键 + **只**刷新一次回本机（复用 resetToLocal 的冷却/哨兵）",
		reachBox.calls.reloads === 1 && currentKeysGone(reachBox) && reachBox.slot.checks().selfHealRan === true,
		`reloads=${String(reachBox.calls.reloads)} selfHealRan=${String(reachBox.slot.checks().selfHealRan)}`);
	check("决定之后就把探测停掉（不再打第三枪、也不留定时器）",
		reachBox.slot.checks().timers.length === 0);
	const reachProbes = reachBox.calls.fetch.filter((call) => call.input === internals.VIEW_PATH).length;
	await reachBox.clock.advance(20000);
	check("重置之后不再探测（推进 20 秒也没多一条）",
		reachBox.calls.fetch.filter((call) => call.input === internals.VIEW_PATH).length === reachProbes,
		`${String(reachProbes)} → ${String(reachBox.calls.fetch.filter((call) => call.input === internals.VIEW_PATH).length)}`);

	// ② 回环会话（默认 127.0.0.1）：一个定时器都不登记、一条探测都不打、绝不自动弹回。
	const loopHealBox = bootShimWithClock({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		deviceSeed: [{ id: "home", name: "设备B" }],
		viewState: { peers: unreachablePeers("home") },
	});
	await loopHealBox.clock.advance(20000);
	check("回环会话（127.0.0.1）：不登记定时器、不打探测、连续再久也**绝不**自动弹回",
		loopHealBox.slot.checks().timers.length === 0 && loopHealBox.calls.reloads === 0
		&& loopHealBox.storage.get(internals.STORAGE_KEYS.current) === "home"
		&& loopHealBox.calls.fetch.every((call) => call.input !== internals.VIEW_PATH),
		`timers=${JSON.stringify(loopHealBox.slot.checks().timers)} reloads=${String(loopHealBox.calls.reloads)}`);

	// ③ 桌面壳（dsh-app://app/）：**不是 http(s)** ⇒ 同样不动手（用户明确不要桌面端被弹回）。
	const deskHealBox = bootShimWithClock({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		deviceSeed: [{ id: "home", name: "设备B" }],
		location: { href: "dsh-app://app/", host: "app", hostname: "app", protocol: "dsh-app:", pathname: "/", reload() {} },
		viewState: { peers: unreachablePeers("home") },
	});
	await deskHealBox.clock.advance(20000);
	check("桌面壳（dsh-app://app/）：不登记定时器、不打探测、绝不弹回（桌面端不受影响）",
		deskHealBox.slot.checks().timers.length === 0 && deskHealBox.calls.reloads === 0
		&& deskHealBox.calls.fetch.every((call) => call.input !== internals.VIEW_PATH));

	// ④ 未知 ≠ 不可达：聚合里**没有这台** / 读不到（403）⇒ 计数清零，绝不重置。
	const otherView = { peers: [{ id: "office", name: "设备C", reachable: false, lastError: "连接超时", live: null }] };
	const unknownBox = bootShimWithClock({
		current: "home",
		devices: [{ id: "home", name: "设备B" }, { id: "office", name: "设备C" }],
		deviceSeed: [{ id: "home", name: "设备B" }, { id: "office", name: "设备C" }],
		location: browserLocation("nas.example.com"),
		viewState: otherView,
	});
	await unknownBox.clock.advance(20000);
	check("未知（聚合里没有当前这台）⇒ 探多少次都不重置（未知 ≠ 不可达）",
		unknownBox.calls.reloads === 0 && unknownBox.storage.get(internals.STORAGE_KEYS.current) === "home");

	const refusedBox = bootShimWithClock({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		deviceSeed: [{ id: "home", name: "设备B" }],
		location: browserLocation("nas.example.com"),
		viewState: { status: 403, peers: unreachablePeers("home") },
	});
	await refusedBox.clock.advance(20000);
	check("读不到聚合（403 / 会话不可信）⇒ 未知 ⇒ 不重置（也不当成「连不上」）",
		refusedBox.calls.reloads === 0 && refusedBox.storage.get(internals.STORAGE_KEYS.current) === "home");

	// ⑤ "连续"是严格的：中间夹一次未知就打断计数（不是"累计 2 次"）。
	const flipView = { peers: unreachablePeers("home") };
	const flipBox = bootShimWithClock({
		current: "home",
		devices: [{ id: "home", name: "设备B" }],
		deviceSeed: [{ id: "home", name: "设备B" }],
		location: browserLocation("nas.example.com"),
		viewState: flipView,
	});
	flipView.peers = []; // 第 2 次 = 未知 ⇒ 打断
	await flipBox.clock.advance(2000);
	flipView.peers = unreachablePeers("home"); // 第 3 次 = 又不可达（这一次只是新的第 1 次）
	await flipBox.clock.advance(2000);
	check("中间夹一次未知就打断「连续」计数（第 3 次只是新的第 1 次 ⇒ 仍然不动手）",
		flipBox.calls.reloads === 0 && flipBox.storage.get(internals.STORAGE_KEYS.current) === "home");
	await flipBox.clock.advance(2000);
	check("打断之后又连续 2 次不可达（第 3 + 第 4 次）⇒ 这才重置",
		flipBox.calls.reloads === 1 && currentKeysGone(flipBox));

	// ------------------------------------------------------------------
	// K2（2026-10-17 第二刀那组用例）**已整段删除**（第三刀）：
	//
	// 上一刀往垫片里加了一颗「左上角常驻『← 本机』小按钮」（纯原生 DOM，`KEYS_CURRENT` 非空就挂），
	// 配套 8 条用例（显隐 / 文案 title / 样式 / 挂载点 / 点击清键 + 刷新 / 重跑不复活 / dispose 幂等）。
	// 用户真机实测后认为它**多余且丑**：白屏已从 15 秒降到 2–3 秒、界面基本都会渲染出来，
	// 正常切换器（客户端半的侧栏那一行 + 浮层）就够用 ⇒ 那颗按钮连同 `dispose` 一起删掉，
	// 这 8 条用例随之删除。**"垫片一个 DOM 节点都不插"这条不变式改由上面 K1 ④ 那条覆盖**
	// （断言 `dom.body.children.length === 0` + 不打探针 + 不登记定时器）。
	// ------------------------------------------------------------------


	// ------------------------------------------------------------------
	// K3（2026-10-17 第四刀）：垫片**无声发布设备表** —— 浏览器里唯一还拿得到的设备表来源
	//
	// 背景（真机 bug，用户实测）：`GET /plugin/remote/live` 经 edge 一律 403（`/plugin/` 被
	// `EDGE_BLOCKED_PREFIXES` 整段挡住），于是**任何浏览器打开的页面**都拿不到 `peers[]`；
	// 而客户端半原来唯一的设备表来源（胶囊面板里的 `button[data-device-id]`）随着胶囊停用也断了
	// ⇒ 浮层里只剩「本机」，连切设备都做不到。
	// 修法：垫片把同一份设备快照**无声发布**两份（全局快照 + 隐藏 JSON 节点），客户端半按优先级读。
	// 本组用例盯：内容正确（本机空 id + current 标记）、隐藏节点不可见/不占位、幂等、
	// 热重载刷新、softOff 撤销，以及"**不新增任何网络请求**、body 依旧一个节点都没有"。
	// ------------------------------------------------------------------
	section("K3 无声发布设备表：全局快照 + 隐藏 JSON 节点（浏览器列设备/切设备；不画可见 UI、不发请求）");

	/** 垫片发布到全局的那份设备表（没发布就是 undefined）。 */
	const publishedGlobal = (box) => box.sandbox.__DSH_REMOTE_DEVICES__;
	/** 垫片的隐藏 JSON 节点（挂在 documentElement 上；自测的 body 版 getElementById 找不到它）。 */
	const publishedNode = (box) => box.dom.findByIdIn(box.dom.document.documentElement, internals.SHIM_DEVICES_NODE_ID);
	const devicesInNode = (box) => JSON.parse(String(publishedNode(box).textContent)).devices;

	const publishLocalBox = bootShimWithClock({ current: "" });
	check("发布到全局：`__DSH_REMOTE_DEVICES__` = 注入 payload 那份设备表，本机那条 id 是空串、排在最前",
		Object.prototype.toString.call(publishedGlobal(publishLocalBox)) === "[object Array]"
		&& publishedGlobal(publishLocalBox).length === 3
		&& publishedGlobal(publishLocalBox)[0].id === ""
		&& JSON.stringify(publishedGlobal(publishLocalBox).map((entry) => entry.id)) === JSON.stringify(["", "home", "office"]),
		JSON.stringify(publishedGlobal(publishLocalBox)));
	check("发布内容带名字（对端名字原样透传，不是只给 id）",
		publishedGlobal(publishLocalBox)[1].name === "设备B" && publishedGlobal(publishLocalBox)[2].name === "设备C",
		JSON.stringify(publishedGlobal(publishLocalBox).map((entry) => `${entry.id}=${entry.name}`)));
	check("选中本机（KEYS_CURRENT 空）⇒ 只有本机那条带 current:true，对端全是 false",
		publishedGlobal(publishLocalBox).filter((entry) => entry.current === true).length === 1
		&& publishedGlobal(publishLocalBox)[0].current === true
		&& publishedGlobal(publishLocalBox)[1].current === false,
		JSON.stringify(publishedGlobal(publishLocalBox).map((entry) => `${entry.id}:${String(entry.current)}`)));

	const publishHomeBox = bootShimWithClock({ current: "home" });
	check("`current` 标记跟着 KEYS_CURRENT 走（选 home ⇒ 本机那条 false、home 那条 true）",
		publishedGlobal(publishHomeBox).filter((entry) => entry.current === true).length === 1
		&& publishedGlobal(publishHomeBox)[1].current === true
		&& publishedGlobal(publishHomeBox)[0].current === false,
		JSON.stringify(publishedGlobal(publishHomeBox).map((entry) => `${entry.id}:${String(entry.current)}`)));

	const publishNode = publishedNode(publishHomeBox);
	check('隐藏 JSON 节点在：`<script type="application/json" id="dsh-remote-devices">`，挂在 documentElement 上',
		publishNode !== null && publishNode !== undefined && publishNode.tagName === "SCRIPT"
		&& publishNode.getAttribute("type") === "application/json"
		&& publishNode.getAttribute("id") === internals.SHIM_DEVICES_NODE_ID
		&& internals.SHIM_DEVICES_NODE_ID === "dsh-remote-devices"
		&& publishNode.parentNode === publishHomeBox.dom.document.documentElement,
		`node=${publishNode === null ? "null" : String(publishNode.tagName)} parentIsHtml=${String(publishNode !== null && publishNode.parentNode === publishHomeBox.dom.document.documentElement)}`);
	check("隐藏节点**不可见、不占位**：`hidden === true` + `display:none`（`<script>` 本来就不渲染，双保险）",
		publishNode.hidden === true && publishNode.style.display === "none",
		`hidden=${String(publishNode.hidden)} display=${String(publishNode.style.display)}`);
	check("隐藏节点内容是 `{\"devices\":[…]}`，与全局快照逐字一致（两份互为兜底）",
		JSON.stringify({ devices: publishedGlobal(publishHomeBox) }) === JSON.stringify(JSON.parse(String(publishNode.textContent)))
		&& devicesInNode(publishHomeBox).length === 3,
		String(publishNode.textContent).slice(0, 120));
	check("发布**不占位**：发布之后 body 下依然一个子节点都没有（K1 ④ 那条不变式照样成立）",
		publishHomeBox.dom.body.children.length === 0,
		`bodyChildren=${String(publishHomeBox.dom.body.children.length)}`);
	check("发布**不新增任何网络请求**：垫片的请求仍然只有那两枪（`POST /plugin/remote/hello` 报到 + `GET /plugin/remote/state` 自检）",
		publishHomeBox.calls.fetch.length >= 1
		&& publishHomeBox.calls.fetch.every((call) => call.input === internals.STATE_PATH || call.input === internals.HELLO_PATH),
		JSON.stringify(publishHomeBox.calls.fetch.map((call) => call.input)));
	check("脚本里带着那个节点 id（导出的 `internals.SHIM_DEVICES_NODE_ID` 与注入文本逐字一致，防漂移）",
		SHIM_TEXT.includes(internals.SHIM_DEVICES_NODE_ID)
		&& SHIM_TEXT.includes("__DSH_REMOTE_DEVICES__"),
		`id=${internals.SHIM_DEVICES_NODE_ID}`);

	// 幂等 + 配置热重载：宿主半换设备表后会**重新注入同一份脚本**（新 payload 进同一个窗口）。
	const reloadBox = bootShimWithClock({ current: "home" });
	const nodesBefore = reloadBox.dom.document.documentElement.children.filter((child) => child.id === internals.SHIM_DEVICES_NODE_ID).length;
	runShim(reloadBox, internals.renderShimScript({
		devices: [{ id: "home", name: "设备B（改名后）" }, { id: "office", name: "设备C" }],
		localName: "本机",
	}));
	check("二次执行（配置热重载的落点）：隐藏节点**只有一个**（不重复插），body 依旧干净",
		nodesBefore === 1
		&& reloadBox.dom.document.documentElement.children.filter((child) => child.id === internals.SHIM_DEVICES_NODE_ID).length === 1
		&& reloadBox.dom.body.children.length === 0,
		`before=${String(nodesBefore)} after=${String(reloadBox.dom.document.documentElement.children.filter((child) => child.id === internals.SHIM_DEVICES_NODE_ID).length)}`);
	check("热重载 ⇒ 发布内容同步刷新成新设备表（新 payload 的名字进了全局与节点，不改 patch 也不挂 UI）",
		publishedGlobal(reloadBox)[1].name === "设备B（改名后）"
		&& devicesInNode(reloadBox)[1].name === "设备B（改名后）"
		&& publishedGlobal(reloadBox).length === 3
		&& publishedGlobal(reloadBox)[1].current === true
		&& noShimUi(reloadBox),
		JSON.stringify(publishedGlobal(reloadBox).map((entry) => `${entry.id}=${entry.name}`)));

	// 停用 / 卸载：`enabled:false` 与 404 都走 softOff ⇒ 发布必须被撤掉（不然浏览器里会一直列着旧设备表）。
	const retractBox = createShimSandbox({ current: "home", devices: [{ id: "home", name: "设备B" }], stateBody: { enabled: false } });
	runShim(retractBox, SHIM_TEXT);
	check("前置条件：正常模式下（老窗口）发布已经就位",
		publishedGlobal(retractBox) !== undefined && publishedNode(retractBox) !== null,
		`global=${String(publishedGlobal(retractBox) !== undefined)} node=${String(publishedNode(retractBox) !== null)}`);
	await sleep(0);
	check("自检拿到 enabled:false ⇒ softOff 把全局快照清掉（不留脏数据）",
		retractBox.sandbox.__DSH_REMOTE_DEVICES__ === undefined
		&& retractBox.sandbox.window === undefined,
		`global=${String(retractBox.sandbox.__DSH_REMOTE_DEVICES__)}`);
	check("自检拿到 enabled:false ⇒ softOff 把隐藏 JSON 节点也摘掉（documentElement 下一个都不剩）",
		publishedNode(retractBox) === null
		&& retractBox.dom.document.documentElement.children.filter((child) => child.id === internals.SHIM_DEVICES_NODE_ID).length === 0,
		`node=${String(publishedNode(retractBox))}`);
	check("撤销是幂等的：再调一次 `slot.retractDevices()` 也不报错、也没有节点冒出来",
		(() => {
			const slot = retractBox.sandbox.__DSH_REMOTE_SHIM__;
			slot.retractDevices();
			slot.retractDevices();
			return publishedNode(retractBox) === null && retractBox.sandbox.__DSH_REMOTE_DEVICES__ === undefined;
		})(),
		`node=${String(publishedNode(retractBox))}`);

	// 惰性窗口（注入时 enabled:false）：连"正常模式"都没进 ⇒ 一份都不许发布。
	const lazyPublishBox = createShimSandbox({ current: "home", devices: [{ id: "home", name: "设备B" }], stateBody: { enabled: false } });
	runShim(lazyPublishBox, internals.renderShimScript({
		devices: [{ id: "home", name: "设备B" }],
		localName: "本机",
		statePath: internals.STATE_PATH,
		enabled: false,
		sentinelKey: internals.SHIM_SELFTEST_SENTINEL_KEY,
	}));
	await sleep(0);
	check("注入时就是 enabled:false（惰性窗口）⇒ 全局与节点**一份都不发布**",
		lazyPublishBox.sandbox.__DSH_REMOTE_DEVICES__ === undefined
		&& publishedNode(lazyPublishBox) === null
		&& lazyPublishBox.dom.body.children.length === 0,
		`global=${String(lazyPublishBox.sandbox.__DSH_REMOTE_DEVICES__)} node=${String(publishedNode(lazyPublishBox))}`);

	// ------------------------------------------------------------------


	section("E7 响应头改写：Location / Set-Cookie 收到代理前缀下");
	const device = {
		id: "self", origin: `http://${stub.authority}`, basePath: "", authority: stub.authority, protocol: "http:",
	};
	check("根相对 Location → 前缀下", internals.rewriteLocation("/api/x", device, "/dev/self") === "/dev/self/api/x");
	check("绝对 Location（同设备）→ 前缀下",
		internals.rewriteLocation(`http://${stub.authority}/somewhere`, device, "/dev/self") === "/dev/self/somewhere");
	check("./ 保持相对（浏览器按当前路径解析，本来就在前缀下）",
		internals.rewriteLocation("./", device, "/dev/self") === "./");
	check("Set-Cookie 的 Path 收到 /dev/self/",
		internals.rewriteSetCookie("dsh-auth-x=y; Max-Age=315360000; Path=/; HttpOnly; SameSite=Strict", "/dev/self")
			=== "dsh-auth-x=y; Max-Age=315360000; Path=/dev/self/; HttpOnly; SameSite=Strict",
		internals.rewriteSetCookie("dsh-auth-x=y; Max-Age=1; Path=/; HttpOnly", "/dev/self"));

	// ------------------------------------------------------------------
	// E8：代理的可信请求判定（2026-10-15 只读审查补的：这条以前只有「另存为」有）
	//
	// 背景：`/dev/<id>/**` 会带上宿主侧的 cookie jar 转发到对面整台 DSH，等于"本机任意页面
	// 借它操作对面"的通道。以前只有「另存为」那条路由有官方判定，代理这条没有。
	// 修法：代理入口也跑同一个 authorizeTrustedRequest（失败即拒）。
	// **happy path 不用另写**：上面 E1~E7 的代理用例默认 `requestRejection: () => undefined`
	// （宿主替身的缺省），它们仍然全绿 = 官方判定放行时一切如常、没有误伤。
	// ------------------------------------------------------------------
	section("E8 代理的可信请求判定：拒绝时 403 不转发；宿主没有官方判定时一律拒");
	const e8gatedSeed = (extra) => ({
		dataFile: freshDataFile(),
		devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" }],
		current: "local",
		...extra,
	});
	// ① 官方判定拒绝（403 = Host/Origin 栅栏没过）
	const e8rejectRouter = createRouter({
		credentials: seedCredentials,
		connection: {
			trustedHosts: ["192.0.2.4"],
			browserAuth: { maxAgeMilliseconds: 3_650 * 86_400_000 },
			authenticatedUrl: (base) => `${base}?token=stub`,
			requestRejection: () => 403,
		},
	});
	apply(e8rejectRouter.ctx, e8gatedSeed(), { muxPath: "/api/remote.mux" });
	const e8rejectHost = await startFakeHost(e8rejectRouter);
	const e8upstreamBefore = stub.requests.length;
	const e8rejected = await httpGet(`http://127.0.0.1:${e8rejectHost.port}/dev/self/api/poked`);
	check("代理：官方判定 403 → 本插件 403 text/plain，正文写明「被拒绝」与官方的码",
		e8rejected.status === 403
		&& String(e8rejected.headers.get("content-type")).toLowerCase().startsWith("text/plain")
		&& e8rejected.body.includes("被拒绝") && e8rejected.body.includes("403"),
		`status=${e8rejected.status} body=${JSON.stringify(e8rejected.body.slice(0, 90))}`);
	notHtml("代理被拒（403）", e8rejected);
	check("代理：被拒时**一个请求都没转发到上游**（上游计数不变）",
		stub.requests.length === e8upstreamBefore,
		`before=${e8upstreamBefore} after=${stub.requests.length}`);
	check("代理：401 同样按官方码折成 403 text/plain（正文带 401）", await (async () => {
		const e8code401Router = createRouter({
			credentials: seedCredentials,
			connection: {
				trustedHosts: [],
				browserAuth: { maxAgeMilliseconds: 3_650 * 86_400_000 },
				authenticatedUrl: (base) => `${base}?token=stub`,
				requestRejection: () => 401,
			},
		});
		apply(e8code401Router.ctx, e8gatedSeed(), { muxPath: "/api/remote.mux" });
		const e8code401Host = await startFakeHost(e8code401Router);
		const e8exchange = await httpGet(`http://127.0.0.1:${e8code401Host.port}/dev/self/api/x`);
		await e8code401Host.close();
		return e8exchange.status === 403 && e8exchange.body.includes("401");
	})());
	await e8rejectHost.close();
	// ② 宿主连官方判定都没有（老 DSH）→ **一律拒绝**（fail-closed），不是放行。
	const e8noVerdictRouter = createRouter({
		credentials: seedCredentials,
		connection: { trustedHosts: [], authenticatedUrl: (base) => base },
	});
	apply(e8noVerdictRouter.ctx, e8gatedSeed(), { muxPath: "/api/remote.mux" });
	const e8noVerdictHost = await startFakeHost(e8noVerdictRouter);
	const e8noVerdict = await httpGet(`http://127.0.0.1:${e8noVerdictHost.port}/dev/self/api/x`);
	check("代理：宿主没有 connection.requestRejection → 403 且写明「没有提供官方的可信请求判定」（降级为拒绝）",
		e8noVerdict.status === 403 && e8noVerdict.body.includes("requestRejection"),
		JSON.stringify(e8noVerdict.body.slice(0, 120)));
	await e8noVerdictHost.close();

	// ------------------------------------------------------------------
	// F：本机自验证（沿用 device-switch 的 F 组）
	// ------------------------------------------------------------------
	const FAKE_HOSTNAME = "my-pc";
	const FAKE_IP = "192.0.2.7";
	const fakeFacts = (ctx) => ({ ...internals.collectHostFacts(ctx), hostname: FAKE_HOSTNAME, ips: [FAKE_IP] });
	const seedOf = (devices, current) => ({ dataFile: freshDataFile(), devices, current });

	section("F1 本机自验证：url 命中本机 IPv4 + 端口 → 该条就是本机（不注册路由、标签带 hostname）");
	const autoRouter = createRouter();
	autoRouter.ctx.webServer.port = 19387;
	autoRouter.ctx.webServer.config.port = 19387;
	autoRouter.ctx.webServer.host = "127.0.0.1";
	// current 故意指向另一台：自动匹配必须优先于兜底。
	apply(autoRouter.ctx, seedOf([
		{ id: "company", name: "设备A", url: `http://${FAKE_IP}:19387` },
		{ id: "home", name: "设备B", url: "http://192.0.2.9:19387" },
	], "home"), { hostFacts: fakeFacts, muxPath: "/api/remote.mux" });
	check("自动匹配到的设备不注册 HTTP 代理路由（没被判为本机的那台照常注册）",
		!autoRouter.prefixes.has("/dev/company") && autoRouter.prefixes.has("/dev/home"),
		autoRouter.devPrefixes().join(","));
	check("自动匹配到的设备不注册 upgrade 路由",
		!autoRouter.upgrades.has("/dev/company/api/remote.mux") && autoRouter.upgrades.has("/dev/home/api/remote.mux"),
		[...autoRouter.upgrades.keys()].join(","));
	check("日志写明是「URL 匹配」自验证认领的（不是配置兜底）",
		autoRouter.logs.some((line) => line.includes("本机自验证") && line.includes("URL 匹配") && line.includes('"company"')),
		autoRouter.logs.find((line) => line.includes("本机自验证")) ?? "(无)");
	const autoTable = [];
	autoRouter.emit("webserver/index-inject", autoTable);
	const autoText = String(autoTable[0]?.text ?? "");
	check("菜单本机项文案 = 设备名 + （本机 <os.hostname()>）",
		autoText.includes('"localName":"设备A（本机 my-pc）"'), /"localName":"[^"]*"/u.exec(autoText)?.[0] ?? "(无)");
	check("胶囊短标签 = 设备名 · 本机",
		autoText.includes('"localCaption":"设备A · 本机"'), /"localCaption":"[^"]*"/u.exec(autoText)?.[0] ?? "(无)");
	check("被认领为本机的设备不再出现在设备表里（只剩远端那台）",
		!autoText.includes('"id":"company"') && autoText.includes('"id":"home"'));
	const autoBox = createShimSandbox({});
	runShim(autoBox, autoText);
	check("沙箱（未选中=本机）：胶囊 UI 已停用 ⇒ 不挂任何 UI（localCaption 仍在 payload 里，供回退）",
		noShimUi(autoBox) && autoText.includes('"localCaption":"设备A · 本机"'),
		String(autoBox.dom.findById(`${PILL_ELEMENT_ID}-toggle`)));
	check("沙箱：设备表（本机项带 hostname / 远端那台）仍在 payload 里，只是不再画出来",
		autoText.includes('"localName":"设备A（本机 my-pc）"') && autoText.includes('"id":"home"')
		&& !autoText.includes('"id":"company"') && noShimUi(autoBox));
	const autoHomeBox = createShimSandbox({ current: "home" });
	runShim(autoHomeBox, autoText);
	check("沙箱（选中远端）：也不挂 UI，但改写仍按 home 走（停用画 UI ≠ 停用切设备）",
		noShimUi(autoHomeBox) && fetchTarget(autoHomeBox, "api/sessions") === "/dev/home/api/sessions",
		`toggle=${String(autoHomeBox.dom.findById(`${PILL_ELEMENT_ID}-toggle`))} target=${fetchTarget(autoHomeBox, "api/sessions")}`);

	section("F2 自动匹配一条都没命中 → 回退数据文件的 current");
	const fallbackRouter = createRouter();
	fallbackRouter.ctx.webServer.port = 19387;
	fallbackRouter.ctx.webServer.config.port = 19387;
	fallbackRouter.ctx.webServer.host = "127.0.0.1";
	apply(fallbackRouter.ctx, seedOf([
		{ id: "company", name: "设备A", url: `http://${FAKE_IP}:19387` },
		{ id: "home", name: "设备B", url: "http://192.0.2.9:19387" },
	], "company"), { hostFacts: (ctx) => ({ ...internals.collectHostFacts(ctx), hostname: FAKE_HOSTNAME, ips: ["198.51.100.8"] }), muxPath: "/api/remote.mux" });
	check("回退认领 current 指的那台：它不注册路由，另一台照常注册",
		!fallbackRouter.prefixes.has("/dev/company") && fallbackRouter.prefixes.has("/dev/home"),
		fallbackRouter.devPrefixes().join(","));
	check("日志写明是「回退数据文件的 current」认领的",
		fallbackRouter.logs.some((line) => line.includes("回退数据文件的 current") && line.includes('"company"')),
		fallbackRouter.logs.find((line) => line.includes("本机自验证")) ?? "(无)");
	const fallbackTable = [];
	fallbackRouter.emit("webserver/index-inject", fallbackTable);
	check("兜底认领的标签同样是「设备A（本机 my-pc）」（名字来自数据文件、hostname 来自本机）",
		String(fallbackTable[0]?.text).includes('"localName":"设备A（本机 my-pc）"'));

	section("F3 自动匹配与 current 都失败 → localId 为空、菜单显示「本机（hostname）」");
	const noneRouter = createRouter();
	noneRouter.ctx.webServer.port = 19387;
	noneRouter.ctx.webServer.config.port = 19387;
	noneRouter.ctx.webServer.host = "127.0.0.1";
	apply(noneRouter.ctx, seedOf([{ id: "home", name: "设备B", url: "http://192.0.2.9:19387" }], "local"),
		{ hostFacts: fakeFacts, muxPath: "/api/remote.mux" });
	check("没有本机设备：唯一的设备照常注册 HTTP + upgrade 路由（localId 为空）",
		noneRouter.prefixes.has("/dev/home") && noneRouter.upgrades.has("/dev/home/api/remote.mux"));
	check("日志写明没有认领到任何设备",
		noneRouter.logs.some((line) => line.includes("本机自验证") && line.includes("没有设备命中")),
		noneRouter.logs.find((line) => line.includes("本机自验证")) ?? "(无)");
	const noneTable = [];
	noneRouter.emit("webserver/index-inject", noneTable);
	const noneText = String(noneTable[0]?.text ?? "");
	check("菜单本机项退化为「本机（my-pc）」", noneText.includes('"localName":"本机（my-pc）"'),
		/"localName":"[^"]*"/u.exec(noneText)?.[0] ?? "(无)");
	check("胶囊短标签退化为「本机」", noneText.includes('"localCaption":"本机"'));
	const noneBox = createShimSandbox({});
	runShim(noneBox, noneText);
	check("沙箱：胶囊 UI 已停用 ⇒ 不挂 UI；payload 里既有本机项（带 hostname）也有那台设备",
		noShimUi(noneBox)
		&& noneText.includes('"localName":"本机（my-pc）"')
		&& noneText.includes('"id":"home"'),
		String(noneBox.dom.findById(`${PILL_ELEMENT_ID}-panel`)));

	section("F4 跨平台细节：hostname 大小写、url 不带端口、https、端口不再硬性要求、0.0.0.0");
	const unitCtx = createRouter().ctx;
	const deviceOf = (url) => internals.normalizeDevices(unitCtx, { devices: [{ id: "d", name: "d", url }] })[0];
	const factsFor = (extra = {}) => ({ port: 19387, host: "127.0.0.1", hostname: FAKE_HOSTNAME, ips: [FAKE_IP], ...extra });
	check("hostname 大小写不敏感（url 里 MY-PC ↔ 事实里 My-Pc）",
		internals.deviceMatchesLocal(deviceOf("http://MY-PC:19387"), factsFor({ hostname: "My-Pc" })) === true);
	check("非回环 IPv4 命中（ip 来自 os.networkInterfaces）",
		internals.deviceMatchesLocal(deviceOf(`http://${FAKE_IP}:19387`), factsFor()) === true);
	check("url 不带端口（http 默认 80）→ 现在**也算**命中（0.10.3 起认本机只看 hostname）",
		internals.deviceMatchesLocal(deviceOf(`http://${FAKE_IP}`), factsFor()) === true);
	check("url 不带端口但本机端口恰好是 80 → 算命中",
		internals.deviceMatchesLocal(deviceOf(`http://${FAKE_IP}`), factsFor({ port: 80 })) === true);
	check("https 不带端口 → 仍然命中（端口不参与判定）",
		internals.deviceMatchesLocal(deviceOf(`https://${FAKE_IP}`), factsFor({ port: 443 })) === true
		&& internals.deviceMatchesLocal(deviceOf(`https://${FAKE_IP}`), factsFor({ port: 19387 })) === true);
	check("同地址但端口不同 → 仍然**算**命中（对外入口场景：设备写对外端口、DSH 自己在别的端口上）",
		internals.deviceMatchesLocal(deviceOf(`http://${FAKE_IP}:19388`), factsFor()) === true);
	check("回环地址靠 ctx.webServer.host 命中（127.0.0.1 不在非回环 IPv4 里）",
		internals.deviceMatchesLocal(deviceOf("http://127.0.0.1:19387"), factsFor({ ips: [] })) === true);
	check("绑定 0.0.0.0 是「所有网卡」不是地址：url 写 0.0.0.0 也不认领",
		internals.deviceMatchesLocal(deviceOf("http://0.0.0.0:19387"), factsFor({ host: "0.0.0.0", ips: [] })) === false);
	check("认本机不再依赖「端口就绪」：hostname 命中即可（0.10.3）",
		internals.resolveLocalDevice([deviceOf(`http://${FAKE_IP}:19387`)], "", factsFor({ port: undefined })).via === "auto");
	const multiDevices = internals.normalizeDevices(unitCtx, {
		devices: [
			{ id: "first", name: "first", url: `http://${FAKE_IP}:19387` },
			{ id: "second", name: "second", url: `http://${FAKE_HOSTNAME}:19387` },
		],
	});
	const multiHit = internals.resolveLocalDevice(multiDevices, "", factsFor());
	check("多条命中取第一条（IPv4 与 hostname 同时命中）",
		multiHit.via === "auto" && multiHit.device?.id === "first", `${multiHit.via} ${String(multiHit.device?.id)}`);

	// ------------------------------------------------------------------
	// G1 状态接口的形状与字段
	// ------------------------------------------------------------------
	section("G1 GET /plugin/remote/state：字段与形状（契约冻结）");
	const base = `http://127.0.0.1:${host.port}${internals.PLUGIN_ROUTE}`;
	const stateResponse = await httpJson(`${base}/state`);
	notHtml("GET state", stateResponse);
	const state = stateResponse.json;
	check("状态 200 且是 JSON", stateResponse.status === 200 && state !== null, `status=${stateResponse.status}`);
	check("顶层字段集合正好是契约里那 7 个（顺序无关）",
		JSON.stringify(Object.keys(state).sort()) === JSON.stringify(["access","bridge","devices","diagnostics","edge","enabled","localDevice","update","version"]),
		Object.keys(state).join(","));
	check("enabled 是布尔、version 是本包版本", state.enabled === true && state.version === internals.VERSION,
		`enabled=${String(state.enabled)} version=${String(state.version)}`);
	check("localDevice 是 null 或有 {id,name,hostname,via}（via ∈ auto/config/none）",
		state.localDevice === null
		|| (typeof state.localDevice.id === "string" && typeof state.localDevice.name === "string"
			&& typeof state.localDevice.hostname === "string" && ["auto", "config", "none"].includes(state.localDevice.via)),
		JSON.stringify(state.localDevice));
	check("devices 是 4 台，且每台正好是契约里那 7 个字段",
		state.devices.length === 4
		&& state.devices.every((entry) => JSON.stringify(Object.keys(entry).sort())
			=== JSON.stringify(["id", "lastError", "lastOkAt", "local", "name", "reachable", "url"])),
		JSON.stringify(Object.keys(state.devices[0] ?? {})));
	check("devices[].local 是布尔且恰有一台或零台为 true",
		state.devices.every((entry) => typeof entry.local === "boolean")
		&& state.devices.filter((entry) => entry.local === true).length <= 1);
	check("devices[].url 是数据文件里那个字符串", state.devices.some((entry) => entry.url === `http://127.0.0.1:${stub.port}`),
		JSON.stringify(state.devices.map((entry) => entry.url)));
	check("代理成功过的设备 reachable=true 且 lastOkAt 是 ISO 时间",
		state.devices.find((entry) => entry.id === "self")?.reachable === true
		&& /^\d{4}-\d{2}-\d{2}T/u.test(String(state.devices.find((entry) => entry.id === "self")?.lastOkAt)),
		JSON.stringify(state.devices.find((entry) => entry.id === "self")));
	check("连不上的设备 reachable=false 且 lastError 有内容（体检能看出来）",
		state.devices.find((entry) => entry.id === "down")?.reachable === false
		&& typeof state.devices.find((entry) => entry.id === "down")?.lastError === "string",
		JSON.stringify(state.devices.find((entry) => entry.id === "down")));
	check("access 字段集合 = {host,port,trustedHosts,cookieMaxAgeDays,localAddresses,writable,forkTailN,forkTailDefault,forkTailMax}",
		JSON.stringify(Object.keys(state.access).sort()) === JSON.stringify(["cookieMaxAgeDays", "forkTailDefault", "forkTailMax", "forkTailN", "host", "localAddresses", "port", "trustedHosts", "writable"]),
		Object.keys(state.access).join(","));
	check("access.forkTailN 缺省 20（数据文件里没这个键时的缺省值），上限/缺省都如实报给客户端",
		state.access.forkTailN === 20 && state.access.forkTailDefault === 20 && state.access.forkTailMax === 200,
		JSON.stringify({ forkTailN: state.access.forkTailN, forkTailDefault: state.access.forkTailDefault, forkTailMax: state.access.forkTailMax }));
	check("access.host/port 来自活的 webserver（0.0.0.0 风格也一样读得到）",
		typeof state.access.host === "string" && state.access.port === host.port,
		`host=${String(state.access.host)} port=${String(state.access.port)}`);
	check("access.trustedHosts 来自 ctx.connection.trustedHosts",
		JSON.stringify(state.access.trustedHosts) === JSON.stringify(["192.0.2.4", "203.0.113.1"]),
		JSON.stringify(state.access.trustedHosts));
	check("access.cookieMaxAgeDays 由 browserAuth.maxAgeMilliseconds 换算（3650）",
		state.access.cookieMaxAgeDays === 3650, String(state.access.cookieMaxAgeDays));
	check("access.localAddresses 是「本机地址:端口」清单：回环在前、每条都带当前端口、没有 0.0.0.0",
		Array.isArray(state.access.localAddresses) && state.access.localAddresses.length >= 1
		&& state.access.localAddresses[0] === `127.0.0.1:${host.port}`
		&& state.access.localAddresses.every((entry) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/u.test(entry) && entry.endsWith(`:${host.port}`))
		&& !state.access.localAddresses.some((entry) => entry.startsWith("0.0.0.0:")),
		JSON.stringify(state.access.localAddresses));
	check("access.writable === false：这台假机器没有 config-editor（「配置」块的保存会如实报 503，不假成功）",
		state.access.writable === false);
	check("diagnostics 字段集合 = {injectionSeen,lastHelloAt,muxPath,muxPathFound,proxyRoutes,saveAs,fork,notes,logFile,logDir}",
		JSON.stringify(Object.keys(state.diagnostics).sort())
		=== JSON.stringify(["collectScript", "fork", "injectionSeen", "lastHelloAt", "logDir", "logFile", "muxPath", "muxPathFound", "notes", "proxyRoutes", "resetScript", "saveAs"]),
		Object.keys(state.diagnostics).join(","));
	check("diagnostics.muxPath/muxPathFound 来自发现结果（本次注入的是 /api/remote.mux）",
		state.diagnostics.muxPath === "/api/remote.mux" && state.diagnostics.muxPathFound === true,
		JSON.stringify([state.diagnostics.muxPath, state.diagnostics.muxPathFound]));
	check("diagnostics.proxyRoutes = 注册的 /dev/** 路由数（4 台 × (HTTP + upgrade) = 8）",
		state.diagnostics.proxyRoutes === 8, String(state.diagnostics.proxyRoutes));
	check("diagnostics.notes 是非空字符串数组，且写明 token 存储路线",
		Array.isArray(state.diagnostics.notes) && state.diagnostics.notes.length > 0
		&& state.diagnostics.notes.every((note) => typeof note === "string")
		&& state.diagnostics.notes.some((note) => note.includes("token 存储")),
		JSON.stringify(state.diagnostics.notes.map((note) => note.slice(0, 40))));
	check("notes 里写明「配置」块可写与否（说明书类文案已搬 README，界面只留现状）",
		state.diagnostics.notes.some((note) => note.includes("访问配置可写 = ") && note.includes("access（"))
		&& state.diagnostics.notes.some((note) => note.includes("config-editor")),
		JSON.stringify(state.diagnostics.notes.filter((note) => note.includes("配置") || note.includes("config-editor")).map((note) => note.slice(0, 60))));
	const stateHead = await httpGet(`${base}/state`);
	check("HEAD/GET 都能读状态（GET 命中同一条路由）", stateHead.status === 200 && stateHead.body.includes('"enabled"'));
	check("状态接口里的设备 token 一律不出现（响应体里没有 stub-token）", !stateResponse.body.includes("stub-token"));

	// ------------------------------------------------------------------
	// G2 urls（原 token-copy 的"带 token 访问地址"能力）
	// ------------------------------------------------------------------
	section("G2 GET /plugin/remote/urls：带 token 的访问地址（原 token-copy 能力，仅回环可读）");
	const urlsResponse = await httpJson(`${base}/urls`);
	notHtml("GET urls", urlsResponse);
	check("状态 200、process 有 host/port/pid", urlsResponse.status === 200
		&& typeof urlsResponse.json.process.host === "string"
		&& urlsResponse.json.process.port === host.port
		&& urlsResponse.json.process.pid === process.pid,
		JSON.stringify(urlsResponse.json.process));
	check("urls 至少含回环那条，且每条都有 base + authenticated（token 来自 ctx.connection.authenticatedUrl）",
		Array.isArray(urlsResponse.json.urls) && urlsResponse.json.urls.length >= 1
		&& urlsResponse.json.urls.every((entry) => typeof entry.base === "string" && typeof entry.authenticated === "string")
		&& urlsResponse.json.urls.some((entry) => entry.base === `http://127.0.0.1:${host.port}`),
		JSON.stringify(urlsResponse.json.urls));
	check("authenticated 里带 ?token=（这正是「抄一次就能接入」的能力）",
		urlsResponse.json.urls.every((entry) => entry.authenticated.includes("token=stub-launch-token")),
		JSON.stringify(urlsResponse.json.urls.map((entry) => entry.authenticated)));

	// ------------------------------------------------------------------
	// G3 非回环 / 方法 / 未知路径
	// ------------------------------------------------------------------
	section("G3 设置页接口的边界：非回环 403、方法不对 405、未知路径 404（全部非 HTML）");
	const outside = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/state`, remoteAddress: "192.0.2.9" });
	check("非回环访问 → 403 text/plain 且正文正好是 loopback only",
		outside.status === 403 && String(outside.headers["content-type"]).startsWith("text/plain") && outside.body.trim() === "loopback only",
		`status=${outside.status} body=${JSON.stringify(outside.body)}`);
	check("非回环访问不泄漏任何状态（响应体里没有 enabled/devices）",
		!outside.body.includes("enabled") && !outside.body.includes("devices"));
	notHtml("非回环 403", { status: outside.status, headers: outside.headers, body: outside.body });
	const outsidePost = await localExchange(router, {
		method: "POST", url: `${internals.PLUGIN_ROUTE}/enabled`, remoteAddress: "::ffff:198.51.100.3", body: "{\"enabled\":false}",
	});
	check("非回环（IPv6 映射形式）也一律 403", outsidePost.status === 403, String(outsidePost.status));
	const loopbackV6 = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/state`, remoteAddress: "::1" });
	check("回环 IPv6（::1）放行", loopbackV6.status === 200, String(loopbackV6.status));
	const wrongMethod = await localExchange(router, { method: "PUT", url: `${internals.PLUGIN_ROUTE}/state` });
	check("GET-only 接口收到 PUT → 405 JSON（错误文案里写明只支持 GET/HEAD）",
		wrongMethod.status === 405 && wrongMethod.body.includes("只支持 GET/HEAD"), JSON.stringify(wrongMethod.body));
	notHtml("405 state", { status: wrongMethod.status, headers: wrongMethod.headers, body: wrongMethod.body });
	const unknown = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/nope` });
	check("未知路径 → 404 JSON（不是 HTML、也不是 fallback 的纯文本）",
		unknown.status === 404 && unknown.body.includes("unknown route"), JSON.stringify(unknown.body));
	notHtml("404 未知路径", { status: unknown.status, headers: unknown.headers, body: unknown.body });
	const wrongMethodDevices = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/devices` });
	check("GET /devices（只支持 POST）→ 405", wrongMethodDevices.status === 405, String(wrongMethodDevices.status));

	// ------------------------------------------------------------------
	// G4 设备增删改 + 错误分支
	// ------------------------------------------------------------------
	section("G4 POST/DELETE /plugin/remote/devices：增删改与错误分支（重复 id、非法 url…）");
	const added = await httpJson(`${base}/devices`, { method: "POST", body: { name: "nas", url: "http://192.0.2.77:19387" } });
	notHtml("POST devices（新增）", added);
	check("id 缺省时从名字派生（nas）并返回 device{id,name,url}",
		added.json.ok === true && added.json.device.id === "nas" && added.json.device.name === "nas"
		&& added.json.device.url === "http://192.0.2.77:19387"
		&& JSON.stringify(Object.keys(added.json.device).sort()) === JSON.stringify(["id", "name", "url"]),
		JSON.stringify(added.json));
	check("新设备立刻写进数据文件，且立刻有 /dev/nas 路由",
		readJsonFile(dataFile).devices.some((entry) => entry.id === "nas") && router.prefixes.has("/dev/nas"));
	const duplicate = await httpJson(`${base}/devices`, { method: "POST", body: { name: "nas", url: "http://192.0.2.78:19387" } });
	check("派生出的 id 已存在 → {ok:false, error: duplicate id…}（不误改别人的设备）",
		duplicate.json.ok === false && String(duplicate.json.error).includes("duplicate id"),
		JSON.stringify(duplicate.json));
	const badUrl = await httpJson(`${base}/devices`, { method: "POST", body: { id: "x", name: "坏地址", url: "ftp://192.0.2.4" } });
	check("非法 url（ftp）→ {ok:false, error…}", badUrl.json.ok === false && String(badUrl.json.error).includes("http/https"),
		JSON.stringify(badUrl.json));
	const noName = await httpJson(`${base}/devices`, { method: "POST", body: { url: "http://192.0.2.4:1" } });
	check("缺 name → {ok:false, error…}", noName.json.ok === false && String(noName.json.error).includes("name"), JSON.stringify(noName.json));
	const badId = await httpJson(`${base}/devices`, { method: "POST", body: { id: "bad id!", name: "x", url: "http://192.0.2.4:1" } });
	check("非法 id（带空格/感叹号）→ {ok:false, error…}", badId.json.ok === false && String(badId.json.error).includes("id 只允许"),
		JSON.stringify(badId.json));
	const badJson = await httpJson(`${base}/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
	check("请求体不是 JSON → 400 {ok:false}（不是 text/html）", badJson.status === 400 && badJson.json.ok === false, JSON.stringify(badJson.json));
	notHtml("POST devices 坏 JSON", badJson);
	const updated = await httpJson(`${base}/devices`, {
		method: "POST", body: { id: "nas", name: "设备C 改名", url: "http://192.0.2.79:19387", token: "nas-token-1" },
	});
	check("带已存在的 id → 修改（name/url 都变）", updated.json.ok === true && updated.json.device.name === "设备C 改名"
		&& updated.json.device.url === "http://192.0.2.79:19387", JSON.stringify(updated.json));
	check("带 token 的修改把 token 写进凭据服务（不是数据文件）",
		seedCredentials.setCalls.some(([ref, value]) => ref === internals.tokenRefFor("192.0.2.79:19387") && value === "nas-token-1")
		&& !readFileSync(dataFile, "utf8").includes("nas-token-1"),
		JSON.stringify(seedCredentials.setCalls.map(([ref]) => ref)));
	const asciiDerived = await httpJson(`${base}/devices`, { method: "POST", body: { name: "中文名字台", url: "http://192.0.2.80:19387" } });
	check("中文名字派生不出 id → 退而用 url 的 host 当 id（192.0.2.80）",
		asciiDerived.json.ok === true && asciiDerived.json.device.id === "192.0.2.80", JSON.stringify(asciiDerived.json));
	const deleted = await httpJson(`${base}/devices/nas`, { method: "DELETE" });
	check("DELETE 已存在的设备 → {ok:true}，路由与数据文件同时清掉",
		deleted.json.ok === true && !router.prefixes.has("/dev/nas")
		&& !readJsonFile(dataFile).devices.some((entry) => entry.id === "nas"),
		JSON.stringify(deleted.json));
	check("删除设备会连它的凭据 ref 一起撤掉（unset 被调用）",
		seedCredentials.unsetCalls.includes(internals.tokenRefFor("192.0.2.79:19387")), JSON.stringify(seedCredentials.unsetCalls));
	const deleteUnknown = await httpJson(`${base}/devices/ghost`, { method: "DELETE" });
	check("DELETE 不存在的设备 → {ok:false, error: unknown device}",
		deleteUnknown.json.ok === false && String(deleteUnknown.json.error).includes("unknown device"), JSON.stringify(deleteUnknown.json));
	await httpJson(`${base}/devices/192.0.2.80`, { method: "DELETE" });

	// ------------------------------------------------------------------
	// G5 连通性测试
	// ------------------------------------------------------------------
	section("G5 POST /plugin/remote/test/<id>：连通性测试只回报状态码与耗时");
	const testOk = await httpJson(`${base}/test/self`, { method: "POST", body: {} });
	notHtml("POST test（成功）", testOk);
	check("活的设备 → ok=true 且 status 是数字（401/200 都算活着）、ms 是数字",
		testOk.json.ok === true && Number.isInteger(testOk.json.status) && typeof testOk.json.ms === "number"
		&& testOk.json.error === null,
		JSON.stringify(testOk.json));
	check("连通性测试走的是该设备的 url（带 Host/Origin 改写与 cookie jar）",
		stub.requests.some((request) => request.url === "/" && request.host === stub.authority));
	const testDown = await httpJson(`${base}/test/down`, { method: "POST", body: {} });
	check("连不上的设备 → ok=false、status=null、error 有内容",
		testDown.json.ok === false && testDown.json.status === null && typeof testDown.json.error === "string" && testDown.json.error !== "",
		JSON.stringify(testDown.json));
	const testUnknown = await httpJson(`${base}/test/ghost`, { method: "POST", body: {} });
	check("不存在的设备 → ok=false + unknown device", testUnknown.json.ok === false
		&& String(testUnknown.json.error).includes("unknown device"), JSON.stringify(testUnknown.json));
	const stateAfterDown = (await httpJson(`${base}/state`)).json;
	check("体检里的 reachable/lastError 被连通性测试更新（down 那台）",
		stateAfterDown.devices.find((entry) => entry.id === "down")?.reachable === false,
		JSON.stringify(stateAfterDown.devices.find((entry) => entry.id === "down")));

	// ------------------------------------------------------------------
	// G6 hello：垫片报到
	// ------------------------------------------------------------------
	section("G6 POST /plugin/remote/hello：只记时间、不接受任何 body");
	const before = (await httpJson(`${base}/state`)).json;
	check("报到之前 injectionSeen=false、lastHelloAt=null",
		before.diagnostics.injectionSeen === false && before.diagnostics.lastHelloAt === null,
		JSON.stringify([before.diagnostics.injectionSeen, before.diagnostics.lastHelloAt]));
	const hello = await localExchange(router, { method: "POST", url: `${internals.PLUGIN_ROUTE}/hello` });
	notHtml("POST hello", hello);
	check("无 body 的 POST → {ok:true}", hello.status === 200 && hello.body.includes("\"ok\":true"), JSON.stringify(hello.body));
	const after = (await httpJson(`${base}/state`)).json;
	check("报到之后 injectionSeen=true 且 lastHelloAt 是 ISO 时间",
		after.diagnostics.injectionSeen === true && /^\d{4}-\d{2}-\d{2}T/u.test(String(after.diagnostics.lastHelloAt)),
		JSON.stringify([after.diagnostics.injectionSeen, after.diagnostics.lastHelloAt]));
	const helloAgain = await localExchange(router, { method: "POST", url: `${internals.PLUGIN_ROUTE}/hello` });
	const afterAgain = (await httpJson(`${base}/state`)).json;
	check("重复报到只更新时间（injectionSeen 保持 true）",
		helloAgain.status === 200 && afterAgain.diagnostics.injectionSeen === true
		&& afterAgain.diagnostics.lastHelloAt >= after.diagnostics.lastHelloAt,
		String(afterAgain.diagnostics.lastHelloAt));
	const helloWithBody = await localExchange(router, {
		method: "POST", url: `${internals.PLUGIN_ROUTE}/hello`, headers: { "content-type": "application/json" }, body: "{\"x\":1}",
	});
	check("带 body 的 hello → 400 且**不**当报到（\"不接受任何 body\"）",
		helloWithBody.status === 400 && helloWithBody.body.includes("不接受请求体"), JSON.stringify(helloWithBody.body));
	notHtml("POST hello 带 body", helloWithBody);
	const helloGet = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/hello` });
	check("GET hello → 405（报到只认 POST）", helloGet.status === 405, String(helloGet.status));

	// ------------------------------------------------------------------
	// G7 enabled 活着开关
	// ------------------------------------------------------------------
	section("G7 POST /plugin/remote/enabled：软开关（路由受门控、注入不受门控、设置页仍可读）");
	const disabled = await httpJson(`${base}/enabled`, { method: "POST", body: { enabled: false } });
	notHtml("POST enabled(false)", disabled);
	check("POST enabled(false) → {ok:true, enabled:false}", disabled.json.ok === true && disabled.json.enabled === false,
		JSON.stringify(disabled.json));
	check("enabled=false 时**不注册任何 /dev/** 路由**（HTTP 与 upgrade 都没了）",
		router.devPrefixes().length === 0 && router.upgrades.size === 0,
		`prefixes=${router.devPrefixes().join(",")} upgrades=${[...router.upgrades.keys()].join(",")}`);
	check("enabled=false 时 /dev/self/api/x 落到 fallback（404，插件完全不拦）",
		(await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/x`)).status === 404);
	check("enabled=false 也写进了数据文件（重启后仍然停用）", readJsonFile(dataFile).enabled === false);

	// —— 软开关的关键：注入**照旧**（桌面壳把注入行缓存到窗口生命周期，撤监听没用）——
	check("enabled=false 时**注入行仍然存在**（tapIndex 那条通道还在）", router.taps.length === 1,
		`taps=${String(router.taps.length)}`);
	const offRows = [];
	router.emit("webserver/index-inject", offRows);
	check("enabled=false 时 index-inject 仍然推一行 script（桌面壳那条通道也还在）",
		offRows.length === 1 && offRows[0].kind === "script" && offRows[0].placement === "head",
		JSON.stringify(offRows.map((row) => `${row.kind}/${row.placement}`)));
	const offText = typeof offRows[0]?.text === "string" ? offRows[0].text : "";
	check("停用时注入的脚本里 enabled=false（垫片据此不同步 patch、不挂任何 UI）",
		offText.includes('"enabled":false') || offText.includes("enabled:!1"),
		offText.slice(offText.lastIndexOf("})("), offText.lastIndexOf("})(") + 160));
	check("停用时注入的脚本仍带自检（statePath + 清键 + 撤设备表 + 停探测 + 哨兵刷新）",
		offText.includes(internals.STATE_PATH) && offText.includes("checkHostState")
		&& offText.includes("clearStoredSelection") && offText.includes("retractDeviceTable")
		&& offText.includes("healStop") && offText.includes("reloadOnce")
		&& offText.includes(internals.SHIM_SELFTEST_SENTINEL_KEY));
	check("停用时 /dev/** 路由数与升级路由数都是 0（注入与路由是两件事）",
		router.devPrefixes().length === 0 && router.upgrades.size === 0);

	// —— 状态接口与 /urls 在停用时仍然可用（体检页要能读、能改回来）——
	const disabledState = await httpJson(`http://127.0.0.1:${host.port}${internals.PLUGIN_ROUTE}/state`);
	notHtml("GET state（停用中）", disabledState);
	check("停用时 GET /state 仍然 200：enabled=false、proxyRoutes=0",
		disabledState.status === 200 && disabledState.json.enabled === false
		&& disabledState.json.diagnostics.proxyRoutes === 0,
		`status=${String(disabledState.status)} enabled=${String(disabledState.json.enabled)} routes=${String(disabledState.json.diagnostics?.proxyRoutes)}`);
	check("停用时 notes 写明「路由撤了、设置页仍可读」（说明书类长文案已搬 README）",
		disabledState.json.diagnostics.notes.some((note) => note.includes("插件已停用（enabled=false）") && note.includes("/dev/**"))
		&& disabledState.json.diagnostics.notes.some((note) => note.includes("改回 true 即可恢复"))
		&& !disabledState.json.diagnostics.notes.some((note) => note.includes("软开关：停用只停止代理与注入"))
		&& !disabledState.json.diagnostics.notes.some((note) => note.includes("垫片脚本**照旧注入**")),
		JSON.stringify(disabledState.json.diagnostics.notes.filter((note) => note.includes("停用"))));const disabledUrls = await httpJson(`http://127.0.0.1:${host.port}${internals.PLUGIN_ROUTE}/urls`);
	notHtml("GET urls（停用中）", disabledUrls);
	check("停用时 GET /urls 仍然 200（带 token 的地址还能查）",
		disabledUrls.status === 200 && Array.isArray(disabledUrls.json.urls) && disabledUrls.json.urls.length > 0,
		`status=${String(disabledUrls.status)} urls=${String(disabledUrls.json.urls?.length)}`);
	check("停用后 diagnostics.injectionSeen 的历史仍然保留（停用不会抹掉「报到过」这件事）",
		disabledState.json.diagnostics.injectionSeen === true
		&& disabledState.json.diagnostics.notes.some((note) => note.includes("插件已停用")),
		JSON.stringify([disabledState.json.diagnostics.injectionSeen, disabledState.json.diagnostics.notes.filter((note) => note.includes("停用"))]));

	const reenabled = await httpJson(`${base}/enabled`, { method: "POST", body: { enabled: true } });
	check("改回 true → {ok:true, enabled:true} 且路由/注入立刻回来（不用重启）",
		reenabled.json.ok === true && reenabled.json.enabled === true
		&& router.devPrefixes().length === 4 && router.upgrades.size === 4 && router.taps.length === 1,
		`prefixes=${router.devPrefixes().length} upgrades=${router.upgrades.size} taps=${router.taps.length}`);
	const onRows = [];
	router.emit("webserver/index-inject", onRows);
	check("改回 true 后注入的脚本里 enabled=true 且设备表回来了",
		onRows.length === 1 && (onRows[0].text.includes('"enabled":true') || onRows[0].text.includes("enabled:!0"))
		&& onRows[0].text.includes(internals.STORAGE_KEYS.current),
		String(onRows[0]?.text?.includes('"enabled":true')));
	check("恢复后代理立刻可用", (await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/back`)).status === 200);
	const badEnabled = await httpJson(`${base}/enabled`, { method: "POST", body: { enabled: "yes" } });
	check("enabled 不是布尔 → 400 {ok:false}", badEnabled.status === 400 && badEnabled.json.ok === false, JSON.stringify(badEnabled.json));

	// ------------------------------------------------------------------
	// G8 数据文件热重载（手改文件也活着生效）
	// ------------------------------------------------------------------
	section("G8 手改数据文件（enabled=false）→ 1 秒内活着生效（不用重启）");
	const handEdited = readJsonFile(dataFile);
	handEdited.enabled = false;
	handEdited.devices = handEdited.devices.filter((entry) => entry.id !== "ws");
	writeFileSync(dataFile, `${JSON.stringify(handEdited, null, 2)}\n`, "utf8");
	await sleep(1200);
	const afterReload = (await httpJson(`${base}/state`)).json;
	check("手改的 enabled=false 生效", afterReload.enabled === false, String(afterReload.enabled));
	check("手改删掉的设备也生效（/dev/ws 路由没了）", afterReload.devices.every((entry) => entry.id !== "ws")
		&& !router.prefixes.has("/dev/ws"));
	check("停用后 /dev/self/api/x 又是 404", (await httpGet(`http://127.0.0.1:${host.port}/dev/self/api/x`)).status === 404);
	handEdited.enabled = true;
	handEdited.devices.push({ id: "ws", name: "假远端 WS", url: `http://127.0.0.1:${stub.port}` });
	writeFileSync(dataFile, `${JSON.stringify(handEdited, null, 2)}\n`, "utf8");
	await sleep(1200);
	const afterReload2 = (await httpJson(`${base}/state`)).json;
	check("手改回 true 并加回设备 → 活着恢复（路由与设备表都跟上）",
		afterReload2.enabled === true && afterReload2.devices.some((entry) => entry.id === "ws")
		&& router.prefixes.has("/dev/ws"),
		JSON.stringify(afterReload2.devices.map((entry) => entry.id)));

	section("G8b 数据文件坏掉：不种子、不覆盖，但体检页要报出来");
	const brokenFile = freshDataFile();
	writeFileSync(brokenFile, "{ 这不是 JSON", "utf8");
	const brokenRouter = createRouter();
	apply(brokenRouter.ctx, {
		dataFile: brokenFile,
		devices: [{ id: "x", name: "种子", url: "http://192.0.2.4:1" }],
	}, { muxPath: "/api/remote.mux" });
	const brokenHost = await startFakeHost(brokenRouter);
	const brokenState = (await httpJson(`http://127.0.0.1:${brokenHost.port}${internals.PLUGIN_ROUTE}/state`)).json;
	check("坏掉的数据文件没有被种子覆盖（用户还能自己修）", readFileSync(brokenFile, "utf8") === "{ 这不是 JSON",
		readFileSync(brokenFile, "utf8"));
	check("坏数据文件时设备表按空处理（没有 /dev/** 路由）", brokenRouter.devPrefixes().length === 0);
	check("体检 notes 里报出数据文件无法解析", brokenState.diagnostics.notes.some((note) => note.includes("无法解析")),
		JSON.stringify(brokenState.diagnostics.notes.filter((note) => note.includes("无法解析"))));
	check("日志里有对应告警", brokenRouter.logs.some((line) => line.includes("存在但无法解析")),
		brokenRouter.logs.find((line) => line.includes("无法解析")) ?? "(无)");
	await brokenHost.close();

	// ------------------------------------------------------------------
	// G9 mux 路径的动态发现（成功 / 失败两条分支）
	// ------------------------------------------------------------------
	section("G9 REMOTE_STREAM_MUX_PATH 的动态提取：从本机 client bundle 里读，不硬编码");
	check("提取器认得真源码里那一行（夹具逐字抄自 @deepseek-ai/dsh-api-gateway/lib/client.js）",
		internals.extractMuxPath(REAL_BUNDLE_FIXTURE) === "/api/remote.mux",
		String(internals.extractMuxPath(REAL_BUNDLE_FIXTURE)));
	check("提取器兼容单引号 / 反引号 / 无 const / 多空格",
		internals.extractMuxPath("REMOTE_STREAM_MUX_PATH = '/x/remote.mux'") === "/x/remote.mux"
		&& internals.extractMuxPath("let  REMOTE_STREAM_MUX_PATH=`/y.mux`") === "/y.mux");
	check("提取器对没有这个常量的 bundle 返回 null", internals.extractMuxPath("const A = 1;") === null);
	check("提取器对非法值（带空格/引号）返回 null", internals.extractMuxPath("REMOTE_STREAM_MUX_PATH = \"/a b\"") === null);
	check("候选地址归一：接受 plugins/??… 与 /plugins/…，拒绝 .map 与绝对 URL",
		internals.normalizeCandidate("plugins/??x/client.js&rev=1") === "/plugins/??x/client.js&rev=1"
		&& internals.normalizeCandidate("/plugins/??x/client.js&rev=1") === "/plugins/??x/client.js&rev=1"
		&& internals.normalizeCandidate("/plugins/??x/client.js.map&rev=1") === null
		&& internals.normalizeCandidate("http://evil/plugins/x") === null);

	const bundleServer = await startFakeLocalBundle();
	const discoveryRouter = createRouter({
		injections: [{ kind: "script-preload", src: "plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=abcdef123456" }],
	});
	discoveryRouter.ctx.webServer.port = bundleServer.port;
	const stubRuntime = { ctx: discoveryRouter.ctx, mux: { indexNote: null, lastCandidateError: null } };
	const fromInjections = await internals.discoverMuxPath(stubRuntime);
	check("成功分支 1：从 collectIndexInjections 的行里拿到候选地址并抽出 mux 路径",
		fromInjections.path === "/api/remote.mux" && String(fromInjections.source).includes("index-inject"),
		JSON.stringify({ path: fromInjections.path, source: fromInjections.source }));
	check("成功分支 1：真的去 GET 了那个 client bundle（不是靠猜）", bundleServer.hits.includes(bundleServer.url),
		JSON.stringify(bundleServer.hits));
	const indexOnlyRouter = createRouter();
	indexOnlyRouter.ctx.webServer.port = bundleServer.port;
	const fromIndex = await internals.discoverMuxPath({ ctx: indexOnlyRouter.ctx, mux: { indexNote: null, lastCandidateError: null } });
	check("成功分支 2：注入表里没有时，退回读本机首页（/ 里的 plugins/… 地址）",
		fromIndex.path === "/api/remote.mux" && String(fromIndex.source).includes("index-html"),
		JSON.stringify({ path: fromIndex.path, source: fromIndex.source }));
	const badBundleServer = await startFakeLocalBundle({ bundle: "const NOT_THE_ONE = 1;\n" });
	const badRouter = createRouter({ injections: [{ kind: "script-src", src: "plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=deadbeef0000" }] });
	badRouter.ctx.webServer.port = badBundleServer.port;
	const badResult = await internals.discoverMuxPath({ ctx: badRouter.ctx, mux: { indexNote: null, lastCandidateError: null } });
	check("失败分支 1：候选 bundle 里没有那个常量 → path=null 且 error 说清楚",
		badResult.path === null && String(badResult.error).includes(internals.MUX_CONST_NAME), JSON.stringify(badResult.error));
	const authIndexServer = await startFakeLocalBundle({ indexStatus: 401 });
	const authRouter = createRouter();
	authRouter.ctx.webServer.port = authIndexServer.port;
	const authResult = await internals.discoverMuxPath({ ctx: authRouter.ctx, mux: { indexNote: null, lastCandidateError: null } });
	check("失败分支 2：一个候选地址都拿不到（首页 401）→ path=null 且 error 提到 401",
		authResult.path === null && String(authResult.error).includes("401"), String(authResult.error));
	await Promise.all([bundleServer.close(), badBundleServer.close(), authIndexServer.close()]);

	// 插件级：发现失败 → 无升级路由 + muxPathFound:false + 体检页写明终端通道不可用
	const failFile = freshDataFile();
	const failRouter = createRouter();
	const readySignal = (() => {
		let resolve;
		const promise = new Promise((r) => { resolve = r; });
		return { promise, resolve };
	})();
	apply(failRouter.ctx, {
		dataFile: failFile,
		devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}` }],
	}, {
		discoverMuxPath: async () => null,
		muxRetryDelaysMs: [0, 10, 10, 10, 10],
		onReady: (info_) => readySignal.resolve(info_),
	});
	const failHost = await startFakeHost(failRouter);
	const readyInfo = await readySignal.promise;
	check("发现失败：onReady 收到 muxPathFound=false + 原因",
		readyInfo.muxPathFound === false && typeof readyInfo.error === "string", JSON.stringify(readyInfo));
	check("发现失败：**一条 upgrade 路由都不注册**（终端通道标记为不可用）", failRouter.upgrades.size === 0,
		[...failRouter.upgrades.keys()].join(","));
	check("发现失败：HTTP 代理路由照常注册（对话/代理仍可用）", failRouter.prefixes.has("/dev/self"));
	const failState = (await httpJson(`http://127.0.0.1:${failHost.port}${internals.PLUGIN_ROUTE}/state`)).json;
	check("发现失败：/dev/self/api/x 仍然被代理到远端（拿到远端的 401，而不是本插件的 404/502）",
		(await httpGet(`http://127.0.0.1:${failHost.port}/dev/self/api/x-after-fail`)).status === 401);
	check("发现失败：体检页 muxPathFound=false、muxPath=null、proxyRoutes 只剩 HTTP 那 1 条",
		failState.diagnostics.muxPathFound === false && failState.diagnostics.muxPath === null
		&& failState.diagnostics.proxyRoutes === 1,
		JSON.stringify(failState.diagnostics));
	check("发现失败：notes 里明确写「终端通道不可用」且说明 HTTP 代理/对话不受影响",
		failState.diagnostics.notes.some((note) => note.includes("未能从本机 client bundle 提取") && note.includes("不可用")),
		JSON.stringify(failState.diagnostics.notes.filter((note) => note.includes("提取"))));
	check("发现失败：日志里留了可排查的告警（含常量名）",
		failRouter.logs.some((line) => line.includes(internals.MUX_CONST_NAME)), failRouter.logs.at(-1) ?? "(无)");
	await failHost.close();

	// ------------------------------------------------------------------
	// G10 I1 推广 + 只读访问配置 + 凭据服务缺失时的退化路线
	// ------------------------------------------------------------------
	section("G10 I1 推广：插件所有接口的响应都不是 text/html（逐条跑一遍）");
	const probes = [
		["GET state", await httpJson(`${base}/state`)],
		["GET urls", await httpJson(`${base}/urls`)],
		["POST devices 成功", await httpJson(`${base}/devices`, { method: "POST", body: { name: "probe", url: "http://192.0.2.99:19387" } })],
		["DELETE devices/ghost", await httpJson(`${base}/devices/ghost`, { method: "DELETE" })],
		["POST test/ghost", await httpJson(`${base}/test/ghost`, { method: "POST", body: {} })],
		["POST enabled 坏值", await httpJson(`${base}/enabled`, { method: "POST", body: { enabled: 1 } })],
		["POST hello", await localExchange(router, { method: "POST", url: `${internals.PLUGIN_ROUTE}/hello` })],
		["POST access 空请求体（400）", await httpJson(`${base}/access`, { method: "POST", body: {} })],
		["GET 未知路径", await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/zzz` })],
		["PUT state（405）", await localExchange(router, { method: "PUT", url: `${internals.PLUGIN_ROUTE}/state` })],
		["非回环 403", await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/state`, remoteAddress: "198.51.100.11" })],
		["/dev/self/（I1 拦截）", await httpGet(`http://127.0.0.1:${host.port}/dev/self/`)],
		["/dev/down/api/x（502）", await httpGet(`http://127.0.0.1:${host.port}/dev/down/api/x`)],
	];
	for (const [label, exchange] of probes) notHtml(label, exchange);
	const types = probes.map(([label, exchange]) => `${label}=${String(exchange.headers["content-type"] ?? exchange.headers.get?.("content-type") ?? "")}`);
	check("上面每一条都被 I1 推广覆盖（没有一条是 text/html）",
		probes.every(([, exchange]) => !internals.isHtmlContentType(String(exchange.headers["content-type"] ?? exchange.headers.get?.("content-type") ?? ""))),
		types.join(" | "));
	await httpJson(`${base}/devices/probe`, { method: "DELETE" });

	section("G10b「配置」块：POST /plugin/remote/access 用官方 ctx.configEditor.edit 写 profile");

	/**
	 * 假的 config-editor：只实现本插件依赖的两个形状。
	 *  - `entries()`：两行 Loader entry（webserver / connection），形状照官方 Loader entry 的最小面
	 *    （`entry.options.id` / `entry.options.config`）；
	 *  - `edit(entry, change)`：照官方语义 —— `change(当前 config, 继承值)` 返回什么就把那一行
	 *    的 config **整行替换**成什么（真实现是写 profile patch 的 YAML 再让 Loader 重载）。
	 * `remountOnEdit: true` 模拟最难的那种真实行为：一次 write 之后 webserver/connection 被**重新激活**，
	 * 于是 entries 里的对象全换成新对象（旧对象再喂给 edit() 会抛 "Configuration entry is no longer available"）
	 * —— 本插件必须重新取 entry 才能写第二行。
	 */
	function createFakeConfigEditor(options = {}) {
		const entries = [
			{
				options: {
					id: "webserver",
					name: "@deepseek-ai/dsh-host-webserver",
					config: options.webserver ?? { host: "0.0.0.0", port: 19387, compression: "gzip", compressionLevel: 1, compressionThresholdBytes: 1024 },
				},
			},
			{
				options: {
					id: "connection",
					name: "@deepseek-ai/dsh-client-connection",
					config: options.connection ?? { trustedHosts: ["192.0.2.4"], cookieMaxAgeDays: 3650 },
				},
			},
		];
		if (options.dropWebserverRow === true) entries.shift();
		const calls = [];
		const remount = () => {
			if (options.remountOnEdit !== true) return;
			for (let index = 0; index < entries.length; index += 1) entries[index] = { options: { ...entries[index].options } };
		};
		return {
			entries,
			calls,
			editor: {
				entries: () => (options.entriesBroken === true ? null : entries),
				edit: async (entry, change) => {
					const id = entry.options.id;
					// 官方语义：entry 已经不在 loader 里（被重新装配过）→ 直接抛，不能拿旧对象写。
					const fresh = entries.includes(entry);
					calls.push({ id, entry, fresh });
					if (!fresh) throw new Error("Configuration entry is no longer available");
					if (options.failOn === id) throw new Error(options.failMessage ?? "写盘失败");
					entry.options.config = change(entry.options.config, {});
					calls[calls.length - 1].written = JSON.parse(JSON.stringify(entry.options.config));
					remount();
				},
			},
		};
	}

	/** 造一台「配置」块能用的宿主（带假 config-editor，或 rawEditor 直接指定）。 */
	async function accessHost(options = {}) {
		const fake = options.fakeEditor === undefined ? undefined : createFakeConfigEditor(options.fakeEditor);
		const configEditor = fake === undefined ? options.rawEditor : fake.editor;
		const router_ = createRouter(configEditor === undefined ? {} : { configEditor });
		apply(router_.ctx, { dataFile: freshDataFile(), ...(options.config ?? {}) }, { muxPath: "/api/remote.mux" });
		const bound = await startFakeHost(router_);
		return {
			router: router_,
			host: bound,
			base: `http://127.0.0.1:${bound.port}${internals.PLUGIN_ROUTE}`,
			fake,
			close: () => bound.close(),
		};
	}

	{
		const page = await accessHost({ fakeEditor: { remountOnEdit: true } });
		const saved = await httpJson(`${page.base}/access`, {
			method: "POST",
			body: { port: 19400, trustedHosts: [" 192.0.2.4:19400 ", "a.example.com", "a.example.com", ""] },
		});
		notHtml("POST access 成功", saved);
		check("保存成功 → 200 {ok:true,restartRequired:true,written:{host,port,trustedHosts,cookieMaxAgeDays}}",
			saved.status === 200 && saved.json.ok === true && saved.json.restartRequired === true
			&& saved.json.written.host === "0.0.0.0" && saved.json.written.port === 19400
			&& JSON.stringify(saved.json.written.trustedHosts) === JSON.stringify(["192.0.2.4:19400", "a.example.com"])
			&& saved.json.written.cookieMaxAgeDays === 3650,
			JSON.stringify(saved.json));
		const callsOf = (id) => page.fake.calls.filter((call) => call.id === id);
		check("两行都写了，且顺序是 connection → webserver（webserver 的重新激活会关掉所有连接，所以放最后）",
			JSON.stringify(page.fake.calls.map((call) => call.id)) === JSON.stringify(["connection", "webserver"]),
			JSON.stringify(page.fake.calls.map((call) => call.id)));
		check("webserver 那行：host 固定写成 0.0.0.0、port 改成新值，compression 三件套**一个都没丢**（整行替换语义下最容易丢的东西）",
			callsOf("webserver")[0].written.host === "0.0.0.0" && callsOf("webserver")[0].written.port === 19400
			&& callsOf("webserver")[0].written.compression === "gzip"
			&& callsOf("webserver")[0].written.compressionLevel === 1
			&& callsOf("webserver")[0].written.compressionThresholdBytes === 1024,
			JSON.stringify(callsOf("webserver")[0].written));
		check("connection 那行：trustedHosts 去空白/去重后写入，cookieMaxAgeDays 原样保留",
			JSON.stringify(callsOf("connection")[0].written.trustedHosts) === JSON.stringify(["192.0.2.4:19400", "a.example.com"])
			&& callsOf("connection")[0].written.cookieMaxAgeDays === 3650,
			JSON.stringify(callsOf("connection")[0].written));
		check("入口地址的**首尾空白是修好而不是拒收**（粘贴常见）：' 192.0.2.4:19400 ' → '192.0.2.4:19400'",
			callsOf("connection")[0].written.trustedHosts[0] === "192.0.2.4:19400");
		check("两笔写入用的都是**当时 loader 里的** entry（假的 config-editor 照官方语义：旧对象会抛 Configuration entry is no longer available）",
			page.fake.calls.length === 2 && page.fake.calls.every((call) => call.fresh === true),
			JSON.stringify(page.fake.calls.map((call) => [call.id, call.fresh])));
		const beforeAgain = page.fake.calls.length;
		const again = await httpJson(`${page.base}/access`, {
			method: "POST",
			body: { port: 19400, trustedHosts: ["192.0.2.4:19400", "a.example.com"] },
		});
		check("再保存一次同样的值 → 仍然 200，但**一行都不重写**（端口没变就不重启监听）",
			again.status === 200 && page.fake.calls.length === beforeAgain,
			`${String(again.status)} calls=${String(page.fake.calls.length - beforeAgain)}`);
		check("有 config-editor 时 access.writable === true（客户端半与体检据此判断）",
			(await httpJson(`${page.base}/state`)).json.access.writable === true);
		check("GET /access → 405（只收 POST）", (await httpJson(`${page.base}/access`)).status === 405);
		await page.close();
	}

	{
		// 校验：非法值一律 400 + {ok:false}，而且**一行都不写**。
		const page = await accessHost({ fakeEditor: {} });
		const rejections = [
			["端口 0", { port: 0 }],
			["端口 65536", { port: 65536 }],
			["端口不是数", { port: "abc" }],
			["端口有小数", { port: 19387.5 }],
			["端口带空白", { port: " 19387 " }],
			["端口是 null（等于没给）", { port: null }],
			["trustedHosts 不是数组", { trustedHosts: "a.example.com" }],
			["trustedHosts 里有非字符串", { trustedHosts: [123] }],
			["入口地址带协议前缀", { trustedHosts: ["http://a.example.com"] }],
			["入口地址带路径", { trustedHosts: ["a.example.com/x"] }],
			["入口地址带用户名", { trustedHosts: ["user@a.example.com"] }],
			["入口地址中间有空格", { trustedHosts: ["a b.example.com"] }],
			["入口地址端口补零", { trustedHosts: ["a.example.com:019387"] }],
			["入口地址用 0x 写法", { trustedHosts: ["0x7f.0.0.1"] }],
			["入口地址写网段（CIDR）", { trustedHosts: ["192.0.2.0/24"] }],
			["入口地址写通配符", { trustedHosts: ["192.0.2.*.*"] }],
			["入口地址写 192.0.2.4/32", { trustedHosts: ["192.0.2.4/32"] }],
			["超过 200 条", { trustedHosts: Array.from({ length: 201 }, (_value, index) => `host${String(index)}.example`) }],
			["两个字段都没有", {}],
		];
		for (const [label, body] of rejections) {
			const response = await httpJson(`${page.base}/access`, { method: "POST", body });
			check(`拒绝：${label} → 400 {ok:false} 且原因是中文`,
				response.status === 400 && response.json.ok === false && /[\u4e00-\u9fa5]/u.test(String(response.json.error)),
				`${String(response.status)} ${String(response.json?.error ?? "").slice(0, 70)}`);
		}
		check("校验失败时**一行都没写**（绝不半截改 profile）", page.fake.calls.length === 0, JSON.stringify(page.fake.calls));
		// 这两种"像网段"的写法必须给出**说清楚为什么**的中文原因（`192.0.2.*.*` 官方会收下但永远不匹配 → 静默陷阱）。
		const cidr = await httpJson(`${page.base}/access`, { method: "POST", body: { trustedHosts: ["192.0.2.0/24"] } });
		const wildcard = await httpJson(`${page.base}/access`, { method: "POST", body: { trustedHosts: ["192.0.2.*.*"] } });
		check("网段（CIDR）被拒，并写明「不支持网段/CIDR」",
			cidr.status === 400 && String(cidr.json.error).includes("不支持网段"), String(cidr.json?.error ?? "").slice(0, 90));
		check("通配符被拒，并写明「不支持通配符」+ 给出正确写法示例（`192.0.2.*.*` 官方会静默收下但永远不匹配）",
			wildcard.status === 400 && String(wildcard.json.error).includes("不支持通配符") && String(wildcard.json.error).includes("192.0.2.4"),
			String(wildcard.json?.error ?? "").slice(0, 120));
		const protocol = await httpJson(`${page.base}/access`, { method: "POST", body: { trustedHosts: ["http://a.example.com"] } });
		check("带 http:// 前缀的给出专门的原因（不是被当成「网段」含糊打发）",
			protocol.status === 400 && String(protocol.json.error).includes("协议前缀"), String(protocol.json?.error ?? "").slice(0, 90));
		const onlyHosts = await httpJson(`${page.base}/access`, { method: "POST", body: { trustedHosts: ["a.example.com"] } });
		check("只给 trustedHosts（不给 port）→ 只写 connection 一行，webserver 一行都不动",
			onlyHosts.status === 200 && JSON.stringify(page.fake.calls.map((call) => call.id)) === JSON.stringify(["connection"]),
			JSON.stringify([onlyHosts.status, page.fake.calls.map((call) => call.id)]));
		// 0.9.0：入口地址**允许留空**（官方 trustedHosts 的默认就是空数组；配合「对外入口」edge 时留空才是标准形态）。
		const emptyHosts = await httpJson(`${page.base}/access`, { method: "POST", body: { trustedHosts: [] } });
		check("入口地址留空 → 200 且真的写进 profile 的是空数组（官方默认；配合 edge 时用）",
			emptyHosts.status === 200
			&& JSON.stringify(page.fake.entries.find((row) => row.options.id === "connection").options.config.trustedHosts) === "[]",
			JSON.stringify([emptyHosts.status, page.fake.entries.find((row) => row.options.id === "connection").options.config.trustedHosts]));
		const blankHosts = await httpJson(`${page.base}/access`, { method: "POST", body: { trustedHosts: ["", "  "] } });
		check("入口地址全是空行 → 同样按空数组处理（不报错、不写空白项）",
			blankHosts.status === 200
			&& JSON.stringify(page.fake.entries.find((row) => row.options.id === "connection").options.config.trustedHosts) === "[]",
			String(blankHosts.status));
		check("`host` 不是请求体里的字段：传了也一律被忽略（绑定地址固定 0.0.0.0，界面不显示它）",
			page.fake.entries.find((row) => row.options.id === "webserver").options.config.host === "0.0.0.0");
		await page.close();
	}

	{
		// 「分叉带走的条数」（0.8.0）：设置页「配置」块里的第三格，但**写数据文件、不写 profile**。
		const tailFile = freshDataFile();
		const tailRouter = createRouter();
		apply(tailRouter.ctx, { dataFile: tailFile }, { muxPath: "/api/remote.mux" });
		const tailHost = await startFakeHost(tailRouter);
		const tailBase = `http://127.0.0.1:${tailHost.port}${internals.PLUGIN_ROUTE}`;

		const onlyTail = await httpJson(`${tailBase}/access`, { method: "POST", body: { forkTailN: 35 } });
		notHtml("POST access 只改分叉条数", onlyTail);
		check("只改「分叉带走的条数」→ 200 {ok:true,forkTailN:35}：不要求重启、也不需要 config-editor",
			onlyTail.status === 200 && onlyTail.json.ok === true && onlyTail.json.forkTailN === 35
			&& onlyTail.json.restartRequired !== true,
			JSON.stringify(onlyTail.json));
		const tailState = (await httpJson(`${tailBase}/state`)).json;
		check("存下来的值立刻能从 state.access.forkTailN 读到（设置页预填的就是它；不用重启）",
			tailState.access.forkTailN === 35 && tailState.diagnostics.fork.tailN === 35,
			JSON.stringify({ access: tailState.access.forkTailN, fork: tailState.diagnostics.fork }));
		const onDisk = JSON.parse(readFileSync(tailFile, "utf8"));
		check("数据文件里真的写出了 forkTailN:35（临时文件 + 改名落盘，下次启动/热重载都读得到）",
			onDisk.forkTailN === 35, JSON.stringify(onDisk));
		check("体检 notes 里那一格只报当前值（35）+ 可用范围，不再带说明书文案",
			tailState.diagnostics.notes.some((note) => note.includes("带走的条数 = 35") && note.includes("1..200")),
			JSON.stringify(tailState.diagnostics.notes.filter((note) => note.includes("分叉到")).map((note) => note.slice(0, 40))));

		for (const [label, body] of [
			["0（小于下限）", { forkTailN: 0 }],
			["201（超上限）", { forkTailN: 201 }],
			["小数", { forkTailN: 1.5 }],
			["字符串", { forkTailN: "35" }],
			["布尔", { forkTailN: true }],
		]) {
			const rejected = await httpJson(`${tailBase}/access`, { method: "POST", body });
			check(`分叉条数非法：${label} → 400 {ok:false} + 中文原因`,
				rejected.status === 400 && rejected.json.ok === false && String(rejected.json.error).includes("分叉带走的条数"),
				`${String(rejected.status)} ${String(rejected.json?.error ?? "").slice(0, 80)}`);
		}
		check("非法值被拒之后数据文件仍是 35（半个字节都没写）",
			JSON.parse(readFileSync(tailFile, "utf8")).forkTailN === 35);
		check("上下限：1 与 200 都收、0 与 201 都拒（纯函数 normalizeForkTail）",
			internals.FORK_MAX_TAIL === 200 && internals.FORK_MIN_TAIL === 1
			&& internals.normalizeForkTail(1) === 1 && internals.normalizeForkTail(200) === 200
			&& internals.normalizeForkTail(0) === undefined && internals.normalizeForkTail(201) === undefined
			&& internals.normalizeForkTail(1.5) === undefined && internals.normalizeForkTail("35") === undefined
			&& internals.normalizeForkTail(null) === undefined && internals.normalizeForkTail(undefined) === undefined);
		check("effectiveForkTail：存了就用存的、没存/存了坏值就用缺省 20",
			internals.FORK_DEFAULT_TAIL === 20
			&& internals.effectiveForkTail({ data: { forkTailN: 35 } }) === 35
			&& internals.effectiveForkTail({ data: { forkTailN: 200 } }) === 200
			&& internals.effectiveForkTail({ data: { forkTailN: undefined } }) === 20
			&& internals.effectiveForkTail({ data: { forkTailN: 0 } }) === 20
			&& internals.effectiveForkTail({ data: { forkTailN: 999 } }) === 20);
		check("宿主半的 fork 处理里 tailN 取的是「数据文件里存的值」，而不是写死的缺省（源码断言）",
			readFileSync(new URL("./lib/index.js", import.meta.url), "utf8").includes("let tailN = effectiveForkTail(runtime);"));

		// 数据文件里已经有值时：改完别的字段之后（重新 apply）照样读得到 —— 走的是 readDataFile → adoptData 那条路。
		const rereadRouter = createRouter();
		apply(rereadRouter.ctx, { dataFile: tailFile }, { muxPath: "/api/remote.mux" });
		const rereadHost = await startFakeHost(rereadRouter);
		const rereadState = (await httpJson(`http://127.0.0.1:${rereadHost.port}${internals.PLUGIN_ROUTE}/state`)).json;
		check("重启/重新装配后从数据文件里读回来还是 35（不是只在内存里活着）",
			rereadState.access.forkTailN === 35, JSON.stringify({ forkTailN: rereadState.access.forkTailN }));
		await rereadHost.close();
		await tailHost.close();
	}

	{
		// ===== 0.8.1：远端会话 cookie 落盘（"网页端 cookie 存在浏览器里"的等价物）=====
		section("G11 会话 cookie 落盘（0.8.1）：本机重启后不必再拿 token 兑换一次");

		const credsA = {
			store: new Map(),
			unsetCalls: [],
			async resolve(ref) { const value = this.store.get(ref); return value === undefined ? undefined : { value, source: "store" }; },
			async set(ref, value) { this.store.set(ref, value); },
			async unset(ref) { this.unsetCalls.push(ref); this.store.delete(ref); },
			async describe(ref) { return { configured: this.store.has(ref), writable: true }; },
		};
		const fileA = freshDataFile();
		const tokenExchanges = () => stub.requests.filter((request) => typeof request.url === "string" && request.url.includes("token=")).length;

		const routerA = createRouter({ credentials: credsA });
		apply(routerA.ctx, { dataFile: fileA, devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" }] }, { muxPath: "/api/remote.mux" });
		const hostA = await startFakeHost(routerA);
		const first = await httpGet(`http://127.0.0.1:${hostA.port}/dev/self/api/whatever`);
		check("第一次代理成功（顺带完成一次 token → cookie 兑换）", first.status === 200, `status=${first.status}`);
		check("兑换出来的会话 cookie 已经**落到凭据服务**里（ref = DSH_REMOTE_SESSION_<sha256(authority) 前 16 位>）",
			typeof credsA.store.get(internals.sessionRefFor(`127.0.0.1:${String(stub.port)}`)) === "string"
			&& internals.sessionRefFor(`127.0.0.1:${String(stub.port)}`).startsWith(internals.SESSION_REF_PREFIX),
			JSON.stringify([...credsA.store.keys()].map((ref) => ref.slice(0, 24))));

		// 模拟"本机 DSH 重启"：同一个数据文件 + 同一份凭据，**新装配一个插件实例**。
		const exchangesBeforeRestart = tokenExchanges();
		const routerB = createRouter({ credentials: credsA });
		apply(routerB.ctx, { dataFile: fileA, devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" }] }, { muxPath: "/api/remote.mux" });
		const hostB = await startFakeHost(routerB);
		const afterRestart = await httpGet(`http://127.0.0.1:${hostB.port}/dev/self/api/whatever`);
		check("重启后第一次代理仍 200（直接用落盘的那份 cookie）", afterRestart.status === 200, `status=${afterRestart.status}`);
		check("重启后**没有再拿 token 兑换一次**（落盘命中就跳过兑换）",
			tokenExchanges() === exchangesBeforeRestart, `${String(exchangesBeforeRestart)} → ${String(tokenExchanges())}`);
		const carried = stub.requests.filter((request) => request.url === "/api/whatever" && typeof request.cookie === "string").at(-1);
		check("重启后带过去的仍是那份会话 cookie",
			carried !== undefined && carried.cookie === `${internals.cookieNameFor(stub.authority)}=stub-session-value`,
			carried?.cookie ?? "(none)");
		await hostA.close();
		await hostB.close();

		// 退化路线（没有凭据服务）：cookie 落到数据文件的 sessions 字段
		const fileC = freshDataFile();
		const routerC = createRouter();
		apply(routerC.ctx, { dataFile: fileC, devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" }] }, { muxPath: "/api/remote.mux" });
		const hostC = await startFakeHost(routerC);
		await httpGet(`http://127.0.0.1:${hostC.port}/dev/self/api/whatever`);
		const degraded = readJsonFile(fileC);
		check("没有凭据服务时：cookie 落到数据文件的 sessions 字段（而不是丢掉）",
			degraded.sessions !== undefined && typeof degraded.sessions.self === "string",
			JSON.stringify(Object.keys(degraded)));
		await hostC.close();
	}

	{
		// ===== 0.8.1：远端回 401 时自动丢掉会话并重新兑换（以前会一直 401）=====
		section("G12 远端回 401 → 丢掉缓存会话 + 重新兑换（「切过去一直连接中」的自动恢复）");

		const cookieName401 = internals.cookieNameFor(`127.0.0.1:0`);
		let exchangeCount = 0;
		let authority401 = "";
		const four01 = createServer((req, res) => {
			const url = new URL(req.url, `http://${req.headers.host}`);
			const name = `dsh-auth-${Buffer.from(createHash("sha256").update(req.headers.host).digest()).toString("base64url")}`;
			const authed = typeof req.headers.cookie === "string" && req.headers.cookie.includes(`${name}=ok-cookie`);
			if (url.pathname === "/" && url.searchParams.get("token") === "t-1") {
				exchangeCount += 1;
				res.writeHead(303, { location: "./", "set-cookie": `${name}=ok-cookie; Max-Age=315360000; Path=/; HttpOnly` });
				res.end();
				return;
			}
			if (url.pathname === "/api/kill") {
				res.writeHead(401, { "content-type": "text/plain" });
				res.end("unauthorized");
				return;
			}
			if (url.pathname.startsWith("/api/") && authed) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			res.writeHead(401, { "content-type": "text/plain" });
			res.end("unauthorized");
		});
		await new Promise((resolve) => four01.listen(0, "127.0.0.1", resolve));
		authority401 = `127.0.0.1:${four01.address().port}`;
		const creds401 = {
			store: new Map(),
			unsetCalls: [],
			async resolve(ref) { const value = this.store.get(ref); return value === undefined ? undefined : { value, source: "store" }; },
			async set(ref, value) { this.store.set(ref, value); },
			async unset(ref) { this.unsetCalls.push(ref); this.store.delete(ref); },
			async describe(ref) { return { configured: this.store.has(ref), writable: true }; },
		};
		const file401 = freshDataFile();
		const router401 = createRouter({ credentials: creds401 });
		apply(router401.ctx, { dataFile: file401, devices: [{ id: "x", name: "x", url: `http://${authority401}`, token: "t-1" }] }, { muxPath: "/api/remote.mux" });
		const host401 = await startFakeHost(router401);
		const ok = await httpGet(`http://127.0.0.1:${host401.port}/dev/x/api/normal`);
		check("先成功一次（建立会话 cookie）", ok.status === 200, `status=${ok.status}`);
		check("会话已落盘", typeof creds401.store.get(internals.sessionRefFor(authority401)) === "string");
		const exchangesBefore401 = exchangeCount;
		const killed = await httpGet(`http://127.0.0.1:${host401.port}/dev/x/api/kill`);
		check("远端回 401 时先丢掉会话、用 token 重兑一次并重试；仍 401 就把 401 如实透传给客户端",
			killed.status === 401 && exchangeCount === exchangesBefore401 + 1,
			`status=${killed.status} exchanges=${String(exchangesBefore401)} → ${String(exchangeCount)}`);
		check("401 之后**落盘的会话被丢掉**（unset 了 DSH_REMOTE_SESSION_… ref）",
			creds401.unsetCalls.includes(internals.sessionRefFor(authority401)) && creds401.store.get(internals.sessionRefFor(authority401)) === undefined,
			JSON.stringify(creds401.unsetCalls.map((ref) => ref.slice(0, 24))));
		// 0.13.1（C）：401/403 之后 state.devices[].lastError 要给人话，而不是只有 "HTTP 401"。
		const state401 = (await httpJson(`http://127.0.0.1:${host401.port}${internals.PLUGIN_ROUTE}/state`)).json;
		const device401 = state401.devices.find((entry) => entry.id === "x");
		check("401 之后 state.devices[].lastError 写明「对端拒绝了会话/令牌」+「重新复制 token」",
			typeof device401?.lastError === "string"
			&& device401.lastError.includes("对端拒绝了会话/令牌")
			&& device401.lastError.includes("重新复制 token")
			&& device401.lastError.includes("401"),
			String(device401?.lastError));
		check("401 提示里绝不出现 token 全文（只有状态码与动作指引）",
			typeof device401?.lastError === "string" && !device401.lastError.includes("t-1"),
			String(device401?.lastError));
		const recovered = await httpGet(`http://127.0.0.1:${host401.port}/dev/x/api/normal`);
		check("下一次请求自动**重新兑换**并恢复 200（不需要人去设置页点任何东西）",
			recovered.status === 200 && exchangeCount === exchangesBefore401 + 2,
			`status=${recovered.status} exchanges=${String(exchangesBefore401)} → ${String(exchangeCount)}`);
		await host401.close();
		await new Promise((resolve) => four01.close(resolve));
		void cookieName401;
	}

	{
		// ===== 0.13.2：代理的 401 重放 =====
		//  - 小 body（≤ 256 KiB，content-length 已知）⇒ 先缓冲，401 后重兑 + **原样重放一次**；
		//  - 大 body（> 256 KiB）⇒ 只发一次，401 时**不静默**：state.devices[].lastError 写清"体太大无法自动重放"；
		//  - 无 body（GET）⇒ 老行为回归（仍然重兑 + 重试一次）。
		section("G12b 代理 401 重放：小 body 缓冲重放 / 大 body 单发 + 明确提示 / 无 body 回归");
		let replayExchanges = 0;
		const smallHits = [];
		const smallBodies = [];
		const smallCookies = [];
		const largeHits = [];
		const largeBytes = [];
		const getHits = [];
		const getCookies = [];
		const replayRemote = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://replay.invalid");
			const authority = req.headers.host ?? "";
			const name = `dsh-auth-${base64Url(createHash("sha256").update(authority).digest())}`;
			const latest = () => `${name}=replay-cookie-${String(replayExchanges)}`;
			const unauthorized = () => {
				res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh web authentication required\n");
			};
			if (url.pathname === "/" && url.searchParams.get("token") === "replay-token") {
				replayExchanges += 1;
				res.writeHead(303, {
					location: "./",
					"set-cookie": `${name}=replay-cookie-${String(replayExchanges)}; Max-Age=315360000; Path=/; HttpOnly`,
				});
				res.end();
				return;
			}
			if (url.pathname === "/api/replay-small") {
				const chunks = [];
				req.on("data", (chunk) => chunks.push(chunk));
				req.on("end", () => {
					smallHits.push(1);
					smallBodies.push(Buffer.concat(chunks).toString("utf8"));
					smallCookies.push(typeof req.headers.cookie === "string" ? req.headers.cookie : "");
					// 第一发永远 401（模拟对端重启），重放时只认**最新**那次兑换的 cookie。
					if (smallHits.length === 1 || req.headers.cookie !== latest()) return unauthorized();
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true, via: "replayed" }));
				});
				return;
			}
			if (url.pathname === "/api/replay-large") {
				const chunks = [];
				req.on("data", (chunk) => chunks.push(chunk));
				req.on("end", () => {
					largeHits.push(1);
					largeBytes.push(Buffer.concat(chunks).length);
					unauthorized();
				});
				return;
			}
			if (url.pathname === "/api/replay-get") {
				getHits.push(1);
				getCookies.push(typeof req.headers.cookie === "string" ? req.headers.cookie : "");
				if (getHits.length === 1 || req.headers.cookie !== latest()) return unauthorized();
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, via: "get" }));
				return;
			}
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
		});
		await new Promise((resolve) => replayRemote.listen(0, "127.0.0.1", resolve));
		const replayAuthority = `127.0.0.1:${String(replayRemote.address().port)}`;
		const replayCreds = {
			store: new Map(),
			async resolve(ref) { const value = this.store.get(ref); return value === undefined ? undefined : { value, source: "store" }; },
			async set(ref, value) { this.store.set(ref, value); },
			async unset(ref) { this.store.delete(ref); },
			async describe(ref) { return { configured: this.store.has(ref), writable: true }; },
		};
		const replayRouter = createRouter({ credentials: replayCreds });
		apply(replayRouter.ctx, {
			dataFile: freshDataFile(),
			devices: [{ id: "replay", name: "重放对端", url: `http://${replayAuthority}`, token: "replay-token" }],
		}, { muxPath: "/api/remote.mux" });
		const replayHost = await startFakeHost(replayRouter);
		const base = `http://127.0.0.1:${String(replayHost.port)}/dev/replay`;
		const cookieName = `dsh-auth-${base64Url(createHash("sha256").update(replayAuthority).digest())}`;

		// ① 小 body：≤ 256 KiB ⇒ 缓冲 + 401 后重放一次。
		const smallPayload = "small-body-payload";
		const small = await httpJson(`${base}/api/replay-small`, { method: "POST", body: smallPayload });
		check("小 body：401 后自动重兑 + 重放，最终拿到 200", small.status === 200 && small.json?.via === "replayed",
			`status=${small.status} body=${small.body.slice(0, 80)}`);
		check("小 body：上游一共收到两次（第一次 401、第二次是重放）", smallHits.length === 2, `hits=${String(smallHits.length)}`);
		check("小 body：重放的是**同一个请求体**（逐字节）",
			smallBodies.length === 2 && smallBodies[0] === smallPayload && smallBodies[1] === smallPayload,
			JSON.stringify(smallBodies.map((entry) => entry.length)));
		check("小 body：第二次带的是重兑后的**新** cookie",
			smallCookies.length === 2 && smallCookies[1] === `${cookieName}=replay-cookie-2`
			&& smallCookies[1] !== smallCookies[0],
			smallCookies.join(" | "));
		check("小 body：只重兑了一次（token 兑换次数 = 2）", replayExchanges === 2, `exchanges=${String(replayExchanges)}`);

		// ② 无 body（GET）：老行为回归 —— 仍会重兑 + 重试一次。
		const getOk = await httpGet(`${base}/api/replay-get`);
		check("无 body（GET）：401 后仍重兑 + 重试一次，最终 200", getOk.status === 200 && getHits.length === 2,
			`status=${getOk.status} hits=${String(getHits.length)}`);
		check("无 body：重试带上了新 cookie",
			getCookies.length === 2 && getCookies[1] === `${cookieName}=replay-cookie-3` && getCookies[1] !== getCookies[0],
			getCookies.join(" | "));

		// ③ 大 body：> 256 KiB ⇒ 单发、不重放；401 时写清原因（不再静默）。
		const largePayload = "x".repeat(263 * 1024);
		const large = await httpJson(`${base}/api/replay-large`, { method: "POST", body: largePayload });
		check("大 body：只发一次（不重放），401 如实透传", large.status === 401 && largeHits.length === 1,
			`status=${large.status} hits=${String(largeHits.length)}`);
		check("大 body：上游确实收到了完整的 263 KiB（不是半个体）",
			largeBytes.length === 1 && largeBytes[0] === Buffer.byteLength(largePayload),
			JSON.stringify(largeBytes));
		check("大 body：没有再拿 token 兑换（兑换次数仍是 3）", replayExchanges === 3, `exchanges=${String(replayExchanges)}`);
		const replayState = (await httpJson(`http://127.0.0.1:${String(replayHost.port)}${internals.PLUGIN_ROUTE}/state`)).json;
		const replayDevice = replayState.devices.find((entry) => entry.id === "replay");
		check("大 body：state.devices[].lastError 明确写「请求体过大无法自动重放」+「请重试一次」",
			typeof replayDevice?.lastError === "string"
			&& replayDevice.lastError.includes("请求体过大无法自动重放")
			&& replayDevice.lastError.includes("请重试一次")
			&& replayDevice.lastError.includes("401/403"),
			String(replayDevice?.lastError));
		check("大 body 的提示里绝不出现 token 全文",
			typeof replayDevice?.lastError === "string" && !replayDevice.lastError.includes("replay-token"),
			String(replayDevice?.lastError));

		await replayHost.close();
		await new Promise((resolve) => replayRemote.close(resolve));
	}

	{
		// 不可写 / 失败的各条路：一律 {ok:false}，绝不假成功。
		const noEditor = await accessHost({});
		const denied = await httpJson(`${noEditor.base}/access`, { method: "POST", body: { port: 19388 } });
		notHtml("POST access（没有 config-editor → 503）", denied);
		check("没有 config-editor → 503 {ok:false}（不假成功）",
			denied.status === 503 && denied.json.ok === false && String(denied.json.error).includes("config-editor"),
			JSON.stringify(denied.json).slice(0, 160));
		const noEditorState = (await httpJson(`${noEditor.base}/state`)).json;
		check("没有 config-editor 时 access.writable=false，且体检 notes 写明保存会失败（503）",
			noEditorState.access.writable === false
			&& noEditorState.diagnostics.notes.some((note) => note.includes("config-editor") && note.includes("503")),
			JSON.stringify(noEditorState.diagnostics.notes.filter((note) => note.includes("config-editor")).map((note) => note.slice(0, 50))));
		await noEditor.close();

		const brokenShape = await accessHost({ rawEditor: { edit: async () => {} } }); // 没有 entries()
		const broken = await httpJson(`${brokenShape.base}/access`, { method: "POST", body: { port: 19388 } });
		check("config-editor 形状不认识（只有 edit()、没有 entries()）→ 503（按「没有」处理，不猜）",
			broken.status === 503 && broken.json.ok === false, `${String(broken.status)} ${String(broken.json?.error ?? "").slice(0, 60)}`);
		await brokenShape.close();

		const missingRow = await accessHost({ fakeEditor: { dropWebserverRow: true } });
		const noRow = await httpJson(`${missingRow.base}/access`, { method: "POST", body: { port: 19388 } });
		check("profile 里找不到 webserver 行 → 503，且提示不手改 YAML 而是给出文件位置（绝不自己改 YAML）",
			noRow.status === 503 && noRow.json.ok === false && String(noRow.json.error).includes("cordis.patch.yml"),
			JSON.stringify(noRow.json).slice(0, 160));
		check("找不到行时一行都没写", missingRow.fake.calls.length === 0, JSON.stringify(missingRow.fake.calls));
		await missingRow.close();

		const failingConn = await accessHost({ fakeEditor: { failOn: "connection", failMessage: "配置文件只读" } });
		const failedConn = await httpJson(`${failingConn.base}/access`, { method: "POST", body: { port: 19388, trustedHosts: ["a.example.com"] } });
		notHtml("POST access（edit 抛错 → 500）", failedConn);
		check("edit 抛错 → 500 {ok:false}、原因里带上底层错误、并说明已回滚（不假成功、不吞错）",
			failedConn.status === 500 && failedConn.json.ok === false
			&& String(failedConn.json.error).includes("配置文件只读") && String(failedConn.json.error).includes("回滚"),
			JSON.stringify(failedConn.json).slice(0, 200));
		check("入口地址那一笔失败 → 端口那一笔也不再写（失败即停）",
			failingConn.fake.calls.length === 1 && failingConn.fake.calls[0].id === "connection",
			JSON.stringify(failingConn.fake.calls.map((call) => call.id)));
		await failingConn.close();

		const failingWeb = await accessHost({ fakeEditor: { failOn: "webserver", failMessage: "端口被占用" } });
		const failedWeb = await httpJson(`${failingWeb.base}/access`, { method: "POST", body: { port: 19388, trustedHosts: ["a.example.com"] } });
		check("端口那一笔失败 → 500，并把「入口地址已写入、端口没写」如实说清楚（不吞掉半截状态）",
			failedWeb.status === 500 && failedWeb.json.ok === false
			&& String(failedWeb.json.error).includes("端口被占用") && String(failedWeb.json.error).includes("入口地址那一行已经写入"),
			JSON.stringify(failedWeb.json).slice(0, 200));
		await failingWeb.close();

		const disabled = await accessHost({ fakeEditor: {} });
		await httpJson(`${disabled.base}/enabled`, { method: "POST", body: { enabled: false } });
		const gated = await httpJson(`${disabled.base}/access`, { method: "POST", body: { port: 19388 } });
		check("插件停用时改配置 → 409 {ok:false}（受 enabled 门控）",
			gated.status === 409 && gated.json.ok === false && String(gated.json.error).includes("已停用"),
			JSON.stringify(gated.json).slice(0, 140));
		check("停用时一行都没写", disabled.fake.calls.length === 0);
		await disabled.close();
	}

	{
		// 写配置仍然**只认回环**：这条路由是"写"操作，不给浏览器用。
		const page = await accessHost({ fakeEditor: {} });
		const nonLoop = await localExchange(page.router, {
			method: "POST",
			url: `${internals.PLUGIN_ROUTE}/access`,
			remoteAddress: "198.51.100.11",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ port: 19388 }),
		});
		notHtml("POST access（非回环 → 403）", nonLoop);
		check("非回环改配置 → 403（仅回环守卫照旧）", nonLoop.status === 403, String(nonLoop.status));
		check("非回环被拒时一行都没写", page.fake.calls.length === 0);
		await page.close();
	}

	{
		// localAddresses 的形状（「填入本机地址」直接用它逐行填）。
		const page = await accessHost({ fakeEditor: {} });
		const state_ = (await httpJson(`${page.base}/state`)).json;
		check("access.localAddresses：回环在前、每条都带**当前端口**、都是 IPv4:port、没有 0.0.0.0",
			Array.isArray(state_.access.localAddresses) && state_.access.localAddresses[0] === `127.0.0.1:${page.host.port}`
			&& state_.access.localAddresses.every((entry) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/u.test(entry) && entry.endsWith(`:${page.host.port}`))
			&& !state_.access.localAddresses.some((entry) => entry.startsWith("0.0.0.0:")),
			JSON.stringify(state_.access.localAddresses));
		check("internals.canonicalTrustedAuthority 与官方口径一致：规范值放行、会被静默改写的值一律判不合格", (() => {
			const ok = ["192.0.2.4", "192.0.2.4:19387", "A.EXAMPLE.COM:19387", "harness.internal:80"];
			const bad = ["harness.internal/path", "user@harness.internal", "0x7f.0.0.1", "a.example:019387", "a.example ", " a.example", "http://a.example", ""];
			return ok.every((entry) => internals.canonicalTrustedAuthority(entry) !== undefined)
				&& bad.every((entry) => internals.canonicalTrustedAuthority(entry) === undefined);
		})(), JSON.stringify(["192.0.2.4:19387", "a.example:019387", "harness.internal/path"].map((entry) => internals.canonicalTrustedAuthority(entry))));
		await page.close();
	}

	const unreadableRouter = createRouter({ connection: { trustedHosts: undefined, authenticatedUrl: undefined } });
	apply(unreadableRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
	const unreadableHost = await startFakeHost(unreadableRouter);
	const unreadableState = (await httpJson(`http://127.0.0.1:${unreadableHost.port}${internals.PLUGIN_ROUTE}/state`)).json;
	check("读不到 trustedHosts / browserAuth 时如实回空数组与 null（不猜、不报错）",
		JSON.stringify(unreadableState.access.trustedHosts) === "[]" && unreadableState.access.cookieMaxAgeDays === null,
		JSON.stringify(unreadableState.access));
	const unreadableUrls = (await httpJson(`http://127.0.0.1:${unreadableHost.port}${internals.PLUGIN_ROUTE}/urls`)).json;
	check("ctx.connection.authenticatedUrl 不可用时 urls 退化为 base 本身（仍然 200）",
		unreadableUrls.urls.every((entry) => entry.authenticated.startsWith(entry.base)),
		JSON.stringify(unreadableUrls.urls));
	await unreadableHost.close();

	section("G10c 凭据服务缺席 → 退化到数据文件，并明确标注 token 明文存储");
	const plainFile = freshDataFile();
	const plainRouter = createRouter();
	apply(plainRouter.ctx, {
		dataFile: plainFile,
		devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" }],
	}, { muxPath: "/api/remote.mux" });
	const plainHost = await startFakeHost(plainRouter);
	await sleep(1200); // 等种子 token 的落点判定窗口过去（SEED_TOKEN_SETTLE_MS=1000）
	const plainState = (await httpJson(`http://127.0.0.1:${plainHost.port}${internals.PLUGIN_ROUTE}/state`)).json;
	const plainFileText = readFileSync(plainFile, "utf8");
	check("没有凭据服务时 token 落到数据文件的 tokens 字段（明文）",
		plainFileText.includes("stub-token") && JSON.parse(plainFileText).tokens?.self === "stub-token",
		JSON.stringify(Object.keys(JSON.parse(plainFileText))));
	check("退化路线的体检 notes 明确写「token 明文存储」并给出文件路径",
		plainState.diagnostics.notes.some((note) => note.includes("token 明文存储") && note.includes(plainFile)),
		JSON.stringify(plainState.diagnostics.notes.filter((note) => note.includes("明文"))));
	check("退化路线下 token 仍然可用（代理时用文件里的明文 token 兑换出会话 → 200）",
		(await httpGet(`http://127.0.0.1:${plainHost.port}/dev/self/api/plain`)).status === 200
		&& stub.requests.some((request) => typeof request.url === "string" && request.url.includes("token=stub-token")));
	check("退化路线也提示 ctx.credentials 不可用",
		plainState.diagnostics.notes.some((note) => note.includes("ctx.credentials 不可用")));
	await plainHost.close();

	// ------------------------------------------------------------------
	// H 新能力：文件「另存为…」与会话「分叉到…」
	// ------------------------------------------------------------------
	section("H0 新能力的纯函数：basename / RFC 5987 / multipart / 种子文本");

	check("basename 同时认 / 与 \\（目标机可能是 Windows），末尾斜杠被吃掉",
		internals.basenameOf("/a/b/中文 文件.md") === "中文 文件.md"
		&& internals.basenameOf("C:\\notes\\报表.xlsx") === "报表.xlsx"
		&& internals.basenameOf("dir/") === "dir"
		&& internals.basenameOf("") === "download.bin",
		JSON.stringify([internals.basenameOf("/a/b/c.md"), internals.basenameOf("C:\\notes\\报表.xlsx")]));

	check("Content-Disposition：ASCII 回退名 + RFC 5987 的 filename*（中文名走后者）",
		internals.contentDispositionFor("notes/中文 文件.md")
			=== "attachment; filename=\"__ __.md\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md",
		internals.contentDispositionFor("notes/中文 文件.md"));
	check("encodeRfc5987 连 !'()* 也编码（encodeURIComponent 会漏掉它们）",
		internals.encodeRfc5987("a!b'c(d)e*f") === "a%21b%27c%28d%29e%2Af",
		internals.encodeRfc5987("a!b'c(d)e*f"));
	check("Content-Disposition 里没有裸控制字符/引号（响应头必须合法）",
		!/[\u0000-\u001f"]/u.test(internals.contentDispositionFor("a\"b\nc.md").replace(/filename="[^"]*"/u, "")),
		internals.contentDispositionFor("a\"b\nc.md"));

	check("parseMultipart：metadata + 二进制附件都能取到（段尾的 CRLF 不算数据）", (() => {
		const boundary = "----selftestBoundary";
		const body = multipartBody(boundary, [
			{ name: "metadata", data: Buffer.from("{\"ok\":true}", "utf8") },
			{ name: "bytes-0", filename: "blob", contentType: "application/octet-stream", data: Buffer.from([0, 1, 2, 255]) },
		]);
		const parsed = internals.parseMultipart(body, boundary);
		if (parsed.error !== undefined) return false;
		if (parsed.parts.get("metadata").toString("utf8") !== "{\"ok\":true}") return false;
		const bytes = parsed.parts.get("bytes-0");
		return bytes.length === 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 2 && bytes[3] === 255;
	})(), "见 parseMultipart");
	check("multipartBoundary 从 content-type 里取边界（带/不带引号都认）",
		internals.multipartBoundary("multipart/form-data; boundary=abc") === "abc"
		&& internals.multipartBoundary("multipart/form-data; boundary=\"a b\"") === "a b"
		&& internals.multipartBoundary("application/json") === null);

	check("buildSeedContext：按「role: text」拼；工具调用只留一行摘要", (() => {
		const seed = internals.buildSeedContext(LOCAL_RECORDS);
		return seed.text.startsWith("用户: ")
			&& seed.text.includes("用户: 帮我看看 notes/中文 文件.md")
			&& seed.text.includes("助手: 好的，先读一遍。\n[工具调用：read]")
			&& seed.text.includes("助手: 读完了。")
			&& seed.messages === 3
			&& seed.truncated === false;
	})(), JSON.stringify(internals.buildSeedContext(LOCAL_RECORDS).text));
	check("messageOfRecord：只认 user/message 与 assistant/message，其余返回 null",
		internals.messageOfRecord({ type: "event", event: { type: "tool/result", data: {} } }) === null
		&& internals.messageOfRecord(LOCAL_RECORDS[0]).role === "用户"
		&& internals.messageOfRecord(LOCAL_RECORDS[1]).role === "助手");
	check("forkSeedPrompt 的措辞（含用户要求的「不用回复」口径）", () => {
		const seed = internals.forkSeedPrompt("用户: hi");
		assert(seed.includes("[来自另一台设备的会话分叉]"), "要有分叉标记");
		assert(seed.includes("仅文字，不含文件"), "要写明只带文字、不含文件");
		assert(seed.includes("用户: hi"), "要带上上下文正文");
		// 2026-10-13 用户反馈：没有这句时目标机 agent 会把上下文当任务，思考几分钟再长篇回复。
		assert(seed.includes("不用回复"), "结尾必须写明「不用回复」");
		assert(seed.includes("不要开始工作"), "结尾必须写明「不要开始工作」");
		assert(seed.indexOf("不用回复") > seed.indexOf("用户: hi"), "这句必须放在**上下文之后**（后缀）");
	});

	section("H1 GET /plugin/remote/download：鉴权改用官方的「可信请求」判定（不再看请求来源是不是回环）");
	// 「另存为」是唯一一条不受"仅回环"守卫约束的路由（见 isDownloadRequestUrl），
	// 它的鉴权在 handleDownloadRequest 的**第 0 步**用官方判定单独做，早于任何参数校验；
	// 所以下面这条 URL 只用来打鉴权分支，参数本身在 H2 再逐个校验。
	const downloadUrl = `${internals.PLUGIN_ROUTE}/download?device=self&path=a.md&session=sess-1`;
	// ① 官方判定拒绝（401 = Host/Origin 栅栏过了但没有有效 dsh-auth-* 会话 cookie；
	//    403 = 栅栏没过）→ 本插件**一律折成 403 text/plain**，并把官方给的码写进正文（排错不用猜）。
	for (const code of [401, 403]) {
		const rejectRouter = createRouter({
			connection: {
				trustedHosts: ["192.0.2.4"],
				browserAuth: { maxAgeMilliseconds: 3_650 * 86_400_000 },
				authenticatedUrl: (base) => `${base}?token=stub-launch-token`,
				requestRejection: () => code,
			},
		});
		apply(rejectRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
		const exchange = await localExchange(rejectRouter, { method: "GET", url: downloadUrl, remoteAddress: "192.0.2.9" });
		check(`另存为：官方判定拒绝（${String(code)}）→ 403 text/plain 且写明原因与官方的码`,
			exchange.status === 403 && String(exchange.headers["content-type"]).startsWith("text/plain")
			&& exchange.body.includes("被拒绝") && exchange.body.includes(String(code)),
			`status=${exchange.status} body=${JSON.stringify(exchange.body.slice(0, 100))}`);
		notHtml(`另存为被拒（${String(code)}）`, exchange);
	}
	// ② 宿主连"可信请求"判定都没有（老 DSH）→ **一律拒绝**（不清楚的请求不放行），并写明原因。
	const noVerdictRouter = createRouter({ connection: { trustedHosts: [], authenticatedUrl: (base) => base } });
	apply(noVerdictRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
	const noVerdict = await localExchange(noVerdictRouter, { method: "GET", url: downloadUrl });
	check("另存为：宿主没有 connection.requestRejection → 403 且写明「没有提供官方判定」（降级为拒绝，不是放行）",
		noVerdict.status === 403 && noVerdict.body.includes("requestRejection"), JSON.stringify(noVerdict.body.slice(0, 100)));
	notHtml("另存为（无官方判定）", noVerdict);
	// ③ 反证：**回环与否不再参与判定** —— 官方的 Host/Origin 栅栏才是判据。
	//    一个有栅栏的实例：Host 是回环/trustedHosts 才过；非回环来源但 Host 合法 → 放行。
	const gated = createLocalWorkspaceFiles({ files: { "C:\\work\\a.md": Buffer.from("gated\n") } });
	const gateRouter = createRouter({
		services: { typert: gated.typert, workspaceFiles: gated.workspaceFiles },
		connection: {
			trustedHosts: ["trusted.internal"],
			browserAuth: { maxAgeMilliseconds: 3_650 * 86_400_000 },
			authenticatedUrl: (base) => `${base}?token=stub`,
			// 照官方 isTrustedApiRequest 的判定：Host 必须是回环或 trustedHosts 里的 authority。
			requestRejection: (req) => {
				const host = String(req.headers.host ?? "").split(":")[0];
				return host === "127.0.0.1" || host === "localhost" || host === "trusted.internal" ? undefined : 403;
			},
		},
	});
	apply(gateRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
	const gateHost = await startFakeHost(gateRouter);
	const gatedOk = await httpGetBuffer(`http://127.0.0.1:${gateHost.port}${internals.PLUGIN_ROUTE}/download?device=&path=${encodeURIComponent("C:\\work\\a.md")}&session=sess-local`);
	check("另存为：官方判定可信（Host 合法）→ 放行并读到字节 200（不再看是不是回环来源）",
		gatedOk.status === 200 && gatedOk.body.toString("utf8") === "gated\n", `status=${gatedOk.status}`);
	const gatedBad = await httpGetBuffer(`http://127.0.0.1:${gateHost.port}${internals.PLUGIN_ROUTE}/download?device=&path=${encodeURIComponent("C:\\work\\a.md")}&session=sess-local`, { host: "evil.example" });
	check("另存为：官方判定不可信（Host 不在 trustedHosts）→ 403 text/plain（DNS rebinding 那类请求被挡）",
		gatedBad.status === 403 && String(gatedBad.headers["content-type"]).startsWith("text/plain")
		&& gatedBad.body.toString("utf8").includes("403"), `status=${gatedBad.status} body=${JSON.stringify(gatedBad.body.toString("utf8").slice(0, 80))}`);
	notHtml("另存为（Host 不可信）", { status: gatedBad.status, headers: gatedBad.headers, body: gatedBad.body.toString("utf8") });
	check("路由形状：只有 /plugin/remote/download 这一条不受「仅回环」守卫约束",
		internals.isDownloadRequestUrl(`${internals.PLUGIN_ROUTE}/download?device=&path=a`) === true
		&& internals.isDownloadRequestUrl(`${internals.PLUGIN_ROUTE}/download`) === true
		&& internals.isDownloadRequestUrl(`${internals.PLUGIN_ROUTE}/state`) === false
		&& internals.isDownloadRequestUrl(`${internals.PLUGIN_ROUTE}/download/`) === false
		&& internals.isDownloadRequestUrl(undefined) === false,
		"见 isDownloadRequestUrl");
	await gateHost.close();
	const outsideFork = await localExchange(router, {
		method: "POST", url: `${internals.PLUGIN_ROUTE}/fork`, remoteAddress: "::ffff:198.51.100.3",
		headers: { "content-type": "application/json" }, body: JSON.stringify({ targetDeviceId: "self", sourceSessionId: "s" }),
	});
	check("非回环 POST /fork → 403 text/plain（fork 是写操作，仍然只认回环；回环 IPv6 映射形式也一律拒）",
		outsideFork.status === 403, String(outsideFork.status));
	notHtml("非回环 POST fork", { status: outsideFork.status, headers: outsideFork.headers, body: outsideFork.body });
	const nonLoopbackState = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/state`, remoteAddress: "192.0.2.9" });
	check("非回环 GET /state 仍然 403 loopback only（设置页没有被这次改动放开）",
		nonLoopbackState.status === 403 && nonLoopbackState.body.trim() === "loopback only",
		`status=${nonLoopbackState.status} body=${JSON.stringify(nonLoopbackState.body)}`);
	const postDownload = await localExchange(router, { method: "POST", url: `${internals.PLUGIN_ROUTE}/download` });
	check("POST /download → 405 text/plain（下载是浏览器导航过去的一条 GET）",
		postDownload.status === 405 && String(postDownload.headers["content-type"]).startsWith("text/plain")
		&& postDownload.body.includes("只支持 GET"), JSON.stringify(postDownload.body));
	const getFork = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/fork` });
	check("GET /fork → 405 JSON",
		getFork.status === 405 && getFork.body.includes("只支持 POST"), JSON.stringify(getFork.body));
	notHtml("405 GET fork", { status: getFork.status, headers: getFork.headers, body: getFork.body });
	// 未知路径仍然是 404（新路由没有把兜底吃掉）。
	const stillUnknown = await localExchange(router, { method: "GET", url: `${internals.PLUGIN_ROUTE}/nope` });
	check("未知路径仍是 404 unknown route（新路由没有改变兜底行为）",
		stillUnknown.status === 404 && stillUnknown.body.includes("unknown route"), JSON.stringify(stillUnknown.body));

	section("H2 GET /plugin/remote/download：参数校验（400 一律 text/plain，且都不是 HTML）");
	const downloadCases = [
		["非法 device id", `${internals.PLUGIN_ROUTE}/download?device=bad%20id%21&path=a.md&session=sess-1`, "device 参数不合法"],
		["未知设备", `${internals.PLUGIN_ROUTE}/download?device=ghost&path=a.md&session=sess-1`, "unknown device"],
		["缺 path", `${internals.PLUGIN_ROUTE}/download?device=self&session=sess-1`, "缺少 path"],
		["path 含 NUL", `${internals.PLUGIN_ROUTE}/download?device=self&path=a%00b.md&session=sess-1`, "NUL"],
		["path 过长", `${internals.PLUGIN_ROUTE}/download?device=self&path=${"a".repeat(internals.MAX_PATH_CHARS + 1)}&session=sess-1`, "过长"],
		["缺 session", `${internals.PLUGIN_ROUTE}/download?device=self&path=a.md`, "缺少 session"],
		["session 过长", `${internals.PLUGIN_ROUTE}/download?device=self&path=a.md&session=${"s".repeat(internals.MAX_SESSION_ID_CHARS + 1)}`, "session 参数不合法"],
		// device 为空 = 本机文件，所以**不再是**参数错误（旧版这里排的是"缺少 device → 400"，
		// 那正是"浏览器打开远端页面必然 403"那套错的模型的一部分）。
		["device 空 + 缺 path（本机分支也要校验 path）", `${internals.PLUGIN_ROUTE}/download?device=&session=sess-1`, "缺少 path"],
		["device 空 + path 含 NUL", `${internals.PLUGIN_ROUTE}/download?device=&path=a%00b.md&session=sess-1`, "NUL"],
		["device 空 + 缺 session", `${internals.PLUGIN_ROUTE}/download?device=&path=a.md`, "缺少 session"],
	];
	for (const [label, url, wanted] of downloadCases) {
		const exchange = await localExchange(router, { method: "GET", url });
		check(`download 参数校验：${label} → 400 且写明原因`,
			exchange.status === 400 && exchange.body.includes(wanted)
			&& String(exchange.headers["content-type"]).startsWith("text/plain"),
			`status=${exchange.status} body=${JSON.stringify(exchange.body.slice(0, 80))}`);
		notHtml(`download 400（${label}）`, { status: exchange.status, headers: exchange.headers, body: exchange.body });
	}
	const localDeviceAttempt = await (async () => {
		// 造一个"被认领为本机"的设备的独立实例（主实例里 4 台都不是本机）。
		const localRouter = createRouter();
		localRouter.ctx.webServer.port = 19387;
		localRouter.ctx.webServer.config.port = 19387;
		localRouter.ctx.webServer.host = "127.0.0.1";
		apply(localRouter.ctx, { dataFile: freshDataFile(), devices: [{ id: "me", name: "本机", url: "http://127.0.0.1:19387" }] }, { muxPath: "/api/remote.mux" });
		return localExchange(localRouter, { method: "GET", url: `${internals.PLUGIN_ROUTE}/download?device=me&path=a.md&session=sess-1` });
	})();
	check("download：device 指向被认领为本机的那台 → 400（设备有值时仍然走代理，那条老规矩没变）",
		localDeviceAttempt.status === 400 && localDeviceAttempt.body.includes("本机"), JSON.stringify(localDeviceAttempt.body.slice(0, 90)));

	section("H2b GET /plugin/remote/download（device 为空 = 本机文件）：读本机 workspaceFiles、不发任何远端请求");
	// 这一组就是用户实测那个场景："页面由设备A提供、文件在设备A —— 浏览器里点另存为"。
	// localStorage 里没有切换键 → 客户端半带一个空的 device → 宿主半必须读**本机**文件。
	const localBig = Buffer.alloc(1_200_000);
	for (let index = 0; index < localBig.length; index += 1) localBig[index] = (index * 7) % 251;
	const localFiles = createLocalWorkspaceFiles({
		files: {
			"C:\\work\\本机 文件.bin": localBig,
			"C:\\work\\some-dir": null,
			"C:\\work\\small.txt": Buffer.from("本机小文件\n", "utf8"),
		},
		sessions: ["sess-local"],
		workspaceRoot: "C:\\work",
	});
	const localRouter = createRouter({ services: { typert: localFiles.typert, workspaceFiles: localFiles.workspaceFiles } });
	apply(localRouter.ctx, { dataFile: freshDataFile(), devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}` }] }, { muxPath: "/api/remote.mux" });
	const localHost = await startFakeHost(localRouter);
	const localBase = `http://127.0.0.1:${localHost.port}${internals.PLUGIN_ROUTE}`;
	const stubRequestsBefore = stub.requests.length;
	const stubReadsBefore = stub.api.readBytesCalls.length;
	const localPath = encodeURIComponent("C:\\work\\本机 文件.bin");
	const localDownload = await httpGetBuffer(`${localBase}/download?device=&path=${localPath}&session=sess-local`);
	check("本机分支：device= 空 → 200 且字节逐字节取到（1.2 MB 本机文件，不是占位/错误页）",
		localDownload.status === 200 && localDownload.body.length === localBig.length && localDownload.body.equals(localBig),
		`status=${localDownload.status} 收到 ${String(localDownload.body.length)} 字节`);
	notHtmlBinary("GET download（本机分支）", localDownload);
	check("本机分支：Content-Length 来自本机 workspaceFiles 的 stat（不是我们猜的）",
		String(localDownload.headers["content-length"]) === String(localBig.length), String(localDownload.headers["content-length"]));
	check("本机分支：Content-Disposition 沿用同一套（ASCII 回退 + RFC 5987 中文名）",
		String(localDownload.headers["content-disposition"]).includes("filename*=UTF-8''%E6%9C%AC%E6%9C%BA%20%E6%96%87%E4%BB%B6.bin"),
		String(localDownload.headers["content-disposition"]));
	check("本机分支：**一个字节都没有走远端**（没打目标机、也没有远端 readBytes）",
		stub.requests.length === stubRequestsBefore && stub.api.readBytesCalls.length === stubReadsBefore,
		`stub.requests +${String(stub.requests.length - stubRequestsBefore)}，stub readBytes +${String(stub.api.readBytesCalls.length - stubReadsBefore)}`);
	check("本机分支：走的是官方 typert.lookups 的 workspaceFileScope（session → {sessionId, workspaceRoot}）",
		JSON.stringify(localFiles.calls.resolve) === JSON.stringify(["sess-local"])
		&& localFiles.calls.stat.length === 1
		&& JSON.stringify(localFiles.calls.stat[0].scope) === JSON.stringify({ sessionId: "sess-local", workspaceRoot: "C:\\work" }),
		JSON.stringify(localFiles.calls.resolve));
	check("本机分支：分块流式（1.2 MB → 3 个 512 KiB 窗口，offset 依次推进），不是一次读进内存",
		localFiles.calls.readBytes.length === 3
		&& localFiles.calls.readBytes.every((args) => args.path === "C:\\work\\本机 文件.bin")
		&& JSON.stringify(localFiles.calls.readBytes.map((args) => args.options.range.offset)) === JSON.stringify([0, 524_288, 1_048_576])
		&& localFiles.calls.readBytes.every((args) => args.options.range.length === internals.DOWNLOAD_CHUNK_BYTES),
		JSON.stringify(localFiles.calls.readBytes.map((args) => args.options.range)));
	check("本机分支：每次调用都带了 AbortSignal（官方 @Remote 包装会直接解引用它）",
		localFiles.failures.length === 0, JSON.stringify(localFiles.failures));
	check("本机分支：服务名/lookup 键名与官方契约一致（workspaceFiles / typert / workspaceFileScope）",
		internals.WORKSPACE_FILES_SERVICE === "workspaceFiles" && internals.TYPERT_SERVICE === "typert"
		&& internals.WORKSPACE_FILE_SCOPE_LOOKUP === "workspaceFileScope",
		[internals.WORKSPACE_FILES_SERVICE, internals.TYPERT_SERVICE, internals.WORKSPACE_FILE_SCOPE_LOOKUP].join("/"));
	// 不带 device 参数（而不是带空值）同样当本机 —— 两种写法都要能用。
	const localNoParam = await httpGetBuffer(`${localBase}/download?path=${encodeURIComponent("C:\\work\\small.txt")}&session=sess-local`);
	check("本机分支：**完全没有 device 参数**也当本机（缺失与空值等价）",
		localNoParam.status === 200 && localNoParam.body.toString("utf8") === "本机小文件\n",
		`status=${localNoParam.status} body=${JSON.stringify(localNoParam.body.toString("utf8"))}`);
	// 本机那条路的成功也要进体检（和代理路线共用 noteOp）—— 趁还没跑失败用例先读一次。
	const localStateOk = (await httpJson(`${localBase}/state`)).json;
	check("本机分支的成功进体检（saveAs.lastOkAt 有值、lastError 为空）",
		typeof localStateOk.diagnostics.saveAs.lastOkAt === "string" && localStateOk.diagnostics.saveAs.lastError === null,
		JSON.stringify(localStateOk.diagnostics.saveAs));
	// ---- 失败分支：一律 text/plain、非 200、原因明确（且都不是 HTML）----
	const localSessionMissing = await httpGetBuffer(`${localBase}/download?device=&path=${encodeURIComponent("C:\\work\\small.txt")}&session=nope`);
	check("本机分支：会话不存在/不可见 → 404 且写明「本机上找不到这个 session」（授权范围来自会话）",
		localSessionMissing.status === 404 && localSessionMissing.body.toString("utf8").includes("本机上找不到这个 session"),
		`status=${localSessionMissing.status} body=${JSON.stringify(localSessionMissing.body.toString("utf8").slice(0, 100))}`);
	notHtml("本机分支（会话不存在）", { status: localSessionMissing.status, headers: localSessionMissing.headers, body: localSessionMissing.body.toString("utf8") });
	const localMissing = await httpGetBuffer(`${localBase}/download?device=&path=${encodeURIComponent("C:\\work\\nope.bin")}&session=sess-local`);
	check("本机分支：本机上找不到文件 → 404 且写明「本机上找不到这个文件」",
		localMissing.status === 404 && localMissing.body.toString("utf8").includes("本机上找不到这个文件"),
		`status=${localMissing.status} body=${JSON.stringify(localMissing.body.toString("utf8").slice(0, 90))}`);
	const localDir = await httpGetBuffer(`${localBase}/download?device=&path=${encodeURIComponent("C:\\work\\some-dir")}&session=sess-local`);
	check("本机分支：路径是目录 → 400 且写明「本机上这个路径不是普通文件」",
		localDir.status === 400 && localDir.body.toString("utf8").includes("本机上这个路径不是普通文件"),
		`status=${localDir.status} body=${JSON.stringify(localDir.body.toString("utf8").slice(0, 90))}`);
	notHtml("本机分支（目录）", { status: localDir.status, headers: localDir.headers, body: localDir.body.toString("utf8") });
	const noServicesRouter = createRouter();
	apply(noServicesRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
	const noServicesHost = await startFakeHost(noServicesRouter);
	const noServices = await httpGetBuffer(`http://127.0.0.1:${noServicesHost.port}${internals.PLUGIN_ROUTE}/download?device=&path=${localPath}&session=sess-local`);
	check("本机分支：组合里没有 workspaceFiles 服务 → 403 且写明（插件绝不绕过官方服务直接读本机磁盘）",
		noServices.status === 403 && noServices.body.toString("utf8").includes("本机文件读取不可用"),
		`status=${noServices.status} body=${JSON.stringify(noServices.body.toString("utf8").slice(0, 100))}`);
	await noServicesHost.close();
	// 本机那条路的失败同样进体检（原因里写着"本机"，排错时一眼看出文件是在哪台机器上找的）。
	const localState = (await httpJson(`${localBase}/state`)).json;
	check("本机分支的失败也进体检（saveAs.lastError 里写明「本机」）",
		localState.diagnostics.saveAs.attempts > 0 && String(localState.diagnostics.saveAs.lastError).includes("本机"),
		JSON.stringify(localState.diagnostics.saveAs.lastError));
	await localHost.close();

	section("H3 GET /plugin/remote/download：真字节、分块流式、Content-Length / Content-Disposition");
	const bigFile = Buffer.alloc(1_200_000);
	for (let index = 0; index < bigFile.length; index += 1) bigFile[index] = index % 251;
	stub.api.files.set("big.bin", { data: bigFile });
	stub.api.files.set("some-dir", { directory: true });
	const readCallsBefore = stub.api.readBytesCalls.length;
	const downloaded = await httpGetBuffer(`${base}/download?device=self&path=big.bin&session=sess-1`);
	check("下载状态 200，content-type 是 application/octet-stream + nosniff（不是 text/html）",
		downloaded.status === 200
		&& String(downloaded.headers["content-type"]).startsWith("application/octet-stream")
		&& String(downloaded.headers["x-content-type-options"]) === "nosniff",
		`status=${downloaded.status} type=${String(downloaded.headers["content-type"])}`);
	notHtmlBinary("GET download（成功）", downloaded);
	check("字节真的取到了：1 200 000 字节逐字节相等（不是占位、不是错误页）",
		downloaded.body.length === bigFile.length && downloaded.body.equals(bigFile),
		`收到 ${String(downloaded.body.length)} 字节`);
	check("Content-Length 来自目标机的 stat（不是我们猜的）",
		String(downloaded.headers["content-length"]) === String(bigFile.length), String(downloaded.headers["content-length"]));
	check("Content-Disposition：ASCII 回退 + RFC 5987（basename 是 big.bin）",
		String(downloaded.headers["content-disposition"]) === "attachment; filename=\"big.bin\"; filename*=UTF-8''big.bin",
		String(downloaded.headers["content-disposition"]));
	const windowCalls = stub.api.readBytesCalls.slice(readCallsBefore);
	check("分块流式：1.2 MB 走了 3 个窗口（512 KiB 一块），offset 依次推进",
		windowCalls.length === 3
		&& windowCalls.every((args) => args.workspaceFileScopeId === "sess-1" && args.path === "big.bin")
		&& JSON.stringify(windowCalls.map((args) => args.options.range.offset)) === JSON.stringify([0, 524_288, 1_048_576])
		&& windowCalls.every((args) => args.options.range.length === internals.DOWNLOAD_CHUNK_BYTES),
		JSON.stringify(windowCalls.map((args) => args.options.range)));
	check("下载用的是 Connection 的一元 Remote RPC（POST /api/workspaceFiles/readBytes，带 JSON 信封）",
		stub.requests.some((request) => request.method === "POST" && request.url === "/api/workspaceFiles/readBytes"),
		[...new Set(stub.requests.map((request) => `${String(request.method)} ${String(request.url)}`))].join(" | "));
	check("stat 也打的是 /api/workspaceFiles/stat（先拿大小与类型）",
		stub.api.statCalls.some((args) => args.path === "big.bin" && args.workspaceFileScopeId === "sess-1"),
		JSON.stringify(stub.api.statCalls.at(-1)));

	const chineseDownload = await httpGetBuffer(`${base}/download?device=self&path=notes%2F%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md&session=sess-1`);
	check("中文文件名：Content-Disposition 用 RFC 5987 的 filename*（%XX 大写、空格 %20）",
		chineseDownload.status === 200
		&& String(chineseDownload.headers["content-disposition"]).includes("filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md"),
		String(chineseDownload.headers["content-disposition"]));
	check("中文名的字节同样取到（与 stub 里那份一致）",
		chineseDownload.body.toString("utf8") === stub.api.files.get("notes/中文 文件.md").data.toString("utf8"),
		JSON.stringify(chineseDownload.body.toString("utf8")));

	const dirAttempt = await httpGetBuffer(`${base}/download?device=self&path=some-dir&session=sess-1`);
	check("路径是目录 → 400 text/plain 且写明「不是普通文件」",
		dirAttempt.status === 400 && dirAttempt.body.toString("utf8").includes("不是普通文件")
		&& String(dirAttempt.headers["content-type"]).startsWith("text/plain"),
		`status=${dirAttempt.status} body=${JSON.stringify(dirAttempt.body.toString("utf8").slice(0, 90))}`);
	notHtml("download 目录", { status: dirAttempt.status, headers: dirAttempt.headers, body: dirAttempt.body.toString("utf8") });

	const missingAttempt = await httpGetBuffer(`${base}/download?device=self&path=nope.bin&session=sess-1`);
	check("目标机找不到文件 → 404 text/plain 且写明「找不到这个文件」",
		missingAttempt.status === 404 && missingAttempt.body.toString("utf8").includes("找不到这个文件"),
		`status=${missingAttempt.status} body=${JSON.stringify(missingAttempt.body.toString("utf8").slice(0, 90))}`);

	const wrongSession = await httpGetBuffer(`${base}/download?device=self&path=big.bin&session=other-sess`);
	check("session 在目标机上不存在 → 404 + 明确说明（gateway/lookup-not-found 被翻译成中文）",
		wrongSession.status === 404 && wrongSession.body.toString("utf8").includes("找不到这个 session"),
		`status=${wrongSession.status} body=${JSON.stringify(wrongSession.body.toString("utf8").slice(0, 120))}`);

	const unreachableDownload = await httpGetBuffer(`${base}/download?device=down&path=a.bin&session=sess-1`);
	check("目标机不可达 → 502 text/plain + 写明不可达（I1：仍然不是 HTML）",
		unreachableDownload.status === 502 && unreachableDownload.body.toString("utf8").includes("不可达"),
		`status=${unreachableDownload.status} body=${JSON.stringify(unreachableDownload.body.toString("utf8").slice(0, 90))}`);
	notHtml("download 不可达", { status: unreachableDownload.status, headers: unreachableDownload.headers, body: unreachableDownload.body.toString("utf8") });

	// 0.13.1：token/会话按 **authority** 存 ⇒ 同一个 authority 的另一条设备会共享会话。
	// 要测"没有 token ⇒ 401"，必须给这台设备一个**独立的 authority**（一台只回 401 的假对端）。
	const unauthDownloadPeer = createServer((req, res) => {
		req.resume();
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
		res.end("dsh web authentication required; no token\n");
	});
	await new Promise((resolve) => unauthDownloadPeer.listen(0, "127.0.0.1", resolve));
	const unauthDownloadPort = unauthDownloadPeer.address().port;
	const noAuthDownloadDevice = await httpJson(`${base}/devices`, { method: "POST", body: { id: "noauth", name: "没配 token", url: `http://127.0.0.1:${unauthDownloadPort}` } });
	const unauthDownload = await httpGetBuffer(`${base}/download?device=noauth&path=big.bin&session=sess-1`);
	check("目标机 401（token 缺失/失效）→ 401 text/plain + 明确提示去补 token（不是 502）",
		noAuthDownloadDevice.json.ok === true && unauthDownload.status === 401
		&& unauthDownload.body.toString("utf8").includes("token"),
		`status=${unauthDownload.status} body=${JSON.stringify(unauthDownload.body.toString("utf8").slice(0, 120))}`);
	notHtml("download 目标机 401", { status: unauthDownload.status, headers: unauthDownload.headers, body: unauthDownload.body.toString("utf8") });
	await httpJson(`${base}/devices/noauth`, { method: "DELETE" });
	await new Promise((resolve) => unauthDownloadPeer.close(resolve));

	const healthAfterDownload = (await httpJson(`${base}/state`)).json;
	check("体检里能读到「另存为」的最近结果与最近一次失败原因（diagnostics.saveAs + notes）",
		healthAfterDownload.diagnostics.saveAs.attempts > 0
		&& typeof healthAfterDownload.diagnostics.saveAs.lastOkAt === "string"
		&& typeof healthAfterDownload.diagnostics.saveAs.lastError === "string"
		&& healthAfterDownload.diagnostics.saveAs.lastError !== ""
		&& healthAfterDownload.diagnostics.notes.some((note) => note.includes("另存为") && note.includes("最近一次失败")),
		JSON.stringify(healthAfterDownload.diagnostics.saveAs));
	const downloadAgain = await httpGetBuffer(`${base}/download?device=self&path=big.bin&session=sess-1`);
	const healthAfterSuccess = (await httpJson(`${base}/state`)).json;
	check("成功一次之后 saveAs.lastError 被清空（体检不会一直挂着旧错误）",
		downloadAgain.status === 200 && healthAfterSuccess.diagnostics.saveAs.lastError === null
		&& healthAfterSuccess.diagnostics.saveAs.lastErrorAt === null,
		JSON.stringify([downloadAgain.status, healthAfterSuccess.diagnostics.saveAs.lastError]));

	section("H4 POST /plugin/remote/fork：本机源会话读不到时明确报错（HTTP 回退路线，进程内服务不可用）");
	const noLocalApiFork = await httpJson(`${base}/fork`, {
		method: "POST", body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 20 },
	});
	check("本机 /api/session/projections 不存在 → 404 + 写明读本机会话失败（不猜、不静默）",
		noLocalApiFork.status === 404 && String(noLocalApiFork.json.error).includes("读本机会话失败"),
		JSON.stringify(noLocalApiFork.json));
	notHtml("fork 本机会话读失败", noLocalApiFork);

	section("H5 POST /plugin/remote/fork：HTTP 回退读本机会话 → 目标机建会话 + 改名 + 发种子（落点是目标机默认工作区）");
	const localApi = registerLocalSessionApi(router);
	const forkOk = await httpJson(`${base}/fork`, {
		method: "POST", body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 20 },
	});
	notHtml("POST fork（成功）", forkOk);
	check("fork 成功返回 { ok, targetDeviceId, newSessionId }（newSessionId 来自目标机）",
		forkOk.status === 200 && forkOk.json.ok === true && forkOk.json.targetDeviceId === "self"
		&& forkOk.json.newSessionId === "new-sess-1" && forkOk.json.messages === 3,
		JSON.stringify(forkOk.json));
	check("读本机源会话走的是本机 HTTP 的 Remote RPC：session/projections 先拿 asOfSeq",
		localApi.calls.projections.length === 1 && localApi.calls.projections[0].sessionId === "local-sess",
		JSON.stringify(localApi.calls.projections));
	check("再按 asOfSeq 读尾页：address.kind=session / throughSeq=42 / maxMessages=tailN",
		localApi.calls.pages.length === 1
		&& JSON.stringify(localApi.calls.pages[0].address) === JSON.stringify({ kind: "session", sessionId: "local-sess" })
		&& localApi.calls.pages[0].throughSeq === 42
		&& localApi.calls.pages[0].maxMessages === 20,
		JSON.stringify(localApi.calls.pages));
	check("目标机先取默认工作区：POST /api/workspace/initializeDefault，args 是空对象（零参数 descriptor）",
		stub.api.workspaceCalls.length === 1 && JSON.stringify(stub.api.workspaceCalls[0]) === JSON.stringify({}),
		JSON.stringify(stub.api.workspaceCalls));
	check("目标机建会话：POST /api/session/create，args.request 里带**目标机默认工作区的 id**（走 workspaceId，不猜 cwd）",
		stub.api.createCalls.length === 1 && JSON.stringify(stub.api.createCalls[0]) === JSON.stringify({ request: { workspaceId: "ws-default" } }),
		JSON.stringify(stub.api.createCalls));
	check("目标机改名：POST /api/session/rename，args 恰好 {request:{sessionId,title}}，title 是「未命名会话 - 来自<本机名>」",
		stub.api.renameCalls.length === 1
		&& JSON.stringify(Object.keys(stub.api.renameCalls[0])) === JSON.stringify(["request"])
		&& JSON.stringify(Object.keys(stub.api.renameCalls[0].request).sort()) === JSON.stringify(["sessionId", "title"])
		&& stub.api.renameCalls[0].request.sessionId === "new-sess-1"
		&& stub.api.renameCalls[0].request.title.startsWith(`${internals.FORK_UNTITLED_TITLE} - 来自`)
		&& stub.api.renameCalls[0].request.title.length > `${internals.FORK_UNTITLED_TITLE} - 来自`.length
		&& forkOk.json.title === stub.api.renameCalls[0].request.title
		&& forkOk.json.workspaceId === "ws-default"
		&& forkOk.json.workspaceFallback === false
		&& forkOk.json.renameError === null,
		JSON.stringify([stub.api.renameCalls, forkOk.json]));
	check("种子作为第一条消息发出：session/prompt + mode=queue + 指定 sessionId",
		stub.api.promptCalls.length === 1
		&& stub.api.promptCalls[0].request.mode === "queue"
		&& stub.api.promptCalls[0].request.sessionId === "new-sess-1"
		&& typeof stub.api.promptCalls[0].request.requestId === "string"
		&& stub.api.promptCalls[0].request.requestId !== "",
		JSON.stringify(stub.api.promptCalls.map((call) => ({ mode: call.request.mode, sessionId: call.request.sessionId }))));
	check("种子的正文是「role: text」拼出来的上下文（含工具调用的一行摘要）",
		stub.api.promptCalls[0].request.content[0].type === "text"
		&& stub.api.promptCalls[0].request.content[0].text.startsWith("[来自另一台设备的会话分叉]")
		&& stub.api.promptCalls[0].request.content[0].text.includes("用户: 帮我看看 notes/中文 文件.md")
		&& stub.api.promptCalls[0].request.content[0].text.includes("[工具调用：read]")
		&& stub.api.promptCalls[0].request.content[0].text.includes("助手: 读完了。"),
		JSON.stringify(stub.api.promptCalls[0].request.content[0].text.slice(0, 160)));
	check("fork 结束后体检里的 fork 段是成功的（lastError=null、via=http）",
		(await httpJson(`${base}/state`)).json.diagnostics.fork.lastError === null
		&& (await httpJson(`${base}/state`)).json.diagnostics.fork.via === "http",
		JSON.stringify((await httpJson(`${base}/state`)).json.diagnostics.fork));
	localApi.dispose();

	// ------------------------------------------------------------------
	// H5b：分叉的**顺序、落点与标题**（用户实测提的两个问题）
	//   A：新会话标题必须是「<源会话标题> - 来自<本机设备名>」（源标题来自客户端半的 displayTitle）；
	//   B：新会话必须落在**目标机的默认工作区**（workspace/initializeDefault → session/create 带 workspaceId）。
	// 这一组的"本机"是被 URL 自验证**认领**的那台（名字取设备条目的 name=设备A），
	// 源会话改走进程内 ctx.sessionController（不依赖本机 HTTP），目标机仍然是假远端 stub。
	// ------------------------------------------------------------------
	section("H5b POST /plugin/remote/fork：先取目标机默认工作区 → create(workspaceId) → rename(<源标题> - 来自<本机名>) → prompt");
	const nameRouter = createRouter();
	nameRouter.ctx.webServer.port = 19387;
	nameRouter.ctx.webServer.config.port = 19387;
	nameRouter.ctx.webServer.host = "127.0.0.1";
	apply(nameRouter.ctx, {
		dataFile: freshDataFile(),
		devices: [
			{ id: "me", name: "设备A", url: "http://127.0.0.1:19387" },
			{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" },
		],
	}, { muxPath: "/api/remote.mux" });
	const nameCalls = { projections: [], pages: [] };
	nameRouter.ctx._provide("sessionController", {
		async projections(request) {
			nameCalls.projections.push(request);
			return { asOfSeq: 42, values: {} };
		},
		async page(request) {
			nameCalls.pages.push(request);
			return { records: LOCAL_RECORDS, hasMore: false };
		},
	});
	check("H5b 前置：设备表里那台 127.0.0.1:19387 被认领为本机（不给它注册 /dev 代理路由），另一台才是分叉目标",
		JSON.stringify(nameRouter.devPrefixes()) === JSON.stringify(["/dev/self"]), JSON.stringify(nameRouter.devPrefixes()));
	const nameHost = await startFakeHost(nameRouter);
	const nameBase = `http://127.0.0.1:${nameHost.port}${internals.PLUGIN_ROUTE}`;

	stub.api.callOrder.length = 0;
	const named = await httpJson(`${nameBase}/fork`, {
		method: "POST",
		body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 3, sourceTitle: "修跨设备分叉" },
	});
	notHtml("POST fork（带源标题）", named);
	check("① 顺序：workspace/initializeDefault → session/create → session/rename → session/prompt（先取默认工作区再建会话）",
		JSON.stringify(stub.api.callOrder) === JSON.stringify([
			"workspace/initializeDefault", "session/create", "session/rename", "session/prompt",
		]),
		JSON.stringify(stub.api.callOrder));
	check("①-a workspace/initializeDefault 的 args 是空对象（零参数 descriptor，多一个字段会被 assertExactArguments 拒）",
		JSON.stringify(stub.api.workspaceCalls.at(-1)) === JSON.stringify({}), JSON.stringify(stub.api.workspaceCalls.at(-1)));
	check("② session/create 的 args 里带上目标机的默认工作区（workspaceId，不是 cwd —— 抽自 SessionCreateRequest）",
		JSON.stringify(stub.api.createCalls.at(-1)) === JSON.stringify({ request: { workspaceId: "ws-default" } }),
		JSON.stringify(stub.api.createCalls.at(-1)));
	check("③ session/rename 的 args 是 {request:{sessionId,title}}，title 严格 =「修跨设备分叉 - 来自设备A」",
		JSON.stringify(stub.api.renameCalls.at(-1)) === JSON.stringify({ request: { sessionId: "new-sess-1", title: "修跨设备分叉 - 来自设备A" } }),
		JSON.stringify(stub.api.renameCalls.at(-1)));
	check("③-a 响应里带上 title / workspaceId / cwd / workspaceFallback:false / renameError:null（验收看得到目标机实际用的落点）",
		named.status === 200 && named.json.ok === true
		&& named.json.title === "修跨设备分叉 - 来自设备A"
		&& named.json.sourceTitle === "修跨设备分叉"
		&& named.json.localName === "设备A"
		&& named.json.workspaceId === "ws-default"
		&& named.json.cwd === STUB_DEFAULT_WORKSPACE.path
		&& named.json.workspaceFallback === false
		&& named.json.renameError === null,
		JSON.stringify(named.json));

	for (const [label, sourceTitle] of [["缺失（body 里没有这个字段）", undefined], ["空串", ""], ["纯空白", "   "], ["不是字符串（数字）", 123]]) {
		stub.api.callOrder.length = 0;
		const body = { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 3 };
		if (sourceTitle !== undefined) body.sourceTitle = sourceTitle;
		const exchange = await httpJson(`${nameBase}/fork`, { method: "POST", body });
		check(`④ 源标题${label} → title =「未命名会话 - 来自设备A」（绝不空标题 / undefined）`,
			exchange.status === 200 && exchange.json.ok === true
			&& exchange.json.title === "未命名会话 - 来自设备A"
			&& stub.api.renameCalls.at(-1).request.title === "未命名会话 - 来自设备A"
			&& !String(exchange.json.title).includes("undefined"),
			JSON.stringify([exchange.json.title, stub.api.renameCalls.at(-1)]));
	}

	stub.api.callOrder.length = 0;
	stub.api.renameError = true;
	const renameFailed = await httpJson(`${nameBase}/fork`, {
		method: "POST",
		body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 3, sourceTitle: "改名会失败" },
	});
	stub.api.renameError = false;
	notHtml("POST fork（改名失败）", renameFailed);
	check("⑤ rename 失败 → 整个请求仍 ok:true + 带 renameError，且种子照样发出去（会话已建好，不半途而废）",
		renameFailed.status === 200 && renameFailed.json.ok === true
		&& renameFailed.json.newSessionId === "new-sess-1"
		&& typeof renameFailed.json.renameError === "string"
		&& renameFailed.json.renameError.includes(internals.SESSION_RENAME_ENDPOINT)
		&& JSON.stringify(stub.api.callOrder) === JSON.stringify([
			"workspace/initializeDefault", "session/create", "session/rename", "session/prompt",
		]),
		JSON.stringify([renameFailed.json, stub.api.callOrder]));
	check("⑤-a rename 失败时响应里的 title 仍是我们要的目标标题（排错用）",
		renameFailed.json.title === "改名会失败 - 来自设备A", JSON.stringify(renameFailed.json.title));
	check("⑤-b rename 失败写了一条中文 warn 日志（不静默）",
		nameRouter.logs.some((line) => line.includes("改名失败") && line.includes("new-sess-1")),
		JSON.stringify(nameRouter.logs.filter((line) => line.includes("改名")).slice(-1)));

	stub.api.workspaceEmpty = true;
	stub.api.callOrder.length = 0;
	const workspaceMissing = await httpJson(`${nameBase}/fork`, {
		method: "POST",
		body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 3, sourceTitle: "没有默认工作区" },
	});
	stub.api.workspaceEmpty = false;
	notHtml("POST fork（initializeDefault 返回 undefined）", workspaceMissing);
	check("⑥ initializeDefault 返回 undefined → 仍建出会话，create 退回不传工作区，响应带 workspaceFallback:true",
		workspaceMissing.status === 200 && workspaceMissing.json.ok === true
		&& workspaceMissing.json.newSessionId === "new-sess-1"
		&& workspaceMissing.json.workspaceFallback === true
		&& workspaceMissing.json.workspaceId === null && workspaceMissing.json.cwd === null
		&& JSON.stringify(stub.api.createCalls.at(-1)) === JSON.stringify({ request: {} }),
		JSON.stringify([workspaceMissing.json, stub.api.createCalls.at(-1)]));
	stub.api.workspaceError = true;
	const workspaceFailed = await httpJson(`${nameBase}/fork`, {
		method: "POST",
		body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 3, sourceTitle: "老版本目标机" },
	});
	stub.api.workspaceError = false;
	notHtml("POST fork（initializeDefault 报错）", workspaceFailed);
	check("⑥-a initializeDefault 报错（目标机没这个 endpoint）→ 同样降级：ok:true + workspaceFallback:true + 照常改名发种子",
		workspaceFailed.status === 200 && workspaceFailed.json.ok === true
		&& workspaceFailed.json.workspaceFallback === true
		&& workspaceFailed.json.title === "老版本目标机 - 来自设备A"
		&& JSON.stringify(stub.api.createCalls.at(-1)) === JSON.stringify({ request: {} }),
		JSON.stringify([workspaceFailed.json, stub.api.createCalls.at(-1)]));
	check("⑥-b 降级时写了中文 warn 日志（写明这次分叉不指定工作区）",
		nameRouter.logs.some((line) => line.includes("不指定工作区")), JSON.stringify(nameRouter.logs.filter((line) => line.includes("工作区")).slice(-1)));
	check("H5b 收尾：本机源会话一直是走进程内 controller 读的（这一组没注册任何本机 /api 路由）",
		nameCalls.projections.length === 8 && nameCalls.pages.length === 8,
		JSON.stringify({ projections: nameCalls.projections.length, pages: nameCalls.pages.length }));
	await nameHost.close();

	section("H6 POST /plugin/remote/fork：进程内 ctx.sessionController 优先（不经过 HTTP）");
	const inProcCalls = { projections: [], pages: [] };
	const fakeController = {
		async projections(request) {
			inProcCalls.projections.push(request);
			return { asOfSeq: 42, values: {} };
		},
		async page(request) {
			inProcCalls.pages.push(request);
			return { records: LOCAL_RECORDS, hasMore: false };
		},
	};
	const procRouter = createRouter();
	apply(procRouter.ctx, {
		dataFile: freshDataFile(),
		devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}`, token: "stub-token" }],
	}, { muxPath: "/api/remote.mux" });
	procRouter.ctx._provide("sessionController", fakeController);
	const procHost = await startFakeHost(procRouter);
	const procFork = await httpJson(`http://127.0.0.1:${procHost.port}${internals.PLUGIN_ROUTE}/fork`, {
		method: "POST", body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 5 },
	});
	const procJson = procFork.json;
	check("进程内 controller 可用时直接用它（projections → page），返回 {ok:true,newSessionId}",
		procFork.status === 200 && procJson.ok === true && procJson.newSessionId === "new-sess-1"
		&& procJson.via === "ctx.sessionController"
		&& inProcCalls.projections.length === 1 && inProcCalls.pages.length === 1
		&& inProcCalls.pages[0].throughSeq === 42 && inProcCalls.pages[0].maxMessages === 5,
		JSON.stringify([procJson, inProcCalls]));
	notHtml("POST fork（进程内）", procFork);
	await procHost.close();
	check("进程内路线不碰本机 HTTP（没有注册任何本机 /api 路由也照样跑通）",
		procJson.via === "ctx.sessionController");

	section("H7 POST /plugin/remote/fork：请求体校验与失败分支（一律 JSON、绝不是 HTML）");
	const forkBadBodies = [
		["缺 targetDeviceId", { sourceSessionId: "s" }, "targetDeviceId"],
		["非法 targetDeviceId", { targetDeviceId: "bad id!", sourceSessionId: "s" }, "不合法"],
		["未知设备", { targetDeviceId: "ghost", sourceSessionId: "s" }, "unknown device"],
		["缺 sourceSessionId", { targetDeviceId: "self" }, "缺少 sourceSessionId"],
		["sourceSessionId 含 NUL", { targetDeviceId: "self", sourceSessionId: "a\u0000b" }, "sourceSessionId 不合法"],
		["tailN 不是整数", { targetDeviceId: "self", sourceSessionId: "s", tailN: 1.5 }, "tailN"],
		["tailN 超上限", { targetDeviceId: "self", sourceSessionId: "s", tailN: internals.FORK_MAX_TAIL + 1 }, "tailN"],
	];
	for (const [label, payload, wanted] of forkBadBodies) {
		const exchange = await httpJson(`${base}/fork`, { method: "POST", body: payload });
		check(`fork 参数校验：${label} → 400 {ok:false,error}`,
			exchange.status === 400 && exchange.json.ok === false && String(exchange.json.error).includes(wanted),
			JSON.stringify(exchange.json));
		notHtml(`fork 400（${label}）`, exchange);
	}
	const notJsonFork = await httpJson(`${base}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
	check("fork 请求体不是 JSON → 400 {ok:false}（JSON 响应，不是 HTML）",
		notJsonFork.status === 400 && notJsonFork.json.ok === false, JSON.stringify(notJsonFork.json));
	notHtml("fork 坏 JSON", notJsonFork);

	const localApi2 = registerLocalSessionApi(router);
	const unreachableFork = await httpJson(`${base}/fork`, {
		method: "POST", body: { targetDeviceId: "down", sourceSessionId: "local-sess", tailN: 5 },
	});
	check("目标机不可达 → 502 {ok:false, stage:'create', error 写明不可达}",
		unreachableFork.status === 502 && unreachableFork.json.ok === false && unreachableFork.json.stage === "create"
		&& String(unreachableFork.json.error).includes("不可达"),
		JSON.stringify(unreachableFork.json));
	notHtml("fork 目标机不可达", unreachableFork);

	// 一台**没有 token** 的设备：目标机会回 401，插件要把"token 可能失效"讲清楚。
	// 0.13.1：token/会话按 authority 存 ⇒ 共用 stub 会共享已建立的会话；这里同样用独立 authority。
	const unauthForkPeer = createServer((req, res) => {
		req.resume();
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
		res.end("dsh web authentication required; no token\n");
	});
	await new Promise((resolve) => unauthForkPeer.listen(0, "127.0.0.1", resolve));
	const unauthForkPort = unauthForkPeer.address().port;
	const noAuthDevice = await httpJson(`${base}/devices`, { method: "POST", body: { id: "noauth", name: "没配 token", url: `http://127.0.0.1:${unauthForkPort}` } });
	check("前置：新增一台没有 token 的设备", noAuthDevice.json.ok === true, JSON.stringify(noAuthDevice.json));
	const unauthFork = await httpJson(`${base}/fork`, {
		method: "POST", body: { targetDeviceId: "noauth", sourceSessionId: "local-sess", tailN: 5 },
	});
	check("目标机 401（token 失效/缺失）→ 401 + 明确提示去补 token",
		unauthFork.status === 401 && unauthFork.json.ok === false && String(unauthFork.json.error).includes("token"),
		JSON.stringify(unauthFork.json));
	notHtml("fork 目标机 401", unauthFork);

	stub.api.createError = true;
	const createFailedFork = await httpJson(`${base}/fork`, {
		method: "POST", body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 5 },
	});
	stub.api.createError = false;
	check("目标机拒绝创建会话 → 502 {stage:'create'} 且带上目标机的原因与 endpoint",
		createFailedFork.status === 502 && createFailedFork.json.stage === "create"
		&& String(createFailedFork.json.error).includes("session/create")
		&& String(createFailedFork.json.error).includes("create refused"), JSON.stringify(createFailedFork.json));
	notHtml("fork 创建失败", createFailedFork);
	localApi2.dispose();

	const emptyLocalApi = registerLocalSessionApi(router, { records: [{ type: "event", event: { type: "user/message", seq: 1, time: 1, data: { content: [] } } }] });
	const emptyFork = await httpJson(`${base}/fork`, {
		method: "POST", body: { targetDeviceId: "self", sourceSessionId: "local-sess", tailN: 5 },
	});
	check("源会话里没有可带走的文字 → 400 + 明确说明（不建会话、不发空种子）",
		emptyFork.status === 400 && String(emptyFork.json.error).includes("没有可带走的文字"), JSON.stringify(emptyFork.json));
	notHtml("fork 空会话", emptyFork);
	emptyLocalApi.dispose();

	const localDeviceRouter = createRouter();
	localDeviceRouter.ctx.webServer.port = 19387;
	localDeviceRouter.ctx.webServer.config.port = 19387;
	localDeviceRouter.ctx.webServer.host = "127.0.0.1";
	apply(localDeviceRouter.ctx, { dataFile: freshDataFile(), devices: [{ id: "me", name: "本机", url: "http://127.0.0.1:19387" }] }, { muxPath: "/api/remote.mux" });
	const localDeviceHost = await startFakeHost(localDeviceRouter);
	const localTargetFork = await httpJson(`http://127.0.0.1:${localDeviceHost.port}${internals.PLUGIN_ROUTE}/fork`, {
		method: "POST", body: { targetDeviceId: "me", sourceSessionId: "s" },
	});
	check("fork 的目标是「本机」那台 → 400（分叉只往别的机器发）",
		localTargetFork.status === 400 && String(localTargetFork.json.error).includes("本机"),
		JSON.stringify(localTargetFork.json));
	await localDeviceHost.close();
	check("体检里 fork 的最近一次失败原因被记下来（排错就靠它）",
		(await httpJson(`${base}/state`)).json.diagnostics.fork.lastError !== null,
		JSON.stringify((await httpJson(`${base}/state`)).json.diagnostics.fork.lastError));
	await httpJson(`${base}/devices/noauth`, { method: "DELETE" });
	await new Promise((resolve) => unauthForkPeer.close(resolve));

	section("H8 软开关：enabled=false 时两条新能力都不可用（设置页/体检仍可读）");
	const offFile = freshDataFile();
	writeFileSync(offFile, JSON.stringify({
		enabled: false,
		devices: [{ id: "self", name: "假远端", url: `http://127.0.0.1:${stub.port}` }],
		// 退化路线的明文 token（没有凭据服务时就是这么存的）：改回 enabled 后立刻能用。
		tokens: { self: "stub-token" },
		current: "local",
	}), "utf8");
	const offRouter = createRouter();
	apply(offRouter.ctx, { dataFile: offFile }, { muxPath: "/api/remote.mux" });
	const offHost = await startFakeHost(offRouter);
	const offBase = `http://127.0.0.1:${offHost.port}${internals.PLUGIN_ROUTE}`;
	// 先读体检（此时这一对能力还"没被用过"，notes 给的是"当前不可用"的形态）。
	const offState = (await httpJson(`${offBase}/state`)).json;
	check("enabled=false：设置页/体检仍可读，且 saveAs/fork 标为 available:false",
		offState.enabled === false && offState.diagnostics.saveAs.available === false && offState.diagnostics.fork.available === false,
		JSON.stringify([offState.enabled, offState.diagnostics.saveAs.available, offState.diagnostics.fork.available]));
	check("enabled=false：notes 里写明这两条能力当前不可用（软开关与 /dev/** 一致）",
		offState.diagnostics.notes.some((note) => note.includes("另存为") && note.includes("不可用"))
		&& offState.diagnostics.notes.some((note) => note.includes("分叉") && note.includes("不可用")),
		JSON.stringify(offState.diagnostics.notes.filter((note) => note.includes("另存为") || note.includes("分叉")).map((note) => note.slice(0, 50))));
	const offDownload = await httpGet(`${offBase}/download?device=self&path=big.bin&session=sess-1`);
	check("enabled=false：GET /download → 403 text/plain + 写明插件已停用",
		offDownload.status === 403 && String(offDownload.headers.get("content-type")).startsWith("text/plain")
		&& offDownload.body.includes("已停用"), `status=${offDownload.status} body=${JSON.stringify(offDownload.body.slice(0, 80))}`);
	const offFork = await httpJson(`${offBase}/fork`, { method: "POST", body: { targetDeviceId: "self", sourceSessionId: "s" } });
	check("enabled=false：POST /fork → 403 {ok:false} + 写明插件已停用",
		offFork.status === 403 && offFork.json.ok === false && String(offFork.json.error).includes("已停用"),
		JSON.stringify(offFork.json));
	const offStateAfter = (await httpJson(`${offBase}/state`)).json;
	check("enabled=false：被拒绝的那两次也进了体检（notes 里是「最近一次失败」形态，含原因）",
		offStateAfter.diagnostics.saveAs.lastError !== null && offStateAfter.diagnostics.fork.lastError !== null
		&& offStateAfter.diagnostics.notes.some((note) => note.includes("另存为") && note.includes("最近一次失败"))
		&& offStateAfter.diagnostics.notes.some((note) => note.includes("分叉") && note.includes("最近一次失败")),
		JSON.stringify([offStateAfter.diagnostics.saveAs.lastError, offStateAfter.diagnostics.fork.lastError]));
	const backOn = await httpJson(`${offBase}/enabled`, { method: "POST", body: { enabled: true } });
	const onDownload = await httpGet(`${offBase}/download?device=self&path=big.bin&session=sess-1`);
	check("改回 enabled=true 后立刻可用（403 停用 → 变成真的下载 200）",
		backOn.json.ok === true && onDownload.status === 200
		&& String(onDownload.headers.get("content-type")).startsWith("application/octet-stream"),
		`status=${onDownload.status}`);
	await offHost.close();

	section("H9 体检字段与 notes：两条新能力都有一条人能读的说明");
	const finalState = (await httpJson(`${base}/state`)).json;
	check("diagnostics 多了 saveAs / fork 两段（形状固定：available/lastError/lastErrorAt/lastOkAt/attempts；fork 另带 tailN/tailDefault/tailMax）",
		JSON.stringify(Object.keys(finalState.diagnostics.saveAs).sort()) === JSON.stringify(["attempts", "available", "lastError", "lastErrorAt", "lastOkAt"])
		&& JSON.stringify(Object.keys(finalState.diagnostics.fork).sort()) === JSON.stringify(["attempts", "available", "lastError", "lastErrorAt", "lastOkAt", "tailDefault", "tailMax", "tailN", "via"]),
		JSON.stringify([Object.keys(finalState.diagnostics.saveAs), Object.keys(finalState.diagnostics.fork)]));
	check("notes 里两条新能力各有一条状态/最近失败说明（不再有路由形状那类说明书）",
		finalState.diagnostics.notes.some((note) => note.includes("另存为"))
		&& finalState.diagnostics.notes.some((note) => note.includes("分叉")),
		JSON.stringify(finalState.diagnostics.notes.filter((note) => note.includes("另存为") || note.includes("分叉")).map((note) => note.slice(0, 60))));
	check("静态说明书类文案已从体检 notes 里移除（只剩现状 + ⚠ 告警）",
		!finalState.diagnostics.notes.some((note) => note.includes("可信请求") || note.includes("分叉顺序固定") || note.includes("0.8.1 起它会落盘")),
		JSON.stringify(finalState.diagnostics.notes.map((note) => note.slice(0, 40))));

	// ===== 0.10.2：会话 cookie 的名字**以服务器给的为准**（对外入口改写 Host 后就靠这条活）=====
	section("G14 会话 cookie：名字以服务器为准（修对外入口下的 401）");

	{
		// 单元级：罐子按**服务器给的名字**存/发（对外入口改写 Host 后，上游名字 ≠ 设备地址派生名）。
		const sessions = new Map();
		const runtime = { sessions, sessionStore: undefined };
		const device = { id: "d1", authority: "192.0.2.4:19387" };
		internals.captureSession(device, ["other=1; Path=/", "dsh-auth-SERVERGIVEN=v1.abc; Path=/; HttpOnly"], runtime);
		check("上游名字 ≠ 设备地址派生名时，罐子照样存下整对（这修的就是对外入口下的 401）",
			sessions.get("d1") === "dsh-auth-SERVERGIVEN=v1.abc", String(sessions.get("d1")));
		check("发出去的 Cookie 就是服务器给的那一对（原样，不再按设备地址重造名字）",
			internals.cookieHeaderFor(device, undefined, runtime) === "dsh-auth-SERVERGIVEN=v1.abc",
			String(internals.cookieHeaderFor(device, undefined, runtime)));
		const empty = { sessions: new Map(), sessionStore: undefined };
		const deviceCookie = `${internals.cookieNameFor(device.authority)}=fromBrowser`;
		check("罐子空时仍回落到浏览器带来的、名字正好等于设备派生的那个 cookie",
			internals.cookieHeaderFor(device, deviceCookie, empty) === deviceCookie,
			String(internals.cookieHeaderFor(device, deviceCookie, empty)));
		check("别的 authority 的浏览器 cookie 绝不会被发过去",
			internals.cookieHeaderFor(device, `${internals.cookieNameFor("127.0.0.1:2851")}=mine`, empty) === undefined,
			String(internals.cookieHeaderFor(device, `${internals.cookieNameFor("127.0.0.1:2851")}=mine`, empty)));
		check("纯函数：sessionPairFromSetCookie 只认 dsh-auth- 前缀、返回整对、找不到就 undefined",
			internals.sessionPairFromSetCookie(["other=1; Path=/", "dsh-auth-zzz=v1.abc; Path=/"]) === "dsh-auth-zzz=v1.abc"
			&& internals.sessionPairFromSetCookie(["nope=1; Path=/"]) === undefined
			&& internals.sessionPairFromSetCookie([]) === undefined,
			String(internals.sessionPairFromSetCookie(["dsh-auth-zzz=v1.abc; Path=/"])));
	}

	// 先出结果再清理：Node 的 server.close() 不覆盖升级 socket（dsh-host-webserver 也必须显式
	// 跟踪 upgradedSockets），所以 close 的回调不保证触发，绝不能让收尾等待挡住结果输出。
	// ===== 0.10.0：对外入口（起停 / 403 / Host 改写 / 迁移 / 软开关连坐）=====
	section("G13 对外入口（0.10.0）：改写 Host 转给本机 DSH、挡 /plugin/**、迁移与软开关连坐");

	const edgeFreePort = async () => {
		const probe = createServer();
		await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const port = probe.address().port;
		await new Promise((resolve) => probe.close(resolve));
		return port;
	};

	{
		const page = await accessHost({ fakeEditor: {} });
		const seenHosts = [];
		page.router.ctx.webServer.register({
			kind: "exact",
			path: "/echo-host",
			handler: (req, res) => {
				seenHosts.push(String(req.headers.host ?? ""));
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end("ok");
			},
		});
		const port = await edgeFreePort();

		check("默认：对外入口关着（state.edge.enabled=false）",
			(await httpJson(`${page.base}/state`)).json.edge.enabled === false);

		const on = await httpJson(`${page.base}/access`, { method: "POST", body: { edgeEnabled: true, edgePort: port } });
		check("开对外入口（端口 ≠ DSH 端口）→ 200 且立刻在监听（不要求重启）",
			on.status === 200 && on.json.edge?.running === true && on.json.restartRequired !== true,
			JSON.stringify(on.json));
		const st = (await httpJson(`${page.base}/state`)).json.edge;
		check("state.edge 报 enabled/running/port/targetPort",
			st.enabled === true && st.running === true && st.port === port && st.targetPort === page.host.port,
			JSON.stringify(st));

		const urlsAfter = (await httpJson(`${page.base}/urls`)).json;
		check("对外入口开着时，「本机地址」用对外端口列各网卡地址（回环那条仍是 DSH 自己的内部口）",
			urlsAfter.urls.some((entry) => entry.base === `http://127.0.0.1:${page.host.port}`)
			&& urlsAfter.urls.some((entry) => entry.base.endsWith(`:${port}`) && !entry.base.includes("127.0.0.1")),
			JSON.stringify(urlsAfter.urls.map((entry) => entry.base)));

		const blocked = await httpGet(`http://127.0.0.1:${port}/plugin/remote/state`);
		check("经对外入口打 /plugin/** → 403（设置页/写路由仍只认回环）",
			blocked.status === 403 && blocked.body.includes("edge"), `${String(blocked.status)} ${blocked.body.slice(0, 60)}`);

		const viaEdge = await httpGet(`http://127.0.0.1:${port}/echo-host`);
		check("经对外入口的请求：本机 DSH 收到的 Host 改写成【固定的】对内 authority（0.13.3：cookie 只认 Host，与实际端口解耦）",
			viaEdge.status === 200 && seenHosts.at(-1) === internals.EDGE_INNER_AUTHORITY, `seen=${JSON.stringify(seenHosts)}`);

		// 0.10.3：对外端口不能和 DSH 自己的端口撞 —— 直接 409 提示，**不写 profile**（不再有迁移）。
		const callsBefore = page.fake.calls.length;
		const samePort = await httpJson(`${page.base}/access`, { method: "POST", body: { edgeEnabled: true, edgePort: page.host.port } });
		check("对外端口 == DSH 自己的端口 → 409 + 中文提示，且 profile 一个字节都没写",
			samePort.status === 409 && samePort.json.ok === false && /[\u4e00-\u9fa5]/u.test(String(samePort.json.error))
			&& page.fake.calls.length === callsBefore,
			`${String(samePort.status)} ${String(samePort.json === null || samePort.json === undefined ? "" : samePort.json.error).slice(0, 70)} calls=${String(page.fake.calls.length)}`);

		const off = await httpJson(`${page.base}/enabled`, { method: "POST", body: { enabled: false } });
		const offState = (await httpJson(`${page.base}/state`)).json;
		check("软开关停用 → 对外入口一起停（B），state.edge.running=false",
			off.json.ok === true && offState.enabled === false && offState.edge.running === false,
			JSON.stringify(offState.edge));
		let gone = false;
		try {
			await httpGet(`http://127.0.0.1:${port}/echo-host`);
		} catch {
			gone = true;
		}
		check("停用后那个对外端口真的关上了", gone === true);
		await page.close();
	}

	// ===== 0.12.1：句柄卫生（"远程连着时更新器装不上"= 活跃连接留下的 ref 句柄）=====
	// 真机症状：本插件停用后更新成功，远程连着时失败（graceful task teardown / deadline exceeded）。
	// 这几条用桩把"进程能不能退出"相关的动作全部钉住：unref / connection 跟踪 /
	// closeAllConnections / agent:false / 定时器 unref —— 业务语义（Host 改写、目标端口）另有一条回归。
	section("G15 句柄卫生（0.12.1）：edge 不挡 Host 退出 + 定时器一律 unref");

	{
		/** 桩 socket：可断言 destroy，可手动触发 close。 */
		const makeSocket = () => {
			const handlers = new Map();
			const socket = {
				destroyed: false,
				destroyCount: 0,
				pipe: () => socket,
				write: () => true,
				end: () => socket,
				destroy() {
					socket.destroyed = true;
					socket.destroyCount += 1;
					return socket;
				},
				on(event, handler) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
					return socket;
				},
				emit(event, ...args) {
					for (const handler of handlers.get(event) ?? []) handler(...args);
					return true;
				},
			};
			return socket;
		};
		/** 桩 server：记录 unref/close/closeAllConnections/listen 的**顺序**与监听器。 */
		const makeServer = () => {
			const handlers = new Map();
			const calls = { unref: 0, close: 0, closeAllConnections: 0, listen: [], order: [] };
			const server = {
				on(event, handler) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
					return server;
				},
				unref() {
					calls.unref += 1;
					calls.order.push("unref");
					return server;
				},
				close() {
					calls.close += 1;
					calls.order.push("close");
					return server;
				},
				closeAllConnections() {
					calls.closeAllConnections += 1;
					calls.order.push("closeAllConnections");
				},
				listen(port, host, callback) {
					calls.listen.push([port, host]);
					calls.order.push("listen");
					if (typeof callback === "function") callback();
					return server;
				},
			};
			return {
				server,
				calls,
				emit: (event, ...args) => {
					for (const handler of handlers.get(event) ?? []) handler(...args);
				},
			};
		};

		const originalIo = { ...internals.edgeIo };
		const made = { servers: [], requests: [], connects: [] };
		const stubs = { upstreamForHttp: null, upstreamForWs: null };
		try {
			internals.edgeIo.server = (handler) => {
				const wrapper = makeServer();
				wrapper.handler = handler;
				made.servers.push(wrapper);
				return wrapper.server;
			};
			internals.edgeIo.request = (options) => {
				made.requests.push(options);
				stubs.upstreamForHttp = makeSocket();
				return stubs.upstreamForHttp;
			};
			internals.edgeIo.connect = (port, host, callback) => {
				made.connects.push([port, host]);
				stubs.upstreamForWs = makeSocket();
				// 真 netConnect 的 connect 回调**总是**异步的（`const upstream = …` 那时已经赋值）；
				// 桩这里也必须异步，否则会踩到 TDZ（那是桩的错，不是插件的）。
				if (typeof callback === "function") queueMicrotask(callback);
				return stubs.upstreamForWs;
			};

			const edgeState = {
				server: null, port: null, targetPort: null, running: false, error: null,
				sockets: new Set(), upstreamSockets: new Set(),
			};
			const runtime = {
				ctx: { webServer: { port: 2851 }, logger: { warn: () => {}, info: () => {}, error: () => {} } },
				data: { enabled: true, edge: { enabled: true, port: 39001 } },
				edge: edgeState,
				timers: new Set(),
				disposed: false,
			};

			internals.startEdge(runtime);
			const wrapper = made.servers[0];
			check("startEdge 创建 server 后**立刻** unref（在 listen 之前；辅助服务器不挡 Host 进程退出）",
				wrapper !== undefined && wrapper.calls.unref === 1 && wrapper.calls.order[0] === "unref"
				&& wrapper.calls.order.includes("listen")
				&& JSON.stringify(wrapper.calls.listen) === JSON.stringify([[39001, "0.0.0.0"]]),
				JSON.stringify(wrapper?.calls.order));

			const keepAlive = makeSocket();
			const sse = makeSocket();
			wrapper.emit("connection", keepAlive);
			wrapper.emit("connection", sse);
			check("connection 事件把**所有**入站 socket（HTTP keep-alive / SSE，不只是 upgrade）都收进 state.sockets",
				edgeState.sockets.size === 2 && edgeState.sockets.has(keepAlive) && edgeState.sockets.has(sse),
				String(edgeState.sockets.size));
			keepAlive.emit("close");
			check("入站 socket 断开后自动从跟踪集合移除（长跑不涨内存）",
				edgeState.sockets.size === 1 && !edgeState.sockets.has(keepAlive), String(edgeState.sockets.size));

			const req = {
				url: "/api/session/list",
				method: "GET",
				headers: { host: "192.0.2.4:39001", origin: "http://192.0.2.4:39001", referer: "http://192.0.2.4:39001/index" },
				on: () => {},
				pipe: () => {},
			};
			const res = { headersSent: false, writeHead: () => {}, end: () => {}, on: () => {} };
			wrapper.handler(req, res);
			const forward = made.requests[0];
			check("转发上游请求带 agent:false（不复用 keep-alive 池：关闭后不留下池里的空闲 socket）",
				forward !== undefined && forward.agent === false, JSON.stringify(forward?.agent));
			check("业务语义没变：仍转发到 127.0.0.1:<本机 DSH 端口>，但 Host/Origin 改成【固定的】对内 authority（0.13.3）",
				forward?.host === "127.0.0.1" && forward?.port === 2851
				&& forward?.headers?.host === internals.EDGE_INNER_AUTHORITY
				&& forward?.headers?.origin === `http://${internals.EDGE_INNER_AUTHORITY}`,
				`${String(forward?.host)}:${String(forward?.port)} host=${String(forward?.headers?.host)}`);

			const wsInbound = makeSocket();
			wrapper.emit("upgrade", { url: "/dev/d1/session-mux", headers: { host: "192.0.2.4:39001" } }, wsInbound, Buffer.alloc(0));
			check("WebSocket 升级转发的上游 socket 进单独集合（与入站 socket 分开跟踪）",
				made.connects.length === 1 && made.connects[0][0] === 2851 && made.connects[0][1] === "127.0.0.1"
				&& edgeState.upstreamSockets.size === 1 && edgeState.upstreamSockets.has(stubs.upstreamForWs),
				`connects=${JSON.stringify(made.connects)} upstreams=${String(edgeState.upstreamSockets.size)}`);

			const unrefBefore = wrapper.calls.unref;
			internals.stopEdge(runtime);
			check("stopEdge 同步调 close() + closeAllConnections()（keep-alive/SSE 不会让 close 一直等）",
				wrapper.calls.close === 1 && wrapper.calls.closeAllConnections === 1 && edgeState.server === null,
				JSON.stringify(wrapper.calls));
			check("stopEdge 再 unref 一次（辅助服务器不再是 ref 句柄）",
				wrapper.calls.unref === unrefBefore + 1 && wrapper.calls.order.at(-2) === "closeAllConnections",
				`${String(unrefBefore)}→${String(wrapper.calls.unref)} order=${JSON.stringify(wrapper.calls.order)}`);
			check("stopEdge 同步 destroy 全部已跟踪 socket（入站 keep-alive / SSE / upgrade + 升级上游）并清空集合",
				sse.destroyed === true && wsInbound.destroyed === true && stubs.upstreamForWs.destroyed === true
				&& edgeState.sockets.size === 0 && edgeState.upstreamSockets.size === 0,
				`keepAlive=${String(keepAlive.destroyed)} sse=${String(sse.destroyed)} ws=${String(wsInbound.destroyed)} upstream=${String(stubs.upstreamForWs.destroyed)}`);
			internals.stopEdge(runtime);
			check("stopEdge 幂等且**同步**（返回 undefined；重复调用不炸、也不再多关一次）",
				internals.stopEdge(runtime) === undefined && edgeState.running === false && wrapper.calls.close === 1);

			// 定时器：宿主侧（lib/index.js）**每一个** setTimeout/setInterval 句柄都必须过 unrefTimer。
			const hostSource = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
			const missingUnref = [];
			for (const match of hostSource.matchAll(/(?:const\s+)?((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\s*=\s*set(?:Timeout|Interval)\(/gu)) {
				const name = match[1];
				const tail = hostSource.slice(match.index, match.index + 1200);
				if (!tail.includes(`unrefTimer(${name})`)) {
					missingUnref.push(`${name}@L${String(hostSource.slice(0, match.index).split("\n").length)}`);
				}
			}
			check("lib/index.js 里每个 setTimeout/setInterval 句柄都过 unrefTimer（不留下会把 Host 拖住的定时器）",
				missingUnref.length === 0, missingUnref.join(", "));
			const timerStub = { calls: 0, unref() { this.calls += 1; } };
			check("unrefTimer：有 unref 就调；null / 没有 unref 的桩也不炸（老 Node 与桩都能用）",
				internals.unrefTimer(timerStub) === timerStub && timerStub.calls === 1
				&& internals.unrefTimer(null) === null && typeof internals.unrefTimer({}) === "object");
		} finally {
			// 桩必须还回去：后面的用例还要用真的 node:http / node:net。
			internals.edgeIo.server = originalIo.server;
			internals.edgeIo.request = originalIo.request;
			internals.edgeIo.connect = originalIo.connect;
		}
	}

	// ------------------------------------------------------------------
	// L：跨机实时状态（生产 + 聚合）—— 本机页面口 + 跨机取数口
	// ------------------------------------------------------------------
	section("L1 /plugin/remote/live：聚合形状 + 对端可达性语义（404 不画红、网络错才红）");

	/** 假对端 DSH：`GET /dsh-remote-live` 回自己的 live，`POST .../seen` 回清完的 live。 */
	const startFakeLivePeer = async (options = {}) => {
		const calls = { get: 0, seen: 0, paths: [], methods: [] };
		const server = createServer((req, res) => {
			let pathname = "/";
			try {
				pathname = new URL(req.url ?? "/", "http://local.invalid").pathname;
			} catch {
				pathname = "/";
			}
			calls.paths.push(pathname);
			calls.methods.push(req.method);
			req.resume();
			req.on("end", () => {
				if (options.status !== undefined && options.status !== 200) {
					res.writeHead(options.status, { "content-type": "text/html; charset=utf-8" });
					res.end("<html><body>nope</body></html>");
					return;
				}
				const live = { ...(options.live ?? { running: 2, pending: 1, unread: true, doneAt: 111, at: 222 }) };
				if (pathname === internals.PEER_LIVE_SEEN_PATH && req.method === "POST") {
					calls.seen += 1;
					live.unread = false;
				} else {
					calls.get += 1;
				}
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ at: Date.now(), live }));
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		return {
			port: server.address().port,
			calls,
			close: () => new Promise((resolve) => server.close(resolve)),
		};
	};

	/** 一个**没人听**的端口（先占用再关掉）：用来制造"连接失败"这类网络错误。 */
	const freeDeadPort = async () => {
		const server = createServer(() => {});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		await new Promise((resolve) => server.close(resolve));
		return port;
	};

	const liveUp = await startFakeLivePeer();
	const liveOld = await startFakeLivePeer({ status: 404 });
	const liveDeadPort = await freeDeadPort();

	const liveItems = { value: [] };
	const liveListCalls = { count: 0, signals: 0 };
	const liveFile = join(workDir, "live-l1.json");
	// 注意：`sessionController` 不能塞进 createRouter 的 options.services（那里已经 defineProperty 过一次，
	// 重定义会抛）；照 H5b/H6 的做法用 `ctx._provide` 在 apply 之后再给（这也正好走一遍真实的
	// "服务晚到 → ctx.inject 回调才触发" 路线）。
	const liveRouter = createRouter();
	apply(liveRouter.ctx, {
		dataFile: freshDataFile(),
		liveFile,
		current: "me",
		devices: [
			{ id: "me", name: "本机台", url: "http://127.0.0.1:9" },
			{ id: "up", name: "设备B", url: `http://127.0.0.1:${liveUp.port}` },
			{ id: "old", name: "老版本台", url: `http://127.0.0.1:${liveOld.port}` },
			{ id: "dead", name: "关着的台", url: `http://127.0.0.1:${liveDeadPort}` },
		],
	}, { muxPath: "/api/remote.mux", livePollMs: 40 });
	liveRouter.ctx._provide("sessionController", {
		async list(_request, signal) {
			liveListCalls.count += 1;
			if (signal !== undefined && signal !== null && typeof signal.throwIfAborted === "function") liveListCalls.signals += 1;
			return { items: liveItems.value };
		},
	});
	const liveHost = await startFakeHost(liveRouter);
	const liveBase = `http://127.0.0.1:${liveHost.port}${internals.PLUGIN_ROUTE}`;
	await sleep(300);

	const liveResp = await httpJson(`${liveBase}/live`);
	notHtml("GET /plugin/remote/live", liveResp);
	const liveJson = liveResp.json;
	check("GET /plugin/remote/live → 200 JSON，顶层正好 {at, self, peers}",
		liveResp.status === 200 && liveJson !== null
		&& JSON.stringify(Object.keys(liveJson).sort()) === JSON.stringify(["at", "peers", "self"]),
		JSON.stringify(Object.keys(liveJson ?? {})).slice(0, 120));
	check("self 正好 {name, live}（name = 本机被认领那条设备的名字，空串 = 没认领到），live 正好那 5 个字段（running/pending/unread/doneAt/at）",
		liveJson !== null && JSON.stringify(Object.keys(liveJson.self).sort()) === JSON.stringify(["live", "name"])
		&& typeof liveJson.self.name === "string"
		&& JSON.stringify(Object.keys(liveJson.self.live).sort()) === JSON.stringify(["at", "doneAt", "pending", "running", "unread"]),
		JSON.stringify(liveJson === null ? null : liveJson.self));
	check("peers = 设备表减去被认领为本机的那条：3 台，id/name 取自设备配置",
		Array.isArray(liveJson?.peers)
		&& JSON.stringify(liveJson.peers.map((peer) => peer.id)) === JSON.stringify(["up", "old", "dead"])
		&& JSON.stringify(liveJson.peers.map((peer) => peer.name)) === JSON.stringify(["设备B", "老版本台", "关着的台"]),
		JSON.stringify((liveJson?.peers ?? []).map((peer) => [peer.id, peer.name])));
	check("peers[] 每个节点正好 5 个字段（id/name/reachable/lastError/live）",
		Array.isArray(liveJson?.peers) && liveJson.peers.every((peer) => JSON.stringify(Object.keys(peer).sort())
			=== JSON.stringify(["id", "lastError", "live", "name", "reachable"])),
		JSON.stringify((liveJson?.peers ?? []).map((peer) => Object.keys(peer))));

	const peerOf = (id) => (Array.isArray(liveJson?.peers) ? liveJson.peers.find((peer) => peer.id === id) : undefined);
	const peerUp = peerOf("up");
	check("对端 200 + 合法 JSON → reachable=true，live 就是它报的那份（逐字段）",
		peerUp?.reachable === true && peerUp?.lastError === ""
		&& peerUp?.live?.running === 2 && peerUp?.live?.pending === 1 && peerUp?.live?.unread === true
		&& peerUp?.live?.doneAt === 111 && peerUp?.live?.at === 222,
		JSON.stringify(peerUp));
	const peerOld = peerOf("old");
	check("对端 **404**（还没升级）→ reachable=true、live=null、lastError 空（页面**不画红**）",
		peerOld?.reachable === true && peerOld?.live === null && peerOld?.lastError === "",
		JSON.stringify(peerOld));
	const peerDead = peerOf("dead");
	check("对端**连接失败** → reachable=false + lastError 有内容、live=null（只有这种才画红）",
		peerDead?.reachable === false && peerDead?.live === null
		&& typeof peerDead?.lastError === "string" && peerDead.lastError.length > 0,
		JSON.stringify(peerDead));
	check("被认领为本机的那条**不在 peers 里**（本机自己永远不是红的那个）",
		(liveJson?.peers ?? []).every((peer) => peer.id !== "me") === true);
	check("本机生产者真的在轮询，且每次都传了 AbortSignal（ctx.sessionController.list 的硬要求）",
		liveListCalls.count > 0 && liveListCalls.signals === liveListCalls.count,
		`count=${String(liveListCalls.count)} signals=${String(liveListCalls.signals)}`);

	section("L2 跨机取数口 /dsh-remote-live：新注册的路径 + 非 /plugin/ 前缀 + 可信请求守卫");
	check("取数口是**新注册**的独立前缀，且**故意不带 /plugin/**（否则会被对端 edge 的 EDGE_BLOCKED_PREFIXES 403 掉）",
		internals.PEER_LIVE_ROOT === "/dsh-remote-live"
		&& !internals.PEER_LIVE_ROOT.startsWith("/plugin/")
		&& liveRouter.prefixes.has(internals.PEER_LIVE_ROOT),
		JSON.stringify([...liveRouter.prefixes.keys()]));
	const selfLive = await httpJson(`http://127.0.0.1:${liveHost.port}${internals.PEER_LIVE_PATH}`);
	notHtml("GET /dsh-remote-live", selfLive);
	check("取数口只回 {at, live}（**绝不回**聚合的 self/peers，避免跨机递归取数）",
		selfLive.status === 200 && selfLive.json !== null
		&& JSON.stringify(Object.keys(selfLive.json).sort()) === JSON.stringify(["at", "live"])
		&& selfLive.json.self === undefined && selfLive.json.peers === undefined,
		JSON.stringify(selfLive.json).slice(0, 120));
	check("取数口的 live 与本机页面口 self.live 逐字段一致（同一个生产者）",
		JSON.stringify(selfLive.json?.live) === JSON.stringify(liveJson?.self?.live),
		`${JSON.stringify(selfLive.json?.live)} vs ${JSON.stringify(liveJson?.self?.live)}`);
	const peerBadMethod = await httpJson(`http://127.0.0.1:${liveHost.port}${internals.PEER_LIVE_PATH}`, { method: "POST", body: {} });
	check("取数口非 GET/HEAD → 405（不是 200、也不是 HTML）", peerBadMethod.status === 405, String(peerBadMethod.status));
	notHtml("POST /dsh-remote-live（405）", peerBadMethod);

	/** 起一个"守卫会拒绝"的实例（官方判定返回给定码；undefined = 宿主根本没有判定）。 */
	const liveGate = async (verdict) => {
		const gateRouter = createRouter({
			connection: {
				trustedHosts: ["192.0.2.4"],
				browserAuth: { maxAgeMilliseconds: 86_400_000 },
				authenticatedUrl: (base) => `${base}?token=stub`,
				...(verdict === undefined ? {} : { requestRejection: () => verdict }),
			},
		});
		apply(gateRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
		const gateHost = await startFakeHost(gateRouter);
		const exchange = await httpGet(`http://127.0.0.1:${gateHost.port}${internals.PEER_LIVE_PATH}`);
		await gateHost.close();
		return exchange;
	};
	const gated403 = await liveGate(403);
	check("取数口守卫 = 官方可信请求判定：Host/Origin 栅栏没过（403）→ 403 text/plain，正文写明被拒绝",
		gated403.status === 403 && String(gated403.headers.get("content-type")).toLowerCase().startsWith("text/plain")
		&& gated403.body.includes("被拒绝") && gated403.body.includes("403"),
		`${String(gated403.status)} ${JSON.stringify(gated403.body.slice(0, 80))}`);
	notHtml("取数口被拒（403）", gated403);
	const gated401 = await liveGate(401);
	check("取数口：栅栏过了但没有会话 cookie（401）→ 同样 403，正文带 401",
		gated401.status === 403 && gated401.body.includes("401"), JSON.stringify(gated401.body.slice(0, 90)));
	const gatedNone = await liveGate(undefined);
	check("宿主没有官方判定（老 DSH）→ fail-closed 403，正文写明 requestRejection",
		gatedNone.status === 403 && gatedNone.body.includes("requestRejection"), JSON.stringify(gatedNone.body.slice(0, 110)));

	// ------------------------------------------------------------------
	// L2b（0.12.0）：**浏览器口** `GET /dsh-remote-view`
	//
	// 为什么要有它：edge（对外端口）只拦 `/plugin/` 前缀，所以走 edge 的浏览器里
	// `/plugin/remote/live` 永远 403（状态点一个都画不出来）；`/dsh-remote-live` 又是
	// **跨机取数口**（只回本机自己、防跨机递归），语义不能动。于是新开这一条**非 `/plugin/`**
	// 的聚合口：同形聚合 + `version`，守卫用官方的可信请求判定（与「另存为」同一把尺子）。
	// 本组用例盯：路径形状、注册、可信守卫（含伪造请求被拒且不泄漏聚合）、
	// 返回形状（同形 + version）、以及**页面口与跨机取数口一个字没变**。
	// ------------------------------------------------------------------
	section("L2b 浏览器口 /dsh-remote-view（0.12.0）：非 /plugin/ 前缀 + 同形聚合 + version + 可信守卫");
	check("浏览器口是新注册的独立前缀，**故意不带 /plugin/**，且与跨机取数口不是同一条",
		internals.VIEW_PATH === "/dsh-remote-view"
		&& !internals.VIEW_PATH.startsWith("/plugin/")
		&& internals.VIEW_PATH !== internals.PEER_LIVE_ROOT
		&& liveRouter.prefixes.has(internals.VIEW_PATH),
		JSON.stringify([...liveRouter.prefixes.keys()]));
	const viewResp = await httpJson(`http://127.0.0.1:${liveHost.port}${internals.VIEW_PATH}`);
	notHtml("GET /dsh-remote-view", viewResp);
	check("浏览器口 → 200 JSON，顶层 = 页面口那三个键 **+ version**（只多这一个字段）",
		viewResp.status === 200 && viewResp.json !== null
		&& JSON.stringify(Object.keys(viewResp.json).sort()) === JSON.stringify(["at", "peers", "self", "version"]),
		JSON.stringify(Object.keys(viewResp.json ?? {})).slice(0, 140));
	check("version = 本机 dsh-remote 的版本号（internals.VERSION，与 package.json 的对账在 T0）",
		viewResp.json?.version === internals.VERSION && internals.VERSION === "0.16.2",
		String(viewResp.json?.version));
	check("self / peers 与页面口**逐字段同形**（同一个 builder：键集与对端 id 完全一致；`at` 这类时间戳本来就每次都变）",
		JSON.stringify(Object.keys(viewResp.json?.self ?? {}).sort()) === JSON.stringify(Object.keys(liveJson?.self ?? {}).sort())
		&& JSON.stringify((viewResp.json?.peers ?? []).map((peer) => Object.keys(peer).sort().join(",")))
			=== JSON.stringify((liveJson?.peers ?? []).map((peer) => Object.keys(peer).sort().join(",")))
		&& JSON.stringify((viewResp.json?.peers ?? []).map((peer) => peer.id)) === JSON.stringify((liveJson?.peers ?? []).map((peer) => peer.id)),
		`self=${JSON.stringify(Object.keys(viewResp.json?.self ?? {}))} peers=${JSON.stringify((viewResp.json?.peers ?? []).map((peer) => Object.keys(peer).sort()))}`);
	check("浏览器口非 GET/HEAD → 405（不是 200、也不是 HTML）",
		(await httpJson(`http://127.0.0.1:${liveHost.port}${internals.VIEW_PATH}`, { method: "POST", body: {} })).status === 405);
	check("浏览器口只认自己那条路径（前缀路由下的子路径 404，不乱答）",
		(await httpJson(`http://127.0.0.1:${liveHost.port}${internals.VIEW_PATH}/x`)).status === 404,
		String((await httpJson(`http://127.0.0.1:${liveHost.port}${internals.VIEW_PATH}/x`)).status));
	// 页面口 / 跨机取数口的语义**一个字没变**：页面口没有 version，跨机口仍然只回 {at, live}。
	const liveAgain = (await httpJson(`${liveBase}/live`)).json;
	check("页面口 /plugin/remote/live **没有** version（同形 ≠ 同一条；它只认回环、形状未变）",
		liveAgain !== null && liveAgain.version === undefined
		&& JSON.stringify(Object.keys(liveAgain).sort()) === JSON.stringify(["at", "peers", "self"]),
		JSON.stringify(Object.keys(liveAgain ?? {})));
	const peerAgain = (await httpJson(`http://127.0.0.1:${liveHost.port}${internals.PEER_LIVE_PATH}`)).json;
	check("跨机取数口 /dsh-remote-live 语义未变：仍然只回本机自己的 {at, live}（不聚合、不带 version）",
		peerAgain !== null && JSON.stringify(Object.keys(peerAgain).sort()) === JSON.stringify(["at", "live"])
		&& peerAgain.self === undefined && peerAgain.peers === undefined && peerAgain.version === undefined,
		JSON.stringify(peerAgain ?? {}).slice(0, 120));

	/** 起一个"守卫按请求头判定"的实例：带**跨站 Origin** 的伪造请求一律 403（模拟官方的 Host/Origin 栅栏）。 */
	const viewForge = async () => {
		const forgeRouter = createRouter({
			connection: {
				trustedHosts: ["192.0.2.4"],
				browserAuth: { maxAgeMilliseconds: 86_400_000 },
				authenticatedUrl: (base) => `${base}?token=stub`,
				requestRejection: (req) => {
					const headers = req.headers ?? {};
					const origin = String(headers.origin ?? "");
					if (origin !== "" && origin !== `http://${String(headers.host ?? "")}`) return 403;
					return undefined;
				},
			},
		});
		apply(forgeRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
		const forgeHost = await startFakeHost(forgeRouter);
		// 伪造请求必须用**裸 http** 发：fetch 会把 `origin` 当禁改头丢掉，测不出跨站那条栅栏。
		const forged = await new Promise((resolve, reject) => {
			const request = httpRequest({
				host: "127.0.0.1",
				port: forgeHost.port,
				path: internals.VIEW_PATH,
				method: "GET",
				headers: { origin: "http://evil.example" },
			}, (response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => { body += chunk; });
				response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
			});
			request.on("error", reject);
			request.end();
		});
		const legit = await httpGet(`http://127.0.0.1:${forgeHost.port}${internals.VIEW_PATH}`);
		await forgeHost.close();
		return { forged, legit };
	};
	const { forged, legit } = await viewForge();
	check("伪造请求（跨站 Origin / 不可信 Host）被官方判定拒掉：403 text/plain，**不泄漏聚合体**",
		forged.status === 403 && String(forged.headers["content-type"] ?? "").toLowerCase().startsWith("text/plain")
		&& forged.body.includes("被拒绝") && !forged.body.includes("peers") && !forged.body.includes(internals.VERSION),
		`${String(forged.status)} ${JSON.stringify(forged.body.slice(0, 80))}`);
	notHtml("浏览器口被拒（403）", forged);
	check("同一台机器上不带 Origin 的可信请求照样 200（守卫只拦伪造，不是把浏览器口锁死）",
		legit.status === 200 && String(legit.body).includes(internals.VERSION),
		`${String(legit.status)} ${JSON.stringify(String(legit.body).slice(0, 80))}`);
	const viewGate = async (verdict) => {
		const gateRouter = createRouter({
			connection: {
				trustedHosts: ["192.0.2.4"],
				browserAuth: { maxAgeMilliseconds: 86_400_000 },
				authenticatedUrl: (base) => `${base}?token=stub`,
				...(verdict === undefined ? {} : { requestRejection: () => verdict }),
			},
		});
		apply(gateRouter.ctx, { dataFile: freshDataFile() }, { muxPath: "/api/remote.mux" });
		const gateHost = await startFakeHost(gateRouter);
		const exchange = await httpGet(`http://127.0.0.1:${gateHost.port}${internals.VIEW_PATH}`);
		await gateHost.close();
		return exchange;
	};
	const viewGated403 = await viewGate(403);
	check("浏览器口守卫 = 官方可信请求判定：Host/Origin 栅栏没过（403）→ 403 text/plain + 正文写明",
		viewGated403.status === 403 && viewGated403.body.includes("被拒绝") && viewGated403.body.includes("403"),
		`${String(viewGated403.status)} ${JSON.stringify(viewGated403.body.slice(0, 80))}`);
	const viewGated401 = await viewGate(401);
	check("浏览器口：栅栏过了但没有会话 cookie（401）→ 同样 403，正文带 401",
		viewGated401.status === 403 && viewGated401.body.includes("401"), JSON.stringify(viewGated401.body.slice(0, 90)));
	const viewGatedNone = await viewGate(undefined);
	check("宿主没有官方判定（老 DSH）→ fail-closed 403，正文写明 requestRejection",
		viewGatedNone.status === 403 && viewGatedNone.body.includes("requestRejection"), JSON.stringify(viewGatedNone.body.slice(0, 110)));

	section("L3 本机 unread：首轮不判完成、running 由 >0 变 0 才亮、落盘独立文件");
	const selfLiveNow = async () => (await httpJson(`${liveBase}/live`)).json.self.live;
	check("**首轮**（prevRunning 还没有基准）running=0 **不判完成**：unread=false、doneAt=0、at>0（轮询确实跑过）",
		liveJson?.self?.live?.unread === false && liveJson?.self?.live?.doneAt === 0 && liveJson?.self?.live?.at > 0,
		JSON.stringify(liveJson?.self?.live));
	liveItems.value = [{ running: true }];
	await sleep(200);
	const afterRunning = await selfLiveNow();
	check("有会话在跑：running=1，仍然 unread=false（没跑完之前绝不亮绿）",
		afterRunning.running === 1 && afterRunning.unread === false, JSON.stringify(afterRunning));
	liveItems.value = [{ running: true, sessionId: "s-amber", projections: { values: { userQuestions: { active: [{ callId: "c1" }, { callId: "c2" }] } } } }];
	await sleep(200);
	const afterPending = await selfLiveNow();
	check("pending 再也**不看** projections.values.userQuestions.active（真机实测那个源恒为 0）⇒ 这里就是 0",
		afterPending.running === 1 && afterPending.pending === 0, JSON.stringify(afterPending));
	liveItems.value = [];
	await sleep(200);
	const afterDone = await selfLiveNow();
	check("running 由 >0 变 0 的那一瞬置 unread=true + doneAt=Date.now()",
		afterDone.running === 0 && afterDone.unread === true && afterDone.doneAt > 0, JSON.stringify(afterDone));
	const liveOnDisk = readJsonFile(liveFile);
	check("unread/doneAt **立刻落盘**到独立文件（正好只有这两个键）",
		JSON.stringify(Object.keys(liveOnDisk).sort()) === JSON.stringify(["doneAt", "unread"])
		&& liveOnDisk.unread === true && liveOnDisk.doneAt === afterDone.doneAt,
		`${liveFile} → ${JSON.stringify(liveOnDisk)}`);
	check("缺省落盘文件名就是 $DSH_HOME/dsh-remote-live.json（绝不用探针插件那份 dsh-device-panel-live.json）",
		internals.LIVE_FILE_NAME === "dsh-remote-live.json"
		&& internals.resolveLivePath({}) === join(internals.dshHome(), "dsh-remote-live.json"),
		internals.resolveLivePath({}));

	// ---- L3b 琥珀（pending）判定：尾页事件（2026-10-17 真机实测的两种卡）----
	section("L3b pending（琥珀）：只算「卡在等用户回答/批准」的 running 会话，判据取自会话尾页事件");

	// 一个最小的"运行时"替身：琥珀判定只读 `live`（状态）、`sessionController` 与 `ctx`（日志）。
	// 这里**不用**那个真 runtime（`apply` 不返回它）：直接用 `internals.pollLocalLive` 走一遍真实代码路径。
	const rt = {
		ctx: liveRouter.ctx,
		live: internals.createLiveState(),
		sessionController: undefined,
		localDevice: undefined,
		devices: [],
	};
	const pendingStub = {
		records: [],
		/** `(sessionId) => records`：每条被读的会话拿到自己那份尾页。 */
		recordsFor: () => [],
		items: [],
		projectionsCalls: 0,
		pageCalls: 0,
		/** false = 只实现 list()（老宿主半 / 接口形状不全会走的那条路）。 */
		withPage: true,
		pageError: false,
		listError: false,
		async projections(_request, signal) {
			if (signal === undefined || signal === null || typeof signal.throwIfAborted !== "function") throw new Error("projections 缺 AbortSignal");
			pendingStub.projectionsCalls += 1;
			return { asOfSeq: 99, values: {} };
		},
		async page(request, signal) {
			if (signal === undefined || signal === null || typeof signal.throwIfAborted !== "function") throw new Error("page 缺 AbortSignal");
			pendingStub.pageCalls += 1;
			if (pendingStub.pageError === true) throw new Error("page 炸了");
			if (request.throughSeq !== 99) throw new Error(`page 必须带 asOfSeq 当 throughSeq，收到 ${JSON.stringify(request)}`);
			return { records: pendingStub.recordsFor(request.address.sessionId), hasMore: false };
		},
		async list(_request, signal) {
			if (signal === undefined || signal === null || typeof signal.throwIfAborted !== "function") throw new Error("list 缺 AbortSignal");
			if (pendingStub.listError === true) throw new Error("list 炸了");
			return { items: pendingStub.items };
		},
	};
	const pendingNow = () => internals.liveViewOf(internals.liveStateOf(rt)).pending;
	/** 真机上抓到的那三种尾巴（原样照抄 seq / data 字段）。 */
	const tailAsk = [
		{ type: "event", event: { type: "assistant/message", seq: 19, data: {} } },
		{ type: "event", event: { type: "tool/call", seq: 21, data: { turn: 1, step: 1, callId: "call_00_ask", name: "ask_user_question", arguments: "{}" } } },
	];
	const tailAskSettled = [
		...tailAsk,
		{ type: "event", event: { type: "tool/result", seq: 23, data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "call_00_ask" } } } },
	];
	const tailApproval = [
		{ type: "event", event: { type: "approval/asked", seq: 31, data: { id: "d53feaa0-x", toolName: "write", callId: "call_00_w", reason: "escalate sandbox to workspace-write" } } },
	];
	const tailApprovalSettled = [
		...tailApproval,
		{ type: "event", event: { type: "approval/decided", seq: 33, data: { id: "d53feaa0-x", outcome: "allowed-once" } } },
	];

	check("① 尾页最后一条是 tool/call(ask_user_question)（计划批准也是这个工具）⇒ 1",
		internals.liveTailRoleOf(tailAsk) === "ask",
		`role=${internals.liveTailRoleOf(tailAsk)}`);
	check("② 同一个 callId 之后有 tool/result ⇒ 已结算，0",
		internals.liveTailRoleOf(tailAskSettled) === ""
		&& internals.liveTailRoleOf([...tailAsk, { type: "event", event: { type: "tool/result", seq: 23, data: { toolCallId: "call_00_其他" } } }]) === "ask",
		`settled=${internals.liveTailRoleOf(tailAskSettled)}`);
	check("③ 尾页有 approval/asked、之后没有 approval/decided ⇒ 1（结算事件名确认：官方 SessionEventMap 里就是 approval/decided）",
		internals.liveTailRoleOf(tailApproval) === "approval",
		`role=${internals.liveTailRoleOf(tailApproval)}`);
	check("④ approval/asked 之后有 approval/decided（outcome=allowed-once / rejected / cancelled / unavailable 都算结算）⇒ 0",
		internals.liveTailRoleOf(tailApprovalSettled) === ""
		&& internals.liveTailRoleOf([...tailApproval, { type: "event", event: { type: "approval/decided", seq: 35, data: { id: "d53feaa0-x", outcome: "rejected" } } }]) === "",
		`settled=${internals.liveTailRoleOf(tailApprovalSettled)}`);
	check("⑤ 别的 id 的 approval/decided **不能**顶掉这一条的待批（按 id 配对，不是按「有没有出现过 decided」）",
		internals.liveTailRoleOf([...tailApproval, { type: "event", event: { type: "approval/decided", seq: 33, data: { id: "另一个-id", outcome: "allowed-once" } } }]) === "approval");
	check("⑥ 形状不认识 / 空尾页 / 记账事件收尾 ⇒ 一律 0（宁可不画琥珀，也绝不瞎画）",
		internals.liveTailRoleOf([]) === ""
		&& internals.liveTailRoleOf(null) === ""
		&& internals.liveTailRoleOf([{ type: "event", event: { type: "tool/call", seq: 1, data: { name: "write" } } }]) === ""
		&& internals.liveTailRoleOf([{ type: "event", event: { type: "step/end", seq: 22 } }]) === ""
		&& internals.liveTailRoleOf([{ nonsense: true }]) === "");

	// 接上一条真实的轮询：controller 换成 pendingStub，走 pollLocalLive（宿主半每 5 秒那条路）。
	// 注意两个落点：`state.controller` 是 `list()` 读的那份（`ctx.inject` 时写进去的），
	// `runtime.sessionController` 是琥珀判定（`projections`/`page`）读的那份。
	rt.sessionController = pendingStub;
	internals.liveStateOf(rt).controller = pendingStub;
	/**
	 * 跑一轮 pollLocalLive。
	 * `records` 既可以是"每条被读的会话都给同一份尾页"的数组，也可以是 `{ sessionId: records }`
	 * 的映射（多条会话各自不同尾巴时用）；没给的会话给空尾页（= 不卡住）。
	 */
	const pollNow = async (items, records) => {
		pendingStub.items = items;
		const byId = Array.isArray(records)
			? Object.fromEntries(items.map((item) => [item.sessionId, records]))
			: (records === undefined ? {} : records);
		pendingStub.recordsFor = (sessionId) => (byId[sessionId] === undefined ? [] : byId[sessionId]);
		await internals.pollLocalLive(rt);
		return pendingNow();
	};
	check("⑦ 提问卡：一条 running 会话尾页是不结算的 ask_user_question ⇒ pending=1，且 projections/page 各调一次、都带 throughSeq=asOfSeq",
		(await pollNow([{ sessionId: "s-1", running: true }], tailAsk)) === 1
		&& pendingStub.projectionsCalls === 1 && pendingStub.pageCalls === 1,
		`pending=${String(pendingNow())} projections=${String(pendingStub.projectionsCalls)} page=${String(pendingStub.pageCalls)}`);
	check("⑧ 同一会话结算（tool/result 跟上）⇒ pending 归 0",
		(await pollNow([{ sessionId: "s-1", running: true }], tailAskSettled)) === 0, String(pendingNow()));
	check("⑨ 三张卡同时开着（提问 + 多选 + 审批）=3 条 running 各自卡住 + 1 条在跑的对话 ⇒ pending=3（不是 4、也不是提问条数）",
		(await pollNow([
			{ sessionId: "s-ask", running: true },
			{ sessionId: "s-multi", running: true },
			{ sessionId: "s-approval", running: true },
			{ sessionId: "s-chat", running: true },
		], {
			"s-ask": tailAsk,
			"s-multi": tailAsk,
			"s-approval": tailApproval,
			"s-chat": [{ type: "event", event: { type: "assistant/message", seq: 40, data: {} } }],
		})) === 3, String(pendingNow()));
	check("⑩ 审批卡：尾页 approval/asked（未结算）⇒ 1；结算后 ⇒ 0",
		(await pollNow([{ sessionId: "s-approval", running: true }], tailApproval)) === 1
		&& (await pollNow([{ sessionId: "s-approval", running: true }], tailApprovalSettled)) === 0,
		String(pendingNow()));
	check("⑪ page() 抛错 ⇒ 这一条贡献 0（**绝不抛**，pollLocalLive 也不炸）",
		(await (async () => {
			pendingStub.pageError = true;
			try {
				await pollNow([{ sessionId: "s-boom", running: true }], tailAsk);
			} catch (error) {
				return `抛了：${String(error)}`;
			} finally {
				pendingStub.pageError = false;
			}
			return String(pendingNow());
		})()) === "0",
		`pending=${String(pendingNow())}`);
	check("⑫ 形状不对（没有 projections/page 这个方法）⇒ 0，而且根本不调它们",
		(await (async () => {
			const before = [pendingStub.projectionsCalls, pendingStub.pageCalls];
			rt.sessionController = { list: pendingStub.list.bind(pendingStub) };
			pendingStub.items = [{ sessionId: "s-nope", running: true }];
			await internals.pollLocalLive(rt);
			const after = [pendingStub.projectionsCalls, pendingStub.pageCalls];
			rt.sessionController = pendingStub;
			return JSON.stringify([pendingNow(), after[0] - before[0], after[1] - before[1]]);
		})()) === JSON.stringify([0, 0, 0]),
		`pending=${String(pendingNow())}`);
	check("⑬ **没有 running 会话时不调用 page**（123 条空闲会话也一样：一条尾页都不读）",
		(await (async () => {
			const beforePage = pendingStub.pageCalls;
			const beforeProjections = pendingStub.projectionsCalls;
			const idle = [];
			for (let index = 0; index < 123; index += 1) idle.push({ sessionId: `s-idle-${String(index)}`, running: false });
			const value = await pollNow(idle, tailAsk);
			return JSON.stringify([value, pendingStub.pageCalls - beforePage, pendingStub.projectionsCalls - beforeProjections]);
		})()) === JSON.stringify([0, 0, 0]),
		`page=${String(pendingStub.pageCalls)} projections=${String(pendingStub.projectionsCalls)}`);
	check("⑭ list() 抛错 ⇒ 只记一次日志、保持上一轮数值、**上面那层绝不抛**",
		(await (async () => {
			pendingStub.listError = true;
			try {
				await internals.pollLocalLive(rt);
			} catch (error) {
				return `抛了：${String(error)}`;
			} finally {
				pendingStub.listError = false;
			}
			return String(internals.liveStateOf(rt).pending);
		})()) === "0" && internals.LIVE_TAIL_N >= 8,
		`LIVE_TAIL_N=${String(internals.LIVE_TAIL_N)}`);
	check("⑮ 同一条会话持续卡住 ⇒ 日志**不重复**；换了一条卡住的会话才再写一条（只在结果变化时写）",
		(await (async () => {
			await pollNow([{ sessionId: "s-log-1", running: true }], tailAsk);
			const logsAfterFirst = liveRouter.logs.filter((line) => line.includes("琥珀亮）：s-log-1")).length;
			await pollNow([{ sessionId: "s-log-1", running: true }], tailAsk);
			const logsAfterSame = liveRouter.logs.filter((line) => line.includes("琥珀亮）：s-log-1")).length;
			await pollNow([{ sessionId: "s-log-2", running: true }], tailAsk);
			const logsAfterOther = liveRouter.logs.filter((line) => line.includes("琥珀亮）：s-log-1")).length
				+ liveRouter.logs.filter((line) => line.includes("琥珀亮）：s-log-2")).length;
			return JSON.stringify([logsAfterFirst, logsAfterSame, logsAfterOther]);
		})()) === JSON.stringify([1, 1, 2]),
		`logs=${JSON.stringify(liveRouter.logs.filter((line) => line.includes("琥珀")).slice(-6))}`);

	section("L4 POST /plugin/remote/live/seen：本机/对端分支与 405/400/仅回环边界");
	const armUnread = async () => {
		liveItems.value = [{ running: true }];
		await sleep(160);
		liveItems.value = [{ running: false }];
		await sleep(160);
		return (await selfLiveNow()).unread === true;
	};
	check("准备：再点亮一次（>0 → 0）", (await armUnread()) === true);
	const seenEmpty = await httpJson(`${liveBase}/live/seen`, { method: "POST" });
	notHtml("POST /plugin/remote/live/seen（body 缺省）", seenEmpty);
	check("body 缺省（= 本机）→ 清本机 unread，且**返回同形状的最新聚合**",
		seenEmpty.status === 200
		&& JSON.stringify(Object.keys(seenEmpty.json).sort()) === JSON.stringify(["at", "peers", "self"])
		&& seenEmpty.json.self.live.unread === false
		&& readJsonFile(liveFile).unread === false,
		JSON.stringify(seenEmpty.json?.self));
	check("准备：再点亮一次（给 id=本机设备 id 的分支用）", (await armUnread()) === true);
	const seenLocalId = await httpJson(`${liveBase}/live/seen`, { method: "POST", body: { id: "me" } });
	check("id = 被认领为本机那条设备的 id → 走**本机**分支（清本机 unread）",
		seenLocalId.json?.self?.live?.unread === false, JSON.stringify(seenLocalId.json?.self));
	check("准备：再点亮一次（给未知 id 分支用）", (await armUnread()) === true);
	const seenGhost = await httpJson(`${liveBase}/live/seen`, { method: "POST", body: { id: "ghost" } });
	check("id 未知 → 也按本机处理（客户端半不必知道本机到底认领了哪条设备）",
		seenGhost.json?.self?.live?.unread === false, JSON.stringify(seenGhost.json?.self));
	check("准备：再点亮一次（给对端分支用）", (await armUnread()) === true);
	const liveUpSeenBefore = liveUp.calls.seen;
	const seenPeer = await httpJson(`${liveBase}/live/seen`, { method: "POST", body: { id: "up" } });
	const peerUpAfterSeen = (seenPeer.json?.peers ?? []).find((peer) => peer.id === "up");
	check("id = 对端 → **不**清本机 unread，改成 POST 对端的 /dsh-remote-live/seen",
		seenPeer.status === 200 && liveUp.calls.seen === liveUpSeenBefore + 1
		&& seenPeer.json?.self?.live?.unread === true,
		`seenCalls=${String(liveUp.calls.seen)} self=${JSON.stringify(seenPeer.json?.self?.live)}`);
	check("对端清完的 live 立刻进聚合（peers[].live.unread=false）",
		peerUpAfterSeen?.reachable === true && peerUpAfterSeen?.live?.unread === false,
		JSON.stringify(peerUpAfterSeen));
	check("转发给对端的路径就是 /dsh-remote-live/seen（POST）",
		liveUp.calls.paths.includes(internals.PEER_LIVE_SEEN_PATH)
		&& liveUp.calls.methods[liveUp.calls.paths.indexOf(internals.PEER_LIVE_SEEN_PATH)] === "POST",
		JSON.stringify([...new Set(liveUp.calls.paths)]));
	const seenMineAgain = await httpJson(`${liveBase}/live/seen`, { method: "POST", body: { id: "" } });
	check("id = 空串 → 本机分支（把本机 unread 清掉）",
		seenMineAgain.json?.self?.live?.unread === false, JSON.stringify(seenMineAgain.json?.self?.live));
	const liveGet405 = await httpJson(`${liveBase}/live`, { method: "POST", body: {} });
	check("POST /plugin/remote/live → 405（读取只认 GET/HEAD）", liveGet405.status === 405, String(liveGet405.status));
	notHtml("POST /plugin/remote/live（405）", liveGet405);
	const liveSeenBadBody = await httpJson(`${liveBase}/live/seen`, {
		method: "POST",
		body: "{not json",
		headers: { "content-type": "application/json" },
	});
	check("POST /plugin/remote/live/seen 收到非法 JSON → 400（不是 500、不是 HTML）",
		liveSeenBadBody.status === 400, `${String(liveSeenBadBody.status)} ${JSON.stringify(liveSeenBadBody.body.slice(0, 60))}`);
	notHtml("POST /plugin/remote/live/seen（400）", liveSeenBadBody);
	const liveRemote = await localExchange(liveRouter, { url: internals.LIVE_PATH, remoteAddress: "192.0.2.9" });
	check("本机页面口从非回环打 → 403 loopback only（与 /plugin/remote/state 同一道守卫）",
		liveRemote.status === 403 && liveRemote.body.includes("loopback only"),
		`${String(liveRemote.status)} ${JSON.stringify(liveRemote.body.slice(0, 60))}`);
	const liveLoop = await localExchange(liveRouter, { url: internals.LIVE_PATH });
	check("本机页面口从回环打 → 200 且是同一份聚合（直接走 handler 也对）",
		liveLoop.status === 200 && JSON.parse(liveLoop.body).peers.length === 3, JSON.stringify(liveLoop.body).slice(0, 100));

	section("L5 fetchPeerPath：probeDevice 的泛化（path/method/body、限长、超时、网络错）");
	const miniRuntime = {
		ctx: { logger: { warn() {}, info() {}, error() {} } },
		sessions: new Map(),
		sessionStore: undefined,
		authFailures: new Map(),
		tokenCache: new Map(),
		tokens: { get: async () => undefined },
		reach: new Map(),
	};
	const liveDeviceOf = (port) => ({
		id: `peer-${String(port)}`,
		name: "对端",
		protocol: "http:",
		hostname: "127.0.0.1",
		port: String(port),
		authority: `127.0.0.1:${String(port)}`,
		origin: `http://127.0.0.1:${String(port)}`,
		basePath: "",
		rawUrl: `http://127.0.0.1:${String(port)}`,
	});
	const directPeer = await startFakeLivePeer();
	const directOk = await internals.fetchPeerPath(miniRuntime, liveDeviceOf(directPeer.port), internals.PEER_LIVE_PATH);
	check("拿到 200 → status=200、ok=true、响应体被保留并 JSON.parse 成 json，可达性记进 markReach",
		directOk.status === 200 && directOk.ok === true && directOk.json?.live?.running === 2
		&& miniRuntime.reach.get(`peer-${String(directPeer.port)}`)?.reachable === true,
		JSON.stringify([directOk.status, directOk.json]));
	const directOld = await startFakeLivePeer({ status: 404 });
	const direct404 = await internals.fetchPeerPath(miniRuntime, liveDeviceOf(directOld.port), internals.PEER_LIVE_PATH);
	check("拿到 404 → ok=true、status=404、json=null（**这不算网络错误**）",
		direct404.ok === true && direct404.status === 404 && direct404.json === null,
		JSON.stringify([direct404.ok, direct404.status]));
	const directDead = await internals.fetchPeerPath(miniRuntime, liveDeviceOf(await freeDeadPort()), internals.PEER_LIVE_PATH, { timeoutMs: 1500 });
	check("连接失败 → status=null（**只有这种才是不可达**）、error 有内容",
		directDead.status === null && directDead.ok === false && typeof directDead.error === "string" && directDead.error.length > 0,
		JSON.stringify([directDead.status, directDead.error]));
	const blackhole = createServer(() => { /* 连上但永不响应 */ });
	await new Promise((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
	const blackholePort = blackhole.address().port;
	const directTimeout = await internals.fetchPeerPath(miniRuntime, liveDeviceOf(blackholePort), internals.PEER_LIVE_PATH, { timeoutMs: 150 });
	await new Promise((resolve) => blackhole.close(resolve));
	check("超时（对端连上但不回一个字节）→ status=null、error 写明连接超时（超时可按需覆盖）",
		directTimeout.status === null && String(directTimeout.error).includes("连接超时"),
		JSON.stringify([directTimeout.status, directTimeout.error]));
	check("缺省超时 = PEER_LIVE_TIMEOUT_MS（1.5 秒）且**小于**轮询间隔 2 秒（不会拖住下一轮）",
		internals.PEER_LIVE_TIMEOUT_MS === 1_500 && internals.PEER_LIVE_TIMEOUT_MS < internals.LIVE_POLL_MS,
		`${String(internals.PEER_LIVE_TIMEOUT_MS)} / ${String(internals.LIVE_POLL_MS)}`);
	const huge = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(`{"live":{"running":1,"padding":"${"x".repeat(4096)}"}}`);
		});
	});
	await new Promise((resolve) => huge.listen(0, "127.0.0.1", resolve));
	const hugePort = huge.address().port;
	const limited = await internals.fetchPeerPath(miniRuntime, liveDeviceOf(hugePort), internals.PEER_LIVE_PATH, { maxBytes: 64 });
	await new Promise((resolve) => huge.close(resolve));
	check("限长：超过 maxBytes 立刻截断（truncated=true、字节数不超过上限），且**不当成网络错误**",
		limited.status === 200 && limited.truncated === true && Buffer.byteLength(limited.body ?? "", "utf8") <= 64,
		`truncated=${String(limited.truncated)} bytes=${String(Buffer.byteLength(limited.body ?? "", "utf8"))}`);
	check("缺省限长 = PEER_LIVE_MAX_BYTES（16 KiB：只留一段 JSON 体，绝不把大响应读进内存）",
		internals.PEER_LIVE_MAX_BYTES === 16 * 1024, String(internals.PEER_LIVE_MAX_BYTES));
	await directPeer.close();
	await directOld.close();
	check("liveViewFromPeerBody：404 / 非 JSON / 形状不对一律 null（页面就不画点）",
		internals.liveViewFromPeerBody({ status: 404, json: null }) === null
		&& internals.liveViewFromPeerBody({ status: 200, json: null }) === null
		&& internals.liveViewFromPeerBody({ status: 200, json: { live: null } }) === null
		&& internals.liveViewFromPeerBody({ status: 200, json: { live: "x" } }) === null);
	check("liveViewFromPeerBody：200 + 合法 live → 逐字段清洗（缺字段/错类型当 0/false）",
		JSON.stringify(internals.liveViewFromPeerBody({ status: 200, json: { live: { running: "3", pending: -1, unread: 1, doneAt: 5.9, at: null } } }))
		=== JSON.stringify({ running: 3, pending: 0, unread: false, doneAt: 5, at: 0 }));
	check("liveSelfNameOf / buildLiveAggregate.self：认领到本机设备 ⇒ 它的名字；没认领到 / 名字是脏的 ⇒ 空串（客户端半退回「本机」）",
		internals.liveSelfNameOf({ localDevice: { id: "me", name: "设备A" } }) === "设备A"
		&& internals.liveSelfNameOf({ localDevice: { id: "me", name: "  设备A  " } }) === "设备A"
		&& internals.liveSelfNameOf({ localDevice: { id: "me", name: 42 } }) === ""
		&& internals.liveSelfNameOf({}) === ""
		&& internals.liveSelfNameOf(null) === "");
	const aggregateSelf = internals.buildLiveAggregate({
		localDevice: { id: "me", name: "设备A" },
		live: internals.createLiveState(),
		devices: [],
	}).self;
	check("buildLiveAggregate：self 就是 {name, live} 两个键，peers[] 一个字节都没多（老客户端半照样认）",
		JSON.stringify(Object.keys(aggregateSelf).sort()) === JSON.stringify(["live", "name"])
		&& aggregateSelf.name === "设备A"
		&& JSON.stringify(Object.keys(aggregateSelf.live).sort()) === JSON.stringify(["at", "doneAt", "pending", "running", "unread"]),
		JSON.stringify(aggregateSelf));
	const liveNoDevice = JSON.parse(liveResp.body);
	check("这台机器上 URL 自验证没命中（测试里设备写的是 127.0.0.1:9）、但回退 `current` 认领了 \"me\" ⇒ self.name 就是那条设备的名字（真机 auto 分支的「设备A」是同一个字段）",
		liveNoDevice.self.name === "本机台", JSON.stringify(liveNoDevice.self));	await liveUp.close();
	await liveOld.close();
	await liveHost.close();

	// ------------------------------------------------------------------
	// N（0.13.1）：回退设备密钥机制 + 两个真 bug 的验收
	//  N1 源码扫描：0.13.0 的密钥机制一个字都不许残留；
	//  N2 token/会话按 **authority** 存 + 旧 id ref 幂等迁移（不删旧值）；
	//  N3 重填 token **不丢 cookie**（cookie 继续能用；真 401 才丢 + 用新 token 重兑重试）；
	//  N4 fetchPeerPath 的 401 兜底：forgetSession + 重兑 + 重试一次。
	// ------------------------------------------------------------------
	section("N1 0.13.1：0.13.0 的设备密钥机制不得残留（源码扫描）");
	const indexSource = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
	const clientSource = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
	const forbiddenTokens = [
		"x-dsh-remote-key", "DSH_REMOTE_DEVICE_KEY", "DSH_REMOTE_KEY_", "self-key", "deviceKey", "peerKeys",
		"authModeOf", "peerKeyFor", "credentialLabel",
	];
	const forbiddenHits = [];
	for (const [label, source] of [["index.js", indexSource], ["client.js", clientSource]]) {
		for (const token of forbiddenTokens) {
			if (source.includes(token)) forbiddenHits.push(`${label}:${token}`);
		}
	}
	check("源码里没有 x-dsh-remote-key / DSH_REMOTE_DEVICE_KEY / DSH_REMOTE_KEY_ / self-key / deviceKey / peerKeys / authModeOf / credentialLabel",
		forbiddenHits.length === 0, forbiddenHits.join(", ") || "(clean)");
	check("设置页/设备表也不再出现「设备密钥」这套文案（回到 0.12.1 的 token 单一机制）",
		!indexSource.includes("设备密钥") && !clientSource.includes("设备密钥"));

	section("N2 0.13.1：token/会话按 authority 存；旧 id ref 有值 ⇒ 迁过去（幂等、不删旧值）");
	const migCreds = {
		store: new Map(),
		setCalls: [],
		unsetCalls: [],
		async resolve(ref) {
			const value = this.store.get(ref);
			return value === undefined ? undefined : { value, source: "store" };
		},
		async set(ref, value) {
			this.setCalls.push([ref, value]);
			this.store.set(ref, value);
		},
		async unset(ref) {
			this.unsetCalls.push(ref);
			this.store.delete(ref);
		},
		async describe(ref) {
			return { configured: this.store.has(ref), writable: true };
		},
	};
	const legacyId = "legacy-id";
	const migAuthority = "192.0.2.9:19387";
	migCreds.store.set(internals.legacyTokenRefFor(legacyId), "legacy-token-value");
	migCreds.store.set(internals.legacySessionRefFor(legacyId), "dsh-auth-OLD=legacy-cookie");
	const migFile = freshDataFile();
	writeFileSync(migFile, JSON.stringify({ devices: [{ id: legacyId, name: "旧设备", url: `http://${migAuthority}` }] }), "utf8");
	const migRouter = createRouter({ credentials: migCreds });
	apply(migRouter.ctx, { dataFile: migFile }, { muxPath: "/api/remote.mux" });
	await sleep(60);
	const migTokenRef = internals.tokenRefFor(migAuthority);
	const migSessionRef = internals.sessionRefFor(migAuthority);
	check("旧 id ref 有值、新 authority ref 空 ⇒ 启动时复制过去（token 与 session 都迁）",
		migCreds.store.get(migTokenRef) === "legacy-token-value"
		&& migCreds.store.get(migSessionRef) === "dsh-auth-OLD=legacy-cookie",
		JSON.stringify([...migCreds.store.keys()].map((ref) => ref.slice(0, 24))));
	check("旧 id ref **保留不删**（安全回退：改回旧版也还在）",
		migCreds.store.get(internals.legacyTokenRefFor(legacyId)) === "legacy-token-value"
		&& migCreds.store.get(internals.legacySessionRefFor(legacyId)) === "dsh-auth-OLD=legacy-cookie");
	const migWritesAfterFirst = migCreds.setCalls.length;
	const migRouter2 = createRouter({ credentials: migCreds });
	apply(migRouter2.ctx, { dataFile: migFile }, { muxPath: "/api/remote.mux" });
	await sleep(60);
	check("第二次启动幂等：新 ref 已有值 ⇒ 一条都不写（不重复迁移）",
		migCreds.setCalls.length === migWritesAfterFirst,
		`${String(migWritesAfterFirst)} → ${String(migCreds.setCalls.length)}`);

	section("N3 0.13.1：重填 token 不丢 cookie；只有真实 401 才丢 + 用新 token 重兑一次重试");
	const n3Auth = new Map();
	let n3Exchanges = [];
	const n3Server = createServer((req, res) => {
		const url = new URL(req.url, "http://n3.invalid");
		const authority = req.headers.host ?? "";
		const name = internals.cookieNameFor(authority);
		const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
		const authed = cookie.split(";").some((part) => {
			const value = part.trim();
			return value === `${name}=ok-cookie` || value === `${name}=fresh-cookie`;
		});
		if (url.pathname === "/" && url.searchParams.get("token") !== null) {
			const token = url.searchParams.get("token");
			n3Exchanges.push(token);
			res.writeHead(303, {
				location: "./",
				"set-cookie": `${name}=${token === "t-new" ? "fresh-cookie" : "ok-cookie"}; Max-Age=315360000; Path=/; HttpOnly`,
			});
			res.end();
			return;
		}
		if (url.pathname === "/api/kill") {
			req.resume();
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
			res.end("unauthorized\n");
			return;
		}
		if (url.pathname.startsWith("/api/") && authed) {
			req.resume();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		req.resume();
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
		res.end("unauthorized\n");
	});
	await new Promise((resolve) => n3Server.listen(0, "127.0.0.1", resolve));
	const n3Port = n3Server.address().port;
	const n3Creds = {
		store: n3Auth,
		async resolve(ref) {
			const value = this.store.get(ref);
			return value === undefined ? undefined : { value, source: "store" };
		},
		async set(ref, value) {
			this.store.set(ref, value);
		},
		async unset(ref) {
			this.store.delete(ref);
		},
		async describe(ref) {
			return { configured: this.store.has(ref), writable: true };
		},
	};
	const n3File = freshDataFile();
	const n3Router = createRouter({ credentials: n3Creds });
	apply(n3Router.ctx, { dataFile: n3File, devices: [{ id: "self", name: "自测对端", url: `http://127.0.0.1:${String(n3Port)}`, token: "t-old" }] }, { muxPath: "/api/remote.mux" });
	const n3Host = await startFakeHost(n3Router);
	const n3Base = `http://127.0.0.1:${String(n3Host.port)}`;
	const n3First = await httpGet(`${n3Base}/dev/self/api/x`);
	check("前置：第一次代理 200（token 兑换出 ok-cookie）", n3First.status === 200 && n3Exchanges.length === 1, `${String(n3First.status)} / ${JSON.stringify(n3Exchanges)}`);
	const refillSame = await httpJson(`${n3Base}${internals.PLUGIN_ROUTE}/devices`, {
		method: "POST",
		body: { id: "self", name: "自测对端", url: `http://127.0.0.1:${String(n3Port)}`, token: "t-old" },
	});
	const n3AfterSame = await httpGet(`${n3Base}/dev/self/api/x`);
	check("重填**同一个** token：cookie 保留 ⇒ 直接 200，且**没有再兑换一次**",
		refillSame.json.ok === true && n3AfterSame.status === 200 && n3Exchanges.length === 1,
		`status=${String(n3AfterSame.status)} exchanges=${JSON.stringify(n3Exchanges)}`);
	const refillNew = await httpJson(`${n3Base}${internals.PLUGIN_ROUTE}/devices`, {
		method: "POST",
		body: { id: "self", name: "自测对端", url: `http://127.0.0.1:${String(n3Port)}`, token: "t-new" },
	});
	const n3AfterNew = await httpGet(`${n3Base}/dev/self/api/x`);
	check("重填**新** token：旧 cookie 仍在（先不丢），请求照常 200 且不兑换",
		refillNew.json.ok === true && n3AfterNew.status === 200 && n3Exchanges.length === 1,
		`status=${String(n3AfterNew.status)} exchanges=${JSON.stringify(n3Exchanges)}`);
	const n3Kill = await httpGet(`${n3Base}/dev/self/api/kill`);
	check("真实 401：先丢旧会话，再用**新 token** 重兑一次并重试（用旧 token 就说明 tokenCache 没清）",
		n3Kill.status === 401 && n3Exchanges.length === 2 && n3Exchanges[1] === "t-new",
		`status=${String(n3Kill.status)} exchanges=${JSON.stringify(n3Exchanges)}`);
	await n3Host.close();
	await new Promise((resolve) => n3Server.close(resolve));

	section("N4 0.13.1：fetchPeerPath 的 401 兜底（forgetSession → 用 token 重兑 → 重试一次）");
	const n4Creds = {
		store: new Map(),
		async resolve(ref) {
			const value = this.store.get(ref);
			return value === undefined ? undefined : { value, source: "store" };
		},
		async set(ref, value) {
			this.store.set(ref, value);
		},
		async unset(ref) {
			this.store.delete(ref);
		},
	};
	let n4Exchanges = 0;
	const n4Server = createServer((req, res) => {
		const url = new URL(req.url, "http://n4.invalid");
		if (url.pathname === "/" && url.searchParams.get("token") !== null) {
			n4Exchanges += 1;
			res.writeHead(303, { location: "./", "set-cookie": "dsh-auth-fp=fresh-cookie; Max-Age=315360000; Path=/; HttpOnly" });
			res.end();
			return;
		}
		const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
		if (url.pathname === internals.PEER_LIVE_PATH && cookie.includes("fresh-cookie")) {
			req.resume();
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ at: Date.now(), live: { running: 1 } }));
			return;
		}
		req.resume();
		res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
		res.end("unauthorized\n");
	});
	await new Promise((resolve) => n4Server.listen(0, "127.0.0.1", resolve));
	const n4Port = n4Server.address().port;
	const n4Runtime = {
		ctx: { logger: { warn() {}, info() {}, error() {} } },
		credentials: n4Creds,
		sessions: new Map([["peer", "dsh-auth-fp=stale-cookie"]]),
		sessionStore: {
			async get() {
				return undefined;
			},
			async set(device, cookie) {
				n4Creds.store.set(internals.sessionRefFor(device.authority), cookie);
			},
			async remove(device) {
				n4Creds.store.delete(internals.sessionRefFor(device.authority));
			},
		},
		authFailures: new Map(),
		pendingSessions: new Map(),
		tokenCache: new Map(),
		tokens: { async get() { return "t-1"; } },
		reach: new Map(),
		authNotices: new Map(),
	};
	const n4Device = {
		id: "peer",
		name: "对端",
		protocol: "http:",
		hostname: "127.0.0.1",
		port: String(n4Port),
		authority: `127.0.0.1:${String(n4Port)}`,
		origin: `http://127.0.0.1:${String(n4Port)}`,
		basePath: "",
		rawUrl: `http://127.0.0.1:${String(n4Port)}`,
	};
	const n4Result = await internals.fetchPeerPath(n4Runtime, n4Device, internals.PEER_LIVE_PATH);
	check("旧 cookie 回 401 ⇒ 丢掉、用 token 重兑一次、重试拿到 200",
		n4Result.status === 200 && n4Exchanges === 1,
		`status=${String(n4Result.status)} exchanges=${String(n4Exchanges)}`);
	check("重试后的新会话进了内存 jar 与凭据服务（ref 按 authority）",
		n4Runtime.sessions.get("peer") === "dsh-auth-fp=fresh-cookie"
		&& n4Creds.store.get(internals.sessionRefFor(n4Device.authority)) === "dsh-auth-fp=fresh-cookie",
		JSON.stringify([n4Runtime.sessions.get("peer"), n4Creds.store.get(internals.sessionRefFor(n4Device.authority))]));
	check("成功后不留下 401 提示（authNotices 清空）", n4Runtime.authNotices.size === 0, String(n4Runtime.authNotices.size));
	await new Promise((resolve) => n4Server.close(resolve));

	const failed = checks.filter((entry) => !entry.ok);
	log(`\n=== 结果：${String(checks.length - failed.length)}/${String(checks.length)} 通过 ===`);
	if (failed.length > 0) {
		for (const entry of failed) log(`  FAIL  ${entry.title}`);
		log("\n（退出码 1；临时数据目录保留以便排查）");
		log(`数据目录：${workDir}`);
		process.exit(1);
	}
	log("全部通过。");
	void stub.close();
	void host.close();
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结果 */
	}
	process.exit(0);
}

main().catch((error) => {
	log("\n自测异常终止：");
	log(error && error.stack ? error.stack : String(error));
	log(`数据目录：${workDir}`);
	process.exit(1);
});
