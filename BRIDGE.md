# 跨机附件搬运（路径桥）— 设计定稿 v2

> 状态：**待实现**（0.11.0）。v1 里"自造投递路由"的方案**已作废** —— 官方有现成通道。

## 1. 问题

DSH 桌面端"发文件"是两套机制：

| 附件类型 | 行为 | 跨机时 |
|---|---|---|
| 图片 | 内容上传到会话所在机器的**附件库**（`dsh-attachment`：`saveImages`） | ✅ 可用 |
| 文本/其它文件 | 只写一条**路径提及** `@C:\…`（`dsh-file-reference`：`formatFileMention`） | ❌ 路径在对面不存在 → 附件等于没发出去 |

目标：把消息里的**本机路径**自动搬运到会话所在机器，并改写消息。

## 2. 复用的官方通道（v1 的错误：以为要自己开路由）

- `dsh-client-file-upload` 有一条**已鉴权的原始字节路由**：

  ```
  POST /api/session/uploadFileBinary?sessionId=<会话 id>
    Content-Type: application/octet-stream
    body: 原始字节
    → 200 JSON（附件元数据）；405 非 POST；415 content-type 不对
  ```

  Host 端是 `FileUploads.uploadStream()` → `ctx.attachments.saveFileStream(...)`，
  **落进官方附件库**（与图片同处）；认证由 Connection/DSH 栅栏负责。
- `dsh-api-workspace-files`：只有 `read` / `readBytes` / `stat`（**只读**）——用它**读本机**文件。
- 因此：
  - **投递 = POST 到对外的 edge**（`http://<对面>:<对外端口>/api/session/uploadFileBinary?sessionId=…`），
    由对面 DSH 用我们已持有的**会话 cookie** 认证；插件不新增任何自定义路由、不新增密钥体系。
  - **不往工作区手写文件**（v1 的 A 方案改动取消）：落点就是官方附件库，远端会话（含 agent）读得到 —— 与图片一致。

## 3. 鉴权与不变量

- 认证 = 对面 DSH 的栅栏（Host/Origin + `dsh-auth-*` cookie）。本机必须**已经持有对面的有效会话**，否则 DSH 层 401。
- 插件侧只做与 `download` 同级的"可信请求"判定（Host/Origin + 停用时 403）+ 日志记来源。
- 单文件上限默认 **256 MiB**；超限明确报错，不半途上传。
- **失败不改写**消息原路径，只在胶囊提示"有 N 个文件没搬过去（原因）"。
- 「配置」块加开关（默认开）；关闭后行为与现在**完全一致**。

## 4. 本机侧流程

1. **垫片（客户端半）**在发送前拿到即将发出的 prompt 请求体；
2. 扫出其中的**本机绝对路径**（`X:\…`；其它形态不动）；
3. 调本机宿主半 `POST /plugin/remote/bridge`（**仅回环**）：
   - 宿主半用官方 `workspaceFiles` **读本机文件**（按 session 授权，不绕过官方服务）；
   - 逐窗口把字节 POST 到对面 `/api/session/uploadFileBinary?sessionId=<对面会话>`（带对面的 cookie）；
   - 返回 `{ 原路径 → 对面附件路径 }` 映射；
4. 垫片**改写**消息里的路径 → 正常发送；
5. 胶囊提示：「已搬运 N 个文件（xx MB）」或失败原因。

## 5. 自测清单

- 投递：POST 路径/content-type 正确、`sessionId` 取自目标会话、200 后能拿到远端附件路径；
- 本机侧：路径识别（Windows / 相对路径不动）、映射改写、失败不改路径、开关关闭零行为；
- 失败分支：对面不可达 / 401 / 413 超限 / 非 octet-stream（我们主动带对）；
- 回归：现有 731 条全绿（`/dev/**` 代理、download、fork 不受影响）。

## 6. 不做

- 不搬目录；不搬超限大文件；不改 DSH 配置；不自造路由/密钥；只处理消息里出现的本机路径。
