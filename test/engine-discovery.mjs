/**
 * Engine discovery across cordis shapes.
 *
 * The panel's "未找到压缩引擎 —— compaction-basic 可能没挂载。" is produced when
 * `compactionEngines` comes back empty, and that list is read straight off
 * cordis internals. Those internals moved:
 *
 *   cordis <  4.1   fiber.store.compaction        Dict<Impl>, keyed by name
 *   cordis >= 4.1   fiber.provisions              Set<Impl>, Impl carries `name`
 *                   fiber.committed               Dict<Impl>
 *
 * The move is silent — the old accessor simply yields `undefined` — so a stale
 * reader keeps working on old hosts and reports "no engine" on new ones while
 * compaction-basic is mounted and compacting. DSH 0.2.2 ships cordis 4.1, and
 * that is exactly the state this fixture pins down.
 *
 * `rawService` is the single reader for that; `tokenMeterOf`, `projectionsOf`
 * and `liveSession` go through it too, so all four services are covered here.
 *
 * The fixture runs the REAL functions sliced out of `lib/index.js`, so it
 * cannot drift from the shipped code the way a copy would.
 *
 * Run: node test/engine-discovery.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "lib", "index.js"), "utf8");

let failures = 0;
function check(name, ok, detail) {
	console.log("  " + (ok ? "\u2705" : "\u274c") + " " + name + (detail === undefined ? "" : "\u3000" + detail));
	if (!ok) failures++;
}

/** Slice a top-level `function name(...) { ... }` out of the shipped source. */
function sliceFunction(text, name) {
	const at = text.indexOf("function " + name + "(");
	if (at < 0) throw new Error("fixture cannot find function " + name);
	const open = text.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(at, i + 1); }
	}
	throw new Error("unbalanced braces in " + name);
}

const rawSource = sliceFunction(SOURCE, "rawService");
const enginesSource = sliceFunction(SOURCE, "compactionEngines");
const rawService = new Function(rawSource + "; return rawService;")();
const compactionEngines = new Function(rawSource + "\n" + enginesSource + "; return compactionEngines;")();

/** A provision record in the shape cordis' `Impl` interface describes. */
function impl(name, value) {
	return { uid: Math.random(), name, ctx: {}, dependents: new Set(), value, isolate: Symbol(name) };
}
function ctxOf(fibers) {
	return { registry: { values: () => [{ fibers: new Set(fibers) }] } };
}

// \u2500\u2500 rawService: the three trailing shapes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
{
	const engine = { kind: "basic" };
	const record = impl("compaction", engine);
	const got = rawService({ provisions: new Set([record, impl("tokenMeter", {})]) }, "compaction");
	check("reads a provision out of `fiber.provisions`", got === record);
}
{
	const record = impl("compaction", { kind: "committed" });
	const got = rawService({ committed: { compaction: impl("compaction", { kind: "wrong" }) } }, "compaction");
	check("reads the fibre's own `committed` entry by name", got?.value?.kind === "wrong");
}
{
	const record = impl("tokenMeter", { kind: "legacy" });
	const got = rawService({ store: { tokenMeter: record } }, "tokenMeter");
	check("still reads the legacy `fiber.store` entry", got === record);
}
{
	check("returns undefined for a service the fiber does not own",
		rawService({ provisions: new Set([impl("something", {})]) }, "compaction") === undefined);
}
{
	const record = impl("compaction", undefined);
	check("skips a provision whose value is still unassigned",
		rawService({ provisions: new Set([record]) }, "compaction") === undefined);
}
{
	check("tolerates an empty/absent fiber record",
		rawService(undefined, "compaction") === undefined && rawService({}, "compaction") === undefined);
}

// \u2500\u2500 compactionEngines over those shapes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
{
	const engine = { kind: "provisioned" };
	const ctx = ctxOf([{ provisions: new Set([impl("compaction", engine)]) }]);
	const found = compactionEngines(ctx);
	check("finds an engine held in `fiber.provisions`", found.length === 1 && found[0] === engine, "count=" + found.length);
}
{
	const engine = { kind: "legacy" };
	const ctx = ctxOf([{ store: { compaction: impl("compaction", engine) } }]);
	const found = compactionEngines(ctx);
	check("still finds an engine held in the legacy `fiber.store`", found.length === 1 && found[0] === engine);
}
{
	const engine = { kind: "both" };
	const record = impl("compaction", engine);
	const ctx = ctxOf([{ provisions: new Set([record]), committed: { compaction: record }, store: { compaction: record } }]);
	const found = compactionEngines(ctx);
	check("deduplicates one engine seen through three records", found.length === 1, "count=" + found.length);
}
{
	const a = { kind: "preset-a" };
	const b = { kind: "preset-b" };
	const ctx = {
		registry: {
			values: () => [
				{ fibers: new Set([{ provisions: new Set([impl("compaction", a)]) }]) },
				{ fibers: new Set([{ provisions: new Set([impl("compaction", b)]) }]) }
			]
		}
	};
	const found = compactionEngines(ctx);
	check("collects one engine per mounted preset", found.length === 2 && found[0] === a && found[1] === b, "count=" + found.length);
}
{
	const ctx = { registry: { values: () => [{ fibers: undefined }, { fibers: new Set([{}]) }] } };
	let threw = null;
	try { compactionEngines(ctx); } catch (err) { threw = err; }
	check("an unloaded/empty fiber record does not throw", threw === null, threw === null ? "" : String(threw));
}

// \u2500\u2500 no call site may go back to the removed accessor \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
{
	const direct = SOURCE.match(/fiber\.store\?\./g) ?? [];
	check("no call site reads `fiber.store?.<name>` any more", direct.length === 0, "found=" + direct.length);
}
{
	const users = ["tokenMeterOf", "projectionsOf", "liveSession"].filter((name) => {
		const body = sliceFunction(SOURCE, name);
		return !/rawService\(/.test(body);
	});
	check("tokenMeter / sessionProjections / sessions all go through rawService",
		users.length === 0, users.join(","));
}

console.log("");
if (failures === 0) {
	console.log("\u5168\u90e8\u901a\u8fc7\uff0813 \u9879\u65ad\u8a00\uff09");
} else {
	console.log(failures + " \u9879\u5931\u8d25");
	process.exit(1);
}
