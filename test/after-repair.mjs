/**
 * 「压缩后占用永远停在计算中」的回归夹具。
 *
 * 与 host-policy.mjs / quiet-effort.mjs 同一套路：从 `lib/index.js` 里抽**真正的**函数，
 * 装进 `new Function` 作用域里跑。
 *
 * 钉住的是一条真实踩到的性质：宿主把待结算记录放在 `awaitingAfter` 里，那是个
 * **内存 WeakMap，键是会话对象本身**。进程一重启、或者会话对象被重建，队列就没了，
 * `settleQueued` 之后只会找到一个空队列 —— 而全文件**没有第二处**会写 `after`。
 * 于是那条记录永远显示「计算中」，面板还一直承诺「下一条消息发出后自动补上」。
 *
 * 回放是唯一还记得正确数值的地方：它在**用量事件紧跟压缩结束**的那个 seq 上测，
 * 所以那个读数属于那一次压缩，而不是会话几天之后的占用。`repairStoredAfter` 就是
 * 把这个读数落回存储记录的那一步。
 *
 * 三条不能破的边界：
 *   1. 已经结清的记录**不许**被回放覆盖 —— 它的值是 `settleQueued` 现场测的，证据更强。
 *   2. 回放没测到（null / 非数字）时什么都不写。
 *   3. 塌缩伪影（`totalTokens === 0` 而 before 大于 0）不许写 —— 这正是文档里
 *      「514K 被记成 142K」那类错数的来源。
 *
 * 用法：
 *   node test/after-repair.mjs [要检查的 lib/index.js 路径]
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

/** `backfillSession` 太依赖真实会话对象，跑不起来，只能钉它的接线。 */
const BACKFILL = sliceFunction(source, "backfillSession");

const DECLARATIONS = ["lastAfterById"];
const FUNCTIONS = ["isCollapseArtifact", "noteAfterBaseline", "repairStoredAfter"];

const pieces = [];
for (const name of DECLARATIONS) pieces.push(sliceDeclaration(source, name));
for (const name of FUNCTIONS) pieces.push(sliceFunction(source, name));

const body = `
${pieces.join("\n")}
return { isCollapseArtifact, noteAfterBaseline, repairStoredAfter, lastAfterById };
`;

const scope = new Function(body)();
const { isCollapseArtifact, repairStoredAfter, lastAfterById } = scope;

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

const reading = (totalTokens, contextWindow = 1048576) => ({ totalTokens, contextWindow });

// ── 1. 补得上 ──────────────────────────────────────────────────────────────
console.log("\n回放读数落回存储记录");
{
	const stored = {
		id: "c1",
		sessionId: "session-a",
		before: reading(134602),
		after: null,
		error: null
	};
	const changed = repairStoredAfter(stored, reading(23333));

	check("空 after 被回放读数填上", changed === true);
	check("填进去的就是回放测到的那个值", stored.after?.totalTokens === 23333,
		`实际 ${stored.after?.totalTokens}`);
	check("会话的「最后一次结清值」基线跟着更新", lastAfterById.get("session-a") === 23333,
		`实际 ${lastAfterById.get("session-a")}`);
}

// ── 2. 现场测到的值不许被覆盖 ──────────────────────────────────────────────
console.log("\n已经结清的记录");
{
	const stored = { id: "c2", sessionId: "session-b", before: reading(313000), after: reading(24925), error: null };
	const changed = repairStoredAfter(stored, reading(999999));

	check("已结清的 after 不被回放改写", changed === false && stored.after.totalTokens === 24925,
		`实际 ${stored.after.totalTokens}`);
}

// ── 3. 回放没测到就什么都不写 ──────────────────────────────────────────────
console.log("\n回放没测到");
{
	const a = { id: "c3", sessionId: "session-c", before: reading(500000), after: null, error: null };
	const b = { id: "c4", sessionId: "session-c", before: reading(500000), after: null, error: null };

	check("null 读数不写", repairStoredAfter(a, null) === false && a.after === null);
	check("非数字读数不写", repairStoredAfter(b, reading(undefined)) === false && b.after === null);
	check("记录不存在时不抛错也不写", repairStoredAfter(undefined, reading(1000)) === false
		&& repairStoredAfter(null, reading(1000)) === false);
	check("这一轮没有改动，基线也没被动过", lastAfterById.get("session-c") === undefined,
		`实际 ${lastAfterById.get("session-c")}`);
}

// ── 4. 塌缩伪影不许写 ──────────────────────────────────────────────────────
console.log("\n塌缩伪影");
{
	const before = reading(514000);
	const artifact = reading(0);
	const stored = { id: "c6", sessionId: "session-d", before, after: null, error: null };

	check("before 是正数时的 0 判为伪影", isCollapseArtifact(artifact, before) === true);
	check("真伪影不写进记录", repairStoredAfter(stored, artifact) === false && stored.after === null);

	// 真实的 0 占用（before 本来就是 0）不是伪影，只是少见；不许连它一起挡掉，
	// 否则全新会话上第一次压缩就永远结不清。
	const zeroStart = { id: "c7", sessionId: "session-e", before: reading(0), after: null, error: null };
	check("before 也是 0 时不算伪影（全空会话）",
		repairStoredAfter(zeroStart, reading(0)) === true && zeroStart.after.totalTokens === 0);
}

// ── 5. 接线：回放必须真的调用它，且只重排最后一条 ──────────────────────────
//
// 这一段是结构断言，不是行为断言：`backfillSession` 需要真实会话对象与 token meter，
// 在本夹具里跑不起来。它挡的是「以后重构时把这一步丢掉」——那正是这个缺陷的成因。
console.log("\nbackfillSession 的接线");
{
	const callsRepair = /repairStoredAfter\(\s*storedById\.get\(awaiting\.id\)\s*,/.test(BACKFILL);
	check("已知 id 的分支把回放读数交给 repairStoredAfter", callsRepair);

	const keepsUnmeasured = /storedTrailing\.after\s*==\s*null\s*&&\s*storedTrailing\.error\s*==\s*null/.test(BACKFILL);
	check("重排只收「after 与 error 都为空」的那条", keepsUnmeasured,
		"失败过的记录不能进队列，否则会被下一次用量采样改写");

	const persists = /if\s*\(repaired\s*>\s*0\)\s*\{\s*writeStoredLog\(\)/.test(BACKFILL);
	check("补到东西就落盘（不落盘等于没修）", persists);

	const requeuesStored = /awaitingAfter\.set\(session,\s*\[storedTrailing\]\)/.test(BACKFILL);
	check("重排的是存储记录本身，不是回放的副本", requeuesStored,
		"settleQueued 必须改到 compactionLog 里那个对象");
}

// ── 结果 ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} 项通过${failures.length === 0 ? " ✅" : `，${failures.length} 项失败 ❌`}`);
if (failures.length > 0) {
	for (const label of failures) console.log(`  - ${label}`);
	process.exitCode = 1;
}
