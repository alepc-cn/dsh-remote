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
 *      `dsh-device-switch:*` / `dsh-remote:*` → 摘掉自己画的胶囊 → 还原被改写的原语
 *      → 带 `sessionStorage` 哨兵地刷新一次（哨兵保证最多刷一次，`enabled:true` 时清掉）。
 *      这样"停用"在没有重启 APP 的老窗口里也能立刻回到本机直连、无胶囊的干净状态。
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
 *  - `enabled:false` 或 404 → 清存储 → 摘胶囊 → 还原原语 → 带哨兵刷新一次；
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
 * 只使用 node: 内置模块，零第三方依赖。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { homedir, hostname as osHostname, networkInterfaces as osNetworkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";

export const name = "dsh-remote";
export const inject = ["webServer", "connection"];

/** 插件版本（selftest 会拿它与 package.json 对账，防止两处漂移）。 */
const VERSION = "0.10.6";

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
const AUTH_COOKIE_PREFIX = "dsh-auth-";

/** 垫片脚本的唯一标记：两条注入通道靠它互相去重，也供 selftest 识别。 */
const SHIM_MARKER = "/* dsh-remote:shim */";
/** 垫片浮层的 DOM id（幂等挂载）。 */
const SWITCHER_ELEMENT_ID = "dsh-remote-root";
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

/** 设备数据文件名（放在 `$DSH_HOME` 下，绝不写 profile patch）。 */
const DATA_FILE_NAME = "remote-devices.json";
/** 数据文件里 tokens 字段只用于"凭据服务不可用"的退化路线（见 README）。 */
const DATA_TOKENS_FIELD = "tokens";
/** 数据文件里 sessions 字段同理（0.8.1：远端会话 cookie 的退化落点）。 */
const DATA_SESSIONS_FIELD = "sessions";
/** 数据文件里「对外入口」字段（0.10.0）：`{ enabled, port }`。 */
const DATA_EDGE_FIELD = "edge";
/** 对外入口默认端口（就是大家一直在用的那个）。 */
const EDGE_DEFAULT_PORT = 19387;
/** 对外入口**永远**挡掉的路径前缀：设置页/写路由只认回环，不能被入口放出去。 */
const EDGE_BLOCKED_PREFIXES = ["/plugin/"];
/** 数据文件里「分叉带走的条数」字段（缺省不写这个键 = 用 {@link FORK_DEFAULT_TAIL}）。 */
const DATA_FORK_TAIL_FIELD = "forkTailN";
/** 凭据 ref 的固定前缀（后接设备 id 的 sha256 前 16 位十六进制）。 */
const TOKEN_REF_PREFIX = "DSH_REMOTE_TOKEN_";
/** **远端会话 cookie** 的凭据 ref 前缀（0.8.1：让 cookie 活过本机重启，等价于"浏览器把 cookie 存下来"）。 */
const SESSION_REF_PREFIX = "DSH_REMOTE_SESSION_";
/** 数据文件热重载的最小间隔（手改文件后最多 1 秒生效）。 */
const DATA_RELOAD_MIN_INTERVAL_MS = 1_000;

/** 连接（拿到响应头 / 首个字节之前）的超时；流式响应本身不设总超时。 */
const CONNECT_TIMEOUT_MS = 15_000;
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
/** 分叉时回看的消息条数：缺省、下限与上限（可在设置页「配置」块里改，存数据文件、立即生效）。 */
const FORK_DEFAULT_TAIL = 20;
const FORK_MAX_TAIL = 200;
const FORK_MIN_TAIL = 1;

/**
 * 「分叉带走的条数」的规范形式：`FORK_MIN_TAIL..FORK_MAX_TAIL` 的**整数**。
 * 只认 number，与 `tailN` 的既有契约一致：小数 / 越界 / 字符串 / null 一律 `undefined`（= 不合法）。
 */
function normalizeForkTail(value) {
	if (!Number.isSafeInteger(value)) return undefined;
	return value >= FORK_MIN_TAIL && value <= FORK_MAX_TAIL ? value : undefined;
}

/** 生效的「分叉带走的条数」：数据文件里存的值 → 缺省 {@link FORK_DEFAULT_TAIL}。 */
function effectiveForkTail(runtime) {
	const stored = normalizeForkTail(runtime.data.forkTailN);
	return stored === undefined ? FORK_DEFAULT_TAIL : stored;
}
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
function base64Url(buffer) {
	return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** 某 authority 对应的会话 cookie 名（用于精确取用，顺带避免把本机 cookie 发到远端）。 */
function cookieNameFor(authority) {
	return AUTH_COOKIE_PREFIX + base64Url(createHash("sha256").update(authority).digest());
}

/** 从 Cookie 头里取一个精确名字的值（实现同远端的 cookieValue：只认第一段同名）。 */
function readCookie(cookieHeader, wanted) {
	if (typeof cookieHeader !== "string" || cookieHeader === "") return undefined;
	for (const segment of cookieHeader.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1 || segment.slice(0, at).trim() !== wanted) continue;
		const value = segment.slice(at + 1).trim();
		return value === "" ? undefined : value;
	}
	return undefined;
}

/** 一条错误的可读消息。 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 宽松地发一条告警；ctx.logger 缺失时退回 console（宿主进程里两者都进 DSH 日志）。 */
function warn(ctx, message) {
	try {
		const logger = ctx && ctx.logger;
		if (logger && typeof logger.warn === "function") logger.warn(`[dsh-remote] ${message}`);
		else console.warn(`[dsh-remote] ${message}`);
	} catch {
		/* 日志失败绝不能影响请求处理 */
	}
}

/** 一条普通信息日志（"认领了哪台是本机"这类正常但值得看见的事）；info 缺失时退回 console。 */
function info(ctx, message) {
	try {
		const logger = ctx && ctx.logger;
		if (logger && typeof logger.info === "function") logger.info(`[dsh-remote] ${message}`);
		else console.log(`[dsh-remote] ${message}`);
	} catch {
		/* 日志失败绝不能影响装配 */
	}
}

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

/**
 * 说明文本里的用户可控值（设备名/地址/原因都来自配置或上游）。
 * 把尖括号换成全角，保证**插件产生的响应体里连一个 `<` 都不会出现**。
 */
function plainValue(value) {
	return String(value).replaceAll("<", "\uFF1C").replaceAll(">", "\uFF1E");
}

/** 端口归一：只接受 1..65535 的整数（0 是"由 OS 分配"，对不上任何 url）。 */
function toPort(value) {
	const port = typeof value === "number" ? value : Number(String(value ?? "").trim());
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

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

/** 设备 id → 凭据 ref 名（`^[A-Za-z_][A-Za-z0-9_]*$`，所以只能派生，不能直接用 id）。 */
function tokenRefFor(deviceId) {
	return TOKEN_REF_PREFIX + createHash("sha256").update(String(deviceId)).digest("hex").slice(0, 16);
}

/** 设备 id → **远端会话 cookie** 的凭据 ref 名（0.8.1：cookie 也存下来，见 README「会话 cookie 落盘」）。 */
function sessionRefFor(deviceId) {
	return SESSION_REF_PREFIX + createHash("sha256").update(String(deviceId)).digest("hex").slice(0, 16);
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

/** `$DSH_HOME` = `process.env.DSH_HOME` 或 `%USERPROFILE%\.dsh`。 */
function dshHome() {
	const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
	if (fromEnv !== "") return fromEnv;
	try {
		return join(homedir(), ".dsh");
	} catch {
		return ".dsh";
	}
}

/** 数据文件的最终路径（`config.dataFile` 只为自测/特殊部署预留）。 */
function resolveDataPath(config) {
	const override = config !== null && typeof config === "object" && typeof config.dataFile === "string" ? config.dataFile.trim() : "";
	if (override !== "") return override;
	return join(dshHome(), DATA_FILE_NAME);
}

/** 设备数据文件里的一条记录（只保留契约里那三个字段）。 */
function cleanStoredDevice(entry) {
	return {
		id: typeof entry.id === "string" ? entry.id.trim() : "",
		name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : "",
		url: typeof entry.url === "string" ? entry.url.trim() : "",
	};
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
 *   `enabled:false`（或 404 = 插件已被卸载）才自除：清键 → 摘胶囊 → 还原原语 → 带哨兵刷新一次。
 *   拿到 `enabled:true` 时：本次若是**惰性**（因为 payload/哨兵而没挂载）→ **惰性自愈**：
 *   写 `force-active` 标记、清哨兵、带防循环保护地刷新一次（同一窗口最多一次）；
 *   否则只清哨兵。请求失败 / 拿不到合法 JSON → 安静什么都不做（一次探测失败绝不能影响页面）。
 * - **没有选中设备时完全惰性**：不碰 fetch / WebSocket / XMLHttpRequest。
 * - 选中设备 `X` 时，把同源的 `api/…`、`/api/…`、`./api/…` 改写成 `/dev/X/…`
 *   （fetch、WebSocket、XMLHttpRequest.open 三处），其它 URL 原样放行。
 * - 右下角一个「设备：<名字>」胶囊，点开列出所有设备 + 「本机」；点击写 localStorage 后 `location.reload()`。
 *
 * @param options - `{ devices, localName, localCaption?, helloPath?, statePath?, enabled?, sentinelKey?, forceActiveKey? }`
 *   （宿主按当前设备表与 `enabled` 生成）。
 * @returns 幂等槽位对象（重复执行直接返回它，不再包装）。
 */
function remoteShim(options) {
	var KEYS_CURRENT = ["dsh-device-switch:current", "dsh-remote:current"];
	var KEYS_DEVICES = ["dsh-device-switch:devices", "dsh-remote:devices"];
	var SLOT = "__DSH_REMOTE_SHIM__";
	var ELEMENT_ID = "dsh-remote-root";
	var PREFIX = "/dev/";
	var ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
	var root = globalThis;
	var config = options !== null && typeof options === "object" ? options : {};
	var defaults = Array.isArray(config.devices) ? config.devices : [];
	var localName = typeof config.localName === "string" && config.localName !== "" ? config.localName : "本机";
	// 菜单条目文案与胶囊文案分开：菜单里本机项要带主机名（`设备A（本机 my-pc）`），
	// 胶囊上只需要短标签（`设备A · 本机`）。旧调用方只传 localName 时行为不变。
	var localCaption = typeof config.localCaption === "string" && config.localCaption !== "" ? config.localCaption : localName;
	var helloPath = typeof config.helloPath === "string" && config.helloPath !== "" ? config.helloPath : "/plugin/remote/hello";
	// 自检问的是状态接口（宿主注入时按当前 enabled 现算，见 currentShimScript）。
	var statePath = typeof config.statePath === "string" && config.statePath !== "" ? config.statePath : "/plugin/remote/state";
	var hostEnabled = config.enabled !== false;
	var sentinelKey = typeof config.sentinelKey === "string" && config.sentinelKey !== "" ? config.sentinelKey : "dsh-remote:soft-off";
	// "强制激活"标记的键（与客户端半用同一个键名）：读到非空 → 忽略 payload.enabled 与哨兵。
	var forceActiveKey = typeof config.forceActiveKey === "string" && config.forceActiveKey !== ""
		? config.forceActiveKey
		: "dsh-remote:force-active";

	var installed = root[SLOT];
	if (installed !== null && typeof installed === "object" && installed.installed === true) return installed;

	/**
	 * 本垫片的幂等槽位。**在两条通道（patch 与自除）之前就建好**，
	 * 这样自检路径也拿得到它（`enabled:false` 时用一个惰性槽位顶上）。
	 */
	var slot = { installed: true, selected: "", patched: [] };
	root[SLOT] = slot;

	//#region 存储

	function normalizeId(value) {
		if (typeof value !== "string") return "";
		var trimmed = value.trim();
		return ID_PATTERN.test(trimmed) ? trimmed : "";
	}

	function readStored(key) {
		try {
			var storage = root.localStorage;
			if (storage === null || typeof storage !== "object") return null;
			var value = storage.getItem(key);
			return typeof value === "string" ? value : null;
		} catch (error) {
			return null;
		}
	}

	function writeStored(key, value) {
		try {
			var storage = root.localStorage;
			if (storage === null || typeof storage !== "object") return false;
			if (value === "") storage.removeItem(key);
			else storage.setItem(key, value);
			return true;
		} catch (error) {
			return false;
		}
	}

	/** sessionStorage 读：读不到 / 不可用一律当"没设过"（绝不让存储异常影响页面）。 */
	function readSession(key) {
		try {
			var storage = root.sessionStorage;
			if (storage === null || typeof storage !== "object") return "";
			var value = storage.getItem(key);
			return typeof value === "string" ? value : "";
		} catch (error) {
			return "";
		}
	}

	/** sessionStorage 写（空串 = 删键）；返回是否真的写成功（不可用时 false）。 */
	function writeSession(key, value) {
		try {
			var storage = root.sessionStorage;
			if (storage === null || typeof storage !== "object") return false;
			if (value === "") storage.removeItem(key);
			else storage.setItem(key, value);
			return true;
		} catch (error) {
			return false;
		}
	}

	/** sessionStorage 的哨兵：读不到 / 不可用一律当"没设过"。 */
	function readSentinel() {
		return readSession(sentinelKey);
	}

	function writeSentinel(value) {
		return writeSession(sentinelKey, value);
	}

	/**
	 * "强制激活"标记：非空 = 这次加载忽略 payload.enabled 与哨兵，直接走正常模式。
	 * 读不到（sessionStorage 不可用）时按"没有"处理。
	 */
	function readForceActive() {
		return readSession(forceActiveKey) !== "";
	}

	/** 置 / 清"强制激活"标记；返回是否真的写成功（写不进去时调用方要自己决定降级）。 */
	function writeForceActive(on) {
		return writeSession(forceActiveKey, on === true ? "1" : "");
	}

	/**
	 * 把四个键一起清掉（"当前设备"+"设备列表"，主键与别名）。
	 * 停用后重开不能继续跑远端，靠的就是这一步。
	 */
	function clearStoredSelection() {
		writeAll(KEYS_CURRENT, "");
		writeAll(KEYS_DEVICES, "");
	}

	/** 多个键里第一个有值的（主键优先，别名兜底：客户端半用哪个都行）。 */
	function readFirst(keys) {
		for (var index = 0; index < keys.length; index += 1) {
			var value = readStored(keys[index]);
			if (value !== null) return value;
		}
		return null;
	}

	/** 写入所有键（空串 = 删除该键）。 */
	function writeAll(keys, value) {
		var wrote = false;
		for (var index = 0; index < keys.length; index += 1) {
			if (writeStored(keys[index], value)) wrote = true;
		}
		return wrote;
	}

	//#endregion

	//#region 报到 + 自检（注入是否生效 / 插件是否已停用）

	function reportHello() {
		try {
			var original = root.fetch;
			if (typeof original !== "function") return;
			var result = original.call(root, helloPath, { method: "POST", credentials: "same-origin", cache: "no-store" });
			if (result !== null && typeof result === "object" && typeof result.then === "function") {
				result.then(function () {}, function () {});
			}
		} catch (error) {
			/* 报到失败绝不能影响页面 */
		}
	}

	/** 摘掉自己画的那颗胶囊（幂等；没挂过就什么都不做）。 */
	function removePill() {
		try {
			var doc = root.document;
			if (doc === null || typeof doc !== "object" || typeof doc.getElementById !== "function") return false;
			var node = doc.getElementById(ELEMENT_ID);
			if (node === null || node === undefined) return false;
			var parent = node.parentNode;
			if (parent !== null && parent !== undefined && typeof parent.removeChild === "function") {
				parent.removeChild(node);
				return true;
			}
			if (typeof node.remove === "function") {
				node.remove();
				return true;
			}
		} catch (error) {
			/* 摘不掉也不能影响页面 */
		}
		return false;
	}

	/**
	 * 还原被改写过的网络原语（尽力而为：每一步独立 try）。
	 * `slot.patched` 记着这次到底 patch 了哪几个。
	 */
	function restorePrimitives() {
		for (var index = 0; index < slot.patched.length; index += 1) {
			var which = slot.patched[index];
			try {
				if (which === "fetch" && typeof root.fetch === "function" && typeof root.fetch.__dshRemoteOriginal === "function") {
					root.fetch = root.fetch.__dshRemoteOriginal;
				} else if (which === "websocket" && typeof root.WebSocket === "function" && typeof root.WebSocket.__dshRemoteOriginal === "function") {
					root.WebSocket = root.WebSocket.__dshRemoteOriginal;
				} else if (which === "xhr" && typeof root.XMLHttpRequest === "function") {
					var xhr = root.XMLHttpRequest;
					if (xhr.prototype !== null && xhr.prototype !== undefined && typeof xhr.prototype.open === "function"
						&& typeof xhr.prototype.open.__dshRemoteOriginal === "function") {
						xhr.prototype.open = xhr.prototype.open.__dshRemoteOriginal;
					}
				}
			} catch (error) {
				/* 还原失败就保持现状：页面继续按已改写的原语工作，一样能用 */
			}
		}
	}

	/** 带哨兵地刷新一次：同一窗口最多刷一次，避免"停用状态下无限刷新"。 */
	function reloadOnce() {
		if (readSentinel() !== "") return false;
		writeSentinel("1");
		try {
			root.location.reload();
			return true;
		} catch (error) {
			/* 下面兜底 */
		}
		try {
			root.location.href = root.location.href;
			return true;
		} catch (error) {
			return false;
		}
	}

	/** 自除：回到"本机直连、没有胶囊"的干净状态，然后刷新一次。 */
	function softOff() {
		try {
			clearStoredSelection();
			removePill();
			restorePrimitives();
			slot.selected = "";
			slot.patched = [];
			reloadOnce();
		} catch (error) {
			/* 自除失败绝不能把页面弄坏 */
		}
	}

	/**
	 * **惰性自愈**：本次加载因为 payload 里的 `enabled:false` 或哨兵在位而没走正常模式
	 * （不 patch、不挂胶囊，已经错过挂载时机），但自检发现宿主其实 `enabled:true`。
	 *
	 * 动作顺序不许换：置 `force-active` 标记（下次加载忽略 payload/哨兵、直接走正常模式）
	 * → 清哨兵 → 带防循环保护地刷一次。
	 *
	 * **防循环的第一道**：`force-active` 写不进去（sessionStorage 被禁 / 不可用）时**绝不刷新** ——
	 * 否则每次加载都会再走一遍自愈，变成"无限刷新"。此时降级为"等用户手动重载一次"
	 * （修复前的行为：需要再点一次「重载窗口」）。
	 * 写得进去时最多刷一次：刷新后的那个窗口同步阶段必然读到标记、走正常模式并把它用掉，
	 * 于是不会再来自愈；哨兵的第二道保护由 `reloadOnce` 提供。
	 * @returns 是否真的刷新了。
	 */
	function healLazy() {
		if (!writeForceActive(true)) return false;
		writeSentinel("");
		return reloadOnce();
	}

	/**
	 * 异步自检：同步 patch **之后**才跑，绝不阻塞首屏请求。
	 * 只有拿到明确的 `enabled:false`，或 404（插件已被卸载 / 路由没了）才自除；
	 * 其余一切情况（网络失败、非 JSON、没有这个字段）都安静地什么都不做。
	 */
	function checkHostState() {
		try {
			var original = root.fetch;
			if (typeof original !== "function") return;
			var result = original.call(root, statePath, { method: "GET", credentials: "same-origin", cache: "no-store" });
			if (result === null || typeof result !== "object" || typeof result.then !== "function") return;
			result.then(function (response) {
				if (response === null || typeof response !== "object") return undefined;
				var status = typeof response.status === "number" ? response.status : 0;
				if (status === 404) {
					softOff();
					return undefined;
				}
				if (typeof response.json !== "function") return undefined;
				return response.json().then(function (state) {
					if (state === null || typeof state !== "object") return;
					if (state.enabled === false) {
						softOff();
						return;
					}
					if (state.enabled === true) {
						writeSentinel("");
						// 宿主是开着的，但本次是惰性的（错过挂载时机）→ 自愈：置标记 + 刷一次。
						if (lazy === true) healLazy();
					}
				}, function () {});
			}, function () {});
		} catch (error) {
			/* 自检失败绝不能影响页面 */
		}
	}

	//#endregion

	/**
	 * 本次加载是不是"惰性"：不同步 patch、不挂胶囊，只剩自检这一件事。
	 * 两种原因：payload 里的 `enabled === false`（宿主注入时就是停用的），或哨兵在位
	 * （这个窗口已经为"停用"刷过一次）；唯一的例外是 `force-active` 标记 —— 它压倒一切，
	 * 强制走正常模式（这样"开启后一次刷新胶囊就回来"）。自检的惰性自愈要用这个判断。
	 */
	var forcedActive = readForceActive();
	var lazy = forcedActive !== true && (hostEnabled !== true || readSentinel() !== "");

	/**
	 * 停用（`enabled:false`）时脚本只剩"自检"这一件事：**不同步 patch、不挂胶囊**。
	 * 直接返回一个惰性槽位，让页面保持"本机直连、没有胶囊"的干净状态。
	 * 宿主注入时给的 `enabled` 可能不是最新的（桌面壳把注入行缓存到窗口生命周期），
	 * 所以这里仍然跑自检：在老窗口里它会发现 `enabled:false` 并自除 + 刷新一次；
	 * 反过来，如果发现宿主其实开着，就置 `force-active` 并刷一次（惰性自愈）。
	 */
	if (lazy === true) {
		checkHostState();
		return slot;
	}

	// 走到这里就是"正常模式"（含 force-active 强制激活）：标记用掉就删，它只该生效一次
	// ——否则关停时客户端半还得再清一次它，且可能让下一次加载莫名其妙地又强制激活一遍。
	if (forcedActive === true) writeForceActive(false);

	var selected = normalizeId(readFirst(KEYS_CURRENT));
	slot.selected = selected;
	reportHello();

	//#region URL 改写

	function hasScheme(value) {
		return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
	}

	/**
	 * "本机"的 authority 集合：当前文档的 host，加上 `__DSH_TRANSPORT__.streamBaseUrl`（桌面壳在
	 * 注入行之前就写好了它，值为本机 Host 的 origin）与 `document.baseURI` 的 host。
	 * 只**读** `__DSH_TRANSPORT__`，绝不改写它（I2）。
	 */
	function localHosts() {
		var hosts = [];
		function add(value) {
			if (typeof value !== "string" || value === "") return;
			for (var index = 0; index < hosts.length; index += 1) if (hosts[index] === value) return;
			hosts.push(value);
		}
		var location = root.location;
		if (location !== null && typeof location === "object") add(location.host);
		var transport = root.__DSH_TRANSPORT__;
		var base = transport !== null && typeof transport === "object" && typeof transport.streamBaseUrl === "string" ? transport.streamBaseUrl : "";
		if (base === "") {
			var doc = root.document;
			if (doc !== null && typeof doc === "object" && typeof doc.baseURI === "string") base = doc.baseURI;
		}
		if (base !== "" && typeof root.URL === "function" && location !== null && typeof location === "object" && typeof location.href === "string") {
			try {
				add(new root.URL(base, location.href).host);
			} catch (error) {
				/* 解析不了就算了，不影响其它 host */
			}
		}
		return hosts;
	}

	/** `/api…` → `/dev/<selected>/api…`；其它路径返回 null（原样放行）。 */
	function prefixPath(pathname) {
		if (typeof pathname !== "string" || pathname === "") return null;
		if (pathname === "/api" || pathname.slice(0, 5) === "/api/") return PREFIX + selected + pathname;
		return null;
	}

	/**
	 * 把一次请求 URL 改写到代理前缀下。
	 * - 字符串/URL 的**相对**写法 → 返回路径形式（如 `"/dev/home/api/sessions"`）
	 * - **绝对**写法 → 保留 scheme 与 host:port，只换路径
	 * - 不同源、或不是 api 路径 → 返回 null（调用方原样透传）
	 */
	function rewriteUrl(raw) {
		if (typeof raw !== "string" || raw === "") return null;
		var location = root.location;
		if (typeof root.URL !== "function" || location === null || typeof location !== "object" || typeof location.href !== "string") return null;
		var parsed = null;
		try {
			parsed = new root.URL(raw, location.href);
		} catch (error) {
			parsed = null;
		}
		if (parsed !== null) {
			var hosts = localHosts();
			var sameHost = false;
			for (var index = 0; index < hosts.length; index += 1) {
				if (hosts[index] === parsed.host) {
					sameHost = true;
					break;
				}
			}
			if (sameHost) {
				var path = prefixPath(parsed.pathname);
				if (path !== null) {
					if (hasScheme(raw)) return parsed.protocol + "//" + parsed.host + path + parsed.search + parsed.hash;
					return path + parsed.search + parsed.hash;
				}
			}
		}
		// 兜底：解析不出来（或 host 对不上）时，只认"相对写法 + 明显是 api 路径"的输入。
		if (!hasScheme(raw)) {
			var bare = raw.slice(0, 2) === "./" ? raw.slice(2) : raw;
			if (bare === "api" || bare.slice(0, 4) === "api/") return PREFIX + selected + "/" + bare;
		}
		return null;
	}

	//#endregion

	//#region fetch / WebSocket / XHR 改写（幂等）

	function rebuildRequest(target, request) {
		var RequestCtor = root.Request;
		if (typeof RequestCtor !== "function") return target;
		try {
			return new RequestCtor(target, request);
		} catch (error) {
			/* 继续手工重建 */
		}
		try {
			var init = {
				method: request.method,
				headers: request.headers,
				mode: request.mode,
				credentials: request.credentials,
				cache: request.cache,
				redirect: request.redirect,
				referrer: request.referrer,
				referrerPolicy: request.referrerPolicy,
				integrity: request.integrity,
				keepalive: request.keepalive,
				signal: request.signal,
			};
			if (request.body !== null && request.body !== undefined) {
				init.body = request.body;
				init.duplex = "half";
			}
			return new RequestCtor(target, init);
		} catch (error) {
			/* 再退一步：退回纯 URL 字符串（fetch 的第二个参数仍然生效） */
		}
		return target;
	}

	function patchFetch() {
		var original = root.fetch;
		if (typeof original !== "function" || original.__dshRemotePatched === true) return false;
		function patchedFetch(input, init) {
			var self = this === undefined || this === null ? root : this;
			try {
				var replacement = null;
				if (typeof input === "string") {
					replacement = rewriteUrl(input);
				} else if (input !== null && typeof input === "object") {
					if (typeof input.url === "string" && typeof root.Request === "function") {
						var target = rewriteUrl(input.url);
						if (target !== null) replacement = rebuildRequest(target, input);
					} else if (typeof input.href === "string") {
						replacement = rewriteUrl(input.href);
					}
				}
				if (replacement !== null) return original.call(self, replacement, init);
			} catch (error) {
				/* 垫片绝不能把请求弄挂：改写失败就照原样发 */
			}
			return original.call(self, input, init);
		}
		patchedFetch.__dshRemotePatched = true;
		patchedFetch.__dshRemoteOriginal = original;
		root.fetch = patchedFetch;
		return true;
	}

	function patchWebSocket() {
		var Original = root.WebSocket;
		if (typeof Original !== "function" || Original.__dshRemotePatched === true) return false;
		function PatchedWebSocket(url, protocols) {
			var finalUrl = url;
			try {
				var raw = typeof url === "string" ? url : (url !== null && typeof url === "object" && typeof url.href === "string" ? url.href : null);
				var target = raw === null ? null : rewriteUrl(raw);
				if (target !== null) finalUrl = target;
			} catch (error) {
				finalUrl = url;
			}
			if (protocols === undefined) return new Original(finalUrl);
			return new Original(finalUrl, protocols);
		}
		PatchedWebSocket.prototype = Original.prototype;
		var constants = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
		for (var index = 0; index < constants.length; index += 1) {
			var key = constants[index];
			if (Original[key] !== undefined) PatchedWebSocket[key] = Original[key];
		}
		PatchedWebSocket.__dshRemotePatched = true;
		PatchedWebSocket.__dshRemoteOriginal = Original;
		root.WebSocket = PatchedWebSocket;
		return true;
	}

	function patchXhr() {
		var Original = root.XMLHttpRequest;
		if (typeof Original !== "function" || Original.prototype === null || Original.prototype === undefined) return false;
		var originalOpen = Original.prototype.open;
		if (typeof originalOpen !== "function" || originalOpen.__dshRemotePatched === true) return false;
		function patchedOpen(method, url) {
			var finalUrl = url;
			try {
				var raw = typeof url === "string" ? url : (url !== null && typeof url === "object" && typeof url.href === "string" ? url.href : null);
				var target = raw === null ? null : rewriteUrl(raw);
				if (target !== null) finalUrl = target;
			} catch (error) {
				finalUrl = url;
			}
			var rest = Array.prototype.slice.call(arguments, 2);
			return originalOpen.apply(this, [method, finalUrl].concat(rest));
		}
		patchedOpen.__dshRemotePatched = true;
		// 自除时要靠它还原（见 restorePrimitives / softOff）。
		patchedOpen.__dshRemoteOriginal = originalOpen;
		try {
			Original.prototype.open = patchedOpen;
		} catch (error) {
			return false;
		}
		return true;
	}

	if (selected !== "") {
		if (patchFetch()) slot.patched.push("fetch");
		if (patchWebSocket()) slot.patched.push("websocket");
		if (patchXhr()) slot.patched.push("xhr");
	}

	//#endregion

	//#region 设备列表与右下角胶囊

	function loadDevices() {
		var list = [];
		var seen = {};
		function push(entry) {
			if (entry === null || typeof entry !== "object") return;
			var id = normalizeId(entry.id);
			if (id === "" || seen[id] === true) return;
			seen[id] = true;
			var name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : id;
			list.push({ id: id, name: name });
		}
		var parsed = null;
		var raw = readFirst(KEYS_DEVICES);
		if (raw !== null) {
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				parsed = null;
			}
		}
		var source = Array.isArray(parsed) ? parsed : defaults;
		for (var index = 0; index < source.length; index += 1) push(source[index]);
		// 选中了一台当前列表里没有的设备（配置改过 / 设备被删）：也让它出现在胶囊里，好切回来。
		if (selected !== "" && seen[selected] !== true) list.push({ id: selected, name: selected });
		return list;
	}

	/** 条目：本机（id 为空串）在最前，其后是所有设备。 */
	function buildEntries() {
		var entries = [{ id: "", name: localName }];
		var devices = loadDevices();
		for (var index = 0; index < devices.length; index += 1) entries.push(devices[index]);
		return entries;
	}

	function currentName(entries) {
		for (var index = 0; index < entries.length; index += 1) if (entries[index].id === selected) return entries[index].name;
		return selected === "" ? localName : selected;
	}

	/** 胶囊文案：本机用 localCaption（`<名字> · 本机`），选中的远端用它的名字（与旧版一致）。 */
	function currentCaption(entries) {
		for (var index = 0; index < entries.length; index += 1) {
			if (entries[index].id !== selected) continue;
			return entries[index].id === "" ? localCaption : entries[index].name;
		}
		return selected === "" ? localCaption : selected;
	}

	function escapeHtml(value) {
		return String(value).replace(/[&<>"']/g, function (character) {
			if (character === "&") return "&amp;";
			if (character === "<") return "&lt;";
			if (character === ">") return "&gt;";
			if (character === '"') return "&quot;";
			return "&#39;";
		});
	}

	function mount() {
		var doc = root.document;
		if (doc === null || typeof doc !== "object" || typeof doc.createElement !== "function") return;
		if (typeof doc.getElementById === "function" && doc.getElementById(ELEMENT_ID) !== null) return;
		var entries = buildEntries();
		// 只有「本机」一项时完全不加 UI（配置为空的插件保持惰性）。
		if (entries.length < 2) return;

		var container = doc.createElement("div");
		container.id = ELEMENT_ID;
		container.setAttribute("data-dsh-remote", "shim");
		container.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;"
			+ "flex-direction:column;align-items:flex-end;gap:6px;"
			+ "font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#fff;-webkit-app-region:no-drag";

		var panel = doc.createElement("div");
		panel.id = ELEMENT_ID + "-panel";
		panel.style.cssText = "min-width:180px;max-width:280px;max-height:46vh;overflow:auto;"
			+ "background:rgba(24,24,28,.95);border:1px solid rgba(255,255,255,.14);border-radius:10px;"
			+ "box-shadow:0 8px 24px rgba(0,0,0,.35);padding:6px";
		panel.hidden = true;

		var markup = '<div style="opacity:.55;padding:2px 8px 6px;font-size:11px">'
			+ "切换 DSH 设备（本窗口界面始终是本机那份）</div>";
		for (var index = 0; index < entries.length; index += 1) {
			var entry = entries[index];
			var active = entry.id === selected;
			markup += '<button type="button" data-device-id="' + escapeHtml(entry.id) + '"'
				+ (active ? ' data-current="1"' : "")
				+ ' style="display:block;width:100%;text-align:left;padding:6px 8px;border:0;border-radius:7px;'
				+ "background:" + (active ? "rgba(103,158,254,.22)" : "transparent") + ";color:#fff;font:inherit;"
				+ "cursor:" + (active ? "default" : "pointer") + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
				+ (active ? "● " : "") + escapeHtml(entry.name)
				+ '<span style="opacity:.5;font-size:11px;margin-left:6px">'
				+ (entry.id === "" ? "本机流量" : "/dev/" + escapeHtml(entry.id) + "/") + "</span></button>";
		}
		panel.innerHTML = markup;

		var label = currentName(entries);
		var caption = currentCaption(entries);
		var toggle = doc.createElement("button");
		toggle.type = "button";
		toggle.id = ELEMENT_ID + "-toggle";
		toggle.textContent = "设备：" + caption;
		toggle.title = "切换 DSH 设备（当前：" + label + "）";
		toggle.style.cssText = "padding:5px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.18);"
			+ "background:rgba(24,24,28,.92);color:#fff;font:inherit;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)";

		function hide() {
			panel.hidden = true;
		}

		toggle.addEventListener("click", function (event) {
			event.stopPropagation();
			panel.hidden = !panel.hidden;
		});
		panel.addEventListener("click", function (event) {
			var target = event.target;
			var button = target !== null && typeof target === "object" && typeof target.closest === "function"
				? target.closest("button[data-device-id]")
				: null;
			if (button === null || button === undefined) return;
			event.preventDefault();
			event.stopPropagation();
			var id = normalizeId(button.getAttribute("data-device-id"));
			if (id === selected) {
				hide();
				return;
			}
			writeAll(KEYS_CURRENT, id);
			try {
				root.location.reload();
				return;
			} catch (error) {
				/* 下面兜底 */
			}
			try {
				root.location.href = root.location.href;
			} catch (error) {
				/* 放弃 */
			}
		});
		doc.addEventListener("keydown", function (event) {
			if (event.key === "Escape") hide();
		});
		doc.addEventListener("click", function (event) {
			if (!container.contains(event.target)) hide();
		}, true);

		container.appendChild(panel);
		container.appendChild(toggle);
		var anchor = doc.body !== null && doc.body !== undefined ? doc.body : doc.documentElement;
		if (anchor !== null && anchor !== undefined && typeof anchor.appendChild === "function") anchor.appendChild(container);
	}

	var doc = root.document;
	if (doc !== null && typeof doc === "object" && doc.readyState === "loading" && typeof doc.addEventListener === "function") {
		doc.addEventListener("DOMContentLoaded", mount, { once: true });
	} else {
		mount();
	}

	//#endregion

	// 同步 patch 与胶囊都已经就位了，现在才异步自检（时序：绝不让首屏请求等这次探测）。
	checkHostState();

	return slot;
}

/** 把垫片序列化成一条可注入的 `<script>` 文本（纯追加，改不动页面里任何既有内容）。 */
function renderShimScript(options) {
	const source = remoteShim.toString();
	return `${SHIM_MARKER}\n(${source})(${inlineJson(options)});`;
}

//#endregion

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
	};
}

/**
 * 归一化 `config.devices`（保留 device-switch 的同名导出，selftest 与"配置种子"都用它）。
 * @returns 归一化后的设备数组。
 */
export function normalizeDevices(ctx, config) {
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
export function collectHostFacts(ctx) {
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
export function deviceMatchesLocal(device, facts) {
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
export function resolveLocalDevice(devices, current, facts) {
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
export function localEntryName(device, facts) {
	const hostname = facts !== null && typeof facts === "object" && typeof facts.hostname === "string" ? facts.hostname.trim() : "";
	if (device === undefined || device === null) return hostname === "" ? "本机" : `本机（${hostname}）`;
	return hostname === "" ? `${device.name}（本机）` : `${device.name}（本机 ${hostname}）`;
}

//#endregion

//#region 数据文件（$DSH_HOME/remote-devices.json）

/**
 * 读取数据文件。**同步**读：`apply()` 必须同步知道"启用/设备表"，
 * 否则 device-switch 那套"apply 之后路由就在"的语义会碎掉。
 * @returns `{ enabled, devices, current, tokens, existed }`，读不到/坏文件时返回 null。
 */
function readDataFile(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
		throw error;
	}
	const parsed = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("数据文件的根必须是 JSON 对象");
	}
	const devices = [];
	for (const entry of Array.isArray(parsed.devices) ? parsed.devices : []) {
		const device = cleanStoredDevice(entry === null || typeof entry !== "object" ? {} : entry);
		if (device.id !== "" && device.url !== "") devices.push(device);
	}
	const tokens = Object.create(null);
	const rawTokens = parsed[DATA_TOKENS_FIELD];
	if (rawTokens !== null && typeof rawTokens === "object" && !Array.isArray(rawTokens)) {
		for (const [key, value] of Object.entries(rawTokens)) {
			if (typeof value === "string" && value !== "") tokens[key] = value;
		}
	}
	const sessions = Object.create(null);
	const rawSessions = parsed[DATA_SESSIONS_FIELD];
	if (rawSessions !== null && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
		for (const [key, value] of Object.entries(rawSessions)) {
			if (typeof value === "string" && value !== "") sessions[key] = value;
		}
	}
	// 0.10.0：对外入口（{ enabled, port }）。
	const rawEdge = parsed[DATA_EDGE_FIELD];
	const edge = {
		enabled: rawEdge !== null && typeof rawEdge === "object" && !Array.isArray(rawEdge) && rawEdge.enabled === true,
		port: rawEdge !== null && typeof rawEdge === "object" && !Array.isArray(rawEdge) ? toPort(rawEdge.port) : undefined,
	};
	return {
		enabled: parsed.enabled !== false,
		devices,
		current: typeof parsed.current === "string" ? parsed.current.trim() : "",
		forkTailN: normalizeForkTail(parsed[DATA_FORK_TAIL_FIELD]),
		tokens,
		sessions,
		edge,
		existed: true,
	};
}

/** 数据文件的内容（**只有契约里那三个键**；token 只在退化路线下出现）。 */
function renderDataFile(runtime) {
	const payload = {
		enabled: runtime.data.enabled === true,
		devices: runtime.data.devices.map((entry) => cleanStoredDevice(entry)),
	};
	if (typeof runtime.data.current === "string" && runtime.data.current !== "") payload.current = runtime.data.current;
	const forkTail = normalizeForkTail(runtime.data.forkTailN);
	if (forkTail !== undefined) payload[DATA_FORK_TAIL_FIELD] = forkTail;
	if (runtime.tokens.mode() === "file" && Object.keys(runtime.fileTokens).length > 0) {
		payload[DATA_TOKENS_FIELD] = { ...runtime.fileTokens };
	}
	// 0.8.1：远端会话 cookie 的退化落点。主路线（凭据服务）下这里**一个字节都不写**。
	if (runtime.tokens.mode() === "file" && Object.keys(runtime.fileSessions).length > 0) {
		payload[DATA_SESSIONS_FIELD] = { ...runtime.fileSessions };
	}
	// 0.10.0：对外入口配置（只写真正的值，缺省不落键）。
	const edge = runtime.data.edge ?? {};
	if (edge.enabled === true || toPort(edge.port) !== undefined) {
		payload[DATA_EDGE_FIELD] = {
			enabled: edge.enabled === true,
			...(toPort(edge.port) === undefined ? {} : { port: toPort(edge.port) }),
		};
	}
	return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * 收紧数据文件权限。POSIX 上 `chmod 0600` 就是"仅当前用户可读"；
 * Windows 没有可检查的 mode（Node 的 chmod 只切只读位），所以额外尽力调一次 `icacls`
 * （去掉继承 + 只给当前用户完全控制），失败就如实记录在体检页里。
 * @returns 一句话说明，写进 `diagnostics.notes`。
 */
function hardenDataFile(path) {
	let note = "";
	if (process.platform !== "win32") {
		try {
			chmodSync(path, 0o600);
			return "已 chmod 600（仅属主可读）";
		} catch (error) {
			return `chmod 600 失败：${messageOf(error)}`;
		}
	}
	try {
		chmodSync(path, 0o600);
		note = "chmod 600";
	} catch (error) {
		note = `chmod 失败：${messageOf(error)}`;
	}
	const who = typeof process.env.USERNAME === "string" && process.env.USERNAME.trim() !== ""
		? process.env.USERNAME.trim()
		: (typeof process.env.USER === "string" ? process.env.USER.trim() : "");
	if (who !== "") {
		try {
			execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${who}:F`], { stdio: "ignore", timeout: 5_000, windowsHide: true });
			return `${note} + icacls（继承已去掉，只授 "${who}"）`;
		} catch (error) {
			return `${note}；icacls 收紧失败（Windows 上 chmod 不能真正收紧 ACL）：${messageOf(error)}`;
		}
	}
	return `${note}；Windows 上无法用 icacls 确认 ACL（USERNAME 为空）`;
}

/** 写数据文件（临时文件 + 改名，尽量原子），并回写 stamp 免得自己触发一次热重载。 */
function persistDataFile(runtime) {
	const path = runtime.dataPath;
	const text = renderDataFile(runtime);
	const temp = `${path}.tmp-${String(process.pid)}`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, path);
	let stamp = null;
	try {
		const stat = statSync(path);
		stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
	} catch {
		stamp = null;
	}
	runtime.dataStamp = stamp;
	// 只在"文件里真的要放明文 token"时收紧权限：主路线（凭据服务）下这个文件里没有机密，
	// 不必为它同步起一次 icacls 拖慢插件激活。
	const holdsPlaintext = runtime.tokens.mode() === "file"
		&& (Object.keys(runtime.fileTokens).length > 0 || Object.keys(runtime.seedTokens).length > 0
			|| Object.keys(runtime.fileSessions).length > 0);
	if (holdsPlaintext) runtime.hardeningNote = hardenDataFile(path);
	return text;
}

/** 把从文件里读到的东西装进运行时（含"凭据服务可用时把明文 token 迁走"）。 */
function adoptData(runtime, loaded) {
	runtime.data.enabled = loaded.enabled !== false;
	runtime.data.devices = loaded.devices.map((entry) => cleanStoredDevice(entry));
	runtime.data.current = typeof loaded.current === "string" ? loaded.current : "";
	runtime.data.forkTailN = normalizeForkTail(loaded.forkTailN);
	if (loaded.edge !== undefined && loaded.edge !== null && typeof loaded.edge === "object") {
		runtime.data.edge = { enabled: loaded.edge.enabled === true, port: toPort(loaded.edge.port) };
	}
	if (loaded.sessions !== undefined && typeof loaded.sessions === "object") {
		runtime.fileSessions = Object.create(null);
		for (const [key, value] of Object.entries(loaded.sessions)) {
			if (typeof value === "string" && value !== "") runtime.fileSessions[key] = value;
		}
	}
	if (loaded.tokens !== undefined && typeof loaded.tokens === "object") {
		runtime.fileTokens = Object.create(null);
		for (const [key, value] of Object.entries(loaded.tokens)) {
			if (typeof value === "string" && value !== "") runtime.fileTokens[key] = value;
		}
	}
}

/**
 * 手改数据文件也活着生效：stat 一下，变了就整体重读（最多每 1 秒一次）。
 * @returns 是否真的重载了。
 */
function maybeReloadData(runtime, force) {
	const now = Date.now();
	if (force !== true && now - runtime.lastReloadCheckAt < DATA_RELOAD_MIN_INTERVAL_MS) return false;
	runtime.lastReloadCheckAt = now;
	let stat;
	try {
		stat = statSync(runtime.dataPath);
	} catch {
		return false; // 文件被删/读不到：保持内存状态，不因为一次误删把设备清空
	}
	const stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
	if (stamp === runtime.dataStamp) return false;
	let loaded;
	try {
		loaded = readDataFile(runtime.dataPath);
	} catch (error) {
		warn(runtime.ctx, `数据文件解析失败，继续用内存里的状态：${messageOf(error)}`);
		runtime.dataStamp = stamp;
		return false;
	}
	runtime.dataStamp = stamp;
	if (loaded === null) return false;
	adoptData(runtime, loaded);
	syncEdge(runtime);
	info(runtime.ctx, `数据文件变化已生效：enabled=${String(runtime.data.enabled)}，设备 ${String(runtime.devices.length)} 台（重算路由）`);
	refreshDevices(runtime);
	void migrateFileTokens(runtime);
	return true;
}

//#endregion

//#region token 存储（凭据服务优先，数据文件只做退化）

/**
 * 造一个 token 存取器。
 * - `credentials` 模式：每条设备一个 ref（`DSH_REMOTE_TOKEN_<sha256(id) 前 16 位>`），
 *   值落在 `$DSH_HOME/.credentials.yaml`，数据文件里只留 id/name/url；
 * - `file` 模式（凭据服务不可用）：退化到数据文件的 `tokens` 字段，并收紧文件权限，
 *   体检页与 README 都明确标注"token 明文存储"。
 */
function createTokenStore(runtime) {
	return {
		mode: () => (runtime.credentials !== undefined && runtime.credentials !== null ? "credentials" : "file"),
		async get(deviceId) {
			if (runtime.credentials !== undefined && runtime.credentials !== null) {
				try {
					const hit = await runtime.credentials.resolve(tokenRefFor(deviceId));
					const value = hit !== null && typeof hit === "object" && typeof hit.value === "string" ? hit.value : "";
					return value === "" ? undefined : value;
				} catch (error) {
					warn(runtime.ctx, `读取凭据 ${tokenRefFor(deviceId)} 失败：${messageOf(error)}`);
					return undefined;
				}
			}
			// 退化路线：数据文件的 tokens 字段；种子里带过来的 token 先只放在内存里
			// （见 scheduleSeedTokenSettlement：确认凭据服务不可用后才落盘，避免白白写一次明文）。
			const fromFile = runtime.fileTokens[deviceId];
			if (typeof fromFile === "string" && fromFile !== "") return fromFile;
			const fromSeed = runtime.seedTokens[deviceId];
			return typeof fromSeed === "string" && fromSeed !== "" ? fromSeed : undefined;
		},
		async set(deviceId, token) {
			const value = typeof token === "string" ? token.trim() : "";
			if (value === "") return this.remove(deviceId);
			if (runtime.credentials !== undefined && runtime.credentials !== null) {
				await runtime.credentials.set(tokenRefFor(deviceId), value);
				return;
			}
			delete runtime.seedTokens[deviceId];
			runtime.fileTokens[deviceId] = value;
			runtime.tokenPlaintext = true;
		},
		async remove(deviceId) {
			delete runtime.seedTokens[deviceId];
			if (runtime.credentials !== undefined && runtime.credentials !== null) {
				try {
					await runtime.credentials.unset(tokenRefFor(deviceId));
				} catch (error) {
					warn(runtime.ctx, `移除凭据 ${tokenRefFor(deviceId)} 失败：${messageOf(error)}`);
				}
				return;
			}
			delete runtime.fileTokens[deviceId];
		},
	};
}

/**
 * **远端会话 cookie** 的存储（0.8.1）：跟 token 同一套路线 ——
 *  - `credentials` 模式：`ctx.credentials` 里 `DSH_REMOTE_SESSION_<sha256(id) 前 16 位>` 记录；
 *  - `file` 模式：数据文件的 `sessions` 字段（明文，权限照 token 那套收紧）。
 *
 * 为什么非要有：cookie 以前只活在进程内存（`runtime.sessions`）里，**本机 DSH 一重启就没了**，
 * 于是每次都要拿 token 重新兑换 —— 而"对方也重启过"时 token 早已作废，症状就是"切过去一直连接中"
 * （2026-10-13 实战）。存下来之后，只要 cookie 没过期就能直接用 ——
 * 这跟"网页端把 cookie 存在浏览器里"是同一个效果（用户 2026-10-13 的原话）。
 */
function createSessionStore(runtime) {
	const usable = () => runtime.credentials !== undefined && runtime.credentials !== null;
	return {
		mode: () => (usable() ? "credentials" : "file"),
		async get(deviceId) {
			if (usable()) {
				try {
					const hit = await runtime.credentials.resolve(sessionRefFor(deviceId));
					const value = hit !== null && typeof hit === "object" && typeof hit.value === "string" ? hit.value : "";
					return value === "" ? undefined : value;
				} catch (error) {
					warn(runtime.ctx, `读取凭据 ${sessionRefFor(deviceId)} 失败：${messageOf(error)}`);
					return undefined;
				}
			}
			const fromFile = runtime.fileSessions[deviceId];
			return typeof fromFile === "string" && fromFile !== "" ? fromFile : undefined;
		},
		async set(deviceId, cookie) {
			const value = typeof cookie === "string" ? cookie.trim() : "";
			if (value === "") return this.remove(deviceId);
			if (usable()) {
				try {
					await runtime.credentials.set(sessionRefFor(deviceId), value);
				} catch (error) {
					warn(runtime.ctx, `写入凭据 ${sessionRefFor(deviceId)} 失败（这次的会话只留在内存里）：${messageOf(error)}`);
				}
				return;
			}
			runtime.fileSessions[deviceId] = value;
			runtime.sessionPlaintext = true;
			try {
				persistDataFile(runtime);
			} catch (error) {
				warn(runtime.ctx, `写数据文件的 sessions 字段失败（这次的会话只留在内存里）：${messageOf(error)}`);
			}
		},
		async remove(deviceId) {
			if (usable()) {
				try {
					await runtime.credentials.unset(sessionRefFor(deviceId));
				} catch (error) {
					warn(runtime.ctx, `移除凭据 ${sessionRefFor(deviceId)} 失败：${messageOf(error)}`);
				}
				return;
			}
			if (runtime.fileSessions[deviceId] !== undefined) {
				delete runtime.fileSessions[deviceId];
				try {
					persistDataFile(runtime);
				} catch (error) {
					warn(runtime.ctx, `重写数据文件失败：${messageOf(error)}`);
				}
			}
		},
	};
}

/**
 * 凭据服务可用后，把数据文件 / 种子里带过来的明文 token 搬进凭据服务并把它从文件里删掉。
 * 让"先退化成文件、后来有了凭据服务"的部署自动收敛，而不是一直明文躺着。
 */
async function migrateFileTokens(runtime) {
	if (runtime.credentials === undefined || runtime.credentials === null) return;
	const ids = [...new Set([...Object.keys(runtime.fileTokens), ...Object.keys(runtime.seedTokens)])];
	if (ids.length === 0) return;
	const moved = [];
	for (const id of ids) {
		const token = runtime.fileTokens[id] ?? runtime.seedTokens[id];
		if (typeof token !== "string" || token === "") continue;
		try {
			await runtime.credentials.set(tokenRefFor(id), token);
			delete runtime.fileTokens[id];
			delete runtime.seedTokens[id];
			runtime.tokenCache.delete(id);
			moved.push(id);
		} catch (error) {
			warn(runtime.ctx, `把设备 "${id}" 的明文 token 迁进凭据服务失败（继续明文保存）：${messageOf(error)}`);
		}
	}
	if (moved.length > 0) {
		info(runtime.ctx, `已把 ${String(moved.length)} 台设备的 token 从数据文件迁进凭据服务（数据文件里不再有明文）`);
		try {
			persistDataFile(runtime);
		} catch (error) {
			warn(runtime.ctx, `迁移后重写数据文件失败：${messageOf(error)}`);
		}
	}
}

/** 种子里带过来的 token 落在哪：确认凭据服务在场就迁走，否则（延迟一会儿后）落进数据文件。 */
function scheduleSeedTokenSettlement(runtime) {
	if (Object.keys(runtime.seedTokens).length === 0) return;
	const timer = setTimeout(() => {
		runtime.timers.delete(timer);
		if (Object.keys(runtime.seedTokens).length === 0) return;
		if (runtime.credentials !== undefined && runtime.credentials !== null) {
			void migrateFileTokens(runtime);
			return;
		}
		for (const [id, token] of Object.entries(runtime.seedTokens)) runtime.fileTokens[id] = token;
		runtime.seedTokens = Object.create(null);
		try {
			persistDataFile(runtime);
			warn(runtime.ctx, `profile 配置里种子的 token 已迁进数据文件（凭据服务不可用）：token 明文存储，请留意 ${runtime.dataPath} 的权限收紧结果。`);
		} catch (error) {
			warn(runtime.ctx, `种子 token 落盘失败：${messageOf(error)}`);
		}
	}, SEED_TOKEN_SETTLE_MS);
	if (typeof timer.unref === "function") timer.unref();
	runtime.timers.add(timer);
}

//#endregion

//#region 会话（cookie jar + token 引导）

/**
 * 向远端发起一次 token 兑换：`GET <base>/?token=…`。
 * 远端返回 303 + `Set-Cookie: dsh-auth-<hash>=…`；这里只取 cookie，不跟随跳转。
 * @returns 会话 cookie 值；没有就是 undefined。
 */
/**
 * 从上游 `set-cookie` 里挑出会话 cookie，返回 **`name=value` 整对**（找不到返回 undefined）。
 *
 * **名字以服务器给的为准**：对外入口会把 Host 统一改写成 `127.0.0.1:<内部端口>`，
 * 被连接方签发的 cookie 名字会跟着变成那个 authority 的派生名 —— 再用 `device.authority` 派生名去筛，
 * 就会一个都收不到（罐子永远空 → 每个请求都不带 cookie → 远端回 401）。0.10.2 修的就是这一刀。
 */
function sessionPairFromSetCookie(headers) {
	for (const header of headers) {
		const first = String(header).split(";", 1)[0];
		const at = first.indexOf("=");
		if (at <= 0) continue;
		const name = first.slice(0, at).trim();
		const value = first.slice(at + 1).trim();
		if (name === "" || value === "") continue;
		if (name.startsWith("dsh-auth-")) return `${name}=${value}`;
	}
	return undefined;
}

function exchangeToken(device, token) {
	return new Promise((resolve, reject) => {
		const url = new URL(`${device.origin}${device.basePath}/`);
		url.searchParams.set("token", token);
		const send = device.protocol === "https:" ? httpsRequest : httpRequest;
		const upstream = send({
			protocol: url.protocol,
			hostname: device.hostname,
			port: device.port === "" ? undefined : device.port,
			path: `${url.pathname}${url.search}`,
			method: "GET",
			headers: {
				host: device.authority,
				origin: device.origin,
				accept: "text/html",
				"user-agent": USER_AGENT,
			},
		}, (response) => {
			const headers = response.headers["set-cookie"] ?? [];
			response.resume();
			const pair = sessionPairFromSetCookie(headers);
			response.on("error", reject);
			response.on("end", () => {
				resolve(pair);
			});
		});
		const timer = setTimeout(() => {
			upstream.destroy(new Error(`token 兑换超时（${String(CONNECT_TIMEOUT_MS)} ms）`));
		}, CONNECT_TIMEOUT_MS);
		upstream.on("close", () => {
			clearTimeout(timer);
		});
		upstream.on("error", reject);
		upstream.end();
	});
}

/**
 * 取该设备的 token（带缓存）：命中缓存直接用；"确定没有"这个结论只缓存 10 秒，
 * 这样用户在设置页刚补上的 token 会很快生效。
 */
async function tokenFor(runtime, device) {
	const hit = runtime.tokenCache.get(device.id);
	if (hit !== undefined && (hit.value !== null || Date.now() < hit.expiresAt)) return hit.value === null ? undefined : hit.value;
	let value;
	try {
		value = await runtime.tokens.get(device.id);
	} catch (error) {
		warn(runtime.ctx, `读取设备 "${device.id}" 的 token 失败：${messageOf(error)}`);
		value = undefined;
	}
	const normalized = typeof value === "string" && value !== "" ? value : null;
	runtime.tokenCache.set(device.id, {
		value: normalized,
		expiresAt: normalized === null ? Date.now() + TOKEN_ABSENCE_TTL_MS : Number.POSITIVE_INFINITY,
	});
	return normalized === null ? undefined : normalized;
}

/**
 * 确保该设备有一份可用的宿主侧会话（没有配 token 时什么都不做）。
 * 并发调用共享同一次兑换；失败进入冷却期，避免每请求都打远端。
 * 本版没有"首页"请求了，所以由**第一个需要代理的请求**触发（约多一个 RTT，之后走 jar）。
 */
async function ensureSession(device, runtime) {
	if (runtime.sessions.has(device.id)) return;
	const store = runtime.sessionStore;
	// 0.8.1：先看**落盘**的那份会话 —— 本机重启后直接接着用，不必再拿 token 兑换一次。
	// （这正是"网页端 cookie 存在浏览器里"的等价物；见 createSessionStore 的说明。）
	if (store !== undefined && store !== null) {
		const persisted = await store.get(device.id);
		if (typeof persisted === "string" && persisted !== "") {
			runtime.sessions.set(device.id, persisted);
			return;
		}
	}
	const token = await tokenFor(runtime, device);
	if (token === undefined) return;
	const failedAt = runtime.authFailures.get(device.id);
	if (failedAt !== undefined && Date.now() - failedAt < AUTH_RETRY_MS) return;
	const running = runtime.pendingSessions.get(device.id);
	if (running !== undefined) {
		await running.catch(() => {});
		return;
	}
	const pending = (async () => {
		try {
			const value = await exchangeToken(device, token);
			if (value === undefined) {
				runtime.authFailures.set(device.id, Date.now());
				warn(runtime.ctx, `设备 "${device.id}" 的 token 兑换没有拿到会话 cookie（token 是否已过期？）`);
				return;
			}
			runtime.sessions.set(device.id, value);
			runtime.authFailures.delete(device.id);
			if (store !== undefined && store !== null) void store.set(device.id, value);
		} catch (error) {
			runtime.authFailures.set(device.id, Date.now());
			warn(runtime.ctx, `设备 "${device.id}" 的 token 兑换失败：${messageOf(error)}`);
		}
	})();
	runtime.pendingSessions.set(device.id, pending);
	try {
		await pending;
	} finally {
		runtime.pendingSessions.delete(device.id);
	}
}

/**
 * 丢掉这台设备的宿主侧会话（内存 + 落盘）。两处用得上：
 *  ① 远端回 **401**（这份 cookie 已经不被认了：过期 / 身份记录被换 / authority 变了）；
 *  ② 用户在设置页**更新了这台设备的 token**（换了 token 就该重新兑换一次）。
 * 以前缺这一步：401 之后一直拿旧 cookie 打，症状是"切过去一直连接中"（2026-10-13 实战）。
 */
function forgetSession(runtime, deviceId, reason) {
	const had = runtime.sessions.delete(deviceId);
	runtime.authFailures.delete(deviceId);
	runtime.tokenCache.delete(deviceId);
	const store = runtime.sessionStore;
	if (store !== undefined && store !== null) void store.remove(deviceId);
	if (had === true && reason !== "") {
		warn(runtime.ctx, `设备 "${deviceId}" 的会话 cookie 已丢弃（${reason}），下一次请求会用最新 token 重新兑换`);
	}
}

/** 从上游 `set-cookie` 里抓该设备的会话 cookie 存进 jar。 */
function captureSession(device, setCookieHeaders, runtime) {
	// 名字以服务器给的为准（见 sessionPairFromSetCookie 的说明）：对外入口改写 Host 后仍能收到会话。
	const pair = sessionPairFromSetCookie(setCookieHeaders);
	if (pair === undefined) return;
	runtime.sessions.set(device.id, pair);
	// 0.8.1：远端重新发过 cookie 就顺手落盘（覆盖旧的）。
	const store = runtime.sessionStore;
	if (store !== undefined && store !== null) void store.set(device.id, pair);
}

/**
 * 决定这次请求往上游带哪个 Cookie。
 * 优先宿主侧 jar（桌面窗口里浏览器侧根本拿不到远端的 set-cookie），
 * 其次才是浏览器带来的、**名字正好等于本设备派生名**的那一个 —— 顺带保证
 * 本机自己的 `dsh-auth-<本机authority hash>` 绝不会被发到别的机器上。
 */
function cookieHeaderFor(device, clientCookie, runtime) {
	const cookieName = cookieNameFor(device.authority);
	// 罐子里存的是**服务器给的名字**（0.10.2 起是 `name=value` 整对），直接原样发。
	const jar = runtime.sessions.get(device.id);
	if (jar !== undefined) return jar;
	const value = readCookie(clientCookie, cookieName);
	return value === undefined ? undefined : `${cookieName}=${value}`;
}

/** 记一次"这台设备最近一次代理结果"（体检页要用）。 */
function markReach(runtime, deviceId, ok, error) {
	const previous = runtime.reach.get(deviceId) ?? { reachable: null, lastOkAt: null, lastError: null };
	const next = {
		reachable: ok === true,
		lastOkAt: ok === true ? new Date().toISOString() : previous.lastOkAt,
		lastError: ok === true ? null : (error === undefined || error === null || error === "" ? previous.lastError : String(error)),
	};
	runtime.reach.set(deviceId, next);
}

//#endregion

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
		"怎么办：让窗口停在本机页面，用右下角的「设备」胶囊切换。本插件的垫片会把",
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
function openUpstream(device, url, req, headers) {
	const send = device.protocol === "https:" ? httpsRequest : httpRequest;
	return send({
		protocol: url.protocol,
		hostname: device.hostname,
		port: device.port === "" ? undefined : device.port,
		path: `${url.pathname}${url.search}`,
		method: req.method,
		headers,
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

	const proceed = () => {
		const cookie = cookieHeaderFor(device, req.headers.cookie, runtime);
		let target;
		try {
			target = new URL(`${device.origin}${device.basePath}${rest}`);
		} catch {
			markReach(runtime, device.id, false, "无法构成远端地址");
			writeDeviceNotice(res, device, `无法构成远端地址（${device.origin}${device.basePath}${rest}）`, 500);
			return;
		}
		for (const [key, value] of parsed.searchParams) target.searchParams.append(key, value);

		const headers = forwardableRequestHeaders(req);
		headers.host = device.authority;
		headers.origin = device.origin;
		headers["user-agent"] = USER_AGENT;
		if (cookie !== undefined) headers.cookie = cookie;

		let upstream;
		try {
			upstream = openUpstream(device, target, req, headers);
		} catch (error) {
			markReach(runtime, device.id, false, messageOf(error));
			writeDeviceNotice(res, device, `建立上游请求失败：${messageOf(error)}`, 502);
			return;
		}

		let settled = false;
		const connectTimer = setTimeout(() => {
			upstream.destroy(new Error(`连接超时（${String(CONNECT_TIMEOUT_MS)} ms 内没有响应）`));
		}, CONNECT_TIMEOUT_MS);

		upstream.on("response", (upstreamRes) => {
			clearTimeout(connectTimer);
			settled = true;
			markReach(runtime, device.id, true, null);
			relayResponse(device, prefix, runtime, upstreamRes, res, parsed.pathname);
		});
		upstream.on("error", (error) => {
			clearTimeout(connectTimer);
			if (settled) {
				if (!res.writableEnded) res.destroy();
				return;
			}
			settled = true;
			const message = messageOf(error);
			markReach(runtime, device.id, false, message);
			warn(runtime.ctx, `设备 "${device.id}" 转发失败：${message}`);
			writeDeviceNotice(res, device, message, 502);
		});

		// 请求体（POST/PUT）直接管道转发；客户端断开就掐掉上游。
		res.on("close", () => {
			if (!res.writableEnded) upstream.destroy();
		});
		req.on("error", () => {
			upstream.destroy();
		});
		req.pipe(upstream);
	};

	// 配了 token 且还没有会话：宿主侧先兑换一次（桌面窗口拿不到 set-cookie，必须由宿主代持）。
	if (cookieHeaderFor(device, req.headers.cookie, runtime) === undefined) {
		ensureSession(device, runtime).then(proceed, proceed);
		return;
	}
	proceed();
}

/**
 * 把上游响应回给客户端。
 * - `content-type` 是 HTML → I1：丢弃 + 404 纯文本（并写日志），一个字节都不透传。
 * - 否则流式透传，但**第一块**会先做一次"看起来是不是 HTML"的嗅探（最多攒 4 KB）。
 */
function relayResponse(device, prefix, runtime, upstreamRes, res, requestPath) {
	const status = upstreamRes.statusCode ?? 502;
	// 0.8.1：远端回 401 = 我们这份 cookie 已经不被认（过期 / 身份记录被换 / authority 变了）。
	// 丢掉它，下一次请求就会用最新 token 重新兑换 —— 缺这一步就会一直 401（"切过去一直连接中"）。
	if (status === 401 && runtime.sessions.has(device.id)) forgetSession(runtime, device.id, "远端回了 401");
	const headers = responseHeadersFor(upstreamRes, device, prefix);
	captureSession(device, upstreamRes.headers["set-cookie"] ?? [], runtime);

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
		const prefixBytes = Buffer.concat(pending, pendingBytes).subarray(0, SNIFF_WINDOW_BYTES);
		const verdict = classifyBodyPrefix(prefixBytes);
		if (verdict === "maybe" && pendingBytes < SNIFF_LIMIT_BYTES) return;
		if (verdict === "html") {
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

	const proceed = () => {
		const cookie = cookieHeaderFor(device, req.headers.cookie, runtime);
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
		const connectTimer = setTimeout(() => {
			failed = true;
			markReach(runtime, device.id, false, `连接超时（${String(CONNECT_TIMEOUT_MS)} ms）`);
			rejectUpgrade(socket, `连接超时（${String(CONNECT_TIMEOUT_MS)} ms）`);
			upstream.destroy();
		}, CONNECT_TIMEOUT_MS);

		upstream.on("data", () => {
			sawUpstreamBytes = true;
			clearTimeout(connectTimer);
			markReach(runtime, device.id, true, null);
		});
		upstream.on("error", (error) => {
			clearTimeout(connectTimer);
			if (failed) return;
			failed = true;
			const message = messageOf(error);
			markReach(runtime, device.id, false, message);
			warn(runtime.ctx, `设备 "${device.id}" 的 WebSocket 转发失败：${message}`);
			if (sawUpstreamBytes) socket.destroy();
			else rejectUpgrade(socket, message);
		});
		upstream.on("close", () => {
			clearTimeout(connectTimer);
			socket.destroy();
		});
		socket.on("close", () => upstream.destroy());
		socket.on("error", () => upstream.destroy());

		// TLS 场景要等 secureConnect（握手完成）才能写 HTTP；明文用 connect。
		const readyEvent = device.protocol === "https:" ? "secureConnect" : "connect";
		upstream.on(readyEvent, () => {
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
			if (cookie !== undefined) lines.push(`Cookie: ${cookie}`);
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
			socket.setNoDelay(true);
			upstream.setNoDelay(true);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
	};

	if (cookieHeaderFor(device, req.headers.cookie, runtime) === undefined) {
		ensureSession(device, runtime).then(proceed, proceed);
		return;
	}
	proceed();
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



//#region 对外入口 edge（0.9.0）：把 Host/Origin 改写成 loopback 再转给本机 DSH

/** 这台机器 DSH 自己的监听端口（= edge 的转发目标）。 */
function edgeTargetPort(runtime) {
	const web = runtime.ctx !== null && typeof runtime.ctx === "object" ? runtime.ctx.webServer : undefined;
	return web !== undefined && web !== null ? toPort(web.port) : undefined;
}

/** edge 要不要挡这个路径（插件的设置页/写路由只认回环，不能让它们透过 edge）。 */
function edgeBlocks(pathname) {
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

/** 停掉对外入口（幂等）。 */
function stopEdge(runtime) {
	const state = runtime.edge;
	if (state === undefined || state === null) return;
	if (state.sockets !== undefined) {
		for (const socket of state.sockets) {
			try {
				socket.destroy();
			} catch {
				/* 已断 */
			}
		}
		state.sockets.clear();
	}
	const server = state.server;
	state.server = null;
	state.running = false;
	if (server !== null && server !== undefined) {
		try {
			server.close();
		} catch {
			/* 已关 */
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
	const authority = `127.0.0.1:${String(target)}`;
	state.targetPort = target;

	const server = httpServer((req, res) => {
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
		const upstream = httpRequest({
			host: "127.0.0.1",
			port: target,
			method: req.method,
			path: req.url,
			headers: edgeHeaders(req.headers, authority),
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
		const upstream = netConnect(target, "127.0.0.1", () => {
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
		if (typeof timer.unref === "function") timer.unref();
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
	let cookie = typeof settings.cookie === "string" && settings.cookie !== "" ? settings.cookie : undefined;
	if (cookie === undefined && settings.skipSession !== true) {
		if (cookieHeaderFor(device, undefined, runtime) === undefined) await ensureSession(device, runtime);
		cookie = cookieHeaderFor(device, undefined, runtime);
	}
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

//#region 路由装配（含 enabled 的活着切换）

/** 当前设备表 + `enabled` → 垫片脚本（每次注入时现算，设备表 / 开关改了立刻生效）。 */
function currentShimScript(runtime) {
	const localDevice = runtime.localDevice;
	const localName = localEntryName(localDevice, runtime.facts);
	const localCaption = localDevice === undefined || localDevice === null ? "本机" : `${localDevice.name} · 本机`;
	const devices = runtime.devices
		.filter((device) => device !== localDevice)
		.map((device) => ({ id: device.id, name: device.name }));
	return renderShimScript({
		devices,
		localName,
		localCaption,
		helloPath: HELLO_PATH,
		statePath: STATE_PATH,
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
		if (device === runtime.localDevice) continue; // 标记为本机的设备不代理
		// 注意：prefix 必须**不带尾斜杠**。webserver 的 match() 规则是
		// `pathname === prefix || pathname.startsWith(prefix + "/")`，
		// 若注册成 "/dev/self/"，则 "/dev/self/api/x" 既不相等也不以 "/dev/self//" 开头 → 永远不匹配。
		const prefix = `${ROUTE_ROOT}${device.id}`;
		const route = {
			kind: "prefix",
			path: prefix,
			handler: (req, res) => {
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
 * `GET /plugin/remote/state` 决定要不要自除（清键 / 摘胶囊 / 还原原语 / 带哨兵刷新一次）。
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



/** 组装体检 / 状态一次性数据（契约里的形状，字段名不许改）。 */
function buildState(runtime) {
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
	if (runtime.sessionController === undefined || runtime.sessionController === null) {
		notes.push("分叉读本机源会话走本机 HTTP /api（ctx.sessionController 不可用）。");
	}

	const devices = runtime.devices.map((device) => {
		const reach = runtime.reach.get(device.id);
		return {
			id: device.id,
			name: device.name,
			url: device.rawUrl,
			local: device === runtime.localDevice,
			reachable: reach === undefined ? null : reach.reachable,
			lastError: reach === undefined ? null : reach.lastError,
			lastOkAt: reach === undefined ? null : reach.lastOkAt,
		};
	});

	return {
		enabled: runtime.data.enabled === true,
		version: VERSION,
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
		diagnostics: {
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
		// 名字多半是中文，派生不出合法 id 时退而用 url 的 host（`192.0.2.9` 就是合法 id）。
		id = slugifyDeviceId(name);
		if (id === "") id = slugifyDeviceId(parsed.hostname);
		if (id === "") return { ok: false, error: `无法从名字 ${JSON.stringify(name)} 派生合法 id，请显式给 id` };
		if (runtime.data.devices.some((entry) => entry.id === id)) {
			return { ok: false, error: `duplicate id: ${id}（这台设备已经存在；要改它请显式带上 id）` };
		}
	}
	const existing = runtime.data.devices.find((entry) => entry.id === id);
	if (existing === undefined) {
		runtime.data.devices.push({ id, name, url: urlText });
	} else {
		existing.name = name;
		existing.url = urlText;
	}
	const hasToken = Object.hasOwn(payload, "token");
	if (hasToken) {
		const token = typeof payload.token === "string" ? payload.token : "";
		try {
			await runtime.tokens.set(id, token);
		} catch (error) {
			return { ok: false, error: `保存 token 失败：${messageOf(error)}` };
		}
		runtime.tokenCache.delete(id);
		// 换了 token 就必须连**会话 cookie** 一起丢（内存 + 落盘）：否则 ensureSession 看到罐子里有旧值
		// 就直接拿它去打，新 token 永远不兑换 → 症状就是"切过去一直连接中"。0.8.1 修。
		forgetSession(runtime, id, "token 已更新");
	}
	try {
		persistDataFile(runtime);
	} catch (error) {
		return { ok: false, error: `写入数据文件失败：${messageOf(error)}` };
	}
	refreshDevices(runtime);
	void migrateFileTokens(runtime);
	return { ok: true, device: { id, name, url: urlText } };
}

/** 删掉一台设备（连同它的凭据 ref 与代理路由）。 */
async function deleteDevice(runtime, id) {
	const at = runtime.data.devices.findIndex((entry) => entry.id === id);
	if (at === -1) return { ok: false, error: `unknown device: ${id}` };
	runtime.data.devices.splice(at, 1);
	try {
		await runtime.tokens.remove(id);
	} catch (error) {
		warn(runtime.ctx, `删除设备 "${id}" 的 token 失败：${messageOf(error)}`);
	}
	runtime.tokenCache.delete(id);
	runtime.sessions.delete(id);
	runtime.reach.delete(id);
	if (runtime.sessionStore !== undefined && runtime.sessionStore !== null) void runtime.sessionStore.remove(id);
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
		ensureSession(device, runtime).then(() => {
			const cookie = cookieHeaderFor(device, undefined, runtime);
			let target;
			try {
				target = new URL(`${device.origin}${device.basePath}/`);
			} catch (error) {
				finish(null, messageOf(error));
				return;
			}
			const send = device.protocol === "https:" ? httpsRequest : httpRequest;
			const headers = { host: device.authority, origin: device.origin, "user-agent": USER_AGENT, accept: "text/html" };
			if (cookie !== undefined) headers.cookie = cookie;
			try {
				upstreamHost = send({
					protocol: target.protocol,
					hostname: device.hostname,
					port: device.port === "" ? undefined : device.port,
					path: `${target.pathname}${target.search}`,
					method: "GET",
					headers,
				}, (response) => {
					// 拿到响应头就算完事：立刻丢弃响应体（不读进内存、不落盘）。
					response.resume();
					finish(response.statusCode ?? 0, null);
				});
			} catch (error) {
				finish(null, messageOf(error));
				return;
			}
			upstreamHost.on("error", (error) => finish(null, messageOf(error)));
			upstreamHost.end();
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
		writeJson(res, 200, { ok: true }, headOnly);
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
		reach: new Map(),
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
		edge: { server: null, port: null, targetPort: null, running: false, error: null, sockets: new Set() },
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
		info(ctx, "凭据服务可用：设备 token 会存在 ctx.credentials（每条设备一个 ref），数据文件里只留 id/name/url");
		void migrateFileTokens(runtime);
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

/** 供自测核对：路由常量与纯函数（宿主侧运行时不使用）。 */
export const internals = {
	VERSION,
	SHIM_MARKER,
	SWITCHER_ELEMENT_ID,
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
	createSessionStore,
	forgetSession,
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
};
