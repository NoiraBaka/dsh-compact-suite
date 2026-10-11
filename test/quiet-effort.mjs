/**
 * 摘要调用「省思考」的回归夹具。
 *
 * 与 host-policy.mjs 同一套路：从 `lib/index.js` 里按名字抽出**真正的**函数与常量，
 * 装进 `new Function` 作用域里跑，断言的对象就是会被发布出去的那段代码。
 *
 * 钉住的是两条性质，它们各自都有很容易被抄错的做法：
 *
 *   1. 档位**必须**先问 `llm.resolveCallConfig` 再写。`ReasoningEffortId` 是 adapter
 *      私有的不透明字符串，没有跨 adapter 词表；`dsh-llm` 会拿它比对该模型的能力，
 *      不在集合里就在发起任何 provider I/O 之前抛 `UNSUPPORTED_REASONING_EFFORT`，
 *      **整个压缩事务随之失败**（@falling-ts/dsh-force-compact 记录过一次真实事故：
 *      连续 15 次失败、零个 checkpoint）。所以硬写字面量 `'off'` 是错的。
 *   2. 结论不确定时**什么都不写**。能力查询本身报错（不是"这一档不接受"）时，我们
 *      无从判断，宁可不省这点 token，也不能让压缩挂掉。
 *
 * 用法：
 *   node test/quiet-effort.mjs [要检查的 lib/index.js 路径]
 *
 * 传入一份硬写 `'off'`、或"查询失败也照写"的实现时应当**失败**——这正是它的意义。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(here, "..", "lib", "index.js");
const source = readFileSync(target, "utf8");

// ── 从源码里取真货 ─────────────────────────────────────────────────────────

function sliceFunction(text, name) {
	let at = text.indexOf(`function ${name}(`);
	if (at < 0) throw new Error(`夹具找不到 function ${name}`);
	// `async function` 也包含 `function <name>(`，但切片要从 `async` 起，否则抽出来的
	// 函数体会带着 await 却不再是 async —— 装进 new Function 立刻语法错误。
	if (text.slice(at - 6, at) === "async ") at -= 6;
	const open = text.indexOf("{", at);
	if (open < 0) throw new Error(`夹具找不到 function ${name} 的函数体`);
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return text.slice(at, i + 1);
		}
	}
	throw new Error(`function ${name} 的大括号不平衡`);
}

function sliceDeclaration(text, name) {
	const re = new RegExp(`^(?:const|let|var)\\s+${name}\\s*=`, "m");
	const match = re.exec(text);
	if (match === null) throw new Error(`夹具找不到声明 ${name}`);
	const semi = text.indexOf(";", match.index);
	if (semi < 0) throw new Error(`声明 ${name} 没有结尾分号`);
	return text.slice(match.index, semi + 1);
}

const DECLARATIONS = [
	"QUIET_EFFORT",
	"EFFORT_LADDER",
	"quietEffortByRoute",
	"quietEffortPending",
	"quietEffortWarned",
	"reroutedFor"
];
const FUNCTIONS = [
	"isUnsupportedEffort",
	"quietEffortKey",
	"acceptsEffort",
	"resolveQuietEffort",
	"quietEffortOf",
	"installCompactRouter"
];

const pieces = [];
for (const name of DECLARATIONS) pieces.push(sliceDeclaration(source, name));
for (const name of FUNCTIONS) pieces.push(sliceFunction(source, name));

const body = `
${pieces.join("\n")}
return {
	QUIET_EFFORT,
	EFFORT_LADDER,
	quietEffortByRoute,
	quietEffortPending,
	reroutedFor,
	acceptsEffort,
	resolveQuietEffort,
	quietEffortOf,
	installCompactRouter,
	extracted: ${JSON.stringify(FUNCTIONS)},
	reset: () => {
		quietEffortByRoute.clear();
		quietEffortPending.clear();
		quietEffortWarned.clear();
		reroutedFor.clear();
	}
};
`;

const scope = new Function(body)();

// ── 断言小工具 ─────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(label, ok, detail = "") {
	if (ok) {
		passed++;
		console.log(`  ✅ ${label}${detail ? "　" + detail : ""}`);
	} else {
		failures.push(label);
		console.log(`  ❌ ${label}${detail ? "　" + detail : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// ── 假 ctx ─────────────────────────────────────────────────────────────────

/** The LLM service's own "this route has no such effort" rejection. */
function unsupportedEffort(effort) {
	const error = new Error(`provider "p" model "m" does not support reasoning effort "${effort}"`);
	error.code = "UNSUPPORTED_REASONING_EFFORT";
	return error;
}

/**
 * Build a ctx whose `llm.resolveCallConfig` answers from a route table.
 *
 * A route value is `{ accepted: [...] }` to model a real capability set, or
 * `{ broken: true }` to model a lookup that fails for a reason that is NOT an
 * effort rejection. An absent route rejects every effort.
 * @param routes - `provider/model` → route spec.
 * @param record - receives every `llm.stream` options object.
 */
function makeCtx(routes, record) {
	const asked = [];
	const listeners = [];
	const warnings = [];
	const ctx = {
		logger: {
			warn(message) {
				warnings.push(message);
			}
		},
		llm: {
			resolveCallConfig(config) {
				const key = `${config.provider}/${config.model}`;
				asked.push(`${key}:${config.reasoningEffort}`);
				const spec = routes[key];
				if (spec === undefined) return Promise.reject(unsupportedEffort(config.reasoningEffort));
				if (spec.broken === true) return Promise.reject(new Error("capability lookup exploded"));
				if (spec.accepted.includes(config.reasoningEffort)) return Promise.resolve(config);
				return Promise.reject(unsupportedEffort(config.reasoningEffort));
			},
			stream(options) {
				record.push(options);
				return { streamed: options };
			}
		},
		on(event, handler, opts) {
			listeners.push({ event, handler, opts });
			return () => {};
		}
	};
	return { ctx, asked, listeners, warnings };
}

function handlerOf(listeners) {
	const entry = listeners.find((item) => item.event === "llm/stream");
	if (entry === undefined) throw new Error("夹具没有拿到 llm/stream 监听器");
	return entry.handler;
}

/** Wire a router whose quiet reader resolves lazily, exactly as apply() does. */
function wire(ctx, routeOf, preferred = "") {
	return scope.installCompactRouter(ctx, routeOf,
		(provider, model) => scope.quietEffortOf(ctx, provider, model, preferred));
}

const compaction = (extra = {}) => ({ purpose: "compaction", provider: "p", model: "m", ...extra });

console.log("夹具：摘要调用的省思考档位");

// ── 1. 兼容字段的判定语义 ──────────────────────────────────────────────────

section("1. QUIET_EFFORT 只认“完全关闭”语义");

check("导出了 QUIET_EFFORT", scope.QUIET_EFFORT instanceof RegExp);
for (const id of ["off", "none", "disabled", "no-thinking", "no_thinking", "no thinking", "Off", "NONE"]) {
	check(`命中 ${JSON.stringify(id)}`, scope.QUIET_EFFORT.test(id));
}
for (const id of ["low", "medium", "high", "minimal", "on", "default", "auto", "buffet", "offshore"]) {
	check(`不误伤 ${JSON.stringify(id)}`, !scope.QUIET_EFFORT.test(id));
}
check("阶梯按代价升序，off 在首位", scope.EFFORT_LADDER[0] === "off",
	`ladder=${JSON.stringify(scope.EFFORT_LADDER)}`);

// ── 2. 没有硬写字面量，兼容字段只有一个受控出口 ────────────────────────────

section("2. 源码里没有任何硬写的档位字面量");

const hardcoded = /reasoningEffort\s*[:=]\s*["'`]/.exec(source);
check("没有 reasoningEffort: \"…\" 这样的字面量赋值", hardcoded === null,
	hardcoded === null ? "" : `出现在第 ${source.slice(0, hardcoded.index).split("\n").length} 行`);

// `(?!=)` 排除 `options.reasoning_effort === compat` 这种比较，只留真正的赋值。
const compatAssignments = [...source.matchAll(/reasoning_effort\s*=(?!=)\s*([^;\n]+)/g)].map((m) => m[1].trim());
check("reasoning_effort 只有一处赋值", compatAssignments.length === 1,
	`找到 ${compatAssignments.length} 处：${JSON.stringify(compatAssignments)}`);
check("且赋的是受门控的变量，不是字面量", compatAssignments[0] === "compat" && source.includes("QUIET_EFFORT.test(effort)"));

// ── 3. 非压缩调用一律放行 ──────────────────────────────────────────────────

section("3. 只有 purpose === 'compaction' 才介入");

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({}, record);
	let nextCalls = 0;
	wire(ctx, () => ({ provider: "x", model: "y" }));
	const handler = handlerOf(listeners);
	const result = handler({ purpose: "session-title", provider: "p", model: "m" }, () => ++nextCalls);
	check("非压缩调用走 next()", nextCalls === 1);
	check("非压缩调用没有 stream()", record.length === 0);
	check("非压缩调用原样返回 next() 的结果", result === 1);
	await settle();
	check("非压缩调用没有去查能力", record.length === 0);
}

// ── 4. 冷路由先放行，解析完成后带字段重发 ──────────────────────────────────

section("4. 冷路由先放行，不阻塞也不报错");

{
	scope.reset();
	const record = [];
	const routes = { "p/m": { accepted: ["off", "low", "high"] } };
	const { ctx, asked, listeners } = makeCtx(routes, record);
	let nextCalls = 0;
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);

	handler(compaction(), () => ++nextCalls);
	check("第一次调用走 next()（不猜档位）", nextCalls === 1);
	check("第一次调用没有 stream()", record.length === 0);

	await settle();
	check("已经拿 resolveCallConfig 探过", asked.includes("p/m:off"), `asked=${JSON.stringify(asked)}`);
	check("解析结果被缓存", scope.quietEffortOf(ctx, "p", "m") === "off");

	handler(compaction(), () => ++nextCalls);
	check("第二次调用改走 stream()", record.length === 1);
	check("带上 camelCase 档位", record[0]?.reasoningEffort === "off");
	check("并带上 llama.cpp 兼容字段", record[0]?.reasoning_effort === "none");
	check("其余字段保持不变", record[0]?.purpose === "compaction" && record[0]?.provider === "p");
	check("options 被冻结", Object.isFrozen(record[0]));
}

// ── 5. 'none' 也算完全关闭 ─────────────────────────────────────────────────

section("5. 路由只认 'none' 时照样发兼容字段");

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({ "p/m": { accepted: ["none"] } }, record);
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => {});
	await settle();
	handler(compaction(), () => {});
	check("探到的是 'none'", scope.quietEffortOf(ctx, "p", "m") === "none");
	check("camelCase 用 'none'", record[0]?.reasoningEffort === "none");
	check("兼容字段也照发", record[0]?.reasoning_effort === "none");
}

// ── 6. 阶梯降级：能省则省，但不冒充"关闭" ──────────────────────────────────

section("6. 无法关闭时降到最便宜的可接受档，且不发兼容字段");

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({ "p/m": { accepted: ["high", "low"] } }, record);
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => {});
	await settle();
	handler(compaction(), () => {});
	check("降到 'low'（阶梯里更便宜的那个）", scope.quietEffortOf(ctx, "p", "m") === "low");
	check("camelCase 用 'low'", record[0]?.reasoningEffort === "low");
	check("不发兼容字段（既没被要求“关”，就不该被要求 none）",
		record[0]?.reasoning_effort === undefined);
}

// ── 7. 安全性质：该模型不支持推理时绝不写字段 ──────────────────────────────

section("7. 路由一个档位都不接受时，绝不写 reasoningEffort");

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({ "p/m": { accepted: [] } }, record);
	let nextCalls = 0;
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => ++nextCalls);
	await settle();
	handler(compaction(), () => ++nextCalls);
	check("始终走 next()", nextCalls === 2, `nextCalls=${nextCalls}`);
	check("一次都没有 stream()", record.length === 0);
	check("缓存结论是 null", scope.quietEffortOf(ctx, "p", "m") === null);
}

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({}, record);
	let nextCalls = 0;
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => ++nextCalls);
	await settle();
	handler(compaction(), () => ++nextCalls);
	check("路由未知时同样 no-op", nextCalls === 2 && record.length === 0,
		`nextCalls=${nextCalls} stream=${record.length}`);
}

// ── 8. 安全性质：查询本身失败时必须放弃 ────────────────────────────────────

section("8. 能力查询抛非档位错误时，结论不成立，什么都不写");

{
	scope.reset();
	const record = [];
	const { ctx, listeners, warnings } = makeCtx({ "p/m": { broken: true } }, record);
	let nextCalls = 0;
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => ++nextCalls);
	await settle();
	handler(compaction(), () => ++nextCalls);
	check("查询炸了也走 next()", nextCalls === 2, `nextCalls=${nextCalls}`);
	check("查询炸了没有 stream()", record.length === 0);
	check("并且说明了原因", warnings.some((text) => text.includes("could not probe")),
		`warnings=${JSON.stringify(warnings)}`);
}

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({}, record);
	delete ctx.llm.resolveCallConfig;
	let nextCalls = 0;
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => ++nextCalls);
	await settle();
	handler(compaction(), () => ++nextCalls);
	check("旧宿主没有能力查询时也 no-op", nextCalls === 2 && record.length === 0,
		`nextCalls=${nextCalls} stream=${record.length}`);
}

// ── 9. 二次进入必须收敛 ────────────────────────────────────────────────────

section("9. 重入一次即收敛，不会递归");

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({ "p/m": { accepted: ["off"] } }, record);
	wire(ctx, () => undefined);
	const handler = handlerOf(listeners);
	handler(compaction(), () => {});
	await settle();

	let nested = 0;
	handler(compaction(), () => { nested++; });           // 这一次会重发并带上两个字段
	const patched = record[0];
	const again = handler({ ...patched }, () => { nested++; return "NEXT-RESULT"; });
	check("第二次经过时直接 next()", nested === 1, `nested=${nested}`);
	check("没有再次 stream()", record.length === 1, `stream 调用=${record.length}`);
	check("重入不吞掉 next() 的返回值", again === "NEXT-RESULT", `again=${JSON.stringify(again)}`);
}

// ── 10. 路由改写不能被破坏 ─────────────────────────────────────────────────

section("10. 原有的路由改写行为保持不变");

{
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({ "cloud/flash": { accepted: ["off"] } }, record);
	let nextCalls = 0;
	wire(ctx, () => ({ provider: "cloud", model: "flash" }));
	const handler = handlerOf(listeners);

	handler(compaction({ sessionId: "s1" }), () => ++nextCalls);
	check("路由立即生效：第一次就 stream()", record.length === 1);
	check("第一次只改写路由、不猜档位", record[0]?.provider === "cloud"
		&& record[0]?.model === "flash"
		&& record[0]?.reasoningEffort === undefined);

	await settle();
	handler(compaction({ sessionId: "s1" }), () => ++nextCalls);
	check("第二次带上档位与兼容字段", record.length === 2
		&& record[1]?.reasoningEffort === "off"
		&& record[1]?.reasoning_effort === "none");
	check("记下了该会话的实际去向", scope.reroutedFor.get("s1")?.model === "flash");

	record.length = 0;
	const before = nextCalls;
	handler(compaction({ provider: "cloud", model: "flash", sessionId: "s1", reasoningEffort: "off", reasoning_effort: "none" }),
		() => ++nextCalls);
	check("目标与两个字段都已就位时直接 next()", record.length === 0 && nextCalls === before + 1);
}

// ── 11. 非 DeepSeek adapter：显式指定档位 ──────────────────────────────────

section("11. 显式指定档位，给档位名不在阶梯里的 adapter 用");

{
	// 该 adapter 的档位 id 完全不透明（"0"），名字是中文，阶梯一个都不匹配。
	scope.reset();
	const record = [];
	const { ctx, listeners } = makeCtx({ "local/qwen3": { accepted: ["0", "2"] } }, record);
	wire(ctx, () => ({ provider: "local", model: "qwen3" }), "0");
	const handler = handlerOf(listeners);
	handler(compaction({ sessionId: "s2" }), () => {});
	await settle();
	check("阶梯外的模型：默认探测只能降级", scope.quietEffortOf(ctx, "local", "qwen3") === null);
	check("显式指定后命中 id \"0\"", scope.quietEffortOf(ctx, "local", "qwen3", "0") === "0");
	handler(compaction({ sessionId: "s2" }), () => {});
	check("改写后带上指派的档位", record.at(-1)?.reasoningEffort === "0");
	check("'0' 不算完全关闭 → 不发兼容字段", record.at(-1)?.reasoning_effort === undefined);
}

{
	// 指定的 id 该路由不接受：必须退回阶梯，而不是把它写下去。
	scope.reset();
	const record = [];
	const { ctx, listeners, warnings } = makeCtx({ "p/m": { accepted: ["off"] } }, record);
	wire(ctx, () => undefined, "thinking-disabled");
	const handler = handlerOf(listeners);
	handler(compaction(), () => {});
	await settle();
	check("未公布的指定值退回阶梯", scope.quietEffortOf(ctx, "p", "m", "thinking-disabled") === "off");
	check("并且记了一条警告", warnings.some((text) => text.includes("thinking-disabled")),
		`warnings=${JSON.stringify(warnings)}`);
	handler(compaction(), () => {});
	check("写下去的是被接受的 id", record.at(-1)?.reasoningEffort === "off");
}

{
	// 指定值无效，且该路由一个档位都不接受：只能什么都不做，并说清原因。
	scope.reset();
	const record = [];
	const { ctx, listeners, warnings } = makeCtx({ "p/m": { accepted: [] } }, record);
	let nextCalls = 0;
	wire(ctx, () => undefined, "nope");
	const handler = handlerOf(listeners);
	handler(compaction(), () => ++nextCalls);
	await settle();
	handler(compaction(), () => ++nextCalls);
	check("指定值无效且无可接受档位时仍是 no-op", nextCalls === 2 && record.length === 0,
		`nextCalls=${nextCalls} stream=${record.length}`);
	check("警告里说明了没有更便宜的档位",
		warnings.some((text) => text.includes("no cheaper level")),
		`warnings=${JSON.stringify(warnings)}`);
}

{
	// 不同指定值必须各算各的，不能互相命中缓存。
	scope.reset();
	const record = [];
	const { ctx } = makeCtx({ "p/m": { accepted: ["0", "1"] } }, record);
	scope.quietEffortOf(ctx, "p", "m", "0");
	scope.quietEffortOf(ctx, "p", "m", "1");
	await settle();
	check("指定值不同则结果不同", scope.quietEffortOf(ctx, "p", "m", "0") === "0"
		&& scope.quietEffortOf(ctx, "p", "m", "1") === "1");
}

// ── 12. 夹具抽的是真货 ─────────────────────────────────────────────────────

section("12. 夹具抽的是真货");

for (const name of FUNCTIONS) {
	const count = source.split(`function ${name}(`).length - 1;
	check(`${name} 在源文件里只声明了一次`, count === 1, `找到 ${count} 次`);
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
	console.log(`全部通过　（${passed} 项断言）`);
} else {
	console.log(`失败 ${failures.length} 项 / 共 ${passed + failures.length} 项：`);
	for (const label of failures) console.log(`  · ${label}`);
	process.exitCode = 1;
}
