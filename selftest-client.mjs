/**
 * selftest-client.mjs —— @local/dsh-remote 客户端半（lib/client.js）的自测。
 *
 * 覆盖的是"三页合并成一页"之后的形态：**只有 1 个** settings.section（id remote-connection，
 * order 60，label「远程连接」），页面内自上而下 4 块 —— 插件开关 / 本机地址（默认收起）/
 * 设备管理 / 体检。
 *
 * 零依赖、离线：
 * - 用 `node:vm` 把 lib/client.js 的**源码**在一个假全局环境里执行（每个用例都是全新的一次求值，
 *   不受 ESM 模块缓存影响），假的 `window.__ModuleLoader__.load` 抓住 factory；
 * - 假 `require("react")` 提供最小 React 替身（createElement / useState / useEffect）；
 * - 组件是**真的调用一遍**（首帧渲染 + 跑一次 effect），按钮的 onClick 也是真的点一遍；
 * - 最后做源码文本断言（localStorage 键名、依赖、契约路由、两个不许回退的修复）。
 *
 * 跑法（与任务书一致）：
 *   & "C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" selftest-client.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(HERE, "lib", "client.js");
const SOURCE = readFileSync(CLIENT_PATH, "utf8");
/** 求值时的假文件名（只影响报错栈）。 */
const FILENAME = CLIENT_PATH;

//#region 迷你测试框架

let passed = 0;
const failures = [];
const pending = [];

function check(name, fn) {
	const report = (ok, error) => {
		if (ok) {
			passed += 1;
			console.log(`  ✅ ${name}`);
			return;
		}
		failures.push({ name, error });
		console.log(`  ❌ ${name}`);
		console.log(`      ${error && error.message ? error.message : String(error)}`);
	};
	try {
		const result = fn();
		if (result !== null && typeof result === "object" && typeof result.then === "function") {
			pending.push(result.then(() => report(true), (error) => report(false, error)));
			return;
		}
		report(true);
	} catch (error) {
		report(false, error);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message || "断言失败");
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) {
		throw new Error(`${message || "值不相等"}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

/** 让 effect 里的 promise 链跑完（假 fetch 立即 resolve，但链上有 text() 等若干 then）。 */
async function settle() {
	for (let index = 0; index < 3; index += 1) {
		await new Promise((done) => setTimeout(done, 0));
	}
}

//#endregion

//#region 环境替身

/** 假的 localStorage（记录动作，便于断言 setItem/removeItem）。 */
function createStorage() {
	const map = new Map();
	const log = [];
	return {
		log,
		getItem(key) {
			return map.has(key) ? map.get(key) : null;
		},
		setItem(key, value) {
			log.push({ op: "set", key, value: String(value) });
			map.set(key, String(value));
		},
		removeItem(key) {
			log.push({ op: "remove", key });
			map.delete(key);
		},
		has(key) {
			return map.has(key);
		},
	};
}

/**
 * 跨 realm 安全的"读数组"：按序号取值，得到的是一个宿主自己的新数组。
 * 不能用 `Array.from(guestArray)`（会用对方的 Array 构造器/pecies），也不该指望
 * `guestArray.filter/find` 这些方法在本 realm 里行为一致。
 */
function readArray(value) {
	const out = [];
	let length = 0;
	try {
		length = Number(value.length) || 0;
	} catch (error) {
		return out;
	}
	for (let index = 0; index < length; index += 1) out.push(value[index]);
	return out;
}

/** 跨 realm 安全的数组判定：lib/client.js 是在 vm 里求值的，它造出来的数组
 * 在宿主 realm 里 `Array.isArray` 会返回 false（这正是本用例要覆盖的一类真实故障）。
 */
function isArray(value) {
	return Object.prototype.toString.call(value) === "[object Array]";
}

/**
 * 渲染出来的"元素"：够用的假节点，只承载 createElement 的入参，
 * 不参与任何真实 DOM 行为（组件里没有 ref / 真实 DOM 依赖）。
 */
function createElementStub(type, props, ...children) {
	const flat = [];
	for (const child of children) {
		// 用跨 realm 的 isArray：children 数组是 vm 里造出来的，宿主 Array.isArray 对它返回 false，
		// 不处理的话 `children.push(...)` 攒出来的那一批子节点会被当成单个节点塞进去。
		if (isArray(child)) flat.push(...child.flat(Infinity));
		else if (child !== undefined && child !== null && child !== false && child !== true) flat.push(child);
	}
	return { type, props: props === undefined || props === null ? {} : props, children: flat };
}

/** 取一个假节点的子节点（"元素"是 vm 里造的，字段名可能与本地不同，这里两种都认）。
 * 数组子节点（`h("div", null, rows)` 这种写法）也在这里被摊平，和 React 的渲染结果一致。 */
function childrenOf(node) {
	const raw = isArray(node.children) ? node.children : isArray(node.kids) ? node.kids : [];
	const out = [];
	for (let index = 0; index < raw.length; index += 1) {
		const child = raw[index];
		if (isArray(child)) {
			for (let inner = 0; inner < child.length; inner += 1) out.push(child[inner]);
		} else {
			out.push(child);
		}
	}
	return out;
}

/** 把一棵渲染树压平成数组（含根）。 */
function flatten(root, out = []) {
	if (root === null || root === undefined) return out;
	if (isArray(root)) {
		for (const item of root) flatten(item, out);
		return out;
	}
	if (typeof root !== "object") return out;
	out.push(root);
	for (const child of childrenOf(root)) flatten(child, out);
	return out;
}

/** 收集所有文本（元素节点本身 + 它们的字符串子节点）。 */
function collectText(root) {
	let buffer = "";
	const walk = (node) => {
		if (node === null || node === undefined || node === false || node === true) return;
		if (isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (typeof node === "string" || typeof node === "number") {
			buffer += String(node) + "\n";
			return;
		}
		if (typeof node !== "object") return;
		const hasKids = childrenOf(node).length > 0;
		if (!hasKids && (typeof node.type === "string" || typeof node.type === "number")) buffer += String(node.type) + "\n";
		for (const child of childrenOf(node)) walk(child);
	};
	walk(root);
	return buffer;
}

/** 按调用序号找第一个匹配的元素（宿主侧读"另一个 realm 的数组"用，避免依赖对方的 Array 工具方法）。 */
function findBy(arr, predicate) {
	const list = readArray(arr);
	for (let index = 0; index < list.length; index += 1) if (predicate(list[index])) return list[index];
	return undefined;
}

/** 过滤（同上）。 */
function filterBy(arr, predicate) {
	const list = readArray(arr);
	const out = [];
	for (let index = 0; index < list.length; index += 1) if (predicate(list[index])) out.push(list[index]);
	return out;
}

/** 在渲染树里按谓词找节点。 */
function findAll(root, predicate) {
	return flatten(root).filter((node) => predicate(node));
}

/**
 * 把一棵子树的文字压成"人能读的一行"。
 *
 * 为什么需要它：`collectText` 在**节点之间**插 `\n`，而「分叉到 <设备名>」这类行里设备名是
 * **独立节点**（加重的 span），于是原文是 `分叉到 \n设备B`。断言必须按 `\s+ → 空格`
 * 归一化后再比对，否则"文案仍能识别出 `分叉到 <设备名>`"这条根本没法写。
 */
function flatText(node) {
	return collectText(node).replace(/\s+/g, " ").trim();
}

/** 按按钮文字找按钮节点（返回全部命中；比对用归一化后的文字）。 */
function findAllButtons(root, label) {
	return findAll(root, (node) => node.type === "button" && flatText(node).includes(label));
}

function findButton(root, label) {
	return findAllButtons(root, label)[0];
}

/** 找"文字正好就是这个"的按钮（避免「已复制」被「复制」的子串匹配命中）。 */
function findButtonExact(root, label) {
	return findAllButtons(root, label).filter((button) => flatText(button) === label)[0];
}

/**
 * 在一棵渲染树里找"加重的设备名节点"：`<strong>` 或 `style.fontWeight >= 600` 的 span，
 * 且它的文字正好是那个设备名（用来断言「分叉到 <设备名>」里的设备名真的被加重了）。
 */
function findEmphasis(root, name) {
	return flatten(root).filter((node) => {
		if (node.type !== "span" && node.type !== "strong") return false;
		const style = node.props === undefined || node.props === null ? undefined : node.props.style;
		const weight = style === undefined || style === null ? undefined : Number(style.fontWeight);
		const bold = node.type === "strong" || (Number.isFinite(weight) && weight >= 600);
		return bold && flatText(node) === name;
	})[0];
}

/** 点第 n 个（从 0 数）文字匹配的按钮。 */
function clickNth(root, label, index) {
	const buttons = findAllButtons(root, label);
	assert(buttons[index] !== undefined, `找不到第 ${index + 1} 个「${label}」按钮`);
	buttons[index].props.onClick({ target: buttons[index] });
	return buttons[index];
}

/**
 * 标题栏按钮区的**纯图标按钮**（目前只有「另存为…」）：按 `data-dsh-remote` 取。
 *
 * 为什么不能再用按文字找：`renderToolbarAction` 的新实现照抄邻居外圈，并且**只渲染图标**
 * （调用点固定 `iconOnly: true`）—— 按钮里一个字都没有，`flatText` 拿到的永远是空串
 * （连图标都取不到时甚至是宿主标签名 "button"）。所以身份用 testId，文案断言改用
 * `title` / `aria-label`（这两个才是纯图标按钮给人读的名字）。
 */
function findToolbarActions(root, testId) {
	return findAll(root, (node) => node.type === "button" && node.props !== undefined && node.props !== null && node.props["data-dsh-remote"] === testId);
}

/** 取第一个纯图标标题栏按钮（找不到就是 undefined）。 */
function findToolbarAction(root, testId) {
	return findToolbarActions(root, testId)[0];
}

/** 点第 n 个（从 0 数）纯图标标题栏按钮。 */
function clickToolbarAction(root, testId, index = 0) {
	const buttons = findToolbarActions(root, testId);
	assert(buttons[index] !== undefined, `找不到第 ${index + 1} 个 <button data-dsh-remote=${testId}>（标题栏纯图标按钮）`);
	buttons[index].props.onClick({ target: buttons[index] });
	return buttons[index];
}

/** 渲染循环的轮数上限（effect 里 setState → 再渲染，稳定就停）。 */
const MAX_RENDERS = 8;

/** 渲染栈（每次渲染临时往里压，见 createSandbox）。 */
let renderStack = [];

/**
 * 渲染一个组件节点：函数组件会被真的调用（假 React 也照 React 的规矩展开子组件），
 * 这样渲染树里就没有"没展开的函数组件"了，断言能一直查到最里面的文本与按钮。
 * 进/出函数组件时维护渲染栈，hook 才能归到正确的组件上。
 */
function renderNode(node) {
	let current = node;
	for (let round = 0; round < 40; round += 1) {
		if (current === null || current === undefined) return null;
		if (isArray(current)) {
			const list = [];
			let length = 0;
			try {
				length = Number(current.length) || 0;
			} catch (error) {
				length = 0;
			}
			for (let index = 0; index < length; index += 1) {
				const child = renderNode(current[index]);
				if (child !== null && child !== undefined) list.push(child);
			}
			return list;
		}
		if (typeof current !== "object") return current;
		if (typeof current.type !== "function") {
			// 宿主元素：把子节点里的函数组件也展开。
			const kids = childrenOf(current);
			const expanded = [];
			for (let index = 0; index < kids.length; index += 1) {
				const child = renderNode(kids[index]);
				if (isArray(child)) {
					for (let inner = 0; inner < child.length; inner += 1) expanded.push(child[inner]);
				} else if (child !== null && child !== undefined) {
					expanded.push(child);
				}
			}
			current.children = expanded;
			return current;
		}
		const props = current.props || {};
		// React 语义：**children 是 props 的一部分**，函数组件从 `props.children` 读子节点。
		// 本 harness 把子节点存在元素节点的 `children` 上（createElementStub），所以这里补一份 ——
		// 否则官方组件的替身（`Button` / `MenuItemButton`）拿不到 children，渲染出来是空按钮。
		if (props.children === undefined) {
			const prepared = childrenOf(current);
			if (prepared.length > 0) props.children = prepared.length === 1 ? prepared[0] : prepared;
		}
		if (props.children !== undefined) {
			const kids = [];
			if (isArray(props.children)) {
				for (let index = 0; index < props.children.length; index += 1) kids.push(props.children[index]);
			} else {
				kids.push(props.children);
			}
			props.children = kids;
		}
		Array.prototype.push.call(renderStack, current.type);
		try {
			current = current.type(props);
		} finally {
			renderStack.pop();
		}
	}
	return current;
}

/**
 * 应用一次 state 更新。字符串/对象的 setter 直接赋值；**函数式更新**（`setForm(prev => ...)`，
 * React 的标准写法）在这里把当前值喂给那个函数 —— 忘了支持它就会把函数本身当成新状态，
 * 表单连续编辑看起来就"丢字段"。
 */
function applyUpdate(slots, update) {
	const current = slots[update.index];
	const value = typeof update.value === "function" ? update.value(current) : update.value;
	slots[update.index] = value;
	return value;
}

/**
 * 假 React（带**真正的渲染循环**）：
 * - `createElement` 只记录结构（不碰真实 DOM）；
 * - `useState` 的值按调用序号持久化在 stateSlots 里，setter 入队后由 renderLoop 触发重渲染；
 * - `useEffect` 收集副作用、渲染结束后执行（**同步**执行，与 React 的 commit 阶段一致）；
 * - 额外提供 useCallback/useMemo/useRef，但**只要被插件碰到就直接抛错**：客户端半承诺只用
 *   useState/useEffect 两个入口，这条断言能防止以后无意中引入别的 React API。
 */
function createReactStub(sandbox) {
	const slotsByType = new WeakMap(); // 每个组件函数一份状态槽位（真实 React 就是这样）
	let pendingEffects = []; // 本次渲染登记的 effect
	let queue = []; // 待应用的 state 更新
	let flushCount = 0;
	let lastCleanups = [];
	let slotCounters = new WeakMap(); // 每个组件各自的 hook 游标（真实 React 也是按组件数的）

	/** 取"当前正在调 hook 的组件"（嵌套函数组件用栈顶）。 */
	function owner() {
		return renderStack.length > 0 ? renderStack[renderStack.length - 1] : undefined;
	}

	/**
	 * 取某个组件的状态槽位。用组件函数当键（同类组件共享一份状态，和真实 React 一样）；
	 * 万一拿不到组件标识，就退回一个"无名槽位"，绝不让测试自己造出来的边界把用例炸掉。
	 */
	function slotsOf(type) {
		if (type === null || type === undefined) {
			if (slotsByType.get(anonSlots) === undefined) slotsByType.set(anonSlots, []);
			return slotsByType.get(anonSlots);
		}
		if (!slotsByType.has(type)) slotsByType.set(type, []);
		return slotsByType.get(type);
	}
	const anonSlots = function anonymousSlots() {};

	function forbidden(name) {
		return () => {
			throw new Error(`客户端半不应该使用 react.${name}（只用 useState/useEffect）`);
		};
	}

	const react = {
		Fragment: Symbol.for("react.fragment"),
		createElement: createElementStub,
		useState(initial) {
			const type = owner();
			const slots = slotsOf(type);
			const key = type === null || type === undefined ? anonSlots : type;
			// 游标按组件走：每个组件的第一个 useState 都是槽位 0（之前用一个全局游标，
			// 结果 CopyButton 的状态被记到了槽位 1，重渲染读槽位 0 就永远看不到"已复制"）。
			const index = slotCounters.get(key) || 0;
			slotCounters.set(key, index + 1);
			if (!(index in slots)) slots[index] = initial;
			const setter = (value) => {
				Array.prototype.push.call(sandbox.log, { op: "setState", index, value });
				Array.prototype.push.call(sandbox.stateWrites, { index, value });
				// 槽位属于**这个组件**：不同组件的槽位彼此独立。
				Array.prototype.push.call(queue, { type, index, value });
			};
			return [slots[index], setter];
		},
		useEffect(fn) {
			// 只登记：本次渲染返回之后由 flushEffects 执行（与 React 的时序一致）。
			Array.prototype.push.call(pendingEffects, fn);
			return undefined;
		},
		get useCallback() {
			return forbidden("useCallback");
		},
		get useMemo() {
			return forbidden("useMemo");
		},
		get useRef() {
			return forbidden("useRef");
		},
	};

	return {
		react,
		/** 执行本次渲染登记的 effect（渲染返回之后调用）。 */
		flushEffects() {
			const queued = pendingEffects;
			pendingEffects = [];
			if (queued.length === 0) return 0;
			// 上一轮的清理函数（模拟卸载/依赖变化前的清理）。
			for (let index = 0; index < lastCleanups.length; index += 1) {
				if (typeof lastCleanups[index] === "function") lastCleanups[index]();
			}
			lastCleanups = [];
			for (let index = 0; index < queued.length; index += 1) {
				const fn = queued[index];
				assert(typeof fn === "function", "useEffect 的回调必须是函数");
				const cleanup = fn();
				if (cleanup !== undefined && typeof cleanup !== "function") {
					throw new Error("useEffect 的返回值（清理函数）必须是函数或 undefined");
				}
				if (typeof cleanup === "function") Array.prototype.push.call(lastCleanups, cleanup);
				sandbox.effectsRan += 1;
			}
			flushCount += 1;
			return queued.length;
		},
		/**
		 * 真正的渲染循环：渲染 → 执行 effect →（effect 里的 setState 让状态变化则）再渲染，
		 * 最多 MAX_RENDERS 轮，避免死循环。
		 * @returns 最后一轮渲染出来的树。
		 */
		renderLoop(component, props) {
			let tree = null;
			for (let round = 0; round < MAX_RENDERS; round += 1) {
				// 先把"上一次渲染之后攒下的"状态更新落到对应组件的槽位上
				// （effect 里的 setState，或者上一轮 await 期间 promise 回调里的 setState）。
				const pendingUpdates = queue;
				queue = [];
				for (let index = 0; index < pendingUpdates.length; index += 1) {
					const update = pendingUpdates[index];
					applyUpdate(slotsOf(update.type), update);
				}
				// 组件树里每个函数组件各自压栈，hook 才能归到正确的组件上。
				renderStack = sandbox.renderStack;
				slotCounters = new WeakMap();
				pendingEffects = [];
				tree = renderNode(component(props));
				renderStack = [];
				this.flushEffects();
				// 这一轮又产生了新的状态更新 → 需要再渲染一次；没有就稳定了。
				if (queue.length === 0) break;
			}
			return tree;
		},
		get renders() {
			return flushCount;
		},
	};
}

/**
 * 假 `@deepseek-ai/dsh-client-ui-primitives`（只在 `createSandbox({ primitives: true })` 时生效）。
 *
 * 为什么需要它：默认替身对任何 require 都返回假 react（没有 `Button` / `MenuItemButton` /
 * 图标），客户端半于是永远走**回退分支**；真实环境里两者都在。这份替身**只复刻断言需要的
 * 那几个导出**，用来验证"官方组件分支"的 props 形状：
 *   - `Button`：按 `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` 里那个 `forwardRef`
 *     的入参形状复刻（`variant` / `size` / `icon` / `className` / `children`，其余透传给
 *     `<button>`，并且自带宽高与 `type="button"`）；
 *   - `MenuItemButton`：菜单行（`icon` + `children` + 其余透传，`role="menuitem"`）；
 *   - 图标：渲染成 `<span data-icon="<名字>">`（真图标是装饰性 svg，一个字都没有）。
 */
function createPrimitivesStub(sandbox) {
	const react = sandbox.reactStub.react;
	const h = react.createElement;
	const icon = (name) =>
		function Icon(props) {
			const size = props === undefined || props === null ? undefined : props.size;
			// 空串子节点是刻意的：假 collectText 会给"没有子节点的宿主元素"补上标签名
			// （"span"），加一个空串子节点就不会把标签名混进按钮文字里 —— 真 DOM 里图标本来就无文字。
			return h("span", { "data-icon": name, "data-size": size }, "");
		};
	function Button(props) {
		const rest = { ...props };
		const variant = rest.variant === undefined ? "ghost" : rest.variant;
		const size = rest.size === undefined ? "md" : rest.size;
		const iconNode = rest.icon;
		delete rest.variant;
		delete rest.size;
		delete rest.icon;
		delete rest.children;
		return h(
			"button",
			{ type: "button", "data-variant": variant, "data-size": size, ...rest },
			iconNode === undefined || iconNode === null ? null : h("span", { className: "icon" }, iconNode),
			props.children,
		);
	}
	function MenuItemButton(props) {
		const rest = { ...props };
		const iconNode = rest.icon;
		delete rest.icon;
		delete rest.children;
		return h(
			"button",
			{ type: "button", role: "menuitem", ...rest },
			iconNode === undefined || iconNode === null ? null : h("span", { className: "icon" }, iconNode),
			props.children,
		);
	}
	return {
		Button,
		MenuItemButton,
		IconDownloadOutlineRegular: icon("IconDownloadOutlineRegular"),
		IconBranchOutlineRegular: icon("IconBranchOutlineRegular"),
	};
}

/**
 * 建立一次"页面环境"。这个对象**本身**就是 vm 的全局对象（会被 createContext 补上内建量），
 * 所以 vm 里对 localStorage / location 的读写，测试里立刻就能看到。
 */
function createSandbox(options = {}) {
	const sandbox = {
		// 渲染栈：renderNode 每进/出一个函数组件就压/弹一层，hook 据此知道自己是哪个组件的。
		renderStack: [],
		log: [],
		fetchCalls: [],
		stateWrites: [],
		pendingEffects: [],
		clipboardWrites: [],
		settingsSections: [],
		requireCalls: [],
		reloads: 0,
		/** `location.assign` 的调用记录（功能 1「另存为…」就是靠它跳转）。 */
		navigations: [],
		/** `alert` 的调用记录（菜单项点完就卸载，结果只能用 alert 报）。 */
		alerts: [],
		prompts: [],
		confirms: [],
		effectsRan: 0,
		responses: options.responses || {},
		localStorage: createStorage(),
		// 软开关的两个会话级标记（哨兵 / 强制激活）走 sessionStorage，也带动作日志。
		sessionStorage: createStorage(),
	};
	sandbox.context = createContext(sandbox);

	sandbox.window = {
		__ModuleLoader__: {
			load(definition) {
				sandbox.loaded = definition;
			},
		},
	};
	sandbox.window.localStorage = sandbox.localStorage;
	sandbox.window.sessionStorage = sandbox.sessionStorage;
	sandbox.window.navigator = options.withClipboard
		? {
				clipboard: {
					writeText(text) {
						Array.prototype.push.call(sandbox.clipboardWrites, String(text));
						return Promise.resolve();
					},
				},
			}
		: undefined;
	sandbox.window.location = {
		href: "http://127.0.0.1:19387/",
		reload() {
			sandbox.reloads += 1;
		},
		assign(url) {
			Array.prototype.push.call(sandbox.navigations, String(url));
		},
	};
	sandbox.window.document = { baseURI: "http://127.0.0.1:19387/" };

	/** 假 fetch：按 `options.responses` 里登记的路径返回脚本化的 JSON。 */
	sandbox.fetch = (url, init) => {
		const target = String(url);
		Array.prototype.push.call(sandbox.fetchCalls, { url: target, init: init || {} });
		const scripted = sandbox.responses[target];
		if (scripted === "reject") return Promise.reject(new Error("boom"));
		const body = scripted === undefined ? "{}" : typeof scripted === "string" ? scripted : JSON.stringify(scripted);
		return Promise.resolve({
			ok: scripted !== "fail",
			status: scripted === "fail" ? 500 : 200,
			text: () => Promise.resolve(body),
		});
	};
	sandbox.window.fetch = sandbox.fetch;

	// 组件读的是 globalThis.*，在 vm 里就是这些全局量。
	sandbox.location = sandbox.window.location;
	sandbox.document = sandbox.window.document;
	sandbox.fetchRef = sandbox.fetch;
	sandbox.navigator = sandbox.window.navigator;
	sandbox.prompt = (message, value) => {
		sandbox.prompts.push({ message, value });
	};
	/** 两个菜单项的结果提示走 alert（点完菜单就卸载了，没有行内位置）。 */
	sandbox.alert = (message) => {
		Array.prototype.push.call(sandbox.alerts, String(message));
	};
	sandbox.readNavigations = () => readArray(sandbox.navigations);
	sandbox.readAlerts = () => readArray(sandbox.alerts);
	sandbox.confirm = (message) => {
		sandbox.confirms.push(message);
		return options.confirmAnswer === undefined ? true : options.confirmAnswer;
	};
	// 定时器要**真的等到时间到**才触发：否则"已复制"(1500ms 后复位) 这种瞬时状态根本看不到。
	sandbox.now = 0;
	sandbox.timers = [];
	sandbox.setTimeout = (fn, delay) => {
		const handle = sandbox.timers.length + 1;
		Array.prototype.push.call(sandbox.timers, { handle, fn, at: sandbox.now + (Number(delay) || 0) });
		return handle;
	};
	sandbox.clearTimeout = (handle) => {
		for (let index = 0; index < sandbox.timers.length; index += 1) {
			if (sandbox.timers[index].handle === handle) sandbox.timers[index].cancelled = true;
		}
	};
	/** 推进时间并执行到期的定时器（默认推进 0，即只跑"立刻到期"的那些）。 */
	sandbox.tick = (ms = 0) => {
		sandbox.now += ms;
		const due = [];
		const rest = [];
		for (let index = 0; index < sandbox.timers.length; index += 1) {
			const timer = sandbox.timers[index];
			if (timer.cancelled === true) continue;
			if (timer.at <= sandbox.now) Array.prototype.push.call(due, timer);
			else Array.prototype.push.call(rest, timer);
		}
		sandbox.timers = rest;
		for (let index = 0; index < due.length; index += 1) {
			if (typeof due[index].fn === "function") due[index].fn();
		}
	};
	sandbox.URL = URL;

	sandbox.reactStub = createReactStub(sandbox);
	/** 要不要给 require 替身一份**有 Button / MenuItemButton / 图标**的假 ui-primitives。 */
	sandbox.primitivesStub = options.primitives === true ? createPrimitivesStub(sandbox) : undefined;

	/** 把"另一个 realm 的数组"拷成本 realm 的数组，供断言使用。 */
	sandbox.readLog = () => readArray(sandbox.log);
	sandbox.readFetch = () => readArray(sandbox.fetchCalls);
	sandbox.readWrites = () => readArray(sandbox.stateWrites);

	/** 求值一次 lib/client.js（全新全局环境），返回 exports。 */
	sandbox.loadModule = () => {
		sandbox.loaded = undefined;
		runInContext(SOURCE, sandbox.context, { filename: FILENAME });
		assert(sandbox.loaded !== undefined && sandbox.loaded !== null, "window.__ModuleLoader__.load 没有被调用");
		sandbox.moduleExports = sandbox.loaded.factory((id) => {
			sandbox.requireCalls.push(String(id));
			// 默认：对任何 id 都返回假 react（于是组件走回退分支，等价于真实环境里 primitives === null）。
			// `primitives: true` 时，第二个 require 拿到有 Button/MenuItemButton/图标的替身。
			if (sandbox.primitivesStub !== undefined && String(id) === "@deepseek-ai/dsh-client-ui-primitives") {
				return sandbox.primitivesStub;
			}
			return sandbox.reactStub.react;
		});
		return sandbox.moduleExports;
	};

	/** 用假 ctx.slots 跑一遍 apply，返回注册记录。 */
	sandbox.applyModule = () => {
		const ctx = {
			slots: {
				inject(slotName, register) {
					Array.prototype.push.call(sandbox.log, { op: "inject", slotName });
					// 任务书要求：宿主立刻执行这个回调。
					return register();
				},
				register(options_, component) {
					sandbox.settingsSections.push({ options: options_, component });
					return { dispose() {} };
				},
			},
		};
		sandbox.moduleExports.apply(ctx);
		return sandbox.settingsSections;
	};

	/**
	 * 渲染一个组件：跑真正的渲染循环（effect 里的 setState 会触发再渲染）。
	 * `skipEffect` 用于"首帧"断言（只渲染一次、不执行 effect）。
	 */
	sandbox.render = (component, props, renderOptions = {}) => {
		sandbox.effectsRan = 0;
		const tree = renderOptions.skipEffect === true
			? renderNode(component(props === undefined ? {} : props))
			: sandbox.reactStub.renderLoop(component, props === undefined ? {} : props);
		return { tree, effectsRan: sandbox.effectsRan };
	};

	/**
	 * 渲染 + 等 fetch 的 promise 链跑完 + 再渲染一次（"页面已经拿到数据"的状态，
	 * 等价于真实 React 里 setState 之后的那次重渲染）。再渲染会重跑 effect，
	 * 所以异步回调特意用 alive 标志做了清理，重复渲染是安全的。
	 */
	sandbox.renderLoaded = async (component, props) => {
		sandbox.render(component, props);
		await settle();
		const result = sandbox.render(component, props);
		if (process.env.DSH_DEBUG) {
			console.log("DBG loaded:", JSON.stringify(collectText(result.tree)));
		}
		return result;
	};

	/**
	 * 点按钮之后用：让点击触发的 fetch 链跑完，再渲染。反复"等 + 渲染"直到没有新的
	 * 状态写入（最多 3 轮），这样"测试中… → ✅ 连通"这种两段式异步结果也能看到。
	 */
	sandbox.settleRenders = async (component, props) => {
		let tree = null;
		for (let round = 0; round < 3; round += 1) {
			const before = sandbox.stateWrites.length;
			await settle();
			const result = sandbox.render(component, props);
			tree = result.tree;
			if (sandbox.stateWrites.length === before) break;
		}
		return { tree };
	};

	return sandbox;
}

//#endregion

//#region 0. 加载与导出

section("0. 加载 lib/client.js（假 __ModuleLoader__ + 假 react）");

const boot = createSandbox();
const EXPORTS = boot.loadModule();

check("factory 被调用，load 的 id 正确", () => {
	assert(boot.loaded !== undefined, "load 没有被调用");
	assertEqual(boot.loaded.id, "@local/dsh-remote", "load 的 id");
	assertEqual(typeof boot.loaded.factory, "function", "load 的 factory 类型");
});

check("exports 含 name / inject / apply，inject 含 slots", () => {
	assertEqual(typeof EXPORTS.name, "string", "exports.name 类型");
	assertEqual(EXPORTS.name, "dsh-remote", "exports.name");
	assert(Array.isArray(EXPORTS.inject), "exports.inject 必须是数组");
	assert(EXPORTS.inject.includes("slots"), 'exports.inject 必须含 "slots"');
	assertEqual(typeof EXPORTS.apply, "function", "exports.apply 类型");
});

check('factory 的 require 只有 react 与 @deepseek-ai/dsh-client-ui-primitives（别的都不许）', () => {
	// 新实现多了一个官方菜单项依赖（放在 try/catch 里，取不到就当 null）。
	// harness 的 require 替身对任何 id 都返回假 react（它没有 MenuItemButton），
	// 于是组件走 renderMenuItem() 里的**普通 `<button role="menuitem">` 回退分支**
	// —— 下面所有菜单项断言都按回退分支写（等价于真实环境里 primitives === null）。
	assertEqual(
		JSON.stringify(boot.requireCalls),
		JSON.stringify(["react", "@deepseek-ai/dsh-client-ui-primitives"]),
		"require 的实际入参",
	);
});

//#endregion

//#region 1. 槽位注册（三页合并成一页）

section("1. ctx.slots 注册（恰好 1 个 settings.section：远程连接 / order 60）");

const SECTIONS = boot.applyModule();

/**
 * 取某个 sandbox 的一次 apply 结果（同一 sandbox 只 apply 一次，结果缓存复用）。
 *
 * 两点都很重要：
 * 1. 组件必须用它所在 sandbox 的 react 实例来渲染（假 React 的 effect 队列按 sandbox 分开）；
 * 2. 必须拿到**同一个组件函数对象**——假 React 像真 React 一样按组件标识保存状态，
 *    重新 apply 得到新函数就等于"换了个组件"，状态会被重置，断言就会看不到点击结果。
 */
function slotEntries(sandbox) {
	if (sandbox.entriesCache === undefined) sandbox.entriesCache = sandbox.applyModule();
	return readArray(sandbox.entriesCache);
}

function page(sandbox) {
	if (sandbox.pageCache === undefined) sandbox.pageCache = slotEntries(sandbox)[0];
	return sandbox.pageCache;
}

/** 按槽名取注册项（找不到就抛，好让断言给出清楚的原因）。 */
function slotEntry(sandbox, slotName) {
	const entries = slotEntries(sandbox);
	for (let index = 0; index < entries.length; index += 1) {
		if (entries[index].options.name === slotName) return entries[index];
	}
	throw new Error(`没有注册槽位 ${slotName}（实际：${entries.map((row) => row.options.name).join(", ")}）`);
}

check("inject 恰好 3 次，槽名是 settings.section + 文档头部按钮区 + 会话菜单", () => {
	const injected = boot.log.filter((entry) => entry.op === "inject");
	assertEqual(injected.length, 3, "inject 次数");
	assertEqual(
		JSON.stringify(injected.map((entry) => entry.slotName)),
		JSON.stringify(["settings.section", "sidebar.right.tab.document.actions", "sidebar.workspaces.session.menu.item"]),
		"槽名与顺序（settings.section 必须第一个：后面的用例按 [0] 取它）",
	);
});

check("注册了 3 项：1 个 settings.section + 文档头部按钮区 + 会话菜单（原来那三页不再存在）", () => {
	assertEqual(SECTIONS.length, 3, `注册数（收到 ${SECTIONS.length} 个）`);
	const entry = SECTIONS[0];
	assertEqual(entry.options.name, "settings.section", "第一项的槽名");
	assertEqual(typeof entry.options.label, "function", "label 必须是函数");
	assertEqual(typeof entry.component, "function", "组件必须是函数");
	const names = SECTIONS.map((row) => row.options.name);
	for (const wanted of ["sidebar.right.tab.document.actions", "sidebar.workspaces.session.menu.item"]) {
		assert(names.includes(wanted), `缺少槽位注册：${wanted}`);
	}
});

check("「另存为…」的挂载点已从 sidebar.right.tab.menu.item 换成 sidebar.right.tab.document.actions", () => {
	// ① 运行时：按槽名取得到 document.actions，取不到旧的菜单槽（slotEntry 找不到会抛）。
	const save = slotEntry(boot, "sidebar.right.tab.document.actions");
	assertEqual(save.options.id, "remote-save-as", "另存为的 id");
	assert(slotEntries(boot).every((row) => row.options.name !== "sidebar.right.tab.menu.item"),
		"任何一项都不许再注册到 sidebar.right.tab.menu.item（那是标签页「…」菜单，用户看不到它）");
	let threw = false;
	try {
		slotEntry(boot, "sidebar.right.tab.menu.item");
	} catch (error) {
		threw = true;
	}
	assert(threw, "旧槽位 sidebar.right.tab.menu.item 必须已经不再注册");
	// ② 源码：两处 register 都被改掉（注释里可以提到旧槽名，但 inject/options.name 里不许再有）。
	assert(SOURCE.includes('ctx.slots.inject("sidebar.right.tab.document.actions"'), "inject 必须是新槽位");
	assert(SOURCE.includes('name: "sidebar.right.tab.document.actions"'), "register 的 name 必须是新槽位");
	assert(!SOURCE.includes('ctx.slots.inject("sidebar.right.tab.menu.item"'), "不该再 inject 旧槽位");
	assert(!SOURCE.includes('name: "sidebar.right.tab.menu.item"'), "不该再 register 旧槽位");
});

check("label 是「远程连接」，order = 60，id 是非空字符串", () => {
	assertEqual(SECTIONS[0].options.label(), "远程连接", "唯一的 label");
	assertEqual(SECTIONS[0].options.order, 60, "order");
	assertEqual(typeof SECTIONS[0].options.id, "string", "id 类型");
	assert(SECTIONS[0].options.id !== "", "id 不能是空串");
});

check("源码里只 register 三次（设置页 + 两个菜单项）；旧的三页 id 与标签都已清掉", () => {
	assertEqual((SOURCE.match(/ctx\.slots\.register\(/g) || []).length, 3, "register 调用次数");
	assertEqual((SOURCE.match(/ctx\.slots\.inject\(/g) || []).length, 3, "inject 调用次数");
	for (const oldId of ["remote-access", "remote-devices", "remote-health"]) {
		assert(!SOURCE.includes(`"${oldId}"`), `旧的三页 id 不该还在：${oldId}`);
	}
	for (const oldLabel of ["远程访问", "远程设备"]) {
		assert(!SOURCE.includes(`"${oldLabel}"`), `旧页 label 不该还在：${oldLabel}`);
	}
});

//#endregion

//#region 2. 页面结构与 4 块

section("2. 唯一一页的 5 块：插件开关 / 本机地址 / 设备管理 / 配置 / 体检");

const BLOCK_TITLES = ["插件开关", "本机地址", "设备管理", "配置", "体检"];

/** 默认的 /urls 与 /state 返回（用例可整份替换，或按需叠加额外路由）。 */
const DEFAULT_URLS = {
	process: { host: "127.0.0.1", port: 19387, pid: 1234 },
	urls: [
		{ base: "http://127.0.0.1:19387/", authenticated: "http://127.0.0.1:19387/?token=abc" },
		{ base: "http://192.0.2.20:19387/", authenticated: "http://192.0.2.20:19387/?token=abc" },
	],
};

const DEFAULT_STATE = {
	enabled: true,
	version: "0.1.0",
	access: {
		host: "0.0.0.0",
		port: 19387,
		trustedHosts: ["a.example", "b.example"],
		cookieMaxAgeDays: 30,
		localAddresses: ["127.0.0.1:19387", "192.0.2.20:19387", "203.0.113.1:19387"],
		writable: true,
		forkTailN: 20,
		forkTailDefault: 20,
		forkTailMax: 200,
	},
	edge: { enabled: false, port: 19387, running: false, error: null, targetPort: 19387, blockedPrefixes: ["/plugin/"] },
	devices: [
		{ id: "home", name: "设备A", url: "http://127.0.0.1:19387", local: true, reachable: true, lastError: "", lastOkAt: "2026-10-12T08:00:00.000Z" },
		{ id: "vps", name: "VPS", url: "http://1.2.3.4:19387", local: false, reachable: false, lastError: "connect ECONNREFUSED", lastOkAt: null },
		{ id: "laptop", name: "笔记本", url: "http://192.0.2.30:19387", local: false, reachable: null, lastError: "", lastOkAt: null },
	],
	diagnostics: {
		injectionSeen: false,
		lastHelloAt: null,
		muxPath: "",
		muxPathFound: false,
		proxyRoutes: 2,
		notes: ["第一条备注", "第二条备注"],
	},
};

const SINGLE_URLS = {
	process: { host: "127.0.0.1", port: 19387, pid: 1234 },
	urls: [{ base: "http://127.0.0.1:19387/", authenticated: "http://127.0.0.1:19387/?token=abc" }],
};

/**
 * 造一个"远程连接页已加载"的沙盒与渲染树。
 * `options.urls` / `options.state` 整份替换这两个接口的返回（可传 "reject" 模拟接口挂掉）；
 * `options.responses` 叠加额外路由（如 /plugin/remote/test/vps）。
 */
async function connectionPage(options = {}) {
	const sandbox = createSandbox({
		confirmAnswer: options.confirmAnswer,
		withClipboard: options.withClipboard,
		responses: {
			"/plugin/remote/urls": options.urls === undefined ? DEFAULT_URLS : options.urls,
			"/plugin/remote/state": options.state === undefined ? DEFAULT_STATE : options.state,
			...(options.responses === undefined ? {} : options.responses),
		},
	});
	if (options.current !== undefined) sandbox.localStorage.setItem("dsh-device-switch:current", options.current);
	sandbox.loadModule();
	const { tree } = await sandbox.renderLoaded(page(sandbox).component);
	return { sandbox, tree };
}

/** 点完按钮之后重新渲染一次（把排队中的 setState 落到渲染树上）。 */
function rerender(sandbox) {
	return sandbox.render(page(sandbox).component).tree;
}

check("组件是函数；渲染 + 跑 effect 不抛异常，effect 有清理函数", () => {
	const sandbox = createSandbox();
	sandbox.loadModule();
	const { tree, effectsRan } = sandbox.render(page(sandbox).component);
	assert(tree !== null && tree !== undefined, "渲染结果为空");
	assert(effectsRan >= 1, `应注册并跑 effect，实际 ${effectsRan} 次`);
});

check("首帧（effect 之前）不白屏：4 块标题 + 「读取中…」", () => {
	const sandbox = createSandbox();
	sandbox.loadModule();
	const { tree } = sandbox.render(page(sandbox).component, {}, { skipEffect: true });
	const allText = collectText(tree);
	assert(allText.includes("读取中"), "首帧应有「读取中…」");
	for (const title of BLOCK_TITLES) assert(allText.includes(title), `首帧就该看到「${title}」这块`);
});

check("加载完成后 4 块标题都在，且不再有旧页的标题", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	for (const title of BLOCK_TITLES) assert(allText.includes(title), `应显示「${title}」块`);
	assert(!allText.includes("带 token 的访问地址"), "旧第 1 页的标题不该还在");
});

check("首屏两个接口都打，且都带 credentials: same-origin", async () => {
	const { sandbox } = await connectionPage();
	const urls = sandbox.readFetch().map((call) => call.url);
	assert(urls.includes("/plugin/remote/state"), `缺少 /state：${JSON.stringify(urls)}`);
	assert(urls.includes("/plugin/remote/urls"), `缺少 /urls：${JSON.stringify(urls)}`);
	for (const call of sandbox.readFetch()) assertEqual(call.init.credentials, "same-origin", "必须带 same-origin");
});

//#region 2.1 本机地址：默认收起 → 展开 → 再收起

check("「本机地址」默认收起：首屏没有地址行，只有摘要 + 「展开」按钮", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	assert(!allText.includes("?token=abc"), `收起时不该出现带 token 的地址行：${allText.slice(0, 200)}`);
	assert(allText.includes("共 2 条带 token 的地址"), "收起时要有摘要（共 N 条带 token 的地址）");
	assertEqual(findAll(tree, (node) => node.type === "code" && collectText(node).includes("?token=abc")).length, 0, "收起时不该有地址节点");
	assert(findButtonExact(tree, "展开") !== undefined, "应有「展开」按钮");
	assert(findButtonExact(tree, "收起") === undefined, "收起状态下按钮应是「展开」");
});

check("点「展开」→ 出现地址行 + 「复制」按钮，且地址文字在复制按钮之前", async () => {
	const { sandbox, tree } = await connectionPage();
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	const allText = collectText(expanded);
	assert(allText.includes("http://127.0.0.1:19387/?token=abc"), "展开后应出现第 1 条带 token 地址");
	assert(allText.includes("http://192.0.2.20:19387/?token=abc"), "展开后应出现第 2 条带 token 地址");
	assertEqual(findAllButtons(expanded, "复制").length, 3, "两条地址 + 末尾单独 token 行，各一个复制按钮");
	assert(findButtonExact(expanded, "收起") !== undefined, "展开后按钮应变成「收起」");
	assert(!allText.includes("http://127.0.0.1:19387/\n"), "裸地址那行小灰字已去掉（不再单独展示 IP 小标题）");
	const flat = flatten(expanded);
	const firstCode = flat.findIndex((node) => node.type === "code" && collectText(node).includes("?token=abc"));
	const firstCopy = flat.findIndex((node) => node.type === "button" && collectText(node).includes("复制"));
	assert(firstCode !== -1 && firstCopy !== -1 && firstCode < firstCopy, "复制按钮必须在地址文字之后");
});

check("「本机地址/token」：标题改名 + token 只显示前 6 位 + 末尾一行完整 token（复制的是 token 本身）", async () => {
	const urls = {
		process: { host: "127.0.0.1", port: 19387, pid: 1234 },
		urls: [{ base: "http://127.0.0.1:19387/", authenticated: "http://127.0.0.1:19387/?token=AbCdEf1234567890xyz" }],
	};
	const { sandbox, tree } = await connectionPage({ withClipboard: true, urls });
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	const allText = collectText(expanded);
	assert(allText.includes("本机地址/token"), `块标题应为「本机地址/token」：${allText.slice(0, 160)}`);
	assert(allText.includes("?token=AbCdEf...."), "地址里的 token 只显示前 6 位 + `....`");
	const codeTexts = flatten(expanded).filter((node) => node.type === "code").map((node) => flatText(node));
	assert(!codeTexts.some((value) => value.includes("?token=AbCdEf1234567890xyz")), "地址行不许出现完整 token");
	assert(codeTexts.includes("AbCdEf1234567890xyz"), "末尾单独 token 行要显示**完整** token");

	// 复制：token 行的按钮只复制 token 本身（地址行的按钮复制完整地址，见下一条用例）。
	const copies = flatten(expanded).filter((node) => node.type === "button" && flatText(node).includes("复制"));
	assertEqual(copies.length, 2, "一条地址 + 一个 token 行，各一个复制按钮");
	copies[copies.length - 1].props.onClick({});
	await settle();
	assertEqual(sandbox.clipboardWrites[sandbox.clipboardWrites.length - 1], "AbCdEf1234567890xyz", "token 行的复制按钮只复制 token");
});

check("说明文字收掉：插件开关的长段说明 + 设备管理的开头说明都不在界面上", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	assert(!allText.includes("关停会先清掉这一台浏览器里"), "插件开关那段长说明应删掉");
	assert(allText.includes("软开关：停用只停止代理与注入"), "插件开关上面那行要保留");
	assert(!allText.includes("切换只改这一台浏览器本地的选择"), "设备管理的开头说明应删掉");
});

check("再点「收起」→ 地址行与「复制」按钮又隐藏，摘要还在", async () => {
	const { sandbox, tree } = await connectionPage();
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	assert(collectText(expanded).includes("?token=abc"), "前置条件：展开后应有地址行");
	clickNth(expanded, "收起", 0);
	const collapsed = rerender(sandbox);
	const allText = collectText(collapsed);
	assert(!allText.includes("?token=abc"), "再次收起后地址行要隐藏");
	assertEqual(findAllButtons(collapsed, "复制").length, 0, "收起后不该还有复制按钮");
	assert(allText.includes("共 2 条带 token 的地址"), "收起后摘要要回来");
	assert(findButtonExact(collapsed, "展开") !== undefined, "按钮应回到「展开」");
});

check("展开后：带 token 的地址 + 本机进程 + 「仅本机可读」说明（绑定/信任/端口都在「配置」块里，这里不再重复展示）", async () => {
	const { sandbox, tree } = await connectionPage();
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	const allText = collectText(expanded);
	assert(allText.includes("仅本机可读") && allText.includes("cookie"), "要有「仅本机可读；接入一台新设备用一次，之后靠 cookie」说明");
	assert(allText.includes("本机进程"), "展开后应显示本机进程信息");
	assert(!allText.includes("访问设置"), "旧的只读「访问设置」小盒子已删（绑定地址不该在界面出现）");
});

check("接口全挂：显示「读取失败：…」，4 块标题仍在（不白屏）", async () => {
	const { tree } = await connectionPage({ urls: "reject", state: "reject" });
	const allText = collectText(tree);
	assert(allText.includes("读取失败："), `应显示读取失败：${allText.slice(0, 300)}`);
	assert(allText.includes("boom"), "应带上错误原因");
	for (const title of BLOCK_TITLES) assert(allText.includes(title), `接口全挂时仍要有「${title}」块`);
	assert(findButton(tree, "重载窗口") !== undefined, "接口挂了也要能点「重载窗口」");
});

check("字段缺失：降级成占位文案（未提供 / 未发现 / 无），不白屏", async () => {
	const { sandbox, tree } = await connectionPage({ urls: {}, state: {} });
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	const allText = collectText(expanded);
	assert(allText.includes("宿主半没有返回任何访问地址"), "空 urls 要有说明");
	assert(allText.includes("（未提供）"), "缺字段要有「（未提供）」");
	assert(allText.includes("当前：对外入口"), "「配置」块要有「当前：」一行（不是空白）");
	assert(allText.includes("（未发现）"), "muxPath 缺失要有「（未发现）」");
	assert(allText.includes("还没有配置任何设备"), "空设备表要有说明");
	assert(allText.includes("当前设备：本机"), "顶栏仍要显示");
	assert(allText.includes("（宿主半没有给出备注）"), "notes 缺失要有说明");
});

//#endregion

//#region 2.2 设备管理

check("设备管理：真 <table>、6 列表头、三态可达、最近错误/上次成功、● 当前", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	assert(allText.includes("设备A") && allText.includes("VPS") && allText.includes("笔记本"), "三台设备都要出现");
	assert(allText.includes("✅") && allText.includes("❌") && allText.includes("未测"), "三态可达都要出现");
	assert(allText.includes("connect ECONNREFUSED"), "应显示最近错误");
	assert(allText.includes("上次成功："), "应显示最近一次成功时间");
	assert(allText.includes("● 当前"), "本机在选中状态时应有「● 当前」标记");
	assert(allText.includes("本机") && allText.includes("远端"), "位置列要区分本机/远端");
	assertEqual(findAll(tree, (node) => node.type === "table").length, 1, "必须是真 <table>");
	assertEqual(findAll(tree, (node) => node.type === "th").length, 6, "6 列表头");
	assertEqual(findAll(tree, (node) => node.type === "td").length, 18, "3 台设备 × 6 列");
});

check("设备管理：四个操作按钮齐全，token 是密码框，开关旁说明了「停用后等于没装」", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	assert(findButton(tree, "回到本机") !== undefined, "本机那行按钮应为「回到本机」");
	assertEqual(findAllButtons(tree, "切换到此设备").length, 2, "两台远端各一个「切换到此设备」");
	assertEqual(findAllButtons(tree, "测试连通").length, 3, "三台设备各一个测试按钮");
	assertEqual(findAllButtons(tree, "修改").length, 3, "三台设备各一个修改按钮");
	assertEqual(findAllButtons(tree, "删除").length, 3, "三台设备各一个删除按钮");
	assert(findButton(tree, "新增") !== undefined, "应有新增按钮");
	assert(allText.includes("已启用"), "enabled=true 时开关应显示已启用");
	assert(allText.includes("软开关：停用只停止代理与注入；要彻底关停请卸载本插件"), "开关旁必须有软开关标注（与 package.json 描述一致）");
	assertEqual(findAll(tree, (node) => node.type === "input" && node.props.type === "password").length, 1, "token 必须是密码输入框");
});

check("顶部当前设备：默认本机；localStorage 有值时显示设备名字", async () => {
	const none = await connectionPage();
	assert(collectText(none.tree).includes("当前设备：本机"), "未设置键时应显示本机");
	const picked = await connectionPage({ current: "vps" });
	assert(collectText(picked.tree).includes("当前设备：VPS"), `键=vps 时应显示 VPS：${collectText(picked.tree).slice(0, 200)}`);
	assert(collectText(picked.tree).includes("● 当前"), "VPS 那行应有「● 当前」");
});

check("设备被删（localStorage 里的 id 不在设备表里）：顶栏显示 id 本身，不空白", async () => {
	const { tree } = await connectionPage({ current: "gone-id" });
	const allText = collectText(tree);
	assert(allText.includes("当前设备：gone-id"), `设备不在表里时应显示 id：${allText.slice(0, 200)}`);
});

check("设备读取失败：显示「读取失败：…」，顶栏与新增表单仍在", async () => {
	const { tree } = await connectionPage({ state: "reject" });
	const allText = collectText(tree);
	assert(allText.includes("读取失败：") && allText.includes("boom"), "应显示读取失败与原因");
	assert(allText.includes("当前设备：本机"), "顶栏仍要显示");
	assert(allText.includes("新增设备"), "新增表单仍要可用");
});

//#endregion

//#region 2.3 「配置」块（端口 + cookie 天数 + 分叉条数；网络那部分不在这里）

const ACCESS_SAVED_NOTE = "已写入配置，重启 DSH 生效";

/** 「配置」块里的控件（按标签找输入框，避免"第几个 number 输入框"这种脆弱写法）。 */
function accessControls(root) {
	const byTestId = (id) => findAll(root, (node) => node.type === "button"
		&& node.props !== undefined && node.props !== null && node.props["data-dsh-remote"] === id)[0];
	const labels = findAll(root, (node) => node.type === "label");
	const inputByLabel = (label) => {
		for (const wrapper of labels) {
			const input = findAll(wrapper, (node) => node.type === "input" && node.props !== undefined)[0];
			if (input === undefined) continue;
			if (flatText(findAll(wrapper, (node) => node.type === "span")[0] ?? wrapper).includes(label)) return input;
		}
		return undefined;
	};
	return {
		edgePort: inputByLabel("对外端口"),
		cookieDays: inputByLabel("cookie 天数"),
		forkTail: inputByLabel("分叉条数"),
		// 按钮文案在请求期间会变成「保存中…」，所以身份用 testId（文案另测）。
		save: byTestId("access-save") ?? findButtonExact(root, "保存"),
	};
}

check("「配置」块永远在（接口正常 / 接口全挂都在）：对外入口 + 对外端口 + cookie + 分叉 + 保存", async () => {
	const ok = await connectionPage();
	const controls = accessControls(ok.tree);
	assert(collectText(ok.tree).includes("配置"), "应有「配置」块");
	assert(controls.edgePort !== undefined && controls.cookieDays !== undefined
		&& controls.forkTail !== undefined && controls.save !== undefined,
		"对外端口 / cookie 天数 / 分叉条数 / 保存 都要在");
	assert(controls.port === undefined, "内部端口不该出现在界面上");
	assert(controls.edgeEnabled === undefined, "不该再有「对外入口」勾选框（改由「对外端口」控制）");
	const down = await connectionPage({ state: "reject", urls: "reject" });
	assert(collectText(down.tree).includes("配置"), "接口全挂时「配置」块照样在（不白屏）");
	assert(accessControls(down.tree).save !== undefined, "接口全挂时保存按钮也要在");
});

check("「配置」块：各项都预填宿主半报的当前值，「当前」一行报运行值", async () => {
	const { tree } = await connectionPage();
	const controls = accessControls(tree);
	assertEqual(controls.edgePort.props.value, "19387", "对外端口要预填");
	assertEqual(controls.cookieDays.props.value, "30", "cookie 天数要预填");
	assertEqual(controls.forkTail.props.value, "20", "分叉条数要预填");
	const allText = collectText(tree);
	assert(allText.includes("对外入口 关"), `「当前」一行要报对外入口状态：${allText.slice(0, 220)}`);
	assert(allText.includes("127.0.0.1:"), "「当前」一行要报本机 DSH 的 loopback 目标");
	assert(allText.includes("cookie 30 天") && allText.includes("分叉 20 条"), "「当前」一行要有 cookie 与分叉");
});

check("「配置」块：入口地址 / 绑定地址都不在界面上（网络那部分单独管）", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	assert(findAll(tree, (node) => node.type === "textarea").length === 0, "不该再有入口地址多行框");
	assert(!allText.includes("入口地址"), "「配置」块里不该再出现「入口地址」");
	assert(!allText.includes("信任地址"), "旧名「信任地址」也不许留");
	assert(!allText.includes("填入本机地址"), "「填入本机地址」按钮随入口地址一起去掉");
	assert(!allText.includes("0.0.0.0"), "绑定值一律不在界面出现");
	assertEqual(findAllButtons(tree, "保存").length, 1, "只留一个保存按钮");
});

check("「配置」块：保存只发 edgeEnabled / edgePort / cookieMaxAgeDays / forkTailN（不碰 port、trustedHosts）", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/access": { ok: true, restartRequired: true } } });
	accessControls(tree).cookieDays.props.onChange({ target: { value: "3650" } });
	const a = rerender(sandbox);
	accessControls(a).edgePort.props.onChange({ target: { value: "19400 " } });
	const b = rerender(sandbox);
	accessControls(b).forkTail.props.onChange({ target: { value: "35" } });
	const c = rerender(sandbox);
	accessControls(c).save.props.onClick({});
	await settle();
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/access");
	assert(call !== undefined, "应打 POST /access");
	const body = JSON.parse(call.init.body);
	assertEqual(body.edgeEnabled, true, "对外入口开关要带上");
	assertEqual(body.edgePort, 19400, "对外端口必须是数字（首尾空白容忍）");
	assertEqual(body.cookieMaxAgeDays, 3650, "cookie 天数要带上（数字）");
	assertEqual(body.forkTailN, 35, "分叉条数要带上（数字）");
	assertEqual(body.port, undefined, "内部端口不归界面管");
	assertEqual(body.trustedHosts, undefined, "入口地址已不归界面管");
});

check("「配置」块：宿主半没报 forkTailN（老版本）→ 空框、保存时也不带这个字段（不猜值）", async () => {
	const state = { ...DEFAULT_STATE, access: { ...DEFAULT_STATE.access, forkTailN: null, forkTailDefault: null } };
	const { sandbox, tree } = await connectionPage({ state, responses: { "/plugin/remote/access": { ok: true } } });
	assertEqual(accessControls(tree).forkTail.props.value, "", "拿不到当前值就该是空框");
	accessControls(tree).save.props.onClick({});
	await settle();
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/access");
	assert(call !== undefined, "应打 POST /access");
	assertEqual(JSON.parse(call.init.body).forkTailN, undefined, "空框 = 不改这一格，请求体里不该有它");
});

check("「保存」成功：显示定稿那句，且没有任何掉线类警告", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/access": { ok: true, restartRequired: true } } });
	accessControls(tree).save.props.onClick({});
	await settle();
	const allText = collectText(rerender(sandbox));
	assert(allText.includes(ACCESS_SAVED_NOTE), `应显示定稿文案：${allText.slice(0, 200)}`);
	assert(!allText.includes("掉线"), "不该出现掉线类警告");
});

check("「保存」失败：显示宿主半的中文原因、**不显示成功**、按钮恢复可用", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/access": { ok: false, error: "写入 profile 失败：selftest boom" } } });
	accessControls(tree).save.props.onClick({});
	await settle();
	const after = rerender(sandbox);
	const allText = collectText(after);
	assert(allText.includes("selftest boom"), `要显示宿主半的原因：${allText.slice(0, 200)}`);
	assert(!allText.includes(ACCESS_SAVED_NOTE), "失败时不能显示成功");
	assertEqual(accessControls(after).save.props.disabled, false, "按钮要恢复可用");
});

check("「保存」期间按钮置灰、文案变「保存中…」（防重复点击）", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/access": { ok: true } } });
	accessControls(tree).save.props.onClick({});
	const pending = rerender(sandbox);
	assertEqual(accessControls(pending).save.props.disabled, true, "请求期间按钮必须置灰");
	assertEqual(flatText(accessControls(pending).save), "保存中…", "请求期间文案应是「保存中…」");
	await settle();
	const done = rerender(sandbox);
	assertEqual(accessControls(done).save.props.disabled, false, "完成后按钮要恢复");
});

check("「保存」前先自己校验：对外端口非法 / 没给端口 / cookie 天数非法 / 分叉条数非法 → 只给中文提示、**不发请求**", async () => {
	const bad = await connectionPage({ responses: { "/plugin/remote/access": { ok: true } } });
	accessControls(bad.tree).edgePort.props.onChange({ target: { value: "70000" } });
	const high = rerender(bad.sandbox);
	accessControls(high).save.props.onClick({});
	await settle();
	assertEqual(bad.sandbox.readFetch().filter((entry) => entry.url === "/plugin/remote/access").length, 0, "对外端口非法不该发请求");
	assert(collectText(rerender(bad.sandbox)).includes("对外端口必须是 1..65535 的整数"), "应给中文校验提示");

	// 留空 = 关掉对外入口：要发得出请求，且 edgeEnabled=false、edgePort 带上原来的口。
	const clearedPage = await connectionPage({ responses: { "/plugin/remote/access": { ok: true } } });
	accessControls(clearedPage.tree).edgePort.props.onChange({ target: { value: "" } });
	const cleared = rerender(clearedPage.sandbox);
	accessControls(cleared).save.props.onClick({});
	await settle();
	const clearedBody = JSON.parse(findBy(clearedPage.sandbox.readFetch(), (entry) => entry.url === "/plugin/remote/access").init.body);
	assertEqual(clearedBody.edgeEnabled, false, "留空应发 edgeEnabled:false");
	assertEqual(clearedBody.edgePort, 19387, "关掉时要把原来的对外端口带回去（写回 profile 用）");

	const badDays = await connectionPage({ responses: { "/plugin/remote/access": { ok: true } } });
	accessControls(badDays.tree).cookieDays.props.onChange({ target: { value: "0" } });
	const days = rerender(badDays.sandbox);
	accessControls(days).save.props.onClick({});
	await settle();
	assertEqual(badDays.sandbox.readFetch().filter((entry) => entry.url === "/plugin/remote/access").length, 0, "cookie 天数非法不该发请求");
	assert(collectText(rerender(badDays.sandbox)).includes("cookie 天数必须是"), "应给中文校验提示");

	const badFork = await connectionPage({ responses: { "/plugin/remote/access": { ok: true } } });
	accessControls(badFork.tree).forkTail.props.onChange({ target: { value: "9999" } });
	const fork = rerender(badFork.sandbox);
	accessControls(fork).save.props.onClick({});
	await settle();
	assertEqual(badFork.sandbox.readFetch().filter((entry) => entry.url === "/plugin/remote/access").length, 0, "分叉条数非法不该发请求");
	assert(collectText(rerender(badFork.sandbox)).includes("分叉条数必须是"), "应给中文校验提示");
});

check("「配置」块：源码断言（常量、路由、唯一 fetch 收口）", () => {
	assert(SOURCE.includes('var ACCESS_ROUTE = "/access"'), "路由常量必须是 /access");
	assert(SOURCE.includes('var payload = wantedEdgePort === ""'), "保存的请求体由「对外端口」是否留空决定开/关");
	assert(!SOURCE.includes('"data-dsh-remote": "edge-enabled"'), "不该再有对外入口勾选框");
	assert(!SOURCE.includes('label: "端口"'), "内部端口那一格不该再出现在界面上");
	assert(SOURCE.includes('if (wantedDays !== "") payload.cookieMaxAgeDays = Number(wantedDays);'),
		"cookie 天数只有非空才带上（留空 = 不改这一格）");
	assert(SOURCE.includes('if (wantedFork !== "") payload.forkTailN = Number(wantedFork);'),
		"分叉条数只有非空才带上（留空 = 不改这一格）");
	assert(SOURCE.includes("request(ACCESS_ROUTE, { method: \"POST\", body: JSON.stringify(payload) })"),
		"保存必须是这一条 POST（body 先 stringify）");
	assert(SOURCE.includes('"data-dsh-remote": "access-save"'), "保存按钮要有稳定的 testId（文案在请求期间会变）");
	assert(SOURCE.includes("function AccessConfigPanel(props)"), "块必须是一个独立组件");
	assert(SOURCE.includes("h(AccessConfigPanel, {"), "必须在页面里渲染它");
	assert(!SOURCE.includes('label: "入口地址'), "插件界面里不该再有入口地址那一格");
	assert(!SOURCE.includes("textarea"), "界面上不该再有入口地址那种多行框");
});

//#region 2.4 体检

check("体检：四项 ✅/❌ 都在，notes 逐条成 <li>，两个按钮都在", async () => {
	const { tree } = await connectionPage();
	const allText = collectText(tree);
	assert(allText.includes("❌"), "红项应显示 ❌");
	assert(allText.includes("✅"), "绿项应显示 ✅");
	for (const needle of ["enabled", "injectionSeen", "muxPath", "proxyRoutes"]) {
		assert(allText.includes(needle), `应显示诊断项 ${needle}`);
	}
	assert(allText.includes("最近报到："), "injectionSeen 项要带 lastHelloAt");
	assert(allText.includes("这一项红 = DSH 升级后页面注入失效"), "必须解释 injectionSeen 红的含义");
	assert(allText.includes("此时插件不影响 DSH 本身"), "必须说明注入失效不影响 DSH 本身");
	assert(allText.includes("终端通道不可用"), "必须解释 muxPath 红的含义");
	assert(allText.includes("第一条备注") && allText.includes("第二条备注"), "notes 要逐条显示");
	assertEqual(findAll(tree, (node) => node.type === "li").length, 2, "notes 应是 2 个 li");
	assert(findButton(tree, "重新读取") !== undefined, "应有「重新读取」按钮");
	assert(findButton(tree, "重载窗口") !== undefined, "应有「重载窗口」按钮");
	assert(allText.includes("改了配置/升级后用它让页面重新加载"), "「重载窗口」旁要说明用途");
});

check("体检：「重载窗口」按钮会调 location.reload()", async () => {
	const { sandbox, tree } = await connectionPage();
	assertEqual(sandbox.reloads, 0, "渲染阶段不该 reload");
	clickNth(tree, "重载窗口", 0);
	assertEqual(sandbox.reloads, 1, "点「重载窗口」必须 reload 一次");
});

check("体检：「重新读取」→ 刷新计数 +1，重渲染后再读一次 /state", async () => {
	const { sandbox, tree } = await connectionPage();
	const before = filterBy(sandbox.fetchCalls, (call) => call.url === "/plugin/remote/state").length;
	clickNth(tree, "重新读取", 0);
	await settle();
	const refreshWrite = findBy(sandbox.stateWrites, (entry) => entry.value === 1);
	assert(refreshWrite !== undefined, "点「重新读取」必须把刷新计数 +1（触发依赖变化）");
	await sandbox.renderLoaded(page(sandbox).component);
	const after = filterBy(sandbox.fetchCalls, (call) => call.url === "/plugin/remote/state").length;
	assert(after > before, `重新渲染后应再读一次 /state（之前 ${before}，之后 ${after}）`);
});

//#endregion

//#endregion

//#region 3. 交互（按钮 onClick 真的点一遍）

section("3. 交互：点击按钮真的按契约打接口");

check("切换到此设备：写 dsh-device-switch:current = 该行 id + location.reload()（每行独立闭包）", async () => {
	const { sandbox, tree } = await connectionPage();
	// 第一个「切换到此设备」属于第 2 行（vps）。历史上行内 var 让所有按钮共享绑定，
	// 这里点下去会写成最后一台（laptop）—— 这条断言就是这个回归的哨兵。
	clickNth(tree, "切换到此设备", 0);
	const ops = sandbox.localStorage.log.filter((entry) => entry.key === "dsh-device-switch:current");
	assertEqual(ops.length, 1, "应恰好写一次这个键");
	assertEqual(ops[0].op, "set", "应是 setItem");
	assertEqual(ops[0].value, "vps", `写入的应是该行的 id（vps），实际 ${JSON.stringify(ops[0].value)}`);
	assertEqual(sandbox.reloads, 1, "应 reload 一次");
});

check("回到本机：removeItem 那个键 + location.reload()", async () => {
	const { sandbox, tree } = await connectionPage({ current: "vps" });
	// 清掉"造场景"时写进去的那一条，只断言点击产生的动作。
	sandbox.localStorage.log.length = 0;
	clickNth(tree, "回到本机", 0);
	const ops = sandbox.localStorage.log.filter((entry) => entry.key === "dsh-device-switch:current");
	assertEqual(ops.length, 1, "应恰好动一次这个键");
	assertEqual(ops[0].op, "remove", "切回本机必须是 removeItem");
	assertEqual(sandbox.localStorage.getItem("dsh-device-switch:current"), null, "键必须被删掉");
	assertEqual(sandbox.reloads, 1, "应 reload 一次");
});

check("测试连通：POST /test/<id>，两段式「测试中… → ✅ 连通 状态码/耗时」", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/test/vps": { ok: true, status: 200, ms: 42 } } });
	clickNth(tree, "测试连通", 1); // 第 2 个测试按钮 = vps
	const pendingTree = rerender(sandbox);
	assert(collectText(pendingTree).includes("测试中…"), "点击后应先显示「测试中…」");
	const rendered = await sandbox.settleRenders(page(sandbox).component);
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/test/vps");
	assert(call !== undefined, `应打 /test/vps，实际：${JSON.stringify(sandbox.readFetch().map((entry) => entry.url))}`);
	assertEqual(call.init.method, "POST", "测试必须 POST");
	const allText = collectText(rendered.tree);
	assert(allText.includes("✅ 连通"), `应显示连通结果，实际：${allText.slice(0, 300)}`);
	assert(allText.includes("状态码：200"), "应显示状态码");
	assert(allText.includes("耗时：42 ms"), "应显示耗时");
});

check("测试连通：宿主半回 ok:false（HTTP 200 的测试结果）→「❌ 不通」而不是接口报错", async () => {
	const { sandbox, tree } = await connectionPage({
		responses: { "/plugin/remote/test/vps": { ok: false, status: null, ms: 7, error: "connect ECONNREFUSED" } },
	});
	clickNth(tree, "测试连通", 1);
	const rendered = await sandbox.settleRenders(page(sandbox).component);
	const allText = collectText(rendered.tree);
	assert(allText.includes("❌ 不通"), `应显示「❌ 不通」，实际：${allText.slice(0, 300)}`);
	assert(allText.includes("状态码：（无）"), "status=null 时应显示「（无）」");
	assert(allText.includes("耗时：7 ms"), "应显示耗时");
	assert(allText.includes("connect ECONNREFUSED"), "应带上错误原因");
});

check("删除：二次确认带设备名；确认后 DELETE /plugin/remote/devices/<id>", async () => {
	const { sandbox, tree } = await connectionPage({ confirmAnswer: true, responses: { "/plugin/remote/devices/vps": { ok: true } } });
	clickNth(tree, "删除", 1); // 第 2 行 = vps
	await settle();
	assertEqual(sandbox.confirms.length, 1, "必须弹一次二次确认");
	assert(sandbox.confirms[0].includes("VPS"), `确认文案应带设备名：${sandbox.confirms[0]}`);
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/devices/vps");
	assert(call !== undefined, "应打 DELETE /devices/vps");
	assertEqual(call.init.method, "DELETE", "必须 DELETE");
});

check("删除：二次确认里选「取消」时一个 DELETE 都不发", async () => {
	const { sandbox, tree } = await connectionPage({ confirmAnswer: false });
	clickNth(tree, "删除", 1);
	await settle();
	assertEqual(sandbox.confirms.length, 1, "必须弹二次确认");
	assertEqual(filterBy(sandbox.fetchCalls, (entry) => entry.init.method === "DELETE").length, 0, "取消后不该发 DELETE");
});

check("删除当前选中的设备后顺手回到本机（清掉 localStorage 键）", async () => {
	const { sandbox, tree } = await connectionPage({ current: "vps", responses: { "/plugin/remote/devices/vps": { ok: true } } });
	sandbox.localStorage.log.length = 0;
	clickNth(tree, "删除", 1);
	await settle();
	const ops = sandbox.localStorage.log.filter((entry) => entry.key === "dsh-device-switch:current");
	assertEqual(ops.length, 1, "应恰好动一次这个键");
	assertEqual(ops[0].op, "remove", "删掉的正是当前设备时必须 removeItem");
});

/** 与 lib/client.js 约定的别名键（停用时两个键都要清）。 */
const SWITCH_ALIAS_KEY = "dsh-remote:current";
/** 软开关标注的原文（package.json 的 description 与页面文案口径一致）。 */
const SOFT_SWITCH_NOTE = "软开关：停用只停止代理与注入；要彻底关停请卸载本插件";
/**
 * 宿主半垫片的两个 sessionStorage 键（键名两边必须逐字一致，selftest 双方都断言）：
 * 哨兵 = "这个窗口已经为停用刷过一次"；force-active = "这次加载忽略 payload/哨兵，走正常模式"。
 */
const SENTINEL_KEY = "dsh-remote:soft-off";
const FORCE_ACTIVE_KEY = "dsh-remote:force-active";

check("插件开关（关停）：POST /plugin/remote/enabled {enabled:false} → 先清 localStorage 再 reload", async () => {
	const { sandbox, tree } = await connectionPage({
		current: "vps",
		responses: { "/plugin/remote/enabled": { ok: true, enabled: false } },
	});
	assert(sandbox.localStorage.has("dsh-device-switch:current"), "前置条件：先选着一台远端设备");
	// 前置条件：上一次开启留下的"强制激活"标记还在（关停必须顺手清掉它）。
	sandbox.sessionStorage.setItem(FORCE_ACTIVE_KEY, "1");
	const checkbox = findAll(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
	assert(checkbox !== undefined, "应有启用/停用开关");
	// 只看这次点击产生的动作（connectionPage 的 current 选项自己会写一次键）。
	sandbox.localStorage.log.length = 0;
	sandbox.sessionStorage.log.length = 0;
	checkbox.props.onChange({ target: { checked: false } });
	await settle();

	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/enabled");
	assert(call !== undefined, "应打 /enabled");
	assertEqual(call.init.method, "POST", "开关必须 POST");
	assertEqual(call.init.body, JSON.stringify({ enabled: false }), "请求体必须恰好是 {enabled:false}");
	assertEqual(sandbox.reloads, 1, "关停成功后必须 reload 一次");
	// 顺序不许换：清键必须在 reload **之前**，否则刷新后垫片又会读到这个 id 继续跑远端。
	const ops = sandbox.localStorage.log.map((entry) => `${entry.op}:${entry.key}`);
	assertEqual(ops.length, 2, `关停必须恰好清两个键（主键 + 别名），实际：${JSON.stringify(ops)}`);
	assertEqual(ops[0], `remove:dsh-device-switch:current`, "第一个动作必须是删主键");
	assertEqual(ops[1], `remove:${SWITCH_ALIAS_KEY}`, "第二个动作必须是删别名键");
	assert(sandbox.localStorage.has("dsh-device-switch:current") === false, "主键必须真的没了");
	assert(sandbox.localStorage.has(SWITCH_ALIAS_KEY) === false, "别名键必须真的没了");
	// 关停必须顺手清掉 force-active：否则它残留，下次关停后的第一次加载又被强制激活。
	assert(sandbox.sessionStorage.has(FORCE_ACTIVE_KEY) === false, "关停必须清掉 force-active 标记");
	const sessionOps = sandbox.sessionStorage.log.map((entry) => `${entry.op}:${entry.key}`);
	assertEqual(sessionOps.length, 1, `关停应恰好动一次 sessionStorage（清 force-active），实际：${JSON.stringify(sessionOps)}`);
	assertEqual(sessionOps[0], `remove:${FORCE_ACTIVE_KEY}`, "关停动的必须是 force-active");
	const rendered = rerender(sandbox);
	const allText = collectText(rendered);
	assert(allText.includes("已关停：正在回到本机"), `成功后要有「已关停：正在回到本机…」提示，实际：${allText.slice(0, 300)}`);
	assert(allText.includes("已启用"), "开关旁的状态文字仍以页面读到的 enabled 为准（刷新后才会变成已停用）");
});

check("插件开关（启动）：先清哨兵、再置 force-active、最后 reload（顺序断言，不碰 localStorage）", async () => {
	const { sandbox, tree } = await connectionPage({
		state: { ...DEFAULT_STATE, enabled: false },
		current: "vps",
		responses: { "/plugin/remote/enabled": { ok: true, enabled: true } },
	});
	// 前置条件：关停那一次留下的哨兵还在 —— 它正是"开启后胶囊不出现"的根因。
	sandbox.sessionStorage.setItem(SENTINEL_KEY, "1");
	const checkbox = findAll(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
	sandbox.localStorage.log.length = 0;
	sandbox.sessionStorage.log.length = 0;
	checkbox.props.onChange({ target: { checked: true } });
	await settle();
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/enabled");
	assertEqual(call.init.body, JSON.stringify({ enabled: true }), "请求体必须恰好是 {enabled:true}");
	assertEqual(sandbox.reloads, 1, "启动成功后必须 reload 一次（让壳重新注入垫片）");
	assertEqual(sandbox.localStorage.log.length, 0, "启动不该动 localStorage");
	assert(sandbox.localStorage.has("dsh-device-switch:current"), "启动不该清掉当前设备（那是关停才做的事）");
	// 关键顺序：remove 哨兵 → set force-active → reload。顺序错了（比如先 set 后 remove）就等于白清。
	const sessionOps = sandbox.sessionStorage.log.map((entry) => `${entry.op}:${entry.key}`);
	assertEqual(sessionOps.length, 2, `启动必须恰好动两次 sessionStorage，实际：${JSON.stringify(sessionOps)}`);
	assertEqual(sessionOps[0], `remove:${SENTINEL_KEY}`, "第一步必须是清掉宿主的防循环哨兵");
	assertEqual(sessionOps[1], `set:${FORCE_ACTIVE_KEY}`, "第二步必须是置 force-active");
	assertEqual(sandbox.sessionStorage.has(SENTINEL_KEY), false, "哨兵必须真的没了（否则垫片同步阶段会惰性返回）");
	assertEqual(sandbox.sessionStorage.getItem(FORCE_ACTIVE_KEY), "1", "force-active 必须真的写上，值为 \"1\"");
	const rendered = rerender(sandbox);
	assert(collectText(rendered).includes("已启用：正在重新注入胶囊"), `要有「已启用：正在重新注入胶囊…」提示，实际：${collectText(rendered).slice(0, 300)}`);
});

check("插件开关（启动）：失败时既不清哨兵、也不置 force-active", async () => {
	const { sandbox, tree } = await connectionPage({
		state: { ...DEFAULT_STATE, enabled: false },
		responses: { "/plugin/remote/enabled": { ok: false, error: "profile 不可写" } },
	});
	sandbox.sessionStorage.setItem(SENTINEL_KEY, "1");
	const checkbox = findAll(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
	sandbox.sessionStorage.log.length = 0;
	checkbox.props.onChange({ target: { checked: true } });
	await settle();
	assertEqual(sandbox.sessionStorage.log.length, 0, "失败时一个 sessionStorage 动作都不该有");
	assertEqual(sandbox.sessionStorage.getItem(SENTINEL_KEY), "1", "失败时哨兵必须原样留着");
	assertEqual(sandbox.reloads, 0, "失败时绝对不许刷新页面");
});

check("插件开关（启动）：sessionStorage 不可用（取不到对象 / 抛异常）时安静跳过，照常刷新", async () => {
	const { sandbox, tree } = await connectionPage({
		state: { ...DEFAULT_STATE, enabled: false },
		responses: { "/plugin/remote/enabled": { ok: true, enabled: true } },
	});
	// 模拟隐私模式：sessionStorage.getItem/setItem/removeItem 一律抛异常。
	sandbox.sessionStorage = {
		getItem() {
			throw new Error("sessionStorage denied");
		},
		setItem() {
			throw new Error("sessionStorage denied");
		},
		removeItem() {
			throw new Error("sessionStorage denied");
		},
	};
	sandbox.window.sessionStorage = sandbox.sessionStorage;
	const checkbox = findAll(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
	checkbox.props.onChange({ target: { checked: true } });
	await settle();
	assertEqual(sandbox.reloads, 1, "sessionStorage 不可用时照样要刷新（降级：靠垫片的实时自检兜底）");
});

check("插件开关：软开关标注出现在页面上（两种 enabled 状态都在）", async () => {
	const on = await connectionPage();
	assert(collectText(on.tree).includes(SOFT_SWITCH_NOTE), "enabled=true 时也要有软开关标注");
	const off = await connectionPage({ state: { ...DEFAULT_STATE, enabled: false } });
	assert(collectText(off.tree).includes(SOFT_SWITCH_NOTE), "enabled=false 时也要有软开关标注");
	assert(SOURCE.includes(SOFT_SWITCH_NOTE), "标注文案必须是源码里的一个常量（口径唯一）");
});

check("插件开关：宿主半回 {ok:false,error} 时展示错误，不显示成功、也不刷新", async () => {
	const { sandbox, tree } = await connectionPage({
		current: "vps",
		responses: { "/plugin/remote/enabled": { ok: false, error: "profile 不可写" } },
	});
	const checkbox = findAll(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0];
	checkbox.props.onChange({ target: { checked: false } });
	const rendered = await sandbox.settleRenders(page(sandbox).component);
	const allText = collectText(rendered.tree);
	assert(allText.includes("profile 不可写"), `提示应带上宿主给的错误，实际：${allText.slice(0, 300)}`);
	assert(!allText.includes("已停用"), "失败时不该显示成功的「已停用」");
	assert(!allText.includes("已关停"), "失败时不该显示「已关停」");
	assertEqual(sandbox.reloads, 0, "失败时绝对不许刷新页面");
	assert(sandbox.localStorage.has("dsh-device-switch:current"), "失败时不许清掉当前设备");
});

check("新增设备表单：填好后 POST /plugin/remote/devices（带 name/url/token，不带 id）", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/devices": { ok: true, device: { id: "new" } } } });
	const nameInput = findAll(tree, (node) => node.type === "input" && node.props.placeholder === "例如 设备A")[0];
	const urlInput = findAll(tree, (node) => node.type === "input" && String(node.props.placeholder).startsWith("http://192.0.2.20"))[0];
	const tokenInput = findAll(tree, (node) => node.type === "input" && node.props.type === "password")[0];
	assert(nameInput !== undefined && urlInput !== undefined && tokenInput !== undefined, "表单三个输入都要在");
	nameInput.props.onChange({ target: { value: "书房" } });
	urlInput.props.onChange({ target: { value: "http://198.51.100.5:19387" } });
	tokenInput.props.onChange({ target: { value: "tok-123" } });
	// onChange 只是 setState：真实 React 会重渲染，再点按钮时闭包里才是填好的值。
	const filled = rerender(sandbox);
	clickNth(filled, "新增", 0);
	await settle();
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/devices");
	assert(call !== undefined, `应打 POST /devices，实际：${JSON.stringify(sandbox.readFetch().map((e) => e.url))}`);
	assertEqual(call.init.method, "POST", "必须 POST");
	const body = JSON.parse(call.init.body);
	assertEqual(body.name, "书房", "name 必须带上");
	assertEqual(body.url, "http://198.51.100.5:19387", "url 必须带上");
	assertEqual(body.token, "tok-123", "token 必须带上");
	assertEqual(body.id, undefined, "新增时不该带 id");
});

check("新增表单：token 留空时请求体里**没有** token 字段（=修改时留空表示不改动）", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/devices": { ok: true } } });
	const nameInput = findAll(tree, (node) => node.type === "input" && node.props.placeholder === "例如 设备A")[0];
	const urlInput = findAll(tree, (node) => node.type === "input" && String(node.props.placeholder).startsWith("http://192.0.2.20"))[0];
	nameInput.props.onChange({ target: { value: "书房" } });
	urlInput.props.onChange({ target: { value: "http://198.51.100.5:19387" } });
	const filled = rerender(sandbox);
	clickNth(filled, "新增", 0);
	await settle();
	const call = findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/devices");
	assert(call !== undefined, "应打 POST /devices");
	const body = JSON.parse(call.init.body);
	assertEqual(body.token, undefined, "token 留空就该整个字段都不带");
	assertEqual(body.name, "书房", "name 必须带上");
});

check("新增表单：名称为空时不发请求，只给中文校验提示", async () => {
	const { sandbox, tree } = await connectionPage({ responses: { "/plugin/remote/devices": { ok: true } } });
	clickNth(tree, "新增", 0);
	await settle();
	assert(findBy(sandbox.fetchCalls, (entry) => entry.url === "/plugin/remote/devices") === undefined, "校验不过不该发请求");
	const rendered = rerender(sandbox);
	assert(collectText(rendered).includes("名称不能为空"), "应给中文校验提示");
});

check("修改：点某行的「修改」→ 该行给出提示；源码断言初值取自 props.device 且提交带 id", async () => {
	const { sandbox, tree } = await connectionPage();
	clickNth(tree, "修改", 1); // 选 vps 那行
	const rendered = rerender(sandbox);
	const allText = collectText(rendered);
	assert(allText.includes("已选中这台设备"), "该行应提示已选中，表单会带上它的 id");
	assert(allText.includes("保存修改") || allText.includes("收起"), "该行「修改」按钮应切换状态");
	const at = SOURCE.indexOf("function DeviceForm");
	const body = SOURCE.slice(at, at + 1200);
	assert(body.includes("asObject(props.device)"), "修改模式的初值应来自 props.device");
	assert(SOURCE.includes('if (form.id !== "") payload.id = form.id'), "提交时必须带上 id");
	assert(SOURCE.includes("var formKey = editId === null"), "换编辑目标时要换 key（真 React 才会重挂表单、用新初值）");
});

check("复制按钮：点击调用 clipboard.writeText，按钮先「已复制」、1.5s 后复位", async () => {
	const { sandbox, tree } = await connectionPage({ withClipboard: true, urls: SINGLE_URLS });
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	const button = findButtonExact(expanded, "复制");
	assert(button !== undefined, "展开后应有复制按钮");
	// 点击前清掉之前渲染攒下的状态写入，只看这次点击。
	sandbox.stateWrites.length = 0;
	button.props.onClick({});
	await settle();
	assertEqual(sandbox.clipboardWrites.length, 1, "必须调用一次 clipboard.writeText");
	assertEqual(sandbox.clipboardWrites[0], "http://127.0.0.1:19387/?token=abc", "写进剪贴板的应是完整地址");
	const shown = rerender(sandbox);
	assert(findButtonExact(shown, "已复制") !== undefined, "点击后按钮应显示「已复制」");
	assertEqual(findAllButtons(shown, "复制").filter((node) => flatText(node) === "复制").length, 1, "其余按钮（末尾 token 行）仍是「复制」");
	sandbox.tick(1600);
	const reset = rerender(sandbox);
	assert(findButtonExact(reset, "复制") !== undefined, "复位后按钮应回到「复制」");
	assert(findButtonExact(reset, "已复制") === undefined, "复位后不该还显示「已复制」");
});

check("复制按钮：没有 navigator.clipboard 时退回 prompt，不抛异常", async () => {
	const { sandbox, tree } = await connectionPage({ withClipboard: false, urls: SINGLE_URLS });
	clickNth(tree, "展开", 0);
	const expanded = rerender(sandbox);
	const button = findButtonExact(expanded, "复制");
	assert(button !== undefined, "展开后应有复制按钮");
	button.props.onClick({});
	assertEqual(sandbox.prompts.length, 1, "应退回 prompt 手动复制");
	assertEqual(sandbox.prompts[0].value, "http://127.0.0.1:19387/?token=abc", "prompt 里应是完整地址");
});

//#endregion

//#region 3.5 两个新扩展位（另存为… / 分叉到 <设备名>）

section("3.5 两个新扩展位：另存为…（文档预览头部按钮区）与分叉到…（会话「…」菜单）");

check("两个槽位都注册了：id / order=900（同插槽 open-in-app 之后）/ 组件是函数", () => {
	const save = slotEntry(boot, "sidebar.right.tab.document.actions");
	const fork = slotEntry(boot, "sidebar.workspaces.session.menu.item");
	assertEqual(save.options.id, "remote-save-as", "另存为的 id");
	assertEqual(fork.options.id, "remote-fork-to", "分叉的 id");
	assertEqual(save.options.order, 900, "另存为的 order");
	assertEqual(fork.options.order, 900, "分叉的 order");
	assertEqual(typeof save.component, "function", "另存为组件类型");
	assertEqual(typeof fork.component, "function", "分叉组件类型");
});

/** 造一个专供扩展位用例的沙盒（`current` = 写进 localStorage 的当前设备 id）。 */
function menuSandbox(options = {}) {
	const sandbox = createSandbox({
		responses: options.responses === undefined ? {} : options.responses,
		// `primitives: true` = require 拿到有 Button/MenuItemButton/图标的假 ui-primitives。
		primitives: options.primitives === true,
	});
	if (options.current !== undefined && options.current !== "") sandbox.localStorage.setItem("dsh-device-switch:current", options.current);
	sandbox.loadModule();
	return sandbox;
}

/** 取槽位组件并渲染（同一个 sandbox 里重复渲染会保留状态，和真 React 一样）。 */
function renderSlotComponent(sandbox, slotName, props) {
	const entry = slotEntry(sandbox, slotName);
	return sandbox.render(entry.component, props);
}

/**
 * 文档预览头部按钮区（`sidebar.right.tab.document.actions`）的**真实** props：
 * ownerProps 只有 `{ absolutePath }`（documentpreview 的 `fileOwner`），
 * `sessionId` 是这个 session 作用域槽位的**标准 props**（open-in-app 用的是同一个 absolutePath）。
 * absolutePath 是 Host 绝对路径（Windows 上形如 `C:\…`），不再是 `dsh-resource://` 资源地址。
 */
const SAVE_OWNER = { absolutePath: "C:\\Users\\<user>\\notes\\中文 文件.md", sessionId: "sess-1" };

check("「另存为…」在 document.actions 上：**永远显示**（本机 / 没有路径 / 没有会话时都渲染），回退分支是 role=button 的 button", () => {
	const sandbox = menuSandbox();
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", SAVE_OWNER);
	assert(tree !== null && tree !== undefined, "本机（localStorage 无那个键）时也必须显示「另存为…」");
	// 新实现只渲染图标（调用点固定 `iconOnly: true`），按钮里没有可见文字 → 按 testId 取；
	// 它的"名字"是 title / aria-label（下面两条断言查的就是这两个）。
	const button = findToolbarAction(tree, "save-as");
	assert(button !== undefined, `找不到 <button data-dsh-remote=save-as>（实际文本 ${JSON.stringify(collectText(tree))}）`);
	// 这里是**标题栏按钮区**（不是菜单行）：是普通 button，不是 role=menuitem。
	assertEqual(button.props.role, "button", "必须是 role=button 的 button（不再用菜单行的 menuitem）");
	assertEqual(button.props["data-dsh-remote"], "save-as", "按钮必须带 data-dsh-remote=save-as");
	assert(String(button.props.title).includes("下载当前预览文件"), `必须有悬停提示 title：${button.props.title}`);
	assert(String(button.props["aria-label"]).includes("下载当前预览文件"), `必须有 aria-label：${button.props["aria-label"]}`);
});

check("「另存为…」永远显示：没有任何 props（既没路径也没会话）时按钮仍在", () => {
	const sandbox = menuSandbox();
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", {});
	assert(tree !== null && tree !== undefined, "什么都不满足时也要显示按钮（用户明确要求不做可见性判断）");
	assert(findToolbarAction(tree, "save-as") !== undefined, `找不到 <button data-dsh-remote=save-as>（实际文本 ${JSON.stringify(collectText(tree))}）`);
});

check("「另存为…」自己渲染 <button data-dsh-remote=save-as>（外圈照抄邻居：24px / .5px 边框 / radius-sm）+ 只显示下载图标 + title，不是菜单行组件", () => {
	const sandbox = menuSandbox({ primitives: true });
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", SAVE_OWNER);
	// 2026-10-13 起**不再用官方 Button**（它自带的 size:"sm" = 28px，比邻居大一圈），改成自己渲染
	// <button>：按 testId 取，外圈尺寸按 style 断言 —— 原来那两条官方 Button 的
	// `data-variant` / `data-size` 断言随实现一起作废（这里换成了等价的 style 断言）。
	const button = findToolbarAction(tree, "save-as");
	assert(button !== undefined, `必须渲染出 <button data-dsh-remote=save-as>（实际文本 ${JSON.stringify(collectText(tree))}）`);
	// 外圈复刻邻居（@deepseek-ai/dsh-client-ui-open-in-app 的 OpenTargetButton CSS）。
	assertEqual(button.props["data-height"], "24", "外圈高度必须与邻居一致（data-height=24）");
	assertEqual(button.props.style.height, "24px", "style.height 也必须是 24px");
	assert(String(button.props.style.border).includes("0.5px solid var(--dsw-alias-border-l4)"), `边框必须复刻邻居：${button.props.style.border}`);
	assertEqual(button.props.style.borderRadius, "var(--dsw-radius-sm)", "圆角必须复刻邻居（radius-sm）");
	assertEqual(button.props.style.boxSizing, "border-box", "外圈尺寸要算上那 0.5px 边框");
	assertEqual(button.props.style.display, "inline-flex", "与邻居一样是 inline-flex");
	// 2026-10-13 用户要求：只显示下载图标（可见文字会让按钮比邻居的三个纯图标按钮宽一圈）。
	assert(!flatText(button).includes("另存为"), `必须只显示图标、不带可见文字：${flatText(button)}`);
	assert(String(button.props["aria-label"]).includes("下载当前预览文件"), "纯图标后必须保留 aria-label（读屏可用）");
	assert(String(button.props.title).includes("下载当前预览文件"), "也必须带 title（悬停提示）");
	const icon = flatten(button).filter((node) => node.props !== undefined && node.props !== null && node.props["data-icon"] === "IconDownloadOutlineRegular")[0];
	assert(icon !== undefined, "必须用官方 IconDownloadOutlineRegular 图标");
	// 菜单行组件 MenuItemButton 不许出现在这个插槽的渲染里（它是下拉菜单的行）。
	assert(flatten(tree).every((node) => node.type !== "menuitem"), "标题栏按钮区不该渲染菜单行");
});

check("点「另存为…」（**没有**设备切换键 = 浏览器打开另一台机器的页面）：照样发起下载，URL 里 device 为空", () => {
	const sandbox = menuSandbox();
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", SAVE_OWNER);
	clickToolbarAction(tree, "save-as");
	const urls = sandbox.readNavigations();
	assertEqual(urls.length, 1, "没有切换键也必须下载（用户实测：坐在家里用浏览器打开设备A的页面，localStorage 里就是空的）");
	assertEqual(
		urls[0],
		"/plugin/remote/download?device=&path=C%3A%5CUsers%5C%3Cuser%3E%5Cnotes%5C%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md&session=sess-1",
		"device= 必须是空值（宿主半据此读页面所在这台机器上的文件）",
	);
	assertEqual(sandbox.readAlerts().length, 0, "这条路不许再弹「当前是「本机」」之类的拦截提示");
});

check("点「另存为…」：**不再出现**「当前是「本机」」这类设备判断（提示与代码里都不许有）", () => {
	const sandbox = menuSandbox();
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", {});
	clickToolbarAction(tree, "save-as");
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条提示（缺路径）");
	assert(!alerts[0].includes("本机"), `提示里不该再出现设备判断：${alerts[0]}`);
	assert(alerts[0].includes("文件路径"), `第一条提示应该是「拿不到文件路径」：${alerts[0]}`);
	assertEqual(sandbox.readNavigations().length, 0, "缺路径时不该跳转");
	// 源码级：另存为那段里不许再有"当前是本机 → 不下载"这条老逻辑。
	const saveAsBlock = SOURCE.slice(SOURCE.indexOf("function SaveAsAction(props)"), SOURCE.indexOf("function ForkMenuItem(props)"));
	assert(!saveAsBlock.includes("当前是「本机」"), "SaveAsAction 里不许再有「当前是「本机」」");
	assert(!saveAsBlock.includes('deviceId === ""'), "SaveAsAction 里不许再有 deviceId 为空的提前 return");
});

check("点「另存为…」（选中远程设备）→ location.assign 到 /plugin/remote/download?device=…&path=<绝对路径>&session=…（编码断言）", () => {
	const sandbox = menuSandbox({ current: "home" });
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", SAVE_OWNER);
	clickToolbarAction(tree, "save-as");
	const urls = sandbox.readNavigations();
	assertEqual(urls.length, 1, "跳转次数");
	assertEqual(
		urls[0],
		"/plugin/remote/download?device=home&path=C%3A%5CUsers%5C%3Cuser%3E%5Cnotes%5C%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md&session=sess-1",
		"下载地址（ownerProp.absolutePath 整条按 URL 编码，session 取自槽位标准 props）",
	);
	assertEqual(sandbox.readAlerts().length, 0, "成功路径不该弹提示");
});

check("「另存为…」拿不到路径（槽位没给 absolutePath）→ 按钮仍在，点了给明确提示、不跳转", () => {
	const sandbox = menuSandbox({ current: "home" });
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", { sessionId: "sess-1" });
	assert(tree !== null, "拿不到路径时也要显示这一项，不再整项隐藏");
	clickToolbarAction(tree, "save-as");
	assertEqual(sandbox.readNavigations().length, 0, "拿不到路径时不该跳转");
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条提示说明为什么不能下载");
	assert(String(alerts[0]).includes("文件路径"), `提示里要说明拿不到文件路径：${alerts[0]}`);
});

check("「另存为…」有路径但没有会话信息（槽位没给 sessionId）→ 提示「没有会话信息」、不跳转", () => {
	const sandbox = menuSandbox({ current: "home" });
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", { absolutePath: "C:\\Users\\<user>\\a.md" });
	clickToolbarAction(tree, "save-as");
	assertEqual(sandbox.readNavigations().length, 0, "不该跳转");
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条提示");
	assert(alerts[0].includes("没有会话信息"), `提示里要写明原因：${alerts[0]}`);
	// 本机与目标机都是同一套"按 session 授权"，所以提示不该再把它说成目标机的事。
	assert(!alerts[0].includes("目标机"), `提示不该再说"目标机的读取"：${alerts[0]}`);
});

check("「另存为…」有切换键但设备表里没有这台（配置改过）→ 照样下载，device 原样带上（客户端半不查设备表）", () => {
	const sandbox = menuSandbox({ current: "ghost-device" });
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", SAVE_OWNER);
	clickToolbarAction(tree, "save-as");
	const urls = sandbox.readNavigations();
	assertEqual(urls.length, 1, "设备表里有没有这台，不该拦住下载（真源是宿主半的设备表）");
	assert(String(urls[0]).startsWith("/plugin/remote/download?device=ghost-device&"), `device 应原样带上：${urls[0]}`);
	assertEqual(sandbox.readAlerts().length, 0, "成功路径不该弹提示");
});

check("「另存为…」session id 里的特殊字符照样 URL 编码（/:? 都不许裸露）", () => {
	const sandbox = menuSandbox();
	const { tree } = renderSlotComponent(sandbox, "sidebar.right.tab.document.actions", { absolutePath: "C:\\Users\\<user>\\a b.md", sessionId: "sess/1?x y" });
	clickToolbarAction(tree, "save-as");
	const urls = sandbox.readNavigations();
	assertEqual(urls.length, 1, "跳转次数");
	assertEqual(urls[0], "/plugin/remote/download?device=&path=C%3A%5CUsers%5C%3Cuser%3E%5Ca%20b.md&session=sess%2F1%3Fx%20y", "URL 编码");
	assert(!String(urls[0]).includes(" "), "地址里不许有空格");
});

/** 设备表：一台本机 + 一台远端（分叉只列远端那台）。 */
const FORK_STATE = {
	enabled: true,
	devices: [
		{ id: "self", name: "本机", url: "http://127.0.0.1:19387", local: true },
		{ id: "home", name: "设备B", url: "http://192.0.2.2:19387", local: false },
	],
};

check("「分叉到…」显示条件：没有任何远程设备（只有本机那台）→ 整项不显示", async () => {
	const sandbox = menuSandbox({
		responses: { "/plugin/remote/state": { enabled: true, devices: [{ id: "self", name: "本机", local: true }] } },
	});
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, { sessionId: "s-1" });
	await settle();
	const { tree } = sandbox.render(entry.component, { sessionId: "s-1" });
	assertEqual(tree, null, "无远程设备时应当是 null（不显示）");
});

check("「分叉到…」还在加载（/state 未返回）→ 整项为 null（不显示）", () => {
	const sandbox = menuSandbox({ responses: { "/plugin/remote/state": FORK_STATE } });
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	// 首帧（跳过 effect）：/state 还没回来 → 一行都不该出现。
	const { tree } = sandbox.render(entry.component, { sessionId: "s-1" }, { skipEffect: true });
	assertEqual(tree, null, "加载中应当是 null（不显示）");
});

check("「分叉到…」有远程设备 → 每台远程设备一行「分叉到 <设备名>」，排除本机那台", async () => {
	const sandbox = menuSandbox({ responses: { "/plugin/remote/state": FORK_STATE } });
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, { sessionId: "s-1" });
	await settle();
	const loaded = sandbox.render(entry.component, { sessionId: "s-1" });
	const row = findButtonExact(loaded.tree, "分叉到 设备B");
	assert(row !== undefined, `找不到「分叉到 设备B」（实际文本 ${JSON.stringify(collectText(loaded.tree))}）`);
	assertEqual(row.props.role, "menuitem", "回退分支必须是 role=menuitem 的 button");
	assertEqual(row.props["data-dsh-remote"], "fork-home", "菜单行必须带 data-dsh-remote=fork-<设备id>");
	assertEqual(findAllButtons(loaded.tree, "分叉到").length, 1, "只有一台远程设备 → 恰好一行");
	assert(findButtonExact(loaded.tree, "分叉到 本机") === undefined, "本机那台必须被排除");
	assert(findButtonExact(loaded.tree, "分叉到…") === undefined, "不再有旧的自绘「分叉到…」一级项");
});

check("「分叉到 <设备名>」的双设备用例：设备名是**加重节点**（fontWeight 600 的 span / strong），文案仍能识别出「分叉到 <名字>」", async () => {
	const sandbox = menuSandbox({
		responses: {
			"/plugin/remote/state": {
				enabled: true,
				devices: [
					{ id: "self", name: "本机", url: "http://127.0.0.1:19387", local: true },
					{ id: "home", name: "设备B", url: "http://192.0.2.2:19387", local: false },
					{ id: "vps", name: "VPS", url: "http://1.2.3.4:19387", local: false },
				],
			},
		},
	});
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, { sessionId: "s-1" });
	await settle();
	const loaded = sandbox.render(entry.component, { sessionId: "s-1" });
	assertEqual(findAllButtons(loaded.tree, "分叉到").length, 2, "两台远程设备 → 恰好两行");
	for (const [id, name] of [["home", "设备B"], ["vps", "VPS"]]) {
		const row = findAllButtons(loaded.tree, "分叉到 " + name)[0];
		assert(row !== undefined, `找不到「分叉到 ${name}」（实际文本 ${JSON.stringify(collectText(loaded.tree))}）`);
		assertEqual(row.props["data-dsh-remote"], "fork-" + id, `行的 testId 应是 fork-${id}`);
		// ③ 加重的设备名节点：文字正好是设备名，且是 <strong> 或 fontWeight >= 600 的 span。
		const bold = findEmphasis(row, name);
		assert(bold !== undefined, `「分叉到 ${name}」里的设备名必须被加重（实际子树：${JSON.stringify(flatText(row))}）`);
		assertEqual(bold.type, "span", "加重节点用 span（带内联 fontWeight）");
		assertEqual(Number(bold.props.style.fontWeight), 600, "加重的 fontWeight 必须是 600");
		// 文案仍能识别出「分叉到 <设备名>」（归一化空白后逐字相等）。
		assertEqual(flatText(row), "分叉到 " + name, "行文案必须仍是「分叉到 <设备名>」");
		// 设备名与"分叉到"是**两个**节点：名字是独立的加重节点，不是整行加粗。
		assert(childrenOf(row).includes("分叉到 "), "「分叉到 」必须仍是普通文字节点（只有设备名加重）");
	}
});

check("「分叉到 <设备名>」在官方 MenuItemButton 分支里同样把设备名当加重 children 传下去", async () => {
	const sandbox = menuSandbox({ responses: { "/plugin/remote/state": FORK_STATE }, primitives: true });
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, { sessionId: "s-1" });
	await settle();
	const loaded = sandbox.render(entry.component, { sessionId: "s-1" });
	const row = findAll(loaded.tree, (node) => node.type === "button" && node.props["data-dsh-remote"] === "fork-home")[0];
	assert(row !== undefined, `官方 MenuItemButton 分支必须渲染出 <button data-dsh-remote=fork-home>（实际 ${JSON.stringify(collectText(loaded.tree))}）`);
	assertEqual(row.props.role, "menuitem", "官方行仍是 menuitem");
	assertEqual(flatText(row), "分叉到 设备B", "行文案必须仍是「分叉到 设备B」");
	const bold = findEmphasis(row, "设备B");
	assert(bold !== undefined, "官方分支里设备名同样必须是加重节点");
	assertEqual(Number(bold.props.style.fontWeight), 600, "加重的 fontWeight 必须是 600");
	assert(flatten(row).some((node) => node.props !== undefined && node.props !== null && node.props["data-icon"] === "IconBranchOutlineRegular"),
		"官方分支必须带 IconBranchOutlineRegular 图标");
});

check("点某台设备那一行 → 先关菜单 + POST /plugin/remote/fork（请求体正确，带槽位给的 displayTitle）+ 成功提示「已在 设备B 上创建会话 ab12cd34」", async () => {
	const sandbox = menuSandbox({
		responses: {
			"/plugin/remote/state": FORK_STATE,
			"/plugin/remote/fork": { ok: true, targetDeviceId: "home", targetDeviceName: "设备B", newSessionId: "ab12cd34-5678-90ab-cdef-1234567890ab", messages: 7, bytes: 321 },
		},
	});
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	let closed = 0;
	let forksAtClose = -1;
	const hookProps = {
		sessionId: "s-42",
		// 槽位 ownerProps 就是 `{ sessionId, displayTitle }`：标题必须原样进 sourceTitle（宿主半拼「<标题> - 来自<本机名>」）。
		displayTitle: "修跨设备分叉",
		useMenuOpenState: () => [null, (value) => {
			if (value === false) {
				closed += 1;
				forksAtClose = sandbox.readFetch().filter((call) => call.url === "/plugin/remote/fork").length;
			}
		}],
	};
	sandbox.render(entry.component, hookProps);
	await settle();
	const loaded = sandbox.render(entry.component, hookProps);
	clickNth(loaded.tree, "分叉到 设备B", 0);
	const calls = sandbox.readFetch().filter((call) => call.url === "/plugin/remote/fork");
	assertEqual(calls.length, 1, "应当恰好发一次 /fork");
	assertEqual(calls[0].init.method, "POST", "必须是 POST");
	assertEqual(calls[0].init.headers["content-type"], "application/json", "必须带 JSON content-type");
	assertEqual(
		calls[0].init.body,
		JSON.stringify({ targetDeviceId: "home", sourceSessionId: "s-42", sourceTitle: "修跨设备分叉" }),
		"请求体（targetDeviceId / sourceSessionId / sourceTitle=ownerProps.displayTitle；**不带 tailN** —— 条数由宿主半按「配置」块里存的值决定）",
	);
	assertEqual(closed, 1, "选完要关掉会话菜单（走框架注入的 useMenuOpenState）");
	assertEqual(forksAtClose, 0, "关闭器必须在动作（POST）之前调用");
	await settle();
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条结果提示");
	assertEqual(alerts[0], "已在 设备B 上创建会话 ab12cd34（带过去 7 条消息）。", "成功提示");
});

check("「分叉到…」ownerProps 里没有 displayTitle（或不是字符串）→ sourceTitle 送空串，由宿主半兜底成「未命名会话」", async () => {
	for (const [label, props] of [
		["没有 displayTitle 字段", { sessionId: "s-7" }],
		["displayTitle 是空串", { sessionId: "s-7", displayTitle: "" }],
		["displayTitle 不是字符串（数字）", { sessionId: "s-7", displayTitle: 123 }],
		["displayTitle 是 null", { sessionId: "s-7", displayTitle: null }],
	]) {
		const sandbox = menuSandbox({
			responses: {
				"/plugin/remote/state": FORK_STATE,
				"/plugin/remote/fork": { ok: true, targetDeviceId: "home", targetDeviceName: "设备B", newSessionId: "ab12cd34-5678-90ab-cdef-1234567890ab", messages: 3, bytes: 42 },
			},
		});
		const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
		sandbox.render(entry.component, props);
		await settle();
		const loaded = sandbox.render(entry.component, props);
		clickNth(loaded.tree, "分叉到 设备B", 0);
		const calls = sandbox.readFetch().filter((call) => call.url === "/plugin/remote/fork");
		assertEqual(calls.length, 1, `${label}：应当发一次 /fork`);
		assertEqual(
			calls[0].init.body,
			JSON.stringify({ targetDeviceId: "home", sourceSessionId: "s-7", sourceTitle: "" }),
			`${label}：sourceTitle 必须是空串（客户端半不自己编标题），且不带 tailN`,
		);
		assert(!String(calls[0].init.body).includes("undefined"), `${label}：请求体里不该出现 undefined`);
		await settle();
	}
});


check("「分叉到…」失败（宿主半回 {ok:false,error}）→ 显示原因，不崩", async () => {
	const sandbox = menuSandbox({
		responses: {
			"/plugin/remote/state": FORK_STATE,
			"/plugin/remote/fork": { ok: false, error: "分叉到：设备B (home) 不可达 —— connect ECONNREFUSED" },
		},
	});
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, { sessionId: "s-42" });
	await settle();
	const loaded = sandbox.render(entry.component, { sessionId: "s-42" });
	clickNth(loaded.tree, "分叉到 设备B", 0);
	await settle();
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条失败提示");
	assert(alerts[0].includes("分叉失败") && alerts[0].includes("不可达"), `提示里要有原因：${alerts[0]}`);
});

check("「分叉到…」拿不到 sessionId（槽位上下文里没有）→ 明确提示，且一个请求都不发", async () => {
	const sandbox = menuSandbox({ responses: { "/plugin/remote/state": FORK_STATE } });
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, {});
	await settle();
	const loaded = sandbox.render(entry.component, {});
	clickNth(loaded.tree, "分叉到 设备B", 0);
	assertEqual(sandbox.readFetch().filter((call) => call.url === "/plugin/remote/fork").length, 0, "拿不到会话 id 时不该发请求");
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条提示");
	assert(alerts[0].includes("拿不到当前会话 id"), `提示里要写明原因：${alerts[0]}`);
});

check("「分叉到…」设备表读失败 → 一行「分叉到…（设备列表读取失败）」，点它给错误提示、不发 POST", async () => {
	const sandbox = menuSandbox({ responses: { "/plugin/remote/state": "reject" } });
	const entry = slotEntry(sandbox, "sidebar.workspaces.session.menu.item");
	sandbox.render(entry.component, { sessionId: "s-1" });
	await settle();
	const loaded = sandbox.render(entry.component, { sessionId: "s-1" });
	const row = findButtonExact(loaded.tree, "分叉到…（设备列表读取失败）");
	assert(row !== undefined, `读失败也要显示这一行（实际文本 ${JSON.stringify(collectText(loaded.tree))}）`);
	assertEqual(row.props.role, "menuitem", "回退分支必须是 role=menuitem 的 button");
	assertEqual(row.props["data-dsh-remote"], "fork-error", "提示行要带 data-dsh-remote=fork-error");
	clickNth(loaded.tree, "分叉到…（设备列表读取失败）", 0);
	assertEqual(sandbox.readFetch().filter((call) => call.url === "/plugin/remote/fork").length, 0, "读失败的行不该发 POST");
	const alerts = sandbox.readAlerts();
	assertEqual(alerts.length, 1, "应当给一条提示");
	assert(alerts[0].includes("读取设备列表失败"), `提示里要写明原因：${alerts[0]}`);
});

//#endregion

//#region 4. 源码文本断言

section("4. 源码文本断言（localStorage 键 / 依赖 / 契约路由 / 两个不许回退的修复）");

check("存储键名：localStorage 只有主键 + 别名；sessionStorage 只有哨兵 + force-active（宿主半同名）", () => {
	// 看**字符串字面量**，避免把文档注释里的键名算进来。
	const literals = SOURCE.match(/"[^"\n]*(?:dsh-device-switch|dsh-remote):[^"\n]*"/g) || [];
	assert(literals.length > 0, "源码里必须出现这些键名的字符串字面量");
	const primary = literals.filter((literal) => literal === '"dsh-device-switch:current"');
	const alias = literals.filter((literal) => literal === '"dsh-remote:current"');
	assertEqual(primary.length, 1, `主键字面量应恰好一处，实际 ${JSON.stringify(literals)}`);
	assertEqual(alias.length, 1, `别名键字面量应恰好一处（SWITCH_ALIAS_KEY），实际 ${JSON.stringify(literals)}`);
	// 两个会话级标记（宿主半的 SHIM_SELFTEST_SENTINEL_KEY / SHIM_FORCE_ACTIVE_KEY，键名必须逐字一致）。
	const sentinel = literals.filter((literal) => literal === `"${SENTINEL_KEY}"`);
	const forced = literals.filter((literal) => literal === `"${FORCE_ACTIVE_KEY}"`);
	assertEqual(sentinel.length, 1, `哨兵键字面量应恰好一处，实际 ${JSON.stringify(literals)}`);
	assertEqual(forced.length, 1, `force-active 键字面量应恰好一处，实际 ${JSON.stringify(literals)}`);
	const allowed = new Set(['"dsh-device-switch:current"', '"dsh-remote:current"', `"${SENTINEL_KEY}"`, `"${FORCE_ACTIVE_KEY}"`]);
	for (const literal of literals) {
		assert(allowed.has(literal), `出现了非约定的键名：${literal}`);
	}
	// 整个文件里任何 dsh-device-switch:xxx / dsh-remote:xxx 的写法都必须是这四个键。
	const anyKey = SOURCE.match(/dsh-device-switch:[A-Za-z0-9._:-]+|dsh-remote:[A-Za-z0-9._:-]+/g) || [];
	for (const key of anyKey) {
		assert(key === "dsh-device-switch:current" || key === "dsh-remote:current" || key === SENTINEL_KEY || key === FORCE_ACTIVE_KEY,
			`出现了非约定的键名：${key}`);
	}
	// 两个会话级标记必须走 sessionStorage（写进 localStorage 就成了跨窗口残留）。
	const clearBody = SOURCE.slice(SOURCE.indexOf("function clearSessionFlag"), SOURCE.indexOf("function clearSessionFlag") + 500);
	assert(clearBody.includes("globalThis.sessionStorage"), "clearSessionFlag 必须读 sessionStorage");
	const writeBody = SOURCE.slice(SOURCE.indexOf("function writeSessionFlag"), SOURCE.indexOf("function writeSessionFlag") + 500);
	assert(writeBody.includes("globalThis.sessionStorage"), "writeSessionFlag 必须读 sessionStorage");
});

check("写键/删键都收口在同一个函数里：切回本机走 clearCurrentId（主键 + 别名一起删）", () => {
	const at = SOURCE.indexOf("function writeCurrentId");
	assert(at > 0, "必须有 writeCurrentId");
	const body = SOURCE.slice(at, at + 900);
	assert(body.includes('if (id === "") storage.removeItem(SWITCH_KEY)'), "切回本机分支必须 removeItem");
	assert(body.includes("storage.setItem(SWITCH_KEY, id)"), "切换分支必须 setItem");
	const clearAt = SOURCE.indexOf("function clearCurrentId");
	assert(clearAt > 0, "必须有 clearCurrentId（停用/回本机都靠它）");
	const clearBody = SOURCE.slice(clearAt, clearAt + 700);
	assert(clearBody.includes("storage.removeItem(SWITCH_KEY)") && clearBody.includes("storage.removeItem(SWITCH_ALIAS_KEY)"),
		"clearCurrentId 必须把主键与别名键都删掉");
	assert(SOURCE.includes('if (next === "") clearCurrentId();'), "applyDeviceSwitch 的「回到本机」分支必须调用 clearCurrentId");
	assert(SOURCE.includes('writeCurrentId(next)'), "applyDeviceSwitch 的切换分支必须调用 writeCurrentId");
	assert(SOURCE.includes("globalThis.location.reload()"), "切换后必须 reload");
});

check('依赖只有 react 与 @deepseek-ai/dsh-client-ui-primitives：没有 import / 没有别的 require / 没有 from "…"', () => {
	// 只认真正的 import 语句（排除注释里的 "import " 说明）。
	const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const importHits = code.match(/(^|[^\w.$])import\s*[({'"]/g) || [];
	assertEqual(importHits.length, 0, `不该有 import 语句，命中 ${importHits.length} 处`);
	const requireHits = code.match(/require\s*\(\s*(['"`])([^'"`]*)\1\s*\)/g) || [];
	// 恰好两处：react + 官方菜单项组件库（后者在 try/catch 里，取不到就退化成普通按钮）。
	assertEqual(requireHits.length, 2, `应恰好两处 require，实际 ${JSON.stringify(requireHits)}`);
	assertEqual(requireHits[0], 'require("react")', "第一个依赖必须是 react");
	assertEqual(requireHits[1], 'require("@deepseek-ai/dsh-client-ui-primitives")', "第二个依赖只能是 ui-primitives");
	for (const hit of requireHits) {
		assert(
			hit === 'require("react")' || hit === 'require("@deepseek-ai/dsh-client-ui-primitives")',
			`出现未允许的依赖：${hit}`,
		);
	}
	assert(!/\bfrom\s+['"]/.test(code), "不该出现 ESM 的 from '...'");
});

check("没有外部资源（无 <link>/<script>/远程 src），样式全内联", () => {
	assert(!/<link\b/i.test(SOURCE), "不该有 <link>");
	assert(!/createElement\(\s*["']script["']/i.test(SOURCE), "不该创建 <script>");
	assert(!/\bsrc\s*:\s*["']https?:/i.test(SOURCE), "不该引用远程 src");
	assert(!/\.css["']/.test(SOURCE), "不该引用 css 文件");
});

check("接口只打契约路由（/plugin/remote/*），含「配置」块的 POST /access", () => {
	const paths = new Set((SOURCE.match(/request\(\s*"([^"]*)"/g) || []).map((hit) => hit.replace(/^request\(\s*"/, "").replace(/"$/, "")));
	assert(paths.size >= 5, `request() 调用点太少：${JSON.stringify([...paths])}`);
	const allowed = (path) =>
		path === "/urls" ||
		path === "/state" ||
		path === "/devices" ||
		path === "/enabled" ||
		path === "/access" ||
		path === "/fork" ||
		path.startsWith("/test/") ||
		path.startsWith("/devices/");
	for (const path of paths) assert(allowed(path), `出现未在契约里的接口：${path}`);
	assert(SOURCE.includes('request(ACCESS_ROUTE, { method: "POST"'), "「配置」的保存必须走 /access（常量拼）");
	assert(SOURCE.includes('var API = "/plugin/remote"'), "路由前缀必须是 /plugin/remote");
	assertEqual((SOURCE.match(/\bfetch\s*\(/g) || []).length, 1, "只该有一个 fetch 调用点（统一走 request 收口）");
	assert(SOURCE.includes("fetch(API + path, init)"), "fetch 必须拼上 /plugin/remote 前缀");
	assert(SOURCE.includes('credentials = "same-origin"'), "必须带 credentials: same-origin");
});

check("形态是构建产物格式：window.__ModuleLoader__.load 包住 factory", () => {
	assert(/window\.__ModuleLoader__\.load\(\{/.test(SOURCE), "必须是 __ModuleLoader__.load({...}) 形态");
	assert(SOURCE.includes('id: "@local/dsh-remote"'), "id 必须是 @local/dsh-remote");
	assert(SOURCE.includes("factory: (require) => {"), "必须是 factory: (require) => {...}");
	assert(SOURCE.includes('exports.inject = ["slots"]'), "必须导出 inject = [slots]");
	assert(SOURCE.includes("return module.exports;"), "必须 return module.exports");
});

check("修复①：设备表每行按钮用**每行独立闭包**（覆盖历史回归）", () => {
	assert(SOURCE.includes("(function buildRow(device) {"), "每行必须在自己的函数作用域里造");
	assert(SOURCE.includes("})(asObject(devices[index])),"), "buildRow 必须被立即执行并传入**当前行**");
	assert(SOURCE.includes('var switching = isLocal ? currentId !== "" : currentId !== id;'), "switching 必须是行内局部量");
	assert(SOURCE.includes('applyDeviceSwitch(isLocal ? "" : id)'), "切换必须用该行闭包里的 id");
	assert(SOURCE.includes("removeDevice(device)"), "删除必须用该行闭包里的 device");
});

check("修复②：表单更新一律函数式 setForm(prev => ({ ...prev, ... }))", () => {
	assert(!/setForm\(\s*(?!function)/.test(SOURCE), "setForm 的实参必须一律是函数（函数式更新）");
	assert(SOURCE.includes("setForm(function (previous) {"), "必须有函数式 setForm");
	assert(SOURCE.includes("return { ...asObject(previous), ...patch };"), "patch 必须展开上一份状态");
	assert((SOURCE.match(/setForm\(/g) || []).length >= 2, "至少有两处 setForm 调用（改字段 / 重置）");
});

//#endregion

//#region 结果

await Promise.all(pending);

console.log(`\n${"-".repeat(60)}`);
if (failures.length === 0) {
	console.log(`全部通过：${passed} 项断言，0 失败。`);
	process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error && failure.error.message}`);
process.exit(1);

//#endregion
