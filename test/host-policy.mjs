/**
 * 宿主半边的回归夹具。
 *
 * 它不重写逻辑：从 `lib/index.js` 里按名字抽出**真正的**那几个函数
 * （`autoPolicy` / `resolvePolicy` / `ratioFloor` / `currentThresholdRatio`）和它们依赖的
 * 模块级常量与映射，装进一个 `new Function` 作用域里跑。这样夹具断言的断言对象就是
 * 会被发布出去的那段代码，而不是它的复制品。
 *
 * 钉住的核心约束只有一条，但它出过一次真事故：
 *
 *   引擎的 `resolveCompactSpec` 在 `retainTokens >= thresholdTokens` 时对**每一次**决策
 *   抛 `TargetPressureConfigError`，而引擎只在第一次 `warn`，之后静默。于是「保留量追平
 *   阈值」在界面上完全看不出来，表现却是自动压缩永久失效，连溢出恢复一起挂。
 *
 * 用法：
 *   node test/host-policy.mjs [要检查的 lib/index.js 路径]
 *
 * 传入旧版本文件时应当**失败**——这正是它存在的意义。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(here, "..", "lib", "index.js");
const source = readFileSync(target, "utf8");

// ── 从源码里取真货 ─────────────────────────────────────────────────────────

function sliceFunction(text, name) {
	const at = text.indexOf(`function ${name}(`);
	if (at < 0) throw new Error(`夹具找不到 function ${name}`);
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

const CONSTANTS = [
	"MIN_RATIO",
	"MIN_SLIDER_RATIO",
	"MAX_RATIO",
	"FALLBACK_RATIO",
	"RETENTION_MARGIN_TOKENS",
	"DEFAULT_RETAIN_RATIO",
	"STATE_VERSION",
	"OWNED_BY_SUITE",
	"AUTO_RETAIN_FRACTION",
	"AUTO_RETAIN_MIN",
	"AUTO_RETAIN_MAX",
	"AUTO_GROWTH_FRACTION",
	"AUTO_GROWTH_MIN",
	"AUTO_GROWTH_MAX"
];
// 旧版本里可能存在、新版本里已删除的常量：有就带上，没有就跳过。
const OPTIONAL_CONSTANTS = ["MIN_RATIO_ABS"];
const STATE = [
	"currentRatio",
	"currentAuto",
	"currentEnabled",
	"currentRoute",
	"currentRetainRatio",
	"currentRetainTokens",
	"currentGrowthTokens",
	"resolvedThresholdRatio",
	"resolvedRetainRatio",
	"resolvedRetainTokens",
	"resolvedGrowthTokens",
	"activeSessionId",
	"contextWindowById",
	"headTokensById",
	"lastAfterById",
	"manualCompactions",
	"outputRescueActive"
];
const FUNCTIONS = [
	"autoPolicy",
	"resolvePolicy",
	"ratioFloor",
	"currentThresholdRatio",
	"effectiveRatio",
	"validateRatio",
	"statePayload"
];

const pieces = [];
for (const name of CONSTANTS) pieces.push(sliceDeclaration(source, name));
for (const name of OPTIONAL_CONSTANTS) {
	try {
		pieces.push(sliceDeclaration(source, name));
	} catch {
		// 新版本删掉了，正常。
	}
}
for (const name of STATE) pieces.push(sliceDeclaration(source, name));
for (const name of FUNCTIONS) pieces.push(sliceFunction(source, name));

const body = `
let __engines = [];
function compactionEngines() { return __engines; }
${pieces.join("\n")}
return {
	autoPolicy,
	resolvePolicy,
	ratioFloor,
	currentThresholdRatio,
	effectiveRatio,
	validateRatio,
	statePayload,
	/** 被抽取的函数名，用来核对「抽到的是生效的那一份」。 */
	extracted: ${JSON.stringify(FUNCTIONS)},
	constants: { ${CONSTANTS.join(", ")} },
	load: (patch) => {
		if (patch.engines !== undefined) __engines = patch.engines;
		if (patch.currentRatio !== undefined) currentRatio = patch.currentRatio;
		if (patch.currentAuto !== undefined) currentAuto = patch.currentAuto;
		if (patch.currentEnabled !== undefined) currentEnabled = patch.currentEnabled;
		if (patch.currentRetainRatio !== undefined) currentRetainRatio = patch.currentRetainRatio;
		if (patch.currentRetainTokens !== undefined) currentRetainTokens = patch.currentRetainTokens;
		if (patch.currentGrowthTokens !== undefined) currentGrowthTokens = patch.currentGrowthTokens;
		if (patch.activeSessionId !== undefined) activeSessionId = patch.activeSessionId;
		if (patch.windows !== undefined) {
			contextWindowById.clear();
			for (const [key, value] of Object.entries(patch.windows)) contextWindowById.set(key, value);
		}
		if (patch.lasts !== undefined) {
			lastAfterById.clear();
			for (const [key, value] of Object.entries(patch.lasts)) lastAfterById.set(key, value);
		}
		if (patch.heads !== undefined) {
			headTokensById.clear();
			for (const [key, value] of Object.entries(patch.heads)) headTokensById.set(key, value);
		}
	},
	read: () => ({
		currentRatio,
		activeSessionId,
		resolvedThresholdRatio,
		resolvedRetainRatio,
		resolvedRetainTokens,
		resolvedGrowthTokens
	})
};
`;

const scope = new Function(body)();
const ctx = { name: "test" };
const NO_ENGINE = [{ config: { thresholdRatio: 0.8 } }];

// ── 夹具本身 ───────────────────────────────────────────────────────────────

let failures = 0;
function section(title) {
	process.stdout.write(`\n${title}\n`);
}
function check(ok, label, detail) {
	if (ok) {
		process.stdout.write(`  ✅ ${label}${detail === undefined ? "" : `　${detail}`}\n`);
	} else {
		failures++;
		process.stdout.write(`  ❌ ${label}${detail === undefined ? "" : `　${detail}`}\n`);
	}
}

const WINDOWS = [4096, 8192, 16384, 32768, 131072, 1048576];
const RATIOS = [0.05, 0.1, 0.2, 0.6, 0.95];

/** 引擎真实的抛错条件：`retainTokens >= thresholdTokens`。 */
function engineThreshold(ratio, window) {
	// 插件把 headroomTokens 设成 -1e6，容量项恒大于比例项，所以阈值就是 W×R。
	return Math.floor(window * ratio);
}

section(`宿主策略下限 · ${target.replace(/^.*[\\/]/, "")}`);

// ── 1. 不管走哪条返回路径，保留量都必须留在阈值下面 ────────────────────────
section("每条返回路径都要保住「保留 < 阈值」");
{
	const modes = [
		{ label: "自动", load: { currentAuto: true, currentRetainTokens: null, currentGrowthTokens: 0 } },
		{ label: "手动·默认保留·增长关", load: { currentAuto: false, currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 0 } },
		{ label: "手动·默认保留·存量增长步长（机制已下线）", load: { currentAuto: false, currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 5000 } },
		{ label: "手动·绝对保留·增长关", load: { currentAuto: false, currentRetainTokens: 4000, currentRetainRatio: null, currentGrowthTokens: 0 } },
		{ label: "手动·比例保留·增长关", load: { currentAuto: false, currentRetainTokens: null, currentRetainRatio: 0.05, currentGrowthTokens: 0 } }
	];
	let worst = null;
	let bad = 0;
	for (const window of WINDOWS) {
		for (const ratio of RATIOS) {
			for (const mode of modes) {
				scope.load({
					engines: NO_ENGINE,
					...mode.load,
					currentRatio: ratio,
					activeSessionId: "s",
					windows: { s: window },
					lasts: { s: Math.floor(window * 0.02) }
				});
				const floor = scope.ratioFloor(ctx, "s");
				const effective = scope.currentThresholdRatio(ctx, "s");
				const threshold = engineThreshold(effective, window);
				const state = scope.read();
				// 插件写了绝对保留时，引擎用的就是它；否则引擎用自带的 16%（相对消息预算，
				// 而消息预算 ≤ 窗口，所以用窗口算 16% 是上界）。
				const retained = state.resolvedRetainTokens !== null
					? state.resolvedRetainTokens
					: Math.floor(window * scope.constants.DEFAULT_RETAIN_RATIO);
				if (retained >= threshold) {
					bad++;
					if (worst === null) worst = { mode: mode.label, window, ratio, floor, effective, threshold, retained };
				}
			}
		}
	}
	check(bad === 0, `${WINDOWS.length * RATIOS.length * modes.length} 组组合下都能保住`,
		bad === 0 ? "" : `仍有 ${bad} 组越界，例如 ${worst.mode} 窗口 ${worst.window} 比例 ${worst.ratio}：阈值 ${worst.threshold} < 保留 ${worst.retained}`);
}

// ── 2. 面板能给的下限，重启后不能被改写 ────────────────────────────────────
section("滑块下限与读盘下限一致");
{
	const { MIN_SLIDER_RATIO, MIN_RATIO } = scope.constants;
	let below = null;
	for (const window of WINDOWS) {
		for (const ratio of RATIOS) {
			for (const auto of [true, false]) {
				scope.load({
					engines: NO_ENGINE, currentAuto: auto, currentRatio: ratio,
					currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 0,
					activeSessionId: "s", windows: { s: window }, lasts: {}
				});
				const floor = scope.ratioFloor(ctx, "s");
				if (floor < MIN_SLIDER_RATIO) below ??= { window, ratio, auto, floor };
			}
		}
	}
	check(below === null, `ratioFloor 从不低于 MIN_SLIDER_RATIO(${MIN_SLIDER_RATIO})`,
		below === null ? "" : `窗口 ${below.window} 比例 ${below.ratio} 自动=${below.auto} → ${below.floor}`);

	scope.load({
		engines: NO_ENGINE, currentAuto: false, currentRatio: 0.8,
		currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 0,
		activeSessionId: "s", windows: { s: 1048576 }, lasts: {}
	});
	const noRetention = scope.ratioFloor(ctx, "s");
	check(noRetention >= MIN_RATIO, `不写保留时下限不低于引擎自带的 16%（MIN_RATIO=${MIN_RATIO}）`, `实际 ${noRetention}`);
}

// ── 3. 自动模式在窗口未知时不得套用休眠的手动值 ────────────────────────────
section("自动 + 窗口未知");
{
	scope.load({
		engines: NO_ENGINE, currentAuto: true, currentRatio: 0.8,
		currentRetainTokens: 8000, currentRetainRatio: null, currentGrowthTokens: 40000,
		activeSessionId: "s", windows: {}, lasts: {}
	});
	scope.resolvePolicy("s");
	const state = scope.read();
	check(state.resolvedRetainTokens === null && state.resolvedGrowthTokens === 0,
		"不套用没被要求过的 8000 保留，存量增长步长也一律作废",
		`实际 retainTokens=${state.resolvedRetainTokens} growthTokens=${state.resolvedGrowthTokens}`);

	scope.load({
		engines: NO_ENGINE, currentAuto: true, currentRatio: 0.8,
		currentRetainTokens: 8000, currentRetainRatio: null, currentGrowthTokens: 40000,
		activeSessionId: "s", windows: { s: 1048576 }, lasts: {}
	});
	scope.resolvePolicy("s");
	const known = scope.read();
	check(known.resolvedRetainTokens === 16777 && known.resolvedGrowthTokens === 0,
		"窗口回来之后按滑块推算（1M 的 80% → 保留 16.8K），增长仍是 0",
		`实际 retainTokens=${known.resolvedRetainTokens} growthTokens=${known.resolvedGrowthTokens}`);
}

// ── 4. 会话参数真的被用上，而不是偷看活动会话 ──────────────────────────────
section("按被问的会话解析");
{
	scope.load({
		engines: NO_ENGINE, currentAuto: true, currentRatio: 0.05,
		currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 0,
		activeSessionId: "A", windows: { A: 1048576, B: 16384 }, lasts: {}
	});
	const floorB = scope.ratioFloor(ctx, "B");
	const effectiveB = scope.currentThresholdRatio(ctx, "B");
	const stateB = scope.read();
	// 16K 窗口、5% → 阈值 819，保留被夹到下限 1000，下限必须把它垫到 (1000+1024)/16384。
	check(stateB.resolvedRetainTokens === 1000, "B 会话的保留按 B 的窗口算（1000）", `实际 ${stateB.resolvedRetainTokens}`);
	check(effectiveB >= floorB - 1e-9, "B 会话的生效比例不低于 B 的下限", `生效 ${effectiveB.toFixed(4)} ≥ 下限 ${floorB.toFixed(4)}`);
	check(engineThreshold(effectiveB, 16384) > 1000, "B 会话的阈值高于保留量",
		`阈值 ${engineThreshold(effectiveB, 16384)} > 保留 1000`);

	scope.load({ activeSessionId: "A", windows: { A: 1048576, B: 16384 }, lasts: {}, engines: NO_ENGINE });
	const floorA = scope.ratioFloor(ctx, "A");
	check(Math.abs(floorA - floorB) > 1e-6, "A 与 B 的下限确实不同（说明用的是各自的窗口）",
		`A=${floorA.toFixed(4)} B=${floorB.toFixed(4)}`);
}

// ── 5. 面板给出的下限，接口必须接受 ────────────────────────────────────────
//
// 真正踩到过：接口用 ratioFloor(活动会话) 校验，而面板的 minRatio 一度按「被问的会话」
// 算。重启后进程还没驱动过任何会话 → 活动会话窗口未知 → 接口下限 0.2，而面板那边窗口
// 已知 → 下限 0.05。滑块允许你拖到 5%，一松手就被拒："thresholdRatio must be at least 0.2"。
section("面板下限必须被接口接受");
{
	const cases = [
		{ label: "活动会话与面板会话同一个（窗口已知）", active: "B", windows: { B: 1048576 } },
		{ label: "重启后：活动会话未知窗口", active: null, windows: { B: 1048576 } },
		{ label: "活动会话是另一个会话", active: "A", windows: { A: 131072, B: 1048576 } },
		{ label: "谁都没有窗口", active: null, windows: {} }
	];
	for (const item of cases) {
		scope.load({
			engines: NO_ENGINE, currentAuto: true, currentRatio: 0.8,
			currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 0,
			activeSessionId: item.active, windows: item.windows, lasts: {}
		});
		const payload = scope.statePayload(ctx, "B");
		const min = payload.value.minRatio;
		const problem = scope.validateRatio(ctx, min);
		check(problem === null, `${item.label}：下限 ${min} 会被接口接受`, problem ?? "");
	}
}

// ── 6. 面板拿到的保留量属于它问的那个会话 ──────────────────────────────────
section("快照不跨会话拼接");
{
	scope.load({
		engines: NO_ENGINE, currentAuto: true, currentRatio: 0.6,
		currentRetainTokens: null, currentRetainRatio: null, currentGrowthTokens: 0,
		activeSessionId: "A", windows: { A: 1048576, B: 16384 }, lasts: {}, heads: {}
	});
	const payload = scope.statePayload(ctx, "B");
	const value = payload.value;
	// A（1M、60%）推出来是 12583；B（16K、60%）阈值 9830，保留被夹到 1000。必须是后者。
	check(value.contextWindow === 16384, "contextWindow 是 B 的", `实际 ${value.contextWindow}`);
	check(value.retainTokens === 1000, "retainTokens 也是 B 的（1000），不是 A 的 12583", `实际 ${value.retainTokens}`);
	check(value.retainTokens !== null && value.retainTokens < value.contextWindow,
		"保留量没有超过它自己那行的窗口", `${value.retainTokens} < ${value.contextWindow}`);
}

// ── 7. 提交 retainTokens 时宿主要挡住越界值（源码不变量） ───────────────────
section("接口层的 retainTokens 交叉校验");
{
	// 正则只能证明「文案还在」。所以这里连同**条件本身**一起钉：把 `>= ceiling` 改成
	// `false && >= ceiling` 时，校验已经死了，但只查文案的正则照样命中。
	const hasGuard = /if \(body\.retainTokens >= ceiling\) \{[\s\S]{0,300}?writeJson\(res, 400/.test(source);
	check(hasGuard, "POST /state 会拒绝高到追平阈值的 retainTokens（条件与 400 都在）");

	const guardUsesNext = /body\.retainRatio >= nextRatio/.test(source) && /Math\.floor\(nextRatio \* w\)/.test(source);
	check(guardUsesNext, "上限比的是同一个请求要写入的阈值，不是即将被替换的旧值");

	// 先落状态、再校验后面的字段：一个 400 也能改掉策略，`{enabled:false, auto:"x"}` 更糟 ——
	// 开关在内存里翻了，`applySwitch` 却从没跑，引擎一直带着接管值，而面板说「已还原」。
	check(!/currentRatio = body\.thresholdRatio/.test(source) && /currentRatio = nextRatio/.test(source),
		"POST 先全部校验、再一次性提交（不再边校验边落状态）", "");
	check(/^function planStatePatch|const nextRatio = wantsRatio/m.test(source),
		"被校验的值先算进 nextRatio", "");

	const autoParams = /growthMax: AUTO_GROWTH_MAX/.test(source);
	check(autoParams, "面板实时重算所需的 autoParams 仍然下发");
}

// ── 7b. 状态文件的迁移与读盘 ───────────────────────────────────────────────
//
// 主机夹具抽的是纯函数，从不碰状态文件，所以这段迁移以前零覆盖：把版本号改回 3、
// 把 `currentGrowthTokens = 0` 换回读 `stored.growthTokens`、或者整段版本检查删掉，
// 夹具都照样全绿。这里用源码不变量把它钉住 —— 不优雅，但比没有强。
section("状态文件：增长字段作废 + 版本重写");
{
	check(/const STATE_VERSION = 4;/.test(source), "状态版本是 4", "");
	check(/off the surface, so a step left in an older config file is dropped[\s\S]{0,200}?currentGrowthTokens = 0;/.test(source),
		"读盘时无条件把 currentGrowthTokens 置 0", "");
	check(!/currentGrowthTokens = typeof stored\.growthTokens/.test(source),
		"读盘不再从文件里恢复增长步长", "");
	check(/if \(stored\.version !== STATE_VERSION\) \{[\s\S]{0,120}?persistState\(\);/.test(source),
		"版本不一致时会重写文件（旧构建留下的字段就此消失）", "");
	// 解析失败以前被当成「空文件」，随后版本检查把默认值覆盖上去 —— 用户设置全丢，
	// 一声不响。现在必须把坏文件挪开并说出来。
	check(/not valid JSON/.test(source) && /renameSync\(statePath\(\), aside\)/.test(source),
		"状态文件解析失败时挪到一边并报出来，不再静默重置", "");
}

// ── 7c. 抽取到的函数确实是生效的那一份 ─────────────────────────────────────
//
// `sliceFunction` 按名字取**第一处**文本。在文件末尾追加一个同名函数声明，JS 里后者
// 生效、模块行为已被改坏，而夹具仍会拿到正确的那一份去测 —— 等于在测死代码。
section("抽取的是生效的那份");
{
	const duplicated = scope.extracted.filter((name) =>
		(source.match(new RegExp(`^function ${name}\\(`, "gm")) ?? []).length !== 1);
	check(duplicated.length === 0, "每个被抽取的函数在源码里只声明一次",
		duplicated.length === 0 ? "" : `重复: ${duplicated.join(", ")}`);
}

// ── 8. 谁决定了触发点 ──────────────────────────────────────────────────────
//
// 真事故：窗口 1.0M、滑块 80%，面板写着「触发于 800K」，引擎却在 5 万令牌就压了，
// 半小时内压了五次。两个原因叠在一起：增长步长把触发点拉到 43K，比 5% 下限（50K）
// 还低，于是下限赢了；而面板还在拿「窗口 × 滑块」自己算。增长模式已经下线，这里
// 同时钉住两件事 —— 存量配置不再把它拖下去，以及主机说清楚现在是谁赢的。
section("触发点是滑块 / 下限决定的");
{
	// 这台机器上真实的那份配置：滑块 0.8、保留 4179、存量增长 14626、上次压完 28577。
	const REAL = {
		currentAuto: false, currentRatio: 0.8, currentRetainRatio: null,
		currentRetainTokens: 4179, currentGrowthTokens: 14626, currentEnabled: true,
		activeSessionId: "R", windows: { R: 1000000 }, lasts: { R: 28577 }
	};
	scope.load({ engines: NO_ENGINE, heads: {}, ...REAL });
	const real = scope.statePayload(ctx, "R").value;
	check(real.thresholdTokens === 800000,
		"重演事故的那份配置现在按滑块压（800K），不再被增长步长拖到 43K",
		`实际 ${real.thresholdTokens}`);
	check(Math.abs(real.effectiveRatio - 0.8) < 1e-9, "生效比例就是滑块上的 0.8", `实际 ${real.effectiveRatio}`);
	check(real.triggerBoundBy === "slider", "归属说的是滑块", `实际 ${real.triggerBoundBy}`);
	check(real.growthTokens === 0, "存量增长步长一律作废（14626 → 0）", `实际 ${real.growthTokens}`);
	check(real.growthTargetTokens === null && real.growthClampedByRetention === false,
		"增长相关的派生量不再产出",
		`target=${real.growthTargetTokens} clamped=${real.growthClampedByRetention}`);
	check(real.triggerFloorIsRetention === false,
		"这份下限来自插件自己的 5% 最小值，不是保留量（面板据此选文案）",
		`实际 ${real.triggerFloorIsRetention}`);
	// 暂停时不该给归属：引擎拿着什么已经不是这张卡片说了算。
	scope.load({ engines: NO_ENGINE, heads: {}, ...REAL, currentEnabled: false });
	const off = scope.statePayload(ctx, "R").value;
	check(off.triggerBoundBy === null && off.triggerFloorIsRetention === false,
		"暂停时不宣称任何归属",
		`boundBy=${off.triggerBoundBy} floorIsRetention=${off.triggerFloorIsRetention}`);
	scope.load({ engines: NO_ENGINE, heads: {}, ...REAL });
	check(engineThreshold(real.effectiveRatio, 1000000) === real.thresholdTokens,
		"引擎阈值与面板一致", `引擎 ${engineThreshold(real.effectiveRatio, 1000000)}`);

	// 换一组滑块比例、再换一个大得离谱的存量步长，结论都必须只跟着滑块走。
	let drifted = null;
	for (const ratio of [0.2, 0.5, 0.8, 0.95]) {
		for (const growth of [0, 14626, 100000]) {
			scope.load({ engines: NO_ENGINE, heads: {}, ...REAL, currentRatio: ratio, currentGrowthTokens: growth });
			const value = scope.statePayload(ctx, "R").value;
			if (value.effectiveRatio !== ratio || value.triggerBoundBy !== "slider") {
				drifted ??= { ratio, growth, effective: value.effectiveRatio, boundBy: value.triggerBoundBy };
			}
		}
	}
	check(drifted === null, "12 组「滑块 × 存量增长」组合下，生效比例都等于滑块",
		drifted === null ? "" : `滑块 ${drifted.ratio} 增长 ${drifted.growth} → ${drifted.effective}（${drifted.boundBy}）`);

	// 下限仍然要能赢：保留量大到把触发点顶过滑块，此时归属必须改成「下限」。
	scope.load({
		engines: NO_ENGINE, heads: {}, currentAuto: false, currentRatio: 0.2,
		currentRetainRatio: null, currentRetainTokens: 300000, currentGrowthTokens: 0,
		activeSessionId: "R", windows: { R: 1000000 }, lasts: {}
	});
	const floored = scope.statePayload(ctx, "R").value;
	check(floored.triggerBoundBy === "floor", "保留量顶过滑块时，归属改成下限", `实际 ${floored.triggerBoundBy}`);
	check(floored.triggerFloorIsRetention === true, "并且说清楚这下限来自保留量", `实际 ${floored.triggerFloorIsRetention}`);
	check(floored.thresholdTokens === 301024, "触发点是保留量垫出来的 301024", `实际 ${floored.thresholdTokens}`);
	check(engineThreshold(floored.effectiveRatio, 1000000) === floored.thresholdTokens,
		"引擎阈值与面板一致", `引擎 ${engineThreshold(floored.effectiveRatio, 1000000)}`);

	// 比例保留的下限必须来自**存下来的**设置，不能只回读引擎：引擎那份只是「上次写进去
	// 的东西」，暂停/还原之后它是引擎自带的 0.16，此时下限会退回 0.2，接口就会接受一个
	// 被 0.9 的保留比例禁止的阈值 —— 引擎随后按真公式算出 保留 ≥ 阈值 并抛错。
	scope.load({
		engines: [{ config: { retainRatio: 0.16, thresholdRatio: 0.8 } }], heads: {},
		currentAuto: false, currentRatio: 0.3, currentRetainRatio: 0.9, currentRetainTokens: null,
		activeSessionId: "R", windows: { R: 1000000 }, lasts: {}
	});
	const storedFloor = scope.ratioFloor(ctx, "R");
	const rejected = scope.validateRatio(ctx, 0.3);
	check(Math.abs(storedFloor - 0.91) < 1e-9,
		"引擎还没带上 0.9 时，下限仍然按存下来的比例算（0.91）", `实际 ${storedFloor}`);
	check(rejected !== null, "这个下限会挡下低于它的阈值", `实际 ${JSON.stringify(rejected)}`);
	// 再验一次那个组合真的会让引擎抛：threshold = floor(W×0.3)，retain = floor((W−reserved)×0.9)。
	{
		const w = 200000, reserved = 128000;
		const threshold = Math.floor(Math.min(w * 0.3, w - reserved + 1e6));
		const retain = Math.floor((w - reserved) * 0.9);
		check(retain >= threshold, "挡住的那个组合确实是引擎会抛错的那种",
			`阈值 ${threshold} vs 保留 ${retain}`);
	}

	// 归属标记不能和 `effectiveRatio` 自相矛盾：说「滑块说了算」时，两者必须相等。
	check(!(real.triggerBoundBy === "slider" && real.effectiveRatio !== real.thresholdRatio),
		"说「滑块说了算」时两个比例必须相等",
		`boundBy=${real.triggerBoundBy} effective=${real.effectiveRatio} ratio=${real.thresholdRatio}`);

	// `ratioIsBinding` 以前是 `thresholdTokens <= 1000000`：把一个**永真的结论**当成
	// 需要验证的猜想。插件把 headroom 强制成 −1000000，引擎的容量项因此至少比任何完成
	// 预留大一百万，`min(W × ratio, 容量项)` 里的比值臂永远胜出。那条判据只会在窗口大到
	// W × ratio 超过一百万时报警 —— 报的恰好是正在按滑块工作的那些引擎。它现在回答的是：
	// 让这个结论成立的那份余量，是不是真写在每个被接管的引擎上。
	const OWNED = (headroom) => ({ config: { [scope.constants.OWNED_BY_SUITE]: true, headroomTokens: headroom } });
	scope.load({ engines: [], heads: {}, ...REAL });
	const noneOwned = scope.statePayload(ctx, "R").value;
	check(noneOwned.ratioIsBinding === null && noneOwned.headroomConsistent === null,
		"没有接管的引擎时，ratioIsBinding 不表态",
		`binding=${noneOwned.ratioIsBinding} consistent=${noneOwned.headroomConsistent}`);

	scope.load({ engines: [OWNED(-1e6), OWNED(-1e6)], heads: {}, ...REAL });
	const allSame = scope.statePayload(ctx, "R").value;
	check(allSame.ratioIsBinding === true, "余量都一致 → 滑块确实说了算", `实际 ${allSame.ratioIsBinding}`);

	scope.load({ engines: [OWNED(-1e6), OWNED(0)], heads: {}, ...REAL });
	const mixed = scope.statePayload(ctx, "R").value;
	check(mixed.ratioIsBinding === false,
		"有引擎没带上本插件那份余量 → 不再断言「滑块说了算」", `实际 ${mixed.ratioIsBinding}`);

	scope.load({ engines: [OWNED(-1e6)], heads: {}, ...REAL, currentRatio: 0.8, windows: { R: 4194304 } });
	const bigWindow = scope.statePayload(ctx, "R").value;
	check(bigWindow.thresholdTokens > 1000000 && bigWindow.ratioIsBinding === true,
		"4M 窗口下阈值超过 100 万，比值臂仍然胜出（旧判据会在这里误报）",
		`阈值 ${bigWindow.thresholdTokens} binding=${bigWindow.ratioIsBinding}`);
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
process.stdout.write("\n");
if (failures === 0) {
	process.stdout.write("全部通过 ✅\n");
	process.exit(0);
} else {
	process.stdout.write(`${failures} 项失败 ❌\n`);
	process.exit(1);
}
