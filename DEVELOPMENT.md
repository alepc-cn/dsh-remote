# dsh-remote（DSH 远程设备插件）

仓库地址：https://github.com/alepc-cn/dsh-remote

# @local/dsh-remote

把 **`@local/dsh-device-switch` 0.2.x 的全部行为** 与 **`@local/dsh-token-copy` 0.1.x 的"带 token 访问地址"能力**
合并成一个插件，并加上几样新东西：**插件自己的设备数据文件**、**`enabled` 软开关**、**体检 / 状态接口**、
以及 **文件「另存为…」（把文件下载到本机「下载」文件夹 —— 页面由哪台机器提供，文件就在哪台机器上）** 与
**会话「分叉到…」（把本机会话的纯文字上下文带到另一台已配置设备，新建会话继续）**。

- 包名 / 行 id：`@local/dsh-remote`（版本 **0.9.1**）
- 宿主半：`lib/index.js`（ESM，**只用 `node:` 内置模块，零第三方依赖**）
- 客户端半：`lib/client.js`（设置里**一页「远程连接」**，页内自上而下 **5 块**：
  插件开关 / 本机地址（可收起）/ 设备管理 / **配置**（端口 + 入口地址 + 分叉带走的条数）/ 体检；
  另在**两个官方扩展位**各追加一项
  —— 文档预览**头部按钮区**的「另存为…」与会话「…」菜单的「分叉到 <设备名>」；
  由 `exports["./client"]` + `dsh.client.platform: "web"` 暴露）
- 本文件以**宿主半**为主；客户端半的接口就是下面"冻结契约"那张表（它的页面结构在第 3.4 节，
  两个扩展位见第 8.5 节）

```
package.json          # name: @local/dsh-remote, type: module, main: lib/index.js
cordis.patch.yml      # 只做一条 insert（id 与 name 都等于包名）
lib/index.js          # 宿主侧全部实现（含被注入页面的垫片脚本、另存为/分叉两条路由）
lib/client.js         # 客户端半（设置页「远程连接」一页 5 块 + 另存为按钮 + 分叉菜单行）
selftest.mjs          # 宿主半自测（不需要安装插件即可运行；本轮 716/716 通过）
selftest-client.mjs   # 客户端半自测（本轮 95/95 通过）
README.md             # 本文件
```

---

## 1. 它做什么

窗口里的界面**永远**是本机那一份原装页面；插件只**追加一条自包含的垫片脚本**，
由垫片把 `api/` 请求与 `api/remote.mux` 长连接改道到 `/dev/<id>/…`，宿主半再把它们反向代理到那台设备。

```
窗口（本机页面，壳自己服务）
  ├─ 垫片把 fetch/WebSocket/XHR 里的 api/… 改写成 /dev/home/api/…
  ├─ /dev/home/api/…        → 本插件 HTTP 反向代理 → http://192.0.2.2:19387/api/…
  └─ /dev/home/<mux>        → 本插件 WebSocket 转发   → ws://192.0.2.2:19387/<mux>
右下角胶囊「设备：设备B」在本机页面里切换（写 localStorage + reload）
```

除了"改道流量"，本版还有**三条跨机器/地基类**的能力（细节与证据链见第 7、8.5 节）：

- **文件「另存为…」**：在文档预览的**头部按钮区**（`sidebar.right.tab.document.actions`，
  和 open-in-app 的「显示文件位置」并排）多一个按钮，把那个文件**流式**下载到「下载」文件夹。
  **不做任何"当前设备"判断**（另存为就是另存为）：文件在哪台机器上由"页面由哪台机器提供"决定 ——
  在桌面 App 里切了远端时是那台设备上的文件（代理回来），用浏览器打开另一台机器的 DSH 页面时
  就是**那台机器自己的**文件（`device` 为空 = 本机读取）。按钮**永远显示**；点了才校验
  "有没有文件路径 / 有没有会话信息"，缺条件给中文提示。
- **会话「分叉到…」**：在会话「…」菜单末尾**每台远程设备一行**「分叉到 <设备名>」
  （**设备名用加重节点渲染**，多设备时一眼可辨），把**本机会话**最近若干条消息的
  **纯文字**上下文带到另一台已配置设备上新建的会话里继续（不带文件；会落到那台机器的会话库里）。
  新会话**落在目标机的默认工作区**，标题是 **`<源会话标题> - 来自<本机设备名>`**（源标题为空用「未命名会话」）。
- **设置页「配置」块**（第 7 节）：在设置里直接改**端口**与**入口地址**，由宿主半用官方
  `ctx.configEditor.edit` 写进 profile patch（**绑定地址固定 `0.0.0.0`，界面不显示**）。
  保存成功只说一句「已写入配置，重启 DSH 生效」；地基类改动的口径就是"重启才算数"。

### 两条铁律（与 device-switch 0.2 语义完全一致，selftest 逐条断言）

- **I1：绝不把 `text/html` 返回给窗口。**
  代理上游响应时，只要 `content-type` 是 `text/html` / `application/xhtml+xml`，或者响应体开头
  **看起来**是 HTML（`<!doctype html`、`<html`、`<head`、`<body`，最多先攒 4 KB 判定，绝不无限缓冲），
  就**一个字节都不透传**：丢弃上游响应，回 **404 + 一小段纯文本说明**，并写日志。
  **本版把 I1 推广到插件自己的全部接口**（`/plugin/remote/*`）：一律 `text/plain` 或 `application/json`
  + `x-content-type-options: nosniff`，而且**任何响应体里都不出现裸 `<`**
  （纯文本里的尖括号换全角；JSON 文本里的 `<` 转义成 `\u003c`，`JSON.parse` 拿到的是原值）。
  selftest 对每条接口（含 403/404/405/500 分支）逐条断言"不是 text/html 且没有裸 `<`"。
- **I2：绝不改动本机页面的 HTML。** 只有两条注入通道，且都是**纯追加**：
  `ctx.on("webserver/index-inject")` 推一行 `{kind:"script",placement:"head",text}`（桌面壳走这条），
  `ctx.webServer.tapIndex(html => 在 <head> 之后插入同一条 <script>)`（浏览器走这条）。
  两条通道用同一份文本、同一个标记（`/* dsh-remote:shim */`）去重；selftest 用"把注入内容删掉后
  与原 HTML 逐字节相同"证明只追加。**没有 `<base>`、没有 `__DSH_TRANSPORT__` 覆盖、没有远端 HTML 改写。**

### 为什么必须是这个样子（0.1.0 的崩溃事故，别再走回去）

0.1.0 把远端首页 HTML 整个反代进窗口（`/dev/home/` 返回远端 `index.html` 并注入 `<base>`），桌面壳随即：

```
dsh-app://app/dev/home/assets/index-5SrrfWpU.js:126
Error: client-modules: HTML did not preload @deepseek-ai/dsh-client-modules/client.js
   at app.asar/lib/main.js:11573
```

机制：桌面壳的 boot 注入行（`__ModuleLoader__` 队列垫片、引导 batch、`script-preload`、`__DSH_BOOT__`）
是**按本机文档**准备的；文档一换成远端那份，`window.__ModuleLoader__.create()` 就在 `pendingQueue` 里
找不到注册 → `dshDesktopBoot.failed()` → 主进程 `reportFatal(..., "web-boot")` → 恢复窗 + 崩溃日志。
**结论：窗口里的 HTML 必须是壳自己那份。**

---

## 2. 设备数据文件（插件自己的，不写 profile patch）

`$DSH_HOME/remote-devices.json`，`$DSH_HOME` = `process.env.DSH_HOME` 或 `%USERPROFILE%\.dsh`：

```json
{
  "enabled": true,
  "devices": [
    { "id": "home", "name": "设备B", "url": "http://192.0.2.2:19387" },
    { "id": "company", "name": "设备A", "url": "http://192.0.2.4:19387" }
  ],
  "current": "company",
  "forkTailN": 35
}
```

| 字段 | 含义 |
|---|---|
| `enabled` | **软开关**。`false` = 只停代理与注入的"效果"（见第 3 节「软开关」）。缺省 `true`。 |
| `devices[].id` | `/dev/<id>/…` 的路径片段，也只允许 `A-Za-z0-9._~-`；垫片写进 localStorage 的就是它。 |
| `devices[].name` | 胶囊/菜单里显示的名字；缺省取 `id`。 |
| `devices[].url` | 必填，`http`/`https`，可带子路径（如 nginx 的 `/dsh`）。 |
| `current` | **可选兜底**：本机自验证（URL 命中本机 IP/主机名 + 端口）一条都没命中时，用它认领"本机"那一台。 |
| `sessions` | **0.8.1 新增，可选**：远端会话 cookie 的**退化落点**（只在凭据服务不可用时才出现；正常路线下 cookie 在凭据服务里、这个键不存在）。见第 5.1 节。 |
| `tokens` | **只有**在凭据服务不可用时才出现（见第 5 节），正常路线下**不存在**。 |
| `forkTailN` | **0.8.0 新增，可选**：「分叉到…」带走的条数（最近 N 条消息），整数 `1..200`。**缺省不写这个键**（= 20）。设置页「配置」块那一格写的就是它；非法值会被读成"没有"（回缺省 20），**绝不会**让文件读不动。 |

规则：

- **绝不写 profile patch**：profile 里 `@local/dsh-remote` 那一条可以完全是空的。
- **一次性种子**：如果数据文件**不存在**，而 profile 配置里给了 `config.devices` / `config.current`
  （device-switch 时代的写法），插件会把它们种子进数据文件，并写日志
  `已从 profile 配置一次性种子 N 台设备到 …（此后以该文件为准）`。文件**已存在**时绝不覆盖 —— 手改/设置页的改动不会被配置顶掉。
  种子里的 `token` 会按第 5 节去凭据服务（**不会**落进 `devices`）。
- **手改也活着生效**：插件用 `stat` 的 `mtime:size` 做戳，最多每 **1 秒**检查一次；
  改了文件（例如把 `enabled` 改成 `false`）后，下一次体检/代理请求就会整体重读并重算路由（selftest G8 实测两条）。
- **坏条目不会拖垮插件**：坏 `id`、缺 `url`、`url` 解析失败、`id` 重复都只告警并跳过。
- **整份文件读不懂时（JSON 坏了）不种子、不覆盖**：设备表按空处理，日志与体检 `notes` 会明说
  "存在但无法解析，请修好或删掉它" —— 手改到一半的文件不会被插件的种子顶掉（selftest G8b）。
- 写入用"临时文件 + 改名"，避免半个文件。

---

## 3. `enabled` **软开关**（两个方向都不对称，不用重启；彻底关停要卸载）

一句话口径（`package.json` 的 `description`、设置页开关旁的标注、体检 notes 三处一致）：

> **软开关：停用只停止代理与注入；要彻底关停请卸载本插件**

### 3.1 关停（`enabled:false`）= 立刻回到"本机直连、没有胶囊"

| 项 | 关停后的行为 |
|---|---|
| `/dev/**` 代理路由（HTTP + WebSocket 升级） | **一条都不注册**（`proxyRoutes: 0`）；`/dev/<id>/…` 落到 DSH 自己的回退处理器（404）。 |
| 垫片脚本注入 | **照旧注入**（两条通道都还挂着）——但它自己会发现停用并**自除**（见 3.2）。 |
| 页面状态 | 垫片不再改写 `api/` 流量：`localStorage` 里的"当前设备"被清掉、右下角胶囊被摘掉、被改写的 fetch/WebSocket/XHR 还原 → 页面立刻回到本机直连。 |
| 设置页接口 | **照常可读**（`GET /plugin/remote/state`、`/urls`…），随时能改回 `true`。 |
| mux 路径探测 | 不再发起；重新启用后再跑一轮。 |

**为什么注入不能跟着一起撤**（0.3.0 之前的做法，实测两个坑）：

1. **桌面壳把注入行缓存到窗口生命周期**：`webserver/index-inject` 是在窗口/页面构建时被壳读走的，
   关停之后再撤监听，**已经打开的老窗口里那条 `<script>` 还在**，胶囊会一直挂到重启 APP 为止。
2. **localStorage 里的"当前设备"没人清**：数据文件里的 `enabled` 变了不等于窗口里的选择没了，
   再开回来会**继续跑远端**（用户以为"关停了"，实际流量还在改道）。

所以现在反过来：**注入永远在，判断交给页面里的垫片自己**。这也顺手覆盖了"插件被卸载"的情况
（卸载后 `/plugin/remote/state` 回 404，垫片走同一条自除路径）。

### 3.2 垫片自检：时序不许变

垫片脚本在**页面加载时同步**完成三件事（这一步绝不能改成"先问状态再 patch"，否则应用的首批请求会漏到本机）：

1. 读 `localStorage` 的"当前设备 / 设备列表"；
2. 若选中了设备 → **同步**改写 `fetch` / `WebSocket` / `XMLHttpRequest.open`；
3. 挂出右下角胶囊（有设备可选时）。

**同步动作全部做完之后**，才发一次**异步、不阻塞**的 `GET /plugin/remote/state`
（`credentials: "same-origin"`, `cache: "no-store"`），只认三种结果：

| 自检结果 | 垫片动作 |
|---|---|
| `enabled === false`（严格比较） | **自除**：清 `dsh-device-switch:current`/`:devices` 与别名 `dsh-remote:current`/`:devices` → `removeChild` 掉自己画的胶囊 → 把三个原语还原成原函数 → **带哨兵地** `location.reload()` 一次。 |
| HTTP **404**（插件已被卸载 / 路由没了） | 同上（同一条自除路径）。 |
| `enabled === true` | 清掉哨兵；**若本次是惰性的**（payload 说停用、或哨兵在位而错过挂载时机）→ **惰性自愈**：写 `force-active`、清哨兵、带防循环保护地刷新一次。 |
| 其它（网络失败、非 JSON、没这个字段、响应不是对象） | **安静什么都不做**：不清键、不摘胶囊、不刷新（一次探测失败绝不能把页面弄坏）。 |

**防循环哨兵**：`sessionStorage["dsh-remote:soft-off"]`（每个窗口一个）。
- 自除前先写哨兵，再 `reload()`；`reload()` 之后页面重新加载，脚本在**同步阶段**读到哨兵就直接当"没装"
  （不 patch、不挂胶囊，也不再刷新）→ **同一窗口最多为停用刷一次**。
- 自检拿到 `enabled:true` 时把哨兵清掉 → 下次关停仍然能正常刷一次（不会"关停过一次就再也刷不动"）。
- 注入 payload 里同时带 `enabled`：宿主注入时已经是 `false` 的话，垫片**同步阶段就直接惰性返回**
  （一次都不 patch、也不挂胶囊），只有自检这一步照跑（用来兜住"老窗口里那行缓存住的脚本"）。

**"强制激活"标记**：`sessionStorage["dsh-remote:force-active"]`（每个窗口一个，键名与客户端半同一个）。
- **为什么需要它**：哨兵在位 + 用户在设置页点"启用"时，刷新后的第一次加载里垫片会惰性返回
  —— 挂载时机已经错过，胶囊**要再点一次「重载窗口」才出现**。所以"启用"时先清哨兵、再置这个标记，
  垫片在同步阶段读到标记就**压倒一切**（忽略 payload 里的 `enabled` 与哨兵，直接 patch + 挂胶囊），
  用掉之后自己删掉 → **一次刷新胶囊就回来**。
- **惰性自愈**（宿主半的兜底，防"老窗口里缓存住的旧注入行"）：自检拿到 `enabled:true` 而**本次是惰性的**
  （payload 说停用、或哨兵在位）时，垫片自己写 `force-active`、清哨兵、并**带防循环保护地**刷新一次
  （同一窗口最多一次）。若 `sessionStorage` 不可写，自愈**不刷新**（降级为手动重载一次），
  避免"每次加载都自愈 → 无限刷新"。
- 关停时客户端半会顺手清掉这个标记，避免它残留导致下次关停后的第一次加载又被强制激活。

### 3.3 启动（`enabled:true`）

- 路由按当前设备表重建（HTTP + upgrade），mux 路径若还没发现会再启动一轮发现。
- 页面侧：设置页开关里点"启用" → POST → **先清掉哨兵、再置 `force-active`** → `location.reload()` →
  垫片这次走正常模式（用掉标记）→ **胶囊一次刷新就回来**，`api/` 流量重新按"当前设备"改道。
  （只清哨兵也行，但要等壳重新注入一份"新鲜"的 payload；置标记是为了连"缓存住的旧注入行"也一起兜住。）

### 3.4 设置页（客户端半）

设置里**一页**：**「远程连接」**（`settings.section`，id `remote-connection`，order 60），页内自上而下 **5 块**：

1. **插件开关** —— `enabled` 状态 + 开关 + 软开关标注。
   - **关停**：`POST /plugin/remote/enabled {enabled:false}` 成功后 → **先清掉 localStorage 的"当前设备"（主键 + 别名）**
     → 顺手清掉 `force-active` 标记 → 再 `location.reload()`，提示"已关停：正在回到本机…"。
   - **启动**：`POST … {enabled:true}` 成功后 → **先清掉哨兵、再置 `force-active` 标记**（顺序不许换）
     → 再 `location.reload()`，提示"已启用：正在重新注入胶囊…" → **一次刷新胶囊就回来**。
   - **失败**：原样显示宿主给的错误，**不假装成功、不刷新**（状态文字仍以页面读到的 `enabled` 为准）。
2. **本机地址**（**默认收起**）—— 展开后是带 token 的地址（地址文字在前、复制按钮在后）+ 本机进程。
   （绑定地址/端口/入口地址的**展示与修改**都收在下面的「配置」块里：绑定值一律不在界面出现。）
3. **设备管理** —— 当前设备一行 + 真表格（切换到此设备 / 回到本机 / 测试连通 / 修改 / 删除）+ 新增修改表单。
4. **配置** —— 端口输入框 + 入口地址多行框 + 「填入本机地址」+ 「保存」（写 profile patch，见第 7 节）。
5. **体检** —— `diagnostics` 逐项 ✅/❌ + `notes` 逐条 + 「重新读取」/「重载窗口」。

改 `enabled` 的两条路：设置页开关（= `POST /plugin/remote/enabled`），或者直接改数据文件里的 `enabled`
（1 秒内活着生效）。

> **注意**：DSH **插件页**（侧栏「插件」）里那个针对 `@local/dsh-remote` 的开关点是**空操作**，
> 原因与修法见第 4 节 —— 那是 DSH 插件管理器的"条目定位"规则，不是本插件的 bug。

---

## 4. 插件页里的开关为什么是空操作（研究结论）

实测：在 DSH 的**插件页**（`@deepseek-ai/dsh-client-ui-plugin-manager`，侧栏「插件」）里点 `@local/dsh-remote`
那一行的启用/停用开关，profile 的 `cordis.patch.yml` **一个字节都没变**。

源码与实测（`@deepseek-ai/dsh-plugin-manager/lib/index.js` 的 `listPlugins()`）：

```js
const rows = flatten(composeEntries([readProfilePatches("dsh", this.profile)]));
return (await readPluginInventory(this.ctx)).entries.map((entry) => {
  const actual = [...this.ctx.loader.entries()].find((row) => row.id === entry.entryId);
  const candidates = rows.filter((row) => row.id === actual?.options.id);
  const candidate = candidates[0];
  …
  if (candidate === void 0 || candidates.length > 1 || candidate.name !== entry.moduleName
      || actual?.parent.tree.ctx.fiber.entry?.id !== "include")
    return { ...entry, readOnlyReason: "unaddressable" };   // ← 页面把它锁成只读，开关点了没反应
  return { ...entry, patchId: candidate.id };
});
```

**根因（实测数据）**：`@local/dsh-remote` 在**两层**里各有一条 `insert` 行，id 都叫 `@local/dsh-remote`：

1. **bundle 层** —— 它自己在 `package.json` 里声明了 `dsh.bundle.patch: ./cordis.patch.yml`，
   而 profile 的 `dsh.profile.bundles` 里有它 → compose 时这一层的 patch 被读进来（`cordis.patch.yml` 的 insert）；
2. **profile 层** —— profile 的 `cordis.patch.yml` **又写了一条一模一样的 insert**
   （`- insert: - id: '@local/dsh-remote' …`，注释写着"合并版：远程访问 + 设备切换"）。

用 `_inspect/_pm_probe/probe.mjs`（把 app-boot 的 `loadProfileDirectory` / `readProfilePatches` /
`applyEntryPatches` / `composeEntries` 逐字抄出来跑真实 profile）实测输出：

```
layer @local/dsh-remote → insert 行: @local/dsh-remote
readProfilePatches → 11 条 patch，其中 insert patch 3 条
== listPlugins() 的判定 ==
id=@local/dsh-remote 命中 2 行: {"id":"@local/dsh-remote","name":"@local/dsh-remote"} | {"id":"@local/dsh-remote","name":"@local/dsh-remote"}
readOnlyReason(不可寻址的原因) = unaddressable
  - candidates.length > 1（找到 2 行同 id）
```

`candidates.length > 1` → `unaddressable` → 插件页把那一行锁成只读（带 Host 给的原因），
所以点开关不会走 `setPluginEnabled` → `writePluginEnabled` → 不写 `disabled`。

**要让它生效需要改什么**（本插件按边界要求**只写结论、不改安装形态**）：

- **推荐（一行删除）**：把 profile 的 `C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml` 里
  那条 `- insert: - id: '@local/dsh-remote'` **删掉**。bundle 层自己就会把这一行插进组合，
  删掉 profile 里那条重复的之后 `candidates.length === 1` → 开关变成可寻址，
  点它会往 `cordis.patch.yml` 写 `- id: '@local/dsh-remote'` + `disabled: true/false`，
  配合 HMR 立刻重组（没有 HMR 的 profile 重启后生效）。
  ⚠ 这条改动会动 `C:\Users\<user>\.dsh`（本次任务不允许），而且**别同时做**：删 profile 的那条 insert
  与"给 profile patch 加 `disabled`"顺序上不冲突，但要先删重复行，否则 `writePluginEnabled` 的
  `add({ id, disabled })` 会追加成第三条同 id 的行，问题只会更糟。
- **不推荐**：保留重复行也可以，但那时 `writePluginEnabled` 写出来的 `disabled` 覆盖项会被
  `entryMap.set` 的"后写覆盖前写"语义吞掉（同 id 的 insert 会互相覆盖），而且
  `listPlugins()` 仍然判 `unaddressable`，开关还是点不动。
- **另注**：这条 profile patch 的 insert 与 bundle patch 完全重复，本身也是冗余配置；
  删掉它不会改变运行结果（`applyEntryPatches` 里 `set` 同 id 是"后写覆盖前写"，两条 insert 谁在前后都一样）。

---

## 5. token 存储：**凭据服务优先，数据文件只做退化**（我选了哪条路 + 为什么）

**路线 A（默认，本部署可用）：`ctx.credentials`（`@deepseek-ai/dsh-credentials-local`）。**

每条设备一个凭据 **ref**：

```
DSH_REMOTE_TOKEN_<sha256(设备 id) 的十六进制前 16 位>
例：设备 id "self" → DSH_REMOTE_TOKEN_06c604b332b386b6
```

- 取值/写入：`ctx.credentials.resolve(ref)` / `set(ref, token)` / `unset(ref)`（`resolve` 返回 `{value, source}`）。
- ref 名必须满足 `^[A-Za-z_][A-Za-z0-9_]*$`（POSIX shell 标识符），而设备 id 允许 `.`/`~`/大写，
  所以**派生**而不直接用 id；sha256 前缀保证不同 id 不撞。
- 值落在 `$DSH_HOME/.credentials.yaml`（`refs:` 分节），**数据文件里永远没有 token**。
- 为什么选它：这是 DSH 自己的机密存储 —— 文件权限由提供方管、轮换立刻生效、设置界面可以只报
  "配没配/可不可写"而不暴露值；而且它本来就在 base bundle 里（本机 `$DSH_HOME/.credentials.yaml` 已存在）。
- 为什么不用"凭据记录"（`modifyRecord` + `<scope>/<id>`）：记录的 id 段必须匹配 `^[a-z][a-z0-9-]*$`，
  设备 id 允许大写/`.`/`~`，得再编码一层才寻址，反而更绕。
- 迁移：如果数据文件里已经躺着明文 token（曾经走过路线 B）而凭据服务后来可用，插件会**自动把它们搬进
  凭据服务并从文件里删掉**，然后重写文件（日志 `已把 N 台设备的 token 从数据文件迁进凭据服务`）。

**路线 B（退化，只在 `ctx.credentials` 缺席时）：数据文件的 `tokens` 字段。**

- 触发条件：组合里没有凭据服务（`ctx.inject(["credentials"], …)` 一直没激活）。
- 此时 `remote-devices.json` 会多一个 `tokens` 字段：`{"tokens": {"<id>": "<明文 token>"}}`。
- 权限收紧：POSIX 上 `chmod 600`；Windows 上 `chmod` 只切只读位、不能真正收紧 ACL，所以**额外尽力**执行
  `icacls <file> /inheritance:r /grant:r "<USERNAME>:F"`；失败会把原因写进体检 notes（不假装成功）。
- **README 与体检页都明确标注"token 明文存储"**：`GET /plugin/remote/state` 的
  `diagnostics.notes` 里会有一条以 `⚠ token 明文存储` 开头的说明，带上文件路径与权限收紧结果。
- profile 配置种子里带来的 token 也走同一判定：先只放内存，**1 秒**内看凭据服务有没有出现 ——
  出现就迁进凭据服务，没出现才落盘（避免白白写一次明文）。

---

### 5.1 远端会话 cookie 也**落盘**（0.8.1）

**为什么**：token 只用来换一次 cookie，之后一直用 cookie（本机设的是 `cookieMaxAgeDays: 3650` = 10 年）。
用**网页端**时 cookie 存在浏览器里，天然活得久；但插件的 cookie 以前只存在**进程内存**（`runtime.sessions`），
**本机 DSH 一重启就没了** → 于是每次都要重新拿 token 兑换一次 —— 而"对方也重启过"时那个 token 早就作废
（官方 `dsh-client-connection` README 原话：「每个进程生成一个随机启动令牌」），表现就是**切过去一直「连接中」**
（2026-10-13 实战）。所以 0.8.1 把 cookie 存下来 —— 等价于"浏览器替我们存着"。

| 项 | 做法 |
|---|---|
| 存储位置 | 凭据服务可用时：`ctx.credentials` 里的 `DSH_REMOTE_SESSION_<sha256(id) 前 16 位>`（与 token 同级安全，值在 `$DSH_HOME/.credentials.yaml`）<br>退化路线：数据文件的 `sessions` 字段（明文，权限按 token 那套收紧） |
| 读取时机 | `ensureSession()`：**先看落盘的** → 有就直接用（不再兑换）；没有才拿 token 兑换 |
| 写入时机 | 兑换成功、或远端重新发过 `Set-Cookie` 时 |
| 丢弃时机 | ① 远端回 **401**（这份 cookie 已不被认）→ 丢掉并让下一次请求重新兑换；② 在设置页**更新该设备的 token**；③ 删除该设备 |
| 效果 | **本机重启**（插件重新装配）后不用再兑换；**只对方重启**时 cookie 依然有效（签名密钥持久化在 `.credentials.yaml`）；两者都不需要人工干预 |

注意：cookie 是绑定 authority（`host:port`）的 —— **改端口后**它自然失效，上面第 ① 条会自动重新兑换。
## 6. 体检 / 状态：垫片报到 + mux 路径发现

### 6.1 垫片报到（"DSH 升级后注入失效"能被看出来）

垫片脚本加载后**立刻**向本机 POST 一次 `/plugin/remote/hello`（fire-and-forget，用**未包装**的 fetch，
`credentials: "same-origin"`），宿主据此记 `injectionSeen` 与 `lastHelloAt`（ISO 时间）。

- `hello` **不接受任何 body**：带 body（`content-length > 0` 或 `transfer-encoding`）一律 400，
  且**不**记为报到（selftest 两条分支都断言）。
- 体检页把 `injectionSeen:false` 显示成红项并给出去查的方向：
  "如果窗口已经打开过，说明本机页面注入可能失效（DSH 升级后常见），刷新一次窗口再看"。
- **报到的时机**：同步 patch 之后（与自检同一时序），所以"注入生效"这件事在停用状态下**依然能报到**
  （脚本永远注入）；停用状态下 notes 会另外说明"垫片照旧注入、会自检自除"，不再说"不会报到"。

### 6.2 `REMOTE_STREAM_MUX_PATH` 的动态提取（**不硬编码**）

>=0.3.0 里这个路径**没有**写死在代码里。启动后（以及失败后每隔 ≥30 秒的体检读）按下面的顺序找：

1. **进程内 `ctx.webServer.collectIndexInjections()` 的行**（第一手、不需要鉴权）：
   - `script-preload` / `script-src` 行的 `src`（就是 client module 的组合 bundle 地址，形如
     `plugins/??@deepseek-ai/dsh-api-gateway/client.js&rev=abcdef123456`）；
   - `__DSH_BOOT__` 那个 `global` 行的值里所有 `plugins/…` 地址（模块图的 `entries[].url`）。
2. **本机首页**：`GET http://127.0.0.1:<ctx.webServer.port>/`，抽出 `src=`/`href=` 里的 `plugins/…` 地址。
   本机 DSH 的首页没有会话 cookie 会 **401**；此时用 `ctx.connection.authenticatedUrl()` 拿进程 token，
   做一次 `GET /?token=…`（不跟随跳转）把 `dsh-auth-*` 会话 cookie 换来再用。
   **token 只出现在这一条请求的 URL 里：不打印、不进体检数据、不留引用**；换不到 cookie 就记一条 note 跳过这一步。
3. **逐个 `GET` 这些"本机 client bundle"**（URL 以 `/` 开头，最多 12 个候选、单个最多 8 MB），
   在文本里找 `REMOTE_STREAM_MUX_PATH = "…"`，校验它是以 `/` 开头的安全路径。
   候选排序：URL 里含 `dsh-api-gateway` 的排最前。
   实测真源码里那一行的形状（夹具逐字抄自 `@deepseek-ai/dsh-api-gateway/lib/client.js`）：
   ```js
   const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
   ```
4. 每个候选的失败原因（HTTP 404 / 拿到字节但没有那个常量）都记进 `runtime.mux.lastCandidateError`，
   最后拼进 `diagnostics.notes`，所以"为什么没找到"是可排查的。

**失败行为（刻意的）**：全部失败 → `diagnostics.muxPathFound:false`、`muxPath:null`、
**一条 `/dev/<id>/<mux>` 升级路由都不注册**（终端通道标记为不可用）、日志与体检 notes 写明
"WebSocket 终端通道**不可用**；HTTP 代理与对话不受影响"。**绝不猜一个默认路径**。
`diagnostics.proxyRoutes` 会如实只数已注册的那几条。

重试节奏：启动后 `0 / 0.4 / 1.2 / 3 / 8` 秒共 5 次；彻底放弃后再由体检读触发（间隔 ≥30 秒，避免打爆本机）。
发现成功后再变化不会重复注册（`syncRoutes` 幂等重建）。

---

## 7. 访问配置：**可写**（设置页「配置」块 → 官方 `ctx.configEditor.edit`）

`GET /plugin/remote/state` 的 `access` 字段每次都**从活的服务上读**，用于展示与体检：

| 字段 | 来源 |
|---|---|
| `access.host` | `ctx.webServer.config.host`（回退 `ctx.webServer.host`）——本机就是 `0.0.0.0` |
| `access.port` | `ctx.webServer.port`（真正的监听端口；`config.port: 0` 时是 OS 分配的那个），回退 `config.port` |
| `access.trustedHosts` | `ctx.connection.trustedHosts`（`HostConnectionService` 的公开字段） |
| `access.cookieMaxAgeDays` | `ctx.connection.browserAuth.maxAgeMilliseconds / 86400000`（四舍五入；读不到就是 `null`） |
| `access.localAddresses` | 本机可访问地址（`127.0.0.1` + 各网卡**非回环 IPv4**），**每条带当前端口**：`["127.0.0.1:19387","192.0.2.4:19387",…]`。设置页「填入本机地址」用它 |
| `access.writable` | `true` = `ctx.configEditor` 的 `edit()`+`entries()` 都在、且 profile 里能唯一定位 `webserver` / `connection` 两行（即「配置」块保存能成功） |
| `access.forkTailN` | 生效的「分叉到…带走的条数」（最近 N 条消息）：**数据文件里的 `forkTailN`** → 缺省 20。设置页「配置」块那一格预填它 |
| `access.forkTailDefault` / `access.forkTailMax` | 缺省 `20` / 上限 `200`（客户端半用它做输入框的占位符与本地校验，不猜） |

### 7.1 设置页「配置」块（用户定稿的规格，别加别减）

- **绑定地址固定 `0.0.0.0`，界面不显示**（没有输入框、没有下拉，也不显示这个值）；`host` 由宿主半写死。
- **端口**：一个数字输入框，预填当前值（默认 19387）。
- **入口地址（本地）**：一个多行文本框（**一行一个**，可带端口）+ 按钮「**填入本机地址**」
  （把 `access.localAddresses` 逐行填进去；用户刚改了端口时按输入框里的端口重写）。
  下面固定一行说明：**填的是本机自己的地址**（别人用这些地址访问本机时界面才能正常用），
  并且**删掉一条不等于不再监听** —— 端口对所有网卡照旧在听，只是从那个地址进来的请求会被 403。
  （这个名字是用户 2026-10-13 定的：官方的 `trustedHosts` 不“信任”任何人，只是允许请求自称这些名字，
  所以旧名「信任地址」误导；也不叫「监听地址」，因为它并不控制监听范围。）
- **分叉带走的条数**（**0.8.0 追加，用户 2026-10-13 定**）：一个数字输入框，预填 `access.forkTailN`
  （1..`access.forkTailMax`，留空 = 不改这一格）。文字说明：点「分叉到 \<设备\>」时把本机这条会话
  最近这么多条消息的**纯文字**带过去；**这一格存在插件自己的数据文件里，保存后立即生效、不用重启**
  （上面两项端口/入口地址才需要重启）。它是**同一块、同一个「保存」按钮**，但写的是两个地方
  —— 见 7.4。
- **保存** → `POST /plugin/remote/access`；成功后**只**显示一句「**已写入配置，重启 DSH 生效**」
  （**不加**任何"会断开/掉线"类提醒）。失败显示宿主半给的中文原因，**不显示成功**；请求期间按钮置灰。
- 这一块**永远显示**（不做可见性判断）；`access.writable === false` 时多一行说明，但表单照样能点
  （点了会拿到宿主半的 503 中文原因）。

### 7.2 `POST /plugin/remote/access`（仅回环 + 受 `enabled` 门控）

请求体 `{ port?, trustedHosts?, forkTailN? }`（都可省；三个都省 → 400）。**前两个键写 profile、`forkTailN` 写数据文件**（见 7.4）。

成功：

```json
{ "ok": true, "restartRequired": true,
  "written": { "host": "0.0.0.0", "port": 19400, "trustedHosts": ["192.0.2.4:19400"], "cookieMaxAgeDays": 3650 },
  "forkTailN": 35 }
```

只带 `forkTailN` 时**完全不碰 profile**（也就不需要 `config-editor`）：

```json
{ "ok": true, "forkTailN": 35, "note": "分叉带走的条数已保存：立即生效，不需要重启。" }
```

失败的每一条路（都带中文原因，状态码如下，绝不假装成功）：

| 情况 | 状态码 |
|---|---|
| 插件停用（`enabled:false`） | `409` |
| 端口不是 1..65535 的整数；`trustedHosts` 不是数组 / 去重后为空 / 超过 200 条 / 有条目不是规范 authority | `400` |
| `forkTailN` 不是 1..200 的整数（小数 / 字符串 / 布尔 / 越界都算） | `400`（原因里写「分叉带走的条数」） |
| 没有可用的 `config-editor`，或找不到 `webserver`/`connection` 行 | `503`（**只改 `forkTailN` 时不会走到这里**） |
| `edit()` 抛错（如端口被占用、值被更高层 patch 覆盖） | `500`，并说明 config-editor 已回滚哪一次改动 |

**校验先于任何写入**：任何 400/503 之前，数据文件与 profile 都一个字节不动；`forkTailN` 的落盘
发生在两笔 profile 写入**之前**（它跟那两笔无关，端口失败不该把它一起丢掉）。

### 7.3 实现要点（都是被真源码/真行为逼出来的）

1. **`edit()` 是"整行 config 替换"**：`change(当前值, 继承值)` 返回什么就写什么。所以必须
   `{ ...current, 只改的键 }` —— 否则 `webserver` 的 `compression` 三件套、`connection` 的
   `cookieMaxAgeDays` 会被一起抹掉（自测里专门断言这三个字段没丢）。
2. **写一行就够，别写两行**：端口没变就完全不碰 `webserver`（它的重新激活 = HTTP 监听重启）。
3. **写完必须重新取 entry**：`edit()` 走 Loader 正常生命周期，`webserver`/`connection` 会
   **重新激活**，而本插件注入的正是这两个服务 → **本插件自身也被重新装配**，之前抓到的 entry
   对象随即失效（旧对象再喂给 `edit()` 会抛 `Configuration entry is no longer available`）。
   所以顺序是 connection → 重新取 entry → webserver，自测用"每次 edit 后把 entries 换成新对象"的
   假 config-editor 钉住这条。
4. **顺序刻意是 connection 先、webserver 后**：`@deepseek-ai/dsh-host-webserver` 的 dispose 会
   `server.closeAllConnections()`——端口一变，**浏览器**场景下这条响应所在的 socket 会被一起关掉
   （桌面 App 的 fetch 走壳的进程内桥接，不受影响）。所以"改端口"与"浏览器正在看的这个页面"本来就
   不可能同时成立：重启后换到新端口重开即可。**端口没变时（只改入口地址）这条响应一定能到达。**
5. **入口地址照官方的规范形式先校验**（`assertTrustedAuthority` 的等价实现）：
   官方在激活 `connection` 时对每条 assert，任何"会被 WHATWG 静默改写"的值都会让**那一行起不来**。
   带路径/用户名、补零端口、`0x` 写法、中间有空格一律 `400`；**首尾空白是修好（trim）而不是拒收**。
6. **`trustedHosts`（界面上的「入口地址（本地）」）是"Host 白名单"，不是"来源网段"**：
   - 匹配的是**请求里的 `Host` 头**（`hostname` 字符串全等，两侧 WHATWG 归一化）；
   - **不带端口**的条目 = 那台主机的**任意端口**都认（推荐，改端口不用重填）；
     **带端口**（`192.0.2.4:19387`）= 只认那一个 authority（改端口后必须重填）；
   - `127.0.0.1` 不用填（回环永远可信）；
   - **网段/通配符统统无效**：`192.0.2.0/24`、`192.0.2.4/32` 官方会拒（URL 会解析出 path），
     而 `192.0.2.*.*` 官方**会收下**但字符串全等匹配永远命中不了 —— 后两种我们都在写盘前 `400` 挡掉
     （见 `applyAccessConfig` 里那两段专门原因）；
   - 它挡的是 **DNS rebinding / 跨站**，**不是**"谁能连上"：真正的门是 `dsh-auth-*` 会话 cookie（认证）
     与端口是否可达（防火墙/ZeroTier/EasyTier）。想按来源网段限制，那是防火墙的事，不是这个字段；
   - 实测（2026-10-13，同一来源 `127.0.0.1`、只改 Host）：`Host: 192.0.2.4:19387` 且带 cookie → 200；
     `Host: 198.51.100.9:19387` → `/api/*` **403**；而**页面（`/`）本身不走这道栅栏**（它只查 index 授权，
     没 cookie 就 401）。所以“名字不对”的表现是：**页面能开、界面数据全 403**。
7. **绝不手改 YAML**：写入一律经 `ctx.configEditor.edit()`（它自己保留注释与其它字段、失败自动回滚）。
8. **顶层改不了就如实说**：`home patch` / 命令行 overlay 覆盖同名字段时 `edit()` 会抛错 ——
   这种情况我们回 `500` 并把原因带给用户，而不是偷偷"成功"。

**要手改的老路仍然有效**（比如 `config-editor` 不在组合里时）：

```yaml
# 暴露给网段：改 webserver.host / port（改完需要重启 DSH）
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  config:
    host: 0.0.0.0          # 只接受 127.0.0.1 或 0.0.0.0
    port: 19387            # 0 = 由 OS 分配
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024

# 浏览器会话 cookie 与可信 authority：注意这一行是**整段替换**，没写的字段会回到默认值
- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  config:
    trustedHosts:
      - "192.0.2.4"
      - "203.0.113.1"
    cookieMaxAgeDays: 3650  # 默认 30
```

文件位置：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（本机是 `C:\Users\<user>\.dsh\profiles\desktop\cordis.patch.yml`）。
**地基类改动（绑定/信任/端口）一律以"重启 DSH 生效"为准**：设置页写的也是这个口径。

### 7.4 「分叉带走的条数」为什么存数据文件，而不是 profile（0.8.0）

同一个「配置」块、同一个「保存」按钮，但**写两个地方**，这是刻意的：

| 这一格 | 写到哪 | 什么时候生效 | 需要 config-editor 吗 |
|---|---|---|---|
| 端口 / 入口地址 | profile patch 的 `webserver` / `connection` 两行（官方 `configEditor.edit`） | **重启 DSH**（地基类改动口径） | 需要（没有就是 503） |
| **分叉带走的条数** | 插件数据文件 `$DSH_HOME/remote-devices.json` 的 **`forkTailN`** 键 | **保存后立即生效** | 不需要 |

理由：
1. 它跟监听/信任毫无关系，写 profile 只会让「地基类改动要重启」这条口径被污染；
2. 写 profile 会触发 Loader 重新装配（`webserver`/`connection` 重新激活 → 本插件自身也被重新装配），
   而这一格完全可以在**不改 profile**的前提下改完 —— 少一次没必要的重装；
3. 存数据文件后，`dsh-remote` 的既有热重载机制（`stat` 数据文件、最多 1 秒生效）与
   `readDataFile → adoptData` 那条路天然覆盖它，重装/重启都读得回来。

生效优先级（`handleForkRequest`）：**请求体里的 `tailN`**（老客户端 / 显式指定）→ **数据文件里的 `forkTailN`** → **缺省 20**。
客户端半从 0.8.0 起**不再发 `tailN`**（它不知道用户设的是多少，发了就会把设置盖掉），
所以"设置里那一格"就是实际生效值。非法值（小数/字符串/布尔/0/201）一律 400，且**一个字节都不落盘**。

---

## 8. 冻结契约（客户端半按这张表写，路径与字段名不许改）

所有请求默认带 `credentials: "same-origin"`；除**唯一一条例外**外都**仅回环可读**
（非回环一律 `403` + 纯文本 `loopback only`；IPv6 的 `::1` 与 `::ffff:127.0.0.1` 也算回环）。
**那一条例外是 `GET /plugin/remote/download`**（下面表里注明了）：它是给**浏览器**用的，
所以走官方的"可信请求"判定（`connection.requestRejection`），不受"仅回环"约束；
它也是唯一一条会读**本机**磁盘文件的路由（经官方 `workspaceFiles`，见第 8-5-2-2 节）。
**任何响应都不是 `text/html`**，且没有裸 `<`。

| 方法/路径 | 作用 | 响应 |
|---|---|---|
| `GET /plugin/remote/state` | 一次性全部状态（**垫片自检也读它**，见第 3.2 节） | 见下 |
| `GET /plugin/remote/urls` | 带 token 的访问地址列表（原 token-copy 能力） | `{ process: { host, port, pid }, urls: [{ base, authenticated }] }` |
| `POST /plugin/remote/devices` | 新增/修改一台设备 | 请求体 `{ id?, name, url, token? }` → `{ ok: true, device: { id, name, url } }` \| `{ ok: false, error }` |
| `DELETE /plugin/remote/devices/<id>` | 删除 | `{ ok: true }` \| `{ ok: false, error }` |
| `POST /plugin/remote/test/<id>` | 连通性测试（用该设备 url，带 token 兑换与 cookie jar，`GET /` 拿到响应头就丢弃响应体；只回报状态码与耗时） | `{ ok, status, ms, error }` |
| `POST /plugin/remote/enabled` | **软开关**（只用它改 `enabled`；语义见第 3 节） | `{ enabled: bool }` → `{ ok: true, enabled }` |
| `POST /plugin/remote/hello` | 垫片报到（**不接受任何 body**） | `{ ok: true }` |
| `GET /plugin/remote/download?device=&path=&session=` | **另存为…**：把文件**流式**回给浏览器。`device` **可选**：空（或不带）= 读**页面所在这台机器**上的文件（本机 `workspaceFiles` 按 session 授权读）；有值 = 代理到那台设备。**不走"仅回环"**，走官方的"可信请求"判定（`connection.requestRejection`：Host/Origin 栅栏 + `dsh-auth-*` 会话 cookie）；`enabled=false` 时 403；见第 8.5 节 | 成功：`application/octet-stream` + `Content-Disposition: attachment`；失败：`text/plain` 中文说明 |
| `POST /plugin/remote/fork` | **分叉到…**：读本机源会话尾页 → 取目标机默认工作区 → 在目标机新建会话（带 `workspaceId`）→ 改名 `<源标题> - 来自<本机名>` → 发种子（仅回环；`enabled=false` 时 403；见第 8.5 节）。`tailN` 不给就用**数据文件里的 `forkTailN`**（缺省 20） | `{ targetDeviceId, sourceSessionId, sourceTitle?, tailN? }` → `{ ok: true, targetDeviceId, targetDeviceName, newSessionId, title, sourceTitle, localName, renameError, workspaceId, cwd, workspaceFallback, messages, bytes, via }` \| `{ ok: false, stage?, error, ... }` |
| `POST /plugin/remote/access` | **「配置」块**：`port` / `trustedHosts` 写进 profile patch，`forkTailN` 写数据文件（仅回环；`enabled=false` 时 409；见第 7 节） | `{ port?, trustedHosts?, forkTailN? }` → `{ ok: true, restartRequired: true, written: { host, port, trustedHosts, cookieMaxAgeDays }, forkTailN? }`（只给 `forkTailN` 时：`{ ok: true, forkTailN, note }`，无 `restartRequired`） \| `{ ok: false, error }`（400/409/500/503） |

`GET /plugin/remote/state` 的完整形状：

```jsonc
{
  "enabled": true,
  "version": "0.8.1",
  "localDevice": { "id": "company", "name": "设备A", "hostname": "my-pc", "via": "auto" }, // 或 null
  "devices": [
    {
      "id": "home", "name": "设备B", "url": "http://192.0.2.2:19387",
      "local": false,            // 这一台是不是被认领的"本机"
      "reachable": true,         // true | false | null（还没试过）
      "lastError": null,         // 最近一次代理/连通性测试的失败原因
      "lastOkAt": "2026-10-12T09:06:48.328Z"
    }
  ],
  "access": { "host": "0.0.0.0", "port": 19387, "trustedHosts": ["192.0.2.4"], "cookieMaxAgeDays": 3650,
              "localAddresses": ["127.0.0.1:19387", "192.0.2.4:19387"], "writable": true,
              "forkTailN": 20, "forkTailDefault": 20, "forkTailMax": 200 },  // 0.8.0：分叉带走的条数
  "diagnostics": {
    "injectionSeen": true,
    "lastHelloAt": "2026-10-12T09:06:48.528Z",
    "muxPath": "/api/remote.mux",
    "muxPathFound": true,
    "proxyRoutes": 8,            // 已注册的 /dev/** 路由条数（HTTP + upgrade）
    "saveAs": {                  // 本版新增：「另存为…」的可用性与最近一次结果
      "available": true, "lastError": null, "lastErrorAt": null,
      "lastOkAt": "2026-10-12T09:31:02.104Z", "attempts": 3
    },
    "fork": {                    // 本版新增：「分叉到…」的可用性与最近一次结果（0.8.0 起多报条数）
      "available": true, "lastError": null, "lastErrorAt": null,
      "lastOkAt": "2026-10-12T09:33:40.771Z", "attempts": 1, "via": "in-process",
      "tailN": 20, "tailDefault": 20, "tailMax": 200
    },
    "notes": ["…一条条人能读的说明…"]
  }
}
```

行为细节：

- `POST /devices`：`id` 给了就是 **upsert**（存在则改，不存在则建）；`id` 缺省时从 `name` 派生
  （中文名字派生不出来就退而用 url 的 host，如 `192.0.2.80`），派生出来的 id **已存在就报
  `duplicate id: …`**，绝不悄悄改别人的设备。`token` 字段：存在则写（空串 = 删除该设备的 token），
  不存在则不动。
- `POST /test/<id>`：`ok` 的定义是"拿到了 HTTP 响应且状态码 < 500"——**401 也算活着**
  （远端要 token 而我们没配对时会回 401，此时 `status:401` 就是最有用的信息）。
- `access.writable` 是给客户端半/体检的信号：`true` = 「配置」块的保存能成功（见第 7 节）。
- 方法不对 → `405 {ok:false}`；未知路径 → `404 {ok:false,error:"unknown route: …"}`。

### 垫片的对外接口（**冻结**，客户端半切设备就靠它）

| 接口 | 值 |
|---|---|
| localStorage 键（当前设备 id；空/删键 = 本机） | **`dsh-device-switch:current`**（主）+ `dsh-remote:current`（别名，两个都读都写） |
| localStorage 键（设备列表 `[{id,name}]`，可覆盖宿主注入的缺省） | `dsh-device-switch:devices`（主）+ `dsh-remote:devices` |
| sessionStorage 键（自检防循环哨兵，非空 = 这个窗口已为"停用"刷过一次） | `dsh-remote:soft-off` |
| sessionStorage 键（**强制激活**标记，非空 = 这次加载忽略 payload.enabled 与哨兵、直接走正常模式；用掉即删） | `dsh-remote:force-active` |
| 垫片自检读的接口（GET，`credentials:"same-origin"`, `cache:"no-store"`） | `/plugin/remote/state`（payload 里的 `statePath` 由宿主注入） |
| 胶囊浮层的 DOM id | `dsh-remote-root`（面板 `-panel`，按钮 `-toggle`） |
| 注入标记 | `/* dsh-remote:shim */` |
| 注入 payload 字段 | `{ devices, localName, localCaption, helloPath, statePath, enabled, sentinelKey, forceActiveKey }` |

**停用（`enabled:false`）时垫片的完整动作序列**（`softOff()`，selftest C4 逐条断言）：

```
clearStoredSelection()   # 四个键全删（主键 + 别名 × current/devices）
removePill()             # removeChild 掉 #dsh-remote-root（真的从 DOM 上摘掉）
restorePrimitives()      # fetch / WebSocket / XMLHttpRequest.prototype.open 还原成原函数
reloadOnce()             # 先写 sessionStorage 哨兵，再 location.reload()（同一窗口最多一次）
```

> 为什么主键仍是 `dsh-device-switch:*`：那是 device-switch 0.2.x 就在用的键，**用户窗口里已有选择值**，
> 客户端半也按它切换设备；改名会让"当前设备"丢失。`dsh-remote:*` 作为别名同时读写，给将来留路。

---

## 8.5 两条新能力：文件「另存为…」与会话「分叉到…」

两条都**只用官方扩展位**（不做 DOM 硬插、不改壳），都受 `enabled` 软开关门控
（与 `/dev/**` 一致：停用时一律 403 + 中文说明，但设置页/体检照旧可读），
错误一律中文，**任何响应都不是 `text/html`**（I1；下载走 `application/octet-stream` + `nosniff`）。

**鉴权（2026-10-13 改法，用户实测驱动）**：
- **「分叉到…」仍然只认回环**（`403 loopback only`）—— 它是**写**操作，只服务设置页/桌面 App。
- **「另存为…」不认回环，认官方的"可信请求"判定**（`ctx.connection.requestRejection(request)`）。
  理由：它的典型用户就是"**坐在家里用浏览器打开设备A的 DSH 页面**，点另存为" ——
  这条请求**天然不来自回环**，旧的"仅回环"守卫必然 403，功能等于废掉（去掉判断也救不了，
  因为 403 发生在宿主半）。官方那套判定同时防 DNS rebinding（Host/Origin 栅栏）与
  跨站请求，并校验浏览器会话 cookie，正是"给浏览器用的路由"该用的东西（证据见 8-5-2-1）。
- **绝不自己发明鉴权**：判定只有一处 —— 官方 `connection.requestRejection`；它拿不到
  （老 DSH 没这个方法）时**一律拒绝**（403 + 写明原因），而不是放行。

> **另存为的模型只有一句：页面由哪台机器提供，文件就在哪台机器上。**
> 所以宿主半**不做"当前设备"判断**，只看地址上的 `device`：
> **空/缺失 → 本机文件**（用本机 `workspaceFiles` 按 session 授权读，一个字节都不出网）；
> **有值 → 那台设备**（走 Remote RPC 代理回来）。客户端半只把"设备切换键"**有就带、空就带空值**。

### 8.5.1 目标机接口的确切结论（先说结论，再说我是从哪个文件确认的）

两条能力都不去猜目标机的私有接口，而是走 **DSH 自己的 Connection 一元 Remote RPC**。
**这是本节的"证据链"，每条都标注了文件**（都用 `_inspect/asar_grep.py --extract` 从 `app.asar` 抽出来读过）：

| 结论 | 值 | 从哪个文件确认 |
|---|---|---|
| RPC 的 HTTP 入口 | `POST <设备>/api/<namespace>/<method>`，`content-type: application/json` | `@deepseek-ai/dsh-client-connection/lib/index.js`：`API_PATH = "/api"`、`rpcFetchHandler()`（它取 `pathname.slice(channel.length + 1)` 当 endpoint，并要求 `message.method === endpoint`） |
| 请求信封 | `{ "type": "client-request", "rpcId": "<string>", "method": "<namespace>/<method>", "payload": { "args": { … } } }` | 同上：`clientRequestSchema`；`@deepseek-ai/dsh-api-gateway/lib/index.js` 的 `remoteRequest()`（要求 payload **恰好**只有 `args` 一个键） |
| endpoint 命名 | `${namespace}/${method}`，如 `workspaceFiles/readBytes`、`session/create` | `@deepseek-ai/dsh-api-gateway/lib/index.js`：`endpointOf()`、`claimsEndpoint()`、`invokeRpc()`；客户端半 `ctx.remote.<ns>.<method>()` → `ctx.connection.rpc.call('/api', endpoint, …)`（gateway 的 `README.zh.md`「Client 服务：`ClientRemote`（ctx key：`remote`）」一节） |
| 响应信封 | JSON `{ "type": "server-response", "rpcId", "result": { ok:true, value } \| { ok:false, error:{ code, message, details } } }` | `dsh-client-connection/lib/index.js`：`serverResponseSchema`、`fullResponse()`、`errorResponse()` |
| **带二进制的响应是 multipart** | `multipart/form-data`，`metadata` 段是上面的 JSON（字节位置是 `null` 占位），附件是 `bytes-<n>` 段 | 同上：`fullResponse()` 用 `FormData` + `new Response(parts)`；`@deepseek-ai/dsh-api-gateway/lib/index.js` 的 `encodeRpcResult()` 用 `writeBytes(value, path)` 把字节摘成附件（`readBytes` 的路径是 `["data"]`，见 `dsh-api-workspace-files/lib/typert.remote-client.js` 的 `result.encode`） |
| 读文件的两个方法 | `workspaceFiles/stat`（args：`workspaceFileScopeId`、`path`）与 `workspaceFiles/readBytes`（args：`workspaceFileScopeId`、`path`、`options`） | `dsh-api-workspace-files/lib/typert.remote-client.js` 的 `TYPERT_REMOTE.descriptors`（含每个参数的 `name` / `wire` / `source`）；方法语义见该包 `README.zh.md` 第 30–50 行 |
| 字节窗口 | `options.range = { offset?, length? }`（0 起算的字节；默认上限 `maxBytes = 2 MiB`，更长的窗口以 `too-large` 失败而不是截短） | 同上 + `dsh-api-workspace-files/README.zh.md`「二进制读取」一节 |
| `readBytes` 的返回值 | `{ offset, data: Uint8Array, eof, absolutePath, version, bytes? }` | 同上（`data` 就是那个附件） |
| 会话分页 | `session/page`（args **只有**一个 `request` 字段：`{ address:{kind:"session",sessionId}, throughSeq, beforeSeq?, maxMessages?, turnWindow? }`） | `dsh-api-session-controller/lib/typert.remote-client.js` 的 descriptor（`parameters: [{ name:'request', wire:'request', … }]`） |
| `throughSeq` 的语义 | 分页**从 `throughSeq+1` 往回**走（`paginate()` 的 `end = min(throughSeq+1, beforeSeq ?? throughSeq+1)`），所以 `throughSeq = 当前最大 seq` 就是"最后一页" | `dsh-api-session-controller/lib/index.js`：`page()` 与 `paginate()` |
| **`throughSeq: -1` 不是"最新"** | 它等价于 `throughSeq+1 = 0` → `slice(0,0)` = **空页**（这是刻意记下来的一条坑） | 同上 |
| 会话头 seq（asOfSeq） | `session/projections`（args：`request: { sessionId }`）→ `{ asOfSeq, values }` 或 `null`（会话不存在） | 同上：`projections()`（`dsh-api-session-controller/lib/index.js` 第 3149–3164 行） |
| 新建会话 | `session/create`（args：`request: { workspaceId?, cwd?, sessionId?, agentPreset? }`）→ `{ sessionId, agentPreset? }`；**四个字段都可选**（传 `{}` 只是"用它自己的默认 cwd"），但 `workspaceId` 与 `cwd` **互斥**：两个都给会被拒 | 同上 descriptor：`SessionCreateRequest`；互斥与 `cwd = workspace?.path ?? request.cwd ?? this.defaultCwd` 见 `dsh-api-session-controller/lib/index.js` 的 `create()`（`throw new RemoteError("gateway/bad-request", "session.create accepts workspaceId or cwd, not both", {})`） |
| **目标机的默认工作区** | `workspace/initializeDefault`：args **必须是空对象**（descriptor 零参数；gateway 的 `assertExactArguments` 会拒多余/缺失字段）→ `undefined \| { workspace: { workspaceId, path, title, sessionIds, createdAt, updatedAt } }`；取到 `workspaceId` 后 `session/create` 的 `cwd` 就解析成 `workspace.path`（并顺带把新会话挂进该工作区） | `@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js` 的 descriptor（`parameters: []`、result 是 `z.union([z.undefined(), z.object({ workspace: … })])`）；`dsh-api-workspace-controller/lib/index.js` 的 `initializeDefault()`（返回 `workspace === undefined ? undefined : { workspace: workspaceView(workspace) }`）与 `dsh-api-session-controller/lib/index.js` 的 `create()` |
| **改会话标题** | `session/rename`（args：`request: { sessionId, title }`）→ `{ title, seq }` | `dsh-api-session-controller/lib/typert.remote-client.js` 的 descriptor（`parameters: [{ name:'request', wire:'request', … SessionRenameRequest }]`，result `SessionRenameValue`）；`dsh-api-session-controller/lib/index.js` 的 `rename()`（标题先过 `sessionTitle.rename()` 归一化，空标题抛 `session/title-invalid`） |
| 发消息 | `session/prompt`（args：`request: { requestId, sessionId, mode:"queue"\|"steer", content:[{type:"text",text}\|…] }`）→ `{ accepted: true }` | 同上 descriptor：`SessionPromptRequest` |
| 消息事件的形状 | `user/message` 的文本在 `data.content[]`；`assistant/message` 的文本在 `data.message.content[]`；块形如 `{type:"text",text}` | `dsh-api-session-controller/lib/index.js`（`MESSAGE_TYPES = {user/message, assistant/message}`、`imageInEvent()` 读 `data.content` / `data.message?.content`） |
| 本机服务 key | `ctx.sessionController`（namespace `session`） | 同上：`super(ctx, "sessionController", { namespace: "session" })` |

两条能力在**目标机**上的实际请求（都带 Host/Origin 改写 + 该设备的 cookie jar，
复用第 3 节那条 token 兑换路线）：

```
POST /api/workspaceFiles/stat       {"type":"client-request","rpcId":"dsh-remote-N","method":"workspaceFiles/stat",
                                     "payload":{"args":{"workspaceFileScopeId":"<目标机上的 sessionId>","path":"<路径>"}}}
POST /api/workspaceFiles/readBytes  …{"args":{"workspaceFileScopeId":"…","path":"…","options":{"range":{"offset":0,"length":524288}}}}
POST /api/workspace/initializeDefault …{"method":"workspace/initializeDefault","payload":{"args":{}}}
POST /api/session/create            …{"method":"session/create","payload":{"args":{"request":{"workspaceId":"<默认工作区 id>"}}}}
POST /api/session/rename            …{"method":"session/rename","payload":{"args":{"request":
                                       {"sessionId":"<新会话>","title":"<源会话标题> - 来自<本机名>"}}}}
POST /api/session/prompt            …{"method":"session/prompt","payload":{"args":{"request":
                                       {"requestId":"dsh-remote-N","sessionId":"<新会话>","mode":"queue",
                                        "content":[{"type":"text","text":"[来自另一台设备的会话分叉]…"}]}}}}
```

### 8.5.2 另存为…（`GET /plugin/remote/download`）

**客户端半**（`sidebar.right.tab.document.actions`，list / **session 作用域**，`order: 900` =
同插槽 open-in-app 的「显示文件位置」之后）：

- **挂载点（2026-10-13 修）**：这个 list 由 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`
  渲染，位置是**文档预览的头部按钮区**（不是标签页「…」菜单）。它**只在文件元数据报出 Host
  绝对路径时**才渲染这个槽位：
  `const fileOwner = absolutePath === void 0 ? void 0 : { absolutePath };` →
  `renderSlot("sidebar.right.tab.document.actions", fileOwner)`（该文件里两处渲染点：文本预览头部
  与"不支持预览"的空态头部）。所以 **ownerProps 只有 `{ absolutePath }`**——
  和 open-in-app 的 `OpenPathAction` 用的是同一个 prop（它拿它去 `openPath(path, …)`）。
- **会话 id 不是 ownerProp**：它是这个 session 作用域槽位的**标准 props**
  （catalog 的 `standardProps` 里逐字有 `sessionId: SessionId`，同列的还有 `useResource`、
  `useSessions`…；框架把"会话标准工具包"与 owner 一起合进 props）。文件读取**按 session 授权**
  （lookup `workspaceFileScope`，本机与目标机是**同一套**服务与闸门），所以必须带上它。
- **按钮永远显示**（不做渲染期可见性判断：早先在本机时整项隐藏，用户找不到入口 ✗）。
  点击那一刻只校验**两项**，缺一项给**明确的中文提示**（`alert`，退到 `console.warn`），
  **绝不默默消失、绝不猜路径**：
  1. 槽位没给 `absolutePath` → 「拿不到文件路径…」；
  2. 槽位没给 `sessionId` → 「没有会话信息…」。
  两项齐全就 `location.assign("/plugin/remote/download?device=…&path=…&session=…")`
  （参数一律 `encodeURIComponent`；`path` 就是整条 Host 绝对路径）。
- **不再有"当前是本机 → 不下载"这条判断**（2026-10-13 删掉）：那正是"浏览器打开远端页面时
  必然失败"的根源 —— 浏览器里 `localStorage["dsh-device-switch:current"]` 是空的，
  于是它只会报一句对用户毫无意义的「当前是「本机」」。现在设备切换键只是**可选**参数：
  有就带（桌面 App 切了远端时），**空就带一个空的 `device=`**，照样发起下载。
- **外观**：用官方 `Button` 的 `toolbar` 变体 + `size:"sm"`（`.toolbar` 读的是
  `--dsw-alias-button-tool-bar-fill/-hover` 这套工具栏令牌，28px 高，与预览头部其它小控件同高），
  图标是官方 `IconDownloadOutlineRegular`，并带 `title`（悬停提示）与 `aria-label`。
  **刻意不用 `MenuItemButton`**：那是下拉菜单的**行**组件（整行宽度 + 行高 + 分隔线），
  放进标题栏按钮区不合适。取不到 `ui-primitives` 时退化成普通 `<button role="button">`（功能一致）。
- 客户端半仍然**只 require `react` 与 `@deepseek-ai/dsh-client-ui-primitives`**（自测里有断言）。

**宿主半**（`GET /plugin/remote/download?device=<可选的设备 id>&path=<路径>&session=<会话 id>`）：

1. **鉴权 = 官方的"可信请求"判定**（不是"仅回环"）：调 `ctx.connection.requestRejection(req)`；
   `undefined` → 放行；返回数字（官方：`403` = Host/Origin 栅栏没过、`401` = 栅栏过了但没有有效
   会话 cookie）→ **一律 `403 text/plain`**，并把官方那个码写进正文（排错不用猜）。
   拿不到这个方法（老 DSH）→ 也一律拒绝并写明原因。细节与出处见 **8-5-2-1**。
   `enabled=false` → `403` + 中文说明（在鉴权之前）。
2. 参数校验：`device` **可选** —— 空/缺失 = 本机文件（**不查设备表**，所以浏览器里那个空的
   切换键天然可用）；有值则必须是配置里的设备 id（`^[A-Za-z0-9._~-]+$`）且**不是被认领的"本机"**。
   `path` 非空/不含 NUL/不超过 4096 字符、`session` 非空/不含 NUL/不超过 256 字符；缺一即
   `400 text/plain`。`session` 是**必须的** —— 文件读取按 session 授权（lookup `workspaceFileScope`：
   会话头里的 `cwd` 就是工作区根，会话不存在/不可见就没有授权范围），本机与目标机同一套。
3. 打开来源（**两条路只差这一步**）：
   - **`device` 为空 → 本机**：进程内调 `ctx.workspaceFiles`（官方
     `@deepseek-ai/dsh-api-workspace-files` 的 `WorkspaceFiles`，`dsh-web-app` 的标准组合里有它），
     session → `{sessionId, workspaceRoot}` 由官方 `ctx.typert.lookups` 的 `workspaceFileScope` 解析；
     闸门全在服务里（空路径 / `lstat` / 普通文件 / 末端符号链接），本插件**只翻译错误**。
     组合里没有这套服务 → `403` + 写明"本机文件读取不可用"（**绝不绕过官方服务直接读磁盘**）。
     取不到 session → `404`；不是普通文件 → `400`；找不到 → `404`（文案里都带"本机"两个字）。
   - **`device` 有值 → 那台设备**：`workspaceFiles/stat` 拿大小与类型（目录 →
     `workspace-file/not-regular-file` → `400` "不是普通文件"；找不到 → `404`；session 不在目标机上
     （`gateway/lookup-not-found`）→ `404`；token 失效（HTTP 401）→ **401** + 提示去补 token；
     不可达 → `502`）。
4. 写响应头（`Content-Type: application/octet-stream`、`nosniff`、`no-store`、
   `Content-Disposition: attachment; filename="<ASCII 回退>"; filename*=UTF-8''<RFC 5987>`，
   `Content-Length` 来自来源的 `stat.bytes`），再按 **512 KiB 一个窗口**循环读，每个窗口的字节
   **立刻**写回浏览器（带背压），`eof` 就收尾。**整份文件绝不进内存**：内存里最多只有
   "一个窗口 + metadata"。
5. 中途失败（来源掉线 / 空窗口却不推进）就销毁连接并写日志；浏览器侧断开则停止读取
   （本机那条路还会**取消**这次文件读取：`AbortController` 接到 `res` 的 `close` 上）。
6. `Content-Length` 若来源没给就只发 `Content-Disposition`（浏览器自己按 chunked 收）。
7. 文件名：`basename` 同时认 `/` 与 `\`；`filename*` 用 RFC 5987 的 ext-value
   （`encodeURIComponent` + 补编码 `!'()*` —— 那四个 `encodeURIComponent` 不会转），
   中文名走 `filename*`，老客户端用 ASCII 回退名。

#### 8-5-2-1 鉴权：官方"可信请求"判定的确切出处（照抄官方的用法，不自己发明）

`_inspect/asar_grep.py --extract` 从 `app.asar` 抽出来读过的原文（**行号就是 asar 里那个文件的行号**）：

| 事实 | 文件 + 行号 | 原文（节选） |
|---|---|---|
| 判定的定义 | `dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js` **586–589** | `requestRejection(request) {`<br>`  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;`<br>`  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;`<br>`}` |
| 同步、可选的 `admit()` 包装 | 同上 **591–594** | `admit(request) { const rejection = this.requestRejection(request); return rejection === void 0 ? { peer: this.operator } : { rejection }; }` |
| 栅栏到底查什么 | 同上 **205–219**（`isTrustedApiRequest`），配 **142–146**（`header`）、**192–198**（`isTrustedAuthority`）、**121–125**（`isLoopbackHostname`） | `const host = header(request.headers, "host"); if (host === void 0) return false;`…`if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, this.trustedHosts)) return false;`<br>`if (header(request.headers, "sec-fetch-site") === "cross-site") return false;`<br>`const origin = header(request.headers, "origin"); if (origin === void 0) return true;`<br>`return new URL(origin).host === hostUrl.host;` |
| 会话认证看的是哪个 cookie | 同上 **284–286**（`cookieName`）与 **296–297**（`sessionCookie`） | `return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());`（`COOKIE_PREFIX = "dsh-auth-"`，**227**）<br>`\`${name}=${value}; Max-Age=…; Path=/; Expires=…; HttpOnly; SameSite=Strict\`` |
| **官方路由的用法（照抄的就是这一段）** | `dsh/node_modules/@deepseek-ai/dsh-host-open-in-app/lib/index.js` **1263–1270** | `const rejected = (req, res) => {`<br>`  const rejection = connectionOf(ctx).requestRejection(req);`<br>`  if (rejection === void 0) return false;`<br>`  res.statusCode = rejection;`<br>`  res.end();`<br>`  return true;`<br>`};` |
| 官方路由注册时的用法 | 同上 **1271–1282**（`ctx.webServer.register({kind:"exact",…})` 里第一句就是 `if (rejected(req, res)) return;`） | `handler: async (req, res) => { if (rejected(req, res)) return; if (req.method !== "GET") { … }` |
| connection 自己的 `/api` 路由 | `dsh-client-connection/lib/index.js` **830–842** | `handler: async (req, res) => { const admission = connection.admit(req); if ("rejection" in admission) { res.writeHead(admission.rejection); res.end(admission.rejection === 401 ? "unauthorized" : "forbidden"); return; }` |
| 官方文档口径 | 同上包的 `README.zh.md`（抽出来读的第 39 / 43 行） | "每个 Host RPC 方法和 WebSocket 流都要求一个浏览器会话，**不存在按方法区分的 loopback 层**"；"Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401" |

**本插件的用法**（`lib/index.js` 的 `authorizeTrustedRequest`）就是官方那三行的等价物：
拿 `ctx.connection.requestRejection(req)`（`serviceOf(ctx,"connection")` 读服务，先 `ctx.get` 后退属性），
`undefined` 放行、数字拒绝。两处**刻意的**不同，都写在代码注释里：

- 拒绝时**统一折成 403**，但把官方的码（401/403）与原因写进 `text/plain` 正文 ——
  与旧"仅回环 → 403"在客户端看来语义一致，同时不丢诊断信息。
- 官方 open-in-app 拒绝时是**空响应体**；本插件按自己的 I1 规矩回 `text/plain` + `nosniff`
  （selftest 逐条断言"不是 text/html、没有裸 `<`"）。

#### 8-5-2-2 本机文件怎么读（`device` 为空时）

**不新发明读取路径，也不直接碰磁盘**：进程内调官方那个"按 session 授权读工作区文件"的服务。
出处同样是抽出来读的原文：

| 事实 | 文件 + 行号 | 原文（节选） |
|---|---|---|
| 服务名 / 类 | `dsh/node_modules/@deepseek-ai/dsh-api-workspace-files/lib/index.js` **394–395** | `constructor(ctx, config) { super(ctx, "workspaceFiles"); … }`（`static inject = ["fs","sandboxPolicy","sessions","typert"]`，**377–382**） |
| session → 工作区根（授权那一步） | 同上 **398–414** | `ctx.inject(["sessions","typert"], (scope) => { scope.typert.lookups.register("workspaceFileScope", { parameter:"workspaceFileScope", wire:"workspaceFileScopeId", … resolve: async (sessionId) => { const live = scope.sessions.get(sessionId)?.header; … if (header === void 0) return void 0; return { sessionId, workspaceRoot: header.cwd ?? scope.sandboxPolicy.workspaceRoot }; } }); })` |
| 消费端怎么取 lookup | `dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/types/service.js` **169–193**（`LookupStore.view/get`） | `get: key => this.get(key)` … `get(key) { const provider = this.providers.get(key)?.provider; if (provider === undefined) return undefined; … return { … resolve: id => resolver.resolve(id) }; }` |
| 四道闸门 | `dsh-api-workspace-files/lib/index.js` **562–608**（`inspect` / `confine` / `locateFile`） | `const entry = await this.ctx.fs.lstat(path, { cwd: workspaceRoot }, signal); if (entry === undefined) throw new RemoteError("workspace-file/not-found", …); if (entry.type !== "file") throw new RemoteError("workspace-file/not-regular-file", …)` |
| 读字节窗口 | 同上 **446–459** | `const data = await this.ctx.fs.readByteRange(target, window, signal);`（`window = {offset,length}`，超过 `config.maxBytes`（默认 2 MiB）以 `too-large` 失败而不是截短） |
| 服务确实在标准组合里 | `dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` **132–133** | `- id: workspace-files`<br>`  name: '@deepseek-ai/dsh-api-workspace-files'` |

本插件**只做三件事**：`serviceOf(ctx,"typert").lookups.get("workspaceFileScope").resolve(sessionId)`
拿 scope（拿不到 → `404` 本机上找不到这个 session）→ `workspaceFiles.stat(scope, path, signal)`
（目录/非普通文件/找不到 → 服务自己的错误码 → 翻成中文 + HTTP 码）→ 循环
`workspaceFiles.readBytes(scope, path, {range:{offset,length:512KiB}}, signal)`。
进程内调用 Remote **必须传 `AbortSignal`**（官方 `@Remote` 包装会直接解引用它 —— 这条坑
`readLocalSessionTail` 的注释里早有实测记录），所以每次都传，并接到响应的 `close` 上。

> **权限范围照实说**：官方 `workspaceFiles` 对**文件读取**不做"必须落在工作区内"的检查
> （工作区包含只约束目录列举与目录监听；见该包 `README.zh.md`「寻址与路径」「文件读取与目录检查」），
> 所以本机这条路能读到的范围 = **有会话授权 + 文件系统后端允许读**。这与"读目标机文件"完全一致
> （那条路打的就是同一个服务的 Remote），本插件**没有放宽也没有收紧**它 ——
> 收紧（额外要求落在工作区内）会与目标机那条路行为不一致，所以不做。

### 8.5.3 分叉到…（`POST /plugin/remote/fork`）

**客户端半**（`sidebar.workspaces.session.menu.item`，list / root 作用域，`order: 900` = 内置的
pin 100 / rename 200 / fork 300 / archive 400 之后，落在菜单末尾）：

- **没有任何远程设备时整项隐藏**（`GET /plugin/remote/state` 的 `devices` 里排除 `local:true` 那台；
  加载中不显示）。读设备表失败时**仍然显示**该项，点一下给出错误（不白屏、不让用户没线索）。
- **每台远程设备一行**「分叉到 <设备名>」（不再有自绘的「分叉到…」一级项 + 子菜单）：
  行的 children 是 `["分叉到 ", <span style={{fontWeight:600}}>设备名</span>]` ——
  **设备名是独立的加重节点**（用户："要有明显的标识区分"），多设备时一眼可辨；
  整行仍然用官方 `MenuItemButton`（字体/图标/hover/分隔线都是框架内置的），没有自绘按钮。
- 点某一行 → `POST /plugin/remote/fork`
  `{ targetDeviceId, sourceSessionId, sourceTitle }`（**0.8.0 起不再发 `tailN`** —— 条数由宿主半按
  「配置」块存进数据文件的值决定，客户端不知道也不该猜；`sourceSessionId` 与 `sourceTitle`
  **只从槽位 ownerProps 的 `props.sessionId` / `props.displayTitle` 拿**：前者拿不到就提示并
  **一个请求都不发**；后者缺失/不是字符串时送**空串**，由宿主半兜底成「未命名会话」——
  客户端半**不自己编标题**）。
- 结果用一条中文提示回报：成功 `已在 <设备名> 上创建会话 <id 前 8 位>（带过去 N 条消息）`，
  失败 `分叉失败：<原因>`。菜单用框架注入的 `useMenuOpenState` 关闭
  （拿不到再退回 owner 给的 `props.dismiss`）。

**宿主半**（`POST /plugin/remote/fork`，请求体 `{ targetDeviceId, sourceSessionId, sourceTitle?, tailN? }`）：

1. 仅回环；`enabled=false` → `403 {ok:false}`；请求体不是 JSON 对象 → `400`。
2. 参数校验：`targetDeviceId` 必须是配置里的设备且不是"本机"；`sourceSessionId` 非空/不含 NUL/≤256 字符；
   `tailN` 是 `1..200` 的整数。**条数优先级**：请求体里的 `tailN` → 数据文件里的 `forkTailN` → 缺省 `20`
   （0.8.0 起客户端不发 `tailN`，所以在设置页改的那一格就是实际值）。全部违规都回 `400 {ok:false,error}`
   （中文，含参数名）。
   `sourceTitle` 是**可选的**：控制字符（含 NUL）换空格 → 去首尾空白 → 截到 512 字符；
   洗完为空就用「未命名会话」（**绝不会出现空标题或 `undefined`**）。
3. **读本机源会话**（源会话就是**本机**这条会话：用户在本地会话里点分叉）：
   优先用**进程内** `ctx.sessionController`（`projections({sessionId})` 拿 `asOfSeq` →
   `page({ address:{kind:"session",sessionId}, throughSeq: asOfSeq, maxMessages: tailN })`）；
   拿不到（服务不在/形状不认识）就退回**本机 HTTP** 的同一对 endpoint
   （`POST /api/session/projections`、`POST /api/session/page`，cookie 由进程 token 兑换一次；
   注意线路上的参数是 `{ request: {…} }`）。
   本机没有这条会话 / 读不到 → `404 {ok:false,error}`（写明是哪一步失败）。
4. 把尾页记录按 `role: text` 拼成种子（`用户: …` / `助手: …`；工具调用结果只留一行 `[工具调用：<name>]`，
   图片/文件留 `[图片]`/`[文件]`）；空文本消息跳过；超 256 KiB 就从**最新**那头截断并写明。
   一条可带走的文字都没有 → `400`（不建会话、不发空种子）。
5. **取目标机的默认工作区**（**新会话的落点就靠这一步**）：`POST /api/workspace/initializeDefault`，
   `args = {}`（descriptor 零参数，多一个字段都会被 gateway 的 `assertExactArguments` 拒掉）；
   结果形状是 `undefined | { workspace: { workspaceId, path, title, sessionIds, createdAt, updatedAt } }`
   （**逐字来自** `@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js`）。
   拿到 → 记下 `workspaceId` 与 `path`；**报错 / 返回 `undefined`** → **不挡分叉**：
   退回"不指定工作区"（= 目标机自己的默认 cwd，本版修掉的那个 bug 会复现），
   写一条中文 warn，并在响应里带 `workspaceFallback:true`。
6. **在目标机新建会话**：`POST /api/session/create`，
   `args.request = { workspaceId: <第 5 步拿到的 id> }`；降级时是 `{}`。
   **为什么是 `workspaceId` 而不是 `cwd`**：`SessionCreateRequest` 是 `{ workspaceId?, cwd?, sessionId?, agentPreset? }`，
   目标机的 `create()` 里 `cwd = workspace?.path ?? request.cwd ?? this.defaultCwd`，且
   `workspaceId` 与 `cwd` **同时给会被拒**（`gateway/bad-request: session.create accepts workspaceId or cwd, not both`）；
   给 `workspaceId` 还顺带把新会话挂进那个工作区的导航里。**不传模型**（用目标机默认值）。
   不可达 → `502 {stage:"create"}`；token 失效（401/403）→ `401 {stage:"create"}`；
   目标机业务错误 → `502 {stage:"create"}`（带 endpoint 与原因）。
7. **给新会话改名**：`POST /api/session/rename`，`args` **恰好** `{ request: { sessionId: <新会话>, title: <标题> } }`
   （descriptor：参数只有一个 `wire: "request"`；结果 `{ title, seq }`）。
   标题 = **`<源标题> - 来自<本机设备名>`**（用户口径；源标题为空 → `未命名会话 - 来自<本机设备名>`）。
   本机设备名依次退：被认领的本机设备 `name`（例如 `设备A`）→ 它的 `id` → `os.hostname()` → `本机`。
   **改名失败不让整个分叉失败**（会话已经建好）：写一条中文 warn、响应里带 `renameError`，
   继续第 8 步；`title` 字段在成功时用目标机回声的标题（它自己的 title 服务会压空白/截断）。
8. **把种子当作第一条消息发过去**：`POST /api/session/prompt`，
   `{ requestId, sessionId: <新会话>, mode: "queue", content: [{ type: "text", text: <种子> }] }`，
   种子正文以这一段固定措辞开头（**别改口径**）：

   ```
   [来自另一台设备的会话分叉]
   以下是我在另一台机器上的会话上下文（仅文字，不含文件）。请在此基础上继续。

   <上下文>
   ```

   失败 → `502 {stage:"prompt"}`，但响应里仍带上已创建的 `newSessionId`、`title` 与 `renameError`（好排错）。
9. 成功返回 `{ ok:true, targetDeviceId, targetDeviceName, newSessionId, title, sourceTitle, localName,
   renameError, workspaceId, cwd, workspaceFallback, messages, bytes, via }`：
   `workspaceId` / `cwd` 是**目标机实际用的落点**（降级时两者都是 `null` 且 `workspaceFallback:true`），
   `title` 最终标题、`sourceTitle` 收到的源标题、`localName` 拼标题用的本机名、`renameError` 为 `null` 表示改名成功。
   **不**改动本机会话、**不**切换设备（用户明确要求不自动切换）。

### 8.5.4 隐私与"未验证"

- **隐私（必须知道）**：分叉会把本机会话最近若干条消息的**纯文字**发到目标机，
  并作为新会话的第一条消息**落到目标机的会话库里、留在那台机器上**。
  带过去的是文字（工具调用只留一行摘要），**不带文件**；但文字本身可能含敏感内容 ——
  请只对可信设备用这个功能。另存为只**读**文件，不改任何机器上的任何东西；
  `device` 为空时读的就是**提供页面那台机器**上的文件（`enabled=true` 且请求通过了官方的
  "可信请求"判定，即"能打开这个 DSH 页面的人"就能读 —— 与官方 `/api`、官方的文件预览同权限）。
- **未验证 / 已知风险**（与第 11 节并列；这些是"照实说"的部分，不是猜测的结论）：

  1. **真机端到端没跑过**：本轮不允许安装插件、不允许改 `C:\Users\<user>\.dsh`、不允许重启、
     不允许 ssh。自测里的"目标机"是我用 `node:http` 搭的替身（照上面那张证据链表复刻信封、
     multipart、`session/create|prompt|rename` 与 `workspace/initializeDefault` 的入参形状）。
     **请求形状是照源码写的**，但"真机上确实能下载到字节 / 确实能建出会话"**没有在真机上验证过**。
  2. **落点与标题这一版是按源码改的，真机复测还没做**（用户上一轮实测的两个问题的修复）：
     - `workspace/initializeDefault` 的具体 endpoint / 零参数 / 返回形状取自
       `@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js`（`parameters: []` +
       `undefined | { workspace: { workspaceId, path, … } }`），`session/create` 用 `workspaceId`
       取自同一包里 `create()` 的 `cwd = workspace?.path ?? request.cwd ?? this.defaultCwd`。
       **没在真机上打过一次这个 endpoint**，也没验证过"目标机上真的多了一个 default-workspace 目录"。
       注意它**有副作用**：目标机首次合格使用时会按它的 Documents 规则**建目录并注册工作区**
       （docs 明说"creates no Session and sends no message"，但确实会落盘）。
     - `session/rename` 的参数 `{ request: { sessionId, title } }` 与结果 `{ title, seq }` 取自
       `@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js`；标题过长时目标机的
       title 服务会自己截断（`truncateTitleUtf8`），所以**真机回声的 `title` 可能比我们送的短**——
       响应里的 `title` 用的是回声值。
     - 降级路线（`workspaceFallback:true`）在真机上**不会**再复现用户报的那个 bug：
       不传工作区时新会话仍然落在目标机进程目录（`desktop` profile 目录）。
       真机上一旦看到 `workspaceFallback:true`，说明 `initializeDefault` 在那台机器上不可用
       （老版本 / 没有 `workspaceController` / 首次使用不合格），这时"落点不对"是**已知**的。
  3. **`throughSeq` 用 `projections.asOfSeq`**：这在源码里是自洽的（`page()` 从 `throughSeq+1`
     往回走），但"asOfSeq 恰好等于最新事件 seq"只在代码里核对过，没有真机实验。
  4. **`assistant/message` 的文本只在 `data.message.content` 里取**：流式还没落地的 chunk
     （`data.stream`）**没有被拼进去**，所以"最后半句正在生成的话"可能带不过去。
     这是刻意的（宁可少带，也不把没定型的内容当上下文）。
  5. **`requestId` 用的是 `dsh-remote-<n>`**（满足 descriptor 的字符串约束）。
     如果目标机的 prompt 准入对 `requestId` 有额外格式要求，这里会在 `502 {stage:"prompt"}` 露出来。
  6. **另存为的输入与两条路（2026-10-13 改法）**：
     - `absolutePath`（ownerProp）与 `sessionId`（会话作用域标准 props）**都是按源码确证的**
       （documentpreview 的 `fileOwner = { absolutePath }` + 两处 `renderSlot(...)`；catalog 的
       `standardProps` 含 `sessionId`），但**没有在真实窗口里点过一次这个按钮**：
       "点下去真的下载到字节"只有宿主半那两条路各自的自测（H2b 本机 / H3 代理）与客户端半的
       URL 断言，**不是真机端到端**。
     - **`device` 为空 = 本机读取这条新路**（"浏览器打开另一台机器的 DSH 页面"那个场景）：
       代码走的是官方 `workspaceFiles` 服务 + 官方 `typert.lookups` 的 `workspaceFileScope`
       （出处见 8-5-2-2），自测里用**假的本机服务**验证了"取到字节 + 一个字节都不出网 + 每次
       都传 `AbortSignal` + 会话不可见 → 404"。**没有在真机上让浏览器打开过一台远端 DSH 页面
       点这个按钮**：所以"官方那套进程内调用在真实组合里一定拿得到 `workspaceFiles`/`typert`"、
       "`requestRejection` 在真实浏览器导航（`Host` 是那台机器的地址、无 `Origin`、
       `sec-fetch-site: same-origin`）下一定放行"这两条**都还没在真机上验证过**。
       若宿主没有 `workspaceFiles` 服务，本机那条路会**明确 403**（不会偷偷直接读磁盘）；
       若官方判定拒绝，会 403 并把官方那个码（401/403）写进正文。
     - **权限范围**：本机那条路与"读目标机文件"用的是**同一个服务**，所以两者的可读范围一致
       （官方对文件读取不做"必须落在工作区内"的检查，只要求会话授权 + 文件系统后端可读；
       见 8-5-2-2 末尾那段）。**"能读到哪些文件"这件事没有在真机上逐项核对过**。
     - `absolutePath` 在**桌面 App 切了远端**时是**目标机视角**的绝对路径（页面切到远程设备后
       `api/` 流量被垫片改道，资源元数据来自那台机器）；宿主半的 `download` 路由两种路径都收
       （"工作区相对路径或绝对路径"），但**"绝对路径在目标机上一定落在该 session 的
       工作区授权范围里"没有真机验证过**。若目标机拒绝，`stat` 会回
       `workspace-file/not-found`（404 + 中文说明）。
     - **旧办法（解析 `dsh-resource://file/session/<sid>/<path>`）已删除**：那个地址是
       `tab.contentId`，而新插槽的 props 里**没有** `tab`。`parseFileAddress` 与两个资源前缀常量
       都从 `lib/client.js` 里移除了（`dsh-resource://` 不再出现在客户端半）。
     - 因此 `dsh-resource://file/absolute/…` 这类**没有会话**的文件也不再是死路：只要槽位给了
       `sessionId`（当前会话），另存为就能发起（这是挂载点换成"预览头部"后顺带修好的）。
     - **删掉了"当前设备"判断**：客户端半不再读 `localStorage` 来决定"要不要下载"
       （只把它当可选的 `device` 参数），宿主半 `device` 为空时也不查设备表。
       **"浏览器里 `localStorage` 是空的"这件事本身没有在真机浏览器里复现过**
       （它是用户实测报的现象；自测里用"不写那个键的沙箱"等价复现）。
  7. **下载没有断点续传 / 没有校验和**：中途失败会中断连接（浏览器里表现为下载失败），
     已写入的字节作废；不支持 Range 续传。
  8. **`alert` 依赖桌面壳**：另存为/分叉的结果提示都用 `alert`（桌面壳支持）；若某个环境里
     `alert` 不可用会退到 `console.warn`（用户可能看不到提示，宿主半的体检里仍有记录）。
     另存为现在是**标题栏按钮**（不再是"点完随菜单卸载"的菜单行），但提示仍然只用 `alert`，
     没有做行内 toast。
  9. **挂载点与渲染 props**：
     - 另存为：`sidebar.right.tab.document.actions` 的 ownerProps（`{ absolutePath }`）
       与"只在有 Host 路径时才渲染该槽位"来自
       `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`（`fileOwner` 一行 +
       两处 `renderSlot`）；`sessionId` 来自 catalog 的 `standardProps` 与 ui-slots README
       的"会话标准工具包"表述。**没有在真实窗口里点过**（见第 6 条）。
     - 分叉：会话菜单的 `{ sessionId, displayTitle }` 与 `useMenuOpenState` 是
       `dsh-client-ui-workspace/lib/client.js` 里 `renderSlot(...)` 的实参。**没有在真实窗口里点过**。
       `displayTitle` 目前只在自测里按这个形状喂进去过；真机上它**是不是恰好等于侧栏显示的那个标题**
       （自动标题 / 改名后的标题）没验证过——本版只是原样转发，不做二次加工。
     - 设备名的加重样式（`fontWeight: 600` 的 `span`）只在假 React 树里断言过结构；
       真机上的**观感**（跟内置行的文字对比够不够明显）没有在窗口里看过。
  10. **第一条 `stat` 与后续 `readBytes` 之间没有版本一致性检查**：目标机上文件在下载过程中
      被改写，会得到"前旧后新"的字节（README 里 workspace-files 自己也写了"读取不具备事务性"）。
  11. **鉴权换成官方的"可信请求"判定（2026-10-13 改动，用户实测驱动）**：
      - 判定**只有一处**：`ctx.connection.requestRejection(req)`（出处见 8-5-2-1）。
        自测里用的是**假的**判定（缺省放行 / 按 `Host` 决定 403），**没有在真机上让真实浏览器
        走过一遍这条判定**：所以"真实浏览器导航到 `GET /plugin/remote/download` 时官方判定
        确实返回 `undefined`"这一步是**按官方源码与文档推断的**，不是实测。
        若它返回 401/403，用户会看到 403 + 一段写明官方码的中文说明（不会静默失败）。
      - 本插件把 401 也折成 **403**（官方原样回 401）：这是刻意的（客户端只看"能不能下载"），
        官方那个码写在正文里。**"会不会有别的消费者依赖那个 401"没考虑过**（这条路由是插件私有的）。
      - `requestRejection` 不存在（老 DSH）时**拒绝**而不是放行：那种机器上"浏览器打开远端页面"
        仍然下载不了，但会给出明确原因。这是安全默认。
      - **只有 `GET /plugin/remote/download` 这一条路由**放开了"仅回环"（`isDownloadRequestUrl`
        精确匹配那个 path）；其余全部路由（`state`/`urls`/`devices`/`test`/`enabled`/`hello`/
        `access`/`fork`）**行为一字未变** —— 非回环仍然是 `403 loopback only`，selftest 里都有断言。
      - 本机那条路（`device` 为空）**要求 `workspaceFiles` + `typert` 两个服务都在**，
        否则 `403` + 明确说明：**绝不绕过官方服务直接读磁盘**。

---

## 9. 配置（profile 里那一节可以完全是空的）

```yaml
# profile 的 cordis.patch.yml
- id: '@local/dsh-remote'
  config: {}          # 通常不需要任何配置；设备与 enabled 都在 $DSH_HOME/remote-devices.json
```

可选字段：

| 字段 | 含义 |
|---|---|
| `publicBase` | 体检页"带 token 地址"里额外列出的公网/中转入口（如 `http://203.0.113.10:39001`）。 |
| `dataFile` | 覆盖数据文件路径（自测/特殊部署用；默认 `$DSH_HOME/remote-devices.json`）。 |
| `devices` / `current` | **只作为数据文件不存在时的一次性种子**（从 device-switch 迁移用）。 |

宿主半的 `inject` 是 `["webServer", "connection"]`；`credentials` 与 `configEditor` 是**可选**依赖，
用 `ctx.inject([...], cb)` 拿（缺了不报错，只退化 + 在体检 notes 里说明）。

---

## 10. 自测（实测输出，可复现）

```powershell
$node = "C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
Set-Location "C:\Users\<user>\Documents\deepseek-harness\default-workspace\_ops\plugin\dsh-remote"
& $node selftest.mjs          # 宿主半：退出码 0 = 全通过（本轮 716/716）
& $node selftest-client.mjs   # 客户端半：退出码 0 = 全通过（本轮 95/95）
```

不安装插件、不改 `C:\Users\<user>\.dsh`、不改 app.asar、不重启任何东西：假 ctx（实现
`register/registerUpgrade/tapIndex/collectIndexInjections/effect/on/inject`，匹配规则照抄
`dsh-host-webserver`：exact 优先、前缀最长、`pathname === prefix || startsWith(prefix + "/")`）、
真 `node:http` 假本机服务、复刻栅栏/token 兑换/流式/WS 的**假远端 DSH**
（本版还复刻了 Connection 的**一元 Remote RPC**：`POST /api/<namespace>/<method>` 的
`client-request` 信封校验、`workspaceFiles/stat|readBytes` 按窗口切片并回 **multipart**
（metadata + `bytes-0`，字节位置是 `null` 占位）、`session/create|prompt|rename` 与
`workspace/initializeDefault` 的入参校验（**照 descriptor 严格校验**：rename 的参数恰好一个
`request` 且键恰好是 `sessionId`+`title`；initializeDefault 的 args 必须是空对象），
还有一个能当"本机"用的 `/api/session/projections|page` facade）、
一台指向**真实本机 DSH `127.0.0.1:19387`** 的设备、node:vm 里的垫片沙箱
（假 DOM/localStorage/**sessionStorage**/location/fetch/WebSocket/XHR，
假 fetch 会按 `stateStatus`/`stateBody` 回 `/plugin/remote/state`，供自检用例），
以及一个假的本机 HTTP 用来提供"client bundle"。
设备表全部落在**临时目录**的数据文件里（`config.dataFile`），跑完删掉。

### 10.1 覆盖了什么

| 组 | 内容 | 条数 |
|---|---|---|
| T | package.json 清单自洽（name/version/exports/dsh）、数据文件一次性种子、路由形状 | 19 |
| A / A2 | **I1**：HTML 透传拦截（content-type 与响应体嗅探两道）+ 日志 | 13 |
| B / B2 / E1 | API 透传、Host/Origin 改写、token 兑换、宿主 cookie jar、cookie 隔离 | 12 |
| E2–E7 | 流式不缓冲、真实本机 401、不可达 502、302 补斜杠、**WebSocket 升级逐字节透传**、头改写 | 25 |
| C / C2 / C3 | **I2**：两条注入通道只追加、去重、空配置惰性 + **force-active 的注入文本断言 + 跨半键名/顺序对账** | 33 |
| **C4** | **新增**：垫片自检（`enabled:false` / 404 才自除；清键 → 摘胶囊 → 还原原语 → 带哨兵刷新一次；哨兵不刷第二次；`enabled:true` 清哨兵；**force-active 强制激活 / 惰性自愈 / 写不进就不刷**；探测失败要安静） | 23 |
| D1–D6 | 垫片沙箱单测：改写、幂等、桌面形态、胶囊切换、键覆盖、**报到** | 44 |
| F1–F4 | 本机自验证（auto/config/none）+ 标签动态化 + 跨平台端口细节 | 27 |
| **G1–G10d** | **新增**：状态接口形状、urls、边界（非回环 403/405/404）、设备增删改与错误分支、连通性测试、hello、**`enabled` 软开关**（路由受门控、注入不受门控、`/state`+`/urls` 仍可读）、数据文件热重载、坏数据文件、mux 发现成功/失败、I1 推广、**访问配置可写（G10d：`POST /access` 成功写两行且保留其它字段 / 校验 21 条拒绝（含**网段 CIDR**与**通配符**，各带专门原因）/ 503 / 500 / 409 / 非回环 403 / `localAddresses` / 官方规范形式判定）**、凭据缺失退化 | 252 |
| **H0–H9** | **本版新增**：另存为/分叉的纯函数（basename / RFC 5987 / multipart / 种子文本）；两条路由的**方法 405**、**`enabled=false` 时不可用**；**鉴权**（另存为：官方"可信请求"判定拒绝 401/403 → 403 text/plain、没有 `requestRejection` → 403、Host 不可信 → 403、可信 → 200；fork 仍仅回环 403；其余路由仅回环不变）；download 的参数校验（path/session 的缺/NUL/超长、非法 id、未知设备、本机设备；**device 为空不再算参数错误**）；**本机分支（H2b）**：`device=` 空/缺失 → 用假的本机 `workspaceFiles`+`typert` 读 1 200 000 字节并逐字节相等、3 个 512 KiB 窗口、`Content-Length`/`Content-Disposition`、**一个字节都不出网**、scope 来自官方 lookup、每次都带 `AbortSignal`、会话不可见/找不到/目录 → 404/404/400、没有服务 → 403；**代理分支（H3）**：真字节下载（1 200 000 字节逐字节相等 + 3 个 512 KiB 窗口 + `Content-Length` + `Content-Disposition`/RFC 5987 中文名 + 目录/找不到/session 不存在/不可达/401 各一条）；fork 的请求体校验与全部失败分支（不可达 / 401 / 创建失败 / 空会话 / 目标是本机）；**进程内 `ctx.sessionController` 与 HTTP 回退两条路线**；**分叉的顺序与落点（H5b）**：`initializeDefault → create(workspaceId) → rename → prompt` 四步顺序、`session/create` 的 args 带目标机默认工作区 id、`session/rename` 的 args `{request:{sessionId,title}}` 与 title 严格等于「<源标题> - 来自<本机名>」、源标题缺失/空串/纯空白/非字符串四种情况下兜底成「未命名会话 - 来自设备A」、rename 失败仍 `ok:true` 且带 `renameError`、`initializeDefault` 返回 `undefined` 与报错两种降级都 `workspaceFallback:true` 且照常建会话改名发种子；体检 saveAs/fork 字段与 notes | 239 |

**device-switch 原有 150 条断言全部保留**（其中 7 个只改了文案/位置，例如"设备表来自宿主配置"→
"来自宿主数据文件"、"没有注册任何 HTTP 路由"→"没有注册任何 `/dev/**` 路由"、"配置兜底"→
"回退数据文件的 current"）。合计 **716 条**，本轮实测 **716/716 通过、退出码 0**
（2026-10-13：0.7.1 那轮 687 条 → 0.8.0 的 705 条（分叉条数那组）→ **0.8.1 的 716 条，净增 11 条**，加的是 G11「会话 cookie 落盘 + 重启后不重复兑换 + 退化路线落文件」与 G12「远端 401 → 丢会话 + 自动重兑」；更早的 626 → 687 是「配置」块那一轮，新的一组写了 **63 条**，
只删掉 2 条**基于旧模型**的断言 ——「`POST /plugin/remote/access` → 404（只读路线）」与
「notes 里写明只读路线」；它们被下面那一整组"可写路线"的断言取代。
另外 `access` 的字段集合断言加上了 `localAddresses`，"恒为 false 的 writable"改成按
config-editor 是否可用判断。）

**G10d「配置」块 / `POST /plugin/remote/access`**（本轮新增的一组，57 条）：成功写入时
`connection` 先、`webserver` 后，且 **`webserver` 的 compression 三件套与 `connection` 的
cookieMaxAgeDays 一个都没丢**（整行 config 替换语义下最容易丢的东西）；`host` 被固定写成 `0.0.0.0`；
入口地址去空白/去重后写入；**重复保存同样的值一行都不重写**；用一个"每次 edit 之后把 entries
换成新对象、并照官方语义对旧对象抛错"的假 config-editor 钉住**"第二笔必须重新取 entry"**；
21 条拒绝用例（端口 0/65536/非数/小数/带空白/null、trustedHosts 非数组/空数组/全空行/含非字符串/
带协议前缀/带路径/带用户名/中间有空格/补零端口/0x 写法/**网段 CIDR**/**通配符 `192.0.2.*.*`**/
**`192.0.2.4/32`**/超 200 条/两个字段都没有）一律 `400` 且**一行都没写**，
其中「网段」「通配符」「协议前缀」三种还各有一条**专门的中文原因**断言
（`192.0.2.*.*` 官方会静默收下但匹配是 hostname 全等 → 永远不匹配，是个静默陷阱，所以在写盘前拒掉）；
只给 `trustedHosts` 时只写一行；没有 config-editor / 形状不认识 / 找不到 `webserver` 行
→ `503`；`edit()` 抛错 → `500`（并如实区分"两行都没写"与"入口地址已写入、端口没写"）；
停用时 `409`；非回环 `403`；`localAddresses` 形状（回环在前、每条带当前端口、没有 `0.0.0.0`）；
以及 `canonicalTrustedAuthority` 与官方 `assertTrustedAuthority` 同口径的单测。

客户端半 `selftest-client.mjs`：**84 项断言（本轮 84/84 通过、退出码 0）**。0.9.1 把「配置」块精简成三格（端口 / cookie 天数 / 分叉条数），随之删掉入口地址相关的旧断言与为 edge 写的那 3 条 —— 数字从 95 降到 84 是"功能删了、断言跟着删"。

- **2026-10-13 这一版（新增设置页「配置」块）** 改了/加了这些断言：
  ① 块标题从 4 块变 5 块（`插件开关 / 本机地址 / 设备管理 / 配置 / 体检`），骨架与"接口全挂"两条都跟着改；
  ② 删掉「本机地址」块里那个**只读的 `access` 展示盒**（它会把绑定地址显示出来，与"界面不显示"冲突），
  对应的旧断言换成"展开后只有地址行 + 本机进程 + 仅本机可读说明，且不再出现「访问设置」"；
  ③ 新增 12 条「配置」块断言：永远显示、端口/入口地址预填、「填入本机地址」（含**跟随输入框里的端口**）、
  保存的 POST 体（换行→数组、去空行、去首尾空白、`port` 是数字、**不带 `host`**）、
  成功文案逐字等于「已写入配置，重启 DSH 生效」且**不含断开/断线/掉线/外网**这类词、
  失败只显示宿主原因不显示成功、本地校验（端口非法 / 入口地址为空）**不发请求**、
  请求期间按钮置灰且文案变「保存中…」、`writable:false` 时给说明但不隐藏表单、
  以及一组源码断言（`ACCESS_ROUTE`、`data-dsh-remote="access-save"`、渲染代码里**没有 `0.0.0.0`**）；
  ④ **0.8.0 追加 5 条**（分叉条数：预填 / 改成 35 带上 / 不合法只给中文提示且不发请求 / 留空不带该字段 / 老宿主半空框不猜值）；**0.7.1 追加 1 条**：字段名是「**入口地址（本地）**」、页面写明「填的是本机自己的地址」与
  「**删掉一条不等于不再监听**」，且**旧名「信任地址」在界面与源码（含注释）里一个都不许留**。

- **2026-10-13 这一版**（挂载点换到文档预览头部按钮区 + 设备名加重）改了/加了这些断言：
  ① 槽名断言改成 `sidebar.right.tab.document.actions`，并**显式断言旧槽
  `sidebar.right.tab.menu.item` 已不再注册**（运行时按槽名取不到 + 源码里 `ctx.slots.inject(...)`
  与 `name: "..."` 两处都不再出现）；
  ② 「另存为…」**永远显示**（本机 / 没有 `absolutePath` / 没有 `sessionId` / 连 props 都没有时
  都渲染出按钮），点击后按 **路径 → 会话** 的顺序各给一条明确提示且**不跳转**；
  参数齐全时 `location.assign` 的 URL **逐字断言**（整条 Windows 绝对路径 + 中文名的
  `encodeURIComponent` 编码）；
  ③ 分叉行里**设备名是加重节点**（`<span style="font-weight:600">`，文字正好是设备名，
  且"分叉到 "仍是普通文字节点），双设备时两行都能识别出「分叉到 <设备名>」；
  ④ 官方组件分支也断言了：另存为用 `Button` 的 `toolbar` 变体 + `size:"sm"` +
  `IconDownloadOutlineRegular` + `title`（**不是** `MenuItemButton`），分叉行用
  `MenuItemButton`（`role="menuitem"`、带 `IconBranchOutlineRegular` 图标）。
- **2026-10-13 这一版（鉴权与本机读取改为"页面由哪台机器提供，文件就在哪台机器上"）**：
  ① 「另存为…」在**没有设备切换键**（= 浏览器打开另一台机器的页面）时**照样发起下载**，
  URL 里 `device=` 为空、且**不弹任何"当前是「本机」"的拦截提示**（URL 逐字断言）；
  ② 提示里**不再出现"本机"这个设备判断**（缺路径时第一条提示是「拿不到文件路径」）；
  ③ **源码级反回归断言**：`SaveAsAction` 那段里不许再出现 `当前是「本机」` 或
  `deviceId === ""` 的提前 return（防止这条错逻辑被改回来）；
  ④ 有切换键时 URL 带 `device=<id>`（原断言保留）；设备表里没有这台设备时**也照样下载**
  （客户端半不查设备表）；session id 里的 `/`、`?`、空格照样 URL 编码；
  ⑤ 缺路径 / 缺 session 仍是明确提示且不跳转，且缺 session 的提示里**不再提"目标机"**
  （本机与目标机现在是同一套按 session 授权）。
- 为此在 harness 里补了两处**测试替身**（只影响自测，不进产物）：
  一份有 `Button`/`MenuItemButton`/图标的假 `ui-primitives`（`createSandbox({primitives:true})`，
  用来覆盖"官方组件分支"），以及让假 React 把子节点也挂到 `props.children`
  （React 语义；否则假 `Button` 拿不到 children）。另外按钮文字比对改成**归一化空白**
  （设备名是独立节点，`collectText` 会在节点之间插 `\n`）。
- 上一轮加的那批（仍在）：两个槽位都注册且 `order:900`、「分叉到…」无远程设备时隐藏 /
  有设备时列出（排除本机）、点设备后 `POST /plugin/remote/fork` 的请求体
  （`targetDeviceId`/`sourceSessionId`/**`sourceTitle`=ownerProps.displayTitle**；**0.8.0 起不带 `tailN`**）与成功提示、
  **`displayTitle` 缺失 / 空串 / 数字 / null 四种情况下 `sourceTitle` 送空串**（由宿主半兜底，
  客户端半不自己编标题）、失败提示不崩、拿不到 `sessionId` 时不发请求、设备表读失败时仍显示该项并给错误。

### 10.2 关键输出（本轮实测，节选）

```
插件名: dsh-remote / inject: ["webServer","connection"]
数据文件（本次临时目录）: C:\Users\<user>\AppData\Local\Temp\dsh-remote-selftest-ZJhBfY

=== T0 package.json：name/version/exports/dsh 声明与宿主半常量一致 ===
  PASS  package.json name 与 lib/index.js 的插件名一致  — @local/dsh-remote / dsh-remote
  PASS  internals.VERSION 与 package.json 的 version 一致（两处漂移会让体检页说谎）  — 0.3.0 vs 0.3.0
  PASS  exports 含 "."、"./client"（指向 lib/client.js）与 "./package.json"
  PASS  dsh 声明：bundle.patch 指向本包 patch、client.platform === "web"

=== C（I2）注入通道：只追加一条 script 行，不含 <base / __DSH_TRANSPORT__ / index 改写 ===
  PASS  注入文本含垫片**自检**（问 /state：诚实取 JSON + same-origin + no-store）
  PASS  自检只认 `enabled === false`（严格比较，不认 falsy / 缺字段）与 HTTP 404（插件已卸载）
  PASS  自检的自除按下述顺序：清键 → 摘胶囊 → 还原原语 → 带哨兵刷新  — function softOff() { try { clearStoredSelection(); removePill(); restorePrimitives(); …
  PASS  清键确有四个键（主键 + 别名：current/devices 都清）
  PASS  哨兵：用 sessionStorage + 固定键名，且 `reloadOnce` 里先查哨兵再写
  PASS  `enabled:true` 时清掉哨兵（否则关停一次之后就再也刷不动了）
  PASS  注入文本含「强制激活」标记键（与客户端半同一个键名，走 sessionStorage）
  PASS  客户端半：键名与宿主半逐字一致，且顺序是「清哨兵 → 置 force-active → reloadPage」
  PASS  同步判定：force-active 存在 → 走正常模式（忽略 payload.enabled 与哨兵），用掉即删  — var forcedActive = readForceActive(); var lazy = forcedActive !== true && (hostEnabled !== true || readSentinel() !== ""); …
  PASS  惰性自愈：写 force-active → 清哨兵 → reloadOnce（顺序不许换），写不进标记就绝不刷新  — function healLazy() { if (!writeForceActive(true)) return false; writeSentinel(""); return reloadOnce(); }
  PASS  惰性自愈只在「本次惰性」时触发（live enabled:true + lazy）
  PASS  还原原语靠 __dshRemoteOriginal（fetch / WebSocket / XHR.open 三处都留了）

=== C4 垫片自检：拿到 enabled:false / 404 才自除（清键 → 摘胶囊 → 还原原语 → 带哨兵刷新一次） ===
  PASS  注入时 enabled:false → 不同步 patch（fetch/WebSocket/XHR 都还是原函数）
  PASS  注入时 enabled:false → 也不挂胶囊
  PASS  注入时 enabled:false → 仍然问一次 /state（老窗口靠它自除）
  PASS  前置条件：老窗口的垫片确实同步 patch 了 fetch 并挂出了胶囊
  PASS  自检拿到 enabled:false → 胶囊被摘掉
  PASS  自检拿到 enabled:false → 被改写的三个原语都还原了
  PASS  自检拿到 enabled:false → 清掉 localStorage 的 current/devices（主键 + 别名四个键全没）  — ["dsh-remote:soft-off"]
  PASS  自检拿到 enabled:false → 带哨兵刷新了页面一次（哨兵写进 sessionStorage）  — reloads=1 sentinel=1
  PASS  摘胶囊是 removeChild（真的从 DOM 上摘掉了，不是只藏起来）
  PASS  哨兵在位 → 同步阶段就当没装：不 patch、不挂胶囊、不刷新
  PASS  哨兵在位 + 自检又拿到 enabled:false → 绝不刷新第二次（防循环）  — 0
  PASS  404 = 插件已被卸载 → 一样自除（清键 + 摘胶囊 + 还原 + 刷新一次）  — reloads=1
  PASS  前置条件：哨兵在位时同步阶段不 patch、不挂胶囊（= 错过挂载时机，胶囊得靠下一次加载）
  PASS  惰性自愈：live enabled:true 且本次惰性 → 置 force-active 并刷新一次  — force-active=1 reloads=1
  PASS  惰性自愈后哨兵仍在位（reloadOnce 重新武装 = 防循环的第二道）  — 1
  PASS  自愈后的下一次加载：force-active 让哨兵失效 → 同步 patch + 挂胶囊，且不再刷新  — reloads=0
  PASS  force-active 用掉即删（只强制激活一次，不留残留）
  PASS  落地后 live enabled:true 且不再惰性 → 只清哨兵、不刷新（全程总共只刷了 1 次）  — reloads=0 sentinel=undefined
  PASS  force-active 存在 → 忽略 payload.enabled:false 与哨兵：patch + 挂胶囊 + 删标记  — fetch=true ws=true xhr=/dev/home/api/sessions pill=true marker=undefined
  PASS  强制激活落地后 live enabled:true → 不刷新，只把哨兵清掉  — reloads=0
  PASS  惰性自愈写不进 force-active → 绝不刷新（降级为手动重载，避免每次加载都刷成死循环）  — reloads=0
  PASS  非惰性的正常窗口 + enabled:true → 不刷新、不写 force-active（自愈不越权）  — reloads=0
  PASS  自检请求被拒（网络失败）→ 安静：不清键、不摘胶囊、不刷新  — reloads=0

=== G1 GET /plugin/remote/state：字段与形状（契约冻结） ===
  PASS  顶层字段集合正好是契约里那 6 个（顺序无关）
  PASS  devices 是 4 台，且每台正好是契约里那 7 个字段
  PASS  diagnostics.proxyRoutes = 注册的 /dev/** 路由数（4 台 × (HTTP + upgrade) = 8）  — 8

=== G6 POST /plugin/remote/hello：只记时间、不接受任何 body ===
  PASS  无 body 的 POST → {ok:true}
  PASS  报到之后 injectionSeen=true 且 lastHelloAt 是 ISO 时间
  PASS  带 body 的 hello → 400 且**不**当报到（"不接受任何 body"）

=== G7 POST /plugin/remote/enabled：软开关（路由受门控、注入不受门控、设置页仍可读） ===
  [plugin info] [dsh-remote] 已停用：/dev/** 路由全部撤掉；垫片脚本仍然注入（老窗口里的胶囊由它自检后自除并刷新一次），设置页接口仍然可读
  PASS  POST enabled(false) → {ok:true, enabled:false}  — {"ok":true,"enabled":false}
  PASS  enabled=false 时**不注册任何 /dev/** 路由**（HTTP 与 upgrade 都没了）  — prefixes= upgrades=
  PASS  enabled=false 时 /dev/self/api/x 落到 fallback（404，插件完全不拦）
  PASS  enabled=false 也写进了数据文件（重启后仍然停用）
  PASS  enabled=false 时**注入行仍然存在**（tapIndex 那条通道还在）  — taps=1
  PASS  enabled=false 时 index-inject 仍然推一行 script（桌面壳那条通道也还在）  — ["script/head"]
  PASS  停用时注入的脚本里 enabled=false（垫片据此不同步 patch、不挂胶囊）  — })({"devices":[{"id":"self",…
  PASS  停用时注入的脚本仍带自检（statePath + 清键 + 摘胶囊 + 哨兵刷新）
  PASS  停用时 /dev/** 路由数与升级路由数都是 0（注入与路由是两件事）
  PASS  停用时 GET /state 仍然 200：enabled=false、proxyRoutes=0  — status=200 enabled=false routes=0
  PASS  停用时 notes 写明「路由撤了但垫片照旧注入、会自除」  — ["插件已停用（enabled=false）：…","软开关：停用只停止代理与注入；要彻底关停（连垫片脚本一起没有）请卸载本插件 —— …"]
  PASS  停用时 GET /urls 仍然 200（带 token 的地址还能查）
  PASS  停用后 diagnostics.injectionSeen 的历史仍然保留（停用不会抹掉「报到过」这件事）
  PASS  改回 true → {ok:true, enabled:true} 且路由/注入立刻回来（不用重启）  — prefixes=4 upgrades=4 taps=1
  PASS  改回 true 后注入的脚本里 enabled=true 且设备表回来了
  PASS  恢复后代理立刻可用

=== G8 手改数据文件（enabled=false）→ 1 秒内活着生效（不用重启） ===
  PASS  手改的 enabled=false 生效
  PASS  手改删掉的设备也生效（/dev/ws 路由没了）

=== G9 REMOTE_STREAM_MUX_PATH 的动态提取：从本机 client bundle 里读，不硬编码 ===
  PASS  提取器认得真源码里那一行（夹具逐字抄自 @deepseek-ai/dsh-api-gateway/lib/client.js）
  PASS  发现失败：**一条 upgrade 路由都不注册**（终端通道标记为不可用）
  PASS  发现失败：HTTP 代理路由照常注册（对话/代理仍可用）

=== G10c 凭据服务缺席 → 退化到数据文件，并明确标注 token 明文存储 ===
  PASS  没有凭据服务时 token 落到数据文件的 tokens 字段（明文）  — ["enabled","devices","tokens"]
  PASS  退化路线的体检 notes 明确写「token 明文存储」并给出文件路径

=== H1 两条新路由的鉴权：另存为走官方「可信请求」判定（不是仅回环），分叉仍然只认回环 ===
  PASS  另存为：官方判定拒绝（403）→ 403 text/plain 且写明原因与官方的码  — "dsh-remote：另存为被拒绝 —— 官方判定 403 forbidden：Host/Origin 栅栏没过…"
  PASS  另存为：官方判定拒绝（401）→ 403 text/plain 且写明原因与官方的码  — "…官方判定 401 unauthorized：Host/Origin 栅栏过了，但这条请求没有带有效的浏览器会话 cookie（dsh-auth-*）…"
  PASS  另存为：宿主没有 connection.requestRejection → 403 且写明「没有提供官方判定」（降级为拒绝，不是放行）
  PASS  另存为：官方判定可信（Host 合法）→ 放行并读到字节 200（不再看是不是回环来源）  — status=200
  PASS  另存为：官方判定不可信（Host 不在 trustedHosts）→ 403 text/plain（DNS rebinding 那类请求被挡）  — status=403
  PASS  路由形状：只有 /plugin/remote/download 这一条不受「仅回环」守卫约束  — 见 isDownloadRequestUrl
  PASS  非回环 POST /fork → 403 text/plain（fork 是写操作，仍然只认回环；回环 IPv6 映射形式也一律拒）  — 403
  PASS  非回环 GET /state 仍然 403 loopback only（设置页没有被这次改动放开）  — status=403 body="loopback only\n"

=== H2 GET /plugin/remote/download：参数校验（400 一律 text/plain，且都不是 HTML） ===
  PASS  download 参数校验：非法 device id → 400 且写明原因
  PASS  download 参数校验：未知设备 → 400 且写明原因
  PASS  download 参数校验：缺 path → 400 且写明原因  — "…缺少 path 参数（工作区相对路径或绝对路径）。"
  PASS  download 参数校验：path 含 NUL → 400 且写明原因
  PASS  download 参数校验：path 过长 → 400 且写明原因
  PASS  download 参数校验：缺 session → 400 且写明原因  — "…文件读取按 session 授权（官方 workspaceFiles 的 lookup workspaceFileScope）…"
  PASS  download 参数校验：session 过长 → 400 且写明原因
  PASS  download 参数校验：device 空 + 缺 path（本机分支也要校验 path） → 400 且写明原因
  PASS  download 参数校验：device 空 + path 含 NUL → 400 且写明原因
  PASS  download 参数校验：device 空 + 缺 session → 400 且写明原因
  PASS  download：device 指向被认领为本机的那台 → 400（设备有值时仍然走代理，那条老规矩没变）

=== H2b GET /plugin/remote/download（device 为空 = 本机文件）：读本机 workspaceFiles、不发任何远端请求 ===
  PASS  本机分支：device= 空 → 200 且字节逐字节取到（1.2 MB 本机文件，不是占位/错误页）  — status=200 收到 1200000 字节
  PASS  本机分支：Content-Length 来自本机 workspaceFiles 的 stat（不是我们猜的）  — 1200000
  PASS  本机分支：Content-Disposition 沿用同一套（ASCII 回退 + RFC 5987 中文名）
  PASS  本机分支：**一个字节都没有走远端**（没打目标机、也没有远端 readBytes）  — stub.requests +0，stub readBytes +0
  PASS  本机分支：走的是官方 typert.lookups 的 workspaceFileScope（session → {sessionId, workspaceRoot}）  — ["sess-local"]
  PASS  本机分支：分块流式（1.2 MB → 3 个 512 KiB 窗口，offset 依次推进），不是一次读进内存
  PASS  本机分支：每次调用都带了 AbortSignal（官方 @Remote 包装会直接解引用它）  — []
  PASS  本机分支：服务名/lookup 键名与官方契约一致（workspaceFiles / typert / workspaceFileScope）
  PASS  本机分支：**完全没有 device 参数**也当本机（缺失与空值等价）  — status=200 body="本机小文件\n"
  PASS  本机分支的成功进体检（saveAs.lastOkAt 有值、lastError 为空）
  PASS  本机分支：会话不存在/不可见 → 404 且写明「本机上找不到这个 session」（授权范围来自会话）  — status=404
  PASS  本机分支：本机上找不到文件 → 404 且写明「本机上找不到这个文件」  — status=404
  PASS  本机分支：路径是目录 → 400 且写明「本机上这个路径不是普通文件」  — status=400
  PASS  本机分支：组合里没有 workspaceFiles 服务 → 403 且写明（插件绝不绕过官方服务直接读本机磁盘）  — status=403
  PASS  本机分支的失败也进体检（saveAs.lastError 里写明「本机」）

=== H3 GET /plugin/remote/download：真字节、分块流式、Content-Length / Content-Disposition ===
  PASS  下载状态 200，content-type 是 application/octet-stream + nosniff（不是 text/html）  — status=200 type=application/octet-stream
  PASS  字节真的取到了：1 200 000 字节逐字节相等（不是占位、不是错误页）  — 收到 1200000 字节
  PASS  Content-Length 来自目标机的 stat（不是我们猜的）  — 1200000
  PASS  Content-Disposition：ASCII 回退 + RFC 5987（basename 是 big.bin）  — attachment; filename="big.bin"; filename*=UTF-8''big.bin
  PASS  分块流式：1.2 MB 走了 3 个窗口（512 KiB 一块），offset 依次推进  — [{"offset":0,…},{"offset":524288,…},{"offset":1048576,…}]
  PASS  中文文件名：Content-Disposition 用 RFC 5987 的 filename*（%XX 大写、空格 %20）  — attachment; filename="__ __.md"; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md
  PASS  路径是目录 → 400 text/plain 且写明「不是普通文件」  — status=400
  PASS  目标机不可达 → 502 text/plain + 写明不可达（I1：仍然不是 HTML）  — status=502
  PASS  目标机 401（token 缺失/失效）→ 401 text/plain + 明确提示去补 token（不是 502）  — status=401

=== H5 POST /plugin/remote/fork：HTTP 回退读本机会话 → 目标机建会话 + 改名 + 发种子（落点是目标机默认工作区） ===
  PASS  fork 成功返回 { ok, targetDeviceId, newSessionId }（newSessionId 来自目标机）  — {"ok":true,"targetDeviceId":"self","newSessionId":"new-sess-1","messages":3,"bytes":121,"via":"本机 HTTP /api"}
  PASS  读本机源会话走的是本机 HTTP 的 Remote RPC：session/projections 先拿 asOfSeq  — [{"sessionId":"local-sess"}]
  PASS  再按 asOfSeq 读尾页：address.kind=session / throughSeq=42 / maxMessages=tailN
  PASS  目标机先取默认工作区：POST /api/workspace/initializeDefault，args 是空对象（零参数 descriptor）  — [{}]
  PASS  目标机建会话：POST /api/session/create，args.request 里带**目标机默认工作区的 id**（走 workspaceId，不猜 cwd）  — [{"request":{"workspaceId":"ws-default"}}]
  PASS  目标机改名：POST /api/session/rename，args 恰好 {request:{sessionId,title}}，title 是「未命名会话 - 来自<本机名>」  — title "未命名会话 - 来自HOST-A"
  PASS  种子作为第一条消息发出：session/prompt + mode=queue + 指定 sessionId  — [{"mode":"queue","sessionId":"new-sess-1"}]
  PASS  种子的正文是「role: text」拼出来的上下文（含工具调用的一行摘要）

=== H5b POST /plugin/remote/fork：先取目标机默认工作区 → create(workspaceId) → rename(<源标题> - 来自<本机名>) → prompt ===
  PASS  H5b 前置：设备表里那台 127.0.0.1:19387 被认领为本机（不给它注册 /dev 代理路由），另一台才是分叉目标  — ["/dev/self"]
  PASS  ① 顺序：workspace/initializeDefault → session/create → session/rename → session/prompt（先取默认工作区再建会话）  — ["workspace/initializeDefault","session/create","session/rename","session/prompt"]
  PASS  ①-a workspace/initializeDefault 的 args 是空对象（零参数 descriptor，多一个字段会被 assertExactArguments 拒）  — {}
  PASS  ② session/create 的 args 里带上目标机的默认工作区（workspaceId，不是 cwd —— 抽自 SessionCreateRequest）  — {"request":{"workspaceId":"ws-default"}}
  PASS  ③ session/rename 的 args 是 {request:{sessionId,title}}，title 严格 =「修跨设备分叉 - 来自设备A」  — {"request":{"sessionId":"new-sess-1","title":"修跨设备分叉 - 来自设备A"}}
  PASS  ③-a 响应里带上 title / workspaceId / cwd / workspaceFallback:false / renameError:null（验收看得到目标机实际用的落点）
  PASS  ④ 源标题缺失（body 里没有这个字段） → title =「未命名会话 - 来自设备A」（绝不空标题 / undefined）
  PASS  ④ 源标题空串 → title =「未命名会话 - 来自设备A」（绝不空标题 / undefined）
  PASS  ④ 源标题纯空白 → title =「未命名会话 - 来自设备A」（绝不空标题 / undefined）
  PASS  ④ 源标题不是字符串（数字） → title =「未命名会话 - 来自设备A」（绝不空标题 / undefined）
  PASS  ⑤ rename 失败 → 整个请求仍 ok:true + 带 renameError，且种子照样发出去（会话已建好，不半途而废）
  PASS  ⑤-a rename 失败时响应里的 title 仍是我们要的目标标题（排错用）  — "改名会失败 - 来自设备A"
  PASS  ⑤-b rename 失败写了一条中文 warn 日志（不静默）
  PASS  ⑥ initializeDefault 返回 undefined → 仍建出会话，create 退回不传工作区，响应带 workspaceFallback:true
  PASS  ⑥-a initializeDefault 报错（目标机没这个 endpoint）→ 同样降级：ok:true + workspaceFallback:true + 照常改名发种子
  PASS  ⑥-b 降级时写了中文 warn 日志（写明这次分叉不指定工作区）
  PASS  H5b 收尾：本机源会话一直是走进程内 controller 读的（这一组没注册任何本机 /api 路由）  — {"projections":8,"pages":8}

=== H6 POST /plugin/remote/fork：进程内 ctx.sessionController 优先（不经过 HTTP） ===
  PASS  进程内 controller 可用时直接用它（projections → page），返回 {ok:true,newSessionId}  — via "ctx.sessionController"

=== H7 POST /plugin/remote/fork：请求体校验与失败分支（一律 JSON、绝不是 HTML） ===
  PASS  fork 参数校验：缺 targetDeviceId → 400 {ok:false,error}
  PASS  目标机不可达 → 502 {ok:false, stage:'create', error 写明不可达}
  PASS  目标机 401（token 失效/缺失）→ 401 + 明确提示去补 token

=== H8 软开关：enabled=false 时两条新能力都不可用（设置页/体检仍可读） ===
  PASS  enabled=false：GET /download → 403 text/plain + 写明插件已停用  — status=403
  PASS  enabled=false：POST /fork → 403 {ok:false} + 写明插件已停用
  PASS  改回 enabled=true 后立刻可用（403 停用 → 变成真的下载 200）  — status=200

=== 结果：716/716 通过 ===
全部通过。
```

客户端半（`selftest-client.mjs`，节选）：

```
1. ctx.slots 注册（恰好 1 个 settings.section：远程连接 / order 60）
  ✅ inject 恰好 3 次，槽名是 settings.section + 文档头部按钮区 + 会话菜单
  ✅ 注册了 3 项：1 个 settings.section + 文档头部按钮区 + 会话菜单（原来那三页不再存在）
  ✅ 「另存为…」的挂载点已从 sidebar.right.tab.menu.item 换成 sidebar.right.tab.document.actions
  ✅ label 是「远程连接」，order = 60，id 是非空字符串
3.5 两个新扩展位：另存为…（文档预览头部按钮区）与分叉到…（会话「…」菜单）
  ✅ 两个槽位都注册了：id / order=900（同插槽 open-in-app 之后）/ 组件是函数
  ✅ 「另存为…」在 document.actions 上：**永远显示**（本机 / 没有路径 / 没有会话时都渲染），回退分支是 role=button 的 button
  ✅ 「另存为…」永远显示：没有任何 props（既没路径也没会话）时按钮仍在
  ✅ 「另存为…」用官方 Button（toolbar 变体 + 下载图标 + title），不是菜单行组件
  ✅ 点「另存为…」（**没有**设备切换键 = 浏览器打开另一台机器的页面）：照样发起下载，URL 里 device 为空
  ✅ 点「另存为…」：**不再出现**「当前是「本机」」这类设备判断（提示与代码里都不许有）
  ✅ 点「另存为…」（选中远程设备）→ location.assign 到 /plugin/remote/download?device=…&path=<绝对路径>&session=…（编码断言）
  ✅ 「另存为…」拿不到路径（槽位没给 absolutePath）→ 按钮仍在，点了给明确提示、不跳转
  ✅ 「另存为…」有路径但没有会话信息（槽位没给 sessionId）→ 提示「没有会话信息」、不跳转
  ✅ 「另存为…」有切换键但设备表里没有这台（配置改过）→ 照样下载，device 原样带上（客户端半不查设备表）
  ✅ 「另存为…」session id 里的特殊字符照样 URL 编码（/:? 都不许裸露）
  ✅ 「分叉到…」显示条件：没有任何远程设备（只有本机那台）→ 整项不显示
  ✅ 「分叉到 <设备名>」的双设备用例：设备名是**加重节点**（fontWeight 600 的 span / strong），文案仍能识别出「分叉到 <名字>」
  ✅ 「分叉到 <设备名>」在官方 MenuItemButton 分支里同样把设备名当加重 children 传下去
  ✅ 选一台设备 → POST /plugin/remote/fork（请求体正确，带槽位给的 displayTitle）+ 成功提示「已在 设备B 上创建会话 ab12cd34」
  ✅ 「分叉到…」ownerProps 里没有 displayTitle（或不是字符串）→ sourceTitle 送空串，由宿主半兜底成「未命名会话」
  ✅ 「分叉到…」失败（宿主半回 {ok:false,error}）→ 显示原因，不崩
  ✅ 「分叉到…」拿不到 sessionId（槽位上下文里没有）→ 明确提示，且一个请求都不发
全部通过：84 项断言，0 失败。
```

### 10.3 为什么 WebSocket 测试用裸 TCP 探针

Node 24 自带的 undici `WebSocket` 客户端打不开"合成握手"（**直连也失败**：见 device-switch 仓库里的
`control-undici-websocket.mjs` 控制实验，是那个客户端的失败路径把真实原因盖成了空消息 TypeError），
所以 selftest 用裸 TCP 逐字节核对 101 与首帧是否被原样转发 —— 证据比那个客户端更强。

---

## 11. 已知限制与风险（含**没有验证**的部分）

**没有在真实桌面窗口里跑过**（本轮不允许安装插件、不允许改 profile、不允许重启）。按重要性：

1. **`REMOTE_STREAM_MUX_PATH` 的真机提取没有端到端验证。** 自测里"本机 client bundle"是我用
   `node:http` 搭的替身（同样的 URL 形状 `plugins/??<id>/client.js&rev=…`、同样的常量行）。
   真机上第一手来源是 `ctx.webServer.collectIndexInjections()`（`@deepseek-ai/dsh-client-modules`
   的 `script-preload`/`__DSH_BOOT__` 行），我按源码核对了它的形状（`buildBatch().descriptor.url =
   comboUrl(…).slice(1)`、`graphRow().url = comboReference(…)`）与 `/plugins/**` 路由的匹配规则
   （`/plugins/<id>/client.js?rev=<rev>` 或 `/plugins/??<id>/client.js&rev=<rev>`，精确 URL、无鉴权），
   但**没有**在真机上看到它抽出路径。看体检页的 `muxPathFound` 与 notes 即可判定；失败时只是终端通道不可用。
2. **凭据服务的真机读写没有验证。** 自测用的是假 `ctx.credentials`（按 README 的
   `resolve → {value,source}` / `set` / `unset` 形状复刻）。另外我按源码确认了本地提供方
   **不校验品牌类型**（`set(ref, value)` 只查"是否被启动环境遮蔽"与空值），且我们的 ref 名满足
   `^[A-Za-z_][A-Za-z0-9_]*$`。**没验证**的是：真机上 `set` 会不会因为别的原因被拒（那时设置页会显示
   `保存 token 失败：…`，并退化/保留旧值）。`$DSH_HOME/.credentials.yaml` 已存在，说明提供方确实在本部署里。
3. **`injectionSeen` 只在真实窗口里刷新页面后才有意义**：桌面壳走 IPC 注入，
   `hM()` 对 `script` 行做 `createElement + textContent + append`（会执行）是我从源码读出来的结论，
   没有在真实窗口观察过执行时机。若 `localStorage` 在 `dsh-app://` 下不可写，垫片会安静退化为"惰性"
   （不 patch、不显示胶囊、但也**不会**报错），本机 DSH 不受影响。
4. **`enabled` 软开关的副作用**（0.3.0 改写后）：
   - 关停/启用会 dispose/重建 `/dev/**` 路由。正在进行的请求会正常跑完（dispose 只改路由表），
     但**新的** `/dev/**` 请求在切换瞬间可能落到回退 404 —— 这是可接受的一致性窗口，没有在真机上压力验证过。
   - 关停后页面**会刷新一次**（由垫片自检触发）。刷新前的那个瞬间页面仍按已改写的原语工作；
     刷新后回到本机。这一行为**没有在真实桌面窗口里观察过**（本轮不允许安装/重启）：
     真实证据只有 node:vm 沙箱里的 C4 组断言 + 注入文本的 grep 断言。
   - **哨兵是 per-window 的 `sessionStorage`**：如果某个环境里 `sessionStorage` 不可用，
     自除那条路（`reloadOnce`）会因为读不到哨兵而每次加载都尝试刷新一次 → 在那个环境里表现为
     **反复刷新**。这是刻意选的取舍（宁可多刷一次也不能停用后胶囊赖着不走），但如果真机上出现刷新循环，
     第一件事就是看 `sessionStorage` 是否可写（此时应给 `sessionStorage` 加"可写探测"）。
   - **"开启后一次刷新就回来"依赖 `sessionStorage` 可写**：客户端半清哨兵 / 置 `force-active`
     写不进去时**安静跳过**（开关照常刷新，不会卡住），此时会退化成本轮修复前的行为 ——
     第一次刷新胶囊可能还没回来，要再点一次「重载窗口」；垫片的惰性自愈同理**不刷新**
     （写不进标记就放弃自愈，宁可多要一次手动重载，也不要"每次加载都自愈"的无限刷新）。
   - 停用后**垫片脚本本身仍在页面里**（这是有意的：老窗口里的注入行撤不掉）。要连脚本一起没有，
     只能卸载插件（卸载后 `/plugin/remote/state` 404，垫片照样会自除）。
5. **插件页里那个开关是空操作**（第 4 节）：根因是 profile patch 里多了一条与 bundle patch 重复的
   `insert`，导致插件管理器判 `unaddressable`。**修法需要动 `C:\Users\<user>\.dsh`**，本轮没动。
6. **`access.cookieMaxAgeDays` 依赖 `connection.browserAuth.maxAgeMilliseconds`**（`HostConnectionService`
   的公开字段 `browserAuth`，不是文档面 API）。若将来它改名，这里会安静地回 `null`（设置页显示"未提供"），
   不会报错。`access.host/port` 走的是 `webServer.config`/`webServer.port`，那是文档面字段。
7. **`icacls` 权限收紧是尽力而为**：Windows 上 Node 的 `chmod` 只切只读位，能不能真正收紧取决于
   `icacls` 是否可用、`USERNAME` 是否非空；失败时 notes 会写明失败原因，绝不假装成功。
   **而且这份总结只对退化路线（数据文件里的明文 token）有意义** —— 主路线（凭据服务）下数据文件里没有机密。
8. **安全边界没有变好**：本插件不额外增加认证。任何能访问本机 DSH 端口的人都能通过 `/dev/<id>/api/…`
   使用你配置的远端机器（凭据由宿主持有，会话 cookie 只在宿主进程内存里）；
   `webserver.host: 0.0.0.0` 就等于把这个能力也开放给该网络。
   `/plugin/remote/*` 只回环可读 —— 但**本机进程**（包括 agent 自己的工具进程）随便读，
   于是 `GET /plugin/remote/urls` 里的 `?token=…` 对同机进程是可见的（这正是 token-copy 的原本语义）。
9. **mux 发现会向本机发一次带进程 token 的 `GET /?token=…`**（换来一个会话 cookie 只用于读首页）。
   token 只出现在那一条请求里，不打印、不进体检数据、不落盘；但这一行为本身值得知道。
   如果你不接受，可以给 `deps.discoverMuxPath` 一个不换 cookie 的实现（只靠注入表）；注入表失败时
   就只会报 `muxPathFound:false`。
10. **垫片用 `Function.prototype.toString()` 序列化**：`remoteShim` 必须保持自包含
    （不能引用模块作用域里的任何绑定）。若将来被 bundle/minify 处理到"把函数体里的引用提到模块作用域"，
    注入文本就会失效（症状：页面控制台 `remoteShim is not defined` 之类）。
11. **代理前缀固定 `/dev/<id>/`**：如果某台远端 DSH 自己就在 `/dev/...` 下提供东西，需要给那台换 `id`。
    垫片只改 `api/` 开头的同源路径，且是**根相对**的 `/dev/...`；DSH 若挂在子路径下（如 `/dsh/`），
    改写规则要同步更新（device-switch 时代同样如此）。
12. **`current` 的语义只用于"认领本机"**，与垫片里"当前选中的设备"（localStorage）是两件事 ——
    前者决定哪一台不注册代理路由，后者决定窗口的 api 流量走哪台。两者互不影响，但名字容易混。
13. **`selftest.mjs` 的假 DOM 不是真 DOM**：为了能断言"胶囊被 removeChild 摘掉"，本轮给假 DOM 补上了
    `parentNode` / `removeChild`。真浏览器里 `removeChild` 的行为是标准的，但"刷新时机与页面可见变化"
    仍然只在沙箱里被断言过。
14. **另存为 / 分叉两条新能力的"未验证"清单在第 8.5.4 节**（真机端到端没跑过、
    `workspace/initializeDefault` 与 `session/create` 带 `workspaceId` 的落点只在源码里核对过、
    `session/rename` 的标题会被目标机归一化/截断、`throughSeq` 取 `asOfSeq` 只在源码里核对过、
    流式未定型的 assistant chunk 不带过去、**另存为的 `absolutePath`/`sessionId` 两个输入只在源码里
    确证过（没在真实窗口点过）、**"浏览器打开远端页面"那条新路（`device` 为空 → 本机读取）与
     新的鉴权（官方 `connection.requestRejection`）都只在自测里验证过、没在真机浏览器里跑过**、
     旧的文件地址解析已删**、没有断点续传、
    结果提示依赖 `alert`、**两个挂载点都没在真实窗口里点过**（头部按钮区的观感也没看过）、
    stat 与 readBytes 之间没有版本一致性检查）。
15. **两条新能力的"可达性"与代理是两套记录**：`markReach()` 会被 download/fork 的成功与失败刷新
    （体检里的 `reachable`/`lastError`），而 `diagnostics.saveAs` / `diagnostics.fork` 记的是
    "这两条能力各自最近一次的结果"。看体检时两者都要看：前者说明"机器在不在"，
    后者说明"这条路最近出了什么错"。
16. **`opNote()` 的措辞分两种形态**：没用过时给"可用/不可用（enabled=false）"，用过之后给
    "最近一次失败（时间）：原因"（成功一次会把 `lastError` 清空）。所以排错时**先看 notes 的那两行**，
    再去看 `saveAs`/`fork` 字段里的结构化值。

---

## 12. 卸载 / 回退（**彻底关停的唯一方式**）

软开关只能停"代理与注入的效果"；**要彻底关停请卸载**。卸载步骤与**残余**如下：

1. 从 profile 的 `cordis.patch.yml` 里删掉 `@local/dsh-remote` 那一节
   （或先把 `enabled` 改成 `false` 观察：代理与胶囊都会停，但设置页还能读）。
2. 从 profile 的 `package.json` 的 `dsh.profile.bundles` / `dependencies` 里移除它
   （也可以用插件管理器卸载，但注意第 4 节：它现在判 `unaddressable`，管理器可能改不动它）。
3. **卸载后残留什么**（按"要不要手工清"排序）：

| 残留 | 位置 | 要不要清 |
|---|---|---|
| 设备数据文件 | `$DSH_HOME/remote-devices.json`（`$DSH_HOME` = `process.env.DSH_HOME` 或 `%USERPROFILE%\.dsh`） | 想彻底干净就删；里面是 `enabled`/`devices`/`current`（退化路线下还可能有明文 `tokens`）。 |
| 凭据库里的 token | `$DSH_HOME/.credentials.yaml` 的 `refs:` 下 `DSH_REMOTE_TOKEN_<sha256(id) 前 16 位>` | 想连 token 一起清就删这些键；不删也不会有东西再读它（没有插件了）。 |
| `link:` 源码目录 | `C:\Users\<user>\.dsh\local-plugins\dsh-remote\`（`package.json` 里是 `link:` 指向它） | **别删**：这是源码本体（`_ops` 里那份是工作副本/对照）。 |
| profile 里那条重复的 `insert` | profile 的 `cordis.patch.yml` | 卸载时一起删（留着就是一条"entry not found"的加载器告警）。 |
| 浏览器里的两个 localStorage 键 + 两个 sessionStorage 标记 | `dsh-device-switch:current`/`:devices`、`dsh-remote:current`/`:devices`、`dsh-remote:soft-off`（哨兵）、`dsh-remote:force-active`（强制激活） | 卸载后垫片自检拿到 404 会自己清掉（并在必要时刷新一次），不用手工清；想立刻清就用设置页关停一次或清站点数据（两个会话标记也可以不管：关窗口即消失）。 |
| 插件自己的 `$DSH_HOME` 数据目录 | 无 | 本插件不建任何目录（只有那一个 JSON 文件）。 |

4. 回退到 device-switch：把数据文件里的 `devices` 抄回 profile 的 `config.devices`（含 `token`）即可
   —— 两者的设备形状（`{id,name,url}`）是刻意保持一致的。

---

## 十、远端目录流（0.11.15）：接管「添加工作区…」的目录选择

**要修的行为**：在 A 的窗口里切到 B，点「添加工作区…」时弹出的是 **A 本机**的系统文件夹窗口（工作区却要建在 B）。

**机制（全部走官方 seam：不做 DOM 硬插、不改壳、不改 DSH 配置）**：

- 「添加工作区…」的目录选择是两个子 slot：`conversation.hero.workspace.directoryFlow` 与
  `sidebar.workspaces.directoryFlow`，都是 `kind: "single"`；占据方契约（client inspect 的
  `DirectoryFlowOwnerProps`）：`open / busy / onPicked(path) / onCancel() / onError(message)`。
- slot 引擎 `entriesOfSlot()` 按 **priority 升序**取每格第一个存活条目；同优先级重复注册会抛错，
  报错文案自己写着「register at a different priority to shadow it (lowest renders)」。
  ⇒ 我们用 `priority: -1` **遮蔽**官方占据方（它在 0）：不卸载它、**本机模式下干脆不注册**。
- 官方占据方是谁：`dsh-host-directory-picker-auto` 在**服务端启动时**按事实解析 ——
  `bindHost !== "127.0.0.1"` → `browse`（应用内浏览），否则 win32/darwin → `native`（无渲染驱动）。
  `native` 的 client half 的 `pick` 只有两条路：① 页面里有桌面壳注入的 `globalThis.__DSH_DIRECTORY_PICKER__`
  → 弹**本机**系统窗口（这次的 bug 本体）；② 没有那个全局 → `uiWorkspace.pickDirectory()` 走 RPC 去对面开系统对话框。
  两条路都不是"让你在这台选对面的目录"。
- 我们的占据方：**远端模式**（`localStorage["dsh-device-switch:current"]` 有值）下注册；数据源用官方 browse
  占据方那一对方法 `uiWorkspace.listDirectory / createDirectory`（远端模式下垫片把 api 流量改道到对面那台），
  渲染成自己的应用内对话框（内联样式 + `--dsw-alias-*` 主题 token）。
  对面解析成 `native` 时 `list` 会以 `directory-picker/unavailable` 被拒 ⇒ 对话框写明原因，并给
  **直接输入对面绝对路径**的兜底（不依赖对面任何后端）。

**几个不许回退的实现细节**：

- **对面是 `native` 后端（列不出目录）时必须给能点的东西**，而不是只丢一句报错：官方 `list` 报的是英文
  （`directoryPicker.list needs the browse capability; the composed picker serves "native"`），界面上换成中文说明
  （**不把官方英文原文抛给用户**——用户实测截图点名了这条），并且给两条路：
  ① 列出"对面**已有工作区**的目录"当候选 —— 来源是**客户端自己的会话快照**
  `ctx.sessions.list.getSnapshot().byId[*].cwd`（远端模式下这份快照本来就是对面那台的；官方
  `dsh-client-ui-chat` 也是这么读 `cwd` 的），去重、排序、最多 8 条，点一下就 `onPicked`；
  ② 保留"直接输入绝对路径"。另外这种限制下"重试"必然同样结果 ⇒ **不摆那个按钮**。
  ⇒ 候选来自客户端快照，所以**不需要任何新网络入口**（比自建 peer 目录通道更保守，也不用对面改配置）；
  代价是只能列"已经有工作区的目录"，其余要手输。
- 「读取中」必须**派生**（`view.token !== wanted.token`），**不许**在 effect 里同步 setState 去写它：
  那会立刻触发一次重渲染，本轮 effect 的清理函数随即把在途请求的 `alive` 关掉，回调永远落不了地
  —— 这是自测抓到的真实时序 bug（表现：永远停在"读取中…"）。
- **选中的设备是"本机自己"那一台时必须交回官方**：设备表里每条设备都带 `local: device === runtime.localDevice`
  （宿主半 `buildDevices`），而 `localStorage` 里的切换键**只表示"选了谁"**（本机 = 删键），所以"选了自己那台"
  是可能存在的一态（本次实测设备A的 `remote-devices.json` 里 `current: "company"` 就是自己）。
  那一态下官方占据方走的是桌面壳的系统对话框（本机、好用），而我们自己的列表会因为"本机 = 回环 + native 后端"失败
  ⇒ 组件在 `open` 时先读 `/state`：目标带 `local:true` 就**不列目录、不渲染自己的弹窗**，直接 `pickDirectory()` 把结果
  交给 owner；设备表读不到则按"对面"处理（照常列目录，名字退化成 id）。
- 设备名那一路（`GET /plugin/remote/state`）**不挂 alive**：它与请求 token 无关，重渲染作废旧闭包时也不该丢结果；
  取不到就显示设备 id，**不编名字**。
- 两个洞各自要 `ctx.slots.inject()`（声明可能晚于我们激活、还可能被替换），官方占据方也是这么嵌套的；
  `inject` 回调允许返回**多个 disposer 的可迭代对象**，所以一次注册两个洞是返回数组。
- `apply` 里接管放**最后**并包 try/catch：接管失败只记一条 `console.warn`，设置页与两个菜单项照常工作。
- 客户端半只准用 `useState/useEffect`（自测的假 react 对 `useRef/useMemo/useCallback` 直接抛错）。
- 自测里首次加载必须用 `loadFlow()`（**先渲染再等 promise**）：`settleRenders()` 是"先 await 再 render"，
  冷启动那轮请求还没发出就已经判定"没有新写入"并 break，会误报成"卡在读取中"。

**部署特性**：这一节只动**客户端半**（`lib/client.js`）⇒ 两台覆盖文件后**重载一次窗口**即可
（宿主半没动，不必重启 DSH；版本号一起进 `package.json` / `lib/index.js` 只为体检显示一致）。
