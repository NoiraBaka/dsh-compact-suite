/**
 * The compress panel must live on <body>, not inside the composer.
 *
 * Two host behaviours break an in-place panel and neither is visible from the
 * plugin's own code:
 *
 *   1. DSH 0.2.2 gives the composer seat `will-change: transform`, which makes
 *      it the containing block for `position: fixed` descendants. The panel's
 *      coordinates are viewport-based, so they get re-anchored to that seat and
 *      the panel lands in the page's bottom-right corner
 *      (NoiraBaka/dsh-compact-suite#2).
 *   2. Any ancestor stacking context — a theme painting the composer card with
 *      `z-index` / `isolation` is enough — caps the panel's `z-index` at that
 *      ancestor's layer, so the panel can be drawn under page content.
 *
 * A portal to `document.body` fixes both, and it brings one requirement of its
 * own: the panel is no longer a DOM descendant of the wrapper, so the
 * outside-click dismissal has to treat BOTH subtrees as "inside" or the panel
 * closes on its own first click.
 *
 * Run: node test/panel-portal.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, "..", "lib", "client.js");
const SOURCE = readFileSync(CLIENT, "utf8");

let failures = 0;
function check(name, ok, detail) {
	const line = "  " + (ok ? "\u2705" : "\u274c") + " " + name + (detail === undefined ? "" : "\u3000" + detail);
	console.log(line);
	if (!ok) failures++;
}

// \u2500\u2500 React stub \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let hookStates = [];
let hookIndex = 0;
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

// \u2500\u2500 portal stub: records the target and keeps the node reachable \u2500\u2500\u2500
const portals = [];
const ReactDOM = {
	createPortal(node, container) {
		portals.push({ node, container });
		return { type: "portal", props: { container }, children: [node] };
	}
};

// \u2500\u2500 DOM stub \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const listeners = new Map();
const body = { id: "document-body" };
globalThis.Node = class Node {};
globalThis.window = {
	__ModuleLoader__: { load(m) { globalThis.__mod = m; } },
	localStorage: { getItem: () => null, setItem() {} },
	addEventListener() {}, removeEventListener() {}
};
globalThis.document = {
	body,
	createElement: () => ({ setAttribute() {}, remove() {} }),
	head: { appendChild() {} },
	addEventListener(type, fn) { listeners.set(type, fn); },
	removeEventListener(type) { listeners.delete(type); }
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) });

const primitives = { useAnchoredPosition() { hookIndex++; return { left: 12, top: 34 }; } };
const myRequire = (n) => n === "react" ? React
	: n === "react-dom" ? ReactDOM
		: n === "@deepseek-ai/dsh-client-ui-primitives" ? primitives
			: (() => { throw new Error("require " + n); })();

await import("file:///" + CLIENT.replace(/\\/g, "/"));
const mod = globalThis.__mod.factory(myRequire);

let Chip = null;
mod.apply({
	effect(fn) { try { fn(); } catch { /* the stylesheet stub is not the subject */ } },
	locale: { register() { return () => {}; }, bind: () => (k) => k },
	slots: { inject(_n, cb) { cb(); }, register(_o, C) { Chip = C; return () => {}; } }
});
check("the composer slot registered a chip", typeof Chip === "function");

// open: CompactChip's first hook is `useState(false)`; refs follow, in order
// triggerRef, panelRef, wrapRef.
hookStates = [true];
hookIndex = 0;
effects = [];
const tree = Chip({ t: (k) => k, sessionId: "s" });

/** depth-first search for an element whose className contains `needle`. */
function find(node, needle) {
	if (node === null || typeof node !== "object") return null;
	if (Array.isArray(node)) { for (const n of node) { const r = find(n, needle); if (r !== null) return r; } return null; }
	if (typeof node.type === "function") return find(node.type({ ...node.props, children: node.children }), needle);
	if (typeof node.props?.className === "string" && node.props.className.includes(needle)) return node;
	for (const c of node.children ?? []) { const r = find(c, needle); if (r !== null) return r; }
	return null;
}
/** Drop portal nodes: what is left is the tree that actually renders in place. */
function withoutPortals(node) {
	if (node === null || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map(withoutPortals);
	if (node.type === "portal") return null;
	if (typeof node.type === "function") return withoutPortals(node.type({ ...node.props, children: node.children }));
	return { ...node, children: (node.children ?? []).map(withoutPortals).filter((c) => c !== null) };
}

check("an open panel was portaled exactly once", portals.length === 1, String(portals.length));
check("the portal target is <body>, not the composer",
	portals.length === 1 && portals[0].container === body,
	portals.length === 1 ? String(portals[0].container === body) : "n/a");

const wrap = find(tree, "dcs-wrap");
check("the chip still renders its own wrapper in the slot", wrap !== null);
check("the panel is not painted inside the wrapper",
	find(withoutPortals(tree), "dcs-panel") === null);

const shell = portals.length === 1 ? portals[0].node : null;
check("the portaled node is the panel shell", shell !== null && typeof shell.props?.style === "object");
check("the shell is position:fixed", shell?.props?.style?.position === "fixed");
check("zIndex is on the host's portaled-menu layer (>= 1000)",
	typeof shell?.props?.style?.zIndex === "number" && shell.props.style.zIndex >= 1000,
	String(shell?.props?.style?.zIndex));
check("the anchored coordinates are forwarded untouched",
	shell?.props?.style?.left === 12 && shell?.props?.style?.top === 34,
	shell?.props?.style?.left + "/" + shell?.props?.style?.top);

// \u2500\u2500 dismissal: a click ON the panel must not close it \u2500\u2500\u2500\u2500\u2500\u2500
let effectFn = null;
for (const fn of effects) if (typeof fn === "function") effectFn = fn;
if (effectFn !== null) effectFn();
const onDown = listeners.get("mousedown");
check("the dismissal effect registered a mousedown listener", typeof onDown === "function");

// The three refs the effect reads: hookStates[1..3] (open occupies [0]).
// The handler ignores anything that is not a real node (synthetic events from
// other scripts): both targets must be `instanceof Node` to reach the guards.
const insideTarget = Object.assign(new globalThis.Node(), { where: "inside" });
const outsideTarget = Object.assign(new globalThis.Node(), { where: "outside" });
// Mutate `.current` on the ref objects the component captured: the effect
// closed over those objects, so replacing entries in hookStates would not be
// seen by the handler.
hookStates[2].current = { contains: (t) => t === insideTarget };        // panelRef
hookStates[3].current = { contains: () => false };                     // wrapRef
hookStates[0] = true;
onDown({ target: insideTarget });
check("a mousedown inside the portaled panel keeps it open", hookStates[0] === true, String(hookStates[0]));
onDown({ target: outsideTarget });
check("a mousedown outside both subtrees dismisses it", hookStates[0] === false, String(hookStates[0]));

// \u2500\u2500 the inline fallback must survive hosts without react-dom \u2500\u2500\u2500
check("react-dom is resolved defensively, not assumed",
	/try \{ ReactDOM = require\("react-dom"\); \} catch/.test(SOURCE));
check("a host without react-dom falls back to an inline panel",
	/panel === null \? null : \(canPortal \? createPortal\(panel, document\.body\) : panel\)/.test(SOURCE));

console.log("");
if (failures === 0) {
	console.log("\u5168\u90e8\u901a\u8fc7\uff0814 \u9879\u65ad\u8a00\uff09");
} else {
	console.log(failures + " \u9879\u5931\u8d25");
	process.exit(1);
}
