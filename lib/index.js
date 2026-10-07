// dsh-compact-suite — host half.
//
// 自动压缩的触发阈值由 @deepseek-ai/dsh-compaction-basic 的 `thresholdRatio`
// 决定（该包 lib/index.js 的 resolveCompactSpec）：
//
//   thresholdTokens = floor(min(contextWindow * thresholdRatio,
//                              contextWindow - reservedCompletionTokens - headroomTokens))
//
// 该引擎的 compactIfNeeded 每次判定都重新读 `this.config`，所以只要替换实例
// 上的 `config` 引用，新阈值立刻参与下一次判定 —— 无需重启，也无需改写
// app.asar 里的官方文件（asar 条目带 SHA256 integrity，改不得）。
//
// ── 口径：以卡片为准 ──────────────────────────────────────────────────────
// 光调 ratio 不够。官方有两套口径：
//   · 卡片 = `contextPressure` 投影的 projectedTokens ?? pressureTokens，
//     主项是 provider 回报的真实 prompt usage（不含输出）。
//   · 引擎 = `TokenMeter.measure().totalTokens`，在
//     `usageTokens(usage) >= estimatedAnchorTokens` 时用真实 usage，否则退回
//     4 字符/令牌的启发式估值。真实内容密度约 5.4-6.9 字符/令牌，启发式因此
//     几乎总是高估（实测 33%-73%），于是引擎读数长期高于卡片 —— 卡片才 50%
//     上下，引擎已越过 80% 阈值，压缩就提前发生了。
// 这里把 `measure()` 的 totalTokens 对齐到卡片那个数，于是「滑块比例」与
// 「卡片显示的百分比」成为同一件事。只影子实例自身的 measure，且只换
// totalTokens —— `nodes` 原样透传，因为压缩选区（selectCompactableRange）与
// surface 稳定性校验只读 nodes；传 requestHeader 的推测调用一律不介入。
// `contextPressure` 是纯事件折叠、不回调 measure，故不存在递归。
//
// 官方把 compaction 挂在一个 `isolate` 组里（profile patch 的 `compaction`
// 行），组外 `ctx.get("compaction")` 解析不到实例（实测非 strict 下为
// undefined，strict 下抛 "cannot get required service in inactive context"）。
// 但 isolate 只拦截上下文代理的取值，fiber 自己的 `store` 是普通对象，因此
// 这里直接遍历 `ctx.registry` 的 fiber store 拿到全部存活引擎实例 —— 每个
// agent preset 一个。已用真实 cordis 验证过该路径。
//
// 压缩日志：@deepseek-ai/dsh-compaction-basic 每压缩一次都会往会话里写
// `compaction/start` → `compaction/summary` → `compaction/end` 三个事件
// （compactSurfaceRegion / commitCompactionBody）。这里以 host 平面监听
// `session/event`，在 start 时用 tokenMeter 量一次「压缩前」，在 end 时量
// 一次「压缩后」，连同 summary 里的 shadowedTokenCount 一起落盘，供卡片里的
// 日志视图读取。tokenMeter 刻意留在 host 平面（见 profile patch 注释），
// 与本插件同平面，故可直接取用。
//
// 浏览器半（lib/client.js）把滑块与日志入口画进上下文监控卡片的面板内部，
// 通过本文件注册的 /compact-suite/api/state 与 /log 读写。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";

/**
 * Host loader entry.
 *
 * `llm` 是本插件相对 dsh-compaction-threshold 新增的依赖：压缩模型路由要挂到
 * `llm/stream` 这个 waterfall 接缝上。
 *
 * `agents` + `commands` 供「立即压缩」用：`ctx.agents.get(sessionId)` 拿到会话对应的
 * agent，再交给 `ctx.commands.execute(agent, "/compact", …)`。走官方命令而不是直接调
 * `compaction.compactNow`，原因是 compaction 缝被 isolate 在 preset 组内、根层取不到；
 * 而 commands 不隔离，并且按 agent 解析命令，正好能看见组里注册的那个 `/compact`。
 */
export const inject = ["webServer", "webRuntime", "llm", "agents", "commands"];

/**
 * 插件配置 —— 写在插件自己的行上，不动 compaction-basic 的任何默认值。
 *
 * 前两个键是相对 dsh-compaction-threshold 新增的能力：把摘要（purpose:
 * 'compaction'）那一次模型调用改派到指定 provider/model。
 */
export const Config = z.object({
	/** 摘要改用哪个 provider；留空 = 跟随当前会话模型（等于旧行为）。 */
	summarizationProvider: z.string().default(""),
	/** 摘要改用哪个 model；与 summarizationProvider 成对设置，缺一即视为关闭。 */
	summarizationModel: z.string().default(""),
	/** 滑块从未拖动过时的初始触发比例；拖动过的值以状态文件为准。 */
	thresholdRatio: z.number().default(0.8),
});

/**
 * 压缩专用的模型路由。
 *
 * `llm/stream` 是 waterfall：命中 `purpose === 'compaction'` 的调用把
 * provider/model 换成配置里那一对，其余一律 `next()` 放行。
 *
 * 为什么走 llm 接缝，而不是用 compaction-basic 自带的
 * `summarizationProvider` / `summarizationModel`：
 * 那两个键必须配在 compaction-basic 自己那一行上，而它挂在 agent preset 的
 * `isolate` 组内 —— 那一行既不属于 profile 根，也就没有设置界面。改走 llm
 * 接缝之后，本插件以顶层行身份即可生效，而且**与挂的是哪个压缩引擎无关**
 * （compaction-basic / billion-context / DCP 都同样被接管）。
 *
 * `global: true` 用来穿透 realm 过滤：压缩发生在 preset 的子领域里，顶层
 * 监听器默认看不到。
 */
/**
 * The route this plugin substituted into the most recent compaction call, per session.
 *
 * `compaction/summary` names the target the ENGINE resolved, and it resolves that
 * before handing the call to `ctx.llm.stream()` -- so the event names the session
 * model even when the waterfall rerouted the call. This plugin is the only party
 * that knows what the request was actually sent to, so it has to remember it.
 *
 * Keyed by session because two sessions may compact at once; when a route is
 * configured every call is rewritten to the same pair, so the key is belt and
 * braces rather than a correctness requirement.
 */
const reroutedFor = new Map();

function installCompactRouter(ctx, routeOf) {
	return ctx.on("llm/stream", (options, next) => {
		if (options.purpose !== "compaction") return next();
		const route = routeOf();
		if (route === undefined) return next();
		if (options.provider === route.provider && options.model === route.model) return next();
		if (typeof options.sessionId === "string") {
			reroutedFor.set(options.sessionId, { provider: route.provider, model: route.model });
		}
		return ctx.llm.stream(Object.freeze({ ...options, provider: route.provider, model: route.model }));
	}, { global: true });
}

/** Route prefix owned by this plugin. */
const API_PREFIX = "/compact-suite/api";
/** State file under $DSH_HOME. */
const STATE_FILENAME = "compact-suite.json";
/** Slider floor; stays clear of the default retainRatio (0.16). */
const MIN_RATIO = 0.2;
/** Slider ceiling; above this a single turn can overflow before compacting. */
const MAX_RATIO = 0.95;
/**
 * `headroomTokens` forced onto every engine.
 *
 * The shipped formula caps the threshold at
 * `contextWindow - reservedCompletionTokens - headroomTokens`, and
 * `reservedCompletionTokens` is the routed model's own `maxTokens`. The `wk`
 * route declares `maxTokens: 128000`, so on its 200K window that arm reads
 * `200000 - 128000 = 72000` — 36% — and `min()` picks it for every slider
 * position above that. The slider was therefore inert above 36%, and real
 * compactions fired at 72196 and 88293 tokens instead of at 160000.
 *
 * A headroom below zero cancels the reservation outright:
 *
 *   contextWindow - reservedCompletionTokens - (-1e6) > contextWindow
 *
 * so the second arm can never be the smaller one and the ratio is left as the
 * only term that decides. The magnitude only has to exceed any real
 * `contextWindow`; it is not a budget, it is a cancellation. `maxTokens` is
 * restated separately, so the summarizer's own output cap is untouched.
 */
const HEADROOM_TOKENS = -1e6;
/**
 * 被 clamp 压坏时抬回的输出下限。跟随压缩器实际的 maxTokens —— 摘要请求用的就是它
 * （引擎把 maxTokens 默认为 headroomTokens = 65536）。实测 283 次摘要最高输出
 * 23,832 令牌，超过 20000 的有 5 次，所以抬回值不能低于压缩器的上限。
 */
let outputFloorTokens = 65536;
/**
 * 判定「输出上限已被 clamp 压坏」的产物上限。
 *
 * `clampMaxTokensToContext` 返回 `min(maxTokens, max(MIN_MAX_TOKENS, available))`，
 * 其中 `available = contextWindow - estimateContextTokens(...).tokens - CONTEXT_SAFETY_TOKENS`
 * （`CONTEXT_SAFETY_TOKENS` 在 `@earendil-works/pi-ai` 的 `simple-options.js` 里是 4096，
 * `clampMaxTokensToContext` 也定义在那里，不是 `dsh-llm-pi-ai`）。
 *
 * 只要 `available < maxTokens` 它就开始压，也就是估算口径超过
 * `contextWindow - maxTokens - 4096` 就压 —— 在 200K 窗口 + 128000 上限下，
 * 真实上下文约 51K 起输出上限就一路下滑。所以这不是一个点，而是一段连续区间：
 * 真实 148.4K 时产物 47，再往上就是 18、1。
 *
 * 一开始只拦 `<= 1`（`available` 为负、被 `max(1, ...)` 夹到底的确切产物），
 * 结果真实会话里出现的 47 和 18 全部漏过。取 16384 把这段「已经小到不可用」的
 * 区间整段盖住：`product <= 16384` 等价于估算口径超过窗口的 89%，真实上下文
 * 约 137K 以上。
 *
 * 已知的人为小上限只有 `session-title-llm` 的 64，也会被一并抬回 —— 那是无害的，
 * `max_completion_tokens` 是上限而非配额，标题请求会在自然结束时停下；真正被压坏
 * 的标题请求反而因此得救。正常配置值（65536 / 128000 / 256000）远高于此，不受影响。
 */
const CLAMP_PRODUCT_CEILING = 16384;
/** 标记位，避免重复包装 globalThis.fetch。 */
const RESCUE_MARK = "__dshCompactionThresholdRescue";
/** @deepseek-ai/dsh-compaction-basic's own default, used when nothing is stored. */
const FALLBACK_RATIO = 0.8;
/** Request body cap; the payload is one number. */
const MAX_BODY_BYTES = 64 * 1024;
/** Compaction log file under $DSH_HOME. */
const LOG_FILENAME = "compaction-log.json";
/** Most recent compactions retained in the log. */
const LOG_LIMIT = 200;

/** The ratio this process is currently enforcing. */
let currentRatio = FALLBACK_RATIO;
/** Compaction records, newest first; loaded from disk on apply. */
let compactionLog = [];
/** Compactions opened by `compaction/start`, awaiting their `compaction/end`. */
const pendingCompactions = new Map();
/**
 * 正在执行「立即压缩」的会话。
 *
 * 引擎自己会拒绝并发的第二次压缩（报 busy），但那样双击的第二次请求要等上几分钟
 * 才被告知——在这里直接拒掉，按钮才是诚实的。
 */
const manualCompactions = new Set();
/** Latest `request/context` capacity per Session; the card's own denominator. */
const contextWindows = new WeakMap();
/** Compactions the meter could not price, dropped rather than grown without bound. */
const MAX_PENDING = 64;
/**
 * Each engine's pre-override output budget, captured before the first write.
 * Keyed by engine instance so a reloaded preset gets a fresh capture.
 */
const engineBaseline = new WeakMap();

/** Current state-file schema version. v1 was a bare `{ thresholdRatio }`. */
const STATE_VERSION = 2;
/**
 * Ownership marker written onto every engine config object this plugin
 * replaces. A Symbol is invisible to JSON and `for-in`, so nothing downstream
 * sees it, but a second manager — or a future official behaviour — can tell
 * whose write it is instead of silently fighting over the same field.
 */
const OWNED_BY_SUITE = Symbol.for("dsh-compact-suite.owned");
/**
 * The engine config captured before this plugin's first write, so dispose can
 * put it back. Without this the live engines keep `headroomTokens: -1e6` and
 * this plugin's ratio after the plugin is disabled, until a process restart —
 * exactly the residue a plugin must not leave behind.
 */
const engineOriginals = new WeakMap();
/** Engines already reported as unadoptable, so the warning is emitted once each. */
const warnedUnadoptable = new WeakSet();
/** Original `measure` per patched meter, so dispose can unwrap. */
const meterOriginals = new Map();
/** Latest context window per Session id, for the panel's token arithmetic. */
const contextWindowById = new Map();
/** Whether this plugin is currently taking over the engines. */
let currentEnabled = true;
/** The summarization route currently enforced (empty pair = follow the session model). */
let currentRoute = { provider: "", model: "" };

// ── state file ─────────────────────────────────────────────────────────────

/** Resolve $DSH_HOME the same way the shipped runtime does. */
function dshHome() {
	return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
}

/** Absolute path of this plugin's state file. */
function statePath() {
	return join(dshHome(), STATE_FILENAME);
}

/**
 * Read the whole state file. A v1 file (bare `{ thresholdRatio }`) is read as
 * is — every field falls back to the caller's default, so upgrading does not
 * need a rewrite pass.
 */
function readStoredState() {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Atomically persist the whole state file under the current schema version. */
function writeStoredState(state) {
	const file = statePath();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
}


// ── compaction log file ────────────────────────────────────────────────────

/** Absolute path of the compaction log. */
function logPath() {
	return join(dshHome(), LOG_FILENAME);
}

/** Read the stored log, or an empty list when the file is absent or unusable. */
function readStoredLog() {
	try {
		const parsed = JSON.parse(readFileSync(logPath(), "utf8"));
		const records = parsed?.records;
		if (!Array.isArray(records)) return [];
		return records
			.filter((record) => record !== null && typeof record === "object")
			// Records written before the collapse rule existed still carry the
			// artifact, so the correction has to run on load as well as on write.
			.map((record) => {
				if (isCollapseArtifact(record.after, record.before)) record.after = null;
				return record;
			})
			.slice(0, LOG_LIMIT);
	} catch {
		return [];
	}
}

/**
 * Persist the log. Failure is swallowed: a full disk must never turn into a
 * broken compaction, and the in-memory list stays authoritative for the session.
 */
function writeStoredLog() {
	try {
		const file = logPath();
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ records: compactionLog }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
	} catch (error) {
		console.error("[dsh-compact-suite] cannot persist the compaction log:", error);
	}
}

/** Prepend one record, trim to the cap, and persist. */
function appendLog(record) {
	compactionLog = [record, ...compactionLog].slice(0, LOG_LIMIT);
	writeStoredLog();
}

// ── live engines ───────────────────────────────────────────────────────────

/**
 * Every live compaction engine in the process, one per mounted preset.
 *
 * Read through raw fiber stores so the `isolate` realm on the profile's
 * `compaction` group cannot hide them; a disposed fiber has its `store`
 * cleared, which the optional chain absorbs.
 */
function compactionEngines(ctx) {
	const found = [];
	for (const runtime of ctx.registry.values()) {
		for (const fiber of runtime.fibers ?? []) {
			const impl = fiber.store?.compaction;
			if (impl?.value !== undefined) found.push(impl.value);
		}
	}
	return found;
}

/** The engine's pre-override budgets, captured on first sight. */
function baselineOf(engine) {
	let base = engineBaseline.get(engine);
	if (base === undefined && engine.config !== undefined) {
		const fallback = 65536;
		base = {
			maxTokens: typeof engine.config.maxTokens === "number" ? engine.config.maxTokens : fallback
		};
		engineBaseline.set(engine, base);
		// 输出兜底值跟随压缩器的实际上限：摘要请求用的就是它，抬回值低于它会截断摘要。
		if (base.maxTokens > outputFloorTokens) outputFloorTokens = base.maxTokens;
	}
	return base;
}

/**
 * Point every live engine at `ratio`.
 *
 * `config` is a frozen snapshot on each instance, so the reference is replaced
 * rather than mutated. Engines whose config is not yet assigned (a service is
 * registered during `super()`, before the subclass finishes its constructor)
 * are skipped and picked up by the next `agent/pre-step`.
 *
 * `headroomTokens` is forced to {@link HEADROOM_TOKENS} because the shipped
 * formula caps pressure by it:
 *
 *   thresholdTokens = min(contextWindow * thresholdRatio,
 *                         contextWindow - reservedCompletionTokens - headroomTokens)
 *
 * With the stock 65536 headroom on a 200K window the cap sits near 64%, so any
 * slider position above that would be silently inert. Zeroing it is not enough:
 * the routed output reservation is itself 128000 on the `wk` route, which pins
 * the cap at 36% — see {@link HEADROOM_TOKENS} for the arithmetic and the fix.
 * `maxTokens` is restated from the captured baseline because the engine
 * defaults it to `headroomTokens`, which is now negative and would otherwise
 * become the summarizer's output cap.
 *
 * @returns how many engines now carry the requested ratio.
 */
function applyRatio(ctx, ratio) {
	let applied = 0;
	for (const engine of compactionEngines(ctx)) {
		const config = engine.config;
		if (config === undefined) continue;
		const known = engineOriginals.has(engine);
		// A config this plugin cannot put back must not be adopted. Capturing a
		// foreign sentinel as "the original" would make release write the poison
		// back -- the exact residue this plugin exists to avoid leaving -- and the
		// engine already behaves the way the slider asks, so declining costs nothing.
		if (!known && (config[OWNED_BY_SUITE] === true || isForeignTakeover(config))) {
			if (!warnedUnadoptable.has(engine)) {
				warnedUnadoptable.add(engine);
				const why = config[OWNED_BY_SUITE] === true
					? "it already carries this plugin's marker but no saved original"
					: "another plugin wrote a negative headroom first";
				ctx.logger?.warn?.(`compact-suite: leaving one engine alone -- ${why}, so a restore could not be trusted`);
			}
			continue;
		}
		const base = baselineOf(engine);
		if (base === undefined) continue;
		if (config.thresholdRatio !== ratio || config.headroomTokens !== HEADROOM_TOKENS || config.maxTokens !== base.maxTokens) {
			if (!known) engineOriginals.set(engine, config);
			const next = { ...config, thresholdRatio: ratio, headroomTokens: HEADROOM_TOKENS, maxTokens: base.maxTokens };
			next[OWNED_BY_SUITE] = true;
			engine.config = next;
		}
		applied += 1;
	}
	reportOutputFloor(ctx);
	return applied;
}

/**
 * Whether a config was forced by something other than this plugin.
 *
 * `headroomTokens` cannot be negative through the engine's own schema
 * (`assertNonNegativeInteger` rejects it at construction), so a negative value
 * without this plugin's marker means another manager wrote the sentinel first --
 * `dsh-compaction-threshold` is the one that does.
 */
function isForeignTakeover(config) {
	return config[OWNED_BY_SUITE] !== true
		&& typeof config.headroomTokens === "number"
		&& config.headroomTokens < 0;
}

/**
 * Report the summarizer output floor when it is first measured.
 *
 * `baselineOf` raises it from the engines' own `maxTokens`, and the engines may not
 * be discoverable when the rescue is installed. Logging the constant at install time
 * announced a floor that was never in effect.
 */
function reportOutputFloor(ctx) {
	if (outputFloorTokens === outputFloorReported) return;
	outputFloorReported = outputFloorTokens;
	ctx.logger?.info?.(`compact-suite: summarizer output floor measured at ${outputFloorTokens}`);
}

/**
 * Put every engine this plugin touched back the way it was found.
 *
 * Called from the plugin's dispose effect: a plugin that mutates another
 * plugin's live config owns the obligation to undo it.
 *
 * @returns how many engines were restored.
 */
function restoreEngines(ctx) {
	let restored = 0;
	for (const engine of compactionEngines(ctx)) {
		const original = engineOriginals.get(engine);
		if (original === undefined) continue;
		engine.config = original;
		engineOriginals.delete(engine);
		restored += 1;
	}
	return restored;
}

/** Undo every `measure` wrap this plugin installed. */
function unpatchMeters() {
	for (const [meter, original] of meterOriginals) {
		meter.measure = original;
	}
	meterOriginals.clear();
}

/** Disposer of the global output-cap rescue while it is installed. */
let outputRescueDispose = null;
/**
 * Whether this plugin's fetch wrapper is installed AND still passing requests through
 * its rewrite.
 *
 * Reported instead of `globalThis.fetch[RESCUE_MARK]`: once another wrapper sits on
 * top, the marker is no longer on the global function and the field would report a
 * false negative for a mutation that is still live.
 */
let outputRescueActive = false;
/** Last `outputFloorTokens` value written to the log, so it is reported when measured. */
let outputFloorReported = 0;

/**
 * Install or withdraw the global output-cap rescue so it matches `currentEnabled`.
 *
 * The rescue wraps `globalThis.fetch` — the most invasive thing this plugin
 * does — so "paused" has to mean it is gone, not merely unused.
 */
function syncOutputRescue(ctx) {
	if (currentEnabled) {
		if (outputRescueDispose === null) {
			outputRescueDispose = installOutputBudgetRescue(ctx) ?? (() => {});
		}
		return;
	}
	if (outputRescueDispose !== null) {
		outputRescueDispose();
		outputRescueDispose = null;
	}
}

/**
 * The single definition of "what this plugin does to other plugins' runtime
 * objects, given the current switch". Every call site goes through here so a
 * paused plugin cannot be half-applied.
 *
 * @returns how many engines now carry the takeover (0 while paused).
 */
function applySwitch(ctx) {
	if (currentEnabled) {
		const applied = applyRatio(ctx, currentRatio);
		patchMeter(ctx);
		syncOutputRescue(ctx);
		return applied;
	}
	const restored = restoreEngines(ctx);
	unpatchMeters();
	syncOutputRescue(ctx);
	return restored;
}

/** The ratio the engines actually carry, falling back to the in-memory one. */
function effectiveRatio(ctx) {
	for (const engine of compactionEngines(ctx)) {
		const value = engine.config?.thresholdRatio;
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return currentRatio;
}

/**
 * Lowest ratio the slider may offer: the fixed floor, raised above any
 * engine's retained fraction. `resolveCompactSpec` throws when retention
 * reaches the threshold, so the two may never meet.
 */
function ratioFloor(ctx) {
	let floor = MIN_RATIO;
	for (const engine of compactionEngines(ctx)) {
		const retained = engine.config?.retainRatio;
		if (typeof retained === "number" && Number.isFinite(retained)) floor = Math.max(floor, Math.ceil((retained + 0.01) * 100) / 100);
	}
	return Math.min(floor, MAX_RATIO);
}

// ── token meter access ─────────────────────────────────────────────────────

/**
 * The process-wide token meter, or undefined when it is not mounted.
 *
 * Read through raw fiber stores first, for two reasons. It sidesteps every
 * realm question (`tokenMeter` is a host-plane service), and — decisively —
 * `ctx.get()` hands back a **fresh proxy on every call**, so wrapping that
 * return value would defeat the `WeakSet` in {@link patchMeter} and stack one
 * shadow per step. The store entry holds the stable instance, and every entry
 * for one service name points at that same object.
 */
function tokenMeterOf(ctx) {
	for (const runtime of ctx.registry.values()) {
		for (const fiber of runtime.fibers ?? []) {
			const impl = fiber.store?.tokenMeter;
			if (impl?.value !== undefined) return impl.value;
		}
	}
	return ctx.get("tokenMeter");
}

/**
 * The official session-projection registry (host of `contextPressure` and
 * friends), reached through raw fiber stores for the same reason as
 * {@link tokenMeterOf}.
 */
function projectionsOf(ctx) {
	const direct = ctx.get("sessionProjections");
	if (direct !== undefined) return direct;
	for (const runtime of ctx.registry.values()) {
		for (const fiber of runtime.fibers ?? []) {
			const impl = fiber.store?.sessionProjections;
			if (impl?.value !== undefined) return impl.value;
		}
	}
	return undefined;
}

/**
 * The occupancy the card is showing right now.
 *
 * The card reads the official `contextPressure` projection's `projectedTokens`
 * (falling back to `pressureTokens`). Its main term comes from the provider's
 * real prompt usage; only the surface movement since that sample is heuristic.
 * That is a different quantity from `measure().totalTokens`, which falls back
 * to pure heuristics whenever they over-estimate the real density — which on
 * real transcripts they do by 33%-72%, so compaction fires while the card still
 * reads ~50-60%. Reading the card's own number here is what lets
 * {@link patchMeter} make "the card reached the threshold" and "the engine
 * compacts" the same statement.
 */
function cardReadingOf(ctx, session) {
	const projections = projectionsOf(ctx);
	if (projections === undefined) return null;
	try {
		const view = projections.snapshot(session, ["contextPressure"])?.values?.contextPressure;
		if (view === undefined) return null;
		const totalTokens = view.projectedTokens ?? view.pressureTokens;
		if (typeof totalTokens !== "number") return null;
		return {
			totalTokens,
			contextWindow: typeof view.contextWindow === "number" ? view.contextWindow : null
		};
	} catch {
		return null;
	}
}

/** Meters already wrapped, so a re-asserted pre-step stays cheap. */
const patchedMeters = new WeakSet();

/**
 * Align `tokenMeter.measure().totalTokens` with the card's reading, so that the
 * slider's ratio means "the percentage the card shows".
 *
 * Only the instance's own property is shadowed, never the prototype, so other
 * meters are untouched; only `totalTokens` is replaced and every other field —
 * `nodes` above all — passes through, because `selectCompactableRange` and the
 * surface-stability checks read `nodes` exclusively. A call that supplies a
 * speculative `requestHeader` is left alone: the card's projection answers only
 * for what is durably logged, never for a hypothetical envelope.
 *
 * @returns whether the meter is wrapped (false while it is not mounted yet, so
 *   the next `agent/pre-step` can retry).
 */
function patchMeter(ctx) {
	const meter = tokenMeterOf(ctx);
	if (meter === undefined) return false;
	if (patchedMeters.has(meter)) return true;
	const original = meter.measure;
	if (typeof original !== "function") return false;
	meter.measure = function measure(session, requestHeader) {
		const measurement = original.call(this, session, requestHeader);
		if (requestHeader !== undefined) return measurement;
		const card = cardReadingOf(ctx, session);
		if (card === null) return measurement;
		if (card.contextWindow !== null) {
			contextWindows.set(session, card.contextWindow);
			contextWindowById.set(String(session.id), card.contextWindow);
		}
		if (card.totalTokens === measurement.totalTokens) return measurement;
		return Object.freeze({ ...measurement, totalTokens: card.totalTokens });
	};
	patchedMeters.add(meter);
	meterOriginals.set(meter, original);
	return true;
}

/** One `{ totalTokens, contextWindow }` reading, or null when unavailable. */
function readingOf(ctx, session) {
	const meter = tokenMeterOf(ctx);
	if (meter === undefined) return null;
	try {
		const measurement = meter.measure(session);
		const totalTokens = typeof measurement?.totalTokens === "number" ? measurement.totalTokens : null;
		if (totalTokens === null) return null;
		return { totalTokens, contextWindow: contextWindows.get(session) ?? null };
	} catch (error) {
		ctx.logger?.warn?.(`compact-suite: cannot measure the session surface: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/**
 * A read-only, truncated window onto one live Session's durable log.
 *
 * `TokenMeter.measure` and the projection registry are both pure replays over
 * `seq` + `eventAt`, so a window that stops at an old cursor answers exactly
 * what the card showed back then. The window is reused as the scan advances, so
 * the meter and the registry each fold the log once rather than once per
 * compaction.
 */
function historyView(session) {
	let cursor = 0;
	return {
		get seq() {
			return cursor;
		},
		get id() {
			return session.id;
		},
		get header() {
			return session.header;
		},
		get inheritedEventCount() {
			return session.inheritedEventCount ?? 0;
		},
		eventAt: (seq) => session.eventAt(seq),
		snapshotEvents: (from = 0, to = cursor) => session.snapshotEvents(from, to),
		/** Include every event up to and including `seq`, matching the live cursor. */
		through(seq) {
			cursor = seq + 1;
		}
	};
}

/** {@link readingOf} for a {@link historyView}, with the window taken from the card. */
function readingOfView(ctx, view) {
	const meter = tokenMeterOf(ctx);
	if (meter === undefined) return null;
	try {
		const measurement = meter.measure(view);
		const totalTokens = typeof measurement?.totalTokens === "number" ? measurement.totalTokens : null;
		if (totalTokens === null) return null;
		const card = cardReadingOf(ctx, view);
		return { totalTokens, contextWindow: typeof card?.contextWindow === "number" ? card.contextWindow : null };
	} catch {
		return null;
	}
}

/**
 * Rebuild the compactions a Session ran before this plugin was installed.
 *
 * The three compaction events are durable, so a Session that was already
 * compacted five times still carries all five brackets in its log. Replaying a
 * truncated window over that log therefore recovers the exact before/after the
 * card showed at the time — not an approximation — because both `measure()` and
 * the `contextPressure` projection are pure folds over the event list.
 *
 * Records already logged live are skipped by `compactionId`, so this is
 * idempotent and safe to call again after a reload.
 *
 * @returns the number of records added.
 */
function backfillSession(ctx, session) {
	const total = session.seq;
	if (!Number.isInteger(total) || total <= 0) return 0;
	const known = new Set(compactionLog.map((record) => record.id));
	const view = historyView(session);
	const found = [];
	const open = new Map();
	let contextWindow = null;

	/** A compaction whose `after` is still waiting for the next usage sample. */
	let awaiting = null;

	for (let seq = 0; seq < total; seq += 1) {
		const event = session.eventAt(seq);
		if (event === undefined) break;
		if (event.type === "request/context" && typeof event.data?.contextWindow === "number") {
			contextWindow = event.data.contextWindow;
		}
		// The post-compaction occupancy only settles once the provider reports
		// usage again; measuring at `end` would read the stale surface stamp.
		if (awaiting !== null && isUsageEvent(event)) {
			view.through(seq);
			const after = readingOfView(ctx, view);
			awaiting.after = after === null ? null : { ...after, contextWindow };
			if (!known.has(awaiting.id)) found.push(awaiting);
			awaiting = null;
		}
		if (event.type === "compaction/start") {
			view.through(seq);
			const before = readingOfView(ctx, view);
			open.set(event.data.compactionId, {
				id: event.data.compactionId,
				sessionId: sessionKeyOf(session),
				at: timeOf(event),
				turn: typeof event.data?.turn === "number" ? event.data.turn : null,
				before: before === null ? null : { ...before, contextWindow },
				historical: true
			});
			continue;
		}
		if (event.type === "compaction/summary") {
			const pending = open.get(event.data?.compactionId);
			if (pending !== undefined) applySummary(pending, event.data);
			continue;
		}
		if (event.type !== "compaction/end") continue;
		// Two compactions with no usage sample between them are not expected, but
		// never drop the earlier record on that account.
		if (awaiting !== null) {
			if (!known.has(awaiting.id)) found.push(awaiting);
			awaiting = null;
		}
		const pending = open.get(event.data?.compactionId);
		if (pending === undefined) continue;
		open.delete(event.data.compactionId);
		pending.error = event.data?.error === undefined ? null : errorTextOf(event.data.error);
		// A Session that ends right after compacting has no later usage event, so
		// keep the immediate reading as the fallback.
		view.through(seq);
		const immediate = readingOfView(ctx, view);
		// A compaction followed by another compaction's `end` -- or by the Session
		// ending -- before any usage sample is exactly the collapse window; this
		// fallback is where the historical `318K -> 0` records came from.
		pending.after = immediate === null || isCollapseArtifact(immediate, pending.before)
			? null
			: { ...immediate, contextWindow };
		awaiting = pending;
	}
	// A compaction that is the Session's last act keeps its immediate reading.
	if (awaiting !== null && !known.has(awaiting.id)) found.push(awaiting);

	if (found.length === 0) return 0;
	compactionLog = [...found.reverse(), ...compactionLog]
		.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
		.slice(0, LOG_LIMIT);
	writeStoredLog();
	ctx.logger?.info?.(`compact-suite: recovered ${found.length} earlier compaction(s) for ${sessionKeyOf(session) ?? "?"}`);
	return found.length;
}

/** The event's ISO timestamp, or null when it carries none. */
function timeOf(event) {
	return typeof event?.time === "number" && Number.isFinite(event.time) ? new Date(event.time).toISOString() : null;
}

/** Sessions already scanned, so a repeated log read does not rescan the log. */
const backfilledSessions = new Set();

/** The live Session with this id, or undefined when it is not mounted. */
function liveSession(ctx, sessionId) {
	for (const runtime of ctx.registry.values()) {
		for (const fiber of runtime.fibers ?? []) {
			const impl = fiber.store?.sessions;
			if (impl?.value === undefined) continue;
			try {
				const session = impl.value.get(sessionId);
				if (session !== undefined) return session;
			} catch {
				// A store entry that is not the SessionStore is simply skipped.
			}
		}
	}
	return undefined;
}

/**
 * Recover history for one Session once, then remember that it was done.
 *
 * Runs on demand — when the card first asks for that Session's log — so nothing
 * is scanned for sessions the user never opens.
 */
function ensureBackfilled(ctx, sessionId) {
	if (backfilledSessions.has(sessionId)) return;
	backfilledSessions.add(sessionId);
	try {
		const session = liveSession(ctx, sessionId);
		if (session !== undefined) backfillSession(ctx, session);
	} catch (error) {
		console.error("[dsh-compact-suite] cannot recover compaction history:", error);
	}
}

/** Attach the capacity the card divides by, when it is known. */
function percentOf(reading) {
	if (reading === null || typeof reading.contextWindow !== "number" || reading.contextWindow <= 0) return null;
	return Math.round(reading.totalTokens / reading.contextWindow * 100);
}

/**
 * Whether a reading is the post-compaction projection collapse, not a measurement.
 *
 * `TokenMeter` is patched to report the card's `contextPressure`, and until the
 * provider reports usage again that projection still carries the pre-compaction
 * surface stamp — the host documents the value as collapsing toward zero in that
 * window. A Session that just compacted 318K tokens is not empty, so a zero here
 * is the artifact.
 *
 * Keeping it was not merely ugly: `318K -> 0  -318K` claims the whole context was
 * removed and *understates* what is left, which is the dangerous direction — the
 * reader concludes there is far more room than there is. An unknown `after`
 * renders as an em dash, and the next usage sample still settles it properly.
 */
function isCollapseArtifact(reading, before) {
	const total = reading?.totalTokens;
	const prior = before?.totalTokens;
	return total === 0 && typeof prior === "number" && prior > 0;
}

// ── compaction log ─────────────────────────────────────────────────────────

/** The durable Session id, or null when the object carries none. */
function sessionKeyOf(session) {
	const id = session?.id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/** Flatten a logged `compaction/end` error into one displayable line. */
function errorTextOf(error) {
	if (typeof error === "string") return error;
	if (error !== null && typeof error === "object") {
		if (typeof error.message === "string") return error.message;
		try {
			return JSON.stringify(error);
		} catch {
			return "compaction failed";
		}
	}
	return "compaction failed";
}

/**
 * Fold a `compaction/summary` payload onto its pending record.
 *
 * @param reroutedSessionId - the Session whose live reroute slot to consult; absent
 *   for a backfilled record, whose reroute (if any) happened before this process.
 */
function applySummary(record, data, reroutedSessionId) {
	const shadowed = data?.shadowedTokenCount;
	record.shadowedTokens = typeof shadowed === "number" ? shadowed : null;
	const seqs = data?.shadowedSeqs;
	record.shadowedCount = Array.isArray(seqs) ? seqs.length : null;
	const range = data?.shadowedRange;
	record.shadowedRange = typeof range?.start === "number" && typeof range?.end === "number" ? { start: range.start, end: range.end } : null;
	const engineProvider = typeof data?.provider === "string" ? data.provider : null;
	const engineModel = typeof data?.model === "string" ? data.model : null;
	const rerouted = typeof reroutedSessionId === "string" ? reroutedFor.get(reroutedSessionId) : undefined;
	if (rerouted === undefined) {
		record.provider = engineProvider;
		record.model = engineModel;
		return;
	}
	// What actually served the summarization, not what the engine asked for.
	record.provider = rerouted.provider;
	record.model = rerouted.model;
	if (rerouted.provider !== engineProvider || rerouted.model !== engineModel) {
		// Keep the engine's claim so the disagreement stays inspectable rather than
		// becoming an invisible mismatch between this log and the session log.
		record.engineProvider = engineProvider;
		record.engineModel = engineModel;
	}
}

/**
 * Whether one event carries the provider's usage sample.
 *
 * Only such an event refreshes `pressureTokens` and its surface stamp together,
 * which is what makes a post-compaction reading trustworthy again.
 */
function isUsageEvent(event) {
	return event.type === "assistant/message" || event.type === "assistant/attempt";
}

/** Compactions whose `after` reading is still waiting for the next usage sample. */
const awaitingAfter = new WeakMap();

/**
 * Settle one queued compaction with the occupancy the card now reports.
 *
 * The record was already persisted at `compaction/end`, so this corrects it in
 * place rather than deferring the write — a Session that stops right after
 * compacting keeps a logged record instead of losing it.
 */
function settleQueued(ctx, session) {
	const queued = awaitingAfter.get(session);
	if (queued === undefined || queued.length === 0) return;
	awaitingAfter.delete(session);
	const settled = readingOf(ctx, session);
	if (settled === null) return;
	for (const record of queued) record.after = settled;
	writeStoredLog();
}

/**
 * Fold one session event into the compaction log.
 *
 * The three compaction events bracket the surface replacement: `start` fires
 * before summarization, `summary` carries the span that was shadowed, and
 * `end` fires after the replacement body has been appended. Measuring at
 * `start` and `end` therefore yields exactly the before/after context the
 * card reports. Anything else is ignored.
 */
function recordSessionEvent(ctx, session, event) {
	if (event.type === "request/context") {
		const contextWindow = event.data?.contextWindow;
		if (typeof contextWindow === "number" && contextWindow > 0) contextWindows.set(session, contextWindow);
		return;
	}
	// A post-compaction reading only becomes trustworthy once the provider has
	// reported usage again: until then the projection still holds the pre-
	// compaction surface stamp, so `projectedTokens` collapses toward zero.
	// `compaction/end` therefore queues the record and the next usage event
	// settles it with the occupancy the card actually settles on.
	if (isUsageEvent(event)) {
		try {
			settleQueued(ctx, session);
		} catch (error) {
			console.error("[dsh-compact-suite] cannot settle a compaction reading:", error);
		}
		return;
	}
	const compactionId = event.data?.compactionId;
	if (typeof compactionId !== "string") return;
	if (event.type === "compaction/start") {
		// Scope the reroute slot to the compaction in flight: a stale entry from an
		// earlier compaction must never label this one.
		const startedFor = sessionKeyOf(session);
		if (startedFor !== null) reroutedFor.delete(startedFor);
		// A start whose end never arrives (a crashed summarizer) would otherwise
		// pin its measurement forever; the cap keeps that bounded.
		if (pendingCompactions.size >= MAX_PENDING) pendingCompactions.clear();
		pendingCompactions.set(compactionId, {
			id: compactionId,
			sessionId: sessionKeyOf(session),
			at: new Date().toISOString(),
			turn: typeof event.data?.turn === "number" ? event.data.turn : null,
			before: readingOf(ctx, session)
		});
		return;
	}
	const pending = pendingCompactions.get(compactionId);
	if (pending === undefined) return;
	if (event.type === "compaction/summary") {
		applySummary(pending, event.data, sessionKeyOf(session));
		return;
	}
	if (event.type !== "compaction/end") return;
	pendingCompactions.delete(compactionId);
	pending.error = event.data?.error === undefined ? null : errorTextOf(event.data.error);
	// Keep the immediate reading as a fallback so a Session that ends right
	// after compacting still logs something; the next usage event overwrites it
	// with the settled value. The collapse artifact is dropped instead of stored,
	// because the record is persisted here and a Session that never reports usage
	// again would keep it forever.
	const immediateLive = readingOf(ctx, session);
	pending.after = isCollapseArtifact(immediateLive, pending.before) ? null : immediateLive;
	appendLog(pending);
	const queued = awaitingAfter.get(session);
	if (queued === undefined) awaitingAfter.set(session, [pending]);
	else queued.push(pending);
}

// ── trust fence (loopback / configured authority + same-origin markers) ────

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		if (typeof entry !== "string") return false;
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}

/**
 * Decide whether one request may reach the plugin routes: loopback (or a
 * configured trusted authority) Host header and same-origin browser markers.
 * DNS-rebinding / cross-site defense, not authentication.
 */
function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, Array.isArray(trustedHosts) ? trustedHosts : [])) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// ── JSON body / response helpers ───────────────────────────────────────────

/** Sentinel: the request body exceeded MAX_BODY_BYTES (respond 413, not 400). */
const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

/** Read a JSON request body, capped at MAX_BODY_BYTES. */
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
				resolve(PAYLOAD_TOO_LARGE);
				return;
			}
			if (!aborted) chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

/** Write a JSON response with the given status code. */
function writeJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}

/** One success envelope describing the current threshold. */
function statePayload(ctx, sessionId) {
	const engines = compactionEngines(ctx);
	const window = sessionId !== null && sessionId !== "" ? contextWindowById.get(String(sessionId)) ?? null : null;
	const ratio = currentEnabled ? effectiveRatio(ctx) : currentRatio;
	// Read the forced headroom back off the engines this plugin actually owns.
	// Taking engines[0] would report a value from an engine that was never
	// touched; disagreement between engines is itself worth surfacing.
	const ownedHeadrooms = engines
		.filter((engine) => engine.config?.[OWNED_BY_SUITE] === true)
		.map((engine) => engine.config.headroomTokens)
		.filter((value) => typeof value === "number");
	const headroom = ownedHeadrooms.length === 0 ? null : ownedHeadrooms[0];
	// `[].every()` is vacuously true — reporting "consistent" while nothing is
	// taken over would be the field lying during a pause.
	const headroomConsistent = ownedHeadrooms.length === 0
		? null
		: ownedHeadrooms.every((value) => value === headroom);
	const thresholdTokens = window === null ? null : Math.floor(window * ratio);
	return {
		ok: true,
		value: {
			version: STATE_VERSION,
			enabled: currentEnabled,
			thresholdRatio: ratio,
			minRatio: ratioFloor(ctx),
			maxRatio: MAX_RATIO,
			defaultRatio: FALLBACK_RATIO,
			engines: engines.length,
			// Transparency: the exact reserved-extra-pressure value this plugin forces.
			headroomTokens: headroom,
			headroomConsistent,
			// How many engines actually carry this plugin's marker.
			ownedEngines: ownedHeadrooms.length,
			contextWindow: window,
			thresholdTokens,
			// With the capacity term cancelled, `min()` must be picking the ratio
			// branch — unless the window is large enough that W*ratio approaches
			// the 1e6 cancellation. Report it instead of assuming.
			ratioIsBinding: thresholdTokens === null ? null : thresholdTokens <= 1000000,
			route: { provider: currentRoute.provider, model: currentRoute.model },
			// `listProviders` is a @Remote-decorated member; a throw here must not
			// take the whole state payload (and therefore the panel) down with it.
			providers: (() => {
				try {
					if (typeof ctx.llm?.listProviders !== "function") return [];
					return ctx.llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name }));
				} catch (error) {
					ctx.logger.warn(`compaction suite: cannot list providers: ${error instanceof Error ? error.message : String(error)}`);
					return [];
				}
			})(),
			// Lets the panel rebuild its busy state after a reload instead of
			// trusting a click it no longer remembers.
			compacting: sessionId !== null && sessionId !== "" && manualCompactions.has(String(sessionId)),
			outputRescue: outputRescueActive
		}
	};
}

/** One compaction record, shaped for the card's log view. */
function logEntry(record) {
	const before = record.before ?? null;
	const after = record.after ?? null;
	return {
		id: record.id,
		sessionId: record.sessionId ?? null,
		at: record.at,
		turn: record.turn ?? null,
		beforeTokens: before?.totalTokens ?? null,
		beforePercent: percentOf(before),
		afterTokens: after?.totalTokens ?? null,
		afterPercent: percentOf(after),
		contextWindow: before?.contextWindow ?? after?.contextWindow ?? null,
		savedTokens: before?.totalTokens != null && after?.totalTokens != null ? before.totalTokens - after.totalTokens : null,
		shadowedTokens: record.shadowedTokens ?? null,
		shadowedCount: record.shadowedCount ?? null,
		shadowedRange: record.shadowedRange ?? null,
		provider: record.provider ?? null,
		model: record.model ?? null,
		/** What the engine resolved; only set when it disagreed with `model` above. */
		engineProvider: record.engineProvider ?? null,
		engineModel: record.engineModel ?? null,
		error: record.error ?? null,
		/** True when rebuilt from the Session log rather than observed live. */
		historical: record.historical === true
	};
}

/** One success envelope describing the compaction log, newest first. */
function logPayload(sessionId) {
	const entries = compactionLog
		.filter((record) => sessionId === null || record.sessionId === sessionId)
		.map(logEntry);
	return { ok: true, value: { entries, total: entries.length, limit: LOG_LIMIT } };
}

/** Reject anything that is not a finite ratio inside the advertised band. */
function validateRatio(ctx, raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return "thresholdRatio must be a finite number";
	const floor = ratioFloor(ctx);
	if (raw < floor) return `thresholdRatio must be at least ${floor}`;
	if (raw > MAX_RATIO) return `thresholdRatio must be at most ${MAX_RATIO}`;
	return null;
}

// ── API ────────────────────────────────────────────────────────────────────

/**
 * Serve one request under {@link API_PREFIX}.
 *
 * `GET  /state` reports the live threshold, the slider band, and the mounted
 * engine count. `POST /state` with `{ thresholdRatio }` persists the value and
 * applies it to every live engine immediately. `GET /log` returns the recorded
 * compactions, optionally narrowed to one session with `?session=<id>`.
 */
/**
 * 用本 composition 自己的 `/compact` 命令压缩一个会话。
 *
 * 复用 `commands.execute` 而不是直接够 `compaction.compactNow`，换来三件直接调引擎
 * 拿不到的东西：
 *
 *  - compaction 缝被 isolate 在 agent preset 组内，根层 `ctx.get("compaction")`
 *    解析不到任何可调用的实例；
 *  - `dsh-command-compact` 已经把每一种预期失败（busy / cancelled / changed /
 *    summary / commit / persistence）归并成一句人话，并且把「没有可压缩历史」
 *    单独报出来；
 *  - 这次调用会作为 `command/run` + `command/done` 写进会话日志，所以按按钮和手打
 *    `/compact` 在记录里一样可追溯。
 *
 * `commands.execute` 是按 agent 解析命令的（`find(agent, name)`），这正是让
 * preset 组内注册的 `/compact` 在这里可见的原因。
 *
 * abort signal 刻意不用 HTTP 请求那一个：面板中途关掉，不应该取消一次已经开始替换
 * 历史的摘要。
 *
 * @returns `{ status, body }`，由调用方写出。
 */
async function compactSessionNow(ctx, sessionId) {
	const agent = ctx.agents.get(sessionId);
	if (agent === undefined) {
		return {
			status: 404,
			body: { ok: false, error: { code: "no-agent", message: `no live agent for session ${sessionId}` } }
		};
	}
	if (manualCompactions.has(sessionId)) {
		return {
			status: 409,
			body: { ok: false, error: { code: "already-running", message: "a manual compaction is already running for this session" } }
		};
	}
	manualCompactions.add(sessionId);
	try {
		const execution = await ctx.commands.execute(agent, "/compact", [], new AbortController().signal);
		if (execution === undefined) {
			return {
				status: 501,
				body: { ok: false, error: { code: "no-command", message: "/compact is not registered in this composition" } }
			};
		}
		return {
			status: 200,
			body: {
				ok: true,
				value: {
					commandId: execution.commandId,
					kind: execution.result.kind,
					text: typeof execution.result.text === "string" ? execution.result.text : null
				}
			}
		};
	} catch (error) {
		return {
			status: 500,
			body: {
				ok: false,
				error: { code: "compact-failed", message: error instanceof Error ? error.message : String(error) }
			}
		};
	} finally {
		manualCompactions.delete(sessionId);
	}
}

async function handleApi(ctx, req, res) {
	// `req.url` may or may not carry the registered prefix, depending on how
	// the web server strips it, so match the suffix rather than the full path.
	const [path, search = ""] = (req.url ?? "/").split("?");
	if (path.endsWith("/log")) {
		if (req.method !== "GET") {
			writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: `${req.method} is not supported` } });
			return;
		}
		const session = new URLSearchParams(search).get("session");
		if (session !== null && session !== "") ensureBackfilled(ctx, session);
		writeJson(res, 200, logPayload(session === null || session === "" ? null : session));
		return;
	}
	if (path.endsWith("/models")) {
		if (req.method !== "GET") {
			writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: `${req.method} is not supported` } });
			return;
		}
		const wanted = new URLSearchParams(search).get("provider");
		if (wanted === null || wanted === "") {
			writeJson(res, 200, { ok: true, value: [] });
			return;
		}
		try {
			const models = await ctx.llm.listModels(wanted);
			writeJson(res, 200, { ok: true, value: models.map((entry) => ({ id: entry.id, name: entry.name })) });
		} catch (error) {
			writeJson(res, 502, {
				ok: false,
				error: { code: "models-unavailable", message: error instanceof Error ? error.message : String(error) }
			});
		}
		return;
	}
	if (path.endsWith("/compact")) {
		if (req.method !== "POST") {
			writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: `${req.method} is not supported` } });
			return;
		}
		const session = new URLSearchParams(search).get("session");
		if (session === null || session === "") {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "?session=<id> is required" } });
			return;
		}
		const outcome = await compactSessionNow(ctx, session);
		// The summarization can outlive the panel that asked for it; a client that
		// already went away must not turn a completed compaction into a throw.
		if (res.writableEnded === true || res.destroyed === true) return;
		writeJson(res, outcome.status, outcome.body);
		return;
	}
	if (!path.endsWith("/state")) {
		writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown route ${path}` } });
		return;
	}
	if (req.method === "GET") {
		writeJson(res, 200, statePayload(ctx, new URLSearchParams(search).get("session")));
		return;
	}
	if (req.method !== "POST") {
		writeJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: `${req.method} is not supported` } });
		return;
	}
	const body = await readJsonBody(req);
	if (body === PAYLOAD_TOO_LARGE) {
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "request body is too large" } });
		return;
	}
	if (body === null || typeof body !== "object") {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "request body must be a JSON object" } });
		return;
	}
	const wantsRatio = body.thresholdRatio !== undefined;
	const wantsRoute = body.summarizationProvider !== undefined || body.summarizationModel !== undefined;
	const wantsEnabled = body.enabled !== undefined;
	if (!wantsRatio && !wantsRoute && !wantsEnabled) {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "no known field in request body" } });
		return;
	}
	if (wantsRatio) {
		const problem = validateRatio(ctx, body.thresholdRatio);
		if (problem !== null) {
			writeJson(res, 400, { ok: false, error: { code: "invalid-ratio", message: problem } });
			return;
		}
		currentRatio = body.thresholdRatio;
	}
	if (wantsRoute) {
		for (const key of ["summarizationProvider", "summarizationModel"]) {
			if (body[key] === undefined) continue;
			if (typeof body[key] !== "string") {
				writeJson(res, 400, { ok: false, error: { code: "invalid-route", message: `${key} must be a string` } });
				return;
			}
		}
		currentRoute = {
			provider: typeof body.summarizationProvider === "string" ? body.summarizationProvider.trim() : currentRoute.provider,
			model: typeof body.summarizationModel === "string" ? body.summarizationModel.trim() : currentRoute.model
		};
		reportRouteResolution(ctx);
	}
	if (wantsEnabled) {
		if (typeof body.enabled !== "boolean") {
			writeJson(res, 400, { ok: false, error: { code: "invalid-enabled", message: "enabled must be a boolean" } });
			return;
		}
		currentEnabled = body.enabled;
	}
	writeStoredState({
		enabled: currentEnabled,
		thresholdRatio: currentRatio,
		summarizationProvider: currentRoute.provider,
		summarizationModel: currentRoute.model
	});
	const touched = applySwitch(ctx);
	ctx.logger.info(currentEnabled
		? `compaction suite updated (ratio ${currentRatio}, ${touched} engine(s) taken over)`
		: `compaction suite paused (${touched} engine(s) restored)`);
	writeJson(res, 200, statePayload(ctx, new URLSearchParams(search).get("session")));
}

// ── 输出预算兜底 ──────────────────────────────────────────────────────────
//
// pi-ai 的 clampMaxTokensToContext 按「窗口减去估算已用」推出本次允许的输出量：
//
//   available = model.contextWindow - estimateContextTokens(context).tokens - 4096
//   maxTokens = min(请求上限, max(1, available))
//
// 估算器只在历史 assistant 的 usage 大于 0 时才肯采信它当锚点，而 DSH 重建历史
// 时把 usage 清零（replayedAssistant 返回 emptyPiUsage()），锚点因此全部失效，
// 估算退化成「字符数 ÷ 4」的全量猜测。真实内容密度约 6.5 字符/令牌，这一步就
// 高估约 30% —— 实测真实 155,633 令牌被判成 202,639，越过 200,000 的窗口，
// available 变成 -6,735，再被 max(1, …) 兜成 1。
//
// 请求于是带着 max_completion_tokens: 1 发出，上游只吐一个令牌就回
// finish_reason "length"，客户端据此显示「已达到输出 token 上限」：用户看到
// 一句「到上限了」，实际一个字都没拿到。
//
// 这里修在 fetch 层，因为它是唯一位于 clamp 之后的位置 —— 改 model、改配置或
// 修估算都要跟那个 Math.min 相斗，而这里改的是最终要离开进程的字节。触发条件
// 是 clamp 的产物本身（<= CLAMP_PRODUCT_CEILING），正常配置的输出上限远高于它。

/**
 * Raise a clamp-shrunk output cap inside one JSON request body.
 * @param bodyText - the raw body, when the caller supplied one as a string.
 * @returns the rewritten body, or null when nothing needed to change.
 */
function liftClampedOutputCap(bodyText) {
	if (typeof bodyText !== "string") return null;
	if (!bodyText.includes("max_completion_tokens") && !bodyText.includes("max_tokens")) return null;
	let params;
	try {
		params = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (params === null || typeof params !== "object") return null;
	let changed = false;
	for (const field of ["max_completion_tokens", "max_tokens"]) {
		if (typeof params[field] === "number" && params[field] <= CLAMP_PRODUCT_CEILING) {
			params[field] = outputFloorTokens;
			changed = true;
		}
	}
	return changed ? JSON.stringify(params) : null;
}

/**
 * Patch `globalThis.fetch` so an outgoing model request gets its clamped output
 * cap lifted before the bytes leave the process.
 * @param ctx - host cordis context, for the activation log line.
 * @returns a disposer restoring the original fetch, or null when unavailable.
 */
function installOutputBudgetRescue(ctx) {
	const original = globalThis.fetch;
	if (typeof original !== "function") {
		ctx.logger.warn("output budget rescue inactive: global fetch is unavailable");
		return null;
	}
	if (original[RESCUE_MARK] === true) {
		ctx.logger.info("output budget rescue already installed");
		return null;
	}
	let disabled = false;
	const patched = async function (input, init) {
		if (disabled) return original.call(this, input, init);
		const direct = liftClampedOutputCap(init?.body);
		if (direct !== null) return original.call(this, input, { ...init, body: direct });
		if (typeof Request === "function" && input instanceof Request) {
			let text;
			try {
				text = await input.clone().text();
			} catch {
				return original.call(this, input, init);
			}
			const lifted = liftClampedOutputCap(text);
			if (lifted !== null) return original.call(this, new Request(input, { body: lifted }), init);
		}
		return original.call(this, input, init);
	};
	patched[RESCUE_MARK] = true;
	globalThis.fetch = patched;
	outputRescueActive = true;
	ctx.logger.info(
		`output budget rescue active: an output cap shrunk to <= ${CLAMP_PRODUCT_CEILING} is lifted to the summarizer's own cap`
	);
	return () => {
		// Withdrawal has to work from any chain position. A later wrapper (a
		// transport shim, another plugin) captures `patched` as its own original, so
		// replacing globalThis.fetch would no longer reach us and this wrapper would
		// keep rewriting every request for the life of the process.
		disabled = true;
		outputRescueActive = false;
		if (globalThis.fetch === patched) globalThis.fetch = original;
	};
}

// ── entry ──────────────────────────────────────────────────────────────────

/**
 * Warn once per distinct route when its provider is not composed.
 *
 * The route is validated only as a non-empty string pair, so a typo stores happily
 * and every compaction summary then fails at the adapter -- while the startup line
 * asserted the routing was in effect without checking anything.
 */
let routeWarnedFor = null;
function reportRouteResolution(ctx) {
	if (!currentEnabled) return;
	const provider = currentRoute.provider.trim();
	const model = currentRoute.model.trim();
	if (provider.length === 0 || model.length === 0) return;
	const key = `${provider}/${model}`;
	if (routeWarnedFor === key) return;
	let providers;
	try {
		if (typeof ctx.llm?.listProviders !== "function") return;
		providers = ctx.llm.listProviders();
	} catch {
		return;
	}
	if (!Array.isArray(providers)) return;
	routeWarnedFor = key;
	if (providers.some((entry) => entry.id === provider)) return;
	ctx.logger?.warn?.(
		`compact-suite: summaries are routed to ${key}, but no provider named "${provider}" is composed -- every compaction summary will fail until this is corrected`
	);
}

/**
 * Host loader entry: mount the threshold API, record every compaction, and keep
 * every live compaction engine on the stored ratio.
 * @param ctx - host cordis context (webServer, webRuntime).
 */
export function apply(ctx, config = {}) {
	// ── 压缩模型路由（相对 dsh-compaction-threshold 新增）──────────────────
	const routeOf = () => {
		if (!currentEnabled) return undefined;
		const provider = currentRoute.provider.trim();
		const model = currentRoute.model.trim();
		if (provider.length === 0 || model.length === 0) return undefined;
		return { provider, model };
	};
	ctx.effect(() => installCompactRouter(ctx, routeOf), "dsh-compact-suite: compaction model router");
	{
		const route = routeOf();
		ctx.logger.info(route === undefined
			? "compaction summaries follow the session model (no dedicated route configured)"
			: `compaction summaries routed to ${route.provider}/${route.model}`);
		reportRouteResolution(ctx);
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			try {
				await handleApi(ctx, req, res);
			} catch (error) {
				console.error("[dsh-compact-suite] threshold API error:", error);
				writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
			}
		}
	}), "dsh-compact-suite: threshold API route");

	compactionLog = readStoredLog();

	// State precedence: the state file wins, the plugin config is the fallback,
	// and a v1 file (or a first run) is adopted and rewritten as v2 so the panel
	// opens on real values instead of blanks.
	const stored = readStoredState();
	const configRatio = typeof config.thresholdRatio === "number" && Number.isFinite(config.thresholdRatio)
		? config.thresholdRatio
		: FALLBACK_RATIO;
	const rawRatio = typeof stored.thresholdRatio === "number" && Number.isFinite(stored.thresholdRatio)
		? stored.thresholdRatio
		: configRatio;
	currentRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, rawRatio));
	currentRoute = {
		provider: typeof stored.summarizationProvider === "string"
			? stored.summarizationProvider
			: (typeof config.summarizationProvider === "string" ? config.summarizationProvider : ""),
		model: typeof stored.summarizationModel === "string"
			? stored.summarizationModel
			: (typeof config.summarizationModel === "string" ? config.summarizationModel : "")
	};
	currentEnabled = typeof stored.enabled === "boolean" ? stored.enabled : true;

	if (stored.version !== STATE_VERSION) {
		writeStoredState({
			enabled: currentEnabled,
			thresholdRatio: currentRatio,
			summarizationProvider: currentRoute.provider,
			summarizationModel: currentRoute.model
		});
		ctx.logger.info(`compaction suite state upgraded to v${STATE_VERSION}`);
	}

	const applied = currentEnabled ? applyRatio(ctx, currentRatio) : 0;
	ctx.logger.info(currentEnabled
		? `compaction threshold ${currentRatio} applied to ${applied} engine(s)`
		: "compaction takeover paused; engines left untouched");

	// Self-check: the takeover writes `engine.config` by replacement, and the
	// -1e6 sentinel deliberately bypasses config validation. If a future host
	// makes that property accessor-validated the write would be rejected
	// silently, leaving a plugin that looks active but changes nothing.
	if (currentEnabled) {
		const rejected = compactionEngines(ctx).filter((engine) =>
			engine.config !== undefined && engine.config[OWNED_BY_SUITE] !== true);
		if (rejected.length > 0) {
			ctx.logger.warn(`compaction suite: ${rejected.length} engine(s) did not accept the threshold override — the takeover is not in effect for them`);
		}
	}

	// Release everything this plugin changed when it is disabled or disposed.
	// Disabling a plugin must not leave the live engines mutated.
	ctx.effect(() => () => {
		const restored = restoreEngines(ctx);
		unpatchMeters();
		ctx.logger.info(`compaction suite released (restored ${restored} engine(s))`);
	}, "dsh-compact-suite: release engines and meter on dispose");

	// 输出预算兜底：在请求离开进程前，把被 clamp 夹到底的输出上限抬回来。
	// The rescue wraps globalThis.fetch, so its lifetime follows the switch
	// instead of being installed unconditionally.
	ctx.effect(() => {
		syncOutputRescue(ctx);
		return () => {
			if (outputRescueDispose !== null) {
				outputRescueDispose();
				outputRescueDispose = null;
			}
		};
	}, "dsh-compact-suite: output budget rescue");

	// Wrap the meter now when it is already mounted, so readings are card-aligned
	// before the first step; the pre-step hook below retries otherwise. While the
	// plugin is paused the meter is deliberately left alone.
	if (currentEnabled && !patchMeter(ctx)) {
		ctx.logger.info("token meter not mounted yet; will align it on the first step");
	}

	// `session/event` carries every durable append, including the compaction
	// lifecycle this plugin logs. `global` lifts the realm filter so the
	// listener also sees sessions owned by an isolated preset.
	ctx.on("session/event", (session, event) => {
		try {
			recordSessionEvent(ctx, session, event);
		} catch (error) {
			console.error("[dsh-compact-suite] cannot record a session event:", error);
		}
	}, { global: true });

	// Re-assert before every step, ahead of the engine's own listener, so a
	// preset mounted later — or reloaded with a fresh config snapshot — picks
	// the ratio up before its compaction decision reads it, and so the meter is
	// already card-aligned when that decision measures the session. `global`
	// lifts the realm filter that would otherwise confine a host-plane listener.
	ctx.on("agent/pre-step", (_payload, next) => {
		// Guarded: before this fix the unconditional call here silently undid
		// "pause" on the very next step.
		if (currentEnabled) {
			applyRatio(ctx, currentRatio);
			patchMeter(ctx);
		}
		return next();
	}, { global: true, prepend: true });
}
