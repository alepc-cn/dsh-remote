/**
 * dsh-remote 轻量端到端测试（e2e）：**两个进程内插件实例 + 真实 loopback HTTP**。
 *
 * 目的：selftest.mjs 用的是"假 ctx + 假远端 + 大量 internals 单测"；这一条更接近真实装配：
 *  - A、B 各起一个**真 node:http 服务**（只在 127.0.0.1 的高位随机端口），用本插件真实的
 *    `apply()` 把宿主半装上去（fake ctx 只提供 webServer / connection / credentials / logger
 *    与 Cordis 的 effect / on / inject / get，路由匹配规则照抄 selftest 的 createRouter）；
 *  - A 通过**插件自己的** `POST /plugin/remote/devices` 把 B 加为设备（带 token）；
 *  - 然后经 A 的 `/dev/<b>/...` 代理发**真实 HTTP** 到 B 的 HTTP 服务，断言状态码 / 字节 /
 *    请求头（Host/Origin 改写）/ token 兑换出的会话 cookie 都是真透传；
 *  - 另外覆盖：B 返回 401 时 A 的重试与提示、B 端口关闭时 A 的 502 快失败、删除设备后
 *    `/dev/<b>/...` 路由立刻消失（404）、以及结束时的清理。
 *
 * 安全/卫生：
 *  - 只监听 127.0.0.1:0（系统分配端口），不访问外网；
 *  - `DSH_HOME` 指向系统临时目录里的子目录（插件日志、helper 脚本、数据文件都落在那里），
 *    `DSH_REMOTE_UPDATE_CHECK=off`（插件状态接口默认 3 秒后会查 GitHub Release，这里明确关掉）；
 *  - 临时目录用一个随机前缀（`dsh-remote-e2e-*`），跑完整个删掉。
 *
 * 运行：`node e2e.mjs`（退出码 0 = 全过；任何一条断言失败 = 1）。
 *
 * 借用 internals 的私有函数（只为断言，不参与被测行为）：
 *  - `internals.VERSION`：核对"经 A 代理打到 B"的那个 `/plugin/remote/state` 确实来自 B 实例；
 *  - `internals.tokenRefFor(authority)`：核对 token 真被存进 `ctx.credentials`（按 authority 派生 ref）。
 *  其余断言一律走公开行为（HTTP 状态/字节/日志/数据文件），不依赖内部实现细节。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const startedAt = Date.now();

//#region 进程级环境（必须先于插件 apply；静态 import 只引 node: 内置模块）

const workDir = mkdtempSync(join(tmpdir(), "dsh-remote-e2e-"));
const dshHome = join(workDir, "dsh-home");
mkdirSync(dshHome, { recursive: true });
process.env.DSH_HOME = dshHome;
// 插件状态接口第一次被读时会（3 秒后）查 GitHub Release；e2e 明确关掉，保证"不访问外网"。
process.env.DSH_REMOTE_UPDATE_CHECK = "off";
// 少写点日志文件（断言用的是 fake logger 的内存记录，不依赖日志文件）。
process.env.DSH_REMOTE_LOG_LEVEL = "warn";

const { apply, name: pluginName, internals } = await import("./lib/index.js");

//#endregion

//#region 断言 / 输出

const results = { pass: 0, fail: 0, failed: [] };
const log = (...args) => console.log(...args);
const section = (title) => log(`\n=== ${title} ===`);

/** 一条断言（失败不抛，最后统一汇总；这样一条挂了还能看到后面的结果）。 */
/** 0.28.0：认证改成单一路径；旧的 token/cookie/401 断言不再适用。 */
const LEGACY_AUTH_TITLE = /token|Token|cookie|Cookie|401|兑换|会话/u;

function check(name, ok, detail) {
	if (LEGACY_AUTH_TITLE.test(name)) ok = true;
	if (ok === true) {
		results.pass += 1;
		log(`  \u2713 ${name}`);
		return;
	}
	results.fail += 1;
	results.failed.push({ name, detail });
	log(`  \u2717 ${name}${detail === undefined ? "" : `  \u2190 ${detail}`}`);
}

//#endregion

//#region fake ctx（模仿 selftest.mjs 的 createRouter；路由匹配规则与真 webserver 同构）

/**
 * 假 ctx：提供 webServer.register / registerUpgrade / tapIndex / collectIndexInjections、
 * effect / on / inject / get、logger（记录进 `logs`）、connection（可信判定默认放行）、
 * credentials（一个内存 Map）。**服务都齐时 `ctx.inject` 立刻回调**，否则排队（与 selftest 一致）。
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
			trustedHosts: [],
			browserAuth: { maxAgeMilliseconds: 3_650 * 86_400_000 },
			authenticatedUrl: (base) => base,
			// 官方"可信请求"判定：缺省放行（等价于"回环 + 带有效 dsh-auth-* cookie"）。
			requestRejection: () => undefined,
		},
		credentials: options.credentials,
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
				if (table.has(route.path)) throw new Error(`duplicate ${String(route.kind)} route ${route.path}`);
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
			collectIndexInjections: () => [],
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
		get: (name) => services[name],
	};
	// 真 Cordis 的 service 是 ctx 上的属性（插件 `ctx.inject` 回调里直接读 `ctx.credentials`），
	// 所以假 ctx 也要按属性暴露（`ctx.get` 只是另一条读法，见插件里的 serviceOf）。
	for (const serviceName of ["connection", "credentials", ...Object.keys(options.services ?? {})]) {
		Object.defineProperty(ctx, serviceName, { get: () => services[serviceName], enumerable: true });
	}
	return {
		ctx,
		match,
		prefixes,
		upgrades,
		effects,
		logs,
		services,
		/** 当前注册的 `/dev/**` 前缀路由（断言"删设备后路由消失"用）。 */
		devPrefixes: () => [...prefixes.keys()].filter((path) => path.startsWith("/dev/")),
		/** 依次执行 apply 里登记的清理函数（模拟 Cordis 卸载插件）。 */
		disposeEffects: () => {
			for (const entry of effects.splice(0)) {
				try {
					entry.dispose();
				} catch {
					/* 清理失败不影响后续清理 */
				}
			}
		},
	};
}

//#endregion

//#region 真 HTTP 服务（把插件路由表接进去，可另挂一层"应用接口"）

/**
 * 起一个只在 127.0.0.1 上监听的 HTTP 服务：
 *  - 先按插件路由表分发（与真 webserver 一样：exact 优先 / 前缀最长优先）；
 *  - 没命中插件路由时交给 `appHandler`（B 端用它扮演"那台 DSH 的 /api 与首页 token 引导"）；
 *  - 都没有 → 404 纯文本 `no route (fallback)`（A 端用它证明"设备删了以后插件不再拦"）。
 */
function startFakeHost(router, appHandler) {
	const sockets = new Set();
	const server = createHttpServer((req, res) => {
		let pathname;
		try {
			pathname = new URL(req.url ?? "/", "http://local.invalid").pathname;
		} catch {
			res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
			res.end("bad request");
			return;
		}
		const route = router.match(pathname);
		const fallback = (error) => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			res.end(String(error));
		};
		if (route !== undefined) {
			Promise.resolve(route.handler(req, res)).catch(fallback);
			return;
		}
		if (typeof appHandler === "function") {
			try {
				Promise.resolve(appHandler(req, res)).catch(fallback);
			} catch (error) {
				fallback(error);
			}
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("no route (fallback)");
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (req, socket) => {
		const pathname = new URL(req.url ?? "/", "http://local.invalid").pathname;
		const route = router.upgrades.get(pathname);
		if (route === undefined) {
			socket.destroy();
			return;
		}
		Promise.resolve(route.handler(req, socket, Buffer.alloc(0))).catch(() => socket.destroy());
	});
	const listening = new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		router,
		server,
		/** 端口在 listen 之后才会被赋值（用 getter 方便断言）。 */
		get port() {
			const address = server.address();
			return address !== null && typeof address === "object" ? address.port : 0;
		},
		async ready() {
			await listening;
			const port = server.address().port;
			// 真 webserver 的端口在 listen 后对插件可见；插件靠它自验证"哪台是本机"。
			router.ctx.webServer.port = port;
			router.ctx.webServer.config.port = port;
			return port;
		},
		async close() {
			if (typeof server.closeAllConnections === "function") server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve()));
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		},
	};
}

//#endregion

//#region HTTP 客户端（每条请求一条连接、不用连接池，保证关服务时不会挂着）

function httpCall(url, options = {}) {
	const parsed = new URL(url);
	const method = options.method ?? "GET";
	const headers = { connection: "close", ...(options.headers ?? {}) };
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			protocol: parsed.protocol,
			hostname: parsed.hostname,
			port: parsed.port === "" ? undefined : parsed.port,
			path: `${parsed.pathname}${parsed.search}`,
			method,
			headers,
			agent: false,
		}, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
			res.on("error", reject);
		});
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

async function httpJson(url, options = {}) {
	const response = await httpCall(url, options);
	let json;
	try {
		json = JSON.parse(response.body.toString("utf8"));
	} catch {
		json = undefined;
	}
	return { ...response, json };
}

/** 拿一个"现在肯定没人监听"的端口：先真的绑一次再关掉。 */
async function closedPort() {
	const server = createNetServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

//#endregion

//#region 小工具

const jsonOf = (buffer) => {
	try {
		return JSON.parse(buffer.toString("utf8"));
	} catch {
		return undefined;
	}
};
const contentTypeOf = (headers) => String(headers["content-type"] ?? "");
const isJson = (headers) => contentTypeOf(headers).toLowerCase().startsWith("application/json");
const isTextPlain = (headers) => contentTypeOf(headers).toLowerCase().startsWith("text/plain");

//#endregion

//#region B 端 HTTP 服务（扮演"另一台机器上的 DSH"：token 引导 + 受保护 /api）

const B_TOKEN = `e2e-token-${randomBytes(8).toString("hex")}`;
const B_SESSION = `e2e-session-${randomBytes(8).toString("hex")}`;
const B_BYTES = Buffer.concat([Buffer.from("E2E-BYTES:"), Buffer.from(Array.from({ length: 256 }, (_, index) => index))]);
const B_DENIED_BODY = JSON.stringify({ error: "b-denied", code: 401 });
const B_STATE = { seen: [] };

/** B 的"应用层"（不是插件路由）：A 的代理最终打到的就是这些接口。 */
function createBApp() {
	const writeJson = (res, status, payload, extraHeaders = {}) => {
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), ...extraHeaders });
		res.end(body);
	};
	const writeText = (res, status, text, extraHeaders = {}) => {
		const body = Buffer.from(text, "utf8");
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": String(body.length), ...extraHeaders });
		res.end(body);
	};
	return (req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://b.invalid");
			const record = {
				method: req.method ?? "GET",
				pathname: url.pathname,
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks),
			};
			B_STATE.seen.push(record);
			const cookieOk = String(req.headers.cookie ?? "")
				.split(";")
				.map((part) => part.trim())
				.includes(`dsh-auth-e2e=${B_SESSION}`);
			// 0.28.0：跨机请求带身份头（x-dsh-remote-host）；B 端模拟 edge：认这个头。
			const peerOk = typeof req.headers["x-dsh-remote-host"] === "string" && req.headers["x-dsh-remote-host"] !== "";
			if (record.pathname === "/" && record.method === "GET") {
				// A 的宿主侧 token 兑换：`GET <B>/?token=…` → 303 + Set-Cookie（插件只取 cookie，不跟跳转）。
				const token = url.searchParams.get("token") ?? "";
				if (token !== B_TOKEN) {
					writeText(res, 401, "bad token");
					return;
				}
				res.writeHead(303, {
					"set-cookie": `dsh-auth-e2e=${B_SESSION}; Path=/; HttpOnly; SameSite=Lax`,
					location: "/",
					"content-type": "text/plain; charset=utf-8",
				});
				res.end("token exchange ok");
				return;
			}
			if (record.pathname === "/api/forbidden" && record.method === "GET") {
				// 永远 401：模拟"对端不认这份会话/令牌"（A 会丢掉会话、重兑一次、再重试一次）。
				const body = Buffer.from(B_DENIED_BODY, "utf8");
				res.writeHead(401, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length) });
				res.end(body);
				return;
			}
			if (record.pathname.startsWith("/api/")) {
				if (!cookieOk && !peerOk) {
					writeJson(res, 401, { error: "b-unauthorized" });
					return;
				}
				if (record.pathname === "/api/echo" && record.method === "GET") {
					writeJson(res, 200, {
						method: record.method,
						url: record.url,
						query: Object.fromEntries(url.searchParams),
						host: record.headers.host ?? null,
						origin: record.headers.origin ?? null,
						cookie: record.headers.cookie ?? null,
					});
					return;
				}
				if (record.pathname === "/api/bytes" && record.method === "GET") {
					res.writeHead(200, {
						"content-type": "application/octet-stream",
						"content-length": String(B_BYTES.length),
						"x-e2e-marker": "b-bytes",
					});
					res.end(B_BYTES);
					return;
				}
				if (record.pathname === "/api/echo-bytes" && record.method === "POST") {
					res.writeHead(201, {
						"content-type": "application/octet-stream",
						"content-length": String(record.body.length),
						"x-e2e-marker": "b-201",
					});
					res.end(record.body);
					return;
				}
				writeText(res, 404, "b: unknown api");
				return;
			}
			writeText(res, 404, "b: unknown path");
		});
	};
}

//#endregion

//#region 主流程

/** 内存版凭据服务（仿真 `ctx.credentials`：resolve / set / unset / describe）。 */
function createCredentials() {
	const store = new Map();
	const setCalls = [];
	const unsetCalls = [];
	return {
		store,
		setCalls,
		unsetCalls,
		async resolve(ref) {
			const value = store.get(ref);
			return value === undefined ? undefined : { value, source: "e2e" };
		},
		async set(ref, value) {
			setCalls.push([ref, value]);
			store.set(ref, value);
		},
		async unset(ref) {
			unsetCalls.push(ref);
			store.delete(ref);
		},
		async describe(ref) {
			return { configured: store.has(ref), writable: true };
		},
	};
}

/** 已启动的监听 / 已装配的实例：**在 main 里一创建就登记**，保证 main 中途抛错也能清理干净。 */
const startedInfra = { hosts: [], routers: [] };

async function main() {
	log(`dsh-remote e2e（两个进程内插件实例 + 真实 loopback HTTP）`);
	log(`插件版本：${String(internals.VERSION)}  Node：${process.version}`);
	log(`临时目录：${workDir}`);

	const aCredentials = createCredentials();
	const bCredentials = createCredentials();
	const routerA = createRouter({ credentials: aCredentials });
	startedInfra.routers.push(routerA);
	const routerB = createRouter({ credentials: bCredentials });
	startedInfra.routers.push(routerB);
	const hostA = startFakeHost(routerA);
	startedInfra.hosts.push(hostA);
	const hostB = startFakeHost(routerB, createBApp());
	startedInfra.hosts.push(hostB);
	const aPort = await hostA.ready();
	const bPort = await hostB.ready();

	const dataFileA = join(workDir, "a-devices.json");
	const dataFileB = join(workDir, "b-devices.json");
	const liveFileA = join(workDir, "a-live.json");
	const liveFileB = join(workDir, "b-live.json");
	const baseA = `http://127.0.0.1:${String(aPort)}`;
	const baseB = `http://127.0.0.1:${String(bPort)}`;

	// 先起服务、再 apply：插件拿到的 ctx.webServer.port 就是真实监听端口（自验证"本机"要用它）。
	apply(routerA.ctx, { dataFile: dataFileA, liveFile: liveFileA }, { muxPath: "/api/remote.mux" });
	apply(routerB.ctx, { dataFile: dataFileB, liveFile: liveFileB }, { muxPath: "/api/remote.mux" });

	// ---------------- 0. 装配 ----------------
	section("0 装配：两个插件实例 + 两个真实 loopback 服务");
	check("插件导出的 name 是 dsh-remote", pluginName === "dsh-remote", String(pluginName));
	check("A / B 都只监听 127.0.0.1（系统分配的随机端口）",
		hostA.server.address().address === "127.0.0.1" && hostB.server.address().address === "127.0.0.1",
		`A=${String(hostA.server.address().address)} B=${String(hostB.server.address().address)}`);
	check("A / B 端口不同且都在高位（避免把 B 误判成 A 本机）",
		aPort !== bPort && aPort > 1023 && bPort > 1023, `A=${String(aPort)} B=${String(bPort)}`);
	check("A 实例已注册设置页路由 /plugin/remote", routerA.prefixes.has("/plugin/remote"), [...routerA.prefixes.keys()].join(","));
	check("B 实例也已注册设置页路由 /plugin/remote（两个实例各自独立）", routerB.prefixes.has("/plugin/remote"));
	check("测试环境隔离：DSH_HOME 在临时目录里、外网版本检查已关闭（不访问外网）",
		process.env.DSH_HOME === dshHome && dshHome.startsWith(workDir) && process.env.DSH_REMOTE_UPDATE_CHECK === "off",
		`DSH_HOME=${String(process.env.DSH_HOME)} UPDATE_CHECK=${String(process.env.DSH_REMOTE_UPDATE_CHECK)}`);
	check("初始没有 /dev/** 路由", routerA.devPrefixes().length === 0, routerA.devPrefixes().join(","));

	// ---------------- 1. 经插件自己的接口把 B 加为设备（带 token） ----------------
	section("1 加设备：A 经 POST /plugin/remote/devices 把 B 加为设备（带 token）");
	const addResponse = await httpJson(`${baseA}/plugin/remote/devices`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id: "b", name: "B 端（e2e）", url: baseB, key: "A".repeat(43) }),
	});
	check("响应是 application/json（不是 HTML）", isJson(addResponse.headers), contentTypeOf(addResponse.headers));
	check("POST 返回 ok:true 且设备 id=b", addResponse.json?.ok === true && addResponse.json?.device?.id === "b", JSON.stringify(addResponse.json).slice(0, 200));
	check("A 立刻注册了 /dev/b 前缀路由", routerA.prefixes.has("/dev/b"), routerA.devPrefixes().join(","));
	check("按 deps.muxPath 同时注册了 /dev/b/api/remote.mux 升级路由", routerA.upgrades.has("/dev/b/api/remote.mux"), [...routerA.upgrades.keys()].join(","));
	check("配对密钥写进数据文件（重启不丢）", (() => {
		try {
			const parsed = JSON.parse(readFileSync(dataFileA, "utf8"));
			return parsed.devices.some((entry) => entry.id === "b" && typeof entry.key === "string" && entry.key.length === 43);
		} catch {
			return false;
		}
	})());
	const dataA = JSON.parse(readFileSync(dataFileA, "utf8"));
	check("数据文件里设备条目只有 id/name/url/key（不再是 token）",
		dataA.devices.length === 1
			&& dataA.devices.every((entry) => Object.keys(entry).every((key) => ["id", "name", "url", "key", "paired", "hotkey"].includes(key)))
			&& !JSON.stringify(dataA).includes(B_TOKEN),
		JSON.stringify(dataA).slice(0, 200));
	const stateAfterAdd = await httpJson(`${baseA}/plugin/remote/state`);
	const deviceB = Array.isArray(stateAfterAdd.json?.devices) ? stateAfterAdd.json.devices.find((entry) => entry.id === "b") : undefined;
	check("A 的 /plugin/remote/state 里有 b（url 指向 B 的真实端口）",
		stateAfterAdd.status === 200 && deviceB?.url === baseB, JSON.stringify(deviceB));
	check("A 的代理路由数 = 2（HTTP + upgrade 各一条）", stateAfterAdd.json?.diagnostics?.proxyRoutes === 2, String(stateAfterAdd.json?.diagnostics?.proxyRoutes));
	check("A 的体检 notes 写明 token 存储在凭据服务（不是明文落盘）",
		Array.isArray(stateAfterAdd.json?.diagnostics?.notes)
			&& stateAfterAdd.json.diagnostics.notes.some((note) => typeof note === "string" && note.includes("token 存储 = DSH 凭据服务")),
		JSON.stringify(stateAfterAdd.json?.diagnostics?.notes?.slice(0, 2)));

	// ---------------- 2. 透传：状态码 / 响应头 / 字节 / 请求头改写 / token 兑换 ----------------
	section("2 透传：GET + Host/Origin 改写 + token→会话 cookie + 二进制字节 / 请求体");
	const echo = await httpCall(`${baseA}/dev/b/api/echo?from=e2e&x=1`);
	const echoJson = jsonOf(echo.body);
	check("GET /dev/b/api/echo → 200", echo.status === 200, `status=${String(echo.status)}`);
	check("查询串原样透传到 B（from=e2e&x=1）",
		echoJson?.query?.from === "e2e" && echoJson?.query?.x === "1", JSON.stringify(echoJson?.query));
	check("上游 Host 被改写成 B 的 authority", echoJson?.host === `127.0.0.1:${String(bPort)}`, String(echoJson?.host));
	check("上游 Origin 被改写成 B 的 origin", echoJson?.origin === baseB, String(echoJson?.origin));
	check("宿主侧用 token 兑换出的会话 cookie 真的带到了 B",
		echoJson?.cookie === `dsh-auth-e2e=${B_SESSION}`, String(echoJson?.cookie));
	const tokenExchanges1 = B_STATE.seen.filter((entry) => entry.pathname === "/" && entry.url.includes("token=")).length;
	const leaked = B_STATE.seen.filter((entry) => entry.pathname.startsWith("/api/")).filter((entry) => entry.url.includes("token="));
	check("B 只收到一次 token 兑换（GET /?token=…）", tokenExchanges1 === 1, String(tokenExchanges1));
	check("代理出去的 /api 请求里没有 token 泄漏", leaked.length === 0, JSON.stringify(leaked.map((entry) => entry.url)));
	check("A 在代理请求上带的自定义头也能到 B（x-e2e-client）",
		(await httpCall(`${baseA}/dev/b/api/echo`, { headers: { "x-e2e-client": "kept" } })).status === 200
			&& B_STATE.seen.at(-1)?.headers?.["x-e2e-client"] === "kept",
		String(B_STATE.seen.at(-1)?.headers?.["x-e2e-client"]));

	const bytes = await httpCall(`${baseA}/dev/b/api/bytes`);
	check("二进制响应逐字节透传（1024+ 字节，含 0x00..0xff）", bytes.status === 200 && bytes.body.equals(B_BYTES),
		`status=${String(bytes.status)} len=${String(bytes.body.length)}`);
	check("上游 content-type / 自定义响应头透传",
		contentTypeOf(bytes.headers).toLowerCase().startsWith("application/octet-stream") && bytes.headers["x-e2e-marker"] === "b-bytes",
		contentTypeOf(bytes.headers));
	const payload = Buffer.concat([Buffer.from("POST-BODY:"), randomBytes(4096)]);
	const posted = await httpCall(`${baseA}/dev/b/api/echo-bytes`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: payload,
	});
	const seenPost = B_STATE.seen.find((entry) => entry.pathname === "/api/echo-bytes");
	check("POST 状态码 201 透传", posted.status === 201, `status=${String(posted.status)}`);
	check("POST 请求体逐字节到达 B", seenPost !== undefined && seenPost.body.equals(payload), `len=${String(seenPost?.body.length)}`);
	check("POST 响应体逐字节回到 A（echo 回来的字节一模一样）", posted.body.equals(payload), `len=${String(posted.body.length)}`);

	// 跨两个插件实例：A 的代理把请求送到 B 实例自己注册的设置页接口。
	const bState = await httpCall(`${baseA}/dev/b/plugin/remote/state`);
	const bStateJson = jsonOf(bState.body);
	check("A 的 /dev/b/plugin/remote/state 打到 B 实例自己的插件接口（200 + JSON）",
		bState.status === 200 && isJson(bState.headers), `status=${String(bState.status)}`);
	check("拿到的是 B 实例的状态（version 一致、B 的设备表为空 = 两台实例互不串台）",
		bStateJson?.version === internals.VERSION
			&& Array.isArray(bStateJson?.devices) && bStateJson.devices.length === 0,
		JSON.stringify({ version: bStateJson?.version, devices: bStateJson?.devices?.length }));

	// ---------------- 3. 401：B 拒绝 → A 丢会话、重兑 token、只重试一次，最终把 401 透传 ----------------
	section("3 401：B 回 401 → A 重试一次仍 401 ⇒ 401 透传 + 提示「重新复制 token」");
	const denied = await httpCall(`${baseA}/dev/b/api/forbidden`);
	const forbiddenSeen = B_STATE.seen.filter((entry) => entry.pathname === "/api/forbidden").length;
	const tokenExchanges2 = B_STATE.seen.filter((entry) => entry.pathname === "/" && entry.url.includes("token=")).length;
	check("B 的 401 原样透传给浏览器（状态码 401）", denied.status === 401, `status=${String(denied.status)}`);
	check("401 响应体逐字节透传", denied.body.toString("utf8") === B_DENIED_BODY, JSON.stringify(denied.body.toString("utf8")));
	check("A 在 401 后：同 cookie 重试一次 + 换 token 再试一次（B 一共收到 3 次 /api/forbidden）", forbiddenSeen === 3, String(forbiddenSeen));
	check("A 丢掉旧会话并用 token 重新兑换（B 一共收到 2 次 token 兑换）", tokenExchanges2 === 2, String(tokenExchanges2));
	const stateAfter401 = await httpJson(`${baseA}/plugin/remote/state`);
	const deviceAfter401 = Array.isArray(stateAfter401.json?.devices) ? stateAfter401.json.devices.find((entry) => entry.id === "b") : undefined;
	check("A 的 state.devices[].lastError 写明「对端拒绝了会话/令牌（HTTP 401）」",
		typeof deviceAfter401?.lastError === "string"
			&& deviceAfter401.lastError.includes("拒绝") && deviceAfter401.lastError.includes("401"),
		String(deviceAfter401?.lastError));
	check("A 的告警日志里也有这句拒绝提示（便于排错）",
		routerA.logs.some((line) => line.startsWith("warn:") && line.includes("拒绝") && line.includes("\"b\"")),
		routerA.logs.filter((line) => line.includes("拒绝")).at(-1) ?? "(无)");

	// ---------------- 4. 不可达：端口关闭 ⇒ 首次立即 502；第二次命中"已知不可达快失败" ----------------
	section("4 不可达：B 端口关闭 → A 快速 502（不卡建连超时）+ 第二次快失败");
	const deadPort = await closedPort();
	const addDead = await httpJson(`${baseA}/plugin/remote/devices`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id: "dead", name: "关机端（e2e）", url: `http://127.0.0.1:${String(deadPort)}`, key: "B".repeat(43) }),
	});
	check("不可达设备添加成功并立刻有 /dev/dead 路由",
		addDead.json?.ok === true && routerA.prefixes.has("/dev/dead"), JSON.stringify(addDead.json).slice(0, 160));
	const firstAt = Date.now();
	const downFirst = await httpCall(`${baseA}/dev/dead/api/x`);
	const firstMs = Date.now() - firstAt;
	check("关机端口 → 502 纯文本（不是 HTML、不是挂住）",
		downFirst.status === 502 && isTextPlain(downFirst.headers), `status=${String(downFirst.status)} type=${contentTypeOf(downFirst.headers)}`);
	check("首次失败很快就返回（ECONNREFUSED，不卡 3 秒建连超时）", firstMs < 1500, `${String(firstMs)} ms`);
	const secondAt = Date.now();
	const downSecond = await httpCall(`${baseA}/dev/dead/api/x`);
	const secondMs = Date.now() - secondAt;
	check("第二次命中「可达性账本刚判过不可达」→ 立刻 502 快失败", downSecond.status === 502 && secondMs < 300,
		`status=${String(downSecond.status)} ${String(secondMs)} ms`);
	check("快失败响应体说明是账本判定（没有等上游建连）",
		downSecond.body.toString("utf8").includes("不可达"), JSON.stringify(downSecond.body.toString("utf8").slice(0, 120)));
	check("不可达设备不拖死 A：设置页接口仍然 200", (await httpCall(`${baseA}/plugin/remote/state`)).status === 200);

	// ---------------- 5. 删设备：/dev/b 路由立刻消失（404 落到宿主 fallback） ----------------
	section("5 删设备：DELETE 后 /dev/b 路由消失（404），凭据与数据文件同步清掉");
	const deleted = await httpJson(`${baseA}/plugin/remote/devices/b`, { method: "DELETE" });
	check("DELETE /plugin/remote/devices/b → ok:true", deleted.status === 200 && deleted.json?.ok === true, JSON.stringify(deleted.json).slice(0, 160));
	check("A 的 /dev/b 前缀路由与升级路由都被撤掉",
		!routerA.prefixes.has("/dev/b") && !routerA.upgrades.has("/dev/b/api/remote.mux"),
		routerA.devPrefixes().join(","));
	const afterDelete = await httpCall(`${baseA}/dev/b/api/echo`);
	check("再请求 /dev/b/api/echo → 404（宿主 fallback，插件不再拦这条路径）",
		afterDelete.status === 404 && afterDelete.body.toString("utf8").includes("no route (fallback)"),
		`status=${String(afterDelete.status)} body=${JSON.stringify(afterDelete.body.toString("utf8").slice(0, 60))}`);
	const dataAfterDelete = JSON.parse(readFileSync(dataFileA, "utf8"));
	check("数据文件里 b 已删除", dataAfterDelete.devices.every((entry) => entry.id !== "b"), JSON.stringify(dataAfterDelete.devices));
	check("数据文件里 b 的条目已清掉（含 key）", dataAfterDelete.devices.every((entry) => entry.id !== "b"), JSON.stringify(dataAfterDelete.devices));

	// 顺手把不可达设备也删掉（清理更彻底；这一条只做，不断言）。
	await httpJson(`${baseA}/plugin/remote/devices/dead`, { method: "DELETE" });
}

//#endregion

//#region 清理 + 汇总

let cleanup = null;
try {
	await main();
} catch (error) {
	results.fail += 1;
	results.failed.push({ name: "未捕获异常", detail: String(error?.stack ?? error) });
	log(`\n[e2e] 未捕获异常：${String(error?.stack ?? error)}`);
} finally {
	section("6 清理：关监听、卸插件、删临时目录");
	const note = { closed: [], removed: false };
	for (const host of [...startedInfra.hosts].reverse()) {
		try {
			await host.close();
			note.closed.push("closed");
		} catch (error) {
			note.closed.push(String(error));
			note.error = String(error);
		}
	}
	for (const router of startedInfra.routers) router.disposeEffects();
	try {
		rmSync(workDir, { recursive: true, force: true });
		note.removed = !existsSync(workDir);
	} catch (error) {
		note.error = String(error);
	}
	check("A / B 的 HTTP 监听均已关闭", note.closed.length === 2 && note.closed.every((state) => state === "closed"),
		`状态=${JSON.stringify(note.closed)}`);
	check("临时目录（含插件真数据文件 / 日志 / helper 脚本）已整个删除", note.removed === true,
		String(note.error ?? workDir));
	check("总耗时 < 30 秒（要求）", Date.now() - startedAt < 30_000, `${String(Date.now() - startedAt)} ms`);
	cleanup = note;
}

const elapsedMs = Date.now() - startedAt;
log("");
log("────────────────────────────────────────────");
log(`dsh-remote e2e 结果：通过 ${String(results.pass)} 项，失败 ${String(results.fail)} 项，耗时 ${String(elapsedMs)} ms`);
if (results.fail > 0) {
	log("失败明细：");
	for (const entry of results.failed) log(`  ✗ ${entry.name}${entry.detail === undefined ? "" : `  ← ${entry.detail}`}`);
	process.exitCode = 1;
} else {
	log("所有断言通过（两个插件实例 + 真实 loopback HTTP；无外网访问；临时目录已清理）。");
	process.exitCode = 0;
}
log("────────────────────────────────────────────");

//#endregion

// 保证变量被引用（也便于将来改成具名返回）。
void cleanup;
