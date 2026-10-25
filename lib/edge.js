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

import { info, messageOf, toPort, warn } from "./util.js";

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
const EDGE_ALLOWED_PLUGIN_PATHS = new Set(["/plugin/remote/hello", "/plugin/remote/live", "/plugin/remote/live/seen"]);

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

	const server = edgeIo.server((req, res) => {
		let pathname = "";
		try {
			pathname = new URL(req.url, `http://${req.headers.host ?? "edge"}`).pathname;
		} catch {
			pathname = String(req.url ?? "");
		}
		if (edgeBlocks(pathname)) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh-remote edge: 这个路径只对本机回环开放\n");
			return;
		}
		// 只读插件路径（hello / live）放行给"已登录的浏览器页面"：没带 DSH 认证 cookie 一律 401。
		if (EDGE_ALLOWED_PLUGIN_PATHS.has(pathname)) {
			const rawCookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
			if (!/(?:^|;\s*)dsh-auth-[^=;]+=/u.test(rawCookie)) {
				res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				res.end("dsh-remote edge: 需要先登录\n");
				return;
			}
		}
		const upstream = edgeIo.request({
			host: "127.0.0.1",
			port: target,
			method: req.method,
			path: req.url,
			headers: edgeHeaders(req.headers, authority),
			// **不复用 keep-alive 池**：每条转发都新开一条连接（目标是 127.0.0.1，代价可忽略）。
			// 否则池里那条空闲 socket 会在关闭后继续当 ref 句柄，把 Host 进程拖住。
			agent: false,
		}, (upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
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
	});

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
		let pathname = "";
		try {
			pathname = new URL(req.url, `http://${req.headers.host ?? "edge"}`).pathname;
		} catch {
			pathname = String(req.url ?? "");
		}
		if (edgeBlocks(pathname)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		if (state.sockets !== undefined) {
			state.sockets.add(socket);
			socket.on("close", () => state.sockets.delete(socket));
		}
		const upstream = edgeIo.connect(target, "127.0.0.1", () => {
			const lines = [`GET ${req.url} HTTP/1.1`, `Host: ${authority}`, `Origin: http://${authority}`];
			for (const [key, value] of Object.entries(req.headers)) {
				const lower = key.toLowerCase();
				if (lower === "host" || lower === "origin" || lower === "connection" || lower === "upgrade") continue;
				if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
				else if (value !== undefined) lines.push(`${key}: ${value}`);
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
		// 升级转发的**上游** socket 也跟踪：`stopEdge` 时与入站 socket 一起 destroy，
		// 否则一条活着的 mux 长连接（或被半关的连接）照样能把 Host 进程按在退出前。
		if (state.upstreamSockets !== undefined && state.upstreamSockets !== null) {
			state.upstreamSockets.add(upstream);
			upstream.on("close", () => state.upstreamSockets.delete(upstream));
		}
		upstream.on("error", (error) => {
			warn(runtime.ctx, `对外入口 WebSocket 转发失败：${messageOf(error)}`);
			socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		});
		socket.on("error", () => upstream.destroy());
	});

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
