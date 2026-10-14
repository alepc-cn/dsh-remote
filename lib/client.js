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

		/** 新增/修改一台设备。`props.device` 非空时进入"修改"模式（提交会带上它的 id）。 */
		function DeviceForm(props) {
			beginHooks();
			var initial = asObject(props.device);
			var pair = useStoredState({
				id: text(initial.id),
				name: text(initial.name),
				url: text(initial.url),
				token: "",
			});
			var form = pair[0];
			var setForm = pair[1];
			var busypair = useStoredState(false);
			var busy = busypair[0];
			var setBusy = busypair[1];
			var errpair = useStoredState("");
			var err = errpair[0];
			var setErr = errpair[1];

			/** 用函数式更新改表单：连续多次输入时每次都基于**最新**的表单值，不丢字段。 */
			function set(patch) {
				setForm(function (previous) {
					return { ...asObject(previous), ...patch };
				});
			}

			/** 清空表单（也走函数式更新，保持"表单更新一律函数式"这条约定）。 */
			function reset() {
				setForm(function () {
					return { id: "", name: "", url: "", token: "" };
				});
			}

			function submit() {
				var name = String(form.name || "").trim();
				var url = String(form.url || "").trim();
				if (name === "") {
					setErr("名称不能为空。");
					return;
				}
				if (url === "") {
					setErr("地址不能为空（形如 http://host:port）。");
					return;
				}
				setBusy(true);
				setErr("");
				var payload = { name: name, url: url };
				if (form.id !== "") payload.id = form.id;
				var token = String(form.token || "").trim();
				// 修改时 token 留空 = **不改动**原有 token，所以留空就干脆不带这个字段。
				if (token !== "") payload.token = token;
				request("/devices", { method: "POST", body: JSON.stringify(payload) })
					.then(unwrap)
					.then(function () {
						reset();
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
				h("div", { style: TITLE_STYLE }, form.id === "" ? "新增设备" : "修改设备：" + form.id),
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
						label: "地址",
						value: form.url,
						placeholder: "http://192.0.2.20:19387",
						onChange: function (value) {
							set({ url: value });
						},
					}),
					h(InputField, {
						label: "token",
						type: "password",
						value: form.token,
						placeholder: "可留空；修改时留空表示不改动原有 token",
						onChange: function (value) {
							set({ token: value });
						},
					}),
					h("div", { style: HINT_STYLE }, "地址要写完整的 http://host:port（可以带子路径，如 http://host:19387/dsh）。"),
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
						busy === true ? "提交中…" : form.id === "" ? "新增" : "保存修改",
					),
					form.id === ""
						? null
						: h(
								"button",
								{
									type: "button",
									style: BTN_STYLE,
									onClick: function () {
										reset();
										setErr("");
									},
								},
								"取消修改",
							),
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

			var rows = [];
			for (var index = 0; index < devices.length; index += 1) {
				rows.push(
					(function buildRow(device) {
						var id = text(device.id);
						var isLocal = device.local === true;
						var currentId = readCurrentId();
						var isCurrent = isLocal ? currentId === "" : currentId === id;
						var switching = isLocal ? currentId !== "" : currentId !== id;
						var edit = editId === id;
						var testNote = notes.test[id];
						var name = text(device.name) === "" ? id : text(device.name);
						var lastError = text(device.lastError);
						var lastOkAt = formatTime(device.lastOkAt);
						// 注意别叫 notes：那会遮住组件级的 notes 状态（测试结果存在那里）。
						var rowNotes = [];
						if (testNote !== undefined) rowNotes.push(h("div", { key: "test", style: HINT_STYLE }, testNote));
						if (edit) {
							rowNotes.push(
								h("div", { key: "edit", style: HINT_STYLE }, "已选中这台设备：下面的表单会带上它的 id，改完点「保存修改」。"),
							);
						}
						return h(
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
					})(asObject(devices[index])),
				);
			}

			var editDevice = editId === null ? null : asObject(findDevice(devices, editId));
			var formKey = editId === null ? "new" : "edit-" + editId;

			return h(
				"div",
				{ style: SECTION_STYLE },
				h(
					"div",
					{ key: "head", style: ROW_STYLE },
					h("span", { style: { ...TITLE_STYLE, flex: "1 1 auto" } }, "设备管理"),
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
					key: formKey,
					device: editDevice,
					onSaved: function () {
						setEditId(null);
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
			);
		}

		//#endregion

		//#region 两个菜单项（功能 1「另存为…」/ 功能 2「分叉到…」）

		/**
		 * 给用户一条明确反馈。菜单项一点就随菜单卸载，没有地方放行内文本，所以：
		 * 优先 `alert`（桌面壳支持），拿不到就退到 `console.warn` —— 绝不抛异常、绝不白屏。
		 */
		function notify(message) {
			var text_ = text(message);
			try {
				if (globalThis !== null && typeof globalThis === "object" && typeof globalThis.alert === "function") {
					globalThis.alert(text_);
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
		}

		exports.name = "dsh-remote";
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});
