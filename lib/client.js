/**
 * @local/dsh-remote —— 客户端半：设置里的**一页**「远程连接」（页面内自上而下 4 块）。
 *
 * 形态说明：客户端插件是**构建产物**格式（window.__ModuleLoader__.load），这里手工按该格式写，
 * 所以不需要任何构建工具链。factory 里只用 require("react")，样式全部内联，无任何外部资源。
 *
 * 数据来源：宿主半提供的同源路由 `GET/POST /plugin/remote/…`（见下方 API 常量）。
 * 响应保证是 JSON；取不到字段一律降级显示，**不允许白屏**（每块都有自己的错误态与占位文案）。
 *
 * 切换设备与宿主半的垫片（@local/dsh-device-switch 的 deviceSwitchShim）共用同一个
 * localStorage 键 `dsh-device-switch:current`：值是设备 id；**本机 = 删除该键**。
 * 写完后 location.reload()，垫片在下次页面加载时读它决定是否改写 api/ 流量。
 * 别名 `dsh-remote:current` 由宿主半的垫片同步读写，这里也要一起清（见 clearCurrentId）。
 *
 * 页面结构（**只有 1 个** settings.section，id `remote-connection`，order 60）：
 *   1. 插件开关 —— enabled 状态 + 开关（POST /plugin/remote/enabled）+ 软开关标注。
 *                 **关停：先清掉 localStorage 的"当前设备"（含别名），再 reload**；
 *                 **启动：直接 reload**（让壳重新注入垫片 = 胶囊回来）；
 *                 失败：原样显示宿主的错误，不假装成功、不刷新。
 *   2. 本机地址 —— 默认**收起**；展开后是带 token 的地址（地址文字在前、复制按钮在后）+ 本机进程
 *                 （绑定地址与入口地址都不在界面出现：那些由宿主半自动维护）
 *   3. 设备管理 —— 当前设备一行 + 真表格（切换到此设备｜回到本机 / 测试连通 / 修改 / 删除）
 *                 + 新增/修改表单
 *   4. 配置     —— 对外入口开关 + 对外端口 / cookie 天数 / 分叉条数 → POST /plugin/remote/access；
 *                 绑定地址固定 0.0.0.0 且**界面不显示**；成功只说「已写入配置，重启 DSH 生效」
 *   5. 体检     —— diagnostics 逐项 ✅/❌ + notes 逐条 + 「重新读取」/「重载窗口」
 *
 * 另外两个**官方扩展位**（不做 DOM 硬插、不改壳）：
 *   - `sidebar.right.tab.document.actions`（list，session 作用域）→「另存为…」：
 *     挂载点是文档预览的**头部按钮区**（同插槽里 open-in-app 的「显示文件位置」就在旁边），
 *     **不是**标签页「…」菜单 —— 早先挂在 `sidebar.right.tab.menu.item` 上，用户看不到（已改掉）。
 *     按钮**永远显示**（不做渲染期可见性判断）；点一下才判断：拿不到文件路径 /
 *     没有会话信息 → 一条明确的中文提示，绝不默默消失；两项齐了就
 *     `location.assign` 到 `GET /plugin/remote/download?device=&path=&session=`，
 *     由宿主半流式回文件字节，浏览器按 `Content-Disposition: attachment` 存进本机「下载」文件夹。
 *     **不做任何"当前设备"判断**：另存为就是另存为。`device` 只是可选的"设备切换键"（有就带、
 *     空就带空值），空 = 读**页面所在这台机器**上的文件（"页面由哪台机器提供，文件就在哪台机器上"）。
 *     文件路径 = 同槽位的 ownerProp `absolutePath`（Host 绝对路径）；会话 id = 同槽位的标准 prop
 *     `sessionId`（文件读取按 session 授权，本机与目标机都是同一套）。
 *   - `sidebar.workspaces.session.menu.item`（list，root 作用域）末尾 →「分叉到 <设备名>」：
 *     没有任何**远程**设备（`local:true` 那台不算）时整项隐藏；**每台远程设备一行**，
 *     行里的**设备名用加重节点**渲染（多设备时一眼可辨，用户要求"要有明显的标识区分"），
 *     选一台就 `POST /plugin/remote/fork { targetDeviceId, sourceSessionId, tailN:20 }`，
 *     由宿主半读本机会话尾页 → 目标机建会话 + 发种子；结果用一条中文提示回报。
 *     源会话 id 只从槽位上下文的 `sessionId` 拿，拿不到就报错，绝不猜。
 *
 * 第三个**官方扩展位**（只在远端模式下接管，功能 3）：
 *   - `conversation.hero.workspace.directoryFlow` 与 `sidebar.workspaces.directoryFlow`
 *     （两个 `single` 洞 = 「添加工作区…」的目录选择）→ **只在远端模式**（页面正把 api 流量
 *     改道到另一台机器）下用 priority **-1** 注册一个占据方，渲染「**对面机器**的目录浏览」
 *     （数据源 = 官方 browse 占据方用的 `uiWorkspace.listDirectory / createDirectory`，
 *     远端模式下它们经垫片落在对面那台机器上），并按 owner 约定只报一个结果。
 *     本机模式**不注册**：官方占据方（系统对话框，或可浏览模式下的应用内对话框）就是对的。
 *     修的就是「在 A 台窗口里给 B 台建工作区，却弹出 A 台的系统文件夹窗口」。
 *
 * 两个**不许回退**的历史修复：
 *   - 设备表每行按钮的取值必须靠**每行独立闭包**（历史上行内 `var` 让所有按钮共享同一绑定）；
 *   - 表单更新一律走**函数式** setState（把 prev 展开成新对象），连续编辑不丢字段。
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-remote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		var h = react.createElement;
		/**
		 * 官方菜单项组件（ui-primitives）。菜单行**必须**用它才能拿到内置的字体、图标位、
		 * hover 高亮与分隔线（框架自己的 pin/rename/fork/archive 就是这么渲染的）。
		 * 取不到时退化成普通 `role="menuitem"` 的 `<button>`：功能一致、外观朴素，
		 * 且仍然参与框架的键盘走位（它按 DOM 找 menuitem）。
		 */
		var primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = null;
		}

		/** 宿主半的路由前缀。 */
		var API = "/plugin/remote";

		/**
		 * 与 @local/dsh-device-switch 垫片约定的 localStorage 键。
		 * 值是设备 id 字符串；把键**删除**即"回到本机"（垫片把 getItem 得到 null 当作本机）。
		 */
		var SWITCH_KEY = "dsh-device-switch:current";

		/**
		 * 同一个选择的**别名键**（宿主半的垫片两个键都读、都写，所以清的时候必须一起清，
		 * 否则别名里那个 id 会让页子在下次加载时又跑远端）。
		 */
		var SWITCH_ALIAS_KEY = "dsh-remote:current";

		/**
		 * 宿主半垫片的**防循环哨兵**键（sessionStorage，每个窗口一个；键名必须与宿主半的
		 * `SHIM_SELFTEST_SENTINEL_KEY` 一致）。
		 *
		 * 关停时垫片会写下它（值非空 = "这个窗口已经为停用刷过一次"），于是**重新开启后的
		 * 第一次页面加载**里垫片在同步阶段读到它就直接惰性返回：不 patch、不挂胶囊 ——
		 * 这就是"开启后胶囊不出现、必须再点一次「重载窗口」"的根因。
		 * 所以「开启」分支必须在刷新**之前**把它清掉。
		 */
		var SOFT_SWITCH_SENTINEL_KEY = "dsh-remote:soft-off";

		/**
		 * **强制激活**标记（sessionStorage，键名必须与宿主半的 `SHIM_FORCE_ACTIVE_KEY` 一致）。
		 *
		 * 开启成功后写下它，宿主半的垫片在下次页面加载的**同步阶段**就会忽略 payload 里的
		 * `enabled` 与那个哨兵，直接走正常模式（patch + 挂胶囊），用掉后自己删标记。
		 * 这样"开启 → 刷新一次"胶囊就回来，不必再点「重载窗口」。
		 */
		var FORCE_ACTIVE_KEY = "dsh-remote:force-active";

		/**
		 * 软开关的标注文案（与 package.json 的 description 口径一致，宿主半的体检 notes 同样措辞）。
		 * 页面与 README 都不许改口径：停用只停代理与注入，彻底关停要卸载。
		 */
		var SOFT_SWITCH_NOTE = "软开关：停用只停止代理与注入；要彻底关停请卸载本插件";

		/**
		 * 功能 1：「另存为…」跳到宿主半的下载路由（`GET /plugin/remote/download`）。
		 * 宿主半按 `Content-Disposition: attachment` 回文件字节，浏览器把它存进本机「下载」文件夹。
		 * 路由在**页面所在这台机器**上（页面由谁提供，文件就在谁那儿）；`device` 只是可选的切换键。
		 */
		var DOWNLOAD_ROUTE = "/download";

		/** 功能 2：「分叉到…」POST 到本机宿主半。 */
		var FORK_ROUTE = "/fork";

		/**
		 * 「配置」块：**对外入口**（开关 + 端口，写数据文件、改端口立即生效）、**cookie 天数**（写 profile）、**分叉条数**（写数据文件）。
		 * `host` 固定由宿主半写 `0.0.0.0`，界面**不显示、也不提供**改它的入口（用户定稿的规格）。
		 */
		var ACCESS_ROUTE = "/access";

		/** 保存成功后的**唯一**一句提示（用户定稿；不加任何额外的风险/掉线提醒）。 */
		var ACCESS_SAVED_NOTE = "已写入配置，重启 DSH 生效";

		/**
		 * 功能 1「另存为…」的两块输入**只从槽位 props 拿**，不再解析资源地址：
		 *   - `absolutePath`：ownerProp，预览文件的 Host 绝对路径
		 *     （真源：`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`
		 *     `const fileOwner = absolutePath === void 0 ? void 0 : { absolutePath };`
		 *     再 `renderSlot("sidebar.right.tab.document.actions", fileOwner)`，
		 *     与 open-in-app 的 `OpenPathAction` 用的是**同一个** prop）；
		 *   - `sessionId`：该槽位（list / **session 作用域**）的标准 props，由框架与
		 *     "会话标准工具包"一起注入（不是 owner prop；同一件的还有 `useResource` 等）。
		 * 宿主半的 download 路由两种路径都收（"工作区相对路径或绝对路径"），
		 * 而且**两种都不需要**"当前设备"这个信息：绝对路径本来就是**提供页面那台机器**上的路径。
		 */

		/**
		 * 「分叉到…」带走的条数**由宿主半决定**（设置页「配置」块里那一格，存数据文件、改完立即生效），
		 * 所以请求体里**不再塞 tailN**：塞了就会把用户设的值盖掉（客户端不知道用户设的是多少）。
		 */

		/** 菜单项的样式（宿主半只给 react；菜单项就是普通 <button>，样式全内联）。 */
		var MENU_ITEM_STYLE = {
			display: "block",
			width: "100%",
			textAlign: "left",
			padding: "6px 10px",
			background: "transparent",
			border: 0,
			cursor: "pointer",
			font: "inherit",
			color: "inherit",
			whiteSpace: "nowrap",
		};
		/** 展开设备选择时的容器（贴在被点的菜单项下面）。 */
		var MENU_GROUP_STYLE = { display: "grid", gap: 2, padding: "2px 0" };
		/** 设备子项的样式（比一级项缩进一点）。 */
		var MENU_SUB_ITEM_STYLE = { ...MENU_ITEM_STYLE, paddingLeft: 22, opacity: 0.9 };

		/**
		 * 标题栏按钮的**回退**样式（只在取不到官方 `Button` 时用）。
		 * 28px 高、圆角 8px、1px 描边 —— 尽量贴近同插槽 open-in-app 那个小控件的高度，
		 * 以及官方 `Button` 的 `size:"sm"`（28px / 圆角 --dsw-radius-sm）。
		 */
		var TOOLBAR_BUTTON_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
			height: 28,
			padding: "0 10px",
			border: "1px solid rgba(128,128,128,.35)",
			borderRadius: 8,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			cursor: "pointer",
			whiteSpace: "nowrap",
		};

		//#region 内联样式

		var PAGE_STYLE = { padding: 16, display: "grid", gap: 12, alignContent: "start", fontSize: 13, lineHeight: 1.7 };
		/** 4 个大块的容器：浅色边框 + 极淡底色，分隔一眼可见，又不至于把页面拉得很长。 */
		var SECTION_STYLE = {
			border: "1px solid rgba(128,128,128,.35)",
			borderRadius: 8,
			padding: "10px 12px",
			display: "grid",
			gap: 8,
			background: "rgba(128,128,128,.06)",
		};
		/** 块内的小盒子（表格、notes、access…）。 */
		var BOX_STYLE = { border: "1px solid rgba(128,128,128,.22)", borderRadius: 6, padding: "8px 10px", display: "grid", gap: 6 };
		var HINT_STYLE = { fontSize: 12, opacity: 0.65 };
		var ERROR_STYLE = { fontSize: 13, color: "#d9483b" };
		var BTN_STYLE = { padding: "4px 10px", cursor: "pointer" };
		/** 地址行/ token 行上的小号复制按钮（比 BTN_STYLE 小一圈）。 */
		var SMALL_BTN_STYLE = { padding: "1px 6px", fontSize: 12, lineHeight: 1.4, cursor: "pointer" };
		var INPUT_STYLE = { padding: "4px 6px", minWidth: 200 };
		/** 「配置」块的对外端口输入框（对外入口监听的那个端口）。 */
		var TEXTAREA_STYLE = { width: "100%", minHeight: 88, padding: "4px 6px", font: "inherit", resize: "vertical", boxSizing: "border-box" };
		/** 保存成功那一句（用户定稿的文案，唯一一句）。 */
		var OK_STYLE = { fontSize: 13, color: "#2e7d32" };
		var CODE_STYLE = { wordBreak: "break-all", fontSize: 12, lineHeight: 1.6, flex: "1 1 auto" };
		var TABLE_STYLE = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
		var TH_STYLE = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid rgba(128,128,128,.35)", whiteSpace: "nowrap" };
		var TD_STYLE = { padding: "6px 8px", borderBottom: "1px solid rgba(128,128,128,.18)", verticalAlign: "top" };
		var TITLE_STYLE = { fontWeight: 600 };
		var ROW_STYLE = { display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" };

		//#endregion

		//#region hooks（按顺序存放，与真实 React 的规则一致）

		/**
		 * 组件里的 useState/useEffect 都走下面两个薄包装：游标按**调用顺序**推进
		 * （和 React 的规则一样：每次渲染的调用顺序必须稳定）。
		 */
		var HOOK_INDEX = 0;

		/** 每个组件开头调用一次：游标归零。 */
		function beginHooks() {
			HOOK_INDEX = 0;
		}

		/** 一个持久化的状态槽。 */
		function useStoredState(initial) {
			HOOK_INDEX += 1;
			return react.useState(initial);
		}

		/** 一个副作用（依赖数组交给 React 判断要不要跑）。 */
		function useStoredEffect(fn, deps) {
			HOOK_INDEX += 1;
			return react.useEffect(fn, deps);
		}

		//#endregion

		//#region 小工具

		/** 把任意值显示成人能读的字符串（绝不让 undefined/null 露出）。 */
		function text(value) {
			if (value === undefined || value === null) return "";
			if (typeof value === "string") return value;
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			try {
				return JSON.stringify(value);
			} catch (error) {
				return String(value);
			}
		}

		/**
		 * 跨 realm 安全的数组判定。
		 * 不用 `Array.isArray`：宿主半的 JSON 可能在**另一个 realm/模块实例**里产生数组，
		 * 那样 `Array.isArray` 会给出 false，页面就会莫名其妙地空掉。`Object.prototype.toString`
		 * 在各 realm 之间是通用的。
		 */
		function isArray(value) {
			return Object.prototype.toString.call(value) === "[object Array]";
		}

		/** 数组字段的宽容读取：不是数组就当空数组。 */
		function asArray(value) {
			return isArray(value) ? value : [];
		}

		/** 是不是对象（非 null、非数组）。 */
		function asObject(value) {
			return value !== null && typeof value === "object" && !isArray(value) ? value : {};
		}

		/** 统一的错误文案。 */
		function describeError(e) {
			if (e === undefined || e === null) return "未知错误";
			if (typeof e === "string") return e;
			var message = e.message;
			if (typeof message === "string" && message !== "") return message;
			return text(e);
		}

		/** 中文时间：宿主给的是 ISO 串，解析不了就原样显示，绝不显示 "Invalid Date"。 */
		function formatTime(value) {
			var raw = text(value);
			if (raw === "") return "";
			var date = null;
			try {
				date = new Date(raw);
			} catch (error) {
				return raw;
			}
			if (date === null || typeof date.getTime !== "function" || Number.isNaN(date.getTime())) return raw;
			try {
				return date.toLocaleString();
			} catch (error) {
				return raw;
			}
		}

		/** 可达状态三态：true → ✅ / false → ❌ / 其它 → 未测。 */
		function reachableLabel(reachable) {
			if (reachable === true) return "✅";
			if (reachable === false) return "❌";
			return "未测";
		}

		/**
		 * 统一的请求收口。宿主半保证响应是 JSON，但取不到时也降级：
		 * 空响应体返回 `{}`，非 JSON 返回一个带 `__text` 的对象，HTTP 错误抛出中文 Error。
		 */
		function request(path, options) {
			var init = options || {};
			init.credentials = "same-origin";
			if (init.body !== undefined && init.body !== null) {
				init.method = init.method || "POST";
				init.headers = { "content-type": "application/json" };
			}
			return fetch(API + path, init).then(function (response) {
				return response.text().then(function (body) {
					var trimmed = body === undefined || body === null ? "" : String(body).trim();
					var json = null;
					if (trimmed !== "") {
						try {
							json = JSON.parse(trimmed);
						} catch (error) {
							json = null;
						}
					}
					if (!response.ok) {
						var detail = json !== null && typeof json === "object" ? text(json.error) : "";
						throw new Error("HTTP " + response.status + (detail === "" ? "" : "：" + detail));
					}
					if (json !== null) return json;
					return trimmed === "" ? {} : { __text: trimmed };
				});
			});
		}

		/** 宿主半返回 `{ok:false,error}` 时的收口。 */
		function unwrap(json) {
			if (json !== null && typeof json === "object" && json.ok === false) {
				var message = text(json.error);
				throw new Error(message === "" ? "宿主半拒绝了这次操作" : message);
			}
			return json;
		}

		/** 二次确认：拿不到 confirm（理论上不会）时按"已确认"处理，别把按钮卡死。 */
		function askConfirm(message) {
			try {
				var impl = globalThis.confirm;
				if (typeof impl === "function") return impl(message) === true;
			} catch (error) {
				/* 下面按已确认处理 */
			}
			return true;
		}

		//#endregion

		//#region 本地状态（localStorage）

		/** 读"当前选中的设备 id"；空串 = 本机。localStorage 不可用时按本机处理。 */
		function readCurrentId() {
			try {
				var storage = globalThis.localStorage;
				if (storage === null || typeof storage !== "object") return "";
				var value = storage.getItem(SWITCH_KEY);
				return typeof value === "string" ? value : "";
			} catch (error) {
				return "";
			}
		}

		/** 记下一个 id；空串 = 回到本机（**删除**这个键）。返回是否写入成功。 */
		function writeCurrentId(id) {
			try {
				var storage = globalThis.localStorage;
				if (storage === null || typeof storage !== "object") return false;
				if (id === "") storage.removeItem(SWITCH_KEY);
				else storage.setItem(SWITCH_KEY, id);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 把"当前设备"整个忘掉：主键与别名键都删。
		 * 停用插件时必须在 reload **之前**调用（否则页面重新加载后垫片又会读到这个 id 继续跑远端）。
		 * localStorage 不可用时安静返回 false，绝不因此把开关卡住。
		 */
		function clearCurrentId() {
			try {
				var storage = globalThis.localStorage;
				if (storage === null || typeof storage !== "object") return false;
				storage.removeItem(SWITCH_KEY);
				storage.removeItem(SWITCH_ALIAS_KEY);
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 清掉一个**会话级**标记（sessionStorage）。用在软开关的两个方向上：
		 * 开启前清哨兵、关停时清强制激活标记。
		 *
		 * sessionStorage 不可用（隐私模式 / 被策略禁掉 / 跨 realm 取不到对象）时安静返回 false
		 * 并**继续往下走**：绝不能因为一个可选标记把开关卡死。这种情况下的降级行为见 README
		 * 「已知限制」：开启仍然会刷新（哨兵本来就清不掉，垫片的实时自检会兜底）。
		 */
		function clearSessionFlag(key) {
			try {
				var storage = globalThis.sessionStorage;
				if (storage === null || typeof storage !== "object") return false;
				storage.removeItem(key);
				return true;
			} catch (error) {
				return false;
			}
		}

		/** 写一个**会话级**标记；写不进（sessionStorage 不可用）时安静返回 false。 */
		function writeSessionFlag(key, value) {
			try {
				var storage = globalThis.sessionStorage;
				if (storage === null || typeof storage !== "object") return false;
				storage.setItem(key, value);
				return true;
			} catch (error) {
				return false;
			}
		}

		/** 重新加载页面，让垫片按新的选择生效（桌面壳没有 Ctrl+R，体检块里的按钮也用它）。 */
		function reloadPage() {
			try {
				globalThis.location.reload();
				return;
			} catch (error) {
				/* 下面兜底 */
			}
			try {
				globalThis.location.href = globalThis.location.href;
			} catch (error) {
				/* 放弃：用户自己刷新即可 */
			}
		}

		/** 在设备列表里按 id 找一台（找不到返回 null）。 */
		function findDevice(devices, id) {
			var list = asArray(devices);
			for (var index = 0; index < list.length; index += 1) {
				var entry = asObject(list[index]);
				if (text(entry.id) === id) return entry;
			}
			return null;
		}

		/**
		 * 顶部那一行"当前设备：…"。名字优先从已读到的设备列表里取，取不到就显示 id 本身
		 * —— localStorage 与设备列表不同步时（设备刚被删）也不会显示空白。
		 */
		function currentDeviceLabel(devices) {
			var id = readCurrentId();
			if (id === "") return "当前设备：本机";
			var device = findDevice(devices, id);
			var name = device === null ? "" : text(device.name);
			return "当前设备：" + (name === "" ? id : name);
		}

		/** 切换实现（与宿主半垫片对齐）：写 id / 删键，然后重载页面。 */
		function applyDeviceSwitch(id) {
			var next = id === undefined || id === null ? "" : text(id);
			if (next === "") clearCurrentId();
			else writeCurrentId(next);
			reloadPage();
		}

		//#endregion

		//#region 通用小组件

		/** 复制按钮：放在被复制文本的**后面**，成功后短暂显示"已复制"。`small` = 小号（地址行/token 行用）。 */
		function CopyButton(props) {
			beginHooks();
			var pair = useStoredState("复制");
			var label = pair[0];
			var setLabel = pair[1];
			var copyText = text(props.text);
			return h(
				"button",
				{
					type: "button",
					style: props.small === true ? SMALL_BTN_STYLE : BTN_STYLE,
					onClick: function () {
						var done = function () {
							setLabel("已复制");
							setTimeout(function () {
								setLabel("复制");
							}, 1500);
						};
						try {
							var clipboard = globalThis.navigator !== null && typeof globalThis.navigator === "object"
								? globalThis.navigator.clipboard
								: null;
							if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== "function") {
								throw new Error("当前环境没有 navigator.clipboard");
							}
							var pending = clipboard.writeText(copyText);
							if (pending !== null && pending !== undefined && typeof pending.then === "function") pending.then(done, done);
							else done();
						} catch (error) {
							try {
								globalThis.prompt("手动复制：", copyText);
							} catch (inner) {
								/* 连 prompt 都没有：什么都没法做，保持原状 */
							}
						}
					},
				},
				label,
			);
		}

		/** 一行只读信息：左标签、右值。 */
		function Field(props) {
			return h(
				"div",
				{ style: ROW_STYLE },
				h("span", { style: { opacity: 0.65, flex: "0 0 auto" } }, props.label),
				h("span", { style: { flex: "1 1 auto", wordBreak: "break-all" } }, props.value),
			);
		}

		/** 一个可编辑输入行。 */
		function InputField(props) {
			return h(
				"label",
				{ style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
				h("span", { style: { opacity: 0.65, minWidth: 76 } }, props.label),
				h("input", {
					type: props.type || "text",
					value: props.value,
					placeholder: props.placeholder || "",
					style: INPUT_STYLE,
					onChange: function (event) {
						props.onChange(text(event && event.target ? event.target.value : ""));
					},
				}),
			);
		}

		/** 错误提示（红字）；空字符串不渲染。 */
		function ErrorLine(props) {
			var message = text(props.message);
			if (message === "") return null;
			return h("div", { style: props.style || ERROR_STYLE }, message);
		}

		/** 一条体检项：✅/❌ + 标题 + 说明。 */
		function CheckItem(props) {
			var ok = props.ok === true;
			return h(
				"div",
				{ style: { ...BOX_STYLE, gap: 4 } },
				h("div", { style: { fontWeight: 600 } }, (ok ? "✅ " : "❌ ") + text(props.title)),
				props.detail === undefined || props.detail === null || text(props.detail) === ""
					? null
					: h("div", { style: { fontSize: 12, wordBreak: "break-all" } }, text(props.detail)),
				props.help === undefined || props.help === null || text(props.help) === ""
					? null
					: h("div", { style: HINT_STYLE }, text(props.help)),
			);
		}

		//#endregion

		//#region 块 1：插件开关

		/**
		 * 显示当前 enabled，并 POST /plugin/remote/enabled 改它（请求体 `{enabled}`）。
		 *
		 * 软开关的两个方向都**要刷新页面**才对用户生效（宿主半的垫片是页面加载时注入并同步改写的）：
		 *  - 关停：**先**清掉 localStorage 的"当前设备"（主键 + 别名），**再** reload
		 *    ——否则刷新之后垫片又会读到那个 id，继续把 api/ 流量改道到远端；
		 *    顺手还要清掉 `force-active` 标记，免得它残留让下次关停后的第一次加载又被强制激活；
		 *  - 启动：**先**清掉垫片的防循环哨兵（`dsh-remote:soft-off`），**再**置 `force-active`
		 *    标记，**最后**才 reload —— 顺序不许换。哨兵在位的窗口里，垫片同步阶段会直接惰性返回，
		 *    于是刷新后胶囊不会出现（正是"开启后还要再点一次重载窗口"这个 bug）。
		 *    清哨兵 + 强制激活标记让垫片这一次就忽略 payload/哨兵、走正常模式（胶囊回来），
		 *    标记用完由垫片自己删掉。
		 *
		 * 失败时把宿主给的错误原样显示，**不假装成功、也不刷新**（状态文字仍以页面读到的 enabled 为准）。
		 */
		function PluginSwitchPanel(props) {
			beginHooks();
			var enabled = props.enabled === true;
			var busyPair = useStoredState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var notePair = useStoredState("");
			var note = notePair[0];
			var setNote = notePair[1];

			function toggle(next) {
				if (busy === true) return;
				setBusy(true);
				setNote("提交中…");
				request("/enabled", { method: "POST", body: JSON.stringify({ enabled: next }) })
					.then(unwrap)
					.then(function () {
						if (next === false) {
							// 顺序不许换：先清选择，再刷新。
							clearCurrentId();
							// 顺手清掉"强制激活"标记：不留给下一次加载（否则关停后又被强制激活一次）。
							clearSessionFlag(FORCE_ACTIVE_KEY);
							setNote("已关停：正在回到本机…");
						} else {
							// 顺序不许换：先清哨兵（它会让垫片同步阶段惰性返回、错过挂载时机），
							// 再置"强制激活"标记（让垫片忽略 payload/哨兵走正常模式），最后才刷新。
							clearSessionFlag(SOFT_SWITCH_SENTINEL_KEY);
							writeSessionFlag(FORCE_ACTIVE_KEY, "1");
							setNote("已启用：正在重新注入胶囊…");
						}
						if (typeof props.onChanged === "function") props.onChanged();
						reloadPage();
					})
					.catch(function (error) {
						// 失败：显示宿主给的原因，不刷新、不假装成功。
						setNote("操作失败：" + describeError(error));
					})
					.then(function () {
						setBusy(false);
					});
			}

			return h(
				"div",
				{ style: SECTION_STYLE },
				h(
					"div",
					{ style: ROW_STYLE },
					h("span", { style: { ...TITLE_STYLE, flex: "1 1 auto" } }, "插件开关"),
					h("span", { style: { fontWeight: 600 } }, enabled ? "已启用" : "已停用"),
					h(
						"label",
						{ style: { display: "flex", gap: 6, alignItems: "center", cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: enabled,
							disabled: busy === true,
							onChange: function (event) {
								toggle(Boolean(event && event.target ? event.target.checked : !enabled));
							},
						}),
						h("span", null, "开关"),
					),
				),
				h("div", { style: HINT_STYLE }, SOFT_SWITCH_NOTE),
				h("div", { style: HINT_STYLE }, busy === true ? "提交中…" : note),
			);
		}

		//#endregion

		//#region 块 2：本机地址（默认收起）

		/**
		 * 默认**收起**：只给一行标题 + 摘要 + 「展开/收起」按钮，避免设置页一打开就被长地址列表撑满。
		 * 展开后：每条带 token 的地址一行（地址文字在前、复制按钮在后）+ 本机进程信息。
		 * **不再**展示绑定地址/入口地址/内部端口 —— 那些由宿主半自动维护。
		 */
		/** 从一个带 token 的地址里取出 token（取不到返回空串）。 */
		function tokenOf(url) {
			var match = /[?&]token=([^&\s]+)/i.exec(text(url));
			return match === null ? "" : match[1];
		}

		/**
		 * 掩码显示带 token 的地址：token 只留**前 6 位**，后面用 `....` 顶替。
		 * **只影响显示** —— 复制按钮拿到的仍是完整地址（含完整 token）。
		 */
		function maskUrlToken(url) {
			var raw = text(url);
			if (raw === "") return raw;
			return raw.replace(/([?&]token=)([^&\s]+)/i, function (_all, head, value) {
				var shown = value.length <= 6 ? value : value.slice(0, 6);
				return head + shown + "....";
			});
		}

		function LocalAddressPanel(props) {
			beginHooks();
			var collapsedPair = useStoredState(true);
			var collapsed = collapsedPair[0];
			var setCollapsed = collapsedPair[1];

			var urls = asObject(props.urls);
			var state = asObject(props.state);
			var urlsError = urls.error === undefined ? "" : text(urls.error);
			var stateError = state.error === undefined ? "" : text(state.error);
			var list = asArray(urls.urls);

			/** 收起时那一句摘要。 */
			var summary = urlsError !== ""
				? "读取失败：" + urlsError
				: "共 " + String(list.length) + " 条带 token 的地址";

			var children = [
				h(
					"div",
					{ key: "head", style: ROW_STYLE },
					h("span", { style: { ...TITLE_STYLE, flex: "1 1 auto" } }, "本机地址/token"),
					h("span", { style: HINT_STYLE }, summary),
					h(
						"button",
						{
							key: "toggle",
							type: "button",
							style: BTN_STYLE,
							onClick: function () {
								setCollapsed(collapsed !== true);
							},
						},
						collapsed === true ? "展开" : "收起",
					),
				),
			];

			if (collapsed === true) return h("div", { style: SECTION_STYLE }, children);

			children.push(
				h(
					"div",
					{ key: "legend", style: HINT_STYLE },
					"仅本机可读；接入一台新设备用一次，之后靠 cookie。",
					"每个地址都自带 token，发给要接入的机器直接打开即可；从别的设备或中转进来会 403（这是刻意的）。",
					h("strong", null, "cookie 有效期内不用再要 token"),
					"。",
				),
			);

			if (urlsError !== "") {
				children.push(h(ErrorLine, { key: "urls-error", message: "读取失败：" + urlsError }));
			} else if (list.length === 0) {
				children.push(h("div", { key: "urls-empty", style: HINT_STYLE }, "宿主半没有返回任何访问地址。"));
			}
			for (var index = 0; index < list.length; index += 1) {
				var entry = asObject(list[index]);
				var base = text(entry.base);
				var authenticated = text(entry.authenticated);
				var shown = authenticated === "" ? base : authenticated;
				children.push(
					h(
						"div",
						{ key: "url-" + String(index) + "-" + base, style: ROW_STYLE },
						// 地址文字在前、复制按钮在后（顺序在自测里被断言）；token 只显示前 6 位。
						h("code", { style: CODE_STYLE }, shown === "" ? "（空）" : maskUrlToken(shown)),
						h(CopyButton, { key: "copy", text: shown, small: true }),
					),
				);
			}

			// 末尾补一行**单独的 token**：显示完整 token，复制按钮只复制 token 本身。
			var tokenValue = "";
			for (var tokenIndex = 0; tokenIndex < list.length; tokenIndex += 1) {
				tokenValue = tokenOf(asObject(list[tokenIndex]).authenticated);
				if (tokenValue !== "") break;
			}
			if (tokenValue !== "") {
				children.push(
					h(
						"div",
						{ key: "token", style: ROW_STYLE },
						h("span", { style: { opacity: 0.65 } }, "token"),
						h("code", { style: CODE_STYLE }, tokenValue),
						h(CopyButton, { key: "copy", text: tokenValue, small: true }),
					),
				);
			}

			children.push(
				h(Field, {
					key: "process",
					label: "本机进程",
					value: (function () {
						var process_ = asObject(urls.process);
						var processHost = text(process_.host);
						var processPort = text(process_.port);
						var pid = text(process_.pid);
						var where = processHost === "" && processPort === ""
							? "（未提供）"
							: processHost + (processPort === "" ? "" : ":" + processPort);
						return where + (pid === "" ? "" : "（pid " + pid + "）");
					})(),
				}),
			);

			// 绑定地址/内部端口/入口地址都不在界面出现：
			// 这里只保留读取失败的行内提示（0.0.0.0 这类绑定值一律不在界面出现）。
			if (stateError !== "") children.push(h(ErrorLine, { key: "access-error", message: "读取访问设置失败：" + stateError }));

			return h("div", { style: SECTION_STYLE }, children);
		}

		//#endregion

		//#region 块 3：设备管理

		/**
		 * 拆分「名称 + 地址（含 token）」里的地址：标准写法 `http://host:port/?token=…`。
		 * 返回 `{ url, token }`（token 缺失 = 空串，由调用方决定是否必填）或 `{ error }`。
		 * 只认标准写法：必须带 http:// 或 https:// 前缀。
		 */
		function splitDeviceAddress(value) {
			var raw = String(value === null || value === undefined ? "" : value).trim();
			if (raw === "") return { error: "地址不能为空（形如 http://地址:端口/?token=…）" };
			var match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?/iu.exec(raw);
			if (match === null) return { error: "地址要写完整，形如 http://地址:端口/?token=…" };
			var base = match[1] === undefined ? "" : match[1];
			var path = match[2] === undefined ? "" : match[2];
			var query = match[3] === undefined ? "" : match[3];
			var token = "";
			var kept = [];
			var q = query.replace(/^\?/u, "");
			if (q !== "") {
				var parts = q.split("&");
				for (var index = 0; index < parts.length; index += 1) {
					var pair = parts[index];
					if (pair === "") continue;
					var eq = pair.indexOf("=");
					var key = eq >= 0 ? pair.slice(0, eq) : pair;
					if (key === "token") {
						token = eq >= 0 ? pair.slice(eq + 1) : "";
						continue;
					}
					kept.push(pair);
				}
			}
			var url = base + path + (kept.length === 0 ? "" : "?" + kept.join("&"));
			return { url: url, token: token };
		}

		/**
		 * 新增/修改一台设备。
		 * - 新增：只填「名称」+「地址（地址里含 token）」；token 从地址里解析；
		 * - 修改：同一个表单，地址回填当前地址（不含 token）；地址里带 token 才更新 token。
		 * `props.device` 非空 = 修改模式；`props.onCancel` 存在时显示「取消」。
		 */
		function DeviceForm(props) {
			beginHooks();
			var initial = asObject(props.device);
			var pair = useStoredState({
				id: text(initial.id),
				name: text(initial.name),
				address: text(initial.id) === "" ? "" : text(initial.url),
			});
			var form = pair[0];
			var setForm = pair[1];
			var busypair = useStoredState(false);
			var busy = busypair[0];
			var setBusy = busypair[1];
			var errpair = useStoredState("");
			var err = errpair[0];
			var setErr = errpair[1];
			var isEdit = form.id !== "";

			/** 用函数式更新改表单：连续多次输入时每次都基于**最新**的表单值，不丢字段。 */
			function set(patch) {
				setForm(function (previous) {
					return { ...asObject(previous), ...patch };
				});
			}

			function submit() {
				var name = String(form.name || "").trim();
				if (name === "") {
					setErr("名称不能为空。");
					return;
				}
				var split = splitDeviceAddress(form.address);
				if (split.error !== undefined) {
					setErr(split.error);
					return;
				}
				if (isEdit !== true && split.token === "") {
					setErr("地址里要带 token（形如 http://地址:端口/?token=…）。");
					return;
				}
				setBusy(true);
				setErr("");
				var payload = { name: name, url: split.url };
				if (isEdit === true) payload.id = form.id;
				if (split.token !== "") payload.token = split.token;
				request("/devices", { method: "POST", body: JSON.stringify(payload) })
					.then(unwrap)
					.then(function () {
						setForm(function () {
							return { id: "", name: "", address: "" };
						});
						if (typeof props.onSaved === "function") props.onSaved();
					})
					.catch(function (error) {
						setErr("保存失败：" + describeError(error));
					})
					.then(function () {
						setBusy(false);
					});
			}

			return h(
				"div",
				{ style: BOX_STYLE },
				h("div", { style: TITLE_STYLE }, isEdit === true ? "修改设备：" + form.name : "新增设备"),
				h(
					"div",
					{ style: { display: "grid", gap: 6 } },
					h(InputField, {
						label: "名称",
						value: form.name,
						placeholder: "例如 设备A",
						onChange: function (value) {
							set({ name: value });
						},
					}),
					h(InputField, {
						label: "地址（含 token）",
						value: form.address,
						placeholder: "http://192.0.2.20:19387/?token=…",
						onChange: function (value) {
							set({ address: value });
						},
					}),
					h("div", { style: HINT_STYLE }, isEdit === true
						? "回填的是当前地址（不含 token）；把带 token 的地址整段粘进来就会更新 token，不带则保持原 token 不变。"
						: "把对方「本机地址/token」整段粘进来即可，格式：http://地址:端口/?token=…"),
				),
				h(ErrorLine, { message: err }),
				h(
					"div",
					{ style: ROW_STYLE },
					h(
						"button",
						{
							type: "button",
							style: BTN_STYLE,
							disabled: busy === true,
							onClick: function () {
								if (busy === true) return;
								submit();
							},
						},
						busy === true ? "提交中…" : isEdit === true ? "保存修改" : "新增",
					),
					typeof props.onCancel === "function"
						? h(
								"button",
								{
									type: "button",
									style: BTN_STYLE,
									onClick: function () {
										props.onCancel();
									},
								},
								"取消",
							)
						: null,
				),
			);
		}

		/**
		 * 当前设备 + 设备表 + 新增/修改表单。
		 *
		 * 表里每行都在自己的函数作用域里造（见下面 `buildRow` 的立即执行调用）：
		 * 行内 `var` 是函数级的，直接写在循环体里会让**所有按钮共享同一份绑定**，
		 * 读到的永远是最后一台设备（"回到本机"因此永远不会真的切回本机）—— 这个坑不许回退。
		 */
		function DevicePanel(props) {
			beginHooks();
			var devices = asArray(props.devices);
			var stateError = text(props.stateError);
			var editPair = useStoredState(null);
			var editId = editPair[0];
			var setEditId = editPair[1];
			var notesPair = useStoredState({ test: {}, note: "" });
			var notes = notesPair[0];
			var setNotes = notesPair[1];

			function noteTest(id, message) {
				setNotes({ test: { ...asObject(notes.test), [id]: message }, note: notes.note });
			}

			function noteToggle(message) {
				setNotes({ test: notes.test, note: message });
			}

			function testDevice(id) {
				noteTest(id, "测试中…");
				// 注意：这里**不能**过 unwrap。宿主半把"测不通"也编码成 `{ok:false, status, ms, error}`
				// 并配 HTTP 200 —— 那是**测试结果**而不是接口失败；过 unwrap 会让"❌ 不通"永远看不到。
				request("/test/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify({}) })
					.then(function (json) {
						var result = asObject(json);
						var ok = result.ok === true;
						var status = text(result.status);
						var ms = text(result.ms);
						var detail = text(result.error);
						noteTest(
							id,
							(ok ? "✅ 连通" : "❌ 不通")
								+ "　状态码：" + (status === "" ? "（无）" : status)
								+ "　耗时：" + (ms === "" ? "（无）" : ms + " ms")
								+ (detail === "" ? "" : "　错误：" + detail),
						);
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch(function (error) {
						noteTest(id, "测试失败：" + describeError(error));
					});
			}

			function removeDevice(device) {
				var id = text(device.id);
				var name = text(device.name);
				if (!askConfirm("确定要删除设备「" + (name === "" ? id : name) + "」吗？删除后要重新配地址和 token。")) return;
				request("/devices/" + encodeURIComponent(id), { method: "DELETE" })
					.then(unwrap)
					.then(function () {
						// 删掉的正好是当前选中的设备 → 顺手回到本机，别让 localStorage 指向一台不存在的设备。
						if (readCurrentId() === id) writeCurrentId("");
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch(function (error) {
						noteToggle("删除失败：" + describeError(error));
					});
			}

			function moveDevice(id, delta) {
				var ids = [];
				for (var at = 0; at < devices.length; at += 1) {
					var entry = asObject(devices[at]);
					if (entry.local === true) continue;
					ids.push(text(entry.id));
				}
				var from = ids.indexOf(id);
				var to = from + delta;
				if (from < 0 || to < 0 || to >= ids.length) return;
				var moved = ids.splice(from, 1)[0];
				ids.splice(to, 0, moved);
				request("/devices/reorder", { method: "POST", body: JSON.stringify({ ids: ids }) })
					.then(unwrap)
					.then(function () {
						if (typeof props.onChanged === "function") props.onChanged();
					})
					.catch(function (error) {
						noteToggle("调整顺序失败：" + describeError(error));
					});
			}

			var rows = [];
			for (var index = 0; index < devices.length; index += 1) {
				// 本机那一行是自动识别的自己：设备管理里不列它（切换浮层里仍保留「本机」入口）。
				if (asObject(devices[index]).local === true) continue;
				rows.push(
					(function buildRow(device) {
						var id = text(device.id);
						var isLocal = device.local === true;
						var currentId = readCurrentId();
						var isCurrent = isLocal ? currentId === "" : currentId === id;
						var switching = isLocal ? currentId !== "" : currentId !== id;
						var edit = editId === id;
						var position = 0;
						for (var at = 0; at < devices.length; at += 1) {
							var atEntry = asObject(devices[at]);
							if (atEntry.local === true) continue;
							if (text(atEntry.id) === id) break;
							position += 1;
						}
						var testNote = notes.test[id];
						var name = text(device.name) === "" ? id : text(device.name);
						var lastError = text(device.lastError);
						var lastOkAt = formatTime(device.lastOkAt);
						// 注意别叫 notes：那会遮住组件级的 notes 状态（测试结果存在那里）。
						var rowNotes = [];
						if (testNote !== undefined) rowNotes.push(h("div", { key: "test", style: HINT_STYLE }, testNote));
						var row = h(
							"tr",
							{ key: "device-" + id },
							h(
								"td",
								{ style: TD_STYLE },
								h("div", { style: { fontWeight: 600 } }, name),
								h("code", { style: { fontSize: 11, opacity: 0.7 } }, id),
								isCurrent ? h("div", { style: { fontSize: 11, color: "#4a8f4a" } }, "● 当前") : null,
							),
							h("td", { style: TD_STYLE }, h("code", { style: { fontSize: 11, wordBreak: "break-all" } }, text(device.url))),
							h("td", { style: TD_STYLE }, isLocal ? "本机" : "远端"),
							h("td", { style: TD_STYLE }, reachableLabel(device.reachable)),
							h(
								"td",
								{ style: TD_STYLE },
								lastError === "" ? h("span", { style: { opacity: 0.5 } }, "—") : lastError,
								lastOkAt === "" ? null : h("div", { style: HINT_STYLE }, "上次成功：" + lastOkAt),
							),
							h(
								"td",
								{ style: TD_STYLE },
								h(
									"div",
									{ style: { display: "flex", gap: 6, flexWrap: "wrap" } },
									h(
										"button",
										{
											type: "button",
											style: BTN_STYLE,
											onClick: function () {
												if (!switching) return;
												applyDeviceSwitch(isLocal ? "" : id);
											},
										},
										isLocal ? "回到本机" : "切换到此设备",
									),
									h(
										"button",
										{
											type: "button",
											style: BTN_STYLE,
											onClick: function () {
												testDevice(id);
											},
										},
										"测试连通",
									),
									h(
										"button",
										{
											type: "button",
											style: BTN_STYLE,
											title: "上移（切换列表顺序）",
											disabled: position === 0,
											onClick: function () {
												moveDevice(id, -1);
											},
										},
										"↑",
									),
									h(
										"button",
										{
											type: "button",
											style: BTN_STYLE,
											title: "下移（切换列表顺序）",
											disabled: position === devices.length - 1,
											onClick: function () {
												moveDevice(id, 1);
											},
										},
										"↓",
									),
									h(
										"button",
										{
											type: "button",
											style: BTN_STYLE,
											onClick: function () {
												setEditId(edit ? null : id);
											},
										},
										edit ? "收起" : "修改",
									),
									h(
										"button",
										{
											type: "button",
											style: { ...BTN_STYLE, color: "#d9483b" },
											onClick: function () {
												removeDevice(device);
											},
										},
										"删除",
									),
								),
								rowNotes.length === 0 ? null : rowNotes,
							),
						);
						return row;
					})(asObject(devices[index])),
				);
				var editRowId = text(asObject(devices[index]).id);
				if (editId === editRowId) {
					rows.push(
						h(
							"tr",
							{ key: "edit-" + editRowId },
							h(
								"td",
								{ colSpan: 6, style: TD_STYLE },
								h(DeviceForm, {
									device: asObject(devices[index]),
									onSaved: function () {
										setEditId(null);
										if (typeof props.onChanged === "function") props.onChanged();
									},
									onCancel: function () {
										setEditId(null);
									},
								}),
							),
						),
					);
				}
			}

			return h(
				"div",
				{ style: SECTION_STYLE },
				h(
					"div",
					{ key: "head", style: ROW_STYLE },
					h("span", { style: { ...TITLE_STYLE, flex: "1 1 auto" } }, "设备管理"),
					h(
						"button",
						{
							key: "back-local",
							type: "button",
							style: BTN_STYLE,
							disabled: readCurrentId() === "",
							onClick: function () {
								applyDeviceSwitch("");
							},
						},
						"返回本机",
					),
					h("span", { style: { fontWeight: 600 } }, currentDeviceLabel(devices)),
				),
				stateError === "" ? null : h(ErrorLine, { key: "state-error", message: "读取失败：" + stateError }),

				h(
					"div",
					{ key: "table", style: BOX_STYLE },
					devices.length === 0
						? h("div", { style: HINT_STYLE }, "还没有配置任何设备。用下面的表单加一台。")
						: h(
								"table",
								{ style: TABLE_STYLE },
								h(
									"thead",
									null,
									h(
										"tr",
										null,
										h("th", { style: TH_STYLE }, "名称"),
										h("th", { style: TH_STYLE }, "地址"),
										h("th", { style: TH_STYLE }, "位置"),
										h("th", { style: TH_STYLE }, "可达"),
										h("th", { style: TH_STYLE }, "最近错误"),
										h("th", { style: TH_STYLE }, "操作"),
									),
								),
								h("tbody", null, rows),
							),
				),

				h("div", { key: "note", style: HINT_STYLE }, notes.note),
				h(DeviceForm, {
					key: "new",
					onSaved: function () {
						if (typeof props.onChanged === "function") props.onChanged();
					},
				}),
			);
		}

		//#endregion

		//#region 块 4：「配置」（对外入口 + cookie 天数 + 分叉条数）

		/**
		 * 「配置」块 —— **永远显示**（不做可见性判断）。
		 *
		 * 用户定稿的规格（别加别减）：
		 *  - **绑定地址固定 `0.0.0.0`，界面不显示**：这里没有输入框、没有下拉，也不显示这个值；
		 *  - 一个**对外入口**勾选框 + 一个**对外端口**数字输入框（预填当前值）；
		 *  - 一个「**填入本机地址**」按钮：把宿主半给的 `access.localAddresses`（回环 + 各网卡 IPv4，
		 *    每条带当前端口）逐行填进去；用户刚改了端口时按输入框里的端口重写，省得手改；
		 *  - 一个「**保存**」按钮：`POST /plugin/remote/access { edgeEnabled, edgePort, cookieMaxAgeDays?, forkTailN? }`，
		 *    成功后**只**显示一句「已写入配置，重启 DSH 生效」（不加任何额外的风险提醒）；
		 *    失败显示宿主半给的中文原因，**不显示成功**；请求期间按钮置灰（防重复点击）。
		 *
		 * 输入的初值只在挂载时取一次（真实 React 的 useState 语义）：用户正在编辑时，
		 * 后台重新读取状态不会把输入框里的内容冲掉。
		 */
		function AccessConfigPanel(props) {
			beginHooks();
			var access = asObject(props.access);
			var stateError = text(props.stateError);
			/** 对外入口：只由「对外端口」这一格控制 —— 填了 = 开/改，留空 = 关掉。内部端口由宿主半自动挑、不显示。 */
			var edge = asObject(props.edge);
			var edgePortPair = useStoredState(text(edge.port));
			var edgePort = edgePortPair[0];
			var setEdgePort = edgePortPair[1];
			/** 「分叉带走的条数」（最近 N 条消息）：预填宿主半报的当前值。 */
			var forkPair = useStoredState(text(access.forkTailN));
			var forkTail = forkPair[0];
			var setForkTail = forkPair[1];
			/** cookie 天数（官方 connection.cookieMaxAgeDays，默认 30）。 */
			var daysPair = useStoredState(text(access.cookieMaxAgeDays));
			var cookieDays = daysPair[0];
			var setCookieDays = daysPair[1];
			var statusPair = useStoredState("");
			var status = statusPair[0];
			var setStatus = statusPair[1];
			var errorPair = useStoredState("");
			var error = errorPair[0];
			var setError = errorPair[1];
			var busyPair = useStoredState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];

			/** 端口校验：只认 1..65535 的整数（首尾空白容忍），不合法返回空串。 */
			function validPort(value) {
				var raw = text(value).trim();
				if (!/^\d+$/.test(raw)) return "";
				var wanted = Number(raw);
				if (!(wanted >= 1 && wanted <= 65535)) return "";
				return String(wanted);
			}

			/** 分叉条数的上限（宿主半给的值优先，拿不到就按 200）。 */
			function forkUpper() {
				var raw = Number(text(access.forkTailMax));
				return Number.isFinite(raw) && raw >= 1 ? raw : 200;
			}

			/** 分叉条数：空串 = 不改这一格（请求体里不带这个字段）；合法 → 数字串；不合法 → null。 */
			function forkTailValue() {
				var raw = text(forkTail).trim();
				if (raw === "") return "";
				if (!/^\d+$/.test(raw)) return null;
				var wanted = Number(raw);
				if (!(wanted >= 1 && wanted <= forkUpper())) return null;
				return String(wanted);
			}

			/** 保存（校验不过就只给中文提示、绝不发请求）。 */
			function save() {
				if (busy === true) return;
				// 「对外端口」留空 = 关掉对外入口；填了 = 开（或改端口）。
				var wantedEdgePort = text(edgePort).trim();
				if (wantedEdgePort !== "" && (!/^\d+$/.test(wantedEdgePort) || Number(wantedEdgePort) < 1 || Number(wantedEdgePort) > 65535)) {
					setStatus("");
					setError("对外端口必须是 1..65535 的整数（留空 = 关掉对外入口）。");
					return;
				}
				var wantedFork = forkTailValue();
				if (wantedFork === null) {
					setStatus("");
					setError("分叉条数必须是 1.." + String(forkUpper()) + " 的整数。");
					return;
				}
				var wantedDays = text(cookieDays).trim();
				if (wantedDays !== "" && (!/^\d+$/.test(wantedDays) || Number(wantedDays) < 1 || Number(wantedDays) > 36500)) {
					setStatus("");
					setError("cookie 天数必须是 1..36500 的整数。");
					return;
				}
				var payload = wantedEdgePort === ""
					? { edgeEnabled: false, edgePort: Number(text(edge.port) === "" ? 19387 : text(edge.port)) }
					: { edgeEnabled: true, edgePort: Number(wantedEdgePort) };
				if (wantedFork !== "") payload.forkTailN = Number(wantedFork);
				if (wantedDays !== "") payload.cookieMaxAgeDays = Number(wantedDays);
				setBusy(true);
				setStatus("");
				setError("");
				request(ACCESS_ROUTE, { method: "POST", body: JSON.stringify(payload) })
					.then(unwrap)
					.then(function (body) {
						setBusy(false);
						var note = text(asObject(body).note);
						setStatus(note === "" ? ACCESS_SAVED_NOTE : note);
						if (typeof props.onSaved === "function") props.onSaved();
					})
					.catch(function (failure) {
						setBusy(false);
						setStatus("");
						setError("保存失败：" + describeError(failure));
					});
			}

			var daysText = text(access.cookieMaxAgeDays);
			var forkText = text(access.forkTailN);

			return h(
				"div",
				{ style: SECTION_STYLE },
				h(
					"div",
					{ key: "head", style: ROW_STYLE },
					h("span", { style: { ...TITLE_STYLE, flex: "1 1 auto" } }, "配置"),
				),
				access.writable === true
					? null
					: h(
							"div",
							{ key: "not-writable", style: HINT_STYLE },
							"⚠ config-editor 不可用：保存会失败（原因见「体检」块）。",
						),
				h(InputField, {
					key: "edge-port",
					label: "对外端口",
					type: "number",
					value: edgePort,
					placeholder: "19387",
					onChange: setEdgePort,
				}),
				h(InputField, {
					key: "cookie-days",
					label: "cookie 天数",
					type: "number",
					value: cookieDays,
					placeholder: "30",
					onChange: setCookieDays,
				}),
				h(InputField, {
					key: "fork-tail",
					label: "分叉条数",
					type: "number",
					value: forkTail,
					placeholder: text(access.forkTailDefault) === "" ? "20" : text(access.forkTailDefault),
					onChange: setForkTail,
				}),
				h("div", { key: "hint2", style: HINT_STYLE }, "对外端口留空 = 关掉对外入口（立即生效）。cookie 天数需重启；分叉条数立即生效。"),
				h(
					"div",
					{ key: "actions", style: ROW_STYLE },
					h(
						"button",
						{
							key: "save",
							type: "button",
							style: BTN_STYLE,
							"data-dsh-remote": "access-save",
							disabled: busy === true,
							onClick: save,
						},
						busy === true ? "保存中…" : "保存",
					),
				),
				status === "" ? null : h("div", { key: "status", style: OK_STYLE }, status),
				error === "" ? null : h(ErrorLine, { key: "error", message: error }),
				h(
					"div",
					{ key: "current", style: HINT_STYLE },
					"当前：对外入口 " + (edge.enabled === true
						? (edge.running === true ? "监听中 :" + text(edge.port) : "已开但没起来（" + (text(edge.error) === "" ? "未知原因" : text(edge.error)) + "）")
						: "关")
						+ "　→ 本机 DSH 127.0.0.1:" + (text(edge.targetPort) === "" ? "?" : text(edge.targetPort))
						+ "　cookie " + (daysText === "" ? "（未知）" : daysText + " 天")
						+ "　分叉 " + (forkText === "" ? "（未知）" : forkText + " 条"),
				),
				stateError === "" ? null : h(ErrorLine, { key: "state-error", message: "读取配置失败：" + stateError }),
			);
		}

		//#endregion

		//#region 块 5：体检

		/** 版本/更新提示（读取 /state.update；检查失败也如实说明）。 */
		function updateLine(root) {
			const update = asObject(asObject(root).update);
			const current = text(asObject(root).version);
			const latest = text(update.latest);
			const error = text(update.error);
			if (error !== "") return "版本更新检查失败：" + error;
			if (latest === "") return "当前版本：" + (current === "" ? "（未知）" : current) + "（未获取到最新版本信息）";
			if (update.hasUpdate === true) return "当前版本：" + current + "　最新版本：" + latest + "（可升级：" + text(update.url) + "）";
			return "当前版本：" + current + "（已是最新）";
		}

		function HealthPanel(props) {
			beginHooks();
			var root = asObject(props.state);
			var stateError = text(props.stateError);
			var diagnostics = asObject(root.diagnostics);
			var notes = asArray(diagnostics.notes);
			var lastHelloAt = formatTime(diagnostics.lastHelloAt);
			var muxPath = text(diagnostics.muxPath);
			var routes = text(diagnostics.proxyRoutes);

			return h(
				"div",
				{ style: SECTION_STYLE },
				h(
					"div",
					{ key: "head", style: ROW_STYLE },
					h("span", { style: { ...TITLE_STYLE, flex: "1 1 auto" } }, "体检"),
					h(
						"button",
						{
							key: "reread",
							type: "button",
							style: BTN_STYLE,
							onClick: function () {
								if (typeof props.onReload === "function") props.onReload();
							},
						},
						"重新读取",
					),
					h(
						"button",
						{
							key: "reload",
							type: "button",
							style: BTN_STYLE,
							onClick: function () {
								reloadPage();
							},
						},
						"重载窗口",
					),
				),
				h("div", { key: "reload-hint", style: HINT_STYLE }, "改了配置/升级后用它让页面重新加载（桌面壳没有 Ctrl+R）。"),
				stateError === "" ? null : h(ErrorLine, { key: "state-error", message: "读取失败：" + stateError }),

				h(CheckItem, {
					key: "enabled",
					ok: root.enabled === true,
					title: "插件已启用（enabled）",
					detail: "enabled = " + text(root.enabled) + "　版本 " + (text(root.version) === "" ? "（未提供）" : text(root.version)),
					help: "停用时这里会红：此时插件不代理、不注入，等于没装。",
				}),
				h(CheckItem, {
					key: "injection",
					ok: diagnostics.injectionSeen === true,
					title: "页面注入垫片已报到（injectionSeen）",
					detail:
						"injectionSeen = " + text(diagnostics.injectionSeen)
						+ "　最近报到：" + (lastHelloAt === "" ? "（从未）" : lastHelloAt),
					help: "这一项红 = DSH 升级后页面注入失效：垫片没能进页面（或还没进过），设备切换与流量改道就不会生效。"
						+ "此时插件不影响 DSH 本身 —— 它只是没起作用，DSH 照常运行（先点「重载窗口」再看一次）。",
				}),
				h(CheckItem, {
					key: "mux",
					ok: diagnostics.muxPathFound === true,
					title: "会话长连接路径已动态发现（muxPath）",
					detail: "muxPath = " + (muxPath === "" ? "（未发现）" : muxPath),
					help: "这一项红 = 终端通道不可用（终端走的就是这条长连接）；对话与代理仍然可用，其它功能不受影响。",
				}),
				h(CheckItem, {
					key: "routes",
					ok: routes !== "" && routes !== "0",
					title: "已注册代理路由数（proxyRoutes）",
					detail: "proxyRoutes = " + (routes === "" ? "（未提供）" : routes),
					help: "这是插件注册到本机 Host 的 /dev/<id>/ 代理路由条数；为 0 说明还没有可代理的设备。",
				}),

				h("div", { key: "update", style: HINT_STYLE }, updateLine(root)),
				h("div", { key: "shortcut", style: HINT_STYLE }, "快捷键：Alt+Home 回到本机；Alt+F 打开设备切换列表。"),
				h(
					"div",
					{ key: "notes", style: BOX_STYLE },
					h("div", { style: TITLE_STYLE }, "备注（notes）"),
					notes.length === 0
						? h("div", { style: HINT_STYLE }, "（宿主半没有给出备注）")
						: h(
								"ul",
								{ style: { margin: 0, paddingLeft: 18, display: "grid", gap: 4 } },
								notes.map(function (note, index) {
									return h("li", { key: "note-" + String(index), style: { fontSize: 12, wordBreak: "break-word" } }, text(note));
								}),
							),
				),
			);
		}

		//#endregion

		//#region 唯一的一页：远程连接（order 60）

		/** 加载骨架里也要把 5 块的标题摆出来（不白屏，且一眼看出这页有哪些东西）。 */
		var BLOCK_TITLES = ["插件开关", "本机地址", "设备管理", "配置", "体检"];

		/**
		 * 设置里**唯一**的一节：一次读 /state + /urls，然后自上而下渲染 4 块。
		 * 两个接口各自独立降级：一个挂了另一个照样显示（各自把自己的 error 带进对应块）。
		 */
		/** 诊断日志：复制 / 下载 / 清空；日志由宿主半写（不含 token/密码），页面起不来时可直接取 `$DSH_HOME/dsh-remote.log`。 */
		function LogPanel(props) {
			var pair = useStoredState({ note: "" });
			var note = text(pair[0] && pair[0].note);
			var setNote = pair[1];
			var state = asObject(props && props.state);
			var diagnostics = asObject(state.diagnostics);
			var logFile = text(diagnostics.logFile);
			var collectScript = text(diagnostics.collectScript);
			var resetScript = text(diagnostics.resetScript);
			function loadText() {
				return request("/log").then(function (value) {
					return typeof value === "string" ? value : "";
				});
			}
			function copyLog() {
				loadText()
					.then(function (body) {
						var clipboard = globalThis.navigator !== null && globalThis.navigator !== undefined ? globalThis.navigator.clipboard : undefined;
						if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== "function") {
							setNote({ note: "当前环境不支持剪贴板；请改用「下载日志」或直接打开日志文件。" });
							return;
						}
						return clipboard.writeText(body).then(function () {
							setNote({ note: "已复制日志（" + body.length + " 字符）" });
						});
					})
					.catch(function (error) {
						setNote({ note: "复制失败：" + describeError(error) });
					});
			}
			function downloadLog() {
				loadText()
					.then(function (body) {
						var doc = globalThis.document;
						if (doc === null || doc === undefined || typeof doc.createElement !== "function") {
							setNote({ note: "当前环境不支持下载；请直接打开日志文件。" });
							return;
						}
						var blob = new globalThis.Blob([body], { type: "text/plain;charset=utf-8" });
						var url = globalThis.URL.createObjectURL(blob);
						var link = doc.createElement("a");
						link.href = url;
						link.download = "dsh-remote.log";
						if (typeof link.click === "function") link.click();
						globalThis.setTimeout(function () {
							try {
								globalThis.URL.revokeObjectURL(url);
							} catch (error) {
								/* 忽略 */
							}
						}, 2000);
						setNote({ note: "已开始下载 dsh-remote.log（" + body.length + " 字符）" });
					})
					.catch(function (error) {
						setNote({ note: "下载失败：" + describeError(error) });
					});
			}
			function clearLog() {
				request("/log/clear", { method: "POST", body: JSON.stringify({}) })
					.then(unwrap)
					.then(function () {
						setNote({ note: "已清空日志" });
					})
					.catch(function (error) {
						setNote({ note: "清空失败：" + describeError(error) });
					});
			}
			return h(
				"div",
				{ style: SECTION_STYLE },
				h("div", { style: TITLE_STYLE }, "诊断日志"),
				h("div", { style: HINT_STYLE }, "遇到问题时导出日志，随问题描述一起提供；日志不包含 token / 密码。"),
				logFile === "" ? null : h("div", { style: { ...HINT_STYLE, wordBreak: "break-all" } }, "日志文件：" + logFile),
				collectScript === "" ? null : h("div", { style: { ...HINT_STYLE, wordBreak: "break-all" } }, "一键收集（DSH 起不来也能用）：" + collectScript),
				resetScript === "" ? null : h("div", { style: { ...HINT_STYLE, wordBreak: "break-all" } }, "卡在白屏 / 起不来时（应急重置）：" + resetScript),
				h(
					"div",
					{ style: ROW_STYLE },
					h(
						"button",
						{
							type: "button",
							style: BTN_STYLE,
							onClick: function () {
								copyLog();
							},
						},
						"写入剪贴板",
					),
					h(
						"button",
						{
							type: "button",
							style: BTN_STYLE,
							onClick: function () {
								downloadLog();
							},
						},
						"下载日志",
					),
					h(
						"button",
						{
							type: "button",
							style: BTN_STYLE,
							onClick: function () {
								clearLog();
							},
						},
						"清空日志",
					),
					collectScript === ""
						? null
						: h(
								"button",
								{
									type: "button",
									style: BTN_STYLE,
									onClick: function () {
										var clipboard = globalThis.navigator !== null && globalThis.navigator !== undefined ? globalThis.navigator.clipboard : undefined;
										if (clipboard === null || clipboard === undefined || typeof clipboard.writeText !== "function") {
											setNote({ note: "当前环境不支持剪贴板。" });
											return;
										}
										clipboard.writeText(collectScript).then(function () {
											setNote({ note: "已复制收集脚本路径" });
										});
									},
								},
								"复制收集路径",
							),
				),
				h("div", { style: HINT_STYLE }, "页面/插件起不来时：直接打开上面的日志文件，或运行插件目录下 scripts\\collect-logs.cmd 打包全部日志。"),
				note === "" ? null : h("div", { style: HINT_STYLE }, note),
			);
		}

		function RemoteConnectionSection() {
			beginHooks();
			var pair = useStoredState({ status: "loading", state: null, urls: null });
			var view = pair[0];
			var setView = pair[1];
			var refreshPair = useStoredState(0);
			var refresh = refreshPair[0];
			var setRefresh = refreshPair[1];

			useStoredEffect(function () {
				var alive = true;
				// 两个接口一起读；一个挂了另一个也要能显示（各自独立的错误位）。
				Promise.all([
					request("/state").then(
						function (json) {
							return { ok: true, data: json };
						},
						function (error) {
							return { ok: false, error: describeError(error) };
						},
					),
					request("/urls").then(
						function (json) {
							return { ok: true, data: json };
						},
						function (error) {
							return { ok: false, error: describeError(error) };
						},
					),
				]).then(function (results) {
					if (!alive) return;
					setView({
						status: "ready",
						state: results[0].ok ? results[0].data : { error: results[0].error },
						urls: results[1].ok ? results[1].data : { error: results[1].error },
					});
				});
				return function () {
					alive = false;
				};
			}, [refresh]);

			/** 重新读一遍（体检块的「重新读取」，以及设备/开关改完之后）。 */
			function reloadState() {
				setRefresh(refresh + 1);
			}

			if (view.status === "loading") {
				return h(
					"div",
					{ style: PAGE_STYLE },
					h("div", { key: "loading", style: HINT_STYLE }, "读取中…"),
					BLOCK_TITLES.map(function (title, index) {
						return h(
							"div",
							{ key: "skeleton-" + String(index), style: SECTION_STYLE },
							h("div", { style: TITLE_STYLE }, title),
							h("div", { style: HINT_STYLE }, "读取中…"),
						);
					}),
				);
			}

			var state = asObject(view.state);
			var urls = asObject(view.urls);
			var stateError = view.state !== null && state.error !== undefined ? text(state.error) : "";
			var urlsError = view.urls !== null && urls.error !== undefined ? text(urls.error) : "";

			return h(
				"div",
				{ style: PAGE_STYLE },
				h(PluginSwitchPanel, {
					key: "switch",
					enabled: state.enabled === true,
					onChanged: reloadState,
				}),
				h(LocalAddressPanel, {
					key: "address",
					urls: urlsError === "" ? urls : { error: urlsError },
					state: stateError === "" ? state : { error: stateError },
				}),
				h(DevicePanel, {
					key: "devices",
					devices: asArray(state.devices),
					stateError: stateError,
					onChanged: reloadState,
				}),
				h(AccessConfigPanel, {
					key: "access-config",
					access: asObject(state.access),
					edge: asObject(state.edge),
					stateError: stateError,
					onSaved: reloadState,
				}),
				h(HealthPanel, {
					key: "health",
					state: state,
					stateError: stateError,
					onReload: reloadState,
				}),
				h(LogPanel, { key: "log", state: state }),
			);
		}

		//#endregion

		//#region 两个菜单项（功能 1「另存为…」/ 功能 2「分叉到…」）

		/**
		 * 给用户一条**非模态**反馈（0.13.2）：菜单项一点就随菜单卸载，没有地方放行内文本。
		 * 以前优先 `alert`，但真机反馈：弹窗确认后回到对话，**输入框失去焦点、必须刷新**才能继续打字。
		 * 现在改成页面**底部中间**的固定 toast（3 秒自动消失，不挡布局）：
		 *  - 不 `focus()`、不带 `tabindex` ⇒ 绝不抢焦点；
		 *  - DOM 不可用时退回 `console.warn`；**任何情况下都不弹 alert**；
		 *  - 全程 try/catch 兜底，绝不抛异常、绝不白屏。
		 */
		function notify(message) {
			var text_ = text(message);
			try {
				var doc_ = globalThis !== null && typeof globalThis === "object" ? globalThis.document : undefined;
				if (doc_ !== null && doc_ !== undefined && typeof doc_ === "object"
					&& typeof doc_.createElement === "function"
					&& doc_.body !== null && doc_.body !== undefined
					&& typeof doc_.body.appendChild === "function") {
					var toast_ = doc_.createElement("div");
					if (typeof toast_.setAttribute === "function") {
						toast_.setAttribute("data-dsh-remote-toast", "1");
						toast_.setAttribute("role", "status");
						toast_.setAttribute("aria-live", "polite");
					}
					if (toast_.style !== null && toast_.style !== undefined && typeof toast_.style === "object") {
						toast_.style.position = "fixed";
						toast_.style.left = "50%";
						toast_.style.bottom = "48px";
						toast_.style.transform = "translateX(-50%)";
						toast_.style.zIndex = "2147483000";
						toast_.style.background = "rgba(20,20,20,.92)";
						toast_.style.color = "#fff";
						toast_.style.padding = "8px 14px";
						toast_.style.borderRadius = "8px";
						toast_.style.fontSize = "13px";
						toast_.style.maxWidth = "70vw";
					}
					toast_.textContent = text_;
					doc_.body.appendChild(toast_);
					try {
						globalThis.setTimeout(function () {
							try {
								if (toast_.parentNode !== null && toast_.parentNode !== undefined
									&& typeof toast_.parentNode.removeChild === "function") {
									toast_.parentNode.removeChild(toast_);
								} else if (typeof toast_.remove === "function") {
									toast_.remove();
								}
							} catch (error) {
								/* 移除失败无所谓：下一次刷新就没了 */
							}
						}, 3000);
					} catch (error) {
						/* 没有定时器：toast 留着也不挡路（不抢焦点） */
					}
					return;
				}
			} catch (error) {
				/* 往下退 */
			}
			try {
				if (globalThis !== null && typeof globalThis === "object" && globalThis.console !== null && typeof globalThis.console === "object"
					&& typeof globalThis.console.warn === "function") {
					globalThis.console.warn("dsh-remote：" + text_);
				}
			} catch (error) {
				/* 连 console 都没有：只能算了（宿主半的体检里仍有记录） */
			}
		}

		/**
		 * 跳到一条本机地址去触发下载。
		 * 用 `location.assign`（而不是 `window.open`）：桌面壳里没有可靠的"新窗口"，而
		 * `Content-Disposition: attachment` 会让浏览器下载完仍停在本页。
		 * @returns 是否成功发起跳转。
		 */
		function navigateTo(url) {
			try {
				var location_ = globalThis.location;
				if (location_ === null || typeof location_ !== "object") return false;
				if (typeof location_.assign === "function") {
					location_.assign(url);
					return true;
				}
				location_.href = url;
				return true;
			} catch (error) {
				return false;
			}
		}

		/** 拼下载地址：`device` 一律带上（空串 = 读页面所在这台机器上的文件），参数一律 URL 编码。 */
		function buildDownloadUrl(deviceId, path, sessionId) {
			var url = API + DOWNLOAD_ROUTE + "?device=" + encodeURIComponent(text(deviceId)) + "&path=" + encodeURIComponent(text(path));
			if (text(sessionId) !== "") url += "&session=" + encodeURIComponent(text(sessionId));
			return url;
		}

		/** 会话 id 的前 8 位（结果提示里用它，避免糊一屏）。 */
		function shortId(value) {
			var raw = text(value);
			return raw.length <= 8 ? raw : raw.slice(0, 8);
		}

		/** 取一个官方图标节点（`ui-primitives` 的图标族）；名字不对或取不到就返回 null（绝不抛）。 */
		function primitiveIcon(iconName, size) {
			var name = text(iconName);
			if (primitives === null || name === "" || typeof primitives[name] !== "function") return null;
			try {
				return h(primitives[name], { size: size });
			} catch (error) {
				return null;
			}
		}

		/**
		 * 关掉当前菜单：会话「…」菜单靠框架注入的 `useMenuOpenState`（与内置的
		 * 分叉/归档项同一套），拿不到再退回 owner 给的 `props.dismiss`。
		 * **hook 必须在渲染期间调用**，所以这里只拿"关闭器"，不在事件里调 hook。
		 */
		function menuCloserFor(props, useMenuOpenState) {
			try {
				if (typeof useMenuOpenState === "function") {
					var pair = useMenuOpenState();
					if (isArray(pair) && typeof pair[1] === "function") return pair[1];
				}
			} catch (error) {
				/* 落到 dismiss */
			}
			return typeof props.dismiss === "function" ? props.dismiss : null;
		}

		/**
		 * 渲染一行菜单项：优先用官方 `MenuItemButton`（内置字体/图标/hover/分隔线），
		 * 取不到时退化成 `role="menuitem"` 的 `<button>`。
		 * `onSelect` 里先关菜单再动作 —— 官方行就是这么做的（菜单是框架的，动作后不收会浮在内容上）。
		 *
		 * 行的内容默认是 `label` 那段纯文字；给了 `content`（React 节点 / 节点数组）就用它 ——
		 * 「分叉到 <设备名>」靠这个把**设备名渲染成加重节点**（纯文字 label 只用于测试与无障碍名字）。
		 */
		function renderMenuItem(options) {
			var opts = asObject(options);
			var icon = primitiveIcon(opts.iconName, 14);
			var close = typeof opts.close === "function" ? opts.close : null;
			var act = typeof opts.onSelect === "function" ? opts.onSelect : function () {};
			var key = typeof opts.key === "string" ? opts.key : undefined;
			var content = opts.content === undefined || opts.content === null ? text(opts.label) : opts.content;
			if (primitives !== null && typeof primitives.MenuItemButton === "function") {
				try {
					return h(primitives.MenuItemButton, {
						key: key,
						icon: icon,
						"data-dsh-remote": text(opts.testId),
						onSelect: function () {
							if (close !== null) close(false);
							act();
						},
					}, content);
				} catch (error) {
					/* 退到下面的普通按钮 */
				}
			}
			return h(
				"button",
				{
					key: key,
					type: "button",
					role: "menuitem",
					style: MENU_ITEM_STYLE,
					"data-dsh-remote": text(opts.testId),
					onClick: function () {
						if (close !== null) close(false);
						act();
					},
				},
				icon,
				content,
			);
		}

		/**
		 * 渲染一个**标题栏按钮**（`sidebar.right.tab.document.actions`：文档预览头部按钮区）。
		 *
		 * **外圈尺寸照抄邻居**（`@deepseek-ai/dsh-client-ui-open-in-app` 的 `OpenTargetButton` CSS）：
		 * `height:24px` + `border:.5px solid var(--dsw-alias-border-l4)` + `border-radius:var(--dsw-radius-sm)`
		 * + `display:inline-flex`。所以并排看是一样大（早先官方 Button 的 `size:"sm"`=28px 明显大一圈 ✗）。
		 * 只显示图标（13px，同邻居 `{ size: prominent ? 18 : 13 }`）；`title`/`aria-label` 保留。
		 * 悬停高亮用 onMouseEnter/Leave 改内联样式（不依赖样式表注入，两条渲染路径一致）。
		 */
		function renderToolbarAction(options) {
			var opts = asObject(options);
			var label = text(opts.label);
			var title = text(opts.title) === "" ? label : text(opts.title);
			var ariaLabel = label === "" ? title : label;
			var testId = text(opts.testId);
			var icon = primitiveIcon(opts.iconName, 13);
			var act = typeof opts.onSelect === "function" ? opts.onSelect : function () {};
			var style = {
				boxSizing: "border-box",
				height: "24px",
				padding: "0 6px",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				borderRadius: "var(--dsw-radius-sm)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
			};
			return h(
				"button",
				{
					type: "button",
					role: "button",
					title: title,
					"aria-label": ariaLabel,
					style: style,
					"data-dsh-remote": testId,
					"data-height": "24",
					onClick: act,
					onMouseEnter: function (event) {
						try { event.currentTarget.style.background = "var(--dsw-alias-button-tool-bar-hover, rgba(127,127,127,0.12))"; } catch (error) { /* 忽略 */ }
					},
					onMouseLeave: function (event) {
						try { event.currentTarget.style.background = "transparent"; } catch (error) { /* 忽略 */ }
					},
				},
				icon,
				opts.iconOnly === true ? null : label,
			);
		}

		/**
		 * `sidebar.right.tab.document.actions`（list / session 作用域）里的一项：「另存为…」。
		 *
		 * 挂载点的真源（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`）：
		 * 它在文档预览的**头部按钮区**渲染这个 list，并且**只在文件元数据报出 Host 绝对路径时**
		 * 才渲染：`const fileOwner = absolutePath === void 0 ? void 0 : { absolutePath };`
		 * → `renderSlot("sidebar.right.tab.document.actions", fileOwner)`。
		 * 也就是说这个槽位的 **ownerProps 只有 `{ absolutePath }`**（open-in-app 的
		 * `OpenPathAction` 就是用同一个 prop 去 `openPath(path, …)` 的）；
		 * 会话 id 不在 ownerProps 里，它是这个**会话作用域**槽位的**标准 props**
		 * （catalog：`standardProps` 含 `sessionId: SessionId`、`useResource: UseResource`…），
		 * 由框架的"会话标准工具包"一起注入。
		 *
		 * **不做可见性判断**：按钮永远显示（早先在渲染期判断并直接隐藏，用户找不到入口 ✗）。
		 * **也不做任何"当前设备"判断**（早先这里是"当前是「本机」→ 不下载"，用户实测指出这是错的：
		 * 坐在家里用浏览器打开设备A的页面时，浏览器里没有切换键、页面与文件都在设备A，
		 * 那条判断只会拦下一个本来完全可行的下载 ✗）。现在只校验**两项**：
		 * 拿不到文件路径 / 没有会话信息 → 一条明确的中文提示，绝不默默消失；两项齐了就走。
		 */
		function SaveAsAction(props) {
			beginHooks();
			var owner = asObject(props);
			// ownerProp：预览中的那个文件的 Host 绝对路径（**提供页面那台机器**上的路径）。
			var absolutePath = text(owner.absolutePath);
			// 标准 prop（session 作用域）：当前会话 id —— 文件读取按它授权（本机与目标机同一套）。
			var sessionId = text(owner.sessionId);
			function run() {
				if (absolutePath === "") {
					notify("另存为：拿不到文件路径（这个预览没有报出 Host 绝对路径），无法定位要下载的文件。请在有文件预览的标签页上使用。");
					return;
				}
				if (sessionId === "") {
					notify("另存为：没有会话信息（槽位没有给出 sessionId），文件读取按会话授权，无法据此定位文件。请从会话里打开文件再另存为。");
					return;
				}
				// 设备切换键是**可选**的：读到空串就带一个空的 device，
				// 宿主半据此读**页面所在这台机器**上的文件（这正是"浏览器打开远端页面"的场景）。
				var deviceIdOrEmpty = readCurrentId();
				var url = buildDownloadUrl(deviceIdOrEmpty, absolutePath, sessionId);
				if (navigateTo(url) !== true) notify("另存为：无法跳转到 " + url);
			}
			return renderToolbarAction({
				iconName: "IconDownloadOutlineRegular",
				label: "下载当前预览文件",
				title: "下载当前预览文件",
				// 只显示下载图标：这个标题栏按官方规格「只显示图标」，文字会让按钮比邻居宽一圈。
				iconOnly: true,
				testId: "save-as",
				onSelect: run,
			});
		}

		/**
		 * `sidebar.workspaces.session.menu.item`（list，root 作用域）末尾追加的行：**每台远程设备一行**「分叉到 <名字>」。
		 *
		 * 早先是自绘的「分叉到…」+ 下级菜单，字体/图标/hover 都跟内置行不一致，改成一台设备一行官方菜单项。
		 * 没有远程设备或还在加载 → 不显示；设备列表读取失败 → 显示一行提示项。
		 *
		 * 槽位的 ownerProps 是 `{ sessionId, displayTitle }`：前者是源会话 id，后者是源会话**标题** ——
		 * 一起放进 POST body（`sourceTitle`），宿主半拿它拼目标机上的新会话标题「<标题> - 来自<本机设备名>」。
		 * 标题缺失/为空时送空串，由宿主半兜底成「未命名会话」（这里绝不自己编标题）。
		 */
		function ForkMenuItem(props) {
			beginHooks();
			var owner = asObject(props);
			var viewPair = useStoredState({ status: "loading", devices: [], error: "" });
			var view = viewPair[0];
			var setView = viewPair[1];
			var refreshPair = useStoredState(0);
			var refresh = refreshPair[0];
			var closer = menuCloserFor(props, owner.useMenuOpenState);

			useStoredEffect(function () {
				var alive = true;
				request("/state").then(
					function (json) {
						if (!alive) return;
						var devices = asArray(asObject(json).devices).filter(function (entry) {
							return asObject(entry).local !== true;
						});
						setView({ status: "ready", devices: devices, error: "" });
					},
					function (error) {
						if (!alive) return;
						setView({ status: "error", devices: [], error: describeError(error) });
					},
				);
				return function () {
					alive = false;
				};
			}, [refresh]);

			if (view.status === "loading") return null;
			var sessionId = text(owner.sessionId);
			// ownerProps 里的会话标题（宿主半拼新会话标题要用）；不是字符串就当空串交给宿主半兜底。
			var sourceTitle = typeof owner.displayTitle === "string" ? owner.displayTitle : "";
			if (view.status === "error") {
				return renderMenuItem({
					iconName: "IconBranchOutlineRegular",
					label: "分叉到…（设备列表读取失败）",
					testId: "fork-error",
					close: closer,
					onSelect: function () { notify("分叉到：读取设备列表失败 —— " + view.error); },
				});
			}
			var remoteDevices = asArray(view.devices);
			if (remoteDevices.length === 0) return null;

			function fork(device) {
				var id = text(asObject(device).id);
				if (sessionId === "") {
					notify("分叉到：拿不到当前会话 id（槽位上下文里没有 sessionId），不会猜。请换一个会话再试。");
					return;
				}
				request(FORK_ROUTE, {
					method: "POST",
					body: JSON.stringify({ targetDeviceId: id, sourceSessionId: sessionId, sourceTitle: sourceTitle }),
				})
					.then(unwrap)
					.then(function (json) {
						var result = asObject(json);
						var name = text(result.targetDeviceName) === "" ? id : text(result.targetDeviceName);
						notify("已在 " + name + " 上创建会话 " + shortId(result.newSessionId) + "（带过去 " + text(result.messages) + " 条消息）。");
					})
					.catch(function (error) {
						notify("分叉失败：" + describeError(error));
					});
			}

			return h(
				react.Fragment,
				null,
				remoteDevices.map(function (device, index) {
					var id = text(asObject(device).id);
					var name = text(asObject(device).name) === "" ? id : text(asObject(device).name);
					return renderMenuItem({
						key: "device-" + String(index) + "-" + id,
						iconName: "IconBranchOutlineRegular",
						label: "分叉到 " + name,
						// 设备名**加重**（用户："要有明显的标识区分"）：children 传数组，
						// 名字放进一个 fontWeight 600 的 <span>，多设备时一眼可辨。
						content: ["分叉到 ", h("span", { key: "name", style: { fontWeight: 600 } }, name)],
						testId: "fork-" + id,
						close: closer,
						onSelect: function () { fork(device); },
					});
				}),
			);
		}

		//#endregion

		//#region 远端目录流：接管「添加工作区…」的目录选择（修「远端建工作区弹本机文件夹窗口」）

		/**
		 * 两个「目录流」洞（由 ui-workspace 的两个入口声明，kind = `single`）。
		 * 官方占据方由 `dsh-host-directory-picker-auto` 在**服务端**启动时按 (bindHost, win32, …) 选：
		 * 桌面机 + 只听回环 → `native`，它的 client half 是**无渲染**驱动，`pick` 只有两条路：
		 *
		 *   ① 页面里存在 `globalThis.__DSH_DIRECTORY_PICKER__`（桌面壳 preload 注入）→ 弹**本机**的
		 *      系统文件夹窗口 —— 这就是「远端建工作区弹本机窗口」的根因：页面在 A 台窗口里，
		 *      工作区却要建在 B 台；
		 *   ② 没有那个全局（纯浏览器）→ `uiWorkspace.pickDirectory()` 走 RPC 去 B 台开系统对话框，
		 *      而 B 台听的是非回环地址（否则 A 台连不上它），那时后端是 `browse`，
		 *      `pick` 会以 `directory-picker/unavailable` 失败 —— 一样用不了。
		 *
		 * 所以**远端模式**下我们接管这两个洞，渲染「对面机器的目录浏览」（数据源就是官方 browse
		 * 占据方用的那一对方法：`uiWorkspace.listDirectory / createDirectory`，它们经垫片改道到 B 台）。
		 */
		var DIR_FLOW_HOLES = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];

		/**
		 * 接管用的优先级。`single` 洞按 priority **升序**取每格第一个存活条目渲染
		 * （`entriesOfSlot`），同优先级重复注册会抛错，官方 browse 自己的报错文案就写着
		 * 「register at a different priority to shadow it (lowest renders)」，
		 * 这个洞在 inspect 里的 `replaceRisk` 也是 `shadows-shipped-ui`。
		 * 官方占据方在 0 —— 我们用 -1 就能在**不卸载**它的前提下接过来。
		 */
		var DIR_FLOW_PRIORITY = -1;

		/** 面板样式（全部内联；颜色走官方主题 token，取不到时给中性兜底）。 */
		var DIR_OVERLAY_STYLE = {
			position: "fixed",
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
			background: "rgba(0,0,0,.45)",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			zIndex: 4000,
		};
		var DIR_PANEL_STYLE = {
			width: "min(680px, 92vw)",
			maxHeight: "82vh",
			overflow: "auto",
			background: "var(--dsw-alias-bg-overlay, #ffffff)",
			color: "var(--dsw-alias-label-primary, inherit)",
			border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			borderRadius: 10,
			padding: "14px 16px",
			display: "grid",
			gap: 10,
			boxShadow: "0 12px 40px rgba(0,0,0,.28)",
		};
		var DIR_LIST_STYLE = {
			maxHeight: "46vh",
			overflow: "auto",
			border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))",
			borderRadius: 8,
			padding: 4,
			display: "grid",
			gap: 2,
		};
		var DIR_ROW_STYLE = {
			display: "block",
			width: "100%",
			textAlign: "left",
			padding: "6px 8px",
			background: "transparent",
			color: "inherit",
			border: 0,
			borderRadius: 6,
			cursor: "pointer",
			font: "inherit",
		};
		var DIR_CRUMB_STYLE = {
			padding: "2px 6px",
			background: "transparent",
			color: "var(--dsw-alias-brand-primary, #2b6cb0)",
			border: 0,
			cursor: "pointer",
			font: "inherit",
			fontSize: 12,
		};
		var DIR_FOOT_STYLE = { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" };

		/** 远端模式：垫片按 `SWITCH_KEY` 决定要不要把 api 流量改道到另一台机器。 */
		function isRemoteMode() {
			return readCurrentId() !== "";
		}

		/**
		 * 把 `uiWorkspace.listDirectory / createDirectory` 抛出的错误拆成 code + message。
		 * 官方 browse 占据方读的是 `error.rpcError.{code,message}`；形状不稳，所以逐层找，
		 * 都没有就退回 describeError。
		 */
		function browseFailureInfo(reason) {
			var raw = asObject(reason);
			var rpc = asObject(raw.rpcError);
			var code = text(rpc.code) !== "" ? text(rpc.code) : text(raw.code);
			var message = text(rpc.message) !== "" ? text(rpc.message) : text(raw.message);
			if (message === "") message = describeError(reason);
			return { code: code, message: message };
		}

		/**
		 * 目录流占据方：对面机器的目录浏览对话框。
		 *
		 * 与官方 owner 的约定（inspect 里的 `DirectoryFlowOwnerProps`）：
		 * `open` 升起时跑**一次**交互并只报一个结果 —— `onPicked(绝对路径)` / `onCancel()` /
		 * `onError(文案)`；`busy` 为真表示 owner 正在接纳选中的路径（禁用提交按钮）。
		 *
		 * 业务注入由 `dirFlowInjected` 提供：`listDirectory / createDirectory / pickDirectory / deviceId`。
		 */
		function RemoteDirectoryFlow(props) {
			beginHooks();
			// 想加载的目标（token 递增 = 重新加载；path 空串 = 对面机器的家目录）。
			var requestPair = useStoredState({ token: 1, path: "" });
			var wanted = requestPair[0];
			var setWanted = requestPair[1];
			// 已经处理过的请求（token = -1 表示"对话框关着"）。
			var viewPair = useStoredState({ token: -1, phase: "idle", listing: null, error: "", code: "" });
			var view = viewPair[0];
			var setView = viewPair[1];
			var namePair = useStoredState("");
			var deviceName = namePair[0];
			var setDeviceName = namePair[1];
			var inputPair = useStoredState("");
			var newName = inputPair[0];
			var setNewName = inputPair[1];
			var createPair = useStoredState({ busy: false, error: "" });
			var creating = createPair[0];
			var setCreating = createPair[1];
			// 直接输入对面机器上的绝对路径：对面解析成"系统对话框后端"时官方 list 根本不可用，
			// 这条路不依赖对面的任何后端，任何机器都能用。
			var manualPair = useStoredState("");
			var manualPath = manualPair[0];
			var setManualPath = manualPair[1];

			var open = props.open === true;
			var listDirectory = props.listDirectory;
			var createDirectory = props.createDirectory;
			var pickDirectory = props.pickDirectory;
			var deviceId = text(props.deviceId);
			var deviceLabel = deviceName !== "" ? deviceName : deviceId === "" ? "对面机器" : deviceId;

			useStoredEffect(function () {
				if (!open) {
					// 关掉：游标归到 -1（下次 open 一定会重新加载），并把目标重置回家目录。
					if (view.token !== -1) setView({ token: -1, phase: "idle", listing: null, error: "", code: "" });
					if (wanted.path !== "") setWanted({ token: wanted.token, path: "" });
					return undefined;
				}
				// 这个 token 已经处理过 → 什么都不做（React 与自测的渲染循环都会重复跑 effect）。
				if (view.token === wanted.token) return undefined;
				// 注意：这里**不许**同步 setState 去写"读取中" —— 那会立刻触发一次重渲染，
				// 本轮 effect 的清理函数随即把在途请求的 alive 关掉，回调就再也落不了地（永远"读取中"）。
				// "读取中"是**派生**出来的（见下面的 isLoading）。
				var token = wanted.token;
				var path = wanted.path === "" ? undefined : wanted.path;
				var alive = true;
				var startListing = function () {
					if (!alive) return;
					listDirectory(path, undefined).then(
						function (listing) {
							if (!alive) return;
							setView({ token: token, phase: "ready", listing: asObject(listing), error: "", code: "" });
						},
						function (reason) {
							if (!alive) return;
							var info = browseFailureInfo(reason);
							setView({ token: token, phase: "error", listing: null, error: info.message, code: info.code });
						},
					);
				};
				// 先读宿主的设备表（`/plugin/remote/**` 在远端模式下仍打在页面所在这台）：
				//  ① 拿设备名（装饰用）；
				//  ② **选中的正是"本机自己"那一台**时把交互交回官方原行为 —— 那种状态下
				//     官方占据方用的是桌面壳注入的系统对话框（正常好用），我们不该抢；
				//     我们自己的目录列表反而会因为"本机 = 回环 + 原生后端"而失败。
				request("/state").then(
					function (json) {
						if (!alive) return;
						var entry = findDevice(asArray(asObject(json).devices), deviceId);
						if (entry !== null && asObject(entry).local === true) {
							setView({ token: token, phase: "local", listing: null, error: "", code: "" });
							useOSChooser();
							return;
						}
						if (entry !== null && text(asObject(entry).name) !== "") setDeviceName(text(asObject(entry).name));
						startListing();
					},
					function () {
						// 设备表读不到（插件接口不可达等）：按"对面"处理，继续列目录，名字退化成 id。
						startListing();
					},
				);
				return function () {
					alive = false;
				};
			}, [open, wanted.token, wanted.path]);

			if (!open) return null;

			// 这一轮的目标还没落地 = 读取中（派生，不写状态）。
			var isLoading = view.token !== wanted.token;
			var phase = isLoading ? "loading" : view.phase;
			// 目标是**本机自己**那一台：交互已经交回官方占据方（桌面壳的系统文件夹窗口），
			// 我们连自己的弹窗都不渲染 —— 屏幕上只该有那个系统窗口，别多一层遮挡。
			if (phase === "local") return null;
			var listing = asObject(view.listing);
			var crumbs = asArray(listing.crumbs);
			var entries = asArray(listing.entries);
			var current = text(listing.path);
			// 对面已有工作区目录（同步读客户端会话快照；取不到就是空数组）。
			var candidates = typeof props.candidates === "function" ? asArray(props.candidates()) : [];

			/** 去某个目录（token +1 触发重新加载；顺手清掉上一次建目录的错误）。 */
			function go(path) {
				if (creating.busy === true || creating.error !== "") setCreating({ busy: false, error: "" });
				setWanted({ token: wanted.token + 1, path: text(path) });
			}

			/** 在当前目录下建一个子目录，然后刷新当前目录。 */
			function createChild() {
				var name = newName.trim();
				if (name === "" || current === "") return;
				setCreating({ busy: true, error: "" });
				createDirectory(current, name).then(
					function () {
						setNewName("");
						setCreating({ busy: false, error: "" });
						go(current);
					},
					function (reason) {
						setCreating({ busy: false, error: browseFailureInfo(reason).message });
					},
				);
			}

			/** 官方后端只能开对面机器的系统对话框时（native）的兜底入口。 */
			function useOSChooser() {
				if (typeof pickDirectory !== "function") return;
				pickDirectory().then(
					function (picked) {
						if (picked === null || picked === undefined || text(picked) === "") props.onCancel();
						else props.onPicked(text(picked));
					},
					function (reason) {
						props.onError(browseFailureInfo(reason).message);
					},
				);
			}

			var rows = [];
			if (crumbs.length > 1) {
				rows.push(
					h(
						"button",
						{ key: "up", type: "button", style: DIR_ROW_STYLE, onClick: function () { go(asObject(crumbs[crumbs.length - 2]).path); } },
						"⬆ 上一层",
					),
				);
			}
			for (var index = 0; index < entries.length; index += 1) {
				(function buildRow(entry) {
					var entryPath = text(entry.path);
					rows.push(
						h(
							"button",
							{
								key: "dir-" + String(index) + "-" + entryPath,
								type: "button",
								style: DIR_ROW_STYLE,
								onClick: function () { go(entryPath); },
							},
							"📁 " + text(entry.name),
						),
					);
				})(asObject(entries[index]));
			}
			if (rows.length === 0 && phase === "ready") {
				rows.push(h("div", { key: "empty", style: HINT_STYLE }, "这个目录下没有子目录。"));
			}

			var children = [];
			children.push(h("div", { key: "title", style: { fontWeight: 600, fontSize: 14 } }, "选择 " + deviceLabel + " 上的目录"));
			children.push(
				h(
					"div",
					{ key: "hint", style: HINT_STYLE },
					"这是对面机器（" + deviceLabel + "）的文件系统，不是本机的；选中的路径会在那台机器上建工作区。",
				),
			);
			if (crumbs.length > 0 && phase === "ready") {
				children.push(
					h(
						"div",
						{ key: "crumbs", style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 } },
						crumbs.map(function (crumb, crumbIndex) {
							var item = asObject(crumb);
							return h(
								"button",
								{
									key: "crumb-" + String(crumbIndex),
									type: "button",
									style: DIR_CRUMB_STYLE,
									onClick: function () { go(text(item.path)); },
								},
								crumbIndex === 0 ? text(item.path) : text(item.name),
							);
						}),
					),
				);
			}
			if (phase === "loading") {
				children.push(h("div", { key: "loading", style: HINT_STYLE }, "读取 " + deviceLabel + " 的目录…"));
			}
			if (phase === "local") {
				// 选中的是本机自己那一台：交互已经交回官方占据方（桌面壳的系统文件夹窗口）。
				children.push(h("div", { key: "local", style: HINT_STYLE }, "选中的这台就是本机：正在打开本机的系统文件夹窗口…"));
			}
			if (phase === "error") {
				// 对面是"系统对话框后端"时官方那句英文（`directoryPicker.list needs the browse capability…`）
				// 不像人话，也**不是**故障 —— 换成中文说清"是什么限制"，英文原文不再往界面上抛。
				var rawError = text(view.error);
				var unavailable = view.code === "directory-picker/unavailable";
				children.push(
					h(
						"div",
						{ key: "error", style: ERROR_STYLE },
						unavailable ? "读不到 " + deviceLabel + " 的目录列表：那台只提供「系统对话框」式的选择。" : "读取失败：" + rawError,
					),
				);
				if (unavailable) {
					children.push(
						h(
							"div",
							{ key: "error-hint", style: HINT_STYLE },
							"可以直接在下面输入那台机器上的绝对路径，或者点上面「已有的工作区目录」；" +
								"也可以在那台机器上用它自己屏幕上的对话框。",
						),
					);
				}
			}
			if (phase === "ready") {
				children.push(h("div", { key: "list", style: DIR_LIST_STYLE }, rows));
				if (listing.truncated === true) {
					children.push(h("div", { key: "truncated", style: HINT_STYLE }, "目录里条目太多，只列出了前一部分。"));
				}
				children.push(
					h("div", { key: "path", style: { fontSize: 12, wordBreak: "break-all", opacity: 0.75 } }, "当前：" + current),
				);
			}
			if (creating.error !== "") {
				children.push(h("div", { key: "create-error", style: ERROR_STYLE }, "新建文件夹失败：" + creating.error));
			}

			var footer = [];
			if (phase === "ready") {
				footer.push(
					h(
						"div",
						{ key: "create", style: { display: "flex", gap: 6, alignItems: "center" } },
						h("input", {
							key: "name",
							style: INPUT_STYLE,
							placeholder: "新文件夹名",
							value: newName,
							onChange: function (event) { setNewName(text(asObject(event.target).value)); },
						}),
						h(
							"button",
							{
								key: "create-btn",
								type: "button",
								style: BTN_STYLE,
								disabled: creating.busy === true,
								onClick: createChild,
							},
							creating.busy === true ? "创建中…" : "新建文件夹",
						),
					),
				);
			} else {
				footer.push(h("div", { key: "create-placeholder" }, ""));
			}
			// 对面**已有工作区**的目录：不依赖对面的可浏览后端（远端模式下这份快照就是对面的），
			// 点一下就选中 —— 这是"列不出目录"时最省事的一条路。
			if (phase !== "local" && candidates.length > 0) {
				children.push(
					h(
						"div",
						{ key: "candidates", style: { display: "grid", gap: 4 } },
						h("div", { key: "candidates-title", style: HINT_STYLE }, "对面已有的工作区目录（点一下就选它）："),
						h(
							"div",
							{ key: "candidates-rows", style: { display: "flex", flexWrap: "wrap", gap: 6 } },
							candidates.map(function (candidate, index) {
								return h(
									"button",
									{
										key: "candidate-" + String(index),
										type: "button",
										style: BTN_STYLE,
										disabled: props.busy === true,
										onClick: function () { props.onPicked(candidate); },
									},
									candidate,
								);
							}),
						),
					),
				);
			}
			// **不依赖对面后端**的兜底：直接输入对面机器上的绝对路径。
			// 对面解析成"系统对话框后端"（Windows + 只听回环 = 默认）时官方 list 不可用，
			// 这时只有输入框这一条路能把工作区建到对面那台机器上。
			// 目标是**本机自己**那一台时不显示（那种情况已经交回官方系统对话框）。
			if (phase !== "local") {
				var manualInput = h("input", {
					key: "manual-path",
					style: INPUT_STYLE,
					placeholder: "或直接输入对面机器上的绝对路径（例如 D:\\work\\项目）",
					value: manualPath,
					onChange: function (event) { setManualPath(text(asObject(event.target).value)); },
				});
				footer.push(
					h(
						"div",
						{ key: "manual", style: { display: "flex", gap: 6, alignItems: "center", width: "100%", flexWrap: "wrap" } },
						manualInput,
						h(
							"button",
							{
								key: "manual-btn",
								type: "button",
								style: BTN_STYLE,
								disabled: manualPath.trim() === "" || props.busy === true,
								onClick: function () { props.onPicked(manualPath.trim()); },
							},
							"用这个路径",
						),
					),
				);
			}
			var actions = [];
			if (phase === "error") {
				// 对面是系统对话框后端时"重试"必然还是同样的结果，不摆一个按了没用的按钮。
				if (view.code !== "directory-picker/unavailable") {
					actions.push(
						h(
							"button",
							{ key: "retry", type: "button", style: BTN_STYLE, onClick: function () { go(wanted.path); } },
							"重试",
						),
					);
				}
				if (view.code === "directory-picker/unavailable" && typeof pickDirectory === "function") {
					actions.push(
						h(
							"button",
							{ key: "os-chooser", type: "button", style: BTN_STYLE, onClick: useOSChooser },
							"用对面机器的系统选择器",
						),
					);
				}
			}
			if (phase === "ready") {
				actions.push(
					h(
						"button",
						{
							key: "pick",
							type: "button",
							style: BTN_STYLE,
							disabled: props.busy === true,
							onClick: function () { props.onPicked(current); },
						},
						props.busy === true ? "正在创建…" : "用这个目录",
					),
				);
			}
			actions.push(h("button", { key: "cancel", type: "button", style: BTN_STYLE, onClick: function () { props.onCancel(); } }, "取消"));
			footer.push(h("div", { key: "actions", style: { display: "flex", gap: 8 } }, actions));
			children.push(h("div", { key: "footer", style: DIR_FOOT_STYLE }, footer));

			return h("div", { key: "overlay", style: DIR_OVERLAY_STYLE }, h("div", { key: "panel", style: DIR_PANEL_STYLE }, children));
		}

		//#endregion

		/**
		 * 远端模式下接管两个目录流洞；本机模式**什么都不做** —— 官方占据方
		 * （系统对话框，或可浏览模式下的应用内对话框）在本机就是对的，我们不许抢。
		 *
		 * 注册顺序：本函数在 `apply` 的**最后**调用，设置页仍是第一项注册。
		 */
		function registerDirectoryFlow(ctx) {
			if (!isRemoteMode()) return;
			/**
			 * 目录流占据方的业务注入。用的就是官方 browse 占据方那一对方法：
			 * 它们在远端模式下经垫片改道到**对面那台机器**（这正是我们要的），
			 * 所以列表/新建都发生在对面，而不是本机。
			 */
			var dirFlowInjected = function () {
				return {
					listDirectory: function (path, signal) {
						return ctx.uiWorkspace.listDirectory(path, signal);
					},
					createDirectory: function (path, name) {
						return ctx.uiWorkspace.createDirectory(path, name);
					},
					pickDirectory: function () {
						return ctx.uiWorkspace.pickDirectory();
					},
					deviceId: readCurrentId(),
					/**
					 * 对面**已有工作区**的目录（去重、排序、最多 8 条）。
					 *
					 * 来源是客户端自己的会话快照（`sessions.list.getSnapshot().byId[*].cwd`）——远端模式下
					 * 这份快照本来就是**对面那台机器**的（垫片把 api 流量改道过去），所以不新增任何网络入口、
					 * 也不要求对面有可浏览后端，就能给出"点一下就选它"的候选目录。
					 */
					candidates: function () {
						try {
							var snapshot = asObject(ctx.sessions.list.getSnapshot());
							var byId = asObject(snapshot.byId);
							var out = [];
							for (var key in byId) {
								if (Object.prototype.hasOwnProperty.call(byId, key) !== true) continue;
								var cwd = text(asObject(byId[key]).cwd);
								if (cwd === "" || out.indexOf(cwd) !== -1) continue;
								out.push(cwd);
							}
							out.sort();
							return out.slice(0, 8);
						} catch (error) {
							// 会话服务不可用（老版本 / 注入失败）：候选为空，输入框那条路照常。
							return [];
						}
					},
				};
			};
			// 两个洞各自要等自己的声明出现（ui-workspace 的入口可能晚于我们激活，
			// 声明还可能被替换），官方占据方也是这么嵌套 inject 的。
			ctx.slots.inject(DIR_FLOW_HOLES[0], function () {
				return ctx.slots.inject(DIR_FLOW_HOLES[1], function () {
					return [
						ctx.slots.register({ name: DIR_FLOW_HOLES[0], priority: DIR_FLOW_PRIORITY, inject: dirFlowInjected }, RemoteDirectoryFlow),
						ctx.slots.register({ name: DIR_FLOW_HOLES[1], priority: DIR_FLOW_PRIORITY, inject: dirFlowInjected }, RemoteDirectoryFlow),
					];
				});
			});
		}

		//#region 功能 4：设备面板（把探针插件 @local/dsh-device-panel 的客户端 UI 并进来）

		/**
		 * 并入的三件 UI（用户定稿的"合并形态"）：
		 *   ① 侧栏「自动化任务」那一组下面的一行「设备 · <当前设备名>」——**原生 DOM 注入**；
		 *      点它 = 开浮层 + 清**本机**未读；带状态点；窄栏隐藏文字与点；样式对齐官方那一行；
		 *   ② 官方 `shell.overlay` 里的浮层菜单（一行一台设备：状态点 + 名字，点一下切设备并清那台的未读）；
		 *   ③ 垫片那颗「设备切换胶囊」——**宿主半已整段删除（垫片不画任何 UI）**，客户端半这边
		 *      原来往胶囊里塞的那个「集合态」点也**整段删掉**（它已经没有落点）。集合态改挂在
		 *      ① 那一行的点上：本机 + 全部对端按同一优先级取最高者。
		 *
		 * 状态点分工（用户定稿，别搞混）：
		 *   - 侧栏那一行 `-dot` = **集合态**（所有设备里最要紧的那个）：红 > 琥珀 > 绿 > 灰圈 > 无点；
		 *   - 浮层里每一行 = **那一台自己的状态**；
		 *   - `ongoing` 一律画成**转圈**（原生 DOM 的点不会自己动，见 `applyDotStyle`）。
		 *
		 * 数据源**只有宿主半已上线的同源路由**（绝不再碰探针自己那两个取数路由）：
		 *   GET  /plugin/remote/live      2 秒轮询 → `{ at, self:{name,live}, peers:[{id,name,reachable,lastError,live|null}] }`
		 *   GET  /dsh-remote-view         上面那条失败 / 403 / 形状不认识时的退路（**非 `/plugin/` 前缀**，
		 *                                 所以浏览器经 edge 读得到）：**同形 + `version`**
		 *   POST /plugin/remote/live/seen body `{ "id": "<设备 id>" }`（本机用空串）
		 *
		 * 状态语义（一台设备同一时刻只画一个点，优先级 **红 > 琥珀 > 绿 > 灰圈 > 无点**）：
		 *   `reachable === false` ⇒ 红；`live === null` ⇒ **不画点**（未知 ≠ 不可达，绝不画红）；
		 *   `pending > 0` ⇒ 琥珀；`unread` ⇒ 绿；`running > 0` ⇒ 灰圈；其余不画点。
		 *
		 * 与探针**共存**（两个插件同时装在页面里时只能有一份 UI、且不互相拆台）：
		 *   ① 注入行的 DOM id / 属性与探针逐字一致（dsh-device-panel-row / -icon / -label / -dot），
		 *      并且**先认领再插入**：`getElementById(ROW_ID)` 已经有就只做样式对齐，绝不插第二条；
		 *   ② 垫片那块**不画任何 UI**（胶囊面板与左上角按钮都已整段删除）⇒ 我们也不碰它
		 *      （不找 toggle、不插点、不补挂）；
		 *   ③ 槽位注册前先 `ctx.slots.entries(槽名)`：已经有探针那条等价条目就整条跳过。
		 *
		 * 不许回退的历史修复：
		 *   - 注入的是**原生 DOM**，绝不把 React 元素 appendChild 进 React 子树（2026-10-16 白屏的原因之一）；
		 *   - 那一行的点也是原生 DOM，`ongoing` 靠 `@keyframes` 自旋（自己画的，不依赖官方 React 组件）；
		 *   - 观察器只观察 `{childList, subtree}`，且每次写 DOM 前先比"状态键"，没变就一个字节都不写
		 *     ⇒ 不会自激成环；
		 *   - 窄栏（自己那行量出来 < 120px）隐藏文字与状态点；
		 *   - live 轮询 5 秒；页面隐藏时停，回到前台立刻拉一次；
		 *   - `ctx.effect` 的清理函数移除**自己插入的**节点、断开观察器、停掉全部定时器与监听。
		 *
		 * 探针原来那条日志上报路由（`POST` 到它自己的 `/log`）随探针一起丢掉：
		 * 这里只写 `console.debug`，**不写网络**，且只在状态真的变化时写一条（不刷屏）。
		 */

		/** 注入那一行的 DOM id（与探针逐字一致 ⇒ 共存时靠它"先认领再插入"）。 */
		var ROW_ID = "dsh-device-panel-row";
		/** 浮层在 `shell.overlay` 里的注册 id。 */
		var PANEL_OVERLAY_ID = "remote-live-overlay";
		/**
		 * 槽位里算"等价条目"的注册 id：**探针那条**（`remote-devices-overlay`，两个插件共存时的情况）
		 * 与**我们自己那条**（万一把 apply 跑了两遍）。已经有就不插第二条。
		 */
		var PANEL_OVERLAY_EQUIVALENT_IDS = [PANEL_OVERLAY_ID, "remote-devices-overlay"];
		/** 认不出 id 时的退路：按组件名判等价。 */
		var PANEL_OVERLAY_EQUIVALENT_COMPONENTS = ["OverlayEntry"];
		/** 主数据源：宿主半的跨机聚合（同源）。 */
		var LIVE_ROUTE = "/plugin/remote/live";
		/**
		 * **浏览器口（0.12.0）**：与上面那条**同形**的聚合 + 一个 `version` 字段，**非 `/plugin/` 前缀**
		 * ⇒ 能穿过 edge（edge 只拦 `/plugin/`）。走 edge 打开页面时 `/plugin/remote/live` 永远 403，
		 * 这条是浏览器 / 手机唯一的取数口（状态点就靠它）。
		 */
		var VIEW_ROUTE = "/dsh-remote-view";
		/**
		 * **客户端半自己的版本**：与 `package.json` 和宿主半 `lib/index.js` 的 `VERSION` 逐字一致
		 * （自测有一条断言盯这三处，防漂移）。宿主半报的 `version` 与它不一致时只在 title / 日志里
		 * 提示"建议升级"，**绝不改状态点的颜色**。
		 */
		var CLIENT_VERSION = "0.21.0";
		/** 宿主半在聚合里报的版本（空串 = 没拿到 / 老版本 ⇒ 不比较、不提示）。 */
		var liveHostVersion = "";
		/** 清"未读完成"：body `{ id }`（空串 = 本机）。 */
		var LIVE_SEEN_ROUTE = "/plugin/remote/live/seen";
		/**
		 * 垫片**发布的隐藏 JSON 节点** id（`<script type="application/json" id="dsh-remote-devices">`，
		 * 不渲染、不占位）。与宿主半 `lib/index.js` 的 `SHIM_DEVICES_NODE_ID` 逐字一致。
		 */
		var SHIM_DEVICES_NODE_ID = "dsh-remote-devices";
		/** live 轮询间隔（与宿主半轮询对端的节奏同一个数：2 秒）。 */
		var LIVE_POLL_MS = 2000;
		/** 侧栏行"没了就补回来"的定时补偿间隔。 */
		var ROW_WATCH_MS = 2000;
		/** 侧栏行状态点的尺寸：平时 6px 实心圆；`ongoing` 转圈时 14px（官方 ongoing 的观感）。 */
		var ROW_DOT_SIZE = 6;
		var ROW_DOT_SPIN_SIZE = 14;
		/** 注入的防抖（观察器回调会刷得很密）。 */
		var ROW_DEBOUNCE_MS = 120;
		/** 窄栏判定：自己那行量出来 < 这个宽度 = 窄栏（只留图标，与官方行一致）。 */
		var ROW_RAIL_MAX = 120;
		/** 侧栏的横向边界：找锚点时只认靠左的候选（主内容区也可能出现同名文字）。 */
		var SIDEBAR_MAX_LEFT = 360;
		/** 注入锚点：官方「自动化任务」那一组的行文案（换语言时这里要跟着加）。 */
		var ANCHOR_LABELS = ["自动化任务", "Scheduled tasks", "Automations"];
		/** 找不到上面那一行时的退路锚点：侧栏里「工作区」块的标题。 */
		var WORKSPACE_LABELS = ["工作区", "Workspaces", "Workspace"];

		/** 面板用的颜色 token（与探针同一套；取不到就中性兜底）。 */
		var PANEL_C = {
			text: "var(--dsw-alias-label-primary, inherit)",
			dim: "var(--dsw-alias-label-secondary, rgba(128,128,128,.85))",
			surface: "var(--dsw-alias-bg-overlay, #ffffff)",
			brand: "var(--dsw-alias-brand-primary, #2b6cb0)",
			error: "var(--dsw-alias-state-error-primary, #d9483b)",
			online: "var(--dsw-alias-state-success-primary, #2e7d32)",
			offline: "var(--dsw-alias-state-idle-primary, rgba(128,128,128,.5))",
			warn: "var(--dsw-alias-state-warn-primary, #b7791f)",
		};

		/** 面板日志：**只走 console.debug，不写网络**（探针那条上报路由已丢掉）。 */
		function panelLog(message) {
			try {
				var console_ = globalThis.console;
				if (console_ !== null && console_ !== undefined && typeof console_.debug === "function") {
					console_.debug("[dsh-remote/panel] " + text(message));
				}
			} catch (error) {
				/* 没有 console：什么都不做 */
			}
		}

		//#region 实时状态（本机 self.live + 全部 peers[]）

		/**
		 * **本机**"活"状态（宿主半每隔 5 秒在进程内问一次会话服务，这里只负责取回来 + 广播）：
		 *   `running > 0` = 灰圈；`pending > 0` = 琥珀；`unread` = 绿（点那台设备才清）。
		 * **不猜**：一次都没成功拿到过（`have === false`）就什么都不画。
		 */
		var liveSelf = { running: 0, pending: 0, unread: false, doneAt: 0, have: false };
		/**
		 * 本机被认领的那条设备的名字（宿主半 `self.name`；空串 = 没认领到 / 老版本宿主半）。
		 * 浮层里本机那条的文案用它；拿不到就退回想来的「本机」。
		 */
		var liveSelfName = "";
		/** 各对端最近一次聚合快照：`[{ id, name, reachable, lastError, live|null }]`。 */
		var livePeers = [];
		/** 数据来源标记（`"live"` = 聚合路由；空串 = 还没拿到过）。 */
		var liveSource = "";
		/** 数据版本号（订阅者用它触发重渲染，暂停/恢复也不会读到过期那份）。 */
		var liveRevision = 0;
		/** 订阅者（React 的 setState + 原生那行的点 + 胶囊集合态共用）。 */
		var liveListeners = [];
		/** 上一次广播出去的判定键（`""` = 还没广播过 ⇒ 第一次一定要通知）。 */
		var liveLastKey = "";
		/** live 的退订句柄（卸载时要用）。 */
		var liveUnsub = null;

		/** 数字字段：不是有限正数就当 0（坏数据不能把 UI 带偏）。 */
		function asCount(value) {
			var n = Number(value);
			return Number.isFinite(n) && n > 0 ? n : 0;
		}

		/** 日志摘要：本机 + 每台"有状态/不可达"的对端（没数据的对端不提，别把"没数据"说成"空闲"）。 */
		function liveSummary() {
			var own = localLiveState();
			var parts = ["本机=" + (liveSource === "" ? "无数据" : (own === "" ? "空闲" : own))];
			for (var index = 0; index < livePeers.length; index += 1) {
				var peer = asObject(livePeers[index]);
				var state = peerState(peer);
				if (state === "") continue;
				parts.push(text(peer.id) + "=" + state);
			}
			return parts.join(" ");
		}

		/**
		 * 幂等广播：**只有真的变了**才惊动订阅者（每 5 秒一次，白白重渲染会拖慢页面）。
		 * 判定键 = 本机名字 + 四个字段 + 对端表（id / reachable / 四个字段）；`at` 这类时间戳不参与
		 * （它每次都变，参与就等于每 5 秒刷一次屏）。
		 */
		function publishLive(self, peers, source, selfName) {
			var record = asObject(self);
			var nextPeers = asArray(peers);
			var nextName = text(selfName).trim();
			var key = [asCount(record.running), asCount(record.pending), record.unread === true ? 1 : 0, asCount(record.doneAt)].join(",");
			key += "|" + nextName;
			for (var index = 0; index < nextPeers.length; index += 1) {
				var peer = asObject(nextPeers[index]);
				var peerLive = peer.live === null || peer.live === undefined ? null : asObject(peer.live);
				key += "|" + text(peer.id) + "," + (peer.reachable === false ? 0 : 1) + ","
					+ (peerLive === null ? "-" : [asCount(peerLive.running), asCount(peerLive.pending), peerLive.unread === true ? 1 : 0, asCount(peerLive.doneAt)].join(","));
			}
			var changed = liveSelf.have !== true || liveSource !== source || key !== liveLastKey;
			liveSelf = {
				running: asCount(record.running),
				pending: asCount(record.pending),
				unread: record.unread === true,
				doneAt: asCount(record.doneAt),
				have: true,
			};
			livePeers = nextPeers;
			liveSource = source;
			liveSelfName = nextName;
			liveLastKey = key;
			// 状态变了才写一条日志：**别每 5 秒刷屏**。
			if (changed) panelLog("状态更新（" + text(source) + "）：" + liveSummary());
			var list = liveListeners.slice();
			for (var at = 0; at < list.length; at += 1) {
				try {
					list[at](liveRevision + 1);
				} catch (error) {
					/* 订阅者出错不影响别人 */
				}
			}
			liveRevision += 1;
		}

		/** 订阅（React 的 setState + 原生那行的点 + 胶囊集合态共用）。 */
		function subscribeLive(listener) {
			liveListeners.push(listener);
			return function () {
				var at = liveListeners.indexOf(listener);
				if (at !== -1) liveListeners.splice(at, 1);
			};
		}

		/**
		 * React 侧订阅（浮层里那几行点 + 那一行的点随 live 变化重画）。
		 * 用**版本号**做状态：`liveSelf` / `livePeers` 是模块级可变对象，直接 setState 旧对象会被
		 * React 判成"没变"而跳过重渲染。
		 */
		function useLive() {
			var pair = react.useState(liveRevision);
			var setState = pair[1];
			react.useEffect(function () {
				setState(liveRevision);
				return subscribeLive(setState);
			}, []);
			return liveRevision;
		}

		/** 一份 live（本机或对端）→ 官方状态 key（没数据 / 空闲返回空串 = 不画点）。 */
		function liveStateOf(live) {
			var record = asObject(live);
			if (asCount(record.pending) > 0) return "warning";
			if (record.unread === true) return "done";
			if (asCount(record.running) > 0) return "ongoing";
			return "";
		}

		/** 本机 live → 官方状态 key（一次都没拿到数据 ⇒ 空串 = 不画点）。 */
		function localLiveState() {
			if (liveSelf.have !== true) return "";
			return liveStateOf(liveSelf);
		}

		/** 对端一条 `{ reachable, live }` → 官方状态 key（**`reachable:false` 才是红**；`live:null` = 不画点）。 */
		function peerState(peer) {
			var record = asObject(peer);
			if (record.reachable === false) return "error";
			if (record.live === null || record.live === undefined) return "";
			return liveStateOf(record.live);
		}

		/**
		 * 聚合形状认识吗？**只认这一种**：`self` 是对象、`peers` 是数组。
		 * 认不出来（老版本 / 别的东西占了这个路径 / HTML 错误页）就**什么都不做** ——
		 * 保持上一次的数据，不清零、也不拿错数据画点。
		 */
		function isLiveShape(json) {
			var value = asObject(json);
			return value.self !== null && typeof value.self === "object" && isArray(value.peers);
		}

		/** 对端清洗：只留结构合法的条目（`id` 非空、`live` 是对象或 null），坏条目一律丢掉。 */
		function cleanPeers(raw) {
			var list = asArray(raw);
			var out = [];
			for (var index = 0; index < list.length; index += 1) {
				var peer = list[index];
				if (peer === null || typeof peer !== "object") continue;
				var id = text(peer.id).trim();
				if (id === "") continue;
				var rawLive = peer.live;
				var live = rawLive === null || rawLive === undefined ? null : (typeof rawLive === "object" ? rawLive : null);
				out.push({
					id: id,
					name: text(peer.name),
					reachable: peer.reachable !== false,
					lastError: text(peer.lastError),
					live: live,
				});
			}
			return out;
		}

		/** 按 id 取聚合里的那台对端（没有返回 null）。 */
		function livePeer(id) {
			var target = text(id).trim();
			if (target === "") return null;
			for (var index = 0; index < livePeers.length; index += 1) {
				var peer = asObject(livePeers[index]);
				if (text(peer.id).trim() === target) return peer;
			}
			return null;
		}

		/** 按 id 取那台设备的名字（聚合里的 `name` 优先；取不到返回空串）。 */
		function livePeerName(id) {
			var peer = livePeer(id);
			return peer === null ? "" : text(asObject(peer).name);
		}

		/** 按 id 取**当前状态**（本机 = 空串 id / `local`；对端 = peers 里的 id）；取不到返回空串。 */
		function deviceStateById(id, isLocal) {
			if (isLocal === true) return localLiveState();
			var peer = livePeer(id);
			return peer === null ? "" : peerState(peer);
		}

		/**
		 * 每设备状态表（**只收"有数据 / 真的不可达"的设备**），供集合态与那一行/浮层的点共用：
		 *   ① 本机一条（状态来自 `self.live`）；
		 *   ② 聚合里的每一台对端（`live:null` ⇒ 空串被跳过；`reachable:false` ⇒ `"error"`）。
		 * 未知 ≠ 不可达：红只能来自"真的连不上"，绝不会因为"这台没拿到数据"就报红。
		 */
		function deviceStateTable() {
			var table = [{ id: "", local: true, state: localLiveState() }];
			for (var index = 0; index < livePeers.length; index += 1) {
				var peer = asObject(livePeers[index]);
				var id = text(peer.id).trim();
				if (id === "") continue;
				table.push({ id: id, local: false, state: peerState(peer) });
			}
			return table;
		}

		/**
		 * **纯函数**：每设备状态表 → 集合态（用户锁定的优先级，不要改）。
		 *   琥珀 warning > 绿 done > 灰圈 ongoing > 红 error > **不画点（空串）**。
		 *   （2026-10-17 用户改序：**红放最低** —— 多设备时只要有一台离线，红就会长期把其它设备的
		 *    当前态全盖掉；红只该在"没有更值得看的状态"时出现。）
		 * "没有数据"的设备（state 空 / 认不出来）一律跳过 —— 未知 ≠ 不可达。
		 */
		function aggregateDot(states) {
			var list = asArray(states);
			var best = "";
			var bestRank = 0;
			for (var index = 0; index < list.length; index += 1) {
				var item = list[index];
				var state = "";
				if (typeof item === "string") state = item;
				else if (item !== null && item !== undefined && typeof item === "object") state = text(asObject(item).state);
				state = text(state).trim();
				var rank = 0;
				if (state === "warning") rank = 4;
				else if (state === "done") rank = 3;
				else if (state === "ongoing") rank = 2;
				else if (state === "error") rank = 1;
				if (rank > bestRank) {
					bestRank = rank;
					best = state;
				}
			}
			return best;
		}

		//#endregion

		//#region 取数（GET /plugin/remote/live + POST /plugin/remote/live/seen）

		/**
		 * 取 fetch 实现。**为什么绕一层**：本文件有一条既有契约 —— 全篇只允许一个 fetch 调用点
		 * （统一走 `request()` 收口），自测按字面量把它钉住了。live 需要 `cache: "no-store"` 与
		 * `keepalive`，不适合塞进 `request()`，所以这里走别名，别破坏那条契约。
		 */
		function fetchImpl() {
			try {
				return globalThis.fetch;
			} catch (error) {
				return null;
			}
		}

		/** 一次 live 请求（拿不到 fetch 就安静失败）。 */
		function liveRequest(url, init) {
			var impl = fetchImpl();
			if (typeof impl !== "function") return Promise.reject(new Error("当前环境没有 fetch"));
			return impl(url, init);
		}

		/**
		 * 拉**一条**聚合路由并清洗形状：拿不到 2xx（含 403）/ 空体 / 形状不认识 ⇒ `null`
		 * （调用方自己决定退路）。两条路由共用这一段，所以形状判据只有一处（{@link isLiveShape}）。
		 */
		var liveDirectBlocked = false;

		function fetchLiveShape(route) {
			return liveRequest(route, { credentials: "same-origin", cache: "no-store" }).then(function (response) {
				if (response === null || response === undefined || response.ok !== true) {
					// edge 上 /plugin/ 会被拦：记下来，之后直接走 /dsh-remote-view，别再每 2 秒刷一条 403。
					if (route === LIVE_ROUTE) liveDirectBlocked = true;
					return null;
				}
				return response.text();
			}).then(function (body) {
				if (typeof body !== "string" || body === "") return null;
				var json = null;
				try {
					json = JSON.parse(body);
				} catch (error) {
					json = null;
				}
				return isLiveShape(json) === true ? json : null;
			}).catch(function () {
				return null;
			});
		}

		/**
		 * 拉一次聚合（**主数据源**）：
		 *   ① 先 `GET /plugin/remote/live`（回环链路，桌面壳走的就是它）；
		 *   ② 失败 / 403 / 形状不认识 ⇒ 退到 `GET /dsh-remote-view`（同源、浏览器经 edge 可用）；
		 *   ③ 两条都不行 ⇒ **保持上一次的数据**：不清零（宁可不更新，也不画错）、不画红、不白屏、不弹错。
		 * **不新增任何轮询频率、也不新增定时器**（还是那一套 2 秒轮询在调它）。
		 */
		function fetchLive() {
			return (liveDirectBlocked === true ? Promise.resolve(null) : fetchLiveShape(LIVE_ROUTE)).then(function (json) {
				if (json !== null) return { json: json, source: "live" };
				return fetchLiveShape(VIEW_ROUTE).then(function (fallback) {
					return fallback === null ? null : { json: fallback, source: "view" };
				});
			}).then(function (hit) {
				if (hit === null) {
					// 两条都拿不到（老版本宿主半 / 别的东西占了路径 / 网络不通）：只写一条日志，别每 2 秒刷屏。
					if (liveShapeLogged !== true) {
						liveShapeLogged = true;
						panelLog("回环取数两条路都拿不到（" + LIVE_ROUTE + " → " + VIEW_ROUTE + "）⇒ 保持上一次的数据");
					}
					return;
				}
				liveShapeLogged = false;
				var json = asObject(hit.json);
				noteHostVersion(json.version);
				var selfLive = asObject(json.self).live;
				// 本机设备名（宿主半 0.11.0 起给 `self.name`；老版本没有 ⇒ 空串 ⇒ 界面退回「本机」）。
				publishLive(asObject(selfLive), cleanPeers(json.peers), hit.source, text(asObject(json.self).name));
			});
		}

		/**
		 * 记下宿主半报的版本（只有 `/dsh-remote-view` 带这个字段；`/plugin/remote/live` 没有）。
		 * **只在真的变化时**写一条日志；**只提示、不改点的颜色**（红 / 琥珀 / 绿 / 灰圈的判据一个字没动）。
		 */
		function noteHostVersion(version) {
			var next = text(version).trim();
			if (next === liveHostVersion) return;
			var previous = liveHostVersion;
			liveHostVersion = next;
			if (next === "") {
				if (previous !== "") panelLog("宿主半版本未知（聚合里没有 version 字段）⇒ 不再做版本提示");
				return;
			}
			if (next === CLIENT_VERSION) {
				panelLog("版本一致：dsh-remote " + next);
				return;
			}
			panelLog("版本不一致：那台 dsh-remote " + next + "，本机 " + CLIENT_VERSION + "，建议升级");
		}

		/**
		 * 版本不一致的提示后缀（一致 / 没拿到都返回空串）：挂到浮层每一行与侧栏那一行的 `title` 上。
		 * **只管提示**：不参与任何状态判据（绝不因为它把点画红 / 画琥珀）。
		 */
		function versionHint() {
			if (liveHostVersion === "" || liveHostVersion === CLIENT_VERSION) return "";
			return " · 那台 dsh-remote " + liveHostVersion + "，本机 " + CLIENT_VERSION + "，建议升级";
		}

		/** live 轮询定时器（页面隐藏时停掉）。 */
		var liveTimer = null;
		/** "形状不认识"这条日志只写一次（每 5 秒刷屏没有意义）。 */
		var liveShapeLogged = false;

		function livePollStart() {
			if (liveTimer !== null) return;
			var every = globalThis.setInterval;
			if (typeof every !== "function") return;
			liveTimer = every(fetchLive, LIVE_POLL_MS);
		}

		function livePollStop() {
			if (liveTimer === null) return;
			try {
				globalThis.clearInterval(liveTimer);
			} catch (error) {
				/* 忽略 */
			}
			liveTimer = null;
		}

		/** 页面隐藏 ⇒ 停；回到前台 ⇒ 立刻拉一次再继续。 */
		function onLiveVisibility() {
			try {
				var doc = globalThis.document;
				if (doc !== null && doc !== undefined && doc.hidden === true) {
					livePollStop();
					return;
				}
			} catch (error) {
				/* 拿不到 hidden 就当作可见，继续轮询 */
			}
			livePollStart();
			fetchLive();
		}

		/** 可见性监听是否已经挂上（幂等：apply 重复跑也不会挂两次）。 */
		var liveVisibilityBound = false;

		function liveVisibilityOn() {
			if (liveVisibilityBound === true) return;
			try {
				var doc = globalThis.document;
				if (doc !== null && doc !== undefined && typeof doc.addEventListener === "function") {
					doc.addEventListener("visibilitychange", onLiveVisibility);
					liveVisibilityBound = true;
				}
			} catch (error) {
				/* 挂不上就只靠轮询 */
			}
		}

		function liveVisibilityOff() {
			try {
				var doc = globalThis.document;
				if (liveVisibilityBound === true && doc !== null && doc !== undefined && typeof doc.removeEventListener === "function") {
					doc.removeEventListener("visibilitychange", onLiveVisibility);
				}
			} catch (error) {
				/* 忽略 */
			}
			liveVisibilityBound = false;
		}

		/** 起 live：立刻拉一次 + 5 秒轮询 + 可见性监听（页面隐藏时不轮询）。 */
		function startLive() {
			try {
				var doc = globalThis.document;
				var hidden = doc !== null && doc !== undefined && doc.hidden === true;
				if (hidden !== true) livePollStart();
				fetchLive();
				liveVisibilityOn();
			} catch (error) {
				/* 没有 document 也照样试一次取数 */
				fetchLive();
			}
		}

		/**
		 * 点一台设备 ⇒ 清**那台**的"未读完成"（`id === ""` = 本机，非空 = 让宿主半转给那台对端）。
		 * 先乐观清掉本地那份（点完立刻不绿），再发 POST；失败也不回滚 —— 下一次轮询会拿回真值。
		 * **只在点击时清**，没有任何定时器掺和。
		 */
		function clearUnreadFor(id) {
			if (liveSelf.have !== true) return;
			var target = text(id).trim();
			if (target === "") {
				// 本机：乐观清掉那一格（点完立刻不绿），再发 POST（发不发都一样幂等）。
				if (liveSelf.unread === true) {
					publishLive(
						{ running: liveSelf.running, pending: liveSelf.pending, unread: false, doneAt: liveSelf.doneAt },
						livePeers,
						liveSource === "" ? "live" : liveSource,
						liveSelfName,
					);
				}
				postSeen("");
				return;
			}
			// 对端：只乐观清掉这一台那一格（其余原样），真正的清由宿主半转给对端。
			var next = [];
			var found = false;
			for (var index = 0; index < livePeers.length; index += 1) {
				var peer = asObject(livePeers[index]);
				if (text(peer.id) !== target) {
					next.push(peer);
					continue;
				}
				found = true;
				var live = peer.live === null || peer.live === undefined ? null : asObject(peer.live);
				next.push({
					id: peer.id,
					name: peer.name,
					reachable: peer.reachable !== false,
					lastError: peer.lastError,
					live: live === null ? null : {
						running: asCount(live.running),
						pending: asCount(live.pending),
						unread: false,
						doneAt: asCount(live.doneAt),
					},
				});
			}
			if (found) {
				publishLive(
					{ running: liveSelf.running, pending: liveSelf.pending, unread: liveSelf.unread, doneAt: liveSelf.doneAt },
					next,
					liveSource === "" ? "live" : liveSource,
					liveSelfName,
				);
			}
			postSeen(target);
		}

		/**
		 * **点一台设备那行**（浮层每行 onClick 与注入行都走这里）：
		 *   ① 目标对端**已知不可达** ⇒ **不切换**（不写键、不刷新、也不清那台的未读），
		 *      只用既有的提示机制给一句"这台现在连不上（<原因>），先不切"；
		 *   ② 清那台的"未读完成"（本机 = 空串；对端 = 它的 id，由宿主半转给对端）；
		 *   ③ 不是当前那台才真的切换（当前那台仍要能点 —— 就为了清绿点）。
		 *
		 * 第 ① 条的边界（重要，别扩大）：
		 *  - 判据只用**已经在轮询的**聚合快照（`livePeer(id).reachable === false`），
		 *    这里**绝不**为了它多发一个请求；
		 *  - `reachable` 不是布尔 `false`（含 `null` / 缺字段 / 整个 peers 里没有这条）⇒ **照常切**
		 *    —— 未知 ≠ 不可达，没数据时拦人只会变成骚扰；
		 *  - 点了当前那台（`isCurrent`）本来就不切，也就不做任何事；
		 *  - **旧行为（弹一次确认、"继续"仍可切）已按用户要求整段替换**：把"切过去白屏、又没有
		 *    入口切回来"的风险丢给用户是不对的（垫片那条可达性自愈只在非回环会话里生效）。
		 */
		function pickDevice(id, isLocal, isCurrent) {
			var target = isLocal === true ? "" : text(id);
			var snapshot = null;
			try {
				var peer = livePeer(target);
				if (peer !== null) {
					var record = asObject(peer);
					snapshot = {
						reachable: record.reachable === true ? true : (record.reachable === false ? false : null),
						lastError: text(record.lastError),
					};
				}
			} catch (error) {
				snapshot = "error";
			}
			var blocked = isLocal !== true ? unreachableReason(target) : "";
			if (isLocal !== true) {
				if (blocked !== "") {
					// 已知不可达：不再直接拒绝，而是**立即重试一次**（通了就切过去）。
					retryBlockedDevice(target, blocked);
					return;
				}
			}
			clearUnreadFor(target);
			if (isCurrent === true) return;
			applyDeviceSwitch(target);
		}

		/**
		 * 目标对端**已知不可达**的原因；空串 = 可达 / 未知（未知 ≠ 不可达 ⇒ 不拦、浮层里也不灰化）。
		 * 判据与旧的确认逻辑同一个（`livePeer(id).reachable === false` + `lastError`）。
		 */
		function unreachableReason(id) {
			var target = text(id).trim();
			if (target === "") return "";
			var peer = livePeer(target);
			if (peer === null) return "";
			var record = asObject(peer);
			if (record.reachable !== false) return "";
			var reason = text(record.lastError).trim();
			return reason === "" ? "原因不明" : reason;
		}

		/**
		 * 已知不可达的设备被点击时：**立即向宿主发一次 `POST /test/<id>` 重试**。
		 * - 通了 ⇒ 清未读并直接切过去（用户不需要点第二次）；
		 * - 不通 ⇒ 用 notify 给一句原因，行还是灰的，等下次。
		 * 这样"灰掉的设备"也能主动重连，不会只能干等后台轮询。
		 */
		function retryBlockedDevice(id, blocked) {
			var name = livePeerName(id);
			var label = name === "" ? text(id) : name;
			notify("正在重试连接「" + label + "」…");
			request("/test/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify({}) })
				.then(function (json) {
					var result = asObject(json);
					if (result.ok === true) {
						clearUnreadFor(id);
						applyDeviceSwitch(id);
						return;
					}
					var detail = text(result.error);
					notify("仍然连不上「" + label + "」：" + (detail === "" ? blocked : detail));
				})
				.catch(function (error) {
					notify("重试失败「" + label + "」：" + describeError(error));
				});
		}

		/**
		 * "这台现在连不上（<原因>），先不切：<名字>" —— **只写一条控制台日志，绝不弹窗**。
		 * 2026-10-17 真机反馈：以前走 `alert`，弹窗确认后回到对话**输入框失去焦点、必须刷新页面**才能打字。
		 * 反馈已经由"那一行灰化 + 鼠标悬停写明原因"承担，所以这里不再打扰用户。
		 */
		function notifyBlocked(id, reason) {
			var name = livePeerName(id);
			try {
				if (typeof console !== "undefined" && console !== null && typeof console.warn === "function") {
					console.warn("[dsh-remote] 这台现在连不上（" + reason + "），先不切：" + (name === "" ? text(id) : name));
				}
			} catch (error) {
				/* 日志失败不算事 */
			}
		}

		/**
		 * 发"清未读"：`POST /plugin/remote/live/seen` body `{ id }`（空串 = 本机）。
		 * `keepalive`：这一行点下去多半紧接着 reload（切换设备），别让请求被掐掉。
		 */
		function postSeen(id) {
			try {
				liveRequest(LIVE_SEEN_ROUTE, {
					method: "POST",
					credentials: "same-origin",
					cache: "no-store",
					keepalive: true,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: text(id) }),
				}).catch(function () {
					/* 忽略：下一次轮询会拿回真值 */
				});
			} catch (error) {
				/* 忽略 */
			}
		}

		//#endregion

		//#region 设备表与设备名（聚合 + 垫片 DOM，两条都不依赖探针）

		/** 去掉"本机项"名字尾部那段主机名括号：`某台设备（本机 主机名）` → `设备A`。 */
		function trimHostTail(name) {
			try {
				return String(name).replace(/[（(][^（）()]*?(?:本机|[A-Z0-9][A-Z0-9-]{3,})[^（）()]*?[）)]\s*$/u, "").trim();
			} catch (error) {
				return String(name);
			}
		}

		/** 取胶囊面板里那一项的**设备名**：第一个直接文本节点，去掉选中标记「●」与多余空白。 */
		function shimItemName(node, fallback) {
			try {
				var first = node.firstChild;
				if (first !== null && first !== undefined && first.nodeType === 3) {
					var name = String(first.nodeValue).replace(/\u25cf/gu, "").replace(/\s+/gu, " ").trim();
					name = trimHostTail(name);
					if (name !== "") return name;
				}
			} catch (error) {
				/* 退回整段文本 */
			}
			try {
				var whole = text(node.textContent).replace(/\u25cf/gu, "").trim();
				var slash = whole.indexOf("/");
				if (slash > 0) whole = whole.slice(0, slash).trim();
				return whole === "" ? fallback : whole;
			} catch (error) {
				return fallback;
			}
		}

		/**
		 * 垫片发布的那份设备表 → 同一口径的条目（`{ id, name, local, current }`；本机 `id === ""`）。
		 * 本机那条的 `name` 拿不到就退回「本机」，对端拿不到就用 id（**绝不留空**）。
		 */
		function publishedEntries(list) {
			var out = [];
			var items = asArray(list);
			var seen = {};
			for (var index = 0; index < items.length; index += 1) {
				var entry = asObject(items[index]);
				var id = text(entry.id).trim();
				var key = id === "" ? "(local)" : id;
				if (seen[key] === true) continue;
				seen[key] = true;
				var name = text(entry.name).trim();
				out.push({
					id: id,
					name: name === "" ? (id === "" ? "本机" : id) : name,
					local: id === "",
					// 发布里的 current 只是**参考值**（`deviceList()` 以 `readCurrentId()` 为准）。
					current: entry.current === true || text(entry.current) === "true",
				});
			}
			return out;
		}

		/**
		 * ① **垫片写的全局快照** `globalThis.__DSH_REMOTE_DEVICES__`（真实浏览器里 `window` 就是它，
		 * 两边都读一遍，扛"某个壳只挂到 window 上"）。
		 */
		function readGlobalShimDevices() {
			try {
				var direct = publishedEntries(globalThis.__DSH_REMOTE_DEVICES__);
				if (direct.length > 0) return direct;
			} catch (error) {
				/* 读不到就试下一个来源 */
			}
			try {
				var view = globalThis.window;
				if (view === null || view === undefined) return [];
				return publishedEntries(view.__DSH_REMOTE_DEVICES__);
			} catch (error) {
				return [];
			}
		}

		/** ② **隐藏 JSON 节点**（`{"devices":[…]}`）：DOM 兜底，扛"全局被别人清了 / 换了 realm"。 */
		function readShimDevicesNode() {
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined || typeof doc.getElementById !== "function") return [];
				var node = doc.getElementById(SHIM_DEVICES_NODE_ID);
				if (node === null || node === undefined) return [];
				var raw = text(node.textContent).trim();
				if (raw === "") return [];
				return publishedEntries(asObject(JSON.parse(raw)).devices);
			} catch (error) {
				return [];
			}
		}

		/**
		 * ③ 从**垫片画在 DOM 里的胶囊面板**读（纯兜底）：每台设备一个 `button[data-device-id]`
		 * （本机那条 id 是空串，当前那台带 `data-current="1"`）。
		 * 胶囊 UI 已停用 ⇒ 这条路上通常什么都没有；留着只为"删掉 `mount()` 里那行 return 就能回退"。
		 */
		function readPillShimDevices() {
			var out = [];
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return out;
				var nodes = doc.querySelectorAll("[data-device-id]");
				var seen = {};
				for (var index = 0; index < nodes.length; index += 1) {
					var node = nodes[index];
					var id = text(node.getAttribute("data-device-id")).trim();
					var key = id === "" ? "(local)" : id;
					if (seen[key] === true) continue;
					seen[key] = true;
					out.push({
						id: id,
						name: shimItemName(node, id === "" ? "本机" : id),
						local: id === "",
						current: text(node.getAttribute("data-current")).trim() === "1",
					});
				}
			} catch (error) {
				return out;
			}
			return out;
		}

		/**
		 * 垫片那份设备表（**按优先级**）：
		 *   ① 全局快照 `__DSH_REMOTE_DEVICES__`；
		 *   ② 隐藏 JSON 节点 `#dsh-remote-devices`；
		 *   ③ 老的胶囊面板 `button[data-device-id]`（已停用，纯兜底）。
		 *
		 * 为什么需要它：远程浏览器下 `/plugin/remote/live` 是 403（那条路由只认回环），
		 * 而这两份数据都是**同源、不走网络** ⇒ 一样能列设备、能切换。
		 * 代价：这里没有状态，点要靠聚合那份（拿不到就不画点）。
		 */
		function readShimDevices() {
			var published = readGlobalShimDevices();
			if (published.length > 0) return published;
			var fromNode = readShimDevicesNode();
			if (fromNode.length > 0) return fromNode;
			return readPillShimDevices();
		}

		/**
		 * 本机那条的**显示名**：有宿主半给的本机设备名 ⇒ 「<设备名>（本机）」；拿不到 ⇒ 原来的「本机」。
		 * （侧栏那一行的「设备 · <当前设备名>」不走这里，仍是 `currentDeviceName()` 的「本机」。）
		 */
		function localEntryName() {
			var name = text(liveSelfName).trim();
			if (name === "") return "本机";
			// 名字里已经带"本机"就不再补后缀（浮层那层还会再判一次，这里先保证单一来源）。
			if (name.indexOf("本机") !== -1) return name;
			return name + "（本机）";
		}

		/**
		 * 浮层里的设备表：**本机在最前**，其后是所有对端。
		 * 对端来源两处（并集）：聚合的 `peers[]`（带状态、最准）+ 垫片 DOM（远程浏览器也能列）。
		 * 名字都拿不到就用 id（绝不留空）。
		 */
		function deviceList() {
			var currentId = readCurrentId();
			var out = [{ id: "", name: localEntryName(), local: true, current: currentId === "" }];
			var seen = { "(local)": true };
			var shim = readShimDevices();
			var shimNames = {};
			for (var at = 0; at < shim.length; at += 1) {
				var shimEntry = asObject(shim[at]);
				var shimId = text(shimEntry.id).trim();
				if (shimId !== "") shimNames[shimId] = text(shimEntry.name);
			}
			for (var index = 0; index < livePeers.length; index += 1) {
				var peer = asObject(livePeers[index]);
				var id = text(peer.id).trim();
				if (id === "" || seen[id] === true) continue;
				seen[id] = true;
				var name = text(peer.name);
				if (name === "" && shimNames[id] !== undefined) name = shimNames[id];
				out.push({ id: id, name: name === "" ? id : name, local: false, current: currentId === id });
			}
			for (var other = 0; other < shim.length; other += 1) {
				var entry = asObject(shim[other]);
				var entryId = text(entry.id).trim();
				if (entryId === "" || seen[entryId] === true) continue;
				seen[entryId] = true;
				var entryName = text(entry.name);
				out.push({ id: entryId, name: entryName === "" ? entryId : entryName, local: false, current: currentId === entryId });
			}
			return out;
		}

		/** 当前设备名：本机 → 「本机」；对端 → 聚合里的 name → 垫片 DOM 的名字 → id。 */
		function currentDeviceName() {
			var id = readCurrentId();
			if (id === "") return "本机";
			var fromLive = livePeerName(id);
			if (fromLive !== "") return fromLive;
			var shim = readShimDevices();
			for (var index = 0; index < shim.length; index += 1) {
				var entry = asObject(shim[index]);
				if (text(entry.id).trim() !== id) continue;
				var name = text(entry.name);
				if (name !== "") return name;
			}
			return id;
		}

		//#endregion

		//#region 浮层开关（模块级 + 极简订阅：原生 DOM 那行点得开 React 浮层）

		var panelOverlayOpen = false;
		var panelOverlayListeners = [];

		function setPanelOverlayOpen(next) {
			panelOverlayOpen = next === true;
			var list = panelOverlayListeners.slice();
			for (var index = 0; index < list.length; index += 1) {
				try {
					list[index](panelOverlayOpen);
				} catch (error) {
					/* 订阅者出错不影响别人 */
				}
			}
		}

		function subscribePanelOverlay(listener) {
			panelOverlayListeners.push(listener);
			return function () {
				var at = panelOverlayListeners.indexOf(listener);
				if (at !== -1) panelOverlayListeners.splice(at, 1);
			};
		}

		function usePanelOverlayOpen() {
			var pair = react.useState(panelOverlayOpen);
			var open = pair[0];
			var setOpen = pair[1];
			react.useEffect(function () {
				setOpen(panelOverlayOpen);
				return subscribePanelOverlay(function (next) {
					setOpen(next);
				});
			}, []);
			return open;
		}

		//#endregion

		//#region 注入那一行（原生 DOM；先认领再插入）

		/** 注入自检：成功/失败与原因（只用于日志，失败不再往界面挂 ⚠）。 */
		var panelInjectState = { ok: false, reason: "还没跑" };

		/** 注入状态（**幂等**：内容没变就不通知、也不写日志，绝不刷屏）。 */
		function setPanelInjectState(ok, reason) {
			var nextOk = ok === true;
			var nextReason = text(reason);
			if (panelInjectState.ok === nextOk && panelInjectState.reason === nextReason) return;
			panelInjectState = { ok: nextOk, reason: nextReason };
			if (nextOk !== true) panelLog("注入失败：" + nextReason);
		}

		/** 注入总开关 + 观察器/定时器句柄 + "那一行是不是我们插的"（卸载时只移除自己插的）。 */
		var panelStarted = false;
		var panelRowOwned = false;
		var panelObserver = null;
		var panelInterval = null;
		var panelDebounce = null;
		/** 上一次写进那一行的文字 / 点状态 / 日志键（没变就不写 DOM ⇒ 不会自激观察器）。 */
		var lastRowLabel = null;
		var lastRowDotKey = null;
		var lastRowLog = "";

		/** 是不是"官方那一行"：文字、**aria-label**、**title** 任一等于目标文案即可。 */
		function matchesLabel(node, labels) {
			try {
				var candidates = [text(node.textContent).trim()];
				try {
					candidates.push(text(node.getAttribute("aria-label")).trim());
				} catch (error) {
					/* 没有这个属性 */
				}
				try {
					candidates.push(text(node.getAttribute("title")).trim());
				} catch (error) {
					/* 没有这个属性 */
				}
				for (var index = 0; index < candidates.length; index += 1) {
					if (candidates[index] !== "" && labels.indexOf(candidates[index]) !== -1) return true;
				}
				return false;
			} catch (error) {
				return false;
			}
		}

		/** 元素是否真的可见（宽高 > 0）——侧栏有展开/折叠两份 DOM，别插到隐藏那份里。 */
		function isVisible(node) {
			try {
				var rect = node.getBoundingClientRect();
				return rect.width > 1 && rect.height > 1;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 在 `root` 里按文案找"块"：命中文字 / aria-label / title 的可见元素，再往上收拢到
		 * "父节点文字仍是同一句"的最高节点（= 那一行/那一块）。
		 * 返回**候选数组**（调用方按位置挑；找不到就是空数组）。
		 */
		function labelBlocks(root, labels) {
			var out = [];
			try {
				var nodes = root.querySelectorAll("button, a, div, span, li, h2, h3, p");
				for (var index = 0; index < nodes.length; index += 1) {
					var node = nodes[index];
					// 文字 / aria-label / title 任一命中即可（窄栏下只有无障碍名带标签）。
					if (matchesLabel(node, labels) !== true) continue;
					if (isVisible(node) !== true) continue;
					var label = text(node.textContent).trim();
					if (label === "") {
						out.push(node);
						continue;
					}
					var block = node;
					while (block.parentElement !== null && block.parentElement !== undefined && block.parentElement !== root
						&& text(block.parentElement.textContent).trim() === label) {
						block = block.parentElement;
					}
					out.push(block);
				}
			} catch (error) {
				return out;
			}
			return out;
		}

		/** 取第一个候选（够用的老语义）。 */
		function findByLabel(root, labels) {
			var list = labelBlocks(root, labels);
			return list.length === 0 ? null : list[0];
		}

		/**
		 * 找注入锚点：优先取**靠左**（侧栏）的候选 —— 主内容区也可能出现同名文字
		 * （例如「工作区」），只按文字取第一个会在那些页面上插错地方。
		 */
		function findAnchor(root, labels) {
			var list = labelBlocks(root, labels);
			var fallback = null;
			for (var index = 0; index < list.length; index += 1) {
				if (fallback === null) fallback = list[index];
				try {
					var left = list[index].getBoundingClientRect().left;
					if (Number.isFinite(left) && left < SIDEBAR_MAX_LEFT) return list[index];
				} catch (error) {
					/* 量不到就继续 */
				}
			}
			return fallback;
		}

		/**
		 * 找**最深**的那个文字节点：文字正好等于 `labels` 里某一条、且**没有**同文字的元素子节点。
		 * 与 `findByLabel` 的区别：那个是"往上收拢成整块"，这个要的是那一行里的**文字本身**
		 * （横向校准必须按文字左边缘，按整块会错 30 多像素）。
		 */
		function findDeepestLabel(root, labels) {
			try {
				var nodes = root.querySelectorAll("*");
				for (var index = 0; index < nodes.length; index += 1) {
					var node = nodes[index];
					if (matchesLabel(node, labels) !== true) continue;
					if (isVisible(node) !== true) continue;
					var label = text(node.textContent).trim();
					if (label === "") return node;
					var deeper = false;
					for (var child = 0; child < node.children.length; child += 1) {
						if (text(node.children[child].textContent).trim() === label) {
							deeper = true;
							break;
						}
					}
					if (deeper === true) continue;
					return node;
				}
				return null;
			} catch (error) {
				return null;
			}
		}

		/** 找锚点用的搜索根：优先我们那行的父节点（插进去之后它就是官方那个容器），其次 body。 */
		function panelSearchRoot() {
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined) return null;
				var row = typeof doc.getElementById === "function" ? doc.getElementById(ROW_ID) : null;
				if (row !== null && row !== undefined && row.parentElement !== null && row.parentElement !== undefined) return row.parentElement;
				return doc.body === undefined ? null : doc.body;
			} catch (error) {
				return null;
			}
		}

		/** 状态 → 颜色 token（跟官方那 5 个点同一套；原生 DOM 的点和取不到 primitives 时共用）。 */
		function dotToken(state) {
			if (state === "done") return PANEL_C.online;
			if (state === "error") return PANEL_C.error;
			if (state === "warning") return PANEL_C.warn;
			return PANEL_C.offline;
		}

		/** 自旋动画的 `@keyframes`：只插一次（原生 DOM 挂不了官方 `StateDot`，这里自己画同款 loading）。 */
		var DOT_STYLE_ID = "dsh-remote-panel-dot-style";

		/** 插一次 `<style>@keyframes …</style>`（幂等；插不进去就退化成静态点，绝不因此报错）。 */
		function ensureDotStyle(doc) {
			try {
				if (doc === null || doc === undefined || typeof doc.createElement !== "function") return;
				if (typeof doc.getElementById === "function" && doc.getElementById(DOT_STYLE_ID) !== null) return;
				var style = doc.createElement("style");
				style.id = DOT_STYLE_ID;
				style.textContent = "@keyframes dsh-remote-panel-spin{to{transform:rotate(360deg)}}";
				var anchor = doc.head !== null && doc.head !== undefined ? doc.head : doc.documentElement;
				if (anchor !== null && anchor !== undefined && typeof anchor.appendChild === "function") anchor.appendChild(style);
			} catch (error) {
				/* 插不进去就退化成静态点，绝不因此报错 */
			}
		}

		/**
		 * 把状态套到一个**原生** span 上（**唯一**写原生点的入口：别再直接 `style.background = dotToken(...)`）。
		 *   `ongoing` ⇒ **转圈**：透明底 + 2px 透明边 + `border-top-color: dotToken(state)` +
		 *   `.9s linear infinite` 自旋（官方 ongoing 就是 14px 自旋 loading 的观感）；
		 *   其余 ⇒ 实心圆（颜色仍用官方那套 token）。
		 * 尺寸：平时 `size`（侧栏行 = 6px），转圈时 `spinSize`（侧栏行 = 14px）。
		 */
		function applyDotStyle(dot, state, size, spinSize) {
			if (dot === null || dot === undefined || dot.style === undefined) return;
			ensureDotStyle(globalThis.document);
			var color = dotToken(state);
			if (state === "ongoing") {
				var spin = spinSize === undefined || spinSize === null ? 14 : spinSize;
				dot.style.cssText = "display:block;width:" + spin + "px;height:" + spin + "px;box-sizing:border-box;"
					+ "border-radius:999px;flex:0 0 auto;background:transparent;"
					+ "border:2px solid transparent;border-top-color:" + color + ";"
					+ "animation:dsh-remote-panel-spin .9s linear infinite";
				return;
			}
			var px = size === undefined || size === null ? 6 : size;
			dot.style.cssText = "display:block;width:" + px + "px;height:" + px + "px;border-radius:999px;"
				+ "flex:0 0 auto;background:" + color;
		}

		/** 集合态 → 悬停提示文案（**说的是"所有设备里最要紧的那个"**，不是某一台在干什么）。 */
		function aggregateStateText(state) {
			if (state === "error") return "有设备连不上";
			if (state === "warning") return "有设备待批准/待回答";
			if (state === "done") return "有任务刚跑完（点这一行清掉）";
			if (state === "ongoing") return "有会话在跑";
			return "暂时没有设备状态（全部空闲或还没拿到实时数据）";
		}

		/** 日志摘要：只列"给出状态"的设备，空的一律不提（别把"没数据"说成"空闲"）。 */
		function rowStatesSummary(table) {
			var list = asArray(table);
			var parts = [];
			for (var index = 0; index < list.length; index += 1) {
				var item = asObject(list[index]);
				var state = text(item.state).trim();
				if (state === "") continue;
				parts.push((item.local === true || text(item.id).trim() === "" ? "本机" : text(item.id).trim()) + "=" + state);
			}
			return parts.length === 0 ? "没有任何设备给出可显示的状态" : parts.join(" ");
		}

		/** 状态点的悬停提示（只画点不写字，所以状态只放在 title 里）。 */
		function stateText(state, entry) {
			var record = asObject(entry);
			if (state === "error") return "连不上";
			if (state === "warning") return "待批准/待回答";
			if (state === "done") {
				return record.local === true || text(record.id).trim() === "" ? "有任务刚跑完（点这一行清掉）" : "那台刚跑完（点这一行清掉）";
			}
			if (state === "ongoing") return "有会话在跑";
			return "";
		}

		/**
		 * 渲染状态点：**官方 `StateDot` 还在就用它**（done / ongoing / warning）；
		 * 红（不可达）与拿不到 primitives 时退化成同色原生小圆点（功能不丢）。
		 * 为什么红不交给官方那个点：官方 error 态的语义与本插件的"这台设备连不上"不完全一致，
		 * 而用户点名要的是"红 / 兜底用原生点 + 同色 token"。
		 */
		function stateDot(state, size) {
			var px = size === undefined ? 8 : size;
			if (state !== "error" && primitives !== null && primitives !== undefined && typeof primitives.StateDot === "function") {
				try {
					return h(primitives.StateDot, { state: state });
				} catch (error) {
					/* 退到下面的原生点 */
				}
			}
			return h("span", {
				style: { width: px, height: px, borderRadius: 999, flex: "0 0 auto", background: dotToken(state) },
			});
		}

		/**
		 * 建我们那一行（**原生 DOM**：官方行怎么排，我们跟着排）。
		 * id 与探针逐字一致 ⇒ 两个插件同时在时靠它认领，绝不出现第二行。
		 */
		function buildPanelRow() {
			var doc = globalThis.document;
			var row = doc.createElement("button");
			row.id = ROW_ID;
			row.type = "button";
			row.title = "设备（点开浮层）";
			row.setAttribute("aria-label", "设备");
			row.style.cssText = [
				"display:flex", "align-items:center", "gap:8px", "width:100%",
				"padding:6px 10px", "margin:2px 0", "background:transparent", "color:inherit",
				"border:0", "border-radius:6px", "cursor:pointer", "font:inherit", "text-align:left",
			].join(";");
			// 图标必须用**原生 DOM** 建：deviceGlyph() 那种 React 元素对象直接 appendChild 会抛
			// "parameter 1 is not of type 'Node'"（真机报错过）。
			var svgNs = "http://www.w3.org/2000/svg";
			var svg = doc.createElementNS(svgNs, "svg");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			svg.setAttribute("aria-hidden", "true");
			var screen = doc.createElementNS(svgNs, "rect");
			screen.setAttribute("x", "1.5");
			screen.setAttribute("y", "3");
			screen.setAttribute("width", "13");
			screen.setAttribute("height", "8.5");
			screen.setAttribute("rx", "1.5");
			screen.setAttribute("stroke", "currentColor");
			screen.setAttribute("stroke-width", "1.2");
			var stand = doc.createElementNS(svgNs, "path");
			stand.setAttribute("d", "M5.5 14h5");
			stand.setAttribute("stroke", "currentColor");
			stand.setAttribute("stroke-width", "1.2");
			stand.setAttribute("stroke-linecap", "round");
			svg.appendChild(screen);
			svg.appendChild(stand);
			// 图标外面套一个固定宽度的"格子"（官方行就是这种结构，宽度按官方行量出来对齐）。
			var iconBox = doc.createElement("span");
			iconBox.id = ROW_ID + "-icon";
			iconBox.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto";
			iconBox.appendChild(svg);
			row.appendChild(iconBox);
			var label = doc.createElement("span");
			label.id = ROW_ID + "-label";
			label.textContent = "设备";
			row.appendChild(label);
			// 状态点 = **集合态**（所有设备里最要紧的那个；本机与全部对端同一套优先级）。
			// **默认不画**（全都没有可显示的状态 = 无点）；样式一律走 applyDotStyle（ongoing = 转圈）。
			var dot = doc.createElement("span");
			dot.id = ROW_ID + "-dot";
			dot.style.display = "none";
			row.appendChild(dot);
			// 新节点：上一次画过的键作废（否则 paintPanelRow 会以为"没变"而不写）。
			lastRowLabel = null;
			lastRowDotKey = null;
			lastRowLog = "";
			row.addEventListener("click", function (event) {
				event.stopPropagation();
				// 当前看的就是本机 ⇒ 这一行就是"本机那行"：点它（开浮层）就等于看过了，清掉绿点。
				if (readCurrentId() === "") clearUnreadFor("");
				setPanelOverlayOpen(true);
			});
			return row;
		}

		/** 那一行现在是窄栏（只留图标）吗？—— 窄栏下不画状态点（跟官方行一致）。 */
		function rowIsRail() {
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined || typeof doc.getElementById !== "function") return false;
				var row = doc.getElementById(ROW_ID);
				if (row === null) return false;
				var width = row.getBoundingClientRect().width;
				return Number.isFinite(width) && width > 0 && width < ROW_RAIL_MAX;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 画那一行的**动态文字 + 状态点**（幂等：值没变就一个字节都不写 DOM）。
		 *   文字：本机 → 「设备 · 本机」；切到某台 → 「设备 · <设备名>」；查不到 → 「设备 · <id>」；
		 *   点（**集合态**，不是当前设备自己的状态）：本机 `self.live` + 全部 `peers[]` 按
		 *   红 > 琥珀 > 绿 > 灰圈 > 无点 取最高的那个；`live === null` 的设备跳过、
		 *   `reachable === false` 算红；全都没有可显示的状态 ⇒ `display:none`（不画点）。
		 * 文案与状态都来自**已经在轮询的 live 快照** + 垫片 DOM ⇒ 这里**不发任何请求**。
		 */
		function paintPanelRow(rail) {
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined || typeof doc.getElementById !== "function") return;
				if (doc.getElementById(ROW_ID) === null) return;
				var current = readCurrentId();
				var label = "设备 · " + currentDeviceName();
				if (label !== lastRowLabel) {
					lastRowLabel = label;
					var labelNode = doc.getElementById(ROW_ID + "-label");
					if (labelNode !== null) labelNode.textContent = label;
					panelLog("那一行：" + label);
				}
				// 集合态 = 所有设备里最要紧的那个（纯函数 aggregateDot，见「实时状态」region）。
				var table = deviceStateTable();
				var state = aggregateDot(table);
				var isRail = rail === true;
				// 版本提示也进幂等键：宿主半版本变了（只有 `/dsh-remote-view` 会报）就重画一次 title。
				var dotKey = state + "|" + (isRail === true ? "rail" : "wide") + "|" + liveHostVersion;
				if (dotKey === lastRowDotKey) return;
				lastRowDotKey = dotKey;
				var dot = doc.getElementById(ROW_ID + "-dot");
				var row = doc.getElementById(ROW_ID);
				var title = "集合状态：" + aggregateStateText(state);
				if (dot !== null) {
					// **没有可显示的状态 / 窄栏 ⇒ 不画点**；点的样式一律走 applyDotStyle（ongoing = 转圈）。
					if (state === "" || isRail === true) {
						// 不画点就把样式一起清干净：别留一条在暗处继续转的 animation。
						dot.style.cssText = "";
						dot.style.display = "none";
						dot.title = "";
					} else {
						applyDotStyle(dot, state, ROW_DOT_SIZE, ROW_DOT_SPIN_SIZE);
						dot.style.display = "block";
						dot.title = title;
					}
				}
				// 行的 title 说的是"所有设备里最要紧的状态"，**绝不是**"某台在跑"那种会误导的说法；
				// 后面再挂上"两台版本不一致"的提示（只提示，不参与任何状态判据）。
				if (row !== null) row.title = "设备（点开浮层）· " + title + versionHint();
				if (dotKey !== lastRowLog) {
					lastRowLog = dotKey;
					panelLog("那一行的集合态点：" + (state === "" ? "无点" : state) + "（" + rowStatesSummary(table) + "）");
				}
			} catch (error) {
				/* 状态点失败绝不影响那一行 */
			}
		}

		/** 上一次的窄栏状态（模式切换时清零校准余量）与上一次套用的样式键（别反复写属性）。 */
		var lastRailState = null;
		var lastStyleKey = "";

		/**
		 * 让插进去的那一行**长得像官方行**：字号/颜色/内边距/行高/圆角全部抄官方「自动化任务」那一行；
		 * 侧栏收窄（自己那行宽 < 120px）时**只留图标**（官方行在窄栏里也是这种形态）。
		 */
		function styleLikeOfficial(root) {
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined || typeof doc.getElementById !== "function") return false;
				var row = doc.getElementById(ROW_ID);
				if (row === null || root === null || root === undefined) return false;
				// 官方那一行：**文字节点**（横向校准用）+ **整行元素**（尺寸/computed style 用）。
				var officialLabel = findDeepestLabel(root, ANCHOR_LABELS);
				var official = officialLabel === null ? findByLabel(root, ANCHOR_LABELS) : officialLabel;
				var officialRow = official;
				try {
					if (official !== null && official !== undefined && typeof official.closest === "function") {
						var buttonUp = official.closest("button, [role='button'], a");
						if (buttonUp !== null && buttonUp !== undefined) officialRow = buttonUp;
					}
				} catch (error) {
					/* 用原值 */
				}
				// 窄栏（rail）判定：**量我们自己那一行的实际宽度**最靠谱
				// （用容器/官方行宽度时，桌面端缩成 rail 会判断失效 → 文字竖着挤出来）。
				var rowWidth = 0;
				try {
					rowWidth = row.getBoundingClientRect().width;
				} catch (error) {
					rowWidth = 0;
				}
				var rail = Number.isFinite(rowWidth) && rowWidth > 0 && rowWidth < ROW_RAIL_MAX;
				// 展开 <-> 窄栏切换：把上一次的横向校准余量清零再重测（否则 rail 里图标会歪）。
				if (lastRailState === null) {
					lastRailState = rail;
				} else if (lastRailState !== rail) {
					lastRailState = rail;
					try {
						row.style.marginLeft = "";
						var iconReset = doc.getElementById(ROW_ID + "-icon");
						if (iconReset !== null) iconReset.style.marginLeft = "";
						var labelReset = doc.getElementById(ROW_ID + "-label");
						if (labelReset !== null) labelReset.style.marginLeft = "";
					} catch (error) {
						/* 忽略 */
					}
				}
				var fontSize = 13;
				var color = PANEL_C.text;
				var padding = rail ? "0 0 0 18px" : "0 10px";
				var height = 28;
				var lineHeight = "";
				var radius = "";
				var iconWidth = 0;
				var weight = "";
				// 尺寸/computed style 一律取**整行元素**；文字节点只用来做横向校准。
				var metricsFrom = officialRow === null || officialRow === undefined ? official : officialRow;
				if (metricsFrom !== null && metricsFrom !== undefined) {
					try {
						var computed = typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle(metricsFrom) : null;
						if (computed !== null && computed !== undefined) {
							var size = parseFloat(computed.fontSize);
							if (Number.isFinite(size) && size > 8 && size < 20) fontSize = size;
							if (typeof computed.color === "string" && computed.color !== "") color = computed.color;
							if (typeof computed.fontWeight === "string" && computed.fontWeight !== "") weight = computed.fontWeight;
							// 内边距/行高/圆角**原样抄**（对齐的关键：这些值官方行和别的区域不一样）。
							if (typeof computed.paddingLeft === "string" && computed.paddingLeft !== "") {
								padding = computed.paddingTop + " " + computed.paddingRight + " " + computed.paddingBottom + " " + computed.paddingLeft;
							}
							if (typeof computed.lineHeight === "string" && computed.lineHeight !== "normal") lineHeight = computed.lineHeight;
							if (typeof computed.borderRadius === "string" && computed.borderRadius !== "") radius = computed.borderRadius;
						}
						var rect = metricsFrom.getBoundingClientRect();
						if (rect.height > 8) height = Math.round(rect.height);
						// 图标格子宽度：量**整行**的第一个元素子节点（通常就是官方图标位）。
						var firstChild = metricsFrom.firstElementChild;
						if (firstChild !== null && firstChild !== undefined) {
							var childRect = firstChild.getBoundingClientRect();
							if (childRect.width >= 10 && childRect.width <= 40) iconWidth = Math.round(childRect.width);
						}
					} catch (error) {
						/* 抄不到就用缺省 */
					}
				}
				var styleKey = [rail, Math.round(fontSize), color, padding, height, lineHeight, radius, iconWidth, weight].join("|");
				if (styleKey !== lastStyleKey) {
					lastStyleKey = styleKey;
					row.style.height = height + "px";
					row.style.fontSize = Math.round(fontSize) + "px";
					row.style.color = color;
					row.style.padding = padding;
					row.style.gap = "8px";
					if (weight !== "") row.style.fontWeight = weight;
					if (lineHeight !== "") row.style.lineHeight = lineHeight;
					if (radius !== "") row.style.borderRadius = radius;
					var iconBox = doc.getElementById(ROW_ID + "-icon");
					if (iconBox !== null && iconWidth > 0) iconBox.style.width = iconWidth + "px";
				}
				var label = doc.getElementById(ROW_ID + "-label");
				if (label !== null) label.style.display = rail ? "none" : "";
				var dotEl = doc.getElementById(ROW_ID + "-dot");
				// 只负责"窄栏藏起来"，**不再每次都强行显示** —— 显不显示由状态决定（空闲 = 无点）。
				if (dotEl !== null && rail === true) dotEl.style.display = "none";

				// ---- 横向实测校准 ----
				// 光靠抄 padding 猜不准（官方那行的外层容器还带自己的内边距/缩进）：直接量三处左边缘的差，
				// 差几像素就补几像素（下一次测≈0，自收敛）。单次补位**钳在 ±24px** 以内（曾经一次推歪过）。
				if (officialRow !== null && officialRow !== undefined) {
					var nudge = function (element, delta) {
						if (element === null || element === undefined) return;
						if (Math.abs(delta) < 1 || Math.abs(delta) > 24) return;
						var current = parseFloat(element.style.marginLeft === "" ? "0" : element.style.marginLeft);
						if (!Number.isFinite(current)) current = 0;
						element.style.marginLeft = (current + delta) + "px";
					};
					try {
						nudge(row, Math.round(officialRow.getBoundingClientRect().left - row.getBoundingClientRect().left));
					} catch (error) {
						/* 忽略 */
					}
					try {
						var officialIcon = officialRow.firstElementChild;
						var myIcon = doc.getElementById(ROW_ID + "-icon");
						if (officialIcon !== null && officialIcon !== undefined && myIcon !== null) {
							nudge(myIcon, Math.round(officialIcon.getBoundingClientRect().left - myIcon.getBoundingClientRect().left));
						}
					} catch (error) {
						/* 忽略 */
					}
					try {
						if (label !== null && official !== null && official !== undefined) {
							nudge(label, Math.round(official.getBoundingClientRect().left - label.getBoundingClientRect().left));
						}
					} catch (error) {
						/* 忽略 */
					}
				}
				paintPanelRow(rail);
				return true;
			} catch (error) {
				return false;
			}
		}

		/** 插一次；把结果写进 panelInjectState（只进日志，不挂界面）。 */
		function injectPanelRowOnce() {
			try {
				var doc = globalThis.document;
				if (doc === null || doc === undefined || typeof doc.getElementById !== "function") {
					setPanelInjectState(false, "没有 document");
					return false;
				}
				var row = doc.getElementById(ROW_ID);
				var root = panelSearchRoot();
				if (row !== null && row !== undefined) {
					// **先认领再插入**：行已经在（可能正是探针插件插的那一行）⇒ 只做样式对齐。
					if (root !== null) styleLikeOfficial(root);
					setPanelInjectState(true, "");
					return true;
				}
				if (root === null) {
					setPanelInjectState(false, "页面还没就绪（没有 body）");
					return false;
				}
				// 优先：**插进官方那两行的同一个容器**（排在「自动化任务」之后）——
				// 这样内边距、行间距、左边距跟官方行完全一致。
				var anchor = findAnchor(root, ANCHOR_LABELS);
				if (anchor !== null && anchor.parentElement !== null && anchor.parentElement !== undefined) {
					anchor.parentElement.appendChild(buildPanelRow());
					panelRowOwned = true;
					styleLikeOfficial(panelSearchRoot());
					setPanelInjectState(true, "");
					return true;
				}
				// 退路：找不到「自动化任务」那一行（语言不同？）→ 插在「工作区」标题之前。
				var heading = findAnchor(root, WORKSPACE_LABELS);
				if (heading !== null && heading.parentElement !== null && heading.parentElement !== undefined) {
					heading.parentElement.insertBefore(buildPanelRow(), heading);
					panelRowOwned = true;
					styleLikeOfficial(panelSearchRoot());
					setPanelInjectState(true, "");
					return true;
				}
				setPanelInjectState(false, "侧栏里既没找到「自动化任务」，也没找到「工作区」标题");
				return false;
			} catch (error) {
				setPanelInjectState(false, "插入时出错：" + describeError(error));
				return false;
			}
		}

		/** 合并短时间内的多次触发（MutationObserver 会刷得很密）。句柄留着，卸载时要清。 */
		function schedulePanelInject() {
			if (panelStarted !== true) return;
			if (panelDebounce !== null) return;
			var later = globalThis.setTimeout;
			if (typeof later !== "function") {
				injectPanelRowOnce();
				return;
			}
			panelDebounce = later(function () {
				panelDebounce = null;
				injectPanelRowOnce();
			}, ROW_DEBOUNCE_MS);
		}

		/** live 一变就重画那一行的**集合态点**（幂等：没变就不写 DOM）。 */
		function onPanelLiveChanged() {
			try {
				paintPanelRow(rowIsRail());
			} catch (error) {
				/* 状态点失败绝不影响那一行 */
			}
		}

		/**
		 * 盯着 DOM：行被官方重渲染冲掉就补回来（另加定时补偿）。
		 * 观察选项**只有 `{childList, subtree}`**（不看 attributes / characterData）⇒
		 * 我们写 style/title 不会被自己的观察器看到。
		 */
		function watchPanelRow() {
			if (panelStarted === true) return;
			panelStarted = true;
			liveUnsub = subscribeLive(onPanelLiveChanged);
			injectPanelRowOnce();
			try {
				var doc = globalThis.document;
				if (doc !== null && doc !== undefined && doc.body !== null && doc.body !== undefined
					&& typeof globalThis.MutationObserver === "function") {
					panelObserver = new globalThis.MutationObserver(function () {
						schedulePanelInject();
					});
					panelObserver.observe(doc.body, { childList: true, subtree: true });
				}
			} catch (error) {
				panelObserver = null;
			}
			if (typeof globalThis.setInterval === "function") {
				panelInterval = globalThis.setInterval(function () {
					try {
						var doc = globalThis.document;
						if (doc === null || doc === undefined || typeof doc.getElementById !== "function") return;
						if (doc.getElementById(ROW_ID) === null) injectPanelRowOnce();
					} catch (error) {
						/* 补插失败不影响别的功能 */
					}
				}, ROW_WATCH_MS);
			}
			// 实时状态：立刻拉一次 + 5 秒轮询（页面隐藏时停）。
			startLive();
		}

		/** 卸载：停掉注入那套的观察器与定时器，并移除**我们自己插的**那一行（探针插的不动）。 */
		function stopPanelRow() {
			panelStarted = false;
			try {
				if (panelObserver !== null && typeof panelObserver.disconnect === "function") panelObserver.disconnect();
			} catch (error) {
				/* 已断 */
			}
			panelObserver = null;
			if (panelInterval !== null) {
				try {
					globalThis.clearInterval(panelInterval);
				} catch (error) {
					/* 忽略 */
				}
			}
			panelInterval = null;
			if (panelDebounce !== null) {
				try {
					globalThis.clearTimeout(panelDebounce);
				} catch (error) {
					/* 忽略 */
				}
			}
			panelDebounce = null;
			if (panelRowOwned === true) {
				try {
					var doc = globalThis.document;
					var row = doc === null || doc === undefined || typeof doc.getElementById !== "function" ? null : doc.getElementById(ROW_ID);
					if (row !== null && row.parentNode !== null && row.parentNode !== undefined) row.parentNode.removeChild(row);
				} catch (error) {
					/* 已经跟着官方重渲染一起没了 */
				}
			}
			panelRowOwned = false;
			lastRowLabel = null;
			lastRowDotKey = null;
			lastRowLog = "";
			lastRailState = null;
			lastStyleKey = "";
		}

		//#endregion

		//#region 浮层（官方 shell.overlay）

		/**
		 * 浮层内容：**只有设备**的紧凑菜单（一行一台：状态点 + 名字，点一下切换/清未读）。
		 * 当前设备那行同样可点（点它是为了清那台的"未读完成"绿点），只是不再重复切换。
		 */
		function PanelDeviceMenu() {
			// 订阅 live（宿主半每 5 秒推一次）：本机与各对端那行的点跟着 running/pending/unread 重画。
			useLive();
			var rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				textAlign: "left",
				padding: "6px 10px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: "1px solid transparent",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				cursor: "pointer",
			};
			var devices = deviceList();
			if (devices.length === 0) {
				return h("div", { style: { ...rowStyle, color: PANEL_C.dim, cursor: "default" } }, "还没有设备");
			}
			return h(
				"div",
				{ style: { display: "grid", gap: 2 } },
				devices.map(function (device, index) {
					var entry = asObject(device);
					var id = text(entry.id);
					var isLocal = entry.local === true || id === "";
					var isCurrent = entry.current === true;
					var name = text(entry.name) === "" ? id : text(entry.name);
					// 本机那台**标出来**；名字里已经带"本机"就不再补后缀（用户看到过"本机（本机）"）。
					var display = isLocal === true && name.indexOf("本机") === -1 ? name + "（本机）" : name;
					// 本机统一按"空 id 的本机"算（垫片那条 id 就是空串，但别依赖它）。
					var dotState = deviceStateById(isLocal === true ? "" : id, isLocal === true);
					// **已知不可达 ⇒ 这一行灰化 + title 写原因**（点它不切换，见 pickDevice 第 ① 条）。
					// 未知（没有那台的数据）＝ 空串 ⇒ 一点都不灰、title 也不加料 —— 未知 ≠ 不可达。
					var blocked = isLocal === true ? "" : unreachableReason(id);
					var rowTitle = display + versionHint()
						+ (blocked === "" ? "" : " · 现在连不上（" + blocked + "），点它会立即重试连接");
					return h(
						"button",
						{
							key: "panel-device-" + String(index) + "-" + id,
							type: "button",
							title: rowTitle,
							// 不用 disabled：当前那台**仍要能点**（点它是为了清掉"未读完成"绿点），
							// 但点了不重新切换（isCurrent 时 pickDevice 里跳过切换）。
							// 不可达那台同样还能点：点了只弹一句"先不切"（绝不是静默无反应）。
							"aria-disabled": isCurrent === true,
							"data-dsh-panel-device": id === "" ? "(local)" : id,
							"data-dsh-panel-blocked": blocked === "" ? "0" : "1",
							onClick: function () {
								pickDevice(isLocal === true ? "" : id, isLocal === true, isCurrent === true);
							},
							style: {
								...rowStyle,
								// 选中行用**明确的灰色**（官方层色在浅色主题下是白的，看不出来）。
								background: isCurrent === true ? "rgba(128,128,128,.22)" : "transparent",
								// 不可达 ⇒ 再叠一层灰化（可见线索）；title 里写着原因。
								opacity: blocked !== "" ? 0.45 : (isCurrent === true ? 0.9 : 1),
								cursor: isCurrent === true ? "default" : "pointer",
							},
						},
						// 官方状态点；**空闲（无值得看的状态）时整个不渲染**，不占位。
						dotState === ""
							? null
							: h(
									"span",
									{
										key: "dot",
										"data-dsh-panel-dot": dotState,
										title: stateText(dotState, isLocal === true ? { id: "", local: true } : entry),
										style: { display: "inline-flex", flex: "0 0 auto" },
									},
									stateDot(dotState, 8),
								),
						h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, display),
					);
				}),
			);
		}

		/**
		 * `shell.overlay` 里的浮层：**贴着侧栏那一行弹出**（popover 风格）。
		 *   锚点 = 注入行 `#dsh-device-panel-row`；面板放在它右侧（再往左 100px，不挡住设备名与状态点）；
		 *   右边空间不够就翻到左侧；上下夹在视口内；量不到锚点就退回居中。
		 * 遮罩只压不炫：点空白处关闭；Esc 也能关。
		 */
		function PanelOverlay() {
			var open = usePanelOverlayOpen();
			var anchorPair = react.useState(null);
			var anchor = anchorPair[0];
			var setAnchor = anchorPair[1];

			/** 量锚点（那一行）的位置，算出面板该放哪儿。 */
			function measureAnchor() {
				try {
					var doc = globalThis.document;
					if (doc === null || doc === undefined || typeof doc.getElementById !== "function") {
						setAnchor(null);
						return;
					}
					var node = doc.getElementById(ROW_ID);
					if (node === null || node.isConnected !== true) {
						setAnchor(null);
						return;
					}
					var rect = node.getBoundingClientRect();
					var viewportWidth = globalThis.innerWidth;
					var viewportHeight = globalThis.innerHeight;
					// 菜单形态：宽度跟着那一行（比侧栏略宽一点），不做成大面积卡片面板。
					var panelWidth = Math.round(rect.width) + 24;
					if (panelWidth < 220) panelWidth = 220;
					if (panelWidth > 360) panelWidth = 360;
					// 用户要求：在"行右边缘 + 8"基础上**再往左 100px**（仍不挡住设备名与状态点）。
					var left = Math.round(rect.right + 8 - 100);
					if (Number.isFinite(viewportWidth) && left + panelWidth > viewportWidth - 8) {
						left = Math.max(8, viewportWidth - panelWidth - 8);
					}
					if (left < 8) left = 8;
					// 上边缘与那一行对齐（夹在视口内）。
					var top = Math.round(rect.top);
					if (Number.isFinite(viewportHeight) && top + 260 > viewportHeight - 8) {
						top = Math.max(8, viewportHeight - 260 - 8);
					}
					if (top < 8) top = 8;
					setAnchor({ left: left, top: top, width: panelWidth });
				} catch (error) {
					setAnchor(null);
				}
			}

			react.useEffect(function () {
				if (!open) return undefined;
				measureAnchor();
				function onKey(event) {
					if (event !== null && typeof event === "object" && event.key === "Escape") setPanelOverlayOpen(false);
				}
				function onResize() {
					measureAnchor();
				}
				try {
					var doc = globalThis.document;
					if (doc !== null && doc !== undefined && typeof doc.addEventListener === "function") doc.addEventListener("keydown", onKey);
					if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("resize", onResize);
				} catch (error) {
					/* 没有 document：没有 Esc 也能点遮罩关 */
				}
				return function () {
					try {
						var doc = globalThis.document;
						if (doc !== null && doc !== undefined && typeof doc.removeEventListener === "function") doc.removeEventListener("keydown", onKey);
						if (typeof globalThis.removeEventListener === "function") globalThis.removeEventListener("resize", onResize);
					} catch (error) {
						/* 忽略 */
					}
				};
			}, [open]);

			if (!open) return null;
			var panelStyle = anchor === null
				? { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "min(680px, 92vw)" }
				: { left: anchor.left + "px", top: anchor.top + "px", width: anchor.width + "px" };
			return h(
				"div",
				{
					"data-dsh-panel-overlay": "1",
					style: { position: "fixed", top: 0, right: 0, bottom: 0, left: 0, background: "rgba(0,0,0,.35)", zIndex: 5000 },
					onClick: function (event) {
						if (event.target === event.currentTarget) setPanelOverlayOpen(false);
					},
				},
				h(
					"div",
					{
						style: {
							position: "fixed",
							maxHeight: "70vh",
							overflow: "auto",
							background: PANEL_C.surface,
							color: PANEL_C.text,
							border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
							borderRadius: "var(--dsw-radius-md, 10px)",
							boxShadow: "0 12px 36px rgba(0,0,0,.28)",
							padding: 6,
							display: "grid",
							gap: 2,
							...panelStyle,
						},
						onClick: function (event) {
							event.stopPropagation();
						},
					},
					h(PanelDeviceMenu, null),
				),
			);
		}

		//#endregion

		//#region 起停（apply 最后调用）

		/**
		 * 面板要不要起来：**必须有真实 DOM**。
		 * 自测替身 / 非浏览器环境没有 createElement / getElementById ⇒ 整块面板都不注册、不启动
		 * （既不碰别人的槽位，也不往那种环境里塞请求）。真实页面里 document 永远齐备。
		 */
		function panelDomAvailable() {
			try {
				var doc = globalThis.document;
				if (doc === null || typeof doc !== "object") return false;
				if (typeof doc.getElementById !== "function") return false;
				if (typeof doc.createElement !== "function") return false;
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 这个槽位里已经有**等价条目**了吗？
		 * 探针插件可能还装着：它注册的浮层（id `remote-devices-overlay`，组件 OverlayEntry）与我们这份
		 * 是同一件东西 —— 已经有就整条跳过，绝不在 `shell.overlay` 里插第二份菜单。
		 * `ctx.slots.entries(槽名)` 是槽位服务的公开读口；拿不到（老版本 / 自测替身）就按"没有"处理。
		 */
		function slotHasEquivalentEntry(slots, slotName, ids, components) {
			try {
				if (slots === null || slots === undefined || typeof slots.entries !== "function") return false;
				var list = asArray(slots.entries(slotName));
				for (var index = 0; index < list.length; index += 1) {
					var entry = asObject(list[index]);
					var options = asObject(entry.options);
					var id = text(options.id);
					if (id !== "" && ids.indexOf(id) !== -1) return true;
					var component = entry.component;
					var name = component === null || component === undefined ? "" : text(component.name);
					if (name !== "" && components.indexOf(name) !== -1) return true;
				}
				return false;
			} catch (error) {
				return false;
			}
		}

		/** 注册浮层（已经有等价条目就跳过）。 */
		function registerPanelOverlay(ctx) {
			var slots = ctx !== null && ctx !== undefined && typeof ctx === "object" ? ctx.slots : null;
			if (slots === null || slots === undefined || typeof slots.inject !== "function") return;
			slots.inject("shell.overlay", function () {
				// 幂等：同一槽位已经有等价条目（探针那条）就不插第二条。
				if (slotHasEquivalentEntry(slots, "shell.overlay", PANEL_OVERLAY_EQUIVALENT_IDS, PANEL_OVERLAY_EQUIVALENT_COMPONENTS) === true) {
					panelLog("shell.overlay 里已经有等价条目（探针插件还在）⇒ 不重复注册");
					return null;
				}
				return slots.register({ name: "shell.overlay", id: PANEL_OVERLAY_ID, order: 50 }, PanelOverlay);
			});
		}

		/**
		 * 起整块面板（apply 的**最后**一步）：
		 *   ① 注册浮层（幂等，去重见 registerPanelOverlay）；
		 *   ② 注入侧栏那一行 + 盯 DOM + live 轮询（那一行的点 = 集合态）；
		 *   ③ `ctx.effect` 的清理函数负责把上面这些东西**全部拆干净**。
		 * 起不来**绝不能**连累设置页与三个功能位：整段包在 try/catch 里，失败只记一条日志。
		 */
		function startDevicePanel(ctx) {
			try {
				if (panelDomAvailable() !== true) return;
				// 幂等：整块面板只起一次（槽位那一步还有自己的去重，见 registerPanelOverlay）。
				if (panelStarted === true) return;
				registerPanelOverlay(ctx);
				watchPanelRow();
				if (ctx !== null && ctx !== undefined && typeof ctx.effect === "function") {
					ctx.effect(function () {
						return function () {
							stopDevicePanel();
						};
					}, "dsh-remote 设备面板（侧栏行 · 集合态点 / 浮层）");
				}
			} catch (error) {
				panelLog("设备面板启动失败（不影响设置页与其它功能）：" + describeError(error));
			}
		}

		/** 卸载：停轮询、断观察器、移除自己插的节点、关掉浮层 —— 不留定时器、不留脏节点。 */
		function stopDevicePanel() {
			setPanelOverlayOpen(false);
			stopPanelRow();
			livePollStop();
			liveVisibilityOff();
			try {
				if (liveUnsub !== null) liveUnsub();
			} catch (error) {
				/* 已退 */
			}
			liveUnsub = null;
		}

		//#endregion

		function apply(ctx) {
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register(
					{
						name: "settings.section",
						id: "remote-connection",
						order: 60,
						label: function () {
							return "远程连接";
						},
					},
					RemoteConnectionSection,
				);
			});
			// 功能 1：文档预览**头部按钮区**（`sidebar.right.tab.document.actions`，list / session 作用域）。
			// order 900 = 同插槽里 open-in-app 的「显示文件位置」（它没写 order，默认 0）之后。
			// 注意：**不再**注册 `sidebar.right.tab.menu.item`（那是标签页「…」菜单，用户看不到）。
			ctx.slots.inject("sidebar.right.tab.document.actions", function () {
				return ctx.slots.register(
					{
						name: "sidebar.right.tab.document.actions",
						id: "remote-save-as",
						order: 900,
					},
					SaveAsAction,
				);
			});
			// 功能 2：会话「…」菜单的**末尾**（内置的 pin 100 / rename 200 / fork 300 / archive 400 之后）。
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
				return ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "remote-fork-to",
						order: 900,
					},
					ForkMenuItem,
				);
			});
			// 功能 3：远端模式下接管「添加工作区…」的目录选择（本机模式不注册）。
			// 接管失败**绝不能**连累设置页与两个菜单项：注册本身出错时只记一条警告就放过。
			try {
				registerDirectoryFlow(ctx);
			} catch (error) {
				try {
					if (globalThis.console !== null && typeof globalThis.console === "object" && typeof globalThis.console.warn === "function") {
						globalThis.console.warn("dsh-remote：远端目录流接管失败（设置页与菜单项不受影响）：" + describeError(error));
					}
				} catch (inner) {
					/* 连 console 都没有：只能算了 */
				}
			}
			// 功能 4：设备面板（侧栏那一行 / 浮层 / 胶囊集合态点）——**最后**起，起不来不影响上面任何一项。
			// 没有真实 DOM 的环境（自测替身 / 非浏览器）整块跳过：不注册槽位、不启动轮询。
			startDevicePanel(ctx);
			// 快捷键：Alt+Home = 回到本机（清掉当前设备 + 刷新一次）。
			try {
				var shortcutDoc = globalThis.document;
				if (shortcutDoc !== null && shortcutDoc !== undefined && typeof shortcutDoc.addEventListener === "function") {
					var onShortcut = function (event) {
						if (event === null || typeof event !== "object") return;
						if (event.defaultPrevented === true) return;
						if (event.altKey !== true) return;
						var key = event.key;
						var code = event.code;
						// Alt+F：召唤/收起设备切换浮层（与点侧栏「设备·…」那一行等价）。
						if (key === "f" || key === "F" || code === "KeyF") {
							try {
								event.preventDefault();
							} catch (error) {
								/* 忽略 */
							}
							setPanelOverlayOpen(panelOverlayOpen !== true);
							return;
						}
						// Alt+Home：回到本机。
						if (key !== "Home" && code !== "Home") return;
						// 已经在本机：什么都不做（避免无意义刷新）。
						if (readCurrentId() === "") return;
						try {
							event.preventDefault();
						} catch (error) {
							/* 忽略 */
						}
						applyDeviceSwitch("");
					};
					shortcutDoc.addEventListener("keydown", onShortcut);
					if (typeof ctx.effect === "function") {
						ctx.effect(function () {
							return function () {
								try {
									shortcutDoc.removeEventListener("keydown", onShortcut);
								} catch (error) {
									/* 忽略 */
								}
							};
						});
					}
				}
			} catch (error) {
				/* 没有 document：快捷键不可用，不影响其它功能 */
			}
		}

		/**
		 * 自测钩子（`_ops/tmp/` 里的自测脚本用）：只在 `globalThis.__DSH_REMOTE_PANEL_TEST__ === true` 时挂出来。
		 * 为什么要它：跨机聚合的状态矩阵（对端 `live:null` / `reachable:false` / 点一台设备发什么 body）
		 * 在真机上要两台机器配合才能构造，自测里只能直接喂/直接调。
		 * 生产页面里这个全局量不存在 ⇒ exports 上不会多任何字段。
		 */
		if (globalThis.__DSH_REMOTE_PANEL_TEST__ === true) {
			exports.__panel = {
				aggregateDot: aggregateDot,
				aggregateStateText: aggregateStateText,
				applyDotStyle: applyDotStyle,
				deviceStateTable: deviceStateTable,
				deviceStateById: deviceStateById,
				deviceList: deviceList,
				/** 本机那条的显示名（「<设备名>（本机）」/ 退回「本机」）—— 自测用。 */
				localEntryName: localEntryName,
				fetchLive: fetchLive,
				clearUnreadFor: clearUnreadFor,
				pickDevice: pickDevice,
				/** 目标对端"已知不可达"的原因（空串 = 可达 / 未知）—— 自测用。 */
				unreachableReason: unreachableReason,
				/** 客户端半自己的版本常量 / 宿主半报的版本（自测用）。 */
				clientVersion: function () {
					return CLIENT_VERSION;
				},
				hostVersion: function () {
					return liveHostVersion;
				},
				/** "版本不一致"的提示后缀（空串 = 一致 / 未知）—— 自测用。 */
				versionHint: versionHint,
				livePollStart: livePollStart,
				livePollStop: livePollStop,
				/** 那一行现在该画什么（集合态；空串 = 不画点）—— 自测用。 */
				rowDotState: function () {
					return aggregateDot(deviceStateTable());
				},
				liveSnapshot: function () {
					return { self: liveSelf, selfName: liveSelfName, peers: livePeers, source: liveSource, revision: liveRevision };
				},
				injectState: function () {
					return { ok: panelInjectState.ok, reason: panelInjectState.reason };
				},
			};
		}

		exports.name = "dsh-remote";
		// `uiWorkspace` 是目录流占据方的数据源（目录浏览走它的 listDirectory/createDirectory）；
		// `sessions` 用来给"对面已有工作区目录"当候选（远端模式下这份快照就是对面那台的）。
		exports.inject = ["slots", "uiWorkspace", "sessions"];
		exports.apply = apply;
		return module.exports;
	},
});


