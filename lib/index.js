/**
 * @local/dsh-remote —— 宿主半（= @local/dsh-device-switch 0.2.x 的全部行为
 * ＋ @local/dsh-token-copy 0.1.x 的"带 token 访问地址"能力 ＋ 三样新能力）。
 *
 * ## 1. 界面用本机的，流量改道到远端
 *
 * 0.1.0 的 device-switch 把远端首页 HTML 整个反代进窗口，导致桌面壳判定 boot 失败并
 * 弹恢复窗（`client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js`）。
 * 所以本插件只做一件事：**窗口里的页面永远由壳自己服务**，插件只追加一条自包含的垫片脚本，
 * 把 `api/` 请求与 `/api/remote.mux` 长连接改写到 `/dev/<id>/…`，由本插件反向代理到远端。
 *
 * ## 2. 两条铁律（selftest 逐条断言，语义与 device-switch 0.2 完全一致）
 *
 * - **I1：绝不把 `text/html` 返回给窗口。** 上游响应只要 `content-type` 是 HTML，
 *   或响应体开头看起来是 HTML（最多先攒 4 KB 判定），一律不透传：丢弃并回 404 + 纯文本说明。
 *   本插件**自己产生的所有响应**也一律 `text/plain` 或 `application/json` + `nosniff`
 *   （新增的 `/plugin/remote/*` 全部接口同样适用；selftest 对每条接口都断言"不是 text/html"）。
 * - **I2：绝不改动本机页面的 HTML。** 只有两条注入通道，且都是**纯追加**：
 *   `ctx.on("webserver/index-inject")` 推一行 `{kind:"script",placement:"head",text}`
 *   （桌面壳走这条）与 `ctx.webServer.tapIndex()` 在 `<head>` 后插入同一条脚本（浏览器走这条）。
 *
 * ## 3. 本版新增（相对 device-switch 0.2.1）
 *
 * 1. **设备存在插件自己的数据文件** `$DSH_HOME/remote-devices.json`
 *    （`{ enabled, devices: [{id,name,url}], current? }`），**不写 profile patch**。
 *    token 不存在这个文件里：优先存 DSH 凭据服务（`ctx.credentials`，每条设备一个 ref）。
 * 2. **`enabled` 是"软开关"，两个方向都不对称**：
 *    - `/dev/**` 代理路由**受 `enabled` 门控**：`false` 时一条都不注册（等同没装）。
 *    - 垫片脚本**永远注入**（不再受 `enabled` 门控）：注入的那份脚本自带"自检"——
 *      同步 patch 之后异步问一次 `GET /plugin/remote/state`，只有拿到明确的
 *      `enabled:false`（或 404 = 插件已被卸载）才自除：清 localStorage 的
 *      `dsh-device-switch:*` / `dsh-remote:*` → 撤掉发布的设备表 → 停掉可达性探测 → 还原被改写的原语
 *      → 带 `sessionStorage` 哨兵地刷新一次（哨兵保证最多刷一次，`enabled:true` 时清掉）。
 *      这样"停用"在没有重启 APP 的老窗口里也能立刻回到本机直连、垫片不插任何节点的干净状态。
 *      反过来，若本次是惰性的（payload 说停用、或哨兵在位）而自检发现宿主其实开着，
 *      就走**惰性自愈**：置 `force-active` 标记 + 清哨兵 + 刷新一次（见 4.1）。
 *    - 设置页接口（`state`/`urls`/…）**始终可读**，随时能改回 `true`。
 *    要**彻底**关停请卸载本插件（见 README「卸载 / 回退」）。
 * 3. **体检 / 状态**：`/plugin/remote/state` 给出本机认定依据、每台设备的最近一次代理结果、
 *    垫片是否报到过（`injectionSeen` / `lastHelloAt`）、以及 `REMOTE_STREAM_MUX_PATH`
 *    的**动态发现**结果。该路径不再硬编码（见 5）。
 * 4. **带 token 访问地址**（原 token-copy）：`/plugin/remote/urls`，仅回环可读。
 * 5. **访问配置可写（「配置」块）**：读活的 `webserver.host/port`、`connection.trustedHosts`、
 *    `connection.browserAuth.maxAgeMilliseconds`（换算成 `cookieMaxAgeDays`）用于展示与体检，
 *    并给出 `localAddresses`（回环 + 各网卡 IPv4，每条带当前端口）。
 *    `POST /plugin/remote/access`（**仅回环** + 受 `enabled` 门控）用**官方 `ctx.configEditor.edit`**
 *    写 profile patch：`host` 固定 `0.0.0.0`（界面不显示）、`port` 与 `trustedHosts` 由用户给。
 *    **整行 config 替换**语义 → 必须展开当前值再覆盖，保住 webserver 的 compression 三件套与
 *    connection 的 cookieMaxAgeDays（见 {@link applyAccessConfig}）。
 *    入口地址按官方 `assertTrustedAuthority` 的规范形式先校验（否则官方激活 connection 时会拒绝，
 *    而我们绝不手改 YAML、也绝不写入一个会让那行起不来的值）。
 * 6. **两条新能力（本版追加，都受 `enabled` 门控）**：
 *    - `GET /plugin/remote/download?device=&path=&session=`：把文件字节**分块流式**交给浏览器，
 *      按 `Content-Disposition: attachment`（RFC 5987 处理中文名）存进「下载」文件夹。
 *      地址上的 `device` 是**可选**的"设备切换键"（客户端半从 localStorage 读，空就不带）：
 *        · **空 → 本机文件**。模型只有一句："页面由哪台机器提供，文件就在哪台机器上"。
 *          于是"坐在家里用浏览器打开设备A的 DSH 页面、点另存为"读的就是**设备A自己的**文件 ——
 *          用那台机器上官方的 `workspaceFiles` 服务（`typert.lookups` 的 `workspaceFileScope`
 *          解析 session → 服务自己的四道闸门）按会话授权读，与下面那条代理路线**同一个服务**。
 *        · **有值 → 那台设备**：经目标机的 Remote RPC（`workspaceFiles/stat` +
 *          `workspaceFiles/readBytes`，一窗口一次请求）代理回来（桌面 App 切到远端时用）。
 *      **鉴权**：用官方的"可信请求"判定 —— `ctx.connection.requestRejection(request)`
 *      （见 {@link authorizeTrustedRequest} 与 README「另存为」），**不是**"仅回环"：
 *      "浏览器打开另一台机器的 DSH 页面"时请求天然不来自回环，旧的仅回环守卫必然 403，
 *      功能等于废掉。官方那套判定同时覆盖 DNS rebinding（Host/Origin 栅栏）与会话认证
 *      （`dsh-auth-*` cookie），**本插件不自己发明鉴权**；
 *    - `POST /plugin/remote/fork`：读**本机**源会话尾页（进程内 `ctx.sessionController` 优先，
 *      退回本机 HTTP `/api/session/*`）→ 在目标机 `session/create`（**不传工作区、不传模型**）
 *      → `session/prompt`（`mode:"queue"`）把「仅文字」的上下文种子作为第一条消息发过去。
 *      不改本机会话、不切换设备；上下文会落到目标机的会话库里并留在那台机器上（见 README）。
 *      这条**仍然只认回环**（它是"写"操作，且只服务设置页/桌面 App）。
 *
 * ## 4. 垫片报到
 *
 * 垫片脚本加载后向本机 POST 一次 `/plugin/remote/hello`，宿主据此记 `injectionSeen` 与
 * `lastHelloAt` —— 这样"DSH 升级后注入失效"能被一眼看出来（体检页会红）。
 *
 * ## 4.1 垫片自检（"停用后老窗口里的胶囊立刻消失"）
 *
 * 垫片**不再**由宿主按 `enabled` 决定注入与否（桌面壳把注入行缓存到窗口生命周期，
 * 关停后老窗口里那行脚本还在）。改为：注入的脚本自己在**同步 patch 之后**（时序不许变，
 * 否则应用的首批请求会漏到本机）异步问一次 `/plugin/remote/state`：
 *
 *  - `enabled:false` 或 404 → 清存储 → 撤设备表 → 停探测 → 还原原语 → 带哨兵刷新一次；
 *  - `enabled:true` → 清掉哨兵，什么都不做；**但**若本次是惰性的（payload 说停用、
 *    或哨兵在位而错过挂载时机）→ 惰性自愈：置 `force-active`（下次加载忽略 payload/哨兵、
 *    走正常模式并删标记）+ 清哨兵 + 带防循环保护地刷新一次；
 *  - 请求失败 / 拿不到合法 JSON → 安静，什么都不做（绝不因为一次探测失败把页面弄坏）。
 *
 * ## 4.2 "强制激活"标记（`sessionStorage["dsh-remote:force-active"]`）
 *
 * 关停时哨兵被写下，于是**重新开启后的第一次加载**垫片会惰性返回 —— 那一次刷新就白刷了
 * （用户得再点一次「重载窗口」）。修法两条，都用同一个键：
 *  1. **设置页（客户端半）**：开启成功后、`reload()` 之前清哨兵 + 置这个标记 → 一次刷新胶囊就回来；
 *  2. **垫片惰性自愈**（4.1 那条）：兜住"桌面壳缓存住的旧注入行"。
 * 垫片在同步阶段读到标记就压倒一切（忽略 payload 与哨兵），用掉即删，所以最多强制激活一次。
 * `force-active` 写不进去（sessionStorage 不可用）时自愈**不刷新**，降级为手动重载。
 *
 * ## 5. `REMOTE_STREAM_MUX_PATH` 的动态提取（不硬编码）
 *
 * 提取顺序（详见 README「会话长连接路径的发现」）：
 *  1. 进程内 `ctx.webServer.collectIndexInjections()` 的行（`script-preload`/`script-src` 的
 *     `src`、`__DSH_BOOT__` 图里的 `plugins/??<id>/client.js&rev=…`）；
 *  2. 本机 `http://127.0.0.1:<port>/` 首页里出现的 `plugins/…` 资源地址（没有会话 cookie 时
 *     DSH 会 401，此时用 `ctx.connection.authenticatedUrl()` 换一次 cookie，token 只用一次、
 *     绝不落日志）；
 *  3. 逐个 `GET` 这些**本机 client bundle**，在文本里找 `REMOTE_STREAM_MUX_PATH = "…"`。
 * 全部失败 → `muxPathFound:false`、`/dev/<id>/<mux>` 升级路由**一条都不注册**、日志与体检页写明
 * "终端通道不可用（对话 / HTTP 代理仍然可用）"。这是刻意的：宁可少一条通道，也不猜错路径。
 *
 * ## 6. 切到一台关机的设备不再把用户关在门外（2026-10-17 真机复现的致死缺陷）
 *
 * 症状：那台机器关机时切过去 ⇒ 页面里所有 `/api` 被改写成 `/dev/<那台>/api/…` ⇒ 全部失败 ⇒
 * **App 壳渲染不出来（纯白屏 / 长时间"正在加载设置…"）**；而切设备的入口（客户端半注入的侧栏
 * 那一行 + `shell.overlay` 浮层）**长在 App 的 DOM 里** ⇒ 一个入口都没有，只能把那台机器开机。
 * 根因：去掉右下角胶囊时，把**唯一独立于 App DOM** 的逃生口一起拆了。
 *
 * 补丁（第一条在垫片里、不依赖 App 是否渲染；第二条在客户端半）：
 *  1. **同步自愈**：选中的 id **不在本机配置的设备表里**（脏 id / 从别的机器带过来的键）⇒
 *     清 `KEYS_CURRENT` + 刷新一次回本机（见 6.1）；
 *  2. **不可达即禁切**：客户端半的 `pickDevice()` 在目标设备"已知不可达"时**不切换**，
 *     只给一句"这台现在连不上（<lastError>），先不切"（见 6.5）。
 *
 * ### 6.1 自愈的防回环（硬要求，顺序不许换）
 *
 *  - 只在"当前选中的是**对端**（id 非空）"时动手；本机态（键为空）一个字节都不碰；
 *  - **只认同步判据**（选中的 id 在不在本机配置的设备表里）；配置表一台设备都没有 ⇒ "说不清" ⇒ 不动；
 *  - 一次页面生命周期内最多自动重置一次（`sessionStorage` 哨兵，复用 `reloadOnce()`）；
 *  - 冷却标记 `dsh-remote:auto-reset` 写进 **localStorage**（`{at,count}`）：跨 `location.reload()`
 *    存活，60 秒内不再自动重置；**写不进去就绝不重置**（宁可不救，也绝不做"刷新 → 又重置"的死循环，
 *    与 4.1 里 "`force-active` 写不进去就绝不刷新" 同一条道理）。
 *  - **可达性自愈（0.12.0 恢复，但只在"没有别的出口"的会话里开）**：当前选中的是**对端**，
 *    且连续 2 次聚合里那台 `reachable === false` ⇒ 同样走上面这套（清 `KEYS_CURRENT` + 冷却
 *    + 哨兵刷新）。判据取自 `GET /dsh-remote-view`（**非 `/plugin/` 前缀** ⇒ 能穿过 edge；
 *    `/plugin/remote/live` 在走 edge 的浏览器里永远 403）。
 *    **只在非回环且是 http(s) 的会话里生效**：桌面壳（`dsh-app://app/`）与本机浏览器
 *    （127.0.0.1 / localhost / ::1）**一律不动手** —— 用户明确不要"我自己切过去又被弹回来"。
 *  - **左上角那颗常驻「← 本机」按钮也已按用户要求整段删除**（第三刀）：真机白屏已从 15 秒降到
 *    2–3 秒、界面基本都会渲染出来，正常切换器就够用，那颗按钮多余且丑。
 *    ⇒ **垫片一个 DOM 节点都不插**（右下角那颗胶囊面板已整段删除，见 5.x）。
 *
 * ### 6.4 代理侧的"快失败"与"只覆盖建连阶段"的 3 秒兜底（2026-10-17 第二刀）
 *
 * 实测：页面**第一个**请求就是 `/dev/<id>/api/…`（由上面 `rewriteUrl()` 的 `/api` 改写产生），
 * 而对端关机时 Windows 的 TCP 建连要 **15–21 秒**才失败 ⇒ 壳一直不渲染（"白屏 15 秒"）。两条改动：
 *  1. **已知不可达 ⇒ 不发上游连接**：本机可达性账本（{@link markReach} / {@link probeDevice}
 *     维护的 `runtime.reach`）里这台设备 `reachable === false` 且判定时间距今 <
 *     {@link REACH_FRESH_MS}（= `LIVE_POLL_MS` 的 2 倍，约 4 秒）⇒ 直接按"设备不可达"回 502
 *     纯文本（upgrade 直接优雅 destroy），**一条上游连接都不发**；同时顺手探一次这台设备
 *     （同一台只在途一次，见 {@link triggerReachProbe}），它一恢复马上可用。
 *  2. **建连超时 3 秒**（{@link PROXY_CONNECT_TIMEOUT_MS}）：HTTP 与 upgrade 两条路都给上游加一个
 *     **只覆盖建连阶段**的定时器 —— socket 建好（TLS 还要握手完）就清掉，**绝不是**整请求超时
 *     （长请求 / 上传下载 / SSE 与 mux 流都不受影响）。
 * "任何 HTTP 响应都算可达"的 live 口径、以及 edge 黑名单与改写逻辑，这两条都不动。
 *
 * ### 6.5 不可达即禁切（客户端半）
 *
 * `pickDevice()` 用**已经在轮询的**聚合快照（`/plugin/remote/live`，浏览器里退回
 * `/dsh-remote-view`）判断：目标设备 `reachable === false` ⇒ **不切换**（不写 localStorage 键、
 * 不刷新、也不清那台的未读），只用既有的提示机制给一句
 * `这台现在连不上（<lastError>），先不切：<设备名>`；浮层里那一行同时**灰化 + title 写原因**。
 * **没有那条数据时绝不拦**（未知 ≠ 不可达），所以"一台设备都没探过"的常规路径完全不受影响。
 *
 * 只使用 node: 内置模块，零第三方依赖。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, networkInterfaces as osNetworkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-remote";
export const inject = ["webServer", "connection"];

/** 插件版本（selftest 会拿它与 package.json 对账，防止两处漂移）。 */
const VERSION = "0.21.0";

/** 模块一加载就写一行（连"插件加载了但 apply 失败"都能在日志里看到）。 */
appendLog("info", "plugin", "module loaded", { version: VERSION });

/** 代理挂载点前缀：`/dev/<id>/…`（与 device-switch 一致，配置里的设备 id 直接可搬）。 */
const ROUTE_ROOT = "/dev/";

/** 设置页接口的挂载点（唯一一条 prefix 路由，内部按 pathname + method 分派）。 */
const PLUGIN_ROUTE = "/plugin/remote";

/** 垫片报到地址（垫片里也有一份同样的字面量，改这里要同步改 `remoteShim`）。 */
const HELLO_PATH = `${PLUGIN_ROUTE}/hello`;

/**
 * 垫片自检查询的状态接口（GET，只读）。垫片里也有一份同样的字面量，
 * 改这里要同步改 `remoteShim` 的 `statePath` 缺省值。
 */
const STATE_PATH = `${PLUGIN_ROUTE}/state`;

/** 远端浏览器会话 cookie 前缀（`@deepseek-ai/dsh-client-connection` 的 COOKIE_PREFIX）。 */


/** 一键收集脚本的文件名（写到 $DSH_HOME，方便用户不用找 node_modules 深层路径）。 */
const COLLECT_SCRIPT_NAME = "dsh-remote-collect-logs.cmd";
/** 应急重置脚本：白屏/起不来时清掉卡住的 Local Storage 并重启 DSH。 */
const RESET_SCRIPT_NAME = "dsh-remote-reset.cmd";

/** 收集脚本在 $DSH_HOME 的路径。 */
function resolveCollectScriptFile() {
	return join(dshHome(), COLLECT_SCRIPT_NAME);
}

/** 应急重置脚本在 $DSH_HOME 的路径。 */
function resolveResetScriptFile() {
	return join(dshHome(), RESET_SCRIPT_NAME);
}

/** 把插件包里的 scripts/collect-logs.cmd 复制到 $DSH_HOME（插件加载时执行一次）。 */
function installCollectScript() {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(here, "..", "scripts", "collect-logs.cmd"), "utf8");
		writeFileSync(resolveCollectScriptFile(), source);
		const resetSource = readFileSync(join(here, "..", "scripts", "reset.cmd"), "utf8");
		writeFileSync(resolveResetScriptFile(), resetSource);
		appendLog("info", "log", "helper scripts ready", { collect: resolveCollectScriptFile(), reset: resolveResetScriptFile() });
	} catch (error) {
		appendLog("warn", "log", "collect script install failed", { error: messageOf(error) });
	}
}


/** 垫片脚本的唯一标记：两条注入通道靠它互相去重，也供 selftest 识别。 */
const SHIM_MARKER = "/* dsh-remote:shim */";
/**
 * 垫片**发布设备表**用的隐藏 JSON 节点 id（`<script type="application/json">`，不渲染、不占位）。
 * 客户端半按同一个 id 读（`lib/client.js` 的 `SHIM_DEVICES_NODE_ID`）；自测里有一条断言盯这个一致性。
 */
const SHIM_DEVICES_NODE_ID = "dsh-remote-devices";
/**
 * 垫片读写 localStorage 用的键。**冻结**：`dsh-device-switch:*` 是 device-switch 0.2.x
 * 就在用的键，客户端半（设置页）也按它切换设备，且用户窗口里已有选择值 —— 改名会让
 * "当前设备"丢失，所以保留为主键；`dsh-remote:*` 作为别名同时读写，给将来留一条兼容路。
 */
const STORAGE_KEYS = {
	current: "dsh-device-switch:current",
	devices: "dsh-device-switch:devices",
	currentAlias: "dsh-remote:current",
	devicesAlias: "dsh-remote:devices",
};

/**
 * 垫片自检的**防循环哨兵**键（sessionStorage，每个窗口一个）。
 * 语义：值非空 = "这个窗口已经因为停用刷过一次了"。垫片在**同步阶段**读到它就直接当没装
 * （不 patch、不挂胶囊，也不刷新）；自检拿到 `enabled:true` 时把它清掉，于是下次关停仍能刷一次。
 * 键名与垫片里的缺省值必须一致（selftest 断言）。
 */
const SHIM_SELFTEST_SENTINEL_KEY = "dsh-remote:soft-off";

/**
 * 垫片的**"强制激活"标记**键（sessionStorage，每个窗口一个）。
 * 语义：非空 = "这次加载不要理会 payload 里的 `enabled` 与防循环哨兵，直接走正常模式
 * （同步 patch + 挂胶囊）"，用掉之后由垫片自己删掉。
 *
 * 两个写入方：
 *  1. 设置页（客户端半）开启插件成功后、`location.reload()` 之前 —— 这样"关停 → 再开启"
 *     **一次刷新**胶囊就回来（哨兵同时被清掉，见下）；
 *  2. 垫片自检的**惰性自愈** —— 本次因为 payload/哨兵而没挂载、但宿主其实 `enabled:true`
 *     时写下它并刷一次，兜住"老窗口里缓存住的注入行"。
 *
 * 键名与客户端半的 `FORCE_ACTIVE_KEY` 必须一致（selftest 断言）。
 */
const SHIM_FORCE_ACTIVE_KEY = "dsh-remote:force-active";

/** 连接（拿到响应头 / 首个字节之前）的超时；流式响应本身不设总超时。 */
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * 代理的**建连超时**（2026-10-17 第二刀）：只覆盖"把 socket 连上对端"这一段，连上就清掉。
 *
 * 为什么必须有：对端**关机**时 Windows 的 TCP 建连要 **15–21 秒**才失败，而页面**第一个**
 * 请求就是 `/dev/<id>/api/…`（垫片把 `/api` 改写过去的）⇒ 壳一直不渲染 = 用户实测的"白屏 15 秒"。
 * 为什么是"只覆盖建连阶段"：一旦连上，长请求 / 上传下载 / SSE 与 mux 流都可能传很久，
 * 绝不能变成一个整请求超时（那会把正常的慢请求弄坏）。
 */
const PROXY_CONNECT_TIMEOUT_MS = 3_000;
/** token 兑换失败后的冷却时间，避免不断打远端。 */
const AUTH_RETRY_MS = 30_000;
/** "这台设备没有 token"这个结论的缓存时间（用户刚补的 token 要尽快生效）。 */
const TOKEN_ABSENCE_TTL_MS = 10_000;
/** 种子 token 的落点判定窗口：这么久之内凭据服务还没出现，就按"不可用"处理并落盘。 */
const SEED_TOKEN_SETTLE_MS = 1_000;
/** 转发到本机自己的 UA（远端日志里能认出来）。 */
const USER_AGENT = "dsh-remote/0.3 (+local host plugin)";
/** 设置页接口请求体上限。 */
const MAX_JSON_BODY_BYTES = 64 * 1024;

// ---- 跨机实时状态（生产 + 聚合）：见 README「跨机实时状态」与句首 region ----

/**
 * 本机页面口：`GET /plugin/remote/live`（**回环守卫**，与 `/plugin/remote/state` 同一套）。
 * 聚合形状 `{ at, self:{name,live}, peers:[{id,name,reachable,lastError,live}] }`
 * （`self.name` = 本机被认领的那条设备的名字，空串 = 没认领到、客户端退回写死的「本机」）。
 */
const LIVE_PATH = `${PLUGIN_ROUTE}/live`;
/** 清「未读完成」的本机页面口：`POST /plugin/remote/live/seen` body `{id}`（空 = 本机）。 */
const LIVE_SEEN_PATH = `${LIVE_PATH}/seen`;

/**
 * **跨机取数口**：`GET /dsh-remote-live` 只回这台机器自己的 `{ at, live }`（不回聚合结果，避免递归）。
 *
 * 为什么**故意不用** `/plugin/` 前缀：前缀路由由本插件的 webserver 注册，对端那边"是不是这台
 * 机器"由本插件自己判定；但对端可能挂着「对外入口」（edge），而 edge 只拦
 * `EDGE_BLOCKED_PREFIXES = ["/plugin/"]`（见 edgeBlocks）—— 用 `/plugin/` 前缀会被对端 edge
 * 403 掉，跨机取数就永远拿不到。换一个非 `/plugin/` 的独立前缀既能穿过 edge，又不碰
 * `EDGE_BLOCKED_PREFIXES`/`prefixPath()`/`rewriteUrl()` 任何既有语义。
 *
 * 守卫仍是官方的"可信请求"判定（{@link authorizeTrustedRequest}）：Host 必须是回环或
 * `trustedHosts`、Origin 必须同源、且要带有效的 `dsh-auth-*` 会话 cookie。
 */
const PEER_LIVE_ROOT = "/dsh-remote-live";
/** 跨机取数口（GET，本机自己的状态）。 */
const PEER_LIVE_PATH = PEER_LIVE_ROOT;
/** 跨机清未读口（POST，本机自己的 unread）。 */
const PEER_LIVE_SEEN_PATH = `${PEER_LIVE_ROOT}/seen`;

/**
 * **浏览器口（0.12.0）**：`GET /dsh-remote-view` —— 给"经对外端口（edge）打开本机页面"的
 * 浏览器 / 手机用的**聚合**，返回与 `/plugin/remote/live` **同形**的那份 `{at, self, peers}`，
 * 只多一个 `version` 字段（本机 dsh-remote 的版本号，客户端半拿它与自己的版本常量对账）。
 *
 * 为什么必须新开一条：
 *  - edge 只拦 `EDGE_BLOCKED_PREFIXES = ["/plugin/"]`（见 {@link edgeBlocks}）⇒ 浏览器里的
 *    `/plugin/remote/live` 永远是 403，状态点一个都画不出来；
 *  - `/dsh-remote-live` 是**跨机取数口**（只回本机自己的 `{at, live}`，刻意不回聚合结果以免
 *    跨机递归），语义**不能动**。
 * 于是只加这一条**非 `/plugin/` 前缀**的路由，守卫仍用官方的"可信请求"判定
 * （{@link authorizeTrustedRequest}：Host 是回环或 `trustedHosts` + 同源 + 带 `dsh-auth-*` cookie），
 * 与「另存为」那条路由同一把尺子 —— 浏览器本来就带着那份 cookie。
 */
const VIEW_PATH = "/dsh-remote-view";

/** 对端轮询间隔（用户拍的：5 秒；本机状态与对端同一拍，并发取）。 */
const LIVE_POLL_MS = 2_000;
/**
 * **本机可达性账本的"新鲜度"窗口**（2026-10-17 第二刀）：只有"距今 < 这么久"的
 * `reachable === false` 才允许代理**快失败**（不发上游连接、直接 502）。
 *
 * 取 `LIVE_POLL_MS` 的 2 倍（≈4 秒）：账本由轮询与各条代理结果在维护，2 拍之内算"刚判过"，
 * 再久就可能已经过时（对端可能已经开机）——宁可按"不知道"去真连一次，也不拿着过期结论拦路。
 * 自测可用 `deps.reachFreshMs` 覆盖（把 4 秒缩成几十毫秒）。
 */
const REACH_FRESH_MS = LIVE_POLL_MS * 2;
/** 跨机取数的连接/首字节超时（本机每 2 秒问一次，必须**小于**轮询间隔，不能拖住下一轮）。 */
const PEER_LIVE_TIMEOUT_MS = 1_500;
/** 跨机取数最多读多少响应字节（只留一段 JSON 体；超了截断，绝不把大 HTML 读进内存）。 */
const PEER_LIVE_MAX_BYTES = 16 * 1024;
/** 本机未读完成（unread/doneAt）的落盘文件名：`$DSH_HOME/dsh-remote-live.json`。 */
const LIVE_FILE_NAME = "dsh-remote-live.json";
/**
 * 判"卡在等你回答/批准"时读会话尾页要几条事件（**只对 `running === true` 的会话读**）。
 * 12 条足够盖住真机上那三种卡片的尾巴（实测：提问卡尾条是那条没结算的 `ask_user_question`
 * 调用，审批卡尾条是 `approval/asked`），又不至于把开销做大。
 */
const LIVE_TAIL_N = 12;
/**
 * 会话尾页事件里，认定"这条会话在等用户"的那两个事件名。
 * **不是** `projections.values.userQuestions.active` —— 2026-10-17 真机实测：三张卡
 * （单选提问 / 多选提问 / 权限审批）同时开着，4 条 `running=true` 的会话里每一条的
 * `userQuestions.active` 都是 0（单独调 `session/projections` 实时值也还是 0）。
 */
const LIVE_ASK_TOOL = "ask_user_question";
/** 提问卡（单选/多选，以及计划批准用的也是这个工具）⇒ 一个**没有结算的** `tool/call`。 */
const LIVE_PENDING_EVENT = "tool/call";
/** 权限审批卡开始等 ⇒ `approval/asked`。 */
const LIVE_APPROVAL_ASKED = "approval/asked";
/** 权限审批卡结算 ⇒ `approval/decided`（名字取自官方的 `SessionEventMap`：`{ id, outcome }`）。 */
const LIVE_APPROVAL_DECIDED = "approval/decided";

/**
 * 「配置」块**固定**写入的绑定地址（界面不显示它）。
 * `@deepseek-ai/dsh-host-webserver` 的 Config 只接受 `127.0.0.1` 与 `0.0.0.0` 两个值。
 */
const BIND_HOST = "0.0.0.0";
/** profile patch 里「配置」块要写的那两行 Loader entry id（按 id 定位，绝不按行号）。 */
const WEBSERVER_ENTRY_ID = "webserver";
const CONNECTION_ENTRY_ID = "connection";
/** 入口地址条数上限（挡住"误粘贴一整个文件"这类手误）。 */
const MAX_TRUSTED_HOSTS = 200;
/** 「配置」块里的 cookie 天数上限（官方字段是自然数；给个像样的上限免得填出个天文数字）。 */
const MAX_COOKIE_AGE_DAYS = 36500;
/** 取本机首页 / client bundle 的超时。 */
const MUX_FETCH_TIMEOUT_MS = 8_000;
/** 单个候选 bundle 最多读多少字节（client bundle 是几百 KB 级，给足余量）。 */
const MUX_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
/** 一次发现里最多尝试几个候选地址。 */
const MUX_MAX_CANDIDATES = 12;
/** 启动时的发现重试节奏（毫秒，相对上一次尝试）。 */
const MUX_RETRY_DELAYS_MS = [0, 400, 1_200, 3_000, 8_000];
/** 发现彻底失败后，状态页每次来读最多每这么久再试一轮。 */
const MUX_LAZY_MIN_INTERVAL_MS = 30_000;
/** client bundle 里那个常量的名字（动态提取的目标）。 */
const MUX_CONST_NAME = "REMOTE_STREAM_MUX_PATH";

/**
 * 功能 1「另存为…」的本机路由（客户端半 `location.assign` 到这里；见 README）。
 * 这是本插件**唯一**一条给浏览器用的路由：它不走"仅回环"，而走官方的"可信请求"判定
 * （见 {@link authorizeTrustedRequest}）。
 */
const DOWNLOAD_PATH = `${PLUGIN_ROUTE}/download`;

/** 功能 2「分叉到…」的本机路由（客户端半 POST 到这里）。 */
const FORK_PATH = `${PLUGIN_ROUTE}/fork`;

/**
 * 目标机 Remote RPC 的 HTTP 通道：`POST <设备>/api/<namespace>/<method>`。
 * 依据（都从 app.asar 里抽出来读过）：
 *  - `@deepseek-ai/dsh-client-connection/lib/index.js` 的 `API_PATH = "/api"` 与 `rpcFetchHandler`
 *    （请求体信封 `{type:"client-request", rpcId, method, payload}`，`method` 必须等于路径末段）；
 *  - `@deepseek-ai/dsh-api-gateway/lib/index.js` 的 `endpointOf()`（`${namespace}/${method}`）与
 *    `remoteRequest()`（payload 必须**恰好**只有 `args` 一个字段，且 args 的键名 = descriptor 的 wire 名）。
 */
const REMOTE_RPC_CHANNEL = "/api";

/** 跨机附件搬运（路径桥）：见 BRIDGE.md —— 把消息里指向**本机**的文件搬到会话所在那台设备。 */
const BRIDGE_PROMPT_PATH = "/api/session/prompt";
const BRIDGE_UPLOAD_PATH = "/api/session/uploadFileBinary";
const BRIDGE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const BRIDGE_MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * 0.13.2：代理 401/403 **自动重放**的请求体上限（256 KiB）。
 * 只有"体还在我们手里"才敢重发：GET/HEAD/OPTIONS、空体、或已缓冲且不超过这个上限的体。
 * 超过它（或长度未知的流式体）就只发一次；401/403 时明确写 lastError，**绝不静默**。
 */
const REPLAY_MAX_BODY_BYTES = 256 * 1024;
/** 体太大无法重放时写给设备状态的一句话（不带 token / cookie）。 */
const REPLAY_TOO_LARGE_MESSAGE = "对端拒绝了会话/令牌（HTTP 401/403），且请求体过大无法自动重放：请重试一次";
/** 传前是否查对面（默认关；见调用处注释）。 */
const BRIDGE_CHECK_PEER = false;
const BRIDGE_BS = String.fromCharCode(92);
/**
 * 本机绝对路径：盘符路径（C:\…）与 UNC（\\server\share）。
 * - `BRIDGE_QUOTED_PATH_RE`：桌面端对**带空格**的路径会写成 `@"C:\a b.md"`（见 dsh-file-reference 的 formatFileMention）。
 * - `BRIDGE_BARE_PATH_RE`：不带空格的裸路径。
 * 两种都收，匹配到后再裁掉尾随标点。
 */
/** 反斜杠（用字符码构造，避免源码里到处写转义）。 */
// **只认官方的"文件提及"**：桌面端引用文件时写成 `@C:\a.txt` 或 `@"C:\a b.txt"`
// （见 dsh-file-reference 的 formatFileMention）。正文里出现的裸路径**不算附件**，绝不搬运 ——
// 0.11.9 之前是"见到路径就搬"，结果用户正文里提到 C:\Windows\... 也被上传+改写（已修）。
const BRIDGE_MENTION_QUOTED_RE = /@"((?:[A-Za-z]:|\\\\)[^"\r\n]+)"/gu;
const BRIDGE_MENTION_BARE_RE = /@((?:[A-Za-z]:|\\\\)[^\s"'<>|*?\r\n]+)/gu;
const BRIDGE_QUOTED_PATH_RE = /"((?:[A-Za-z]:|\\\\)[^"\r\n]+)"/gu;
const BRIDGE_BARE_PATH_RE = /(?:[A-Za-z]:\\|\\\\\\)[^\s"'<>|*?\r\n]+/gu;
const BRIDGE_TRAILING = /[\s，。、；：,.;:)\]）】」』"']+$/u;

/** 把桥接的每一步决策追加到 <数据目录>/dsh-remote-bridge.log（插件 info 不落盘，排查靠它）。 */
/** 诊断用：把请求体存到 <数据目录>/dsh-remote-bridge-<tag>.json（最多 8 KB，失败静默）。 */
function dumpBridgeBody(runtime, tag, body) {
	const dataPath = typeof runtime.dataPath === "string" ? runtime.dataPath : "";
	const dir = dataPath.replace(/[\\/][^\\/]*$/u, "");
	if (dir === "" || dir === dataPath || body === null) return;
	try {
		writeFileSync(`${dir}/dsh-remote-bridge-${tag}.json`, body.subarray(0, 8192));
	} catch {
		/* 诊断失败不影响功能 */
	}
}

function bridgeNote(runtime, line) {
	const dataPath = typeof runtime.dataPath === "string" ? runtime.dataPath : "";
	const dir = dataPath.replace(/[\\/][^\\/]*$/u, "");
	if (dir === "" || dir === dataPath) return;
	try {
		appendFileSync(`${dir}/dsh-remote-bridge.log`, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		/* 记不上就算了，绝不影响转发 */
	}
}

/**
 * 桥接模式（**0.11.1 起默认关闭** —— 0.11.0 默认开是把文件发送弄坏的那次事故）：
 * - 数据文件旁边有 `dsh-remote-bridge.enabled` → 正常搬运；
 * - 有 `dsh-remote-bridge.dryrun` → **干跑**：只把桌面端真实发来的 prompt 原文记进日志，一个字都不改；
 * - 都没有 → 关闭（完全不碰请求体，行为与没装这个功能一模一样）。
 */
function bridgeMode(runtime) {
	void 0;
	const dataPath = typeof runtime.dataPath === "string" ? runtime.dataPath : "";
	const dir = dataPath.replace(/[\\/][^\\/]*$/u, "");
	if (dir === "" || dir === dataPath) return "off";
	const has = (name) => {
		try {
			statSync(`${dir}/${name}`);
			return true;
		} catch {
			return false;
		}
	};
	if (has("dsh-remote-bridge.enabled")) return "on";
	if (has("dsh-remote-bridge.dryrun")) return "dryrun";
	return "off";
}

/** 读本机一个普通文件的字节：**只**用于用户在消息里明确引用过的路径；有大小上限。 */
function readBridgeFileBytes(filePath) {
	let info;
	try {
		info = statSync(filePath);
	} catch (error) {
		return { error: `读不到（${messageOf(error)}）` };
	}
	if (!info.isFile()) return { error: "不是普通文件（目录或设备）" };
	if (info.size > BRIDGE_MAX_FILE_BYTES) return { error: `超过上限 ${String(BRIDGE_MAX_FILE_BYTES)} 字节` };
	try {
		return { bytes: readFileSync(filePath), size: info.size };
	} catch (error) {
		return { error: `读失败（${messageOf(error)}）` };
	}
}

/** 把字节投到那台设备的官方原始字节上传路由（认证靠该设备的会话 cookie）。 */
function uploadBridgeBytes(device, runtime, sessionId, name, bytes) {
	return new Promise((resolve) => {
		let target;
		try {
			target = new URL(`${device.origin}${device.basePath}${BRIDGE_UPLOAD_PATH}`);
		} catch {
			resolve({ error: "无法构成远端上传地址" });
			return;
		}
		target.searchParams.set("sessionId", sessionId);
		target.searchParams.set("name", name);
		const send = device.protocol === "https:" ? httpsRequest : httpRequest;
		const headers = {
			"content-type": "application/octet-stream",
			"content-length": String(bytes.length),
			accept: "application/json",
			"user-agent": USER_AGENT,
			host: device.authority,
			origin: device.origin,
		};
		const cookie = cookieHeaderFor(device, undefined, runtime);
		if (cookie !== undefined) headers.cookie = cookie;
		const request = send({
			protocol: target.protocol,
			hostname: device.hostname,
			port: device.port === "" ? undefined : device.port,
			path: `${target.pathname}${target.search}`,
			method: "POST",
			headers,
		}, (response) => {
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				if (size > 256 * 1024) return;
				size += chunk.length;
				chunks.push(chunk);
			});
			response.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				if ((response.statusCode ?? 0) >= 400) {
					resolve({ error: `远端上传返回 ${String(response.statusCode)}：${text.slice(0, 120)}` });
					return;
				}
				let parsed = null;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = null;
				}
				// 真机实测（0.11.0 探针）：成功 = {ok:true, value:{receiptId, file:{attachmentId, name, bytes}}}
				const okValue = parsed === null || parsed === undefined ? undefined : parsed.value;
				const file = okValue === null || okValue === undefined ? undefined : okValue.file;
				if (file !== null && typeof file === "object" && typeof file.attachmentId === "string") {
					resolve({
						attachment: {
							attachmentId: file.attachmentId,
							name: typeof file.name === "string" && file.name !== "" ? file.name : name,
							bytes: typeof file.bytes === "number" ? file.bytes : bytes.length,
						},
					});
					return;
				}
				const failed = parsed !== null && parsed !== undefined && parsed.ok === false;
				resolve({ error: failed ? `远端拒绝：${text.slice(0, 160)}` : `远端没回附件信息：${text.slice(0, 160)}` });
			});
		});
		const timer = setTimeout(() => {
			request.destroy(new Error("上传超时"));
		}, CONNECT_TIMEOUT_MS);
		unrefTimer(timer);
		request.on("error", (error) => {
			clearTimeout(timer);
			resolve({ error: `上传失败（${messageOf(error)}）` });
		});
		request.on("response", () => clearTimeout(timer));
		request.end(bytes);
	});
}

/**
 * 定位 prompt 信封里的内容块数组。
 * 文档形状：`payload.args.request.content`；兜底 `request.content`。
 * @returns 数组；找不到 → `undefined`。
 */
function contentArrayOf(envelope) {
	// 1) 文档形状：payload.args.request.content
	const request = envelope?.payload?.args?.request ?? envelope?.request;
	const documented = request === null || request === undefined ? undefined : request.content;
	if (Array.isArray(documented)) return documented;
	// 2) 兜底：深度找一个"内容块数组"（每项都是带 type 字符串的对象），
	//    真实信封的嵌套层数可能和文档不完全一致（实测遇到过），这里不做形状假设。
	const BLOCK_TYPES = new Set(["text", "reasoning", "image", "file", "tool-call", "tool-addition", "tool-removal"]);
	const visit = (value, depth) => {
		if (depth > 6 || value === null || typeof value !== "object") return undefined;
		if (Array.isArray(value)) {
			if (value.length > 0 && value.every((item) => item !== null && typeof item === "object" && BLOCK_TYPES.has(item.type))) return value;
			for (const item of value) {
				const found = visit(item, depth + 1);
				if (found !== undefined) return found;
			}
			return undefined;
		}
		for (const item of Object.values(value)) {
			const found = visit(item, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return visit(envelope, 0);
}

/** 在 JSON 里按候选键名找第一个非空字符串（远端上传响应的形状可能变，这里宽松点）。 */
/** 问对面一次：这台设备的用户目录（用来拼附件库绝对路径）；内存里记住，不落盘。 */
/**
 * 问对面：这台设备的用户目录（用来拼附件库绝对路径）。
 * 用官方 `session/list` 里某条会话的 `cwd` 推前两段（`C:\\Users\\<user>`）——
 * **不能用 `workspaceFiles/stat` 查 "."**：官方 stat 只认普通文件，目录会报 `not-regular-file`（0.11.12 踩过）。
 * 内存里记住，不落盘；拿不到 → null（调用方当"查不准"，照传）。
 */
async function peerUserDir(device, runtime, sessionId) {
	if (runtime.bridgePeerDir !== null && typeof runtime.bridgePeerDir === "object" && typeof runtime.bridgePeerDir[device.id] === "string") {
		return runtime.bridgePeerDir[device.id];
	}
	try {
		const response = await postRemoteRpc(runtime, device, "session/list", { _request: {} }, {});
		if (response === null || response === undefined || response.ok !== true) return null;
		const parsed = parseRpcText(response, "跨机搬运（session/list）");
		if (parsed.ok !== true) {
			bridgeNote(runtime, `问对面用户目录失败：${String(parsed.code)} ${String(parsed.message)}`);
			return null;
		}
		const value = parsed.value === null || parsed.value === undefined ? {} : parsed.value;
		const items = Array.isArray(value.items) ? value.items : [];
		const hit = items.find((item) => item !== null && typeof item === "object" && item.sessionId === sessionId) ?? items.find((item) => item !== null && typeof item === "object" && typeof item.cwd === "string");
		const cwd = hit !== null && hit !== undefined && typeof hit.cwd === "string" ? hit.cwd : "";
		const parts = cwd.split(BRIDGE_BS).filter((part) => part !== "");
		if (parts.length < 3) return null;
		// 用户目录 = 前三段（C: + Users + <user>）；不是这个布局就返回 null（照传，fail-safe）
		if (parts.length < 3 || String(parts[1]).toLowerCase() !== "users") return null;
		const dir = parts.slice(0, 3).join(BRIDGE_BS);
		if (runtime.bridgePeerDir === null || typeof runtime.bridgePeerDir !== "object") runtime.bridgePeerDir = {};
		runtime.bridgePeerDir[device.id] = dir;
		bridgeNote(runtime, `对面用户目录 = ${dir}`);
		return dir;
	} catch (error) {
		bridgeNote(runtime, `问对面用户目录抛错：${messageOf(error)}`);
		return null;
	}
}

/** 官方 workspaceFiles/stat（复用插件里已验证的 RPC 助手；只读）。失败一律 null = 当"查不到"。 */
async function peerWorkspaceFileStat(device, runtime, sessionId, filePath) {
	try {
		const response = await postRemoteRpc(runtime, device, WORKSPACE_FILES_STAT_ENDPOINT, { workspaceFileScopeId: sessionId, path: filePath }, {});
		if (response === null || response === undefined || response.ok !== true) return null;
		const parsed = parseRpcText(response, "跨机搬运（workspaceFiles/stat）");
		if (parsed.ok !== true) {
			bridgeNote(runtime, `查对面失败：${String(parsed.code)} ${String(parsed.message)}`);
			return null;
		}
		return parsed.value !== null && typeof parsed.value === "object" ? parsed.value : null;
	} catch (error) {
		bridgeNote(runtime, `查对面抛错：${messageOf(error)}`);
		return null;
	}
}


/** 对面附件库里这个内容对象在不在？true=在（可跳过传输）/ false=不在 / undefined=查不准（照传）。 */
async function peerHasAttachment(device, runtime, sessionId, sha) {
	const dir = await peerUserDir(device, runtime, sessionId);
	if (dir === null) return undefined;
	const objectPath = [dir, ".dsh", "attachments", "v1", "file-objects", sha.slice(0, 2), sha].join(BRIDGE_BS);
	const stat = await peerWorkspaceFileStat(device, runtime, sessionId, objectPath);
	if (stat === null) return undefined;
	return typeof stat.size === "number" && stat.size > 0;
}

function findStringDeep(value, keys) {
	if (value === null || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findStringDeep(item, keys);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	for (const item of Object.values(value)) {
		const found = findStringDeep(item, keys);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** 收集请求体（有上限；超限返回 null = 不改写、照原样转发）。 */
function readBridgeBody(req, limit) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", () => resolve(null));
	});
}

/**
 * 0.13.2：这次请求**有没有请求体**（只按方法 + 头判断，不读流）。
 * `content-length: 0` / 没有长度也没有 `transfer-encoding` ⇒ 视为没有体（可以像 GET 一样安全重试）。
 */
function requestHasBody(req) {
	const method = String(req.method ?? "").toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
	const length = declaredBodyLength(req);
	if (length !== null && length > 0) return true;
	const encoding = req.headers["transfer-encoding"];
	return typeof encoding === "string" && encoding !== "";
}

/** `content-length`（合法非负数）或 null（未知 / 非法 / 数组）。 */
function declaredBodyLength(req) {
	const raw = req.headers["content-length"];
	if (raw === undefined || raw === null || Array.isArray(raw)) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return null;
	return value;
}

/**
 * 0.13.2：把**声明长度 ≤ REPLAY_MAX_BODY_BYTES** 的请求体读进内存，供 401/403 时原样重放。
 * 调用方必须先按 `content-length` 判断上限；这里仍有一道硬上限（防客户端谎报长度）：
 * 真超过 ⇒ null，调用方回 413（既然流已经读走，就没法再"原样转发"了）。
 * @returns {Promise<Buffer|null>}
 */
function readReplayBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		req.on("data", (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > REPLAY_MAX_BODY_BYTES) {
				finish(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => finish(Buffer.concat(chunks)));
		req.on("error", () => finish(null));
	});
}

/**
 * 把 prompt 请求体里**本机存在**的路径搬到那台设备，并改写成远端路径。
 * @returns 改写后的 Buffer；不需要改写/任何失败 → `undefined`（照原样转发）。
 */
async function bridgePromptBody(device, runtime, req, rest) {
	bridgeNote(runtime, `进入桥接：method=${String(req.method)} path=${String(rest).split("?")[0]}`);
	const mode = bridgeMode(runtime);
	bridgeNote(runtime, `模式=${mode}`);
	if (mode === "off") return undefined;
	if (req.method !== "POST") return undefined;
	if (rest.split("?")[0] !== BRIDGE_PROMPT_PATH) return undefined;
	const raw = await readBridgeBody(req, BRIDGE_MAX_BODY_BYTES);
	// 诊断（0.11.6）：进来的原始请求体存一份，用于和会话最终收到的文本逐字对比
	dumpBridgeBody(runtime, "in", raw);
	if (mode === "dryrun") {
		// 只记录、不改写：用来抓桌面端**真实**发来的 prompt 形状（附件段到底长什么样）
		if (raw !== null) info(runtime.ctx, `跨机搬运【干跑】桌面端真实 prompt（原样转发，前 2000 字符）：${raw.toString("utf8").slice(0, 2000)}`);
		return raw === null ? null : raw;
	}
	// 注意：体已经从这个流里读走了，从这里往下**必须**把 raw（或改写后的）转发出去，
	// 不能再回退到 req.pipe() —— 否则对面等不到请求体（表现为 fetch failed）。
	if (raw === null) return null; // 超上限：调用方回 413，不转发半个体
	if (raw.length === 0) return raw;
	let envelope;
	try {
		envelope = JSON.parse(raw.toString("utf8"));
	} catch {
		return raw; // 不是 JSON：原样转发
	}
	const text = raw.toString("utf8");
const wanted = new Set();
// JSON 文本里引号是转义的（@\"C:\\a b.txt\"）→ 先还原成 @"…" 再匹配，避免正则里堆转义
const searchable = text.split(BRIDGE_BS + '"').join('"');
const mentionQuoted = [...searchable.matchAll(BRIDGE_MENTION_QUOTED_RE)].map((m) => m[1]);
for (const raw of mentionQuoted) {
	const c = raw.trim().replace(/[\\/]+$/u, "");
	if (c !== "") wanted.add(c);
}
for (const m of searchable.matchAll(BRIDGE_MENTION_BARE_RE)) {
	const c = m[1].replace(/[\\/]+$/u, "");
	if (c === "") continue;
// 带空格路径的"前半截"会被裸提及也匹配到：丢掉这种前缀
	if (mentionQuoted.some((q) => q.startsWith(c) && q !== c)) continue;
	wanted.add(c);
}
if (wanted.size === 0) return raw;
	bridgeNote(runtime, `从请求体里扫到 ${String(wanted.size)} 个本机路径：${[...wanted].join(" | ")}`);
	const sessionId = findStringDeep(envelope, ["sessionId"]);
	if (sessionId === undefined) {
		info(runtime.ctx, "跨机搬运：请求体里没有 sessionId，跳过");
		return raw;
	}
	const moved = [];
	for (const from of wanted) {
		// JSON 文本里的路径是**转义过**的（`C:\\\\a`）；读盘要用反转义后的真实路径。
		const filePath = from.split(BRIDGE_BS + BRIDGE_BS).join(BRIDGE_BS);
		const read = readBridgeFileBytes(filePath);
		if (read.error !== undefined) {
			info(runtime.ctx, `跨机搬运：${from} → 跳过（${read.error}）`);
			continue;
		}
		const name = filePath.split(/[\\/]/u).pop() ?? "file";
		// **每次都真传**（用户 2026-10-15 决定）：官方附件库按内容 sha256 去重，重复内容不会重复占空间；
		// 试过"传前查对面"，但官方 workspaceFiles/stat 只认工作区内路径，附件库在工作区外 → 永远查不到（0.11.11~0.11.14 的弯路）。
		// 查询实现保留在 BRIDGE_CHECK_PEER 后面，默认关闭；要重新启用必须先把"怎么问对面"解决掉。
		const uploaded = BRIDGE_CHECK_PEER === true && typeof peerHasAttachment === "function"
			? await (async () => {
				const localSha = createHash("sha256").update(read.bytes).digest("hex");
				const existed = await peerHasAttachment(device, runtime, sessionId, localSha);
				if (existed === true) bridgeNote(runtime, `对面已有该内容对象（${localSha.slice(0, 8)}…）→ 跳过传输`);
				return existed === true ? { attachment: { attachmentId: `sha256:${localSha}`, name, bytes: read.bytes.length } } : uploadBridgeBytes(device, runtime, sessionId, name, read.bytes);
			})()
			: await uploadBridgeBytes(device, runtime, sessionId, name, read.bytes);
		if (uploaded.attachment === undefined) {
			warn(runtime.ctx, `跨机搬运：${from} → 失败（${uploaded.error ?? "远端没回附件信息"}）`);
			continue;
		}
		moved.push({ from, fromUnescaped: filePath, ...uploaded.attachment });
		bridgeNote(runtime, `搬运成功：${filePath} → ${uploaded.attachment.attachmentId}`);
		info(runtime.ctx, `跨机搬运：${from} → 附件 ${uploaded.attachment.name}（${String(read.size)} 字节，${uploaded.attachment.attachmentId}）`);
	}
	if (moved.length === 0) return raw;
	bridgeNote(runtime, `实际搬运成功 ${String(moved.length)} 个`);
	// 正文里把本机路径换成「文件名 + attachmentId」。
// **关键（0.11.3）**：先解析，再在 JS 字符串上替换，最后**重新序列化**；
// 不要在原始 JSON 文本上 split/join —— 转义与字节长度会把请求体弄坏（0.11.2 的 HTTP 400 就是这么来的）。
let envelopeNext = null;
try {
	envelopeNext = JSON.parse(text);
} catch (error) {
	warn(runtime.ctx, `跨机搬运：请求体不是合法 JSON（${messageOf(error)}），原样转发`);
	return raw;
}
// 文案**只用设备名**（不给用户看"你/对方"那种相对说法）：源 = 本机（插件跑在哪台就用哪台的名字），目标 = 正在代理的那台。
const localClaimed = runtime.localDevice;
const sourceName = localClaimed !== null && localClaimed !== undefined && typeof localClaimed.name === "string" && localClaimed.name !== ""
	? localClaimed.name
	: (runtime.facts !== null && runtime.facts !== undefined && typeof runtime.facts.hostname === "string" && runtime.facts.hostname !== "" ? runtime.facts.hostname : "本机");
const targetName = device !== null && device !== undefined && typeof device.name === "string" && device.name !== "" ? device.name : "目标设备";
const shownOf = (item) => `${item.name}（已从${sourceName}搬到${targetName}附件库：${item.attachmentId}）`;
const replaceInStrings = (value) => {
	if (typeof value === "string") {
		let out = value;
		for (const item of moved) {
			const shown = shownOf(item);
			// 单反斜杠、双反斜杠（JSON 转义形态）都试一遍 —— 之前只赌了一种，导致改写空转
			const forms = [item.fromUnescaped, item.from, item.fromUnescaped === undefined ? undefined : item.fromUnescaped.split(BRIDGE_BS).join(BRIDGE_BS + BRIDGE_BS)];
			for (const form of forms) {
				if (typeof form === "string" && form !== "") out = out.split(form).join(shown);
			}
		}
		return out;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) value[i] = replaceInStrings(value[i]);
		return value;
	}
	if (value !== null && typeof value === "object") {
		for (const key of Object.keys(value)) value[key] = replaceInStrings(value[key]);
		return value;
	}
	return value;
};
replaceInStrings(envelopeNext);
let serialized;
try {
	serialized = Buffer.from(JSON.stringify(envelopeNext), "utf8");
} catch (error) {
	warn(runtime.ctx, `跨机搬运：重序列化失败（${messageOf(error)}），原样转发`);
	return raw;
}
	runtime.bridgeMoved = (typeof runtime.bridgeMoved === "number" ? runtime.bridgeMoved : 0) + 1;
	runtime.bridgeLastAt = Date.now();
	runtime.bridgeTarget = targetName;
info(runtime.ctx, `跨机搬运：改写完成（${String(serialized.length)} 字节，无内容段）`);
	dumpBridgeBody(runtime, "out", serialized);
	bridgeNote(runtime, `改写完成：${String(raw.length)} → ${String(serialized.length)} 字节`);
return serialized;
}

/** workspaceFiles Remote 的 endpoint（namespace/method）。 */
const WORKSPACE_FILES_STAT_ENDPOINT = "workspaceFiles/stat";
const WORKSPACE_FILES_READ_BYTES_ENDPOINT = "workspaceFiles/readBytes";
/** sessionController Remote 的 endpoint。 */
const SESSION_PROJECTIONS_ENDPOINT = "session/projections";
const SESSION_PAGE_ENDPOINT = "session/page";
const SESSION_CREATE_ENDPOINT = "session/create";
const SESSION_PROMPT_ENDPOINT = "session/prompt";
/**
 * `@Remote('rename') rename(request: { sessionId, title })`。
 * 依据：`@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js` 里
 * `session/rename` 的 descriptor —— 参数只有一个 `wire: 'request'`（`SessionRenameRequest`），
 * 结果 `SessionRenameValue = { title, seq }`；零参数/多余字段都会被 gateway 的 `assertExactArguments` 拒掉。
 */
const SESSION_RENAME_ENDPOINT = "session/rename";
/**
 * workspaceController 的 Remote：取**目标机**的默认工作区。
 * 依据：`@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js` 里
 * `workspace/initializeDefault` 的 descriptor —— `parameters: []`（args 必须是**空对象**）、
 * 结果 `undefined | { workspace: { workspaceId, path, title, sessionIds, createdAt, updatedAt } }`。
 */
const WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT = "workspace/initializeDefault";

/** 下载分块大小（目标机 `readBytes` 的窗口上限默认 2 MiB，取 512 KiB 留足余量）。 */
const DOWNLOAD_CHUNK_BYTES = 512 * 1024;
/** 一次下载最多读多少个窗口（防"目标机不推进 offset"把本机拖死；512 KiB × 该值 = 64 GiB 上限）。 */
const MAX_DOWNLOAD_WINDOWS = 131_072;
/** 单个 multipart 响应里除窗口字节之外的余量（metadata + 边界 + 段头）。 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** 一次 Remote RPC 的响应体上限（防止目标机回一个巨物把我们撑爆）。 */
const REMOTE_RPC_MAX_BYTES = 4 * 1024 * 1024;
/** 一次 Remote RPC 的总超时（连接 + 读完；下载是**一窗口一次**请求，所以这不会限制大文件）。 */
const REMOTE_RPC_TIMEOUT_MS = 60_000;

/** 种子文本的字节上限（超了就从**最新**那头保留，并在开头写明截断）。 */
const FORK_MAX_SEED_BYTES = 256 * 1024;
/** 源标题一个字都没给时，新会话标题里的那一段（绝不出空标题 / `undefined`）。 */
const FORK_UNTITLED_TITLE = "未命名会话";
/** 源标题的字符上限（目标机的 title 服务自己还会归一化，这里只防"巨物"撑爆请求体）。 */
const MAX_SOURCE_TITLE_CHARS = 512;
/** 下载/分叉的参数上限。 */
const MAX_PATH_CHARS = 4_096;
const MAX_SESSION_ID_CHARS = 256;

/** 响应转发时要丢掉的逐跳头（长度类另行重算）。 */
const DROP_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-length",
]);

/** 请求转发时要丢掉的头（这些一律由本插件改写或按需要重设）。 */
const DROP_REQUEST_HEADERS = new Set([
	"host",
	"origin",
	"cookie",
	"connection",
	"keep-alive",
	"upgrade",
	"te",
	"trailer",
	"transfer-encoding",
	"proxy-connection",
	"proxy-authorization",
	"referer",
	"expect",
]);

/**
 * I1 的响应体嗅探：这些开头的响应体按 HTML 处理（`content-type` 缺失或被伪装时兜底）。
 * 只认文档级开头，避免把 JSON 里的 `<` 误判。
 */
const HTML_OPENERS = ["<!doctype html", "<html", "<head", "<body"];
/** 嗅探时最多先攒多少字节（攒不出结论就当作非 HTML 放行，绝不无限缓冲）。 */
const SNIFF_LIMIT_BYTES = 4_096;
/** 每次嗅探只看开头这么多字节。 */
const SNIFF_WINDOW_BYTES = 64;

/**
 * 只允许回环访问插件的设置接口。
 * **例外**：`GET /plugin/remote/download` 走官方的"可信请求"判定（见
 * {@link authorizeTrustedRequest}）—— "浏览器打开另一台机器的 DSH 页面"时它的请求不来自回环，
 * 用这条守卫必然 403。其余路由（含 `POST /plugin/remote/fork`）继续只认回环。
 */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 本机文件读取用的服务名。`workspaceFiles` 是官方那个"按 session 授权读工作区文件"的服务
 * （`@deepseek-ai/dsh-api-workspace-files`，`dsh-web-app` 的标准组合里有它，见 README），
 * 目标机那条代理路线打的就是它的 Remote；本机路线直接**进程内**调它，闸门完全一样。
 */
const WORKSPACE_FILES_SERVICE = "workspaceFiles";
/** `workspaceFileScope` 这个 lookup 是官方把 sessionId 换成 `{sessionId, workspaceRoot}` 的地方。 */
const TYPERT_SERVICE = "typert";
const WORKSPACE_FILE_SCOPE_LOOKUP = "workspaceFileScope";

/** 路径片段安全性：id 会进 URL 与路由表，只允许 unreserved 字符（垫片里有一份同样的正则）。 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u;

//#region 基础工具

/** 把值内联进 `<script>`：`<` 转义成 `\u003c`，避免 `</script>` 提前闭合脚本。 */
function inlineJson(value) {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/** 与 `@deepseek-ai/dsh-client-connection` 的 encodeBase64Url 同式。 */

/** 某 authority 对应的会话 cookie 名（用于精确取用，顺带避免把本机 cookie 发到远端）。 */

/** 从 Cookie 头里取一个精确名字的值（实现同远端的 cookieValue：只认第一段同名）。 */

/** 一条错误的可读消息。 */

/**
 * 定时器一律 `unref()`：**"等一会儿"的定时器不许把 Host 进程拖住**（更新器安装 / 退出时尤其致命）。
 * 请求级定时器照旧在结束时 `clearTimeout`，这里只是再加一道"不挡住退出"的保险。
 */

/** 宽松地发一条告警；ctx.logger 缺失时退回 console（宿主进程里两者都进 DSH 日志）。 */

/** 一条普通信息日志（"认领了哪台是本机"这类正常但值得看见的事）；info 缺失时退回 console。 */

/** 请求是不是从本机回环来的（设置页接口一律只认它）。 */
function isLoopback(req) {
	const raw = req !== null && typeof req === "object" && req.socket !== null && typeof req.socket === "object"
		? req.socket.remoteAddress
		: "";
	return LOOPBACK_ADDRESSES.has(typeof raw === "string" ? raw : "");
}

/**
 * 取一个 service（`ctx.get(name)` 优先，退回属性访问）。
 * 真 Cordis 的 `ctx.get` 是官方读服务的入口；自测的假 ctx 只有属性 —— 两条路都要能用，
 * 而且**拿不到就返回 undefined**（本插件对可选服务一律降级，绝不抛）。
 */
function serviceOf(ctx, name) {
	if (ctx === null || typeof ctx !== "object") return undefined;
	try {
		if (typeof ctx.get === "function") {
			const viaGet = ctx.get(name);
			if (viaGet !== undefined && viaGet !== null) return viaGet;
		}
	} catch {
		/* ctx.get 抛错（服务不存在时某些实现会抛）→ 退回属性访问 */
	}
	const direct = ctx[name];
	return direct === undefined || direct === null ? undefined : direct;
}

/**
 * 这次请求是不是「另存为」那条路由（只看原始 url 的 path，不做 URL 解析）。
 * 它是**唯一**一条不受"仅回环"守卫约束的路由：鉴权在 {@link handleDownloadRequest} 里
 * 用官方的"可信请求"判定单独做（见 {@link authorizeTrustedRequest}）。
 */
function isDownloadRequestUrl(rawUrl) {
	const raw = typeof rawUrl === "string" && rawUrl !== "" ? rawUrl : "";
	const cut = raw.search(/[?#]/u);
	const path = cut === -1 ? raw : raw.slice(0, cut);
	return path === DOWNLOAD_PATH;
}

/**
 * 官方的"可信请求"判定（**照抄官方用法，不自己发明鉴权**）。
 *
 * 依据（app.asar 抽出，见 README「另存为」一节的出处）：
 *  - `@deepseek-ai/dsh-client-connection/lib/index.js` 的 `HostConnectionService.requestRejection(request)`：
 *    `if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;`
 *    `return this.browserAuth.isAuthenticated(request) ? void 0 : 401;`
 *    —— Host 必须是回环或 `trustedHosts` 里的 authority（WHATWG 归一比较），`sec-fetch-site: cross-site`
 *    一律拒，带 `Origin` 时必须与 Host 同源；过了栅栏再看浏览器会话 cookie（`dsh-auth-<sha256(authority)>`）。
 *  - 官方路由的用法：`@deepseek-ai/dsh-host-open-in-app/lib/index.js` 的 `rejected(req, res)`
 *    （`const rejection = connectionOf(ctx).requestRejection(req)`）与 connection 自己的 `/api` 路由。
 *
 * 判定是**同步**的（官方就是这么用的），返回数字 = 拒绝。
 * 本插件把拒绝统一折成 **403 + text/plain**（与旧"仅回环 → 403"在语义上等价），
 * 但把官方那个码（401/403）**写进正文**，排错时不用猜：
 *  - 401 = 栅栏过了、但请求没带有效的 `dsh-auth-*` 会话 cookie（正常浏览器打开过 DSH 页面就带着）；
 *  - 403 = Host/Origin 栅栏没过（DNS rebinding / 跨站请求 / Host 不在 `trustedHosts`）。
 * 宿主连 `requestRejection` 都没有（老 DSH）→ **一律拒绝**（不清楚的请求不放行），并写明原因。
 * @returns `{ ok:true }` 或 `{ ok:false, status, reason }`（`reason` 已含功能名，可直接进正文）。
 */
function authorizeTrustedRequest(runtime, req, label) {
	const connection = serviceOf(runtime.ctx, "connection");
	const requestRejection = connection === undefined ? undefined : connection.requestRejection;
	if (typeof requestRejection !== "function") {
		return {
			ok: false,
			status: 403,
			reason: `${label}被拒绝 —— 这台机器的 DSH 没有提供官方的"可信请求"判定（connection.requestRejection）`
				+ "，本插件无法安全地判断这条请求是否可信；不清楚的请求一律拒绝。请升级 DSH 或改用桌面 App 的本机回环访问。",
		};
	}
	let rejection;
	try {
		rejection = requestRejection.call(connection, req);
	} catch (error) {
		return { ok: false, status: 403, reason: `${label}被拒绝 —— 可信请求判定抛错：${plainValue(messageOf(error))}` };
	}
	if (rejection === undefined || rejection === null) return { ok: true };
	const code = typeof rejection === "number" ? rejection : 403;
	const why = code === 401
		? "官方判定 401 unauthorized：Host/Origin 栅栏过了，但这条请求没有带有效的浏览器会话 cookie"
			+ "（dsh-auth-*），请从这台机器的 DSH 首页（或带 token 的地址）重新打开页面再试"
		: code === 403
			? "官方判定 403 forbidden：Host/Origin 栅栏没过（Host 既不是回环、也不在 connection.trustedHosts 里，"
				+ "或 Origin 与 Host 不同源、或 sec-fetch-site: cross-site）"
			: `官方判定返回 ${String(code)}`;
	return { ok: false, status: 403, reason: `${label}被拒绝 —— ${why}。` };
}

/** 响应 `content-type` 是否是 HTML（I1 的第一道判定）。 */
function isHtmlContentType(value) {
	const essential = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
	return essential === "text/html" || essential === "application/xhtml+xml";
}

/**
 * 判定一段响应体开头是不是 HTML。三态：
 * - `"html"`：确定是 HTML → 拦截（I1）
 * - `"maybe"`：还是某个 HTML 开头的前缀，需要再看更多字节
 * - `"no"`：确定不是 HTML → 放行
 * @param buffer - 响应体最前面的若干字节。
 */
function classifyBodyPrefix(buffer) {
	const text = buffer.toString("latin1").replace(/^\uFEFF/u, "").replace(/^[\s\u0000]+/u, "").toLowerCase();
	if (text === "") return "maybe";
	for (const opener of HTML_OPENERS) {
		if (text.startsWith(opener)) return "html";
		if (opener.startsWith(text)) return "maybe";
	}
	return "no";
}

//#endregion

//#region 浏览器侧垫片（自包含）

/**
 * 浏览器侧垫片。**注意：这个函数会被 `Function.prototype.toString()` 序列化后注入页面**
 * （见 {@link renderShimScript}），所以它只能引用**自己的参数**与**浏览器全局量**，
 * 绝不能引用本模块里的任何其它绑定、也不能用 import。
 *
 * 行为（= device-switch 0.2 的垫片 + "报到" + "自检"）：
 * - 加载后向本机 POST 一次 `/plugin/remote/hello`（fire-and-forget，用**未包装**的 fetch），
 *   宿主据此记 `injectionSeen`：这样"DSH 升级后注入失效"能被体检页看出来。
 * - 从 localStorage 读"当前设备 id"与设备列表（`dsh-device-switch:*` 为主，
 *   `dsh-remote:*` 为别名，两个键都读、都写）。
 * - **同步 patch 时序不许变**：`location` 一加载就同步改写 fetch / WebSocket / XMLHttpRequest
 *   （选中设备时），绝不改成"先问状态再 patch"——否则应用的首批请求会漏到本机。
 * - **自检（异步，不阻塞）**：同步 patch 之后问一次 `GET /plugin/remote/state`。只有拿到明确的
 *   `enabled:false`（或 404 = 插件已被卸载）才自除：清键 → 撤设备表 → 停探测 → 还原原语 → 带哨兵刷新一次。
 *   拿到 `enabled:true` 时：本次若是**惰性**（因为 payload/哨兵而没挂载）→ **惰性自愈**：
 *   写 `force-active` 标记、清哨兵、带防循环保护地刷新一次（同一窗口最多一次）；
 *   否则只清哨兵。请求失败 / 拿不到合法 JSON → 安静什么都不做（一次探测失败绝不能影响页面）。
 * - **没有选中设备时完全惰性**：不碰 fetch / WebSocket / XMLHttpRequest。
 * - 选中设备 `X` 时，把同源的 `api/…`、`/api/…`、`./api/…` 改写成 `/dev/X/…`
 *   （fetch、WebSocket、XMLHttpRequest.open 三处），其它 URL 原样放行。
 * - **垫片不画任何 UI**：右下角那颗「设备」胶囊面板与左上角那颗「← 本机」按钮**都已整段删除**
 *   （连 DOM 节点都不建：自测断言 `dom.body.children.length === 0`）。切设备的入口 = 客户端半
 *   注入的侧栏「设备 · …」那一行 + 点开的浮层菜单。**只删画 UI**：上面那套请求改写
 *   （fetch / WebSocket / XHR）与 `dsh-device-switch:*` 键一个字节没动。
 * - **自愈（2026-10-17 那个致死缺陷的补丁）**，两条，且都只在"选中的是**对端**"时才可能动手：
 *   ① 同步判据（页面加载那一刻）：选中的 id **不在配置的设备表里** ⇒ 清 `KEYS_CURRENT` +
 *      刷新一次回本机（配置表为空时不动：那种情况没有"这个 id 是脏的"的依据）；
 *   ② 可达性判据（0.12.0，**只在非回环且是 http(s) 的会话**里起一条 2 秒探测）：连续 2 次
 *      `GET /dsh-remote-view` 的聚合里那台 `reachable === false` ⇒ 同样清键 + 刷新回本机。
 *      桌面壳（`dsh-app:`）与本机 127.0.0.1 一律不动手（用户不要"自己切过去又被弹回来"）。
 *   防回环：本机态不动；一次页面生命周期最多自动重置一次；冷却标记写进 **localStorage**
 *   （跨 `location.reload()` 存活，60 秒内不再自动重置），写不进去就**绝不重置**；刷新复用
 *   `reloadOnce()` 的 sessionStorage 哨兵 ⇒ 同一窗口最多刷一次。
 *
 * @param options - `{ devices, localName, helloPath?, statePath?, enabled?, sentinelKey?, forceActiveKey? }`
 *   （宿主按当前设备表与 `enabled` 生成）。`localCaption` 仍会出现在 payload 里（兼容旧调用方），
 *   但垫片**一个字节都不读**（它只服务于已删除的胶囊文案）。
 * @returns 幂等槽位对象（重复执行直接返回它，不再包装）。
 */
import { remoteShim } from "./shim.js";
import { appendLog, dshHome, readLogTail, resolveLogFile } from "./logging.js";
import { AUTH_COOKIE_PREFIX, TOKEN_REF_PREFIX, SESSION_REF_PREFIX, base64Url, cookieNameFor, info, legacySessionRefFor, legacyTokenRefFor, messageOf, plainValue, readCookie, sessionRefFor, toPort, tokenRefFor, unrefTimer, warn } from "./util.js";
import { EDGE_INNER_AUTHORITY, buildEdgeState, edgeIo, startEdge, stopEdge, syncEdge } from "./edge.js";
import {
	configureProxy, handleHttpProxy, handleUpgradeProxy, rewriteLocation, rewriteSetCookie,
	writeDeviceNotice, writeJson, writeText,
} from "./proxy.js";
import {
	basenameOf, blockSummary, buildSeedContext, bytesOf, cleanSourceTitle, configureAttach,
	contentDispositionFor, contentText, encodeRfc5987, errorCodeOf, forkSessionTitle, forkSeedPrompt,
	handleDownloadRequest, handleForkRequest, localErrorText, localForkDeviceName, localPseudoDevice,
	messageOfRecord, multipartBoundary, opNote, parseMultipart, parseRpcResult, parseRpcText,
	postRemoteRpc, remoteErrorText, statusForLocalCode,
} from "./attach.js";
/** 保留 index.js 原有的对外导出面（这三个函数原本是这里的 `export function`）。 */
export { cleanSourceTitle, forkSessionTitle, localForkDeviceName };
import {
	buildLiveAggregate, buildLiveView, buildSelfLivePayload, clearLocalLiveUnread, configureLive,
	createLiveState, fetchPeerPath, handleLocalLiveRequest, handlePeerLiveRequest, handleViewRequest,
	livePendingOfItem, liveSelfNameOf, liveStateOf, liveTailRoleOf, liveViewFromPeerBody, liveViewOf,
	loadLiveUnread, markLiveSeen, pollLocalLive, pollPeerLives, resolveLivePath, saveLiveUnread,
	startLivePolling, stopLivePolling,
} from "./live.js";

import {
	DATA_FILE_NAME, DATA_FORK_TAIL_FIELD, DATA_SESSIONS_FIELD, DATA_TOKENS_FIELD,
	FORK_DEFAULT_TAIL, FORK_MAX_TAIL, FORK_MIN_TAIL,
	adoptData, configureData, effectiveForkTail, maybeReloadData, normalizeForkTail,
	persistDataFile, readDataFile, renderDataFile, resolveDataPath,
} from "./data.js";
import {
	authRejectMessage, captureSession, clearAuthNotice, configureStore, cookieHeaderFor,
	copyAuthorityCredentials, createSessionStore, createTokenStore, ensureSession,
	forgetSession, migrateAuthorityRefs, migrateFileTokens, noteAuthRejected,
	scheduleSeedTokenSettlement, sessionPairFromSetCookie,
} from "./store.js";
import {
	collectHostFacts, deviceMatchesLocal, isIpv4, localEntryName, normalizeDeviceEntry,
	normalizeDevices, parseDeviceUrl, resolveLocalDevice, slugifyDeviceId, configureDevices,
} from "./devices.js";
import {
	PROBE_BACKOFF_MAX_MS, configureReach, markReach, probeBackoffDelay, probeBackoffDue,
	proxyConnectTimeout, reachCheckedAt, recentlyUnreachable, triggerReachProbe, unreachableProxyReason,
} from "./reach.js";

/** 设备解析与本机身份（./devices.js）：这 5 个仍是 index 的公开面（device-switch / 自测直接 import）。 */
export { collectHostFacts, deviceMatchesLocal, localEntryName, normalizeDevices, resolveLocalDevice };


/** 把垫片序列化成一条可注入的 `<script>` 文本（纯追加，改不动页面里任何既有内容）。 */
function renderShimScript(options) {
	const source = remoteShim.toString();
	return `${SHIM_MARKER}\n(${source})(${inlineJson(options)});`;
}

//#endregion

//#region 会话长连接路径（REMOTE_STREAM_MUX_PATH）的动态发现

/** 读一个 HTTP(S) URL 的文本响应（不跟随跳转）。 */
function httpGetText(url, options) {
	const settings = options !== null && typeof options === "object" ? options : {};
	const limit = Number.isSafeInteger(settings.maxBytes) && settings.maxBytes > 0 ? settings.maxBytes : 512 * 1024;
	const timeoutMs = Number.isSafeInteger(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : MUX_FETCH_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		let parsed;
		try {
			parsed = new URL(url);
		} catch (error) {
			reject(new Error(`地址无法解析：${String(url)}`));
			return;
		}
		const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
		const headers = { "user-agent": USER_AGENT, accept: "*/*" };
		if (typeof settings.cookie === "string" && settings.cookie !== "") headers.cookie = settings.cookie;
		const request_ = send({
			protocol: parsed.protocol,
			hostname: parsed.hostname,
			port: parsed.port === "" ? undefined : parsed.port,
			path: `${parsed.pathname}${parsed.search}`,
			method: settings.method === "POST" ? "POST" : "GET",
			headers,
		}, (response) => {
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > limit) {
					response.destroy();
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), truncated: true });
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => {
				resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), truncated: false });
			});
			response.on("error", reject);
		});
		const timer = setTimeout(() => {
			request_.destroy(new Error(`读取超时（${String(timeoutMs)} ms）`));
		}, timeoutMs);
		unrefTimer(timer);
		request_.on("close", () => clearTimeout(timer));
		request_.on("error", reject);
		request_.end();
	});
}

/** 从一段文本里抽出 `REMOTE_STREAM_MUX_PATH` 的值（client bundle 里的常量声明）。 */
function extractMuxPath(text) {
	if (typeof text !== "string" || text === "") return null;
	const match = new RegExp(`${MUX_CONST_NAME}\\s*=\\s*["'\`]([^"'\`\\s]+)["'\`]`, "u").exec(text);
	if (match === null) return null;
	const value = match[1];
	if (typeof value !== "string" || value === "") return null;
	const path = value.startsWith("/") ? value : `/${value}`;
	if (!/^\/[A-Za-z0-9._~\-/]*$/u.test(path)) return null;
	return path;
}

/** 把候选地址归一成"以 / 开头的本机路径"（`plugins/??…` 与 `/plugins/??…` 都接受）。 */
function normalizeCandidate(raw) {
	if (typeof raw !== "string") return null;
	const value = raw.trim().replace(/&amp;/gu, "&");
	if (value === "" || value.startsWith("http://") || value.startsWith("https://") || value.startsWith("//")) return null;
	const withSlash = value.startsWith("/") ? value : `/${value}`;
	if (!withSlash.startsWith("/plugins/")) return null;
	if (withSlash.includes(".map")) return null;
	return withSlash;
}

/**
 * 第一手来源（进程内，不需要任何鉴权）：`ctx.webServer.collectIndexInjections()` 的行。
 * `script-preload` / `script-src` 的 `src` 就是 client module 的组合 bundle 地址；
 * `__DSH_BOOT__` 那个 global 行里还带着完整的模块图（`entries[].url`）。
 */
function urlsFromInjections(ctx) {
	const out = [];
	try {
		const webServer = ctx !== null && typeof ctx === "object" ? ctx.webServer : undefined;
		if (webServer === undefined || webServer === null || typeof webServer.collectIndexInjections !== "function") return out;
		const rows = webServer.collectIndexInjections();
		for (const row of Array.isArray(rows) ? rows : []) {
			if (row === null || typeof row !== "object") continue;
			if (typeof row.src === "string") out.push(row.src);
			if (row.kind === "global" && row.value !== undefined) {
				let text = "";
				try {
					text = JSON.stringify(row.value);
				} catch {
					text = "";
				}
				for (const match of text.matchAll(/"?(\/?plugins\/[^"'\s\\]+)/gu)) out.push(match[1]);
			}
		}
	} catch (error) {
		out.push(`__error__:${messageOf(error)}`);
	}
	return out;
}

/**
 * 用进程 token 向本机换一次浏览器会话 cookie（只为本机首页 / 插件资源用）。
 * **token 只用在这一条请求里**：不写日志、不进体检数据、不落盘。
 * @returns cookie 头字符串，或 null。
 */
async function mintLocalSessionCookie(runtime, baseUrl) {
	try {
		const connection = runtime.ctx !== null && typeof runtime.ctx === "object" ? runtime.ctx.connection : undefined;
		if (connection === null || connection === undefined || typeof connection.authenticatedUrl !== "function") return null;
		const authed = connection.authenticatedUrl(`${baseUrl}/`);
		const token = new URL(authed).searchParams.get("token");
		if (typeof token !== "string" || token === "") return null;
		// 只把 token 拼进这一条请求的 URL：不打印、不进体检数据、不留引用。
		const exchange = new URL("/", baseUrl);
		exchange.searchParams.set("token", token);
		const response = await httpGetText(exchange.href, { timeoutMs: MUX_FETCH_TIMEOUT_MS, maxBytes: 8 * 1024 });
		const cookies = response.headers["set-cookie"];
		if (!Array.isArray(cookies) || cookies.length === 0) return null;
		return cookies.map((entry) => String(entry).split(";", 1)[0]).join("; ");
	} catch {
		return null;
	}
}

/** 第二手来源：本机 HTTP 首页里出现的 `plugins/…` 资源地址（401 就记一条 note）。 */
async function urlsFromIndexHtml(runtime, baseUrl) {
	const out = [];
	try {
		const cookie = await mintLocalSessionCookie(runtime, baseUrl);
		const response = await httpGetText(`${baseUrl}/`, { cookie, timeoutMs: MUX_FETCH_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 });
		if (response.status !== 200) {
			runtime.mux.indexNote = `本机首页 GET / 返回 HTTP ${String(response.status)}（没有会话 cookie 时 DSH 会 401）`;
			return out;
		}
		for (const match of response.body.matchAll(/(?:src|href)="([^"]*plugins\/[^"]*)"/gu)) out.push(match[1]);
		for (const match of response.body.matchAll(/\/?plugins\/\?\?[^"'\s\\<]+/gu)) out.push(match[0]);
	} catch (error) {
		runtime.mux.indexNote = `读取本机首页失败：${messageOf(error)}`;
	}
	return out;
}

/**
 * 真正的发现实现：集合候选地址 → 逐个 GET 本机 client bundle → 正则抽常量。
 * `apply(ctx, config, { discoverMuxPath })` 可以整体替换它（自测就换成了假的本机）。
 * @returns `{ path, source, candidates, error }`。
 */
async function discoverMuxPath(runtime) {
	const port = toPort(runtime.ctx !== null && typeof runtime.ctx === "object" && runtime.ctx.webServer ? runtime.ctx.webServer.port : undefined);
	if (port === undefined) {
		return { path: null, source: null, candidates: [], error: "ctx.webServer.port 还没就绪（本机 HTTP 还没在监听）" };
	}
	const baseUrl = `http://127.0.0.1:${String(port)}`;
	const raw = [];
	for (const value of urlsFromInjections(runtime.ctx)) raw.push({ raw: value, from: "index-inject" });
	for (const value of await urlsFromIndexHtml(runtime, baseUrl)) raw.push({ raw: value, from: "index-html" });

	const seen = new Set();
	const candidates = [];
	for (const entry of raw) {
		const path = normalizeCandidate(entry.raw);
		if (path === null || seen.has(path)) continue;
		seen.add(path);
		candidates.push({ path, from: entry.from, preferred: path.includes("dsh-api-gateway") });
	}
	candidates.sort((left, right) => Number(right.preferred) - Number(left.preferred));

	for (const candidate of candidates.slice(0, MUX_MAX_CANDIDATES)) {
		let response;
		try {
			response = await httpGetText(`${baseUrl}${candidate.path}`, { timeoutMs: MUX_FETCH_TIMEOUT_MS, maxBytes: MUX_MAX_BUNDLE_BYTES });
		} catch (error) {
			runtime.mux.lastCandidateError = `${candidate.path}：${messageOf(error)}`;
			continue;
		}
		if (response.status !== 200) {
			runtime.mux.lastCandidateError = `${candidate.path}：HTTP ${String(response.status)}（bundle 的 rev 可能已经过期，下一次尝试会重新取地址）`;
			continue;
		}
		const path = extractMuxPath(response.body);
		if (path !== null) {
			return {
				path,
				source: `${candidate.from} → ${candidate.path}`,
				candidates: candidates.map((entry) => `${entry.path}（${entry.from}）`),
				error: null,
			};
		}
		runtime.mux.lastCandidateError = `${candidate.path}：拿到了 ${String(response.body.length)} 字节，但没有 ${MUX_CONST_NAME}`;
	}
	return {
		path: null,
		source: null,
		candidates: candidates.map((entry) => `${entry.path}（${entry.from}）`),
		error: candidates.length === 0
			? `本机 client bundle 的候选地址一个都没拿到${runtime.mux.indexNote === null ? "" : `（${runtime.mux.indexNote}）`}`
			: `${String(Math.min(candidates.length, MUX_MAX_CANDIDATES))} 个候选 client bundle 里都没有 ${MUX_CONST_NAME}${runtime.mux.lastCandidateError === null ? "" : `；最后一次：${runtime.mux.lastCandidateError}`}`,
	};
}

/** 可取消的 sleep（timer 登记在 runtime 上，插件卸载时一并清掉）。 */
function sleep(runtime, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			runtime.timers.delete(timer);
			resolve();
		}, ms);
		unrefTimer(timer);
		runtime.timers.add(timer);
	});
}

/**
 * 启动时的发现循环：几次退避重试；成功就立刻把升级路由挂上。
 * 失败不做任何"猜一个默认路径"的兜底 —— 只报 `muxPathFound:false` 并把终端通道标不可用。
 */
async function runDiscovery(runtime) {
	if (runtime.mux.running !== null) return runtime.mux.running;
	const delays = runtime.mux.delays;
	const task = (async () => {
		for (let index = 0; index < delays.length; index += 1) {
			if (runtime.disposed === true) return;
			if (runtime.data.enabled !== true) return;
			if (index > 0) await sleep(runtime, delays[index]);
			if (runtime.disposed === true || runtime.data.enabled !== true) return;
			runtime.mux.attempts += 1;
			runtime.mux.lastAttemptAt = Date.now();
			let result;
			try {
				result = await runtime.hooks.discover(runtime);
			} catch (error) {
				result = { path: null, source: null, candidates: [], error: messageOf(error) };
			}
			runtime.mux.candidates = Array.isArray(result?.candidates) ? result.candidates : [];
			if (typeof result?.path === "string" && result.path !== "") {
				const changed = runtime.mux.path !== result.path;
				runtime.mux.path = result.path;
				runtime.mux.found = true;
				runtime.mux.source = typeof result.source === "string" ? result.source : null;
				runtime.mux.lastError = null;
				if (changed) {
					info(runtime.ctx, `会话长连接路径从本机 client bundle 提取成功：${result.path}（来源：${runtime.mux.source ?? "?"}）`);
					syncRoutes(runtime);
				}
				notifyFirstRun(runtime);
				return;
			}
			runtime.mux.found = false;
			runtime.mux.lastError = typeof result?.error === "string" && result.error !== "" ? result.error : "未知原因";
			warn(runtime.ctx, `未能提取 ${MUX_CONST_NAME}（第 ${String(runtime.mux.attempts)} 次）：${runtime.mux.lastError}；WebSocket 终端通道暂不可用（HTTP 代理与对话不受影响）`);
			notifyFirstRun(runtime);
		}
		runtime.mux.gaveUp = true;
		warn(runtime.ctx, `${MUX_CONST_NAME} 动态提取彻底失败（${String(runtime.mux.attempts)} 次尝试）；/dev/<id>/<mux> 升级路由一条都没注册。HTTP 代理与对话仍然可用。`);
	})();
	runtime.mux.running = task;
	try {
		await task;
	} finally {
		runtime.mux.running = null;
	}
}

/** 第一次尝试有结论就通知自测（生产里没人传 onReady）；重试继续在后台跑。 */
function notifyFirstRun(runtime) {
	if (runtime.mux.firstRunDone === true) return;
	runtime.mux.firstRunDone = true;
	callOnReady(runtime);
}

/** 状态页每次来读时，如果还没发现路径（且已经放弃或超过间隔）就再试一轮。 */
function lazyDiscovery(runtime) {
	if (runtime.disposed === true || runtime.data.enabled !== true) return;
	if (runtime.mux.found === true || runtime.mux.running !== null) return;
	if (runtime.mux.path !== null && runtime.mux.gaveUp !== true) return;
	if (Date.now() - runtime.mux.lastAttemptAt < MUX_LAZY_MIN_INTERVAL_MS) return;
	runtime.mux.gaveUp = false;
	void runDiscovery(runtime);
}

/** 第一次发现结束时通知自测（`deps.onReady`），生产里谁都不传。 */
function callOnReady(runtime) {
	if (runtime.readyNotified === true) return;
	runtime.readyNotified = true;
	const hook = runtime.hooks.onReady;
	if (typeof hook !== "function") return;
	try {
		hook({
			muxPath: runtime.mux.path,
			muxPathFound: runtime.mux.found,
			enabled: runtime.data.enabled,
			devices: runtime.devices.length,
			error: runtime.mux.lastError,
		});
	} catch (error) {
		warn(runtime.ctx, `onReady 钩子抛出异常：${messageOf(error)}`);
	}
}

//#endregion

//#region 路由装配（含 enabled 的活着切换）

/** 当前设备表 + `enabled` → 垫片脚本（每次注入时现算，设备表 / 开关改了立刻生效）。 */
function currentShimScript(runtime) {
	const localDevice = runtime.localDevice;
	const localName = localEntryName(localDevice, runtime.facts);
	const localCaption = localDevice === undefined || localDevice === null ? "本机" : `${localDevice.name} · 本机`;
	const devices = runtime.devices
		.filter((device) => device !== localDevice && deviceMatchesLocal(device, runtime.facts) !== true)
		.map((device) => ({ id: device.id, name: device.name }));
	return renderShimScript({
		devices,
		localName,
		localCaption,
		helloPath: HELLO_PATH,
		statePath: STATE_PATH,
		// 注意：**不再传 livePath**（2026-10-17 第二刀把垫片那条 `GET /plugin/remote/live`
		// 探针删了；`LIVE_PATH` 只剩客户端半的 `pickDevice()` 与聚合接口在用）。
		// 停用时脚本自己只剩"自检"（不同步 patch、不挂胶囊）；见 remoteShim 的注释。
		enabled: runtime.data.enabled === true,
		sentinelKey: SHIM_SELFTEST_SENTINEL_KEY,
		// 客户端半（设置页）开启成功后会写这个键；垫片同步阶段读到它就走正常模式。
		forceActiveKey: SHIM_FORCE_ACTIVE_KEY,
	});
}

/** 撤掉全部 `/dev/**` 路由（幂等）。 */
function teardownRoutes(runtime) {
	for (const dispose of runtime.routes.values()) {
		try {
			dispose();
		} catch (error) {
			warn(runtime.ctx, `撤掉代理路由失败：${messageOf(error)}`);
		}
	}
	runtime.routes.clear();
	runtime.proxyRouteCount = 0;
}

/** 撤掉注入（幂等）。 */
function teardownInjection(runtime) {
	if (runtime.injection.tap !== null) {
		try {
			runtime.injection.tap.dispose();
		} catch (error) {
			warn(runtime.ctx, `撤掉 tapIndex 注入失败：${messageOf(error)}`);
		}
		runtime.injection.tap = null;
	}
	if (runtime.injection.onInject !== null) {
		try {
			runtime.injection.onInject.dispose();
		} catch (error) {
			warn(runtime.ctx, `撤掉 index-inject 监听失败：${messageOf(error)}`);
		}
		runtime.injection.onInject = null;
	}
}

/**
 * `enabled=false` 时"代理等同没装"：撤掉全部 `/dev/**` 路由。
 * **注意：注入不撤**（垫片永远注入，停用由垫片自检自除，见 `syncInjection`）。
 */
function teardownProxy(runtime) {
	teardownRoutes(runtime);
}

/** 按当前 `enabled` / 设备表 / mux 路径重建 `/dev/**` 路由与注入通道。 */
function syncRoutes(runtime) {
	teardownRoutes(runtime);
	// 计数器跟着重建归零：`proxyRoutes` 是"当前真实的代理路由条数"，不是历史累加值
	//（0.10.6：以前只加不减，数据文件热重载几次之后就虚高）。
	runtime.proxyRouteCount = 0;
	syncInjection(runtime);
	if (runtime.data.enabled !== true) return;
	const muxPath = runtime.mux.found === true ? runtime.mux.path : null;
	for (const device of runtime.devices) {
		if (device === runtime.localDevice || deviceMatchesLocal(device, runtime.facts) === true) continue; // 标记/判定为本机的设备不代理
		// 注意：prefix 必须**不带尾斜杠**。webserver 的 match() 规则是
		// `pathname === prefix || pathname.startsWith(prefix + "/")`，
		// 若注册成 "/dev/self/"，则 "/dev/self/api/x" 既不相等也不以 "/dev/self//" 开头 → 永远不匹配。
		const prefix = `${ROUTE_ROOT}${device.id}`;
		const route = {
			kind: "prefix",
			path: prefix,
			handler: (req, res) => {
				const startedAt = Date.now();
				const logPath = String(req.url ?? "").split("?")[0];
				res.once("finish", () => {
					const status = res.statusCode;
					const fields = { device: device.id, method: req.method, path: logPath, status: status, ms: Date.now() - startedAt };
					if (status >= 500) appendLog("error", "proxy", "proxy failed", fields);
					else if (status >= 400) appendLog("warn", "proxy", "proxy rejected", fields);
					else appendLog("debug", "proxy", "proxy ok", fields);
				});
				try {
					maybeReloadData(runtime, false);
					handleHttpProxy(device, prefix, runtime, req, res);
				} catch (error) {
					const message = messageOf(error);
					warn(runtime.ctx, `设备 "${device.id}" 的请求处理抛出异常：${message}`);
					writeDeviceNotice(res, device, message, 500);
				}
			},
		};
		try {
			runtime.routes.set(`http:${prefix}`, runtime.ctx.webServer.register(route));
			runtime.proxyRouteCount += 1;
		} catch (error) {
			warn(runtime.ctx, `注册设备 "${device.id}" 的 HTTP 代理路由失败：${messageOf(error)}`);
		}
		if (muxPath === null) continue; // 路径没发现 → 不注册升级路由（终端通道不可用）
		const upgradeRoute = {
			path: `${prefix}${muxPath}`,
			handler: (req, socket, head) => {
				try {
					handleUpgradeProxy(device, prefix, runtime, req, socket, head);
				} catch (error) {
					warn(runtime.ctx, `设备 "${device.id}" 的升级处理抛出异常：${messageOf(error)}`);
					try {
						socket.destroy();
					} catch {
						/* 已销毁 */
					}
				}
			},
		};
		try {
			runtime.routes.set(`upgrade:${prefix}`, runtime.ctx.webServer.registerUpgrade(upgradeRoute));
			runtime.proxyRouteCount += 1;
		} catch (error) {
			warn(runtime.ctx, `注册设备 "${device.id}" 的升级路由失败：${messageOf(error)}`);
		}
	}
}

/**
 * 注册两条注入通道（I2：只追加，不动既有内容）。
 *
 * **注入不再受 `enabled` 门控**（软开关：停用只停代理与注入的"效果"）：
 * 桌面壳把注入行缓存到窗口生命周期，关停后老窗口里那行脚本还在、胶囊也还在，
 * 只有重启 APP 才会消失。所以这里永远注入，由垫片脚本自己异步问
 * `GET /plugin/remote/state` 决定要不要自除（清键 / 撤设备表 / 停探测 / 还原原语 / 带哨兵刷新一次）。
 * 注：`enabled` 变了脚本文本也会变（`enabled` / 设备表进 payload），两条通道各自按
 * `SHIM_MARKER` 去重，所以表里始终只有一份。
 */
function syncInjection(runtime) {
	if (runtime.injection.tap === null) {
		const transform = (html) => {
			if (typeof html !== "string" || html.includes(SHIM_MARKER)) return html;
			return insertAfterHead(html, `<script>${currentShimScript(runtime)}</script>`);
		};
		try {
			runtime.injection.tap = { transform, dispose: runtime.ctx.webServer.tapIndex(transform) };
		} catch (error) {
			warn(runtime.ctx, `注册 tapIndex 注入失败：${messageOf(error)}`);
		}
	}
	if (runtime.injection.onInject === null) {
		if (typeof runtime.ctx.on !== "function") {
			warn(runtime.ctx, "ctx.on 不可用，桌面壳里的垫片注入被跳过（浏览器页面不受影响）");
		} else {
			const listener = (table) => {
				if (!Array.isArray(table)) return;
				if (table.some((row) => row && typeof row.text === "string" && row.text.includes(SHIM_MARKER))) return;
				table.push({ kind: "script", placement: "head", text: currentShimScript(runtime) });
			};
			try {
				const dispose = runtime.ctx.on("webserver/index-inject", listener);
				runtime.injection.onInject = { listener, dispose: typeof dispose === "function" ? dispose : () => {} };
			} catch (error) {
				warn(runtime.ctx, `注册 webserver/index-inject 监听失败：${messageOf(error)}`);
			}
		}
	}
}

/** 把一段标记插到 `<head …>` 之后（没有 head 就插到最前面）——纯追加，不改既有内容。 */
function insertAfterHead(html, markup) {
	const open = /<head(?:\s[^>]*)?>/iu.exec(html);
	if (open === null) return markup + html;
	const at = open.index + open[0].length;
	return html.slice(0, at) + markup + html.slice(at);
}

/** 重算本机身份（数据文件 / 设备表变了都要重算）。 */
function refreshLocal(runtime) {
	const resolved = resolveLocalDevice(runtime.devices, runtime.data.current, runtime.facts);
	runtime.localDevice = resolved.device;
	runtime.localVia = resolved.via;
	info(runtime.ctx, resolved.device === undefined
		? `本机自验证：没有设备命中本机事实（hostname ${runtime.facts.hostname === "" ? "?" : runtime.facts.hostname} / port ${String(runtime.facts.port ?? "?")}），也没有 current 兜底 → 全部 ${String(runtime.devices.length)} 台都注册代理路由`
		: resolved.via === "auto"
			? `本机自验证：URL 匹配命中设备 "${resolved.device.id}"（${resolved.device.authority}）→ 判为本机，不注册代理路由`
			: `本机自验证：URL 匹配未命中任何设备，回退数据文件的 current 认领 "${resolved.device.id}"（${resolved.device.authority}）→ 判为本机，不注册代理路由`);
}

/** 设备表变化后：重新归一化 → 重算本机 → 重建路由。 */
function refreshDevices(runtime) {
	const devices = [];
	const seen = new Set();
	for (const entry of runtime.data.devices) {
		const device = normalizeDeviceEntry(runtime.ctx, entry, seen);
		if (device !== undefined) devices.push(device);
	}
	runtime.devices = devices;
	refreshLocal(runtime);
	syncRoutes(runtime);
}

//#endregion

//#region 体检 / 状态数据

/**
 * 官方 `@deepseek-ai/dsh-client-connection` 的 `assertTrustedAuthority` 等价判定。
 *
 * 一条入口地址必须是**规范的 bare authority**（`host` 或 `host:port`）——即"经 WHATWG 解析后
 * 原样返回（大小写除外）"。官方在 connection 激活时对每条都 assert：任何"解析会被静默改写"
 * 的值都会让**那一行激活失败**，所以写进 profile 之前必须在这里先挡住并给出中文原因。
 * 被拒的典型：带路径/用户名（`harness.internal/path`、`user@harness.internal` —— 会授权到里面那个主机）、
 * 首尾空白、多余的冒号、补零端口（会把"精确端口"放宽成所有端口）、非规范写法
 * （`0x7f.0.0.1`、百分号编码、未加方括号的 IPv6）。
 *
 * 出处（app.asar 抽出，与 `assertTrustedAuthority` / `canonicalAuthority` 逐字对齐）：
 * `dsh-client-connection/lib/index.js` 的 `canonicalAuthority(entry, entryUrl)`：
 * `const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;`
 * `return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;`
 * @param entry - 配置里那一条的原文。
 * @returns 规范形式（官方会接受它），或 `undefined`（会被官方拒绝 → 我们绝不写进去）。
 */
function canonicalTrustedAuthority(entry) {
	const raw = typeof entry === "string" ? entry : String(entry ?? "");
	try {
		const parsed = new URL(`http://${raw}`);
		const port = parsed.port !== "" ? parsed.port : new URL(`https://${raw}`).port;
		const canonical = port === "" ? parsed.hostname : `${parsed.hostname}:${port}`;
		return canonical === raw.toLowerCase() ? canonical : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 本机可用于访问的 IPv4 地址：回环在前，然后各网卡的**非回环** IPv4。
 * 每次都**现读**一次网卡（用户可能刚连上 ZeroTier/EasyTier），读不到就退回装配时那份事实。
 * `0.0.0.0` 是"所有网卡"的绑定写法、不是地址，一律排除。
 */
function localIpv4List(runtime) {
	const seen = [];
	const push = (value) => {
		const address = typeof value === "string" ? value.trim() : "";
		if (!isIpv4(address) || address === "0.0.0.0" || seen.includes(address)) return;
		seen.push(address);
	};
	push("127.0.0.1");
	try {
		const facts = collectHostFacts(runtime.ctx);
		for (const ip of Array.isArray(facts.ips) ? facts.ips : []) push(ip);
	} catch {
		/* 读不到网卡：只给回环 */
	}
	if (seen.length === 1 && runtime.facts !== null && typeof runtime.facts === "object" && Array.isArray(runtime.facts.ips)) {
		for (const ip of runtime.facts.ips) push(ip);
	}
	return seen;
}

/** 上面那些地址**每条带上端口**（`192.0.2.4:19387`）——「填入本机地址」直接逐行填。 */
function localAddressList(runtime, port) {
	const addresses = localIpv4List(runtime);
	const normalized = toPort(port);
	if (normalized === undefined) return addresses;
	return addresses.map((address) => `${address}:${String(normalized)}`);
}

/** 取 config-editor 服务（只认形状：`edit()` + `entries()`；形状不认识就当没有）。 */
function configEditorOf(runtime) {
	const editor = runtime.configEditor;
	if (editor === null || editor === undefined) return undefined;
	if (typeof editor.edit !== "function" || typeof editor.entries !== "function") return undefined;
	return editor;
}

/**
 * 定位「配置」块要写的那两行 Loader entry（`webserver` / `connection`）。
 *
 * 为什么**每次都要重新取**：`ctx.configEditor.edit()` 改完 config 之后走的是 Loader 的正常
 * 生命周期，`webserver` / `connection` 会被**重新激活**（ordinary remount），而本插件注入的正是
 * 这两个服务 → 本插件自身也会被重新装配，之前抓到的 entry 对象随即不在 loader 里了
 * （旧对象再喂给 `edit()` 会抛 "Configuration entry is no longer available"）。
 * @returns `{ editor, webServer, connection }`，任一缺失就返回 `null`（调用方如实报错，不假成功）。
 */
function accessTargets(runtime) {
	const editor = configEditorOf(runtime);
	if (editor === undefined) return null;
	let rows;
	try {
		rows = editor.entries();
	} catch {
		return null;
	}
	if (!Array.isArray(rows)) return null;
	const pick = (id) => rows.find((entry) => entry !== null && typeof entry === "object"
		&& entry.options !== null && typeof entry.options === "object" && entry.options.id === id);
	const webServer = pick(WEBSERVER_ENTRY_ID);
	const connection = pick(CONNECTION_ENTRY_ID);
	if (webServer === undefined || connection === undefined) return null;
	return { editor, webServer, connection };
}

/** 读一行 entry 的当前 config（对象；读不到就当空对象）。 */
function entryConfig(entry) {
	const config = entry !== null && typeof entry === "object" && entry.options !== null && typeof entry.options === "object"
		? entry.options.config
		: undefined;
	return config !== null && typeof config === "object" && Array.isArray(config) !== true ? config : {};
}

/**
 * `POST /plugin/remote/access` 的实现：把「配置」块写进 profile patch（**官方 `ctx.configEditor.edit`**，
 * 绝不手改 YAML）。
 *
 * 关键约束：`edit(entry, change)` 是**整行 config 替换**（`change` 收到当前值，返回什么就写什么），
 * 所以必须"展开当前值再只覆盖要改的键"——否则 webserver 的 compression 三件套、connection 的
 * cookieMaxAgeDays 会被一起抹掉。`host` 固定写 {@link BIND_HOST}，界面不提供改它的入口。
 *
 * 只写**真的变了**的那一行：端口没变就不动 webserver（避免无谓的监听重启）。
 * 顺序也是刻意的：先 connection、后 webserver —— `@deepseek-ai/dsh-host-webserver` 的 dispose 会
 * `server.closeAllConnections()`，端口一变，**浏览器场景下这条响应所在的 socket 会被一起关掉**
 * （桌面 App 的 fetch 走壳的进程内桥接，不受影响）。所以"改端口"与"浏览器正在看的这个页面"本来就
 * 不可能同时成立：用户重启后换到新端口重开即可。端口没变时（只改入口地址）这条响应一定能到达。
 * @returns `{ status, body }`（status/body 直接回给客户端；失败一律 `{ok:false,error}` + 合适状态码）。
 */
async function applyAccessConfig(runtime, payload) {
	const input = payload !== null && typeof payload === "object" && Array.isArray(payload) !== true ? payload : {};
	if (runtime.data.enabled !== true) {
		return { status: 409, body: { ok: false, error: "插件已停用（enabled=false）：请先在上面的「插件开关」里开启，再改基础配置。" } };
	}
	const has = (key) => Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null;
	const wantsPort = has("port");
	const wantsHosts = has("trustedHosts");
	const wantsForkTail = has(DATA_FORK_TAIL_FIELD);
	const wantsCookieDays = has("cookieMaxAgeDays");
	const wantsEdge = has("edgeEnabled") || has("edgePort");
	if (wantsPort !== true && wantsHosts !== true && wantsForkTail !== true && wantsCookieDays !== true && wantsEdge !== true) {
		return {
			status: 400,
			body: { ok: false, error: "请求体里既没有 port、trustedHosts、forkTailN、cookieMaxAgeDays，也没有 edgeEnabled/edgePort：没有要写入的字段。" },
		};
	}

	// cookie 有效期（官方 connection 的 cookieMaxAgeDays，默认 30）：与入口地址同一行，走 profile。
	let cookieDays;
	if (wantsCookieDays) {
		const raw = input.cookieMaxAgeDays;
		const shapeOk = typeof raw === "number" ? Number.isInteger(raw) : typeof raw === "string" && /^\d+$/u.test(raw);
		cookieDays = shapeOk ? Number(raw) : undefined;
		if (cookieDays === undefined || cookieDays < 1 || cookieDays > MAX_COOKIE_AGE_DAYS) {
			return { status: 400, body: { ok: false, error: `cookie 天数必须是 1..${String(MAX_COOKIE_AGE_DAYS)} 的整数（收到 ${plainValue(raw)}）。` } };
		}
	}


	// 「分叉带走的条数」跟端口/入口地址是两回事：它写**数据文件**（不碰 profile），改完立即生效。
	let forkTail;
	if (wantsForkTail) {
		forkTail = normalizeForkTail(input[DATA_FORK_TAIL_FIELD]);
		if (forkTail === undefined) {
			return {
				status: 400,
				body: {
					ok: false,
					error: `分叉带走的条数必须是 ${String(FORK_MIN_TAIL)}..${String(FORK_MAX_TAIL)} 的整数（收到 ${plainValue(input[DATA_FORK_TAIL_FIELD])}）。`,
				},
			};
		}
	}

	let port;
	if (wantsPort) {
		const raw = input.port;
		// 只认"整数 1..65535"：数字要整数，字符串必须**原样**全是数字（" 19387 " 这类带空白的也不收）。
		const shapeOk = typeof raw === "number" ? Number.isInteger(raw) : typeof raw === "string" && /^\d+$/u.test(raw);
		port = shapeOk ? toPort(raw) : undefined;
		if (port === undefined) {
			return { status: 400, body: { ok: false, error: `端口必须是 1..65535 的整数（收到 ${plainValue(raw)}）。` } };
		}
	}

	let trustedHosts;
	if (wantsHosts) {
		if (Array.isArray(input.trustedHosts) !== true) {
			return { status: 400, body: { ok: false, error: "trustedHosts 必须是字符串数组（界面上一行一个 Host 值）。" } };
		}
		const cleaned = [];
		for (const raw of input.trustedHosts) {
			if (typeof raw !== "string") {
				return { status: 400, body: { ok: false, error: `入口地址必须是字符串（收到 ${plainValue(raw)}）。` } };
			}
			const entry = raw.trim();
			if (entry === "") continue; // 空行是正常的（界面里多一个换行而已），直接丢掉
			// 明确挡掉两种"看起来像网段"的写法：
			//  - `192.0.2.0/24`：官方也会拒（WHATWG 会把它解析出 path）；
			//  - `192.0.2.*.*`：官方**会收下**，但匹配是 hostname 字符串全等（没有通配符），
			//    于是它永远匹配不上、请求照样 403 —— 静默陷阱，所以在写盘前按"不支持"拒掉。
			if (entry.includes("*")) {
				return {
					status: 400,
					body: {
						ok: false,
						error: `入口地址 ${plainValue(JSON.stringify(entry))} 里有通配符 *：这里不支持通配符、也不支持网段。`
							+ "要一条一个具体主机地址（例如 192.0.2.4，或带端口精确匹配 192.0.2.4:19387）；"
							+ "不带端口 = 那台主机的任意端口都认。",
					},
				};
			}
			if (entry.includes("://")) {
				return {
					status: 400,
					body: {
						ok: false,
						error: `入口地址 ${plainValue(JSON.stringify(entry))} 带了协议前缀：这里只写主机`
							+ "（例如 192.0.2.4，或带端口 192.0.2.4:19387），不要 http://。",
					},
				};
			}
			if (entry.includes("/")) {
				return {
					status: 400,
					body: {
						ok: false,
						error: `入口地址 ${plainValue(JSON.stringify(entry))} 里有 /：这里不支持网段/CIDR。`
							+ "要一条一个具体主机地址（例如 192.0.2.4，或带端口精确匹配 192.0.2.4:19387）。",
					},
				};
			}
			if (canonicalTrustedAuthority(entry) === undefined) {
				return {
					status: 400,
					body: {
						ok: false,
						error: `入口地址 ${plainValue(JSON.stringify(entry))} 不合格：必须是规范的 host 或 host:port`
							+ "（不能带 http://、路径、用户名、用户名@主机、首尾空白、补零端口或 0x 开头的写法）。"
							+ "官方在激活 connection 时会拒绝这类值，所以这里先挡住。",
					},
				};
			}
			if (cleaned.includes(entry) !== true) cleaned.push(entry);
		}
		// 允许留空 —— 官方 `trustedHosts` 的默认就是空数组（只信 loopback）；页面上不再提供这一格，
		// 但接口保持这个能力（网络白名单怎么列是网络那摊事，插件只负责如实写进 profile）。
		if (cleaned.length > MAX_TRUSTED_HOSTS) {
			return { status: 400, body: { ok: false, error: `入口地址最多 ${String(MAX_TRUSTED_HOSTS)} 条（收到 ${String(cleaned.length)} 条）。` } };
		}
		trustedHosts = cleaned;
	}

	// ---- 对外入口（0.10.3）----
	// 只做**校验**：1..65535，且不能与本机 DSH 自己的端口相同。
	// **不再改写 profile**（没有历史用户；新装用户的 profile 本来就是 127.0.0.1 + 空白名单）。
	let edgeNext;
	if (wantsEdge) {
		const enabled = has("edgeEnabled") ? input.edgeEnabled === true : runtime.data.edge.enabled === true;
		let edgePort = toPort(runtime.data.edge.port);
		if (has("edgePort")) {
			const raw = input.edgePort;
			const shapeOk = typeof raw === "number" ? Number.isInteger(raw) : typeof raw === "string" && /^\d+$/u.test(raw);
			edgePort = shapeOk ? toPort(raw) : undefined;
			if (edgePort === undefined) {
				return { status: 400, body: { ok: false, error: `对外端口必须是 1..65535 的整数（收到 ${plainValue(raw)}）。` } };
			}
		}
		edgeNext = { enabled: enabled === true, port: edgePort };
		const livePort = toPort(readAccess(runtime).port);
		if (edgeNext.enabled === true && toPort(edgeNext.port) !== undefined && toPort(edgeNext.port) === livePort) {
			return {
				status: 409,
				body: {
					ok: false,
					error: `对外端口 ${String(livePort)} 正是本机 DSH 自己在用的端口：请换一个（例如 ${String(livePort + 1)}）。本插件不去改 DSH 自己的配置。`,
				},
			};
		}
	}

	// 只改「分叉带走的条数」/「对外入口」：完全不碰 profile（也就不需要 config-editor），直接落盘数据文件。
	if (wantsPort !== true && wantsHosts !== true && wantsCookieDays !== true) {
		return commitLocalConfig(runtime, {
			forkTailN: wantsForkTail ? forkTail : undefined,
			edge: edgeNext,
		});
	}

	const targets = accessTargets(runtime);
	if (targets === null) {
		return {
			status: 503,
			body: {
				ok: false,
				error: "这台机器的 DSH 没有可用的 config-editor（需要 ctx.configEditor 的 edit() 与 entries()），"
					+ `或 profile 的 cordis.patch.yml 里找不到 ${WEBSERVER_ENTRY_ID} / ${CONNECTION_ENTRY_ID} 两行，`
					+ "因此无法安全地写入配置（本插件绝不手改 YAML）。请手改 profile，片段见 README「访问配置」。",
			},
		};
	}
	// 先把「分叉带走的条数」落盘：它独立于 profile 写入（端口/入口地址失败也不该把它丢掉）。
	if (wantsForkTail || wantsEdge) {
		const applied = commitLocalConfig(runtime, {
			forkTailN: wantsForkTail ? forkTail : undefined,
			edge: edgeNext,
		});
		if (applied.status !== 200) return applied;
	}
	const { editor } = targets;
	const currentWeb = entryConfig(targets.webServer);
	const currentConn = entryConfig(targets.connection);
	const currentPort = toPort(currentWeb.port);
	const currentHost = typeof currentWeb.host === "string" ? currentWeb.host : "";
	const currentHosts = Array.isArray(currentConn.trustedHosts) ? currentConn.trustedHosts.filter((entry) => typeof entry === "string") : [];
	const cookieMaxAgeDays = Number.isFinite(currentConn.cookieMaxAgeDays) ? currentConn.cookieMaxAgeDays : null;
	const nextHosts = wantsHosts === true ? trustedHosts : currentHosts;
	const nextCookieDays = wantsCookieDays === true ? cookieDays : cookieMaxAgeDays;

	// 只写真的变了的行：端口没改就不碰 webserver（它的重新激活 = HTTP 监听重启）。
	const webChanged = wantsPort === true && (port !== currentPort || currentHost !== BIND_HOST);
	const connChanged = (wantsHosts === true && JSON.stringify(trustedHosts) !== JSON.stringify(currentHosts))
		|| (wantsCookieDays === true && cookieDays !== cookieMaxAgeDays);
	const written = {
		host: BIND_HOST,
		port: wantsPort === true ? port : (currentPort === undefined ? null : currentPort),
		trustedHosts: nextHosts,
		cookieMaxAgeDays: nextCookieDays,
	};

	try {
		if (connChanged) {
			// 整行替换语义：入口地址与 cookie 天数一起展开写，别的键（如官方未来的新字段）原样保留。
			await editor.edit(targets.connection, (current) => ({
				...current,
				trustedHosts: nextHosts,
				...(nextCookieDays === null ? {} : { cookieMaxAgeDays: nextCookieDays }),
			}));
		}
	} catch (error) {
		return {
			status: 500,
			body: { ok: false, error: `写入 profile 失败（入口地址/cookie 那一行）：${plainValue(messageOf(error))}。config-editor 会回滚这一次改动，所以本次没有生效；请到体检块看当前运行值再重试。` },
		};
	}
	if (webChanged) {
		try {
			// 上一笔 edit 已经把 webserver/connection 重新激活（而本插件注入的正是这两个服务 →
			// 本插件自身也被重新装配），所以 entry 必须**重新取一次**：旧对象已经不在 loader 里了。
			const fresh = accessTargets(runtime);
			const row = fresh === null ? undefined : fresh.webServer;
			if (row === undefined) throw new Error(`重新装配之后找不到 ${WEBSERVER_ENTRY_ID} 这行了`);
			await editor.edit(row, (current) => ({ ...current, host: BIND_HOST, port }));
		} catch (error) {
			return {
				status: 500,
				body: {
					ok: false,
					error: `入口地址那一行已经写入；端口这一行没写成功：${plainValue(messageOf(error))}。`
						+ "config-editor 会回滚它自己那一次改动（入口地址的写入不受影响），请到体检块看当前运行值再重试。",
				},
			};
		}
	}
	const body = { ok: true, restartRequired: true, written };
	if (wantsForkTail) body.forkTailN = effectiveForkTail(runtime);
	if (wantsCookieDays) body.cookieMaxAgeDays = effectiveCookieDays(runtime);
	return { status: 200, body };
}

/** 当前生效的 cookie 天数（读活的 connection.browserAuth，读不到回落 profile 行里的值）。 */
function effectiveCookieDays(runtime) {
	const access = readAccess(runtime);
	return access.cookieMaxAgeDays === null ? null : access.cookieMaxAgeDays;
}


/**
 * 把**不碰 profile**的那一项落盘（数据文件）并立即生效：`forkTailN`（「分叉带走的条数」）。
 * `undefined` 表示"这一项不动"。
 */
function commitLocalConfig(runtime, change) {
	const before = { forkTailN: runtime.data.forkTailN, edge: { ...runtime.data.edge } };
	if (change.forkTailN !== undefined) runtime.data.forkTailN = change.forkTailN;
	if (change.edge !== undefined && change.edge !== null) {
		runtime.data.edge = { enabled: change.edge.enabled === true, port: change.edge.port };
	}
	try {
		persistDataFile(runtime);
	} catch (error) {
		runtime.data.forkTailN = before.forkTailN;
		runtime.data.edge = before.edge;
		return { status: 500, body: { ok: false, error: `写入数据文件失败（本次没有保存）：${plainValue(messageOf(error))}` } };
	}
	// 数据文件改动即时生效（不需要重启）；对外入口随之起/停。
	if (change.edge !== undefined && change.edge !== null) syncEdge(runtime);
	const body = {
		ok: true,
		note: typeof change.note === "string" && change.note !== "" ? change.note : "已保存：立即生效，不需要重启。",
		restartRequired: change.restartRequired === true,
	};
	if (change.forkTailN !== undefined) body.forkTailN = effectiveForkTail(runtime);
	if (change.edge !== undefined && change.edge !== null) body.edge = buildEdgeState(runtime);
	return { status: 200, body };
}

/**
 * 把「分叉带走的条数」落盘（数据文件 `$DSH_HOME/remote-devices.json` 的 `forkTailN`）。
 * 0.9.0 起统一走 {@link commitLocalConfig}（对外入口也在那边一起落盘）；保留这个薄壳给自测与老调用点。
 * @returns `{ status, body }`（形状与 {@link applyAccessConfig} 一致）。
 */
function commitForkTail(runtime, value) {
	return commitLocalConfig(runtime, { forkTailN: value });
}

/** 读当前的访问配置（活的 service 字段；读不到就是空/ null，绝不猜）。 */
function readAccess(runtime) {
	const ctx = runtime.ctx;
	const webServer = ctx !== null && typeof ctx === "object" ? ctx.webServer : undefined;
	const config = webServer !== undefined && webServer !== null && webServer.config !== null && typeof webServer.config === "object"
		? webServer.config
		: undefined;
	let host = "";
	if (config !== undefined && typeof config.host === "string") host = config.host;
	else if (webServer !== undefined && webServer !== null && typeof webServer.host === "string") host = webServer.host;
	let port = webServer !== undefined && webServer !== null ? toPort(webServer.port) : undefined;
	if (port === undefined && config !== undefined) port = toPort(config.port);
	let trustedHosts = [];
	let cookieMaxAgeDays = null;
	const connection = ctx !== null && typeof ctx === "object" ? ctx.connection : undefined;
	if (connection !== undefined && connection !== null && typeof connection === "object") {
		if (Array.isArray(connection.trustedHosts)) trustedHosts = connection.trustedHosts.filter((entry) => typeof entry === "string");
		const auth = connection.browserAuth;
		const milliseconds = auth !== null && typeof auth === "object" && Number.isFinite(auth.maxAgeMilliseconds) ? auth.maxAgeMilliseconds : undefined;
		if (milliseconds !== undefined && milliseconds > 0) cookieMaxAgeDays = Math.round(milliseconds / 86_400_000);
	}
	return {
		host,
		port: port === undefined ? null : port,
		trustedHosts,
		cookieMaxAgeDays,
		/** 本机可访问地址（回环 + 各网卡 IPv4），每条都带**当前端口** —— 「配置」块的「填入本机地址」用它。 */
		localAddresses: localAddressList(runtime, port),
		/** 能不能写：config-editor 在场、且 webserver / connection 两行都能定位（见 applyAccessConfig）。 */
		writable: accessTargets(runtime) !== null,
		/** 「分叉到…」带走的条数（最近 N 条消息）：设置页「配置」块里那一格；存数据文件、**立即生效**。 */
		forkTailN: effectiveForkTail(runtime),
		forkTailDefault: FORK_DEFAULT_TAIL,
		forkTailMax: FORK_MAX_TAIL,
	};
}

/** token 存储路线的一句话说明（体检页 notes 里最显眼的一条）。 */
function tokenStorageNote(runtime) {
	const plaintextCount = new Set([...Object.keys(runtime.fileTokens), ...Object.keys(runtime.seedTokens)]).size;
	if (runtime.tokens.mode() === "credentials") {
		return `token 存储 = DSH 凭据服务（ctx.credentials），值在 $DSH_HOME/.credentials.yaml；数据文件里只有 id/name/url。`;
	}
	const hardening = runtime.hardeningNote === "" ? "文件里当前没有 token，所以还没执行过权限收紧" : runtime.hardeningNote;
	if (plaintextCount > 0) {
		return `⚠ token 明文存储：DSH 凭据服务（ctx.credentials）不可用，${String(plaintextCount)} 台设备的 token 明文保存在 ${runtime.dataPath} 的 ${DATA_TOKENS_FIELD} 字段里（已尝试收紧：${hardening}）。`;
	}
	return `token 存储 = 数据文件（退化路线）：DSH 凭据服务不可用，当前还没有 token。`;
}

/** 桥接状态（给设置页/胶囊看）：模式 + 已搬运计数 + 最近一次目标设备与时间。 */
function buildBridgeState(runtime) {
	return {
		mode: bridgeMode(runtime),
		moved: typeof runtime.bridgeMoved === "number" ? runtime.bridgeMoved : 0,
		lastAt: typeof runtime.bridgeLastAt === "number" ? runtime.bridgeLastAt : null,
		target: typeof runtime.bridgeTarget === "string" ? runtime.bridgeTarget : null,
	};
}

/** 组装体检 / 状态一次性数据（契约里的形状，字段名不许改）。 */
/** 版本比较：a > b 返回正数。 */
function compareVersions(a, b) {
	const left = String(a).split(".").map((part) => Number(part) || 0);
	const right = String(b).split(".").map((part) => Number(part) || 0);
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

/** 直接 https 取 JSON（8 秒超时，只用于版本检查）。 */
function httpsGetJson(url, timeoutMs) {
	return new Promise((resolve, reject) => {
		let done = false;
		const request = httpsRequest(
			url,
			{ method: "GET", headers: { accept: "application/vnd.github+json", "user-agent": "dsh-remote/" + VERSION } },
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
					if (body.length > 256 * 1024) {
						done = true;
						request.destroy(new Error("响应过大"));
					}
				});
				response.on("end", () => {
					if (done) return;
					done = true;
					if (response.statusCode !== 200) {
						reject(new Error("HTTP " + String(response.statusCode)));
						return;
					}
					try {
						resolve(JSON.parse(body));
					} catch (error) {
						reject(new Error("响应不是 JSON"));
					}
				});
			},
		);
		request.on("error", (error) => {
			if (done) return;
			done = true;
			reject(error);
		});
		request.setTimeout(timeoutMs === undefined ? 8000 : timeoutMs, () => {
			if (done) return;
			done = true;
			request.destroy(new Error("超时"));
		});
		request.end();
	});
}

/** curl 兜底（会继承 https_proxy / HTTPS_PROXY 环境变量）。 */
function curlGetJson(url) {
	const text = execFileSync(
		"curl",
		["-sS", "-m", "8", "-L", "-H", "accept: application/vnd.github+json", "-H", "user-agent: dsh-remote/" + VERSION, url],
		{ encoding: "utf8", timeout: 12000 },
	);
	return JSON.parse(text);
}

/**
 * 版本检查（0.16.0）：查 GitHub 最新 Release，与当前 VERSION 比较。
 * - 只读公开 API，不发送任何本机信息；失败只记 debug 日志，不影响功能；
 * - `DSH_REMOTE_UPDATE_CHECK=off` 可关闭；结果缓存在 `runtime.update`（/state 可见）；
 * - 每 6 小时复查一次。
 */
async function checkForUpdate(runtime) {
	if (String(process.env.DSH_REMOTE_UPDATE_CHECK ?? "").trim().toLowerCase() === "off") return;
	const result = { checkedAt: new Date().toISOString(), latest: "", hasUpdate: false, url: "https://github.com/alepc-cn/dsh-remote/releases", error: null };
	const url = "https://api.github.com/repos/alepc-cn/dsh-remote/releases/latest";
	try {
		let body;
		try {
			body = await httpsGetJson(url);
		} catch (directError) {
			body = curlGetJson(url);
		}
		const latest = String(body !== null && typeof body === "object" && body.tag_name !== undefined ? body.tag_name : "").replace(/^v/u, "").trim();
		result.latest = latest;
		result.hasUpdate = latest !== "" && compareVersions(latest, VERSION) > 0;
		if (body !== null && typeof body === "object" && typeof body.html_url === "string" && body.html_url !== "") result.url = body.html_url;
		appendLog(result.hasUpdate ? "info" : "debug", "update", result.hasUpdate ? "new version available" : "already latest", { current: VERSION, latest: latest });
	} catch (error) {
		result.error = messageOf(error);
		appendLog("debug", "update", "version check failed", { error: result.error });
	}
	runtime.update = result;
	if (runtime.updateTimer === undefined) {
		const periodicCheck = setInterval(() => {
			void checkForUpdate(runtime);
		}, 6 * 60 * 60 * 1000);
		runtime.updateTimer = unrefTimer(periodicCheck);
	}
}

/** 状态里第一次被读到时踢一次版本检查（不阻塞任何请求）。 */
function ensureUpdateCheck(runtime) {
	if (runtime.update !== undefined) return;
	runtime.update = null;
	const firstCheck = setTimeout(() => {
		void checkForUpdate(runtime);
	}, 3000);
	unrefTimer(firstCheck);
}

function buildState(runtime) {
	ensureUpdateCheck(runtime);
	const notes = [];
	notes.push(tokenStorageNote(runtime));
	notes.push(`远端会话 cookie 存储 = ${runtime.tokens.mode() === "credentials"
		? "DSH 凭据服务（$DSH_HOME/.credentials.yaml）"
		: `数据文件 ${runtime.dataPath} 的 ${DATA_SESSIONS_FIELD} 字段（明文）`}。`);
	if (runtime.dataInvalid !== null && runtime.dataInvalid !== undefined) {
		notes.push(`⚠ 数据文件 ${runtime.dataPath} 存在但无法解析（${runtime.dataInvalid}）：本次没有种子、也没有覆盖它，设备表按空处理。请修好或删掉它。`);
	}
	if (runtime.tokens.mode() === "credentials" && Object.keys(runtime.seedTokens).length > 0) {
		notes.push(`还有 ${String(Object.keys(runtime.seedTokens).length)} 条来自 profile 配置种子的 token 正在等落点判定（凭据服务 vs 数据文件）。`);
	}
	if (runtime.data.enabled !== true) {
		notes.push(`插件已停用（enabled=false）：没有注册任何 /dev/** 路由（等同没装）；设置页照常可读，POST ${PLUGIN_ROUTE}/enabled 改回 true 即可恢复。`);
	}
	if (runtime.mux.found === true) {
		notes.push(`${MUX_CONST_NAME} = ${String(runtime.mux.path)}（动态提取自本机 client bundle；来源：${runtime.mux.source ?? "?"}）。`);
	} else {
		notes.push(`⚠ ${MUX_CONST_NAME} 未能从本机 client bundle 提取（已尝试 ${String(runtime.mux.attempts)} 次）：${runtime.mux.lastError ?? "尚未尝试"}。终端通道（/dev/<id>/<mux> 的 WebSocket 升级）**不可用**；HTTP 代理与对话不受影响。`);
		if (runtime.mux.indexNote !== null) notes.push(runtime.mux.indexNote);
		if (runtime.mux.candidates.length > 0) notes.push(`候选地址：${runtime.mux.candidates.slice(0, 6).join("、")}${runtime.mux.candidates.length > 6 ? " …" : ""}`);
	}
	if (runtime.injectionSeen !== true) {
		notes.push(runtime.data.enabled === true
			? "垫片还没有报到过（injectionSeen=false）：如果窗口已经打开过，说明本机页面注入可能失效（DSH 升级后常见），体检的人应刷新一次窗口再看。"
			: "垫片不会报到：插件处于停用状态。");
	}
	notes.push(`访问配置可写 = ${String(configEditorOf(runtime) !== undefined)}；当前运行值见 access（host/port/trustedHosts/cookieMaxAgeDays/localAddresses）。`);
	notes.push(`「分叉到 <设备>」带走的条数 = ${String(effectiveForkTail(runtime))}（可用 ${String(FORK_MIN_TAIL)}..${String(FORK_MAX_TAIL)}，缺省 ${String(FORK_DEFAULT_TAIL)}）。`);
	const edgeState = buildEdgeState(runtime);
	notes.push(edgeState.enabled
		? `对外入口：监听 0.0.0.0:${String(edgeState.port)}${edgeState.running ? "（正在监听）" : `（**没在监听**：${edgeState.error ?? "未知原因"}）`} → 改写成 127.0.0.1:${String(edgeState.targetPort ?? "?")} 再转给本机 DSH；/plugin/** 一律 403。`
		: "对外入口：未启用（外部访问按 profile 的 webserver.host/port + connection.trustedHosts 走）。");
	if (runtime.credentials === undefined || runtime.credentials === null) {
		notes.push("ctx.credentials 不可用（组合里没有凭据服务）：token 只能走数据文件退化路线（见上）。");
	}
	// 0.13.1：401/403 的"人话"提示（设备行的 lastError 也会用同一句；日志在打的时候已经说过一次）。
	if (runtime.authNotices instanceof Map && runtime.authNotices.size > 0) {
		for (const device of runtime.devices) {
			const notice = runtime.authNotices.get(device.id);
			if (notice === undefined) continue;
			notes.push(`设备 "${device.name}"：${notice.message}`);
		}
	}
	if (runtime.configEditorNote !== "") {
		notes.push(runtime.configEditorNote);
	} else if (configEditorOf(runtime) === undefined) {
		// `ctx.inject("configEditor")` 一次都没触发（组合里没有 config-editor）→ 说明白，
		// 别让人以为「配置」块的保存按钮坏了。
		notes.push("⚠ config-editor 还没接入（ctx.inject(\"configEditor\") 没有触发）：这台机器的组合里没有 @deepseek-ai/dsh-config-editor，或它还没装载完。设置页「配置」块的保存会失败（503 {ok:false}），要改请手改 profile 的 cordis.patch.yml（片段见 README）。");
	}
	// 两条新能力：各自一行"可用与否 + 最近一次失败原因"（说明书类文案已搬去 README）。
	notes.push(opNote(runtime, "download", "另存为"));
	notes.push(opNote(runtime, "fork", "分叉到"));
{
	// 跨机附件搬运的状态（设置页「体检/notes」直接渲染宿主给的备注，所以这里加一条就等于给了客户端提示）
	const bridge = buildBridgeState(runtime);
	const bridgeModeText = bridge.mode === "on" ? "已启用" : (bridge.mode === "dryrun" ? "干跑（只记录不改写）" : "未启用（默认关闭；在数据目录放 dsh-remote-bridge.enabled 打开）");
	notes.push(`跨机附件搬运 = ${bridgeModeText}${bridge.moved > 0 ? `；已搬运 ${String(bridge.moved)} 个文件${bridge.target === null ? "" : `（最近到 ${bridge.target}）`}` : ""}。`);
}
	if (runtime.sessionController === undefined || runtime.sessionController === null) {
		notes.push("分叉读本机源会话走本机 HTTP /api（ctx.sessionController 不可用）。");
	}

	const devices = runtime.devices.map((device) => {
		const reach = runtime.reach.get(device.id);
		const notice = runtime.authNotices instanceof Map ? runtime.authNotices.get(device.id) : undefined;
		return {
			id: device.id,
			name: device.name,
			url: device.rawUrl,
			local: device === runtime.localDevice || deviceMatchesLocal(device, runtime.facts) === true,
			reachable: reach === undefined ? null : reach.reachable,
			// 0.13.1：认证被拒时给一句能照着做的提示（而不是只有 "HTTP 401"）。
			lastError: reach === undefined ? (notice === undefined ? null : notice.message) : (reach.lastError ?? (notice === undefined ? null : notice.message)),
			lastOkAt: reach === undefined ? null : reach.lastOkAt,
		};
	});

	return {
		enabled: runtime.data.enabled === true,
		version: VERSION,
		update: runtime.update === undefined ? null : runtime.update,
		localDevice: runtime.localDevice === undefined || runtime.localDevice === null
			? null
			: {
				id: runtime.localDevice.id,
				name: runtime.localDevice.name,
				hostname: typeof runtime.facts.hostname === "string" ? runtime.facts.hostname : "",
				via: runtime.localVia,
			},
		devices,
		access: readAccess(runtime),
		/** 对外入口（0.10.0）：设置页「配置」块那一栏用它显示开关/端口/最近一次失败。 */
		edge: buildEdgeState(runtime),
		bridge: buildBridgeState(runtime),
		diagnostics: {
			logFile: resolveLogFile(),
			logDir: dshHome(),
			collectScript: resolveCollectScriptFile(),
			resetScript: resolveResetScriptFile(),
			injectionSeen: runtime.injectionSeen === true,
			lastHelloAt: runtime.lastHelloAt,
			muxPath: runtime.mux.path,
			muxPathFound: runtime.mux.found === true,
			proxyRoutes: runtime.proxyRouteCount,
			saveAs: {
				available: runtime.data.enabled === true,
				lastError: runtime.ops.download.lastError,
				lastErrorAt: runtime.ops.download.lastErrorAt,
				lastOkAt: runtime.ops.download.lastOkAt,
				attempts: runtime.ops.download.attempts,
			},
			fork: {
				available: runtime.data.enabled === true,
				lastError: runtime.ops.fork.lastError,
				lastErrorAt: runtime.ops.fork.lastErrorAt,
				lastOkAt: runtime.ops.fork.lastOkAt,
				attempts: runtime.ops.fork.attempts,
				via: runtime.sessionController === undefined || runtime.sessionController === null ? "http" : "in-process",
				/** 「分叉到…」带走的条数（最近 N 条消息）；改在设置页「配置」块那一格。 */
				tailN: effectiveForkTail(runtime),
				tailDefault: FORK_DEFAULT_TAIL,
				tailMax: FORK_MAX_TAIL,
			},
			notes,
		},
	};
}

/** 原 token-copy 的能力：当前进程的"带 token 访问地址"。 */
function buildUrls(runtime) {
	const ctx = runtime.ctx;
	const webServer = ctx !== null && typeof ctx === "object" ? ctx.webServer : undefined;
	const config = webServer !== undefined && webServer !== null && webServer.config !== null && typeof webServer.config === "object" ? webServer.config : undefined;
	let port = webServer !== undefined && webServer !== null ? toPort(webServer.port) : undefined;
	if (port === undefined && config !== undefined) port = toPort(config.port);
	if (port === undefined) port = 19387; // DSH web 的默认端口（仅用于"拿不到活端口"时的展示兜底）
	let host = config !== undefined && typeof config.host === "string" ? config.host : "";
	if (host === "" && webServer !== undefined && webServer !== null && typeof webServer.host === "string") host = webServer.host;
	if (host === "") host = "127.0.0.1";
	const publicBase = runtime.config !== null && typeof runtime.config === "object" && typeof runtime.config.publicBase === "string"
		? runtime.config.publicBase.replace(/\/+$/u, "")
		: "";
	const bases = [];
	if (publicBase !== "") bases.push(publicBase);
	bases.push(`http://127.0.0.1:${String(port)}`);
	// 对外入口开着时，**别的机器**能用的地址是「对外端口」那条（此时 DSH 自己只听 loopback，
	// 拿回环地址发给别人没用）；没开对外入口就按老形态（0.0.0.0 时用 DSH 自己的端口列网卡）。
	const edgeOn = runtime.data.edge !== undefined && runtime.data.edge.enabled === true;
	const edgePort = toPort(runtime.data.edge?.port);
	const nicPort = edgeOn && edgePort !== undefined ? edgePort : port;
	const listNic = edgeOn ? edgePort !== undefined : host !== "" && host !== "127.0.0.1";
	if (listNic) {
		try {
			for (const list of Object.values(osNetworkInterfaces() ?? {})) {
				for (const entry of Array.isArray(list) ? list : []) {
					if (entry === null || typeof entry !== "object") continue;
					if (entry.family !== "IPv4" || entry.internal === true) continue;
					if (typeof entry.address !== "string" || entry.address === "") continue;
					bases.push(`http://${entry.address}:${String(nicPort)}`);
				}
			}
		} catch {
			/* 读不到网卡就只给回环 */
		}
	}
	const connection = ctx !== null && typeof ctx === "object" ? ctx.connection : undefined;
	const urls = [];
	for (const base of [...new Set(bases)]) {
		let authenticated = `${base}/`;
		if (connection !== null && connection !== undefined && typeof connection.authenticatedUrl === "function") {
			try {
				authenticated = connection.authenticatedUrl(`${base}/`);
			} catch (error) {
				warn(ctx, `生成带 token 的地址失败（${base}）：${messageOf(error)}`);
			}
		}
		urls.push({ base, authenticated });
	}
	return { process: { host, port, pid: process.pid }, urls };
}

//#endregion

//#region 设置页接口（只回环可读，且一律不是 text/html）

/** 读一个小 JSON 请求体。 */
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let done = false;
		const finish = (value) => {
			if (done) return;
			done = true;
			resolve(value);
		};
		req.on("data", (chunk) => {
			if (done) return;
			size += chunk.length;
			if (size > MAX_JSON_BODY_BYTES) {
				finish({ error: `请求体过大（上限 ${String(MAX_JSON_BODY_BYTES)} 字节）` });
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") {
				finish({ value: {} });
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch (error) {
				finish({ error: `请求体不是合法 JSON：${messageOf(error)}` });
				return;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				finish({ error: "请求体必须是 JSON 对象" });
				return;
			}
			finish({ value: parsed });
		});
		req.on("error", (error) => finish({ error: `读取请求体失败：${messageOf(error)}` }));
	});
}

/** 请求是不是带了 body（`hello` 明确不接受 body）。 */
function hasRequestBody(req) {
	const length = req.headers["content-length"];
	if (typeof length === "string" && length.trim() !== "" && Number(length) > 0) return true;
	const encoding = req.headers["transfer-encoding"];
	return typeof encoding === "string" && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity";
}

/** 新增/修改一台设备（`id` 给了就是 upsert；没给就从名字派生，派生出来的 id 已存在则报错）。 */
async function upsertDevice(runtime, payload) {
	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	if (name === "") return { ok: false, error: "name 不能为空" };
	const urlText = typeof payload.url === "string" ? payload.url.trim() : "";
	const parsed = parseDeviceUrl(urlText);
	if (parsed.error !== undefined) return { ok: false, error: parsed.error };
	let id = typeof payload.id === "string" ? payload.id.trim() : "";
	const explicit = id !== "";
	if (explicit) {
		if (!DEVICE_ID_PATTERN.test(id)) return { ok: false, error: `id 只允许 A-Za-z0-9._~-（收到 ${JSON.stringify(id)}）` };
	} else {
		// 0.13.1：**id 不随随便便变**。同一台机器（authority 相同）再次添加/重建时，沿用已有条目的 id ——
		// 以前这里按"名字 → 否则 url 的 host（IP）"派生，重加一次就换一个 id，凭据/当前选择/未读全"换台"。
		const sameAuthority = runtime.data.devices.find((entry) => parseDeviceUrl(typeof entry.url === "string" ? entry.url : "").authority === parsed.authority);
		if (sameAuthority !== undefined) {
			id = sameAuthority.id;
		} else {
			// 名字多半是中文，派生不出合法 id 时退而用 url 的 host（`192.0.2.9` 就是合法 id）。
			id = slugifyDeviceId(name);
			if (id === "") id = slugifyDeviceId(parsed.hostname);
			if (id === "") return { ok: false, error: `无法从名字 ${JSON.stringify(name)} 派生合法 id，请显式给 id` };
			if (runtime.data.devices.some((entry) => entry.id === id)) {
				return { ok: false, error: `duplicate id: ${id}（这台设备已经存在；要改它请显式带上 id）` };
			}
		}
	}
	const existing = runtime.data.devices.find((entry) => entry.id === id);
	const previousUrl = existing !== undefined && typeof existing.url === "string" ? existing.url : "";
	if (existing === undefined) {
		runtime.data.devices.push({ id, name, url: urlText });
	} else {
		existing.name = name;
		existing.url = urlText;
	}
	// 0.13.1：地址真的变了（authority A → B）= 同一台机器换了地址 ⇒ 把 token/会话 cookie 从旧 authority
	// 复制到新 authority，尽量免掉"重新认证一次"；旧 ref 不删（改回旧地址还能用）。
	const previousAuthority = parseDeviceUrl(previousUrl).authority;
	if (previousAuthority !== "" && previousAuthority !== parsed.authority) {
		await copyAuthorityCredentials(runtime, previousAuthority, parsed.authority);
	}
	/** 存凭据要用 authority（0.13.1）；`runtime.data.devices` 里是原始条目（没有 authority），
	 *  所以直接用刚解析出来的 `parsed.authority` 构造一个带 authority 的临时设备对象。 */
	const device = { id, name, url: urlText, authority: parsed.authority };
	const hasToken = Object.hasOwn(payload, "token");
	if (hasToken) {
		const token = typeof payload.token === "string" ? payload.token : "";
		try {
			await runtime.tokens.set(device, token);
		} catch (error) {
			return { ok: false, error: `保存 token 失败：${messageOf(error)}` };
		}
		runtime.tokenCache.delete(id);
		// **0.13.1：不丢已有 cookie。** 以前这里会 forgetSession（换 token 就连会话一起丢），
		// 换 token 后第一次请求必须重新兑换；若对端此时 token 也变了，就卡死。现在保留旧 cookie，
		// 只有在真实 401/403 时才丢 + 用新 token 重兑一次重试（见代理 / 探活 / 跨机取数 / 升级四条路径）。
	}
	try {
		persistDataFile(runtime);
	} catch (error) {
		return { ok: false, error: `写入数据文件失败：${messageOf(error)}` };
	}
	refreshDevices(runtime);
	void migrateFileTokens(runtime);
	appendLog("info", "device", explicit || existing !== undefined ? "device updated" : "device added", { id: id, name: name, authority: parsed.authority });
	return { ok: true, device: { id, name, url: urlText } };
}

/** 重排设备顺序（设备管理里的 ↑/↓ 与切换列表共用同一个顺序）。 */
function reorderDevices(runtime, payload) {
	const ids = Array.isArray(payload.ids) ? payload.ids.filter((id) => typeof id === "string" && id !== "") : [];
	if (ids.length === 0) return { ok: false, error: "ids 不能为空" };
	const byId = new Map(runtime.data.devices.map((entry) => [entry.id, entry]));
	const next = [];
	for (const id of ids) {
		const entry = byId.get(id);
		if (entry !== undefined && next.includes(entry) !== true) next.push(entry);
	}
	for (const entry of runtime.data.devices) if (next.includes(entry) !== true) next.push(entry);
	runtime.data.devices = next;
	try {
		persistDataFile(runtime);
	} catch (error) {
		return { ok: false, error: `写入数据文件失败：${messageOf(error)}` };
	}
	refreshDevices(runtime);
	appendLog("info", "device", "devices reordered", { order: next.map((entry) => entry.id) });
	return { ok: true, order: next.map((entry) => entry.id) };
}

/** 删掉一台设备（连同它的凭据 ref 与代理路由）。 */
async function deleteDevice(runtime, id) {
	const at = runtime.data.devices.findIndex((entry) => entry.id === id);
	if (at === -1) return { ok: false, error: `unknown device: ${id}` };
	const removed = runtime.data.devices[at];
	appendLog("info", "device", "device deleted", { id: id, name: typeof removed.name === "string" ? removed.name : "" });
	/** `runtime.data.devices` 是原始条目（没有 authority）；删除凭据 ref 要用 authority。 */
	const removedParsed = parseDeviceUrl(typeof removed?.url === "string" ? removed.url : "");
	const removedDevice = { id, url: typeof removed?.url === "string" ? removed.url : "", authority: removedParsed.authority ?? "" };
	runtime.data.devices.splice(at, 1);
	try {
		await runtime.tokens.remove(removedDevice);
	} catch (error) {
		warn(runtime.ctx, `删除设备 "${id}" 的 token 失败：${messageOf(error)}`);
	}
	runtime.tokenCache.delete(id);
	runtime.sessions.delete(id);
	runtime.reach.delete(id);
	clearAuthNotice(runtime, id);
	if (runtime.sessionStore !== undefined && runtime.sessionStore !== null) void runtime.sessionStore.remove(removedDevice);
	try {
		persistDataFile(runtime);
	} catch (error) {
		return { ok: false, error: `写入数据文件失败：${messageOf(error)}` };
	}
	refreshDevices(runtime);
	return { ok: true };
}

/** 活着切换 enabled（立刻撤/建 `/dev/**` 路由；注入一直挂着，由垫片自检决定自除或生效）。 */
function setEnabled(runtime, enabled) {
	runtime.data.enabled = enabled === true;
	try {
		persistDataFile(runtime);
	} catch (error) {
		return { ok: false, error: `写入数据文件失败：${messageOf(error)}` };
	}
	syncRoutes(runtime);
	if (runtime.data.enabled === true) {
		info(runtime.ctx, "已启用：代理路由已按当前设备表重建；设置页会清掉哨兵并置 force-active，刷新一次胶囊就回来");
		if (runtime.mux.found !== true) void runDiscovery(runtime);
		// 软开关是总开关：开回来时把对外入口一起恢复（端口被占/还没重启就只写 error，不炸）。
		syncEdge(runtime);
	} else {
		teardownProxy(runtime);
		stopEdge(runtime);
		info(runtime.ctx, "已停用：/dev/** 路由与对外入口都停了（外部进不来）；垫片脚本仍然注入（老窗口里的胶囊由它自检后自除并刷新一次），设置页接口仍然可读");
	}
	return { ok: true, enabled: runtime.data.enabled };
}

/**
 * 连通性测试：用该设备的 url（带 token 兑换与 cookie jar）请求 `GET /`，拿到响应头就丢响应体，
 * 只回报状态码与耗时。`ok` 的定义：拿到了 HTTP 响应且状态码 < 500（4xx 也算"活着"，例如没有 token
 * 时 DSH 会回 401；这时的 `status` 就写在返回值里）。
 */
function probeDevice(runtime, device) {
	const started = Date.now();
	return new Promise((resolve) => {
		let settled = false;
		let upstreamHost = null;
		const finish = (status, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const ms = Date.now() - started;
			const ok = status !== null && status < 500;
			markReach(runtime, device.id, ok, ok ? null : (error ?? `HTTP ${String(status)}`));
			resolve({ ok, status, ms, error: ok ? null : (error ?? `HTTP ${String(status)}`) });
		};
		const timer = setTimeout(() => {
			try {
				if (upstreamHost !== null) upstreamHost.destroy(new Error(`连接超时（${String(CONNECT_TIMEOUT_MS)} ms）`));
			} catch {
				/* 忽略 */
			}
			finish(null, `连接超时（${String(CONNECT_TIMEOUT_MS)} ms）`);
		}, CONNECT_TIMEOUT_MS);
		unrefTimer(timer);
		ensureSession(device, runtime).then(() => {
			let target;
			try {
				target = new URL(`${device.origin}${device.basePath}/`);
			} catch (error) {
				finish(null, messageOf(error));
				return;
			}
			const send = device.protocol === "https:" ? httpsRequest : httpRequest;
			/** 当前这一发（重试时换新的；旧发的迟到事件靠 `current` 忽略）。 */
			let current = null;
			let attempt = 0;
			const attemptProbe = () => {
				const cookie = cookieHeaderFor(device, undefined, runtime);
				const headers = { host: device.authority, origin: device.origin, "user-agent": USER_AGENT, accept: "text/html" };
				if (cookie !== undefined) headers.cookie = cookie;
				let request;
				try {
					request = send({
						protocol: target.protocol,
						hostname: device.hostname,
						port: device.port === "" ? undefined : device.port,
						path: `${target.pathname}${target.search}`,
						method: "GET",
						headers,
					}, (response) => {
						if (current !== request) {
							response.resume();
							return;
						}
						const status = response.statusCode ?? 0;
						// 拿到响应头就算完事：立刻丢弃响应体（不读进内存、不落盘）。
						response.resume();
						// 0.13.1：401/403 ⇒ 先丢掉旧会话、用 token 重兑一次再探一次。
						if ((status === 401 || status === 403) && attempt === 0) {
							attempt += 1;
							forgetSession(runtime, device, `探活收到 HTTP ${String(status)}`);
							void ensureSession(device, runtime).then(attemptProbe, attemptProbe);
							return;
						}
						if (status === 401 || status === 403) noteAuthRejected(runtime, device, status);
						else clearAuthNotice(runtime, device.id);
						finish(status, null);
					});
				} catch (error) {
					finish(null, messageOf(error));
					return;
				}
				current = request;
				upstreamHost = request;
				request.on("error", (error) => {
					if (current !== request) return;
					finish(null, messageOf(error));
				});
				request.end();
			};
			attemptProbe();
		}, (error) => finish(null, messageOf(error)));
	});
}

/** 设置页接口的总入口（一条 prefix 路由内部按 pathname + method 分派）。 */
async function handlePluginRequest(runtime, req, res) {
	const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
	const headOnly = method === "HEAD";
	// 「另存为」是**唯一**一条给浏览器用的路由：它自己用官方的"可信请求"判定鉴权
	// （见 authorizeTrustedRequest），所以不受下面这条"仅回环"守卫约束。其余路由照旧。
	if (isLoopback(req) !== true && isDownloadRequestUrl(req.url) !== true) {
		writeText(res, 403, "loopback only\n", headOnly);
		return;
	}
	maybeReloadData(runtime, false);
	let parsed;
	try {
		parsed = new URL(typeof req.url === "string" && req.url !== "" ? req.url : "/", "http://local.invalid");
	} catch {
		writeJson(res, 400, { ok: false, error: "无法解析请求路径" }, headOnly);
		return;
	}
	const pathname = parsed.pathname;
	const rest = pathname === PLUGIN_ROUTE || pathname === `${PLUGIN_ROUTE}/`
		? ""
		: pathname.startsWith(`${PLUGIN_ROUTE}/`) ? pathname.slice(PLUGIN_ROUTE.length + 1) : "";

	if (rest === "state") {
		if (method !== "GET" && method !== "HEAD") {
			writeJson(res, 405, { ok: false, error: `state 只支持 GET/HEAD（收到 ${method}）` }, headOnly);
			return;
		}
		lazyDiscovery(runtime);
		writeJson(res, 200, buildState(runtime), headOnly);
		return;
	}
	if (rest === "urls") {
		if (method !== "GET" && method !== "HEAD") {
			writeJson(res, 405, { ok: false, error: `urls 只支持 GET/HEAD（收到 ${method}）` }, headOnly);
			return;
		}
		writeJson(res, 200, buildUrls(runtime), headOnly);
		return;
	}
	if (rest === "devices") {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `devices 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		const body = await readJsonBody(req);
		if (body.error !== undefined) {
			writeJson(res, 400, { ok: false, error: body.error }, headOnly);
			return;
		}
		writeJson(res, 200, await upsertDevice(runtime, body.value), headOnly);
		return;
	}
	if (rest === "devices/reorder") {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `devices/reorder 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		const body = await readJsonBody(req);
		if (body.error !== undefined) {
			writeJson(res, 400, { ok: false, error: body.error }, headOnly);
			return;
		}
		writeJson(res, 200, reorderDevices(runtime, body.value), headOnly);
		return;
	}
	if (rest.startsWith("devices/")) {
		if (method !== "DELETE") {
			writeJson(res, 405, { ok: false, error: `devices/<id> 只支持 DELETE（收到 ${method}）` }, headOnly);
			return;
		}
		let id = "";
		try {
			id = decodeURIComponent(rest.slice("devices/".length));
		} catch {
			id = rest.slice("devices/".length);
		}
		if (id === "") {
			writeJson(res, 400, { ok: false, error: "缺少设备 id" }, headOnly);
			return;
		}
		writeJson(res, 200, await deleteDevice(runtime, id), headOnly);
		return;
	}
	if (rest.startsWith("test/")) {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `test/<id> 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		let id = "";
		try {
			id = decodeURIComponent(rest.slice("test/".length));
		} catch {
			id = rest.slice("test/".length);
		}
		const device = runtime.devices.find((entry) => entry.id === id);
		if (device === undefined) {
			writeJson(res, 200, { ok: false, status: null, ms: 0, error: `unknown device: ${id}` }, headOnly);
			return;
		}
		// 请求体（客户端半会发一个空对象）读掉即可，内容不参与连通性测试。
		await readJsonBody(req);
		writeJson(res, 200, await probeDevice(runtime, device), headOnly);
		return;
	}
	if (rest === "enabled") {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `enabled 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		const body = await readJsonBody(req);
		if (body.error !== undefined) {
			writeJson(res, 400, { ok: false, error: body.error }, headOnly);
			return;
		}
		if (typeof body.value.enabled !== "boolean") {
			writeJson(res, 400, { ok: false, error: "enabled 必须是布尔值" }, headOnly);
			return;
		}
		writeJson(res, 200, setEnabled(runtime, body.value.enabled), headOnly);
		return;
	}
	if (rest === "hello") {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `hello 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		if (hasRequestBody(req)) {
			// 垫片报到**不接受任何 body**：带 body 的请求一律不当报到（也不读它）。
			req.resume();
			writeJson(res, 400, { ok: false, error: "hello 不接受请求体" }, headOnly);
			return;
		}
		runtime.injectionSeen = true;
		runtime.lastHelloAt = new Date().toISOString();
		runtime.helloCount += 1;
		if (runtime.helloCount === 1) info(runtime.ctx, `垫片已报到（${HELLO_PATH}）：本机页面的注入确认生效`);
		appendLog("debug", "shim", "shim hello", { count: runtime.helloCount });
		writeJson(res, 200, { ok: true }, headOnly);
		return;
	}
	if (rest === "log") {
		if (method !== "GET" && method !== "HEAD") {
			writeJson(res, 405, { ok: false, error: `log 只支持 GET/HEAD（收到 ${method}）` }, headOnly);
			return;
		}
		const text = readLogTail();
		const head = {
			"content-type": "text/plain; charset=utf-8",
			"content-disposition": 'attachment; filename="dsh-remote.log"',
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
		};
		try {
			res.writeHead(200, head);
			res.end(headOnly ? undefined : text);
		} catch (error) {
			warn(runtime.ctx, `下载日志失败：${messageOf(error)}`);
		}
		return;
	}
	if (rest === "log/clear") {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `log/clear 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		req.resume();
		try {
			writeFileSync(resolveLogFile(), "");
			appendLog("info", "log", "log cleared by user");
			writeJson(res, 200, { ok: true, file: resolveLogFile() }, headOnly);
		} catch (error) {
			writeJson(res, 500, { ok: false, error: `清空日志失败：${messageOf(error)}` }, headOnly);
		}
		return;
	}
	if (rest === "download") {
		if (method !== "GET") {
			// 下载是浏览器导航过去的一条 GET；错误一律纯文本（I1：绝不是 text/html）。
			writeText(res, 405, `dsh-remote：${DOWNLOAD_PATH} 只支持 GET（收到 ${method}）。\n`);
			return;
		}
		await handleDownloadRequest(runtime, req, res, parsed);
		return;
	}
	if (rest === "fork") {
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `fork 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		await handleForkRequest(runtime, req, res, headOnly);
		return;
	}
	if (rest === "access") {
		// 「配置」块：**只回环**（上面的守卫已经管住）+ 受 enabled 门控；写的是 profile patch，
		// 走官方 ctx.configEditor.edit（见 applyAccessConfig），绝不手改 YAML。
		if (method !== "POST") {
			writeJson(res, 405, { ok: false, error: `access 只支持 POST（收到 ${method}）` }, headOnly);
			return;
		}
		const body = await readJsonBody(req);
		if (body.error !== undefined) {
			writeJson(res, 400, { ok: false, error: body.error }, headOnly);
			return;
		}
		const result = await applyAccessConfig(runtime, body.value);
		writeJson(res, result.status, result.body, headOnly);
		return;
	}
	if (rest === "live") {
		// 跨机实时状态的**本机页面口**（与 state/urls 同一道"仅回环"守卫，见函数顶部）。
		await handleLocalLiveRequest(runtime, req, res, method, headOnly, false);
		return;
	}
	if (rest === "live/seen") {
		// body `{id}`：缺省/空串/未知/本机 id = 清本机；对端 id = 请对端自己清（见 markLiveSeen）。
		await handleLocalLiveRequest(runtime, req, res, method, headOnly, true);
		return;
	}
	writeJson(res, 404, { ok: false, error: `unknown route: ${method} ${pathname}` }, headOnly);
}

//#endregion

//#region 插件装配

/**
 * @param ctx - 宿主 Cordis 上下文（需已提供 webServer 与 connection）。
 * @param config - 见 README：`{ publicBase?, dataFile? }`。**设备与 enabled 都在数据文件里**，
 *   不在 profile patch 里；`config.devices` / `config.current` 只作为"数据文件不存在时的一次性种子"
 *   （把 device-switch 时代的配置搬进新文件，含 token → 凭据服务）。
 * @param deps - 只有自测会传：`{ hostFacts?, discoverMuxPath?, muxPath?, onReady? }`。
 * @returns 无返回值（Cordis 会把它当 effect 处理，返回对象会抛 "Invalid effect"）。
 */
export function apply(ctx, config, deps) {
	appendLog("info", "plugin", "dsh-remote start", { version: VERSION, node: process.version, platform: process.platform });
	installCollectScript();
	const cfg = config !== null && typeof config === "object" ? config : {};
	const hooks = deps !== null && typeof deps === "object" ? deps : {};
	const facts = (() => {
		const injected = typeof hooks.hostFacts === "function" ? hooks.hostFacts(ctx) : undefined;
		return injected !== null && typeof injected === "object" ? injected : collectHostFacts(ctx);
	})();

	const runtime = {
		ctx,
		config: cfg,
		facts,
		hooks,
		dataPath: resolveDataPath(cfg),
		dataStamp: null,
		lastReloadCheckAt: 0,
		data: { enabled: true, devices: [], current: "", forkTailN: undefined, edge: { enabled: false, port: undefined } },
		fileTokens: Object.create(null),
		/** 从 profile 配置种子里带过来、还没定落点的 token（见 scheduleSeedTokenSettlement）。 */
		seedTokens: Object.create(null),
		/** **远端会话 cookie** 的退化落点（凭据服务不可用时才用；见 {@link createSessionStore}）。 */
		fileSessions: Object.create(null),
		/** 有没有往数据文件里写过明文 token / 会话（体检页与 README 要如实标注）。 */
		tokenPlaintext: false,
		sessionPlaintext: false,
		/** 凭据服务可用后由 ctx.inject 填进来（缺失即退化到数据文件）。 */
		credentials: undefined,
		/** 会话服务可用后由 ctx.inject 填进来（分叉读本机源会话时优先用它，缺失退回本机 HTTP）。 */
		sessionController: undefined,
		/** 两条新能力的最近结果（体检页要报"可用"与"最近一次失败原因"）。 */
		ops: {
			download: { attempts: 0, lastOkAt: null, lastError: null, lastErrorAt: null },
			fork: { attempts: 0, lastOkAt: null, lastError: null, lastErrorAt: null },
		},
		/** Remote RPC 的 rpcId 序号。 */
		rpcSeq: 0,
		configEditor: undefined,
		configEditorNote: "",
		devices: [],
		localDevice: undefined,
		localVia: "none",
		sessions: new Map(),
		pendingSessions: new Map(),
		authFailures: new Map(),
		tokenCache: new Map(),
		/** 0.13.1：401/403 的提示（device.id → { status, message, at }）；**不参与可达性判定**。 */
		authNotices: new Map(),
		reach: new Map(),
		/** 失败退避账本（0.17.1）：id → { failures, nextAt }。 */
		probeBackoff: new Map(),
		/**
		 * 代理"快失败"的新鲜度窗口（ms；`deps.reachFreshMs` 可以换掉它，自测用它把 4 秒缩成几十毫秒）。
		 * 见 {@link recentlyUnreachable}。
		 */
		reachFreshMs: Number.isFinite(hooks.reachFreshMs) && hooks.reachFreshMs > 0 ? hooks.reachFreshMs : REACH_FRESH_MS,
		/**
		 * 建连超时（ms；`deps.proxyConnectTimeoutMs` 可以换掉它，自测用它把 3 秒缩成几百毫秒）。
		 * 见 {@link PROXY_CONNECT_TIMEOUT_MS}。
		 */
		proxyConnectTimeoutMs: Number.isFinite(hooks.proxyConnectTimeoutMs) && hooks.proxyConnectTimeoutMs > 0
			? hooks.proxyConnectTimeoutMs
			: PROXY_CONNECT_TIMEOUT_MS,
		/** 正在途的"快失败顺手探测"（一台一个）：防止白屏时几十条 /api 各探一次（见 triggerReachProbe）。 */
		reachProbes: new Set(),
		/** 跨机实时状态：本机生产者 + 对端缓存（见「跨机实时状态」region）。 */
		live: createLiveState(),
		/** 本机 unread/doneAt 的落盘路径（`config.liveFile` 只为自测预留，缺省 `$DSH_HOME/dsh-remote-live.json`）。 */
		livePath: resolveLivePath(cfg),
		/** 跨机实时状态的轮询间隔（`deps.livePollMs` 可以换掉它，自测用它把 5 秒缩到几十毫秒）。 */
		livePollMs: Number.isFinite(hooks.livePollMs) && hooks.livePollMs > 0 ? hooks.livePollMs : LIVE_POLL_MS,
		injectionSeen: false,
		lastHelloAt: null,
		helloCount: 0,
		mux: {
			path: null,
			found: false,
			source: null,
			static: false,
			attempts: 0,
			lastAttemptAt: 0,
			lastError: null,
			lastCandidateError: null,
			indexNote: null,
			candidates: [],
			running: null,
			gaveUp: false,
			firstRunDone: false,
			/** 重试节奏（`deps.muxRetryDelaysMs` 可以换掉它，自测用它把 8 秒缩到 0）。 */
			delays: Array.isArray(hooks.muxRetryDelaysMs) && hooks.muxRetryDelaysMs.length > 0
				? hooks.muxRetryDelaysMs.filter((value) => Number.isFinite(value) && value >= 0)
				: MUX_RETRY_DELAYS_MS,
		},
		routes: new Map(),
		staticRoutes: new Map(),
		proxyRouteCount: 0,
		/** 对外入口（0.10.0）：server 在跑、error 是最近一次失败原因；sockets 用来在停用时断开长连接。 */
		edge: {
			server: null,
			port: null,
			targetPort: null,
			running: false,
			error: null,
			/** 入站连接（HTTP keep-alive / SSE / upgrade）。 */
			sockets: new Set(),
			/** WebSocket 升级转发的上游 socket（`stopEdge` 一起 destroy）。 */
			upstreamSockets: new Set(),
		},
		injection: { tap: null, onInject: null },
		timers: new Set(),
		disposed: false,
		readyNotified: false,
		hardeningNote: "",
		/** 数据文件存在但读不懂时的原因（体检页要报出来，且此时不种子、不覆盖）。 */
		dataInvalid: null,
	};

	runtime.tokens = createTokenStore(runtime);
	/** 0.8.1：远端会话 cookie 也落盘（见 createSessionStore）；它是"网页端 cookie 存在浏览器里"的等价物。 */
	runtime.sessionStore = createSessionStore(runtime);

	// ---- 1. 设备数据文件（同步读，apply 之后路由就必须在）----
	let dataLoaded = false;
	let dataMissing = false;
	try {
		const loaded = readDataFile(runtime.dataPath);
		if (loaded !== null) {
			adoptData(runtime, loaded);
			dataLoaded = true;
			try {
				const stat = statSync(runtime.dataPath);
				runtime.dataStamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
			} catch {
				runtime.dataStamp = null;
			}
		} else {
			dataMissing = true;
		}
	} catch (error) {
		// 文件存在但读不懂：**既不种子也不覆盖**（用户可能正要手改它），本次按空设备表工作。
		runtime.dataInvalid = messageOf(error);
		warn(ctx, `数据文件 ${runtime.dataPath} 存在但无法解析（${runtime.dataInvalid}）：本次不种子、不覆盖它，请修好或删掉它`);
	}
	if (dataLoaded !== true && dataMissing === true) {
		// 一次性种子：只认 profile 配置里给的 devices/current（数据文件**已存在**时绝不覆盖）。
		const seedDevices = normalizeDevices(ctx, cfg);
		const seedCurrent = typeof cfg.current === "string" ? cfg.current.trim() : "";
		if (seedDevices.length > 0 || seedCurrent !== "") {
			runtime.data.devices = seedDevices.map((device) => ({ id: device.id, name: device.name, url: device.rawUrl }));
			runtime.data.current = seedCurrent;
			// 种子里的 token 直接进凭据服务/退化存储（绝不留在这个 JSON 的 devices 里）。
			const seedTokens = [];
			for (const entry of Array.isArray(cfg.devices) ? cfg.devices : []) {
				if (entry === null || typeof entry !== "object") continue;
				const id = typeof entry.id === "string" ? entry.id.trim() : "";
				const token = typeof entry.token === "string" ? entry.token.trim() : "";
				if (id !== "" && token !== "") seedTokens.push([id, token]);
			}
			for (const [id, token] of seedTokens) runtime.seedTokens[id] = token;
			try {
				persistDataFile(runtime);
				info(ctx, `已从 profile 配置一次性种子 ${String(seedDevices.length)} 台设备到 ${runtime.dataPath}（此后以该文件为准）`);
			} catch (error) {
				warn(ctx, `写入数据文件 ${runtime.dataPath} 失败（本次仍按内存里的设备工作）：${messageOf(error)}`);
			}
			scheduleSeedTokenSettlement(runtime);
		}
	}

	// ---- 2. 设备表 / 本机身份 / 路由 + 注入 ----
	refreshDevices(runtime);
	// 0.13.1：token / 会话 cookie 改按 authority 存 —— 把旧 id ref 的值**复制**过来（不删旧 ref）。
	// 幂等；失败只 warn，绝不阻塞启动。
	void migrateAuthorityRefs(runtime, "启动");

	// ---- 3. 设置页接口（无论 enabled 与否都在，体检页要能读、要能改回来）----
	try {
		const route = {
			kind: "prefix",
			path: PLUGIN_ROUTE,
			handler: (req, res) => {
				Promise.resolve(handlePluginRequest(runtime, req, res)).catch((error) => {
					warn(ctx, `设置页接口处理异常：${messageOf(error)}`);
					try {
						writeJson(res, 500, { ok: false, error: messageOf(error) });
					} catch {
						res.destroy();
					}
				});
			},
		};
		runtime.staticRoutes.set("plugin", ctx.webServer.register(route));
	} catch (error) {
		warn(ctx, `注册设置页路由 ${PLUGIN_ROUTE} 失败：${messageOf(error)}`);
	}

	// ---- 3b. 跨机实时状态（生产 + 聚合）：跨机取数口 + 本机生产者 ----
	// 取数口是**新注册**的路径（`/dsh-remote-live`），**故意不带 `/plugin/` 前缀**：
	// 对端的「对外入口」（edge）只拦 `/plugin/`（EDGE_BLOCKED_PREFIXES），带那个前缀会被 403 掉。
	// 既不碰 EDGE_BLOCKED_PREFIXES，也不碰 prefixPath()/rewriteUrl()（页面切设备那套一个字节没动）。
	try {
		const route = {
			kind: "prefix",
			path: PEER_LIVE_ROOT,
			handler: (req, res) => {
				Promise.resolve(handlePeerLiveRequest(runtime, req, res)).catch((error) => {
					warn(ctx, `跨机实时状态接口处理异常：${messageOf(error)}`);
					try {
						writeJson(res, 500, { ok: false, error: messageOf(error) });
					} catch {
						res.destroy();
					}
				});
			},
		};
		runtime.staticRoutes.set("peer-live", ctx.webServer.register(route));
	} catch (error) {
		warn(ctx, `注册跨机取数路由 ${PEER_LIVE_ROOT} 失败：${messageOf(error)}`);
	}
	// ---- 3c. 浏览器口（0.12.0）：`/dsh-remote-view` = 同形聚合 + version ----
	// 同样**故意不带 `/plugin/` 前缀**（edge 只挡 `/plugin/`）：手机 / 浏览器经对外端口打开
	// 本机页面时读不到 `/plugin/remote/live`（403），状态点就全靠这一条。
	// 守卫在 handleViewRequest 里用官方的可信请求判定（与「另存为」同一把尺子）。
	try {
		const route = {
			kind: "prefix",
			path: VIEW_PATH,
			handler: (req, res) => {
				Promise.resolve(handleViewRequest(runtime, req, res)).catch((error) => {
					warn(ctx, `浏览器实时状态接口处理异常：${messageOf(error)}`);
					try {
						writeJson(res, 500, { ok: false, error: messageOf(error) });
					} catch {
						res.destroy();
					}
				});
			},
		};
		runtime.staticRoutes.set("remote-view", ctx.webServer.register(route));
	} catch (error) {
		warn(ctx, `注册浏览器实时状态路由 ${VIEW_PATH} 失败：${messageOf(error)}`);
	}
	// 未读标记（**独立文件** `$DSH_HOME/dsh-remote-live.json`，与探针插件那份互不干扰）。
	// 同步读、失败静默，绝不影响启动。
	loadLiveUnread(runtime);
	// 定时器登记：卸载时清掉（ctx.effect 的清理函数）。
	ctx.effect(() => () => {
		stopLivePolling(runtime);
	}, "dsh-remote: live");
	// 会话服务：拿不到 `list()` 就写一行 info 且**不轮询**（本机状态取不到也不能把插件弄挂）。
	ctx.inject(["sessionController"], (sessionCtx) => {
		const controller = sessionCtx.sessionController;
		const usable = controller !== null && controller !== undefined && typeof controller.list === "function";
		if (usable !== true) {
			info(ctx, `跨机实时状态：会话服务在场但接口形状不认识（需要 list()）→ 不轮询；${LIVE_PATH} 的 self.live 会是初值、peers 保持乐观（不画红）`);
			return;
		}
		liveStateOf(runtime).controller = controller;
		startLivePolling(runtime);
	});

	// ---- 4. 周期清理 / 卸载 ----
	ctx.effect(() => () => {
		runtime.disposed = true;
		stopEdge(runtime);
		teardownProxy(runtime);
		for (const dispose of runtime.staticRoutes.values()) {
			try {
				dispose();
			} catch {
				/* 已撤 */
			}
		}
		runtime.staticRoutes.clear();
		for (const timer of runtime.timers) clearTimeout(timer);
		runtime.timers.clear();
	}, "dsh-remote: lifetime");

	// ---- 5. 可选服务：凭据（token）与 config-editor（「配置」块写 profile 用）----
	ctx.inject(["credentials"], (credentialsCtx) => {
		runtime.credentials = credentialsCtx.credentials;
		info(ctx, "凭据服务可用：设备 token 会存在 ctx.credentials（按 authority 一个 ref），数据文件里只留 id/name/url");
		void migrateFileTokens(runtime);
		// 0.13.1：凭据服务晚到时也补一次 authority 迁移（幂等）。
		void migrateAuthorityRefs(runtime, "凭据服务接入");
	});
	ctx.inject(["sessionController"], (sessionCtx) => {
		// 只用于「分叉到…」读**本机**源会话（projections 拿 asOfSeq、page 拿尾页）；拿不到就退回本机 HTTP。
		const controller = sessionCtx.sessionController;
		const usable = controller !== null && controller !== undefined
			&& typeof controller.projections === "function" && typeof controller.page === "function";
		runtime.sessionController = usable ? controller : undefined;
		info(ctx, usable
			? "会话服务可用：分叉读本机源会话走进程内 ctx.sessionController.page（不经过 HTTP）"
			: "会话服务在场但接口形状不认识（需要 projections() + page()）：分叉读本机源会话会退回本机 HTTP /api");
	});
	ctx.inject(["configEditor"], (editorCtx) => {
		const editor = editorCtx.configEditor;
		// 「配置」块要写 profile，所以这里只认真正能用的形状：edit() + entries()。
		const usable = editor !== null && editor !== undefined
			&& typeof editor.edit === "function" && typeof editor.entries === "function";
		runtime.configEditor = usable ? editor : undefined;
		runtime.configEditorNote = usable
			? ""
			: "⚠ config-editor 在场但接口形状不认识（需要 edit() + entries()），或这台机器根本没有 config-editor：设置页「配置」块的保存会失败（503），要改请手改 profile 的 cordis.patch.yml（片段见 README）。";
	});

	// ---- 6. mux 路径发现（不硬编码）----
	if (typeof hooks.muxPath === "string" && hooks.muxPath !== "") {
		runtime.mux.path = hooks.muxPath;
		runtime.mux.found = true;
		runtime.mux.static = true;
		runtime.mux.source = "deps.muxPath（自测注入）";
		runtime.mux.firstRunDone = true;
		syncRoutes(runtime);
		callOnReady(runtime);
	} else {
		const injectedDiscover = typeof hooks.discoverMuxPath === "function" ? hooks.discoverMuxPath : undefined;
		runtime.hooks = {
			onReady: hooks.onReady,
			discover: injectedDiscover === undefined
				? (target) => discoverMuxPath(target)
				: async (target) => {
					const result = await injectedDiscover(target);
					if (result === null || result === undefined) return { path: null, source: null, candidates: [], error: "注入的 discoverMuxPath 返回空" };
					if (typeof result === "string") return { path: result, source: "deps.discoverMuxPath（自测注入）", candidates: [], error: null };
					return result;
				},
		};
		if (runtime.data.enabled === true) {
			void runDiscovery(runtime);
		} else {
			// 停用时不探测（"代理等同没装"；垫片照旧注入，由它自检自除）；但要给自测一个确定的收尾信号。
			runtime.mux.firstRunDone = true;
			callOnReady(runtime);
		}
	}

	// ---- 7. 对外入口（0.10.0）：配置住在数据文件里；软开关是总开关，启停即时生效 ----
	syncEdge(runtime);
}

//#endregion

/**
 * 抽取到 lib/*.js 的模块要用到的宿主半符号：统一在这里**注入**。
 *
 * 为什么不用 `import ... from "./lib/*.js"` 的反向 import：那会形成
 * `index.js ↔ lib/*.js` 的 ESM 循环引用（还要为了内部符号去扩大 index.js 的 export 面）。
 * 依赖注入没有这个问题：模块侧只是一组 `let` 绑定 + 一个 `configure*()` 赋值函数，
 * 搬迁过去的代码本身**逐字未改**。所有 configure* 都是纯赋值、顺序无关，只要在
 * `apply()` 与自测调用这些模块之前完成即可（本文件在模块求值末尾注入）。
 */
/**
 * 可达性账本 / 快失败（./reach.js）：三个阈值常量同时被代理、live 轮询、对外入口与自测共用，
 * 所以留在宿主半；probeDevice 也留在宿主半（它要网络与凭据层），reach 侧只注入这一个函数。
 */
configureReach({ LIVE_POLL_MS, REACH_FRESH_MS, PROXY_CONNECT_TIMEOUT_MS, probeDevice });

/**
 * 设备解析与本机身份（./devices.js）：id 的安全性正则（{@link DEVICE_ID_PATTERN}）同时被设置页校验、
 * attach 的 DI 名单与自测共用，所以留在宿主半，用注入传下去（与 store 的常量同一口径）。
 */
configureDevices({ DEVICE_ID_PATTERN });

/** 数据文件层（./data.js）：热重载后重算路由 + 把明文 token 迁进凭据服务。 */
configureData({ migrateFileTokens, refreshDevices });

/** 凭据 / 会话层（./store.js）：token 兑换与会话存储用到的常量。 */
configureStore({
	AUTH_RETRY_MS, CONNECT_TIMEOUT_MS, SEED_TOKEN_SETTLE_MS, TOKEN_ABSENCE_TTL_MS, USER_AGENT,
});

configureProxy({
	BRIDGE_MAX_BODY_BYTES, CONNECT_TIMEOUT_MS, DROP_REQUEST_HEADERS, DROP_RESPONSE_HEADERS,
	REPLAY_MAX_BODY_BYTES, REPLAY_TOO_LARGE_MESSAGE, ROUTE_ROOT, SNIFF_LIMIT_BYTES, USER_AGENT,
	captureSession, clearAuthNotice, cookieHeaderFor, ensureSession, forgetSession,
	authorizeTrustedRequest, noteAuthRejected,
	markReach, proxyConnectTimeout, recentlyUnreachable, triggerReachProbe, unreachableProxyReason,
	classifyBodyPrefix, isHtmlContentType, declaredBodyLength, requestHasBody, readReplayBody,
	bridgePromptBody, inlineJson,
});

configureAttach({
	DEVICE_ID_PATTERN, DOWNLOAD_CHUNK_BYTES, MAX_DOWNLOAD_WINDOWS, MAX_PATH_CHARS, MAX_SESSION_ID_CHARS,
	MULTIPART_OVERHEAD_BYTES, REMOTE_RPC_CHANNEL, REMOTE_RPC_MAX_BYTES, REMOTE_RPC_TIMEOUT_MS,
	TYPERT_SERVICE, USER_AGENT, WORKSPACE_FILES_SERVICE, WORKSPACE_FILE_SCOPE_LOOKUP,
	SESSION_CREATE_ENDPOINT, SESSION_PAGE_ENDPOINT, SESSION_PROJECTIONS_ENDPOINT, SESSION_PROMPT_ENDPOINT,
	SESSION_RENAME_ENDPOINT, WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT, WORKSPACE_FILES_STAT_ENDPOINT,
	WORKSPACE_FILES_READ_BYTES_ENDPOINT,
	authorizeTrustedRequest, cookieHeaderFor, ensureSession, isHtmlContentType, markReach,
	mintLocalSessionCookie, readAccess, readJsonBody, serviceOf,
	FORK_MAX_SEED_BYTES, FORK_MAX_TAIL, FORK_UNTITLED_TITLE, MAX_SOURCE_TITLE_CHARS,
	effectiveForkTail, normalizeForkTail,
});

configureLive({
	LIVE_APPROVAL_ASKED, LIVE_APPROVAL_DECIDED, LIVE_ASK_TOOL, LIVE_FILE_NAME, LIVE_PENDING_EVENT,
	LIVE_POLL_MS, LIVE_SEEN_PATH, LIVE_TAIL_N, PEER_LIVE_MAX_BYTES, PEER_LIVE_PATH,
	PEER_LIVE_SEEN_PATH, PEER_LIVE_TIMEOUT_MS, VIEW_PATH, VERSION, USER_AGENT,
	authorizeTrustedRequest, captureSession, clearAuthNotice, cookieHeaderFor, deviceMatchesLocal,
	ensureSession, forgetSession, inlineJson, noteAuthRejected, readJsonBody,
	markReach, maybeReloadData, probeBackoffDue,
});

/** 供自测核对：路由常量与纯函数（宿主侧运行时不使用）。 */
export const internals = {
	VERSION,
	SHIM_MARKER,
	/** 垫片发布设备表用的隐藏 JSON 节点 id（客户端半按同一个 id 读）。 */
	SHIM_DEVICES_NODE_ID,
	/** 代理的建连超时（只覆盖建连阶段；自测断言缺省 3 秒）。 */
	PROXY_CONNECT_TIMEOUT_MS,
	/** 句柄卫生（0.12.1）：对外入口底座 / 定时器 unref —— 自测换桩断言"不挡进程退出"。 */
	edgeIo,
	startEdge,
	stopEdge,
	unrefTimer,
	/** 0.13.3：edge 固定的对内 authority（cookie 只认 Host，与 DSH 实际端口解耦）。 */
	EDGE_INNER_AUTHORITY,
	/** 账本"新鲜度"窗口（= LIVE_POLL_MS 的 2 倍；自测用它验快失败的两侧）。 */
	REACH_FRESH_MS,
	/** 失败退避（0.17.1）：上限与延迟函数（自测直接验证 2/4/8/16/30 序列）。 */
	PROBE_BACKOFF_MAX_MS,
	probeBackoffDelay,
	/** 快失败那两个判据/动作（自测直接驱动它们，不必绕过整个代理）。 */
	reachCheckedAt,
	recentlyUnreachable,
	triggerReachProbe,
	/** 跨机实时状态（生产 + 聚合）：常量与可被自测直接驱动的函数。 */
	LIVE_PATH,
	STORAGE_KEYS,
	SHIM_SELFTEST_SENTINEL_KEY,
	SHIM_FORCE_ACTIVE_KEY,
	ROUTE_ROOT,
	PLUGIN_ROUTE,
	HELLO_PATH,
	STATE_PATH,
	DOWNLOAD_PATH,
	FORK_PATH,
	REMOTE_RPC_CHANNEL,
	WORKSPACE_FILES_STAT_ENDPOINT,
	WORKSPACE_FILES_READ_BYTES_ENDPOINT,
	SESSION_PROJECTIONS_ENDPOINT,
	SESSION_PAGE_ENDPOINT,
	SESSION_CREATE_ENDPOINT,
	SESSION_PROMPT_ENDPOINT,
	SESSION_RENAME_ENDPOINT,
	WORKSPACE_INITIALIZE_DEFAULT_ENDPOINT,
	DOWNLOAD_CHUNK_BYTES,
	MAX_DOWNLOAD_WINDOWS,
	FORK_DEFAULT_TAIL,
	FORK_MAX_TAIL,
	FORK_MIN_TAIL,
	DATA_FORK_TAIL_FIELD,
	normalizeForkTail,
	effectiveForkTail,
	FORK_MAX_SEED_BYTES,
	FORK_UNTITLED_TITLE,
	MAX_SOURCE_TITLE_CHARS,
	MAX_PATH_CHARS,
	MAX_SESSION_ID_CHARS,
	basenameOf,
	encodeRfc5987,
	contentDispositionFor,
	multipartBoundary,
	parseMultipart,
	parseRpcResult,
	remoteErrorText,
	blockSummary,
	contentText,
	messageOfRecord,
	buildSeedContext,
	forkSeedPrompt,
	localForkDeviceName,
	cleanSourceTitle,
	forkSessionTitle,
	localPseudoDevice,
	syncInjection,
	AUTH_COOKIE_PREFIX,
	BIND_HOST,
	WEBSERVER_ENTRY_ID,
	CONNECTION_ENTRY_ID,
	MAX_TRUSTED_HOSTS,
	canonicalTrustedAuthority,
	localIpv4List,
	localAddressList,
	accessTargets,
	commitForkTail,
	configEditorOf,
	entryConfig,
	applyAccessConfig,
	DATA_FILE_NAME,
	DATA_TOKENS_FIELD,
	TOKEN_REF_PREFIX,
	SESSION_REF_PREFIX,
	sessionRefFor,
	/** 0.13.1：旧 id ref（只读，迁移用）与 authority 迁移入口。 */
	legacyTokenRefFor,
	legacySessionRefFor,
	migrateAuthorityRefs,
	/** 0.13.1：401/403 的"人话"提示（设备 lastError / notes / 日志共用同一句）。 */
	authRejectMessage,
	noteAuthRejected,
	clearAuthNotice,
	createSessionStore,
	forgetSession,
	/** 0.13.1：代理与升级实现（自测直接驱动，验 401 重试；生产路径就是这两条路由调用的）。 */
	handleHttpProxy,
	handleUpgradeProxy,
	MUX_CONST_NAME,
	MUX_RETRY_DELAYS_MS,
	MAX_JSON_BODY_BYTES,
	DEVICE_ID_PATTERN,
	cookieNameFor,
	sessionPairFromSetCookie,
	captureSession,
	cookieHeaderFor,
	readCookie,
	rewriteLocation,
	rewriteSetCookie,
	insertAfterHead,
	normalizeDevices,
	normalizeDeviceEntry,
	slugifyDeviceId,
	tokenRefFor,
	dshHome,
	resolveDataPath,
	readDataFile,
	renderDataFile,
	remoteShim,
	renderShimScript,
	isHtmlContentType,
	classifyBodyPrefix,
	collectHostFacts,
	deviceMatchesLocal,
	resolveLocalDevice,
	localEntryName,
	extractMuxPath,
	normalizeCandidate,
	urlsFromInjections,
	discoverMuxPath,
	httpGetText,
	isLoopback,
	serviceOf,
	isDownloadRequestUrl,
	authorizeTrustedRequest,
	errorCodeOf,
	localErrorText,
	statusForLocalCode,
	bytesOf,
	WORKSPACE_FILES_SERVICE,
	TYPERT_SERVICE,
	WORKSPACE_FILE_SCOPE_LOOKUP,
	toPort,
	plainValue,
	// 跨机实时状态（生产 + 聚合）：常量与可被自测直接驱动的函数。
	LIVE_PATH,
	LIVE_SEEN_PATH,
	PEER_LIVE_ROOT,
	PEER_LIVE_PATH,
	PEER_LIVE_SEEN_PATH,
	/** 浏览器口（0.12.0）：聚合 + version，非 `/plugin/` 前缀（穿过 edge）。 */
	VIEW_PATH,
	LIVE_POLL_MS,
	PEER_LIVE_TIMEOUT_MS,
	PEER_LIVE_MAX_BYTES,
	LIVE_FILE_NAME,
	LIVE_TAIL_N,
	resolveLivePath,
	createLiveState,
	liveStateOf,
	liveViewOf,
	liveViewFromPeerBody,
	liveTailRoleOf,
	livePendingOfItem,
	liveSelfNameOf,
	fetchPeerPath,
	pollLocalLive,
	pollPeerLives,
	startLivePolling,
	stopLivePolling,
	buildLiveAggregate,
	buildLiveView,
	buildSelfLivePayload,
	markLiveSeen,
	clearLocalLiveUnread,
	loadLiveUnread,
	saveLiveUnread,
	handlePeerLiveRequest,
	handleViewRequest,
};

