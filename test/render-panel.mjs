/**
 * 面板回归夹具。
 *
 * 两件事必须在这里被挡住，因为它们在浏览器里都表现为“整个芯片凭空消失”，
 * 而在 Node 里跑一遍就能一秒定位：
 *
 *   1. 渲染期抛错 —— 槽位机制会把注册项直接退役（abdicate），页面不刷新就再也回不来。
 *      典型是 TDZ：某个 useCallback 的依赖数组里引用了后面才声明的 const。
 *   2. 事件回调抛错 —— React 不会为此退役槽位，但功能会静默失效。
 *
 * 另外钉住两条产品约束：自动模式下滑块必须是可拖的；拖动时面板上的数字必须
 * 立刻跟着重算，而不是等主机那边提交完才动。
 *
 * 跑法：node test/render-panel.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, "..", "lib", "client.js");

// ── React 替身 ───────────────────────────────────────────────────────────────
// 只实现这个面板真正用到的那几个钩子。state 存在数组里、按下标寻址，这样渲染
// 之间保留状态，setState 之后重新渲染能看见变化。
let hookStates = [];
let hookIndex = 0;
/**
 * 每次渲染时记录下来的 effect。
 *
 * 替身不跑 effect（没有调度器），所以 `load()` / `loadLog()` / 轮询这些路径从来没人走过 ——
 * 连「注释里写着的历史 bug」都没人看守。记下来之后，测试可以自己决定什么时候执行它们，
 * 失败路径也就测得到了。
 */
let effects = [];
const React = {
	Fragment: Symbol("Fragment"),
	createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() }; },
	useState(init) {
		const i = hookIndex++;
		if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? init() : init;
		return [hookStates[i], (v) => { hookStates[i] = typeof v === "function" ? v(hookStates[i]) : v; }];
	},
	useRef(init) { const i = hookIndex++; if (!(i in hookStates)) hookStates[i] = { current: init ?? null }; return hookStates[i]; },
	useEffect(fn) { effects[hookIndex++] = fn; },
	useLayoutEffect(fn) { effects[hookIndex++] = fn; },
	useCallback(fn) { hookIndex++; return fn; },
	useMemo(fn) { hookIndex++; return fn(); }
};
const primitives = { useAnchoredPosition() { hookIndex++; return { left: 0, top: 0 }; } };

const store = new Map();
globalThis.window = {
	__ModuleLoader__: { load(m) { globalThis.__mod = m; } },
	localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
	addEventListener() {}, removeEventListener() {}
};
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} }, addEventListener() {}, removeEventListener() {} };
globalThis.Node = class Node {};
// 夹具自己的 fetch。`STUB_STATE` 让异步的 load() 晚一步落地时写回同一份 state：
// 场景是同步渲染的，它们挂起的 load() 会攒到本文件第一次 await 时一起放出来，
// 若不这样兜底，最后一个 setState 会把 state 写成空对象，面板退化成一堆兜底值。
let STUB_STATE = null;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: STUB_STATE }) });

const myRequire = (n) => n === "react" ? React
	: n === "@deepseek-ai/dsh-client-ui-primitives" ? primitives
		: (() => { throw new Error("require " + n); })();

await import("file:///" + CLIENT.replace(/\\/g, "/"));
const mod = globalThis.__mod.factory(myRequire);

// ── 把 Panel 从芯片的元素树里摘出来 ─────────────────────────────────────────
let Chip = null;
mod.apply({
	effect(fn) { try { fn(); } catch { /* 夹具不需要真实副作用 */ } },
	locale: { register() { return () => {}; }, bind: () => (k) => k },
	slots: { inject(_n, cb) { cb(); }, register(_o, C) { Chip = C; return () => {}; } }
});

hookStates = [true]; hookIndex = 0;
const chipTree = Chip({ t: (k) => k, sessionId: "s" });
function findPanel(node) {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) { for (const n of node) { const r = findPanel(n); if (r) return r; } return null; }
	if (typeof node.type === "function" && node.type.name === "Panel") return node.type;
	return findPanel(node.children ?? []);
}
const Panel = findPanel(chipTree);
if (Panel === null) { console.error("夹具自身失效：没能从芯片里取到 Panel"); process.exit(2); }

// ── 钩子下标表 ──────────────────────────────────────────────────────────────
//
// 替身按下标存 hook，而这份表是硬编码的 —— 在 Panel 顶部插一个 useState 就会让后面
// 全部错位，断言读到别人的状态，而且**不会报错**（历史上就这么静默漂过）。所以下面先用
// 源码里真实的声明顺序核对一遍：对不上就立刻红，而不是让断言去读错位的值。
const HOOK = {
	state: 0, models: 1, modelsError: 2, log: 3, logError: 4, draft: 5, error: 6, busy: 7,
	sending: 8, retainMode: 9, retainDraft: 10, compactNote: 11, logOpen: 12, panelRef: 13
};
{
	const src = readFileSync(CLIENT, "utf8");
	// 只看 Panel 自己的钩子：从它的声明到下一个组件为止。`useCallback`/`useEffect` 也占
	// 下标，但它们排在 `panelRef` 之后，所以这份表只收 useState/useRef。
	const body = src.slice(src.indexOf("function Panel("), src.indexOf("function CompactChip("));
	const decls = [...body.matchAll(/const\s*\[\s*(\w+)\s*,[^\]]*\]\s*=\s*React\.useState\(|const\s+(\w+)\s*=\s*React\.useRef\(/g)]
		.map((m) => m[1] ?? m[2]);
	const expected = Object.keys(HOOK);
	const same = decls.length === expected.length && decls.every((n, i) => n === expected[i]);
	console.log("\n钩子顺序");
	console.log("  " + (same ? "✅" : "❌") + " 夹具的下标表与 client.js 的声明顺序一致（" + decls.length + " 个）");
	if (!same) {
		console.log("     源码: " + decls.join(", "));
		console.log("     夹具: " + expected.join(", "));
		console.log("     在 Panel 顶部动过 useState/useRef 就要同步更新 HOOK。");
		process.exit(2);
	}
}

// ── 渲染与遍历 ──────────────────────────────────────────────────────────────
/** 展开函数组件，把整棵树摊成文本。 */
function render(node) {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node) + " ";
	if (Array.isArray(node)) return node.map(render).join("");
	if (typeof node.type === "function") return render(node.type({ ...node.props, children: node.children }));
	return (node.children ?? []).map(render).join("");
}
/** 展开函数组件后，对每个元素节点调用 visit。 */
function walk(node, visit) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (typeof node === "string" || typeof node === "number") return;
	if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
	visit(node);
	if (typeof node.type === "function") { walk(node.type({ ...node.props, children: node.children }), visit); return; }
	for (const c of node.children ?? []) walk(c, visit);
}

const t = (k, p) => { let s = String(k); if (p) for (const [kk, v] of Object.entries(p)) s += "{" + kk + "=" + v + "}"; return s; };
function draw(state) { STUB_STATE = state ?? null; hookStates = state === undefined ? [] : [state]; hookIndex = 0; effects = []; return Panel({ t, sessionId: "session-x" }); }
/**
 * 把这次渲染记下来的 effect 全部执行一遍（替身没有调度器，默认一个都不跑）。
 * 返回一个 promise，等它们挂起的异步落地。
 */
async function runEffects() {
	const pending = effects.filter((fn) => typeof fn === "function");
	for (const fn of pending) { try { fn(); } catch { /* effect 里抛错在真实 React 里也不该炸测试 */ } }
	await new Promise((r) => setTimeout(r, 0));
}
/**
 * 保留已有 state、只把游标拨回去，用来模拟“setState 之后再渲染一次”。
 * 游标必须在每次调用 Panel 前归零 —— 替身是按数组下标存 hook 的，忘了归零
 * 就会读到错位的 state，渲染出来是一副看起来合理、其实完全无关的面板。
 */
function repaint() { hookIndex = 0; return Panel({ t, sessionId: "session-x" }); }

// ── 场景 ────────────────────────────────────────────────────────────────────
const BASE = {
	version: 3, enabled: true, thresholdRatio: 0.8, minRatio: 0.05, maxRatio: 0.95,
	engines: 8, ownedEngines: 8, headroomTokens: -1e6, headroomConsistent: true,
	contextWindow: 1000000, thresholdTokens: 800000, ratioIsBinding: true,
	triggerBoundBy: "slider", triggerFloorIsRetention: false,
	route: { provider: "deepseek-account", model: "deepseek-v4-pro" },
	providers: [{ id: "deepseek-account", name: "DeepSeek Account" }],
	compacting: false, outputRescue: true
};
/** 主机现在实际会发出来的东西 —— 2.7.4 之后 autoPolicy 里不再有 thresholdRatio。 */
const AUTO_PARAMS = { retainFraction: 0.02, retainMin: 1000, retainMax: 32000, growthFraction: 0.07, growthMin: 2000, growthMax: 100000 };
const AUTO = {
	...BASE, auto: true, autoParams: AUTO_PARAMS,
	// 故意留一组“陈旧”的主机值：拖动时面板必须显示重算后的数，而不是它们。
	autoPolicy: { retainTokens: 8000, growthTokens: 40000 },
	retainRatio: null, retainTokens: null, growthTokens: 0, headTokens: 1504,
	effectiveRatio: 0.6, compactionFloorTokens: 11504, engineRetention: null,
	thresholdTokens: 600000, triggerBoundBy: "growth",
	growthBaselineTokens: 22046, growthTargetTokens: 62046, growthClampedByRetention: false
};

// 每个场景带一句「必须出现在文本里」的期望。只打印字符数等于什么都没断言：把
// `draw()` 里的 state 注入删掉，面板会退化成一堆兜底值（正是当年整块消失的那种形态）
// 而循环照样全绿。
const cases = [
	["自动 · 窗口与基线齐全", AUTO, "autoLine{keep=8K}"],
	["自动 · 窗口未知", { ...AUTO, contextWindow: null, thresholdTokens: null, autoPolicy: null, headTokens: null, effectiveRatio: null, compactionFloorTokens: null, growthBaselineTokens: null, growthTargetTokens: null }, "autoNoWindow"],
	["自动 · 增长被保留卡住", { ...AUTO, retainRatio: 0.16, engineRetention: { retainRatio: 0.16, retainTokens: null }, growthClampedByRetention: true }, "autoLine"],
	["自动 · 未接管（暂停）", { ...AUTO, enabled: false, effectiveRatio: null }, "paused{count=8}"],
	// `ratioIsBinding` 现在说的是「让比值臂必然胜出的那份余量，是不是真在每个被接管的
	// 引擎上」，所以它可以是 false —— 这条把它渲染一遍，顺便挡住那句提示里的异常。
	["自动 · 有引擎没带上本插件那份余量", { ...AUTO, ratioIsBinding: false, headroomConsistent: false }, "notBinding"],
	["手动 · 比例模式", { ...BASE, auto: false, autoPolicy: null, autoParams: null, retainRatio: 0.16, retainTokens: null, growthTokens: 0, headTokens: 1504, effectiveRatio: 0.8, engineRetention: { retainRatio: 0.16, retainTokens: null }, growthBaselineTokens: null, growthTargetTokens: null, growthClampedByRetention: false }, "retainRatioNote{pct=16}"],
	["手动 · 绝对值模式", { ...BASE, auto: false, autoPolicy: null, autoParams: null, retainRatio: null, retainTokens: 5000, growthTokens: 50000, headTokens: 1504, effectiveRatio: 0.072, thresholdTokens: 72000, triggerBoundBy: "growth", compactionFloorTokens: 6504, engineRetention: { retainRatio: null, retainTokens: 5000 }, growthBaselineTokens: 22046, growthTargetTokens: 72046, growthClampedByRetention: false }, "retainTokensNote{kept=5K}"],
	["手动 · 保留未被引擎接受", { ...BASE, auto: false, autoPolicy: null, autoParams: null, retainRatio: null, retainTokens: 5000, growthTokens: 0, headTokens: 1504, effectiveRatio: 0.8, compactionFloorTokens: 6504, engineRetention: { retainRatio: 0.16, retainTokens: null }, growthBaselineTokens: null, growthTargetTokens: null, growthClampedByRetention: false }, "retentionMismatch"],
	["窗口与引擎数都未知", { ...BASE, contextWindow: null, thresholdTokens: null, engines: null, ownedEngines: null, auto: false, autoPolicy: null, autoParams: null, retainRatio: null, retainTokens: null, growthTokens: 0, headTokens: null, effectiveRatio: null, compactionFloorTokens: null, engineRetention: null, growthBaselineTokens: null, growthTargetTokens: null, growthClampedByRetention: false }, "windowUnknown"]
];

let bad = 0;
console.log("\n面板渲染 · " + cases.length + " 个场景");
for (const [name, state, expect] of cases) {
	try {
		const out = render(draw(state));
		const hit = out.includes(expect);
		if (!hit) bad++;
		console.log("  " + (hit ? "✅" : "❌") + " " + name.padEnd(22) + out.length + " 字符，含 " + expect + (hit ? "" : " ← 没找到"));
	} catch (e) {
		bad++;
		console.log("  ❌ " + name.padEnd(22) + e.constructor.name + ": " + e.message);
		console.log("       " + (e.stack.split("\n")[1] ?? "").trim());
	}
}

// ── 回调可调用性 ────────────────────────────────────────────────────────────
// 事件里抛错不会退役槽位，但功能会静默失灵，所以照样要走一遍。
const EVENTS = {
	onChange: { target: { value: "0.62", checked: false }, currentTarget: { value: "0.62" } },
	onMouseUp: { target: { value: "0.62" }, currentTarget: { value: "0.62" } },
	onKeyUp: { target: { value: "0.62" }, currentTarget: { value: "0.62" } },
	onTouchEnd: { target: { value: "0.62" }, currentTarget: { value: "0.62" } },
	onClick: { preventDefault() {}, stopPropagation() {} },
	onBlur: { target: { value: "0.62" } },
	onKeyDown: { key: "Escape", preventDefault() {}, stopPropagation() {} }
};
let badHandlers = 0, handlerCount = 0;
console.log("\n事件回调");
for (const [name, state] of cases) {
	hookIndex = 0; hookStates = [state];
	let tree;
	try { tree = Panel({ t, sessionId: "session-x" }); } catch { continue; }
	const seen = new Set();
	walk(tree, (node) => {
		for (const [key, ev] of Object.entries(EVENTS)) {
			const fn = node.props?.[key];
			if (typeof fn !== "function") continue;
			// 去重键必须能区分同类型的控件。以前只用 `type`，于是两个 range（阈值滑块与
			// 保留比例滑块）、两个 select（provider 与模型）各自塌成一个 id，**每类里后出现
			// 的那个回调从不执行** —— 把它们改成抛错，夹具照样全绿。
			const id = key + ":" + (node.props?.type ?? node.type?.name ?? "?")
				+ ":" + (node.props?.["aria-label"] ?? node.props?.className ?? "?");
			if (seen.has(id)) continue;
			seen.add(id);
			handlerCount++;
			try {
				const r = fn(ev);
				if (r && typeof r.then === "function") r.then(undefined, (e) => { badHandlers++; console.log("  ❌ " + name + " · " + id + " 异步拒绝: " + e.message); });
			} catch (e) {
				badHandlers++;
				console.log("  ❌ " + name + " · " + id + " " + e.constructor.name + ": " + e.message);
			}
		}
	});
}
console.log("  " + (badHandlers === 0 ? "✅ " + handlerCount + " 个回调全部可调用" : "❌ " + badHandlers + " / " + handlerCount + " 个回调抛错"));

// ── 滑块：自动模式必须可拖，拖动后数字必须立刻重算 ──────────────────────────
console.log("\n滑块（自动模式）");
function findSlider(tree) {
	let hit = null;
	walk(tree, (node) => { if (hit === null && node.props?.type === "range") hit = node; });
	return hit;
}
try {
	STUB_STATE = AUTO; hookIndex = 0; hookStates = [AUTO];
	const slider = findSlider(Panel({ t, sessionId: "session-x" }));
	if (slider === null) {
		bad++; console.log("  ❌ 自动模式下没有找到滑块");
	} else {
		console.log("  " + (slider.props.disabled ? "❌" : "✅") + " 自动模式下 disabled = " + slider.props.disabled);
		if (slider.props.disabled) bad++;
		if (slider.props.min !== undefined) {
			const ok = Number(slider.props.min) >= 0.05 - 1e-9;
			console.log("  " + (ok ? "✅" : "❌") + " 最小比例 " + slider.props.min + "（下限 0.05，避免“每轮都压”）");
			if (!ok) bad++;
		}

		STUB_STATE = AUTO; hookIndex = 0; hookStates = [AUTO];
		const before = render(repaint());
		const s2 = findSlider(repaint());
		s2.props.onChange({ target: { value: "0.5" }, currentTarget: { value: "0.5" } });
		const after = render(repaint());
		// W=1e6、比例 0.5 → 阈值 5e5；保留 = 5e5×2% = 10K。陈旧的 8K 若还出现，就说明
		// 预览没接上。增长步长已经没有入口了，面板上不该再出现它的数字。
		const want = ["10K"];
		const stale = ["8K", "40K"];
		const missing = want.filter((w) => !after.includes(w));
		const kept = stale.filter((w) => after.includes(w));
		const moved = before !== after;
		console.log("  " + (moved ? "✅" : "❌") + " 拖动后面板文本发生变化");
		console.log("  " + (missing.length === 0 ? "✅" : "❌") + " 按 0.5 重算为 " + want.join(" / ") + (missing.length ? "，缺 " + missing.join(", ") : ""));
		const noGrowth = !after.includes("growth");
		console.log("  " + (noGrowth ? "✅" : "❌") + " 面板上已经没有任何增长模式残留");
		console.log("     拖动前: " + before.trim());
		console.log("     拖动后: " + after.trim());
		if (!moved || missing.length > 0 || kept.length > 0 || !noGrowth) bad++;
		if (kept.length > 0) console.log("  ❌ 陈旧值仍在显示: " + kept.join(", "));
	}
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

// ── 提交失败：预览值必须让位给主机的真实状态 ───────────────────────────────
//
// `draft` 是「正在拖、还没提交」的唯一标记，面板靠它决定要不要显示按草稿算出来的
// 保留量与触发点。它只在 POST 成功时清空过一次，于是任何一次 4xx/5xx 都会把一次
// 失败伪装成成功：数字看着已经生效，主机其实还是旧值，只有关掉卡片才自愈。
console.log("\n提交失败（自动模式）");
try {
	const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: [] }) });
	const rejectFetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: "invalid-ratio", message: "rejected by host" } }) });
	// 先把前面场景挂起的异步收干净。事件回调清扫那一步已经调过一次滑块的 onMouseUp，
	// 那次提交是成功的、一直挂在微任务里；不先放掉它，它会在下面的 await 处落地并顺手
	// 清掉 draft，让这条断言变得无从分辨。
	await new Promise((r) => setTimeout(r, 0));
	STUB_STATE = AUTO; hookIndex = 0; hookStates = [AUTO];
	globalThis.fetch = okFetch;
	const s1 = findSlider(repaint());
	s1.props.onChange({ target: { value: "0.5" }, currentTarget: { value: "0.5" } });
	const previewed = render(repaint());
	globalThis.fetch = rejectFetch;
	const s2 = findSlider(repaint());
	s2.props.onMouseUp({ target: { value: "0.5" }, currentTarget: { value: "0.5" } });
	await new Promise((r) => setTimeout(r, 0));
	const settled = render(repaint());
	globalThis.fetch = okFetch;

	const showedPreview = previewed.includes("50%");
	const backToHost = settled.includes("80%") && settled.includes("8K");
	const leaked = settled.includes("10K");
	const told = settled.includes("rejected by host");
	console.log("  " + (showedPreview ? "✅" : "❌") + " 拖动期间确实按草稿显示（50%）");
	console.log("  " + (told ? "✅" : "❌") + " 把主机的拒绝原因显示出来");
	console.log("  " + (backToHost ? "✅" : "❌") + " 失败后回到主机的真实值（80% / 8K）");
	console.log("  " + (leaked ? "❌" : "✅") + " 预览值没有留下来冒充已生效的策略");
	console.log("     失败后: " + settled.trim());
	if (!showedPreview || !told || !backToHost || leaked) bad++;
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

// ── 切手动 / 保留方式：点一下就必须落到主机上 ──────────────────────────────
//
// 两个都实际踩到过：
//   1. 「自动」→「手动」把**生效**比例写回了滑块。增长模式在时，滑块写着 80%，生效比例
//      是 0.0846，点一下手动就变成 8%，而且是永久的 —— 面板上没有任何东西提示是它干的。
//   2. 保留方式的三个按钮只改本地状态、从不提交：面板看着切过去了，主机还拿着旧字段，
//      关掉卡片再打开就按主机的值重新推导 —— 只要存过 retainTokens，就永远是「绝对值」。
console.log("\n切手动 / 保留方式");
try {
	await new Promise((r) => setTimeout(r, 0));
	const posts = [];
	// 桩要回显 POST 之后的**主机状态**，而不是一个空数组。
	//
	// 回 `{value: []}` 时 `commitRetention` 成功分支里的 `setState([])` 会让面板立刻
	// 掉回「默认」，于是「关掉卡片再打开模式还在吗」这条根本没法测 —— 补上也会假红。
	// 这里按主机真实的互斥规则回显（命名一个就清另一个）。
	const echoFetch = async (url, init) => {
		const patch = init?.body === undefined ? null : JSON.parse(init.body);
		if (patch !== null) posts.push(patch);
		const value = patch === null ? STUB_STATE : { ...STUB_STATE, ...echoOf(patch) };
		return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
	};
	const echoOf = (patch) => {
		const next = {};
		if (patch.thresholdRatio !== undefined) next.thresholdRatio = patch.thresholdRatio;
		if (patch.auto !== undefined) next.auto = patch.auto;
		if (patch.retainTokens !== undefined) { next.retainTokens = patch.retainTokens; next.retainRatio = null; }
		if (patch.retainRatio !== undefined) { next.retainRatio = patch.retainRatio; if (patch.retainRatio !== null) next.retainTokens = null; }
		return next;
	};
	const findButton = (tree, label) => {
		let hit = null;
		walk(tree, (node) => {
			if (hit !== null || node.props?.type !== "button") return;
			// 夹具的元素节点把子节点放在 `children` 数组里，不在 props 上。
			const text = (node.children ?? []).map((c) => (typeof c === "string" ? c : "")).join("");
			if (text === label) hit = node;
		});
		return hit;
	};
	globalThis.fetch = echoFetch;

	// 增长模式当时把生效比例压到 0.0846，滑块一直写着 0.8。
	const GROWN_DOWN = {
		...BASE, auto: true, autoParams: AUTO_PARAMS, autoPolicy: { retainTokens: 16000 },
		retainRatio: null, retainTokens: 16000, headTokens: 1504, thresholdRatio: 0.8,
		thresholdTokens: 84600, effectiveRatio: 0.0846,
		growthBaselineTokens: 28577, growthTargetTokens: 84577
	};
	posts.length = 0;
	STUB_STATE = GROWN_DOWN; hookIndex = 0; hookStates = [GROWN_DOWN];
	const manual = findButton(Panel({ t, sessionId: "session-x" }), "policy_manual");
	if (manual === null) { bad++; console.log("  ❌ 找不到「手动」按钮"); }
	else {
		manual.props.onClick(EVENTS.onClick);
		await new Promise((r) => setTimeout(r, 0));
		const sent = posts[0] ?? {};
		const froze = sent.auto === false && sent.retainTokens === 16000;
		const leftSlider = !("thresholdRatio" in sent);
		console.log("  " + (froze ? "✅" : "❌") + " 切手动会把自动算出的保留量定下来（16000）");
		console.log("  " + (leftSlider ? "✅" : "❌") + " 切手动不去改写滑块，实际发出 " + JSON.stringify(sent));
		if (!froze || !leftSlider) bad++;
	}

	// 保留方式的每一个按钮都必须提交，否则关掉卡片就会打回原形。
	const TOKENS = { ...BASE, auto: false, autoPolicy: null, autoParams: AUTO_PARAMS, retainRatio: null, retainTokens: 16000, headTokens: 1504, effectiveRatio: 0.8, compactionFloorTokens: 17504 };
	const DEFAULTS = { ...TOKENS, retainTokens: null };
	const modes = [
		{
			from: TOKENS, label: "mode_ratio", want: { retainRatio: 0.16 },
			note: "切换到「比例」会写下一个合法比例",
			reopen: { ...TOKENS, retainTokens: null, retainRatio: 0.16 }, expectMode: "mode_ratio"
		},
		{
			from: TOKENS, label: "mode_default", want: { retainTokens: null },
			note: "切换到「默认」会把两个字段都清掉",
			reopen: { ...TOKENS, retainTokens: null, retainRatio: null }, expectMode: "mode_default"
		},
		{
			from: DEFAULTS, label: "mode_tokens", want: { retainTokens: 16000 },
			note: "切换到「绝对值」会冻结自动值，模式才留得住",
			reopen: { ...DEFAULTS, retainTokens: 16000, retainRatio: null }, expectMode: "mode_tokens"
		}
	];
	for (const item of modes) {
		posts.length = 0;
		STUB_STATE = item.from; hookIndex = 0; hookStates = [item.from];
		const button = findButton(Panel({ t, sessionId: "session-x" }), item.label);
		if (button === null) { bad++; console.log("  ❌ 找不到按钮 " + item.label); continue; }
		button.props.onClick(EVENTS.onClick);
		await new Promise((r) => setTimeout(r, 0));
		const sent = posts[0];
		const ok = sent !== undefined && JSON.stringify(sent) === JSON.stringify(item.want);
		console.log("  " + (ok ? "✅" : "❌") + " " + item.note + "，实际发出 " + JSON.stringify(sent ?? null));
		if (!ok) bad++;

		// 「发出了正确的 POST」不等于「重开还在」。再挂载一次，用回显出来的主机状态
		// 重新推导模式 —— 用户报的第二个 bug 就是这一层，而夹具以前只测了上一层。
		if (item.reopen !== undefined) {
			hookStates = [item.reopen]; hookIndex = 0;
			const reopened = Panel({ t, sessionId: "session-x" });
			const pressed = findButton(reopened, item.expectMode);
			const lit = pressed !== null && pressed.props["aria-pressed"] === true;
			console.log("  " + (lit ? "✅" : "❌") + " 关掉卡片再打开，" + item.expectMode + " 仍然是选中的那个");
			if (!lit) bad++;
		}
	}
	// 窗口未知时点「绝对值」：以前先高亮、再因为算不出值直接 return，一个请求都不发，
	// 关掉卡片又变回「默认」—— 用户报的「模式存不住」还留着这一条路。
	const NO_WINDOW = { ...DEFAULTS, contextWindow: null, thresholdTokens: null, engineRetention: null };
	posts.length = 0;
	STUB_STATE = NO_WINDOW; hookIndex = 0; hookStates = [NO_WINDOW];
	const blind = findButton(Panel({ t, sessionId: "session-x" }), "mode_tokens");
	blind.props.onClick(EVENTS.onClick);
	await new Promise((r) => setTimeout(r, 0));
	const blindTree = repaint();
	const blindPressed = findButton(blindTree, "mode_tokens").props["aria-pressed"] === true;
	const explained = render(blindTree).includes("modeNeedsTokens");
	const nothingSent = posts.length === 0;
	console.log("  " + ((!blindPressed && explained && nothingSent) ? "✅" : "❌")
		+ " 窗口未知又无可冻结的值时：不高亮、不假装、说明原因（发出 " + posts.length + " 个请求）");
	if (blindPressed || !explained || !nothingSent) bad++;

	// 但引擎已经带着一个绝对值时，窗口未知也照样能冻结下来。
	const ENGINE_HAS = { ...NO_WINDOW, engineRetention: { retainRatio: null, retainTokens: 12000 } };
	posts.length = 0;
	STUB_STATE = ENGINE_HAS; hookIndex = 0; hookStates = [ENGINE_HAS];
	findButton(Panel({ t, sessionId: "session-x" }), "mode_tokens").props.onClick(EVENTS.onClick);
	await new Promise((r) => setTimeout(r, 0));
	const froze = posts[0] !== undefined && posts[0].retainTokens === 12000;
	console.log("  " + (froze ? "✅" : "❌") + " 引擎已经带着绝对值时，窗口未知也能冻结成 " + JSON.stringify(posts[0] ?? null));
	if (!froze) bad++;

	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: STUB_STATE }) });
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

// ── 保留量 / 保留方式提交失败：被拒的值不能留在屏幕上 ──────────────────────
//
// `commit`（滑块）早就修过这个：失败时要把 draft 清掉，否则一次 4xx 会变成「显示着一个
// 从没装上去的策略」。`commitRetention` 是同一个模式的另一半，却只在成功时才清 ——
// 于是一次被拒的保留量会一直留在输入框里，一次被拒的模式切换会一直高亮着，
// 而主机还拿着旧的那一对，关掉卡片再打开又打回原形。
console.log("\n提交失败（保留量 / 保留方式）");
try {
	await new Promise((r) => setTimeout(r, 0));
	const rejectFetch = async () => ({
		ok: false, status: 400,
		json: async () => ({ ok: false, error: { code: "invalid-retention", message: "rejected by host" } })
	});
	const findInput = (tree) => {
		let hit = null;
		walk(tree, (node) => {
			if (hit === null && node.props?.type === "number" && node.props["aria-label"] === "retention") hit = node;
		});
		return hit;
	};
	const findModeButton = (tree, label) => {
		let hit = null;
		walk(tree, (node) => {
			if (hit !== null || node.props?.type !== "button") return;
			const text = (node.children ?? []).map((c) => (typeof c === "string" ? c : "")).join("");
			if (text === label) hit = node;
		});
		return hit;
	};
	const stuck = { ...BASE, auto: false, autoPolicy: null, autoParams: AUTO_PARAMS, retainRatio: null, retainTokens: 19000, headTokens: 1504, effectiveRatio: 0.8 };

	// 输入一个会被主机拒掉的数，然后失焦提交。
	hookStates = [stuck]; hookIndex = 0;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: stuck }) });
	const input = findInput(Panel({ t, sessionId: "session-x" }));
	input.props.onChange({ target: { value: "0.62" }, currentTarget: { value: "0.62" } });
	globalThis.fetch = rejectFetch;
	findInput(repaint()).props.onBlur();
	await new Promise((r) => setTimeout(r, 0));
	const afterFail = findInput(repaint());
	const backToHost = afterFail !== null && afterFail.props.value === 19000;
	console.log("  " + (backToHost ? "✅" : "❌") + " 保留量被拒后，输入框回到主机的值 19000（实际 " + (afterFail?.props.value ?? "?") + "）");
	if (!backToHost) bad++;

	// 切模式被拒时，高亮必须跟着回到主机那一侧。
	hookStates = [stuck]; hookIndex = 0;
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: stuck }) });
	const ratioButton = findModeButton(Panel({ t, sessionId: "session-x" }), "mode_ratio");
	globalThis.fetch = rejectFetch;
	ratioButton.props.onClick(EVENTS.onClick);
	await new Promise((r) => setTimeout(r, 0));
	const tokensBtn = findModeButton(repaint(), "mode_tokens");
	const modeReverted = tokensBtn !== null && tokensBtn.props["aria-pressed"] === true;
	console.log("  " + (modeReverted ? "✅" : "❌") + " 模式切换被拒后，「绝对值」重新成为高亮的那一个");
	if (!modeReverted) bad++;

	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: STUB_STATE }) });
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

// ── 触发点归属：滑块是上限，不是触发点 ──────────────────────────────────────
//
// 主机一直在发 `thresholdTokens`（它已经算进增长步长和下限），面板却把它丢掉、拿
// `窗口 × 滑块` 重新算了一遍，于是窗口 1.0M、滑块 80% 时面板写着「触发于 800K」，
// 而引擎实际在 50K 就压了 —— 用户连着看到几次「10% 左右就压缩」，面板一点解释都没有。
// 每一格都是这次事故里的真实数字。
console.log("\n触发点归属（滑块 / 下限）");
try {
	const REAL = {
		...BASE, auto: false, autoPolicy: null, autoParams: null,
		thresholdRatio: 0.8, thresholdTokens: 50000, effectiveRatio: 0.05, minRatio: 0.05,
		retainRatio: null, retainTokens: 4179, growthTokens: 14626, headTokens: 1504,
		compactionFloorTokens: 5683, engineRetention: { retainRatio: null, retainTokens: 4179 },
		growthBaselineTokens: 28577, growthTargetTokens: 43203, growthClampedByRetention: true,
		triggerBoundBy: "floor", triggerFloorIsRetention: false
	};
	hookIndex = 0; hookStates = [REAL];
	const tree = Panel({ t, sessionId: "session-x" });
	const text = render(tree);

	const showsReal = text.includes("triggerFrom{real=50K}{at=800K}{why=whyFloor}");
	const showsCeiling = text.includes("windowMath{window=1.0M}{at=800K}");
	// 增长模式整个下线了：面板里不该再有第二个数字输入框（过去正是它），也不该再出现
	// 「叫用户去改保留方式」那种改不动的建议（真正卡住的是插件自己的 5% 最小值）。
	const numberInputs = [];
	walk(tree, (node) => { if (node.props?.type === "number") numberInputs.push(node.props["aria-label"]); });
	const oneInput = numberInputs.length === 1;
	console.log("  " + (showsReal ? "✅" : "❌") + " 说出实际触发点 50K 与原因是下限");
	console.log("  " + (showsCeiling ? "✅" : "❌") + " 仍然公布滑块上限 800K（上限是真的，不能藏）");
	console.log("  " + (oneInput ? "✅" : "❌") + " 手动模式下只剩一个数字输入框（增长那一行没了），实际 " + numberInputs.join(" / "));
	console.log("     " + text.trim());
	if (!showsReal || !showsCeiling || !oneInput) bad++;

	// 滑块真的说了算时，不能多出一句自相矛盾的提示。
	const PLAIN = { ...REAL, thresholdTokens: 800000, effectiveRatio: 0.8, triggerBoundBy: "slider" };
	hookIndex = 0; hookStates = [PLAIN];
	const plainText = render(Panel({ t, sessionId: "session-x" }));
	const quiet = !plainText.includes("triggerFrom");
	console.log("  " + (quiet ? "✅" : "❌") + " 滑块就是触发点时不多嘴");
	if (!quiet) bad++;
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

// ── 压缩记录：默认折叠 + 每行同一套固定列 ──────────────────────────────────
//
// 记录列表以前默认展开，一打开卡片就是一屏历史；而每行是 `space-between` 的 flex，
// 数字块整块右对齐，左边缘随数字本身的宽度跑，「失败 · …」又落在别的位置。
console.log("\n压缩记录");
try {
	const ROWS = [
		{ at: "2026-10-07T15:30:50.000Z", trigger: "pressure", beforeTokens: 222261, afterTokens: 28577, savedTokens: 193684, model: "deepseek-flash" },
		{ at: "2026-10-07T15:27:03.000Z", trigger: "pressure", beforeTokens: 188382, afterTokens: 194302, savedTokens: null, error: "DeepSeek Messages request aborted" },
		{ at: "2026-10-07T15:12:03.000Z", trigger: "context-overflow", beforeTokens: 89503, afterTokens: 42704, savedTokens: 46799, model: "D:\\llama-b10692-bin\\Swift-1.5-Qwen3.8-27B.gguf" }
	];
	const LOG_STATE = {
		...BASE, auto: false, autoPolicy: null, autoParams: AUTO_PARAMS,
		retainRatio: null, retainTokens: 19000, headTokens: 1504, effectiveRatio: 0.8
	};
	// 钩子按 HOOK 表寻址。留成空洞的下标走各自默认值 —— 这正是「默认折叠」要测的东西。
	const withLog = (open) => { const h = []; h[HOOK.state] = LOG_STATE; h[HOOK.log] = ROWS; h[HOOK.logOpen] = open; return h; };
	// 不预设 `logOpen`：让它走 `useState(false)` 的初值。以前这条断言预设了 false，
	// 于是把源码改成 `useState(true)` 也照样绿 —— 测的是「设成 false 时不渲染」，
	// 不是「默认就是折叠」。
	const freshLog = () => { const h = []; h[HOOK.state] = LOG_STATE; h[HOOK.log] = ROWS; return h; };

	hookStates = freshLog(); hookIndex = 0;
	const shutText = render(Panel({ t, sessionId: "session-x" }));
	const hidden = !shutText.includes("222K") && !shutText.includes("deepseek-flash");
	console.log("  " + (hidden ? "✅" : "❌") + " 默认（不预设 logOpen）就是折起来的（一行都不渲染）");
	if (!hidden) bad++;

	hookStates = withLog(false); hookIndex = 0;
	const explicit = render(Panel({ t, sessionId: "session-x" }));
	console.log("  " + (!explicit.includes("222K") ? "✅" : "❌") + " 显式折叠时也不渲染");
	if (explicit.includes("222K")) bad++;

	hookStates = withLog(true); hookIndex = 0;
	const openTree = Panel({ t, sessionId: "session-x" });
	const openText = render(openTree);
	const showed = openText.includes("222K") && openText.includes("29K") && openText.includes("aborted");
	console.log("  " + (showed ? "✅" : "❌") + " 展开后三行都在（含失败那行）");
	if (!showed) bad++;

	// 成功行必须用同一套固定列；列数一样才谈得上对齐。
	const cols = [];
	let failed = null;
	walk(openTree, (node) => {
		const cls = node.props?.className;
		if (cls === "dcs-val-fail") failed = node;
		if (cls !== "dcs-val") return;
		cols.push((node.children ?? []).map((c) => (c !== null && typeof c === "object" ? c.props?.className : c)).join("|"));
	});
	const uniform = cols.length === 2
		&& cols.every((c) => c === cols[0] && c.includes("dcs-num-before") && c.includes("dcs-saved") && c.includes("dcs-model"));
	console.log("  " + (uniform ? "✅" : "❌") + " 成功行都用同一套固定列：" + (cols.join(" ／ ") || "(一个都没有)"));
	if (!uniform) bad++;

	// 失败行不套数字列，但原文必须留着 —— 它是「这次为什么没压成」的唯一线索。
	const failTidy = failed !== null && failed.props.title === ROWS[1].error;
	console.log("  " + (failTidy ? "✅" : "❌") + " 失败行不带数字列，原因留在 title 上");
	if (!failTidy) bad++;
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

// ── 读取失败：不能把「读不到」说成「没有」 ──────────────────────────────────
//
// `/log` 失败时把结果当空数组，会让面板说「本会话还没有压缩过。」并把已经展开的列表清空，
// 而且每 5 秒重来一次；`/models` 同理，宿主专门返回的 502 理由被丢掉，用户以为该 provider
// 没有模型。两条都要能看见理由，并且不能抹掉手上已有的数据。
console.log("\n读取失败（/log、/models）");
try {
	const DRows = [{ at: "2026-10-07T15:30:50.000Z", trigger: "pressure", beforeTokens: 222261, afterTokens: 28577, savedTokens: 193684, model: "deepseek-flash" }];
	const DSTATE = { ...BASE, auto: false, autoPolicy: null, autoParams: AUTO_PARAMS, retainRatio: null, retainTokens: 19000, headTokens: 1504, effectiveRatio: 0.8 };
	const routes = (opts) => async (url) => {
		if (String(url).includes("/log")) return opts.log();
		if (String(url).includes("/models")) return opts.models();
		return { ok: true, status: 200, json: async () => ({ ok: true, value: DSTATE }) };
	};
	const rejectLog = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: { message: "log down" } }) });
	const rejectModels = async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: { message: "provider exploded" } }) });
	const okWith = (entries) => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { entries, total: entries.length, limit: 200 } }) });

	// 先有一次成功读取（列表里有内容），随后轮询失败：内容必须留着。
	globalThis.fetch = routes({ log: okWith(DRows), models: rejectModels });
	hookStates = []; hookStates[HOOK.state] = DSTATE; hookStates[HOOK.logOpen] = true; hookIndex = 0; effects = [];
	Panel({ t, sessionId: "session-x" });
	await runEffects();
	const good = render(repaint());
	const hadRow = good.includes("222K");

	globalThis.fetch = routes({ log: rejectLog, models: rejectModels });
	hookIndex = 0; effects = [];
	Panel({ t, sessionId: "session-x" });
	await runEffects();
	const afterFail = render(repaint());
	const keptRow = afterFail.includes("222K");
	const saidWhy = afterFail.includes("logFailedRead{why=log down}");
	const lied = afterFail.includes("logEmpty");
	console.log("  " + (hadRow ? "✅" : "❌") + " 成功那次确实读到了记录");
	console.log("  " + (keptRow ? "✅" : "❌") + " /log 失败后列表内容没有被清空");
	console.log("  " + (saidWhy ? "✅" : "❌") + " /log 失败的原因被显示出来");
	console.log("  " + (lied ? "❌" : "✅") + " 没有把「读不到」说成「还没有压缩过」");
	const modelsSaid = afterFail.includes("modelsFailed{why=provider exploded}");
	console.log("  " + (modelsSaid ? "✅" : "❌") + " /models 失败也把宿主的理由显示出来");
	if (!hadRow || !keptRow || !saidWhy || lied || !modelsSaid) bad++;

	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: STUB_STATE }) });
} catch (e) {
	bad++;
	console.log("  ❌ " + e.constructor.name + ": " + e.message);
	console.log("     " + (e.stack.split("\n")[1] ?? "").trim());
}

console.log("\n" + (bad === 0 && badHandlers === 0 ? "全部通过 ✅" : bad + badHandlers + " 项失败 ❌"));
process.exit(bad === 0 && badHandlers === 0 ? 0 : 1);
