/**
 * /dev/** 反向代理 + WebSocket upgrade 转发（含 I1「绝不把 text/html 交给窗口」的拦截、
 * 401/403 自动重放、以及"已知不可达 ⇒ 不发上游连接"的快失败）。
 *
 * 从 lib/index.js 原样搬出（重构第 5 刀，行为一个字节都没改）。搬出的符号：
 *  - 纯文本 / JSON 出口：writeText / writeJson / writeDeviceNotice / blockHtmlResponse
 *  - 头改写：rewriteLocation / rewriteSetCookie / forwardableRequestHeaders / responseHeadersFor
 *  - HTTP 代理：openUpstream / handleHttpProxy / relayResponse
 *  - upgrade 转发：handleUpgradeProxy / rejectUpgrade
 *  - I1 的最终判定：classifyFinalBody
 *
 * 依赖：node:http / node:https / node:net / node:tls；warn / messageOf / plainValue / unrefTimer
 * 来自 ./util.js。设备 / 会话 cookie / 可达性账本 / 代理常量由宿主半（./index.js）通过
 * configureProxy() 注入（见下），**不 import ./index.js** —— 避免循环引用。
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { messageOf, plainValue, unrefTimer, warn } from "./util.js";

/**
 * 宿主半（./index.js）注入的依赖 —— 用依赖注入而不是 import ./index.js，
 * 避免 index ↔ 本文件 的 ESM 循环引用（也避免为了内部符号去扩大 index.js 的 export 面）。
 * 由 index.js 在模块求值末尾调用 configureProxy() 注入；本文件的函数只在**调用时**访问这些绑定。
 */
// 代理常量：BRIDGE_MAX_BODY_BYTES / CONNECT_TIMEOUT_MS / DROP_REQUEST_HEADERS / DROP_RESPONSE_HEADERS / REPLAY_MAX_BODY_BYTES / REPLAY_TOO_LARGE_MESSAGE / ROUTE_ROOT / SNIFF_LIMIT_BYTES / USER_AGENT
// 设备 / 会话 cookie / token 引导：captureSession / clearAuthNotice / cookieHeaderFor / ensureSession / forgetSession / authorizeTrustedRequest / noteAuthRejected
// 可达性账本 / 快失败：markReach / proxyConnectTimeout / recentlyUnreachable / triggerReachProbe / unreachableProxyReason
// I1 HTML 判定 / 请求体：classifyBodyPrefix / isHtmlContentType / declaredBodyLength / requestHasBody / readReplayBody / bridgePromptBody / inlineJson
let BRIDGE_MAX_BODY_BYTES, CONNECT_TIMEOUT_MS, DROP_REQUEST_HEADERS, DROP_RESPONSE_HEADERS,
	REPLAY_MAX_BODY_BYTES, REPLAY_TOO_LARGE_MESSAGE, ROUTE_ROOT, SNIFF_LIMIT_BYTES,
	USER_AGENT, clearAuthNotice, authorizeTrustedRequest, noteAuthRejected,
	peerHeaders, markPaired, unmarkPaired,
	markReach, proxyConnectTimeout, recentlyUnreachable, triggerReachProbe,
	unreachableProxyReason, classifyBodyPrefix, isHtmlContentType, declaredBodyLength,
	requestHasBody, readReplayBody, bridgePromptBody, inlineJson;
export function configureProxy(deps) {
	({
		BRIDGE_MAX_BODY_BYTES, CONNECT_TIMEOUT_MS, DROP_REQUEST_HEADERS, DROP_RESPONSE_HEADERS,
		REPLAY_MAX_BODY_BYTES, REPLAY_TOO_LARGE_MESSAGE, ROUTE_ROOT, SNIFF_LIMIT_BYTES,
		USER_AGENT, clearAuthNotice, authorizeTrustedRequest, noteAuthRejected,
		peerHeaders, markPaired, unmarkPaired,
		markReach, proxyConnectTimeout, recentlyUnreachable, triggerReachProbe,
		unreachableProxyReason, classifyBodyPrefix, isHtmlContentType, declaredBodyLength,
		requestHasBody, readReplayBody, bridgePromptBody, inlineJson
	} = deps);
}

//#region 纯文本 / JSON 出口（I1：本插件绝不产生 text/html）

/** 统一出口：一律 `text/plain` + nosniff。响应头已发出就只能销毁连接。 */
function writeText(res, status, text, headOnly) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const body = Buffer.from(text, "utf8");
	try {
		res.writeHead(status, {
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
			"content-length": String(body.length),
		});
		if (headOnly === true) res.end();
		else res.end(body);
	} catch {
		res.destroy();
	}
}

/**
 * 设置页接口的统一出口：一律 `application/json` + nosniff（同样绝不 text/html）。
 * JSON 文本里的 `<` 也转义成 `\u003c`（JSON 允许这种转义，客户端 `JSON.parse` 拿到原值），
 * 于是"本插件任何响应体里都没有裸 `<`"成为一条能逐条断言的不变式 —— 设备名里带
 * `<script>` 也不会让体检页的 JSON 里出现真的标记。
 */
function writeJson(res, status, payload, headOnly) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const body = Buffer.from(`${inlineJson(payload)}\n`, "utf8");
	try {
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
			"content-length": String(body.length),
		});
		if (headOnly === true) res.end();
		else res.end(body);
	} catch {
		res.destroy();
	}
}

/** 不可达 / 代理失败时的中文说明（纯文本，不是 HTML —— 见 I1）。 */
function writeDeviceNotice(res, device, reason, status) {
	const lines = [
		"dsh-remote：无法通过本机代理访问这台设备。",
		"",
		`设备：${plainValue(device.name)} (${plainValue(device.id)})`,
		`地址：${plainValue(`${device.origin}${device.basePath}`)}`,
		`原因：${plainValue(reason)}`,
		"",
		"检查项：",
		`- 那台机器上的 DSH 是否在运行？（在该机器上打开 http://127.0.0.1:${plainValue(device.port || (device.protocol === "https:" ? "443" : "80"))} 确认）`,
		"- 网络是否可达（防火墙、网段、VPN）？",
		"- 远端要 token 时，在设置页「远程设备」里给这台设备补一个 token（宿主侧会自动兑换会话）。",
		`- 远端配了 trustedHosts 时：本插件已把 Host/Origin 改写成 ${plainValue(device.authority)}。`,
		"",
		"注意：本插件只回纯文本，不产生 HTML。窗口里的界面始终是本机那份页面。",
		"",
	];
	writeText(res, status, lines.join("\n"));
}

/**
 * I1 的拦截出口：上游 HTML 不透传，改成 404 + 一小段纯文本说明，并写日志。
 * （把远端 HTML 交给窗口就是 0.1.0 崩溃的根因。）
 */
function blockHtmlResponse(device, runtime, upstreamRes, res, requestUrl, contentType, sniffed) {
	const detail = sniffed
		? "响应体开头看起来是 HTML（content-type 缺失或被伪装）"
		: `content-type: ${contentType}`;
	warn(runtime.ctx, `拦截 HTML 响应（I1）：设备 "${device.id}" 的 ${requestUrl} 返回 ${detail}，已丢弃并改为 404 纯文本`);
	upstreamRes.destroy();
	writeText(res, 404, [
		"dsh-remote：已拦截一个 HTML 响应（I1 铁律：绝不把 HTML 返回给窗口）。",
		"",
		`设备：${plainValue(device.name)} (${plainValue(device.id)})`,
		`请求：${plainValue(requestUrl)}`,
		`上游：${plainValue(`${device.origin}${device.basePath}`)}`,
		`判定：${plainValue(detail)}`,
		"",
		"为什么拦：窗口里的 HTML 必须是本机那份原装页面。桌面壳会把自家注入的 boot 行",
		"（__DSH_BOOT_READY__、client-modules 的模块预加载行）与窗口文档配对校验；",
		"把远端 HTML 送进窗口会让壳判定 boot 失败，日志形如：",
		"  client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js",
		"然后弹恢复窗并把这次启动记为崩溃。",
		"",
		"怎么办：让窗口停在本机页面，用侧栏那一行「设备 · …」（或它弹出的浮层菜单）切换。本插件的垫片会把",
		"api/ 请求与 mux 长连接改道到 /dev/ 前缀下的那台设备路径，界面代码仍然是本机的。",
		"",
	].join("\n"));
}

//#endregion

//#region 头改写

/**
 * 把远端的 `Location` 拉回 `/dev/<id>/` 下：
 * 根相对（`/x`）→ `前缀 + /x`；绝对且指向本设备 → 换成前缀；`./` 之类保持原样。
 */
function rewriteLocation(location, device, prefix) {
	if (typeof location !== "string" || location === "") return location;
	if (location.startsWith(`${ROUTE_ROOT}`)) return location;
	if (location.startsWith("/")) return `${prefix}${location}`;
	if (location === device.origin) return `${prefix}/`;
	if (location.startsWith(`${device.origin}/`)) return `${prefix}${location.slice(device.origin.length)}`;
	return location;
}

/**
 * 把远端 `Set-Cookie` 的 `Path` 收到代理前缀下：桌面窗口本来就会丢掉 set-cookie，
 * 而真实浏览器里这样能让远端的会话 cookie 只发给本插件的代理路径。
 */
function rewriteSetCookie(value, prefix) {
	const parts = String(value).split(";");
	const output = [];
	let hasPath = false;
	for (const part of parts) {
		if (/^\s*path\s*=/iu.test(part)) {
			hasPath = true;
			output.push(` Path=${prefix}/`);
			continue;
		}
		if (/^\s*domain\s*=/iu.test(part)) continue; // 带 Domain 会让浏览器拒收（名字按 authority 派生）
		output.push(part);
	}
	if (!hasPath) output.push(` Path=${prefix}/`);
	return output.join(";").replace(/^;\s*/u, "");
}

/** 从请求头里挑出要转发给远端的头（其余一律不传）。 */
function forwardableRequestHeaders(req) {
	const output = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (DROP_REQUEST_HEADERS.has(lower)) continue;
		if (lower.startsWith("sec-fetch-") || lower.startsWith("x-forwarded-") || lower.startsWith("proxy-")) continue;
		output[lower] = value;
	}
	return output;
}

/** 组装回给客户端的响应头（丢逐跳头、改 Location 与 Set-Cookie）。 */
function responseHeadersFor(upstreamRes, device, prefix) {
	const headers = {};
	for (const [key, value] of Object.entries(upstreamRes.headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (DROP_RESPONSE_HEADERS.has(lower)) continue;
		if (lower === "set-cookie") {
			headers[lower] = (Array.isArray(value) ? value : [value]).map((item) => rewriteSetCookie(item, prefix));
			continue;
		}
		headers[lower] = value;
	}
	if (typeof headers.location === "string") headers.location = rewriteLocation(headers.location, device, prefix);
	return headers;
}

//#endregion

//#region HTTP 反向代理

/**
 * 建一条到设备的上游请求。回调里拿到的是**未缓冲**的响应对象。
 * @returns 上游 ClientRequest。
 */
function openUpstream(device, url, req, headers, body) {
	const send = device.protocol === "https:" ? httpsRequest : httpRequest;
	const finalHeaders = { ...headers };
	if (body !== undefined) {
		// 桥接改写过的请求体：长度已知，去掉分块传输头，由调用方一次性 end(body)。
		finalHeaders["content-length"] = String(body.length);
		delete finalHeaders["transfer-encoding"];
	}
	return send({
		protocol: url.protocol,
		hostname: device.hostname,
		port: device.port === "" ? undefined : device.port,
		path: `${url.pathname}${url.search}`,
		method: req.method,
		headers: finalHeaders,
	});
}

/**
 * 处理一次 `/dev/<id>/…` 请求。
 * 关键点：非 HTML 一律逐块 `res.write`，绝不攒完再发（SSE / 长响应必须能流过去）；
 * HTML 一律不透传（I1）。
 */
function handleHttpProxy(device, prefix, runtime, req, res) {
	const rawUrl = typeof req.url === "string" && req.url !== "" ? req.url : "/";
	let parsed;
	try {
		parsed = new URL(rawUrl, "http://local.invalid");
	} catch {
		writeText(res, 400, "dsh-remote：本机侧请求路径无法解析。\n");
		return;
	}
	const rest = parsed.pathname.slice(prefix.length);
	if (rest === "") {
		// `/dev/<id>` 没有尾斜杠：补一个（客户端/缓存里可能存了这个地址）。
		try {
			res.writeHead(302, { location: `${prefix}/${parsed.search}`, "cache-control": "no-store" });
			res.end();
		} catch {
			res.destroy();
		}
		return;
	}
	if (!rest.startsWith("/")) {
		writeText(res, 400, "dsh-remote：本机侧请求路径越过了设备前缀。\n");
		return;
	}
	// ① **可信请求判定**（与「另存为」同一把尺子，见 authorizeTrustedRequest）：挡住本机任意网页
	//    借这条代理去打对面那台 DSH（跨站 / DNS rebinding / 本地恶意页面）—— 以前只有"另存为"这一条
	//    路由有这道判定，代理这一条没有，是审查里唯一的高危缺口。
	//    合法路径都过得去：本机页面（Host=回环、Origin 同源、带会话 cookie）、经对外入口进来的浏览器
	//    （入口把 Host 改写成回环 authority）、桌面壳窗口（同上）。这条代理只放行 api/mux（HTML 由 I1 拦），
	//    所以它的调用方永远是"本机那份原装页面"，判定不会误伤。
	const trusted = authorizeTrustedRequest(runtime, req, "设备代理");
	if (trusted.ok !== true) {
		writeText(res, trusted.status, `dsh-remote：${trusted.reason}\n`);
		return;
	}
	// ② 路径安全性：这里**不需要**再做 `..` / 反斜杠的规范化 —— `rest` 取自 `parsed.pathname`，
	//    而 `parsed` 是用 `new URL(rawUrl, base)` 解析出来的：WHATWG URL 会把 `..` 坍缩、把 `\` 当 `/`，
	//    所以带 `..` 的请求行在**解析阶段**就已经变了形，根本匹配不到 `/dev/<id>/` 这个前缀；
	//    也就是说 `rest` 里不可能出现 `..`。审查里提的"拼接可穿越"这条在实现上不成立，
	//    保留这段注释是为了将来改这里时别重新引入。
	// ③ **已知不可达 ⇒ 快失败**（2026-10-17 第二刀）：账本刚判过这台不可达（距今 < REACH_FRESH_MS）
	//    ⇒ **一条上游连接都不发**，直接 502 纯文本（I1 照旧：不吐 HTML）。放在这里（而不是
	//    `proceed()` 里）是为了把 token 兑换 / 请求体桥接那几步也一起省掉 —— 页面白屏时每条 /api
	//    都走这条路，省一步是一步。顺手探一次这台设备（同一台只在途一次），它一恢复马上可用。
	//    注意顺序：**可信判定之后**才谈快失败，别的页面借这条代理打过来仍然是 403。
	if (recentlyUnreachable(runtime, device) === true) {
		triggerReachProbe(runtime, device);
		warn(runtime.ctx, `设备 "${device.id}" 刚判过不可达 ⇒ 不发起上游连接，直接回 502（${rest}）`);
		writeDeviceNotice(res, device, unreachableProxyReason(runtime, device), 502);
		return;
	}

	/** 桥接改写过的请求体（undefined = 原样管道转发）。 */
	let bridgedBody;
	const proceed = () => {
		let target;
		try {
			target = new URL(`${device.origin}${device.basePath}${rest}`);
		} catch {
			markReach(runtime, device.id, false, "无法构成远端地址");
			writeDeviceNotice(res, device, `无法构成远端地址（${device.origin}${device.basePath}${rest}）`, 500);
			return;
		}
		for (const [key, value] of parsed.searchParams) target.searchParams.append(key, value);

		/**
		 * 0.13.1：401/403 时**丢掉会话、用 token 重兑一次、重试一次**。
		 * 0.13.2：判断"请求体还在我们手里"要更细 ——
		 *  - 没有体（GET/HEAD/OPTIONS、content-length: 0）⇒ 可以像以前一样重试；
		 *  - 有体且已缓冲（桥接改写 / 预读进来）且 ≤ REPLAY_MAX_BODY_BYTES ⇒ 重放这份 Buffer；
		 *  - 有体但太大 / 长度未知（流式）⇒ **只发一次**，401/403 时把原因写进设备状态（见下）。
		 */
		const canRetry = bridgedBody !== undefined
			? bridgedBody.length <= REPLAY_MAX_BODY_BYTES
			: requestHasBody(req) !== true;
		const bodyUnreplayable = (bridgedBody !== undefined || requestHasBody(req)) && canRetry !== true;
		let attempt = 0;

		const forward = () => {
			const headers = forwardableRequestHeaders(req);
			headers.host = device.authority;
			headers.origin = device.origin;
			headers["user-agent"] = USER_AGENT;
			// 0.28.0：跨机身份头（hostname 每次带；密钥只在还没配对成功时带一次）。
			Object.assign(headers, peerHeaders(runtime, device));

			let upstream;
			try {
				upstream = openUpstream(device, target, req, headers, bridgedBody);
			} catch (error) {
				markReach(runtime, device.id, false, messageOf(error));
				writeDeviceNotice(res, device, `建立上游请求失败：${messageOf(error)}`, 502);
				return;
			}

			/** 这一次上游是否已经给出结果（响应或错误）；重试时把它置 true，旧连接的迟到事件一律忽略。 */
			let responded = false;
			// `responseTimer` = "多久没拿到响应头"（老行为，15 秒兜底）。**它不是建连超时**，
			// 所以对端关机时它救不了场（Windows 的 TCP 建连本身就要 15–21 秒才失败）。
			const responseTimer = setTimeout(() => {
				upstream.destroy(new Error(`连接超时（${String(CONNECT_TIMEOUT_MS)} ms 内没有响应）`));
			}, CONNECT_TIMEOUT_MS);
			unrefTimer(responseTimer);
			// **只覆盖建连阶段**的 3 秒兜底（2026-10-17 第二刀）：socket 一连上就清掉。
			// TLS 还要等握手完（`secureConnect`）才算"连上"——握手也可能挂住。
			// 清掉的时机决定了它**绝不会**变成整请求超时：连上之后的长传输 / SSE / mux 流一概不受影响。
			const connectTimer = setTimeout(() => {
				upstream.destroy(new Error(`建连超时（${String(proxyConnectTimeout(runtime))} ms 内没连上）`));
			}, proxyConnectTimeout(runtime));
			unrefTimer(connectTimer);
			const clearConnectTimer = () => clearTimeout(connectTimer);
			upstream.on("socket", (socket) => {
				try {
					// 复用（keep-alive）来的 socket 已经连好了 ⇒ 直接清；否则等它连上。
					if (socket !== null && socket !== undefined && socket.connecting === true) {
						socket.once(device.protocol === "https:" ? "secureConnect" : "connect", clearConnectTimer);
					} else {
						clearConnectTimer();
					}
				} catch {
					clearConnectTimer();
				}
			});
			upstream.on("response", (upstreamRes) => {
				clearTimeout(responseTimer);
				clearConnectTimer();
				const status = upstreamRes.statusCode ?? 0;
				const authRejected = status === 401 || status === 403;
				if (authRejected && attempt === 0 && canRetry === true) {
					responded = true;
					attempt += 1;
					// 0.28.0：被拒 ⇒ 清掉"已配对"标记，下一次带上密钥重新配对（只重试一次）。
					upstreamRes.resume();
					unmarkPaired(runtime, device);
					setTimeout(() => {
						if (!res.destroyed && res.writableEnded !== true) forward();
					}, 300);
					return;
				}
				responded = true;
				markReach(runtime, device.id, true, null);
				if (authRejected !== true) markPaired(runtime, device);
				if (authRejected) {
					// 0.13.2：体太大/流式 ⇒ 不重放，但必须**说清楚**（以前是静默的 401）。
					noteAuthRejected(runtime, device, status, bodyUnreplayable === true ? REPLAY_TOO_LARGE_MESSAGE : undefined);
				} else clearAuthNotice(runtime, device.id);
				relayResponse(device, prefix, runtime, upstreamRes, res, parsed.pathname);
			});
			upstream.on("error", (error) => {
				clearTimeout(responseTimer);
				clearConnectTimer();
				if (responded) {
					if (!res.writableEnded) res.destroy();
					return;
				}
				responded = true;
				const message = messageOf(error);
				markReach(runtime, device.id, false, message);
				warn(runtime.ctx, `设备 "${device.id}" 转发失败：${message}`);
				writeDeviceNotice(res, device, message, 502);
			});

			// 请求体（POST/PUT）：没桥接就管道转发；桥接过就把改写后的体一次性写过去。
			res.on("close", () => {
				if (!res.writableEnded) upstream.destroy();
			});
			req.on("error", () => {
				upstream.destroy();
			});
			if (bridgedBody !== undefined) upstream.end(bridgedBody);
			else if (attempt > 0) {
				// 走到这里的重试只剩"没有体"的请求（GET/HEAD/OPTIONS 或 content-length: 0）：
				// 原始 req 早已 end，再 pipe 一次不会再触发 end，必须显式结束这一发上游请求。
				req.resume();
				upstream.end();
			} else req.pipe(upstream);
		};
		forward();
	};

	// 配了 token 且还没有会话：宿主侧先兑换一次（桌面窗口拿不到 set-cookie，必须由宿主代持）。
	const start = () => {
		bridgePromptBody(device, runtime, req, rest).then((body) => {
			if (body === null) {
				// 超过桥接上限：明确报错，不转发半个请求体（宁可不搬，也不发出坏请求）
				writeText(res, 413, `dsh-remote：这条请求的体超过 ${String(BRIDGE_MAX_BODY_BYTES)} 字节，跨机搬运不处理它。\n`);
				return;
			}
			bridgedBody = body;
			// 0.13.2：**小 body 先缓冲到内存**，这样 401/403 才能原样重放一次。
			// 只信 content-length：声明 ≤ 上限才读（长度未知的流式体一律不碰，保持单次发送）。
			if (bridgedBody === undefined) {
				const length = declaredBodyLength(req);
				if (requestHasBody(req) === true && length !== null && length > 0 && length <= REPLAY_MAX_BODY_BYTES) {
					readReplayBody(req).then((buffered) => {
						if (buffered === null) {
							// 客户端谎报 content-length（实际超过上限）：流已经读走，没法再"原样转发"了。
							warn(runtime.ctx, `设备 "${device.id}"：请求体实际超过 ${String(REPLAY_MAX_BODY_BYTES)} 字节（content-length 声明 ${String(length)}），无法缓冲重放，已拒绝。`);
							writeText(res, 413, `dsh-remote：这条请求的体超过 ${String(REPLAY_MAX_BODY_BYTES)} 字节（与 content-length 声明不一致），无法缓冲重放。\n`);
							return;
						}
						bridgedBody = buffered;
						proceed();
					});
					return;
				}
			}
			proceed();
		}, (error) => {
			// 桥接自身出错绝不挡路：照原样转发（失败只记日志）
			warn(runtime.ctx, `跨机搬运自身出错，按原样转发：${messageOf(error)}`);
			proceed();
		});
	};
	start();
}

/**
 * 把上游响应回给客户端。
 * - `content-type` 是 HTML → I1：丢弃 + 404 纯文本（并写日志），一个字节都不透传。
 * - 否则流式透传，但**第一块**会先做一次"看起来是不是 HTML"的嗅探（最多攒 4 KB）。
 */
function relayResponse(device, prefix, runtime, upstreamRes, res, requestPath) {
	const status = upstreamRes.statusCode ?? 502;
	const headers = responseHeadersFor(upstreamRes, device, prefix);

	const contentType = String(upstreamRes.headers["content-type"] ?? "");
	if (isHtmlContentType(contentType)) {
		blockHtmlResponse(device, runtime, upstreamRes, res, requestPath, contentType, false);
		return;
	}

	let decided = false;
	const pending = [];
	let pendingBytes = 0;

	const writeChunk = (chunk) => {
		if (res.destroyed) return;
		if (res.write(chunk)) return;
		upstreamRes.pause();
		res.once("drain", () => upstreamRes.resume());
	};
	const flushPending = () => {
		for (const chunk of pending) writeChunk(chunk);
		pending.length = 0;
		pendingBytes = 0;
	};
	const commit = () => {
		if (res.destroyed) return false;
		try {
			res.writeHead(status, headers);
		} catch {
			upstreamRes.destroy();
			res.destroy();
			return false;
		}
		return true;
	};

	upstreamRes.on("data", (chunk) => {
		if (res.destroyed) {
			upstreamRes.destroy();
			return;
		}
		if (decided) {
			writeChunk(chunk);
			return;
		}
		pending.push(chunk);
		pendingBytes += chunk.length;
		// 嗅探窗口取**已缓存的前 SNIFF_LIMIT_BYTES 字节**（不是固定 64 字节）：
		// `classifyBodyPrefix` 会在窗口内剥掉前导空白，窗口太小的话，远端只要用空白把窗口填满，
		// 真正的 HTML 就落在窗口外、判定退化成 `maybe`（报告里的 I1 绕过）。
		const prefixBytes = Buffer.concat(pending, pendingBytes).subarray(0, Math.min(pendingBytes, SNIFF_LIMIT_BYTES));
		const verdict = classifyBodyPrefix(prefixBytes);
		if (verdict === "maybe" && pendingBytes < SNIFF_LIMIT_BYTES) return;
		// "html" = 确定是 HTML；"maybe"（已到上限仍无法排除，例如整段都是空白）= **fail closed**，
		// 宁可当 HTML 拦掉，也不把无法判定内容原样透传给窗口。
		if (verdict !== "no") {
			decided = true;
			pending.length = 0;
			pendingBytes = 0;
			blockHtmlResponse(device, runtime, upstreamRes, res, requestPath, contentType, true);
			return;
		}
		decided = true;
		if (!commit()) return;
		flushPending();
	});
	upstreamRes.on("end", () => {
		if (res.destroyed) return;
		if (!decided) {
			// **最终嗅探**：拿完整缓存（≤ 上限）再判一次 —— 短响应体不会有下一次 data 事件，
			// 不在这里补判，前面"前置空白"那条路就会在 end 处被无条件放行。
			const verdict = classifyFinalBody(Buffer.concat(pending, pendingBytes).subarray(0, Math.min(pendingBytes, SNIFF_LIMIT_BYTES)));
			if (verdict !== "no") {
				decided = true;
				pending.length = 0;
				pendingBytes = 0;
				blockHtmlResponse(device, runtime, upstreamRes, res, requestPath, contentType, true);
				return;
			}
			decided = true;
			if (!commit()) return;
		}
		flushPending();
		res.end();
	});
	upstreamRes.on("error", () => {
		if (!res.headersSent) writeDeviceNotice(res, device, "读取上游响应失败", 502);
		else res.destroy();
	});
}

//#endregion

//#region WebSocket / upgrade 转发

/**
 * 处理 `/dev/<id><muxPath>` 的升级请求（`registerUpgrade` 是 exact 匹配，muxPath 是**动态发现**来的）。
 * 用 node:net 直连远端，自行拼一条改写过的握手请求行 + 头，然后双向管道透传帧。
 */
function handleUpgradeProxy(device, prefix, runtime, req, socket, head) {
	const rawUrl = typeof req.url === "string" && req.url !== "" ? req.url : "/";
	const parsed = new URL(rawUrl, "http://local.invalid");
	const rest = parsed.pathname.slice(prefix.length);
	if (!rest.startsWith("/")) {
		socket.destroy();
		return;
	}
	const path = `${device.basePath}${rest}${parsed.search}`;

	// **已知不可达 ⇒ 快失败**（2026-10-17 第二刀，与 HTTP 那条同一个判据）：账本刚判过这台
	// 不可达 ⇒ **不发起上游连接**，直接**优雅 destroy**（升级握手还没开始，一个字节都不回；
	// 也绝不给客户端吐 HTML）。顺手探一次这台设备，它一恢复马上可用。
	if (recentlyUnreachable(runtime, device) === true) {
		triggerReachProbe(runtime, device);
		warn(runtime.ctx, `设备 "${device.id}" 刚判过不可达 ⇒ 升级请求直接关闭（不发上游连接）`);
		socket.destroy();
		return;
	}

	/**
	 * 0.13.1：401/403 时**先别把上游响应转给客户端**，攒到响应头再判：
	 * 401/403 ⇒ 丢掉旧会话、用 token 重兑一次、重连一次；其它状态照旧透传。
	 */
	const proceed = (attempt = 0) => {
		if (socket.destroyed === true) return;
		let upstream;
		try {
			upstream = device.protocol === "https:"
				? tlsConnect({
					host: device.hostname,
					port: device.port === "" ? 443 : Number(device.port),
					servername: device.hostname,
				})
				: netConnect({
					host: device.hostname,
					port: device.port === "" ? 80 : Number(device.port),
				});
		} catch (error) {
			markReach(runtime, device.id, false, messageOf(error));
			rejectUpgrade(socket, `建立上游连接失败：${messageOf(error)}`);
			return;
		}

		let sawUpstreamBytes = false;
		let failed = false;
		/** 正在为 401/403 重连：旧连接的 close 绝不能再把客户端 socket 关掉。 */
		let retrying = false;
		// **只覆盖建连阶段**的 3 秒兜底（2026-10-17 第二刀）：`connect` / `secureConnect` 一到就
		// 在下面那个 readyEvent 回调里清掉 —— mux 是长连接，这里绝不能变成一个整连接超时。
		const connectTimer = setTimeout(() => {
			failed = true;
			markReach(runtime, device.id, false, `建连超时（${String(proxyConnectTimeout(runtime))} ms）`);
			rejectUpgrade(socket, `建连超时（${String(proxyConnectTimeout(runtime))} ms）`);
			upstream.destroy();
		}, proxyConnectTimeout(runtime));
		unrefTimer(connectTimer);
		const clearConnectTimer = () => clearTimeout(connectTimer);

		upstream.on("data", () => {
			sawUpstreamBytes = true;
			markReach(runtime, device.id, true, null);
		});
		upstream.on("error", (error) => {
			clearConnectTimer();
			if (failed) return;
			failed = true;
			const message = messageOf(error);
			markReach(runtime, device.id, false, message);
			warn(runtime.ctx, `设备 "${device.id}" 的 WebSocket 转发失败：${message}`);
			if (sawUpstreamBytes) socket.destroy();
			else rejectUpgrade(socket, message);
		});
		upstream.on("close", () => {
			clearConnectTimer();
			if (retrying === true) return;
			socket.destroy();
		});
		socket.on("close", () => upstream.destroy());
		socket.on("error", () => upstream.destroy());

		// TLS 场景要等 secureConnect（握手完成）才能写 HTTP；明文用 connect。
		const readyEvent = device.protocol === "https:" ? "secureConnect" : "connect";
		upstream.on(readyEvent, () => {
			// 建连阶段到此结束（TLS 连握手也算）：撤掉那 3 秒兜底。
			clearConnectTimer();
			// 握手请求行与头：路径去掉 /dev/<id> 前缀，Host/Origin 改写成远端自己的 authority。
			const lines = [
				`GET ${path} HTTP/1.1`,
				`Host: ${device.authority}`,
				`Origin: ${device.origin}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
			];
			const passthrough = [
				["sec-websocket-key", "Sec-WebSocket-Key"],
				["sec-websocket-version", "Sec-WebSocket-Version"],
				["sec-websocket-protocol", "Sec-WebSocket-Protocol"],
				["sec-websocket-extensions", "Sec-WebSocket-Extensions"],
				["accept-language", "Accept-Language"],
			];
			for (const [lower, headerName] of passthrough) {
				const value = req.headers[lower];
				if (typeof value === "string" && value !== "") lines.push(`${headerName}: ${value}`);
			}
			const peer = peerHeaders(runtime, device);
			for (const [name, value] of Object.entries(peer)) lines.push(`${name}: ${value}`);
			lines.push(`User-Agent: ${USER_AGENT}`);
			try {
				upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head !== undefined && head.length > 0) upstream.write(head);
			} catch (error) {
				failed = true;
				clearTimeout(connectTimer);
				rejectUpgrade(socket, messageOf(error));
				upstream.destroy();
				return;
			}
			/** 还没有转发给客户端的初始响应字节（最多攒到 `\r\n\r\n` 或 8 KB）。 */
			const received = [];
			const onFirst = (chunk) => {
				received.push(chunk);
				const text = Buffer.concat(received).toString("latin1");
				if (!text.includes("\r\n\r\n") && text.length < 8192) {
					upstream.once("data", onFirst);
					return;
				}
				const match = /^HTTP\/1\.[01] (\d{3})/u.exec(text);
				const status = match === null ? 0 : Number(match[1]);
				const authRejected = status === 401 || status === 403;
				if (authRejected && attempt === 0) {
					retrying = true;
					failed = true;
					unmarkPaired(runtime, device);
					try {
						upstream.destroy();
					} catch {
						/* 已断 */
					}
					proceed(1);
					return;
				}
				if (authRejected) noteAuthRejected(runtime, device, status);
				else {
					markPaired(runtime, device);
					clearAuthNotice(runtime, device.id);
				}
				socket.setNoDelay(true);
				upstream.setNoDelay(true);
				try {
					socket.write(Buffer.concat(received));
				} catch {
					upstream.destroy();
					socket.destroy();
					return;
				}
				upstream.pipe(socket);
				socket.pipe(upstream);
			};
			upstream.once("data", onFirst);
		});
	};

	proceed(0);
}

/** 升级还没成功时，用一条正经的 HTTP 响应告诉客户端"这台设备连不上"（纯文本）。 */
function rejectUpgrade(socket, reason) {
	if (socket.destroyed) return;
	const text = `dsh-remote: ${reason}\n`;
	try {
		socket.end([
			"HTTP/1.1 502 Bad Gateway",
			"Connection: close",
			"Content-Type: text/plain; charset=utf-8",
			`Content-Length: ${String(Buffer.byteLength(text))}`,
			"",
			text,
		].join("\r\n"));
	} catch {
		socket.destroy();
	}
}

//#endregion

/**
 * `end` 处的**最终判定**（I1 修复的一部分）：
 * - `no` → 放行；
 * - `html` → 拦；
 * - `maybe`：只有"**空体或纯空白**"才放行（没有内容可渲染），其余（前缀 + 更多空白）一律拦。
 *   注意必须把"空体"放行 —— 很多 POST 成功后就返回空响应体（附件上传、状态更新…），
 *   早期版本把空体当 `maybe` 拦掉，会把这类请求打成失败。
 */
function classifyFinalBody(buffer) {
	const verdict = classifyBodyPrefix(buffer);
	if (verdict !== "maybe") return verdict;
	const text = buffer.toString("latin1").replace(/^\uFEFF/u, "").replace(/^[\s\u0000]+/u, "");
	return text === "" ? "no" : "maybe";
}

export {
	blockHtmlResponse,
	classifyFinalBody,
	forwardableRequestHeaders,
	handleHttpProxy,
	handleUpgradeProxy,
	openUpstream,
	relayResponse,
	rejectUpgrade,
	responseHeadersFor,
	rewriteLocation,
	rewriteSetCookie,
	writeDeviceNotice,
	writeJson,
	writeText,
};
