/**
 * 对外入口 edge（0.9.0）：监听 0.0.0.0:PORT，把 Host/Origin/Referer 改写成固定的
 * 内层 authority 再转给本机 DSH（HTTP + WebSocket upgrade 两条路）。
 *
 * 从 lib/index.js 原样搬出（重构第 4 刀，行为一个字节都没改）。搬出的符号：
 *  - EDGE_DEFAULT_PORT / EDGE_INNER_AUTHORITY / EDGE_BLOCKED_PREFIXES / EDGE_ALLOWED_PLUGIN_PATHS
 *  - edgeIo / edgeTargetPort / edgeBlocks / edgeHeaders / destroyTrackedSockets
 *  - startEdge / stopEdge / syncEdge / buildEdgeState（以及 edge 的 HTTP / upgrade handler）
 *
 * 依赖：node:http / node:net；warn / info / messageOf / toPort 来自 ./util.js。
 * 本文件不 import ./index.js（无循环依赖）。
 */

import { createServer as httpServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

import { timingSafeEqual } from "node:crypto";

import { isClientAllowed, rememberClient, PEER_HOST_HEADER, PEER_KEY_HEADER } from "./auth.js";
import { info, messageOf, normalizeDeviceKey, toPort, warn } from "./util.js";

/** 对外入口默认端口（就是大家一直在用的那个）。 */
const EDGE_DEFAULT_PORT = 19387;
/**
 * 对内 authority（**0.13.3**）：edge 转发给内层 DSH 时**固定使用**这个 Host（Host / Origin / Referer 都改写成它）。
 *
 * 为什么：DSH 的 cookie authority = `requestAudience(req.headers)` = **Host 头**（`new URL("http://"+host).host`），
 * 与 DSH 实际监听端口无关。2026-10-18 用假 Host `127.0.0.1:9999` 实测：`/?token=` 兑换 **303**、首页 **200**、
 * `/api/session/list` **200**、`/dsh-remote-live` **200**；不带 cookie **403**；拿假 Host 的 cookie 配真 Host **403**。
 * ⇒ 固定它之后：DSH 的内层端口可以回到随机（避免被占用顶掉），而所有经 edge 的 cookie（浏览器 + 对端）都绑定在
 * 这个固定值上 ⇒ 重启/换端口都不再让 cookie 失效。
 *
 * ⚠ 改这个值 = 所有经 edge 的 cookie 作废（对端需要重新认证一次、浏览器要重新打开登录链接），所以**不要随版本改它**。
 */
const EDGE_INNER_AUTHORITY = "127.0.0.1:2850";
/** 对外入口**永远**挡掉的路径前缀：设置页/写路由只认回环，不能被入口放出去。 */
const EDGE_BLOCKED_PREFIXES = ["/plugin/"];
/** edge 上允许直通的只读插件路径（页面经 edge 打开时垫片/客户端要用；不含 token / 不改配置）。 */
const EDGE_ALLOWED_PLUGIN_PATHS = new Set(["/plugin/remote/hello", "/plugin/remote/live", "/plugin/remote/live/seen", "/plugin/remote/state"]);

//#region 对外入口 edge（0.9.0）：把 Host/Origin 改写成 loopback 再转给本机 DSH

/**
 * 对外入口的三个"底座"（缺省就是 `node:http` / `node:net`，**生产路径一个字节都没变**）。
 * 只给自测换桩用：`unref` / `connection` 跟踪 / `closeAllConnections` / `agent:false` 这几件
 * 都只关乎"进程能不能退出"，用真 socket 很难稳定断言。
 */
const edgeIo = {
	server: (handler) => httpServer(handler),
	request: (options, callback) => httpRequest(options, callback),
	connect: (port, host, callback) => netConnect(port, host, callback),
};

/** 这台机器 DSH 自己的监听端口（= edge 的转发目标）。 */
function edgeTargetPort(runtime) {
	const web = runtime.ctx !== null && typeof runtime.ctx === "object" ? runtime.ctx.webServer : undefined;
	return web !== undefined && web !== null ? toPort(web.port) : undefined;
}

/** edge 要不要挡这个路径（插件的设置页/写路由只认回环，不能让它们透过 edge）。 */
function edgeBlocks(pathname) {
	if (EDGE_ALLOWED_PLUGIN_PATHS.has(pathname)) return false;
	return EDGE_BLOCKED_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

/** 改写请求头：Host/Origin/Referer 一律指向本机 loopback authority（Host 栅栏对 loopback 免检）。 */
function edgeHeaders(headers, authority) {
	const out = { ...headers, host: authority };
	if (typeof out.origin === "string" && out.origin !== "") out.origin = `http://${authority}`;
	if (typeof out.referer === "string" && out.referer !== "") {
		try {
			const parsed = new URL(out.referer);
			out.referer = `http://${authority}${parsed.pathname}${parsed.search}`;
		} catch {
			delete out.referer;
		}
	}
	return out;
}

/** 一次性 destroy 并清空一组 socket（**同步**；单个失败不影响其它，绝不等它）。 */
function destroyTrackedSockets(set) {
	if (set === undefined || set === null) return;
	for (const socket of set) {
		try {
			socket.destroy();
		} catch {
			/* 已断 */
		}
	}
	set.clear();
}

/** 停掉对外入口（幂等；**同步、不 await** —— 清理不许阻塞退出）。 */
function stopEdge(runtime) {
	const state = runtime.edge;
	if (state === undefined || state === null) return;
	// 入站（浏览器 HTTP keep-alive / SSE / upgrade）与升级转发的上游 socket 一起断。
	destroyTrackedSockets(state.sockets);
	destroyTrackedSockets(state.upstreamSockets);
	const server = state.server;
	state.server = null;
	state.running = false;
	if (server !== null && server !== undefined) {
		try {
			server.close();
		} catch {
			/* 已关 */
		}
		// 只 close() 不会断开 keep-alive / SSE 这类长连接（它们会一直挂着）：一次性切掉。
		try {
			if (typeof server.closeAllConnections === "function") server.closeAllConnections();
		} catch {
			/* 老 Node / 已关 */
		}
		// 辅助服务器绝不能成为"进程退不出去"的最后一个 ref 句柄（幂等；桩可能没有 unref）。
		try {
			server.unref?.();
		} catch {
			/* 忽略 */
		}
	}
}

/**
 * 起对外入口：监听 `0.0.0.0:<对外端口>`，把每个请求（含 WebSocket 升级）的 Host/Origin/Referer
 * 改写成 `127.0.0.1:<本机 DSH 端口>` 再转发过去。于是：
 *  - 官方 `connection.trustedHosts` 可以保持**空数组**（loopback 免检，官方默认）；
 *  - `webserver.host` 可以保持**官方支持的 `127.0.0.1`**；
 *  - 对外的端口与进程都沿用**早就被防火墙/安全软件放行过的那个**（不必再去点授权）。
 * 启停是**即时**的（配置存在数据文件里）；只有 profile 里那两行要重启 DSH 才生效。
 */
function startEdge(runtime) {
	const state = runtime.edge;
	if (state === undefined || state === null) return;
	if (runtime.data.enabled !== true || runtime.data.edge === undefined || runtime.data.edge.enabled !== true) {
		stopEdge(runtime);
		state.error = null;
		return;
	}
	if (state.server !== null && state.server !== undefined) return; // 已经在跑
	const port = toPort(runtime.data.edge.port) ?? EDGE_DEFAULT_PORT;
	const target = edgeTargetPort(runtime);
	if (target === undefined) {
		state.error = "读不到本机 DSH 的监听端口，对外入口没起（请看体检块里 webserver 是否可用）";
		warn(runtime.ctx, state.error);
		return;
	}
	if (port === target) {
		state.error = `对外端口 ${String(port)} 正是本机 DSH 自己在用的端口：请换一个（例如 ${String(port + 1)}）—— 本插件不会去改 DSH 的配置`;
		warn(runtime.ctx, state.error);
		return;
	}
	// 0.13.3：**固定**对内 authority，不再用实际内层端口 ⇒ cookie 的 authority 恒定（DSH 端口可以随机）。
	const authority = EDGE_INNER_AUTHORITY;
	state.targetPort = target;

	/**
	 * 0.27.0：配对密钥认证。请求里带 `Cookie: dsh-remote-key=<key>`（本插件代理会带）或
	 * `x-dsh-remote-key` 头时，校验通过就用**本机自己的 token** 在内部换一份 DSH cookie 再转发，
	 * 从而不再依赖对端每次启动都会轮换的 token。
	 */
	function readRemoteKey(headers) {
		const cookie = typeof headers.cookie === "string" ? headers.cookie : "";
		const match = /(?:^|;\s*)dsh-remote-key=([A-Za-z0-9_-]{43})(?:;|$)/u.exec(cookie);
		if (match !== null) return match[1];
		const header = typeof headers["x-dsh-remote-key"] === "string" ? headers["x-dsh-remote-key"].trim() : "";
		return normalizeDeviceKey(header);
	}

	function keyMatches(runtime, key) {
		const expected = typeof runtime.data.deviceKey === "string" ? runtime.data.deviceKey : "";
		if (expected === "" || key === undefined) return false;
		try {
			const left = Buffer.from(expected);
			const right = Buffer.from(key);
			return left.length === right.length && timingSafeEqual(left, right);
		} catch {
			return false;
		}
	}

	function edgeInnerCookie(runtime, target, authority) {
		const state = runtime.edge;
		if (state !== undefined && state !== null && typeof state.keyCookie === "string" && state.keyCookie !== "") return Promise.resolve(state.keyCookie);
		return new Promise((resolve) => {
			let token = "";
			try {
				const connection = runtime.ctx !== null && runtime.ctx !== undefined ? runtime.ctx.connection : undefined;
				if (connection !== null && connection !== undefined && typeof connection.authenticatedUrl === "function") {
					const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${String(target)}/`));
					token = url.searchParams.get("token") ?? "";
				}
			} catch {
				token = "";
			}
			if (token === "") {
				resolve(undefined);
				return;
			}
			const request = edgeIo.request({ host: "127.0.0.1", port: target, method: "GET", path: `/?token=${encodeURIComponent(token)}`, headers: { host: authority }, agent: false }, (response) => {
				const setCookie = response.headers["set-cookie"];
				response.resume();
				const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
				if (typeof first !== "string" || first === "") {
					resolve(undefined);
					return;
				}
				const pair = first.split(";")[0].trim();
				const value = pair.slice(pair.indexOf("=") + 1);
				if (state !== undefined && state !== null) state.keyCookie = `${pair.slice(0, pair.indexOf("="))}=${value}`;
				resolve(`${pair.slice(0, pair.indexOf("="))}=${value}`);
			});
			request.on("error", () => resolve(undefined));
			request.end();
		});
	}

	/**
	 * 0.28.2：只去掉 `key=` 参数，**其它 query 原样保留**。
	 * 不能用 URLSearchParams 重排：客户端 bundle 的地址是 `/plugins/??a/client.js,b/client.js`，
	 * 一重排 `??` 就被改成 `?=@…`，对端 404（浏览器里表现成 "HTML did not preload …"）。
	 */
	function stripKeyQuery(rawUrl) {
		const raw = typeof rawUrl === "string" ? rawUrl : "";
		const mark = raw.indexOf("?");
		if (mark < 0) return raw;
		const path = raw.slice(0, mark);
		const query = raw.slice(mark + 1);
		const kept = query.split("&").filter((part) => part !== "" && part.split("=")[0] !== "key");
		return path + (kept.length === 0 ? "" : "?" + kept.join("&"));
	}

	const server = edgeIo.server((req, res) => {
		const parsedUrl = (() => {
			try {
				return new URL(req.url, `http://${req.headers.host ?? "edge"}`);
			} catch {
				return null;
			}
		})();
		const pathname = parsedUrl === null ? String(req.url ?? "") : parsedUrl.pathname;
		const queryKey = parsedUrl === null ? "" : (parsedUrl.searchParams.get("key") ?? "");
		if (edgeBlocks(pathname)) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh-remote edge: 这个路径只对本机回环开放\n");
			return;
		}
		const peerHost = typeof req.headers[PEER_HOST_HEADER] === "string" ? req.headers[PEER_HOST_HEADER].trim() : "";
		const peerKey = typeof req.headers[PEER_KEY_HEADER] === "string" ? req.headers[PEER_KEY_HEADER].trim() : "";
		const peerIp = normalizePeerIp(req.socket);
		const reject = (message) => {
			res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
			res.end(`dsh-remote edge: ${message}\n`);
		};
		const respondWithCookie = (setCookieToBrowser) => {
			edgeInnerCookie(runtime, target, authority).then((cookie) => {
				if (cookie === undefined) {
					res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
					res.end("dsh-remote edge: 本机 token 兑换会话失败\n");
					return;
				}
				forwardWithCookie(req, res, cookie, setCookieToBrowser === true);
			}, () => {
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote edge: 本机 token 兑换会话失败\n");
			});
		};
		// 1) 跨机请求：必须命中白名单（IP + hostname），或首次带对密钥来配对。
		if (peerHost !== "") {
			const keyOk = normalizeDeviceKey(peerKey) !== undefined && keyMatches(runtime, peerKey) === true;
			if (isClientAllowed(runtime, peerIp, peerHost) !== true) {
				if (keyOk !== true) {
					reject("这台机器的 hostname/IP 不在白名单里，或配对密钥不对");
					return;
				}
				rememberClient(runtime, peerIp, peerHost, peerHost);
			}
			respondWithCookie(false);
			return;
		}
		// 2) 浏览器用 ?key= 打开：密钥对 ⇒ 发一张门卡（Set-Cookie）并放行。
		const browserKey = normalizeDeviceKey(queryKey);
		if (browserKey !== undefined) {
			if (keyMatches(runtime, browserKey) !== true) {
				reject("配对密钥不对");
				return;
			}
			respondWithCookie(true);
			return;
		}
		// 3) 浏览器普通请求：按原样转发（它自己带 DSH 登录 cookie）。
		forwardWithCookie(req, res, undefined, false);
	});

	/** 转发一次请求；cookieForInner 非空时注入本机门卡（401 会自动换一张重试一次）。 */
	function forwardWithCookie(req, res, cookieForInner, setCookieToBrowser) {
		const forwardUrl = stripKeyQuery(String(req.url ?? ""));
		const forwardPath = (() => {
			try {
				return new URL(req.url, `http://${req.headers.host ?? "edge"}`).pathname;
			} catch {
				return String(req.url ?? "");
			}
		})();
		if (edgeBlocks(forwardPath)) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh-remote edge: 这个路径只对本机回环开放\n");
			return;
		}
		if (EDGE_ALLOWED_PLUGIN_PATHS.has(forwardPath)) {
			const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
			if (forwardPath === "/plugin/remote/state" && method !== "GET" && method !== "HEAD") {
				res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote edge: state 只允许只读访问\n");
				return;
			}
			const rawCookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
			if (typeof cookieForInner !== "string" && !/(?:^|;\s*)dsh-auth-[^=;]+=/u.test(rawCookie)) {
				res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote edge: 需要先登录\n");
				return;
			}
		}
		const upstream = edgeIo.request({
			host: "127.0.0.1",
			port: target,
			method: req.method,
			path: forwardUrl,
			headers: (() => {
				const out = edgeHeaders(req.headers, authority);
				delete out[PEER_HOST_HEADER];
				delete out[PEER_KEY_HEADER];
				// 浏览器请求：保留浏览器自己的 DSH cookie；只有注入门卡时才替换掉。
				if (typeof cookieForInner === "string" && cookieForInner !== "") out.cookie = cookieForInner;
				// 让内层不要 gzip（要改写 HTML 里的绝对地址）。
				out["accept-encoding"] = "identity";
				return out;
			})(),
			agent: false,
		}, (upstreamRes) => {
			const status = upstreamRes.statusCode ?? 502;
			// 门卡过期：清缓存、换一张新门卡，重试一次。
			if ((status === 401 || status === 403) && typeof cookieForInner === "string" && cookieForInner !== "") {
				const state = runtime.edge;
				if (state !== undefined && state !== null) state.keyCookie = undefined;
				upstreamRes.resume();
				edgeInnerCookie(runtime, target, authority).then((fresh) => {
					if (fresh === undefined) {
						if (res.headersSent !== true) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
						res.end("dsh-remote edge: 门卡续期失败\n");
						return;
					}
					forwardWithCookie(req, res, fresh, setCookieToBrowser === true);
				}, () => {
					if (res.headersSent !== true) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
					res.end("dsh-remote edge: 门卡续期失败\n");
				});
				return;
			}
			const headers = { ...upstreamRes.headers };
			if (setCookieToBrowser === true && typeof cookieForInner === "string" && cookieForInner !== "") {
				headers["set-cookie"] = [cookieForInner];
			}
			const contentType = typeof headers["content-type"] === "string" ? headers["content-type"] : "";
			const browserHost = typeof req.headers.host === "string" ? req.headers.host : "";
			if (contentType.startsWith("text/html") && browserHost !== "") {
				// 0.28.1：把 HTML 里指向内层 authority 的绝对地址改写成浏览器访问的地址，
				// 否则浏览器会去连 127.0.0.1:2850，客户端 bundle 加载失败（HTML did not preload…）。
				const chunks = [];
				let size = 0;
				upstreamRes.on("data", (chunk) => {
					size += chunk.length;
					if (size <= 4 * 1024 * 1024) chunks.push(chunk);
				});
				upstreamRes.on("end", () => {
					try {
						let body = Buffer.concat(chunks).toString("utf8");
						if (size > 4 * 1024 * 1024) {
							res.writeHead(status, headers);
							res.end(Buffer.concat(chunks));
							return;
						}
						body = body.split(`http://${authority}`).join(`http://${browserHost}`).split(`//${authority}`).join(`//${browserHost}`);
						delete headers["content-encoding"];
						delete headers["transfer-encoding"];
						headers["content-length"] = String(Buffer.byteLength(body));
						res.writeHead(status, headers);
						res.end(body);
					} catch {
						if (res.headersSent !== true) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
						res.end("dsh-remote edge: 改写 HTML 失败\n");
					}
				});
				return;
			}
			res.writeHead(status, headers);
			upstreamRes.pipe(res);
		});
		upstream.on("error", (error) => {
			warn(runtime.ctx, `对外入口转发失败：${messageOf(error)}`);
			if (res.headersSent !== true) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`dsh-remote edge: 转发到本机 DSH 失败：${messageOf(error)}\n`);
		});
		req.on("error", () => upstream.destroy());
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	}

	// **辅助服务器不阻止 Host 进程退出**：更新器安装 / DSH 退出时不能因为"对外入口还开着"
	// 就退不出去。正常运行时 DSH 自己还有别的 ref 句柄撑着，所以行为不变。
	server.unref?.();

	// 跟踪**所有**入站连接，不只是下面 upgrade 那条：浏览器的 HTTP keep-alive / SSE
	// 同样是 ref 句柄，停用（或卸载）时必须一起断开，否则一样拖住退出。
	server.on("connection", (socket) => {
		if (state.sockets === undefined || state.sockets === null) return;
		state.sockets.add(socket);
		socket.on("close", () => state.sockets.delete(socket));
	});

	server.on("upgrade", (req, socket, head) => {
		const parsedUrl = (() => {
			try {
				return new URL(req.url, `http://${req.headers.host ?? "edge"}`);
			} catch {
				return null;
			}
		})();
		const pathname = parsedUrl === null ? String(req.url ?? "") : parsedUrl.pathname;
		const queryKey = parsedUrl === null ? "" : (parsedUrl.searchParams.get("key") ?? "");
		if (edgeBlocks(pathname)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const peerHost = typeof req.headers[PEER_HOST_HEADER] === "string" ? req.headers[PEER_HOST_HEADER].trim() : "";
		const peerKey = typeof req.headers[PEER_KEY_HEADER] === "string" ? req.headers[PEER_KEY_HEADER].trim() : "";
		const peerIp = normalizePeerIp(req.socket);
		const reject = () => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		const start = (cookieForInner) => {
			upgradeWithCookie(req, socket, head, cookieForInner);
		};
		const withCookie = () => {
			edgeInnerCookie(runtime, target, authority).then((cookie) => {
				if (cookie === undefined) {
					socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
					return;
				}
				start(cookie);
			}, () => {
				socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			});
		};
		if (peerHost !== "") {
			const keyOk = normalizeDeviceKey(peerKey) !== undefined && keyMatches(runtime, peerKey) === true;
			if (isClientAllowed(runtime, peerIp, peerHost) !== true) {
				if (keyOk !== true) {
					reject();
					return;
				}
				rememberClient(runtime, peerIp, peerHost, peerHost);
			}
			withCookie();
			return;
		}
		const browserKey = normalizeDeviceKey(queryKey);
		if (browserKey !== undefined) {
			if (keyMatches(runtime, browserKey) !== true) {
				reject();
				return;
			}
			withCookie();
			return;
		}
		start(undefined);
	});

	function upgradeWithCookie(req, socket, head, cookieForInner) {
		if (state.sockets !== undefined) {
			state.sockets.add(socket);
			socket.on("close", () => state.sockets.delete(socket));
		}
		const forwardUrl = stripKeyQuery(String(req.url ?? ""));
		const upstream = edgeIo.connect(target, "127.0.0.1", () => {
			const lines = [`GET ${forwardUrl} HTTP/1.1`, `Host: ${authority}`, `Origin: http://${authority}`];
			for (const [key, value] of Object.entries(req.headers)) {
				const lower = key.toLowerCase();
				if (lower === "host" || lower === "origin" || lower === "connection" || lower === "upgrade") continue;
				if (lower === PEER_HOST_HEADER || lower === PEER_KEY_HEADER || lower === "cookie") continue;
				if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
				else if (value !== undefined) lines.push(`${key}: ${value}`);
			}
			if (typeof cookieForInner === "string" && cookieForInner !== "") {
				lines.push(`Cookie: ${cookieForInner}`);
			} else if (typeof req.headers.cookie === "string" && req.headers.cookie !== "") {
				// 浏览器直连页面时保留它自己的 DSH cookie（否则 mux 长连接 401）。
				lines.push(`Cookie: ${req.headers.cookie}`);
			}
			lines.push("Connection: Upgrade", "Upgrade: websocket");
			try {
				upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head !== undefined && head.length > 0) upstream.write(head);
			} catch (error) {
				warn(runtime.ctx, `对外入口 WebSocket 握手失败：${messageOf(error)}`);
				socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
				upstream.destroy();
				return;
			}
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		if (state.upstreamSockets !== undefined && state.upstreamSockets !== null) {
			state.upstreamSockets.add(upstream);
			upstream.on("close", () => state.upstreamSockets.delete(upstream));
		}
		upstream.on("error", (error) => {
			warn(runtime.ctx, `对外入口 WebSocket 转发失败：${messageOf(error)}`);
			socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		});
		socket.on("error", () => upstream.destroy());
	}

	/** `::ffff:<ipv4>` → `<ipv4>`；取不到就空串（白名单匹配会失败 ⇒ 需重新配对）。 */
	function normalizePeerIp(socket) {
		try {
			const raw = socket !== null && socket !== undefined && typeof socket.remoteAddress === "string" ? socket.remoteAddress : "";
			return raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
		} catch {
			return "";
		}
	}

	server.on("error", (error) => {
		state.error = `对外入口没能监听 ${String(port)}：${messageOf(error)}`;
		state.running = false;
		state.server = null;
		warn(runtime.ctx, state.error);
	});

	state.server = server;
	state.port = port;
	state.error = null;
	server.listen(port, "0.0.0.0", () => {
		state.running = true;
		info(runtime.ctx, `对外入口已在 0.0.0.0:${String(port)} 监听（Host/Origin 改写为 ${authority}，/plugin/** 一律 403）`);
	});
}

/** 让 edge 的实际状态与配置一致（数据文件热重载后也调它）。 */
function syncEdge(runtime) {
	if (runtime.data.edge !== undefined && runtime.data.edge.enabled === true) startEdge(runtime);
	else stopEdge(runtime);
}

//#endregion

/** 对外入口的对外状态（设置页与体检都看它）。 */

function buildEdgeState(runtime) {
	return {
		enabled: runtime.data.edge !== undefined && runtime.data.edge.enabled === true,
		port: toPort(runtime.data.edge?.port) ?? EDGE_DEFAULT_PORT,
		/** "在跑" = 已经有 server 且没报错（listen 是异步的，不看 running 标志，免得 UI 抖）。 */
		running: runtime.edge.server !== null && runtime.edge.error === null,
		error: runtime.edge.error,
		targetPort: edgeTargetPort(runtime) ?? null,
		blockedPrefixes: [...EDGE_BLOCKED_PREFIXES],
	};
}

export {
	EDGE_ALLOWED_PLUGIN_PATHS,
	EDGE_BLOCKED_PREFIXES,
	EDGE_DEFAULT_PORT,
	EDGE_INNER_AUTHORITY,
	buildEdgeState,
	destroyTrackedSockets,
	edgeBlocks,
	edgeHeaders,
	edgeIo,
	edgeTargetPort,
	startEdge,
	stopEdge,
	syncEdge,
};
