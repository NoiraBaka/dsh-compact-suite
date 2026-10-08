/**
 * 压缩记录里的 `after` 是怎么来的 —— 一个会真跑事件处理函数的夹具。
 *
 * 它不重写逻辑：从 `lib/index.js` 里按名字抽出**真正的** `recordSessionEvent` /
 * `settleQueued` / `backfillSession` / `logEntry` 和它们依赖的模块级状态，装进一个
 * `new Function` 作用域里，配一个假的 `TokenMeter`，然后按真实顺序喂事件。
 * 日志文件真的写到临时 `$DSH_HOME` 下，所以「面板看到的那一行」和「磁盘上的那一行」
 * 都会被断言。
 *
 * 钉住的事故（2026-10-08）：一次 514K 的手动压缩，面板记成 `514K -> 142K  -371K`。
 * `after` 是 `compaction/end` 那一刻从卡片的 `contextPressure` 投影里读的，而那时
 * 供应商还没为新表面报过量。真实结清值是 24K —— 记录后来被改对了，但**当时显示在
 * 屏幕上的数字是假的**，而且它看起来完全可信。现在这个窗口里不写任何数字。
 *
 * 用法：
 *   node test/log-after.mjs [要检查的 lib/index.js 路径]
 *
 * 传入旧版本文件时应当**失败**——这正是它存在的意义。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(here, "..", "lib", "index.js");
const source = readFileSync(target, "utf8");

const HOME = join(tmpdir(), "dsh-compact-suite-log-after");
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;
const LOG_FILE = join(HOME, "compaction-log.json");

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

const CONSTANTS = ["LOG_FILENAME", "LOG_LIMIT", "MAX_PENDING"];
const STATE = [
	"compactionLog",
	"pendingCompactions",
	"awaitingAfter",
	"contextWindows",
	"lastAfterById",
	"overflowSessions",
	"reroutedFor",
	"contextWindowById"
];
const FUNCTIONS = [
	"dshHome",
	"logPath",
	"writeStoredLog",
	"appendLog",
	"tokenMeterOf",
	"readingOf",
	"readingOfView",
	"historyView",
	"isUsageEvent",
	"isCollapseArtifact",
	"sessionKeyOf",
	"timeOf",
	"errorTextOf",
	"triggerOf",
	"noteAfterBaseline",
	"applySummary",
	"settleQueued",
	"recordSessionEvent",
	"backfillSession",
	"percentOf",
	"logEntry",
	"logPayload"
];

const pieces = [];
for (const name of CONSTANTS) pieces.push(sliceDeclaration(source, name));
for (const name of STATE) pieces.push(sliceDeclaration(source, name));
for (const name of FUNCTIONS) pieces.push(sliceFunction(source, name));

const body = `
const __meter = {
	totalTokens: 0,
	/** 回放用的时间表：\`view.seq\`（游标）-> 该游标处的读数。 */
	schedule: null,
	measure(target) {
		const cursor = target === undefined ? undefined : target.seq;
		if (this.schedule !== null && typeof cursor === "number") {
			const at = this.schedule.get(cursor);
			if (at !== undefined) return { totalTokens: at };
		}
		return { totalTokens: this.totalTokens };
	}
};
const __ctx = { registry: new Map(), get: () => __meter, logger: { warn() {} } };
const __live = {
	id: "s-live",
	header: {},
	inheritedEventCount: 0,
	seq: 0,
	eventAt: () => undefined,
	snapshotEvents: () => []
};
let __events = [];
const __history = {
	id: "s-hist",
	header: {},
	inheritedEventCount: 0,
	get seq() { return __events.length; },
	eventAt: (index) => __events[index],
	snapshotEvents: () => []
};
/** 回放路径不测的旁路。 */
function cardReadingOf() { return { contextWindow: 1000000 }; }
function publishSessionFacts() {}

${pieces.join("\n")}

return {
	extracted: ${JSON.stringify(FUNCTIONS)},
	ctx: __ctx,
	live: __live,
	history: __history,
	setReading: (tokens) => { __meter.totalTokens = tokens; },
	setSchedule: (pairs) => { __meter.schedule = pairs === null ? null : new Map(pairs); },
	setEvents: (list) => { __events = list; },
	records: () => compactionLog,
	reset: () => { compactionLog = []; pendingCompactions.clear(); },
	recordSessionEvent,
	backfillSession,
	payload: (session) => logPayload(session)
};
`;

const scope = new Function(
	"join",
	"homedir",
	"dirname",
	"readFileSync",
	"writeFileSync",
	"mkdirSync",
	"renameSync",
	body
)(join, homedir, dirname, readFileSync, writeFileSync, mkdirSync, renameSync);

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

/** 磁盘上的原始记录（不是内存里的那一份）。 */
function onDisk() {
	try {
		return JSON.parse(readFileSync(LOG_FILE, "utf8")).records;
	} catch {
		return null;
	}
}

const BEFORE = 513692;
const STALE = 142300;
const SETTLED = 23711;

function start(id, turn = null) {
	return { type: "compaction/start", data: { compactionId: id, turn } };
}
function summary(id, count = 929) {
	return {
		type: "compaction/summary",
		data: {
			compactionId: id,
			shadowedTokenCount: 378018,
			shadowedSeqs: Array.from({ length: count }, (_, i) => i),
			shadowedRange: { start: 10724, end: 13154 },
			provider: "deepseek-account",
			model: "deepseek-flash"
		}
	};
}
const end = (id) => ({ type: "compaction/end", data: { compactionId: id } });
const usage = () => ({ type: "assistant/message", data: {} });

// ── 1. 压缩结束时不得写 after：那一刻的投影还在旧表面上 ──────────────────────

section("1. compaction/end 不写 after（142K 那次事故的现场）");
scope.reset();
scope.setReading(BEFORE);
scope.recordSessionEvent(scope.ctx, scope.live, start("c1"));
scope.recordSessionEvent(scope.ctx, scope.live, summary("c1"));
// 卡片的 contextPressure 现在给出的正是那个「看起来完全可信」的假读数。
scope.setReading(STALE);
scope.recordSessionEvent(scope.ctx, scope.live, end("c1"));

const atEnd = scope.records()[0];
check(atEnd !== undefined, "压缩已经落进记录");
check(atEnd?.after === null, "结束时的 after 是 null，而不是 142300", `after=${JSON.stringify(atEnd?.after)}`);
check(atEnd?.before?.totalTokens === BEFORE, "before 仍然是真实读数", `before=${atEnd?.before?.totalTokens}`);
check(atEnd?.shadowedCount === 929, "shadowed 仍然被记下来", `count=${atEnd?.shadowedCount}`);

const rowAtEnd = scope.payload("s-live").value.entries[0];
check(rowAtEnd?.afterTokens === null, "面板收到 afterTokens=null（渲染成破折号）", `afterTokens=${JSON.stringify(rowAtEnd?.afterTokens)}`);
check(rowAtEnd?.savedTokens === null, "面板不会算出一个假的节省量", `savedTokens=${JSON.stringify(rowAtEnd?.savedTokens)}`);

const diskAtEnd = onDisk();
check(diskAtEnd?.[0]?.after === null, "磁盘上也还没有 after（重启不会把假数字读回来）", `after=${JSON.stringify(diskAtEnd?.[0]?.after)}`);

// ── 2. 下一个用量采样才结清 ────────────────────────────────────────────────

section("2. 下一个用量采样把它结清");
scope.setReading(SETTLED);
scope.recordSessionEvent(scope.ctx, scope.live, usage());

const settled = scope.records()[0];
check(settled?.after?.totalTokens === SETTLED, "after 变成了真实读数", `after=${settled?.after?.totalTokens}`);
const rowSettled = scope.payload("s-live").value.entries[0];
check(rowSettled?.afterTokens === SETTLED, "面板拿到 24K", `afterTokens=${rowSettled?.afterTokens}`);
check(rowSettled?.savedTokens === BEFORE - SETTLED, "节省量按真实读数算", `saved=${rowSettled?.savedTokens}`);
check(onDisk()?.[0]?.after?.totalTokens === SETTLED, "结清的值也落盘了");

// ── 3. 收敛中的 0 不是测量：留在队列里等下一个采样 ─────────────────────────

section("3. 投影收敛到 0 时不得当成测量");
scope.reset();
scope.setReading(BEFORE);
scope.recordSessionEvent(scope.ctx, scope.live, start("c2"));
scope.recordSessionEvent(scope.ctx, scope.live, end("c2"));
scope.setReading(0);
scope.recordSessionEvent(scope.ctx, scope.live, usage());
check(scope.records()[0]?.after === null, "0 没有被写进去", `after=${JSON.stringify(scope.records()[0]?.after)}`);
scope.setReading(25000);
scope.recordSessionEvent(scope.ctx, scope.live, usage());
check(scope.records()[0]?.after?.totalTokens === 25000, "下一个采样仍然能结清同一条记录", `after=${scope.records()[0]?.after?.totalTokens}`);

// ── 4. 失败的压缩同样不写 after ────────────────────────────────────────────

section("4. 失败的压缩");
scope.reset();
scope.setReading(BEFORE);
scope.recordSessionEvent(scope.ctx, scope.live, start("c3", 12));
scope.setReading(STALE);
scope.recordSessionEvent(scope.ctx, scope.live, { type: "compaction/end", data: { compactionId: "c3", error: "DeepSeek Messages request aborted" } });
const failed = scope.records()[0];
check(failed?.error === "DeepSeek Messages request aborted", "错误被记下来");
check(failed?.after === null, "失败行没有 after", `after=${JSON.stringify(failed?.after)}`);
check(scope.payload("s-live").value.entries[0]?.error === "DeepSeek Messages request aborted", "面板走的是失败分支");

// ── 5. 回放（重启后补历史）遵守同一条规则 ──────────────────────────────────

section("5. 回放：没有后续用量采样就不猜");
scope.reset();
scope.setEvents([
	{ type: "compaction/start", time: 1, data: { compactionId: "h1", turn: null } },
	{ type: "compaction/summary", time: 2, data: { compactionId: "h1", shadowedTokenCount: 378018, shadowedSeqs: [1, 2, 3], shadowedRange: { start: 1, end: 3 }, provider: "deepseek-account", model: "deepseek-flash" } },
	{ type: "compaction/end", time: 3, data: { compactionId: "h1" } }
]);
scope.setSchedule([[1, BEFORE]]);
scope.backfillSession(scope.ctx, scope.history);
const backfilled = scope.records()[0];
check(backfilled?.historical === true, "记录被补出来了");
check(backfilled?.before?.totalTokens === BEFORE, "before 来自回放当时的那一刻", `before=${backfilled?.before?.totalTokens}`);
check(backfilled?.after === null, "没有用量采样就没有 after", `after=${JSON.stringify(backfilled?.after)}`);

section("5b. 回放：有后续用量采样就结清");
scope.reset();
scope.setEvents([
	{ type: "compaction/start", time: 1, data: { compactionId: "h2", turn: null } },
	{ type: "compaction/summary", time: 2, data: { compactionId: "h2", shadowedTokenCount: 378018, shadowedSeqs: [1, 2, 3], shadowedRange: { start: 1, end: 3 }, provider: "deepseek-account", model: "deepseek-flash" } },
	{ type: "compaction/end", time: 3, data: { compactionId: "h2" } },
	{ type: "assistant/message", time: 4, data: {} }
]);
scope.setSchedule([[1, BEFORE], [4, SETTLED]]);
scope.backfillSession(scope.ctx, scope.history);
const replayed = scope.records()[0];
check(replayed?.after?.totalTokens === SETTLED, "回放用的是那个采样点的读数", `after=${replayed?.after?.totalTokens}`);

// ── 6. 抽取到的函数确实是生效的那一份 ──────────────────────────────────────

section("6. 夹具抽的是真货");
for (const name of FUNCTIONS) {
	const hits = source.split(`function ${name}(`).length - 1;
	check(hits === 1, `${name} 在源文件里只声明了一次`, `找到 ${hits} 次`);
}

// ── 收尾 ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
