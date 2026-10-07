// dsh-compact-suite — browser half.
//
// 一个「压缩」按钮（composer 工具栏左侧，与 dsh-skillhub 的【技能】同位），
// 点开是全部设置 —— 不再单独占一个设置页：单个偏好不需要整页。
//
// 三条原则：
//   1. 只用宿主真实存在的主题 token（--dsw-alias-*），不写猜的名字 + 兜底色；
//   2. 几何对齐相邻控件（32px 高、border-l2、font:inherit、.12s 过渡，
//      实测自 dsh-skillhub 的 chip）；
//   3. 显示**决策用的数字**（窗口 → 触发点 token），而不是只显示一个比例。
//
// 后端路由：/compact-suite/api/{state,log,models}。

window.__ModuleLoader__.load({
	id: "dsh-compact-suite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var e = React.createElement;

		var API_BASE = "/compact-suite/api";
		var STATE_URL = API_BASE + "/state";
		var LOG_URL = API_BASE + "/log";
		var MODELS_URL = API_BASE + "/models";
		var COMPACT_URL = API_BASE + "/compact";
		var FOLLOW = "";

		// ── 主题 token 全部经 cordis_inspect_query(Theme) 核对过 ──────────────
		var CSS = [
			".dcs-wrap{position:relative;display:inline-flex;min-width:0}",
			".dcs-btn{box-sizing:border-box;display:inline-flex;align-items:center;height:32px;padding:0 12px;",
			"border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;",
			"color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;cursor:pointer;",
			"transition:background-color .12s cubic-bezier(.2,.8,.2,1),border-color .12s cubic-bezier(.2,.8,.2,1)}",
			".dcs-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dcs-btn[aria-expanded=true]{border-color:var(--dsw-alias-brand-primary)}",
			".dcs-panel{width:420px;max-width:calc(100vw - 24px);max-height:min(640px,100vh - 24px);overflow:auto;",
			"box-sizing:border-box;padding:12px 12px 10px;display:flex;flex-direction:column;gap:10px;",
			"border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);",
			"color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;",
			"box-shadow:var(--dsw-elevation-soft)}",
			".dcs-panel{animation:dcs-in .16s cubic-bezier(.2,.8,.2,1)}",
			"@keyframes dcs-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
			// The host ships its own floating-surface material, so this borrows it instead
			// of inventing one: --dsw-menu-surface-fill is already translucent and
			// theme-aware, and --dsw-menu-backdrop-filter is blur(40px) saturate(150%).
			// Halving that radius is exactly what turned the panel into grey smears:
			// 20px leaves the text behind half-legible. The opaque declaration stays
			// first, so this is a pure upgrade where the feature exists.
			".dcs-panel{background:var(--dsw-menu-surface-fill);",

			"-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));",
			"backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));",
			// No hand-made bevel: the host elevation already carries a 0.5px stroke,
			// and an invented one is a second, competing edge.
			"box-shadow:var(--dsw-elevation-soft)}}",


			"@media (prefers-reduced-transparency:reduce){.dcs-panel{background:var(--dsw-alias-bg-layer-2);",
			"-webkit-backdrop-filter:none;backdrop-filter:none}}",
			"@media (prefers-reduced-motion:reduce){.dcs-panel{animation:none}}",
			".dcs-panel:focus{outline:none}",
			".dcs-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dcs-title{font-weight:600}",

			".dcs-sec{display:flex;flex-direction:column;gap:6px;padding-top:2px}",
			".dcs-lab{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dcs-line{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dcs-num{font-variant-numeric:tabular-nums;font-weight:600}",
			".dcs-range{width:100%;margin:0;accent-color:var(--dsw-alias-brand-primary)}",
			".dcs-sel{box-sizing:border-box;width:100%;height:30px;padding:0 8px;border-radius:8px;",
			"border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);",
			"color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
			".dcs-sel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dcs-sel:disabled{color:var(--dsw-alias-label-secondary)}",
			".dcs-sw{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}",
			".dcs-sw input{accent-color:var(--dsw-alias-brand-primary);margin:0}",
			".dcs-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}",
			".dcs-ok{color:var(--dsw-alias-state-success-primary)}",
			".dcs-warn{color:var(--dsw-alias-state-warn-primary)}",
			".dcs-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;display:flex;gap:8px;align-items:center}",
			".dcs-sep{border-top:1px solid var(--dsw-alias-border-l1);margin:2px 0 0}",
			".dcs-list{display:flex;flex-direction:column;gap:3px;max-height:190px;overflow:auto}",
			// Every row runs the same tracks, so the numbers line up down the column.
			// `space-between` did the opposite: it right-aligned the block as a whole, so the
			// left edge of the token counts moved with the width of the numbers themselves,
			// and a failed row started somewhere else again.
			".dcs-item{display:grid;grid-template-columns:74px 52px minmax(0,1fr);gap:8px;align-items:baseline;",
			"font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dcs-time{white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dcs-tag{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dcs-val{min-width:0;display:grid;grid-template-columns:46px 14px 46px 58px minmax(0,1fr);gap:0 4px;",
			"align-items:baseline;font-variant-numeric:tabular-nums}",
			".dcs-num{color:var(--dsw-alias-label-primary);font-weight:500}",
			".dcs-num-before{text-align:right}",
			".dcs-arrow{text-align:center}",
			".dcs-saved{text-align:right}",
			".dcs-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dcs-val-fail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
			"color:var(--dsw-alias-state-error-primary)}",
			".dcs-actions{display:inline-flex;align-items:center;gap:8px}",
			".dcs-mini{box-sizing:border-box;height:24px;padding:0 8px;border-radius:6px;",
			"border:1px solid var(--dsw-alias-border-l2);background:transparent;",
			"color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;",
			"transition:background-color .12s cubic-bezier(.2,.8,.2,1)}",
			".dcs-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dcs-mini:disabled{color:var(--dsw-alias-label-secondary);cursor:default}",
			".dcs-disc{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;",
			"color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:0}",
			".dcs-disc:hover{color:var(--dsw-alias-label-primary)}",
			".dcs-caret{display:inline-block;width:7px;font-size:9px;line-height:1}",
			".dcs-tag{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dcs-num-in{box-sizing:border-box;width:110px;height:26px;padding:0 8px;border-radius:6px;",
			"border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);",
			"color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:right}",
			".dcs-mini[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
			".dcs-time{white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dcs-empty{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dcs-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;",
			"font-size:12px;cursor:pointer;padding:0}"
		].join("");

		function installStyles() {
			var tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", "dsh-compact-suite");
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => { tag.remove(); };
		}

		// ── helpers ───────────────────────────────────────────────────────────
		function fmtTokens(n) {
			if (typeof n !== "number" || !isFinite(n)) return "—";
			if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "M";
			if (n >= 1000) return Math.round(n / 1000) + "K";
			return String(n);
		}
		/**
		 * `MM-DD HH:MM`, local time.
		 *
		 * A record's `at` is an ISO-8601 UTC string, and returning strings verbatim
		 * printed `2026-10-07T12:42:16.258Z` into a 420px panel — the timestamp
		 * alone ate the row. Records span weeks, so the date has to stay.
		 */
		function fmtTime(value) {
			var d = null;
			if (typeof value === "number" && isFinite(value)) d = new Date(value);
			else if (typeof value === "string" && value.length > 0) {
				var parsed = new Date(value);
				if (!isNaN(parsed.getTime())) d = parsed;
			}
			if (d === null) return typeof value === "string" ? value : "";
			var pad = function (n) { return String(n).padStart(2, "0"); };
			return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		}
		/**
		 * A display name for the routed model.
		 *
		 * A local provider reports its model as the weights file's absolute path
		 * (`D:\llama-...\Swift-1.5-Qwen3.8-27B-...gguf`), which is wider than the
		 * whole panel row and tells the reader less than the file name does. Only
		 * path-shaped values are shortened; the full value stays in the tooltip.
		 */
		function fmtModel(value) {
			if (typeof value !== "string" || value.length === 0) return "";
			// Only absolute paths are shortened: an `org/model` id would lose the
			// half that says whose model it is.
			if (!/^[A-Za-z]:[\\/]/.test(value) && value.charAt(0) !== "/") return value;
			var cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
			return cut >= 0 && cut < value.length - 1 ? value.slice(cut + 1) : value;
		}

		/**
		 * What a summary node actually costs, measured from this plugin's own log.
		 *
		 * Only the "target" derivation below reads it, and that mode has no entry point
		 * in the panel right now -- see the mode list in the retention section.
		 *
		 * Observed summaries ran 1.6K-2.8K tokens. The allowance is subtracted when
		 * deriving retention from a post-compaction target, and it is a named constant
		 * rather than a magic number so the guess it represents stays visible.
		 */
		var SUMMARY_ALLOWANCE_TOKENS = 3000;

		/**
		 * Turn one of the three expressions into the field the host accepts.
		 *
		 * "Target" is the intent the user actually has -- the size they want the surface
		 * to settle at -- and honouring it means subtracting the parts no retention
		 * setting can reach: the incompressible head and the summary itself. With no
		 * measured head the subtraction would be a guess, so it keeps nothing beyond the
		 * target instead of inventing a number nobody measured.
		 *
		 * Not reachable from the panel today, and kept deliberately: the offset it applies
		 * is `head + allowance`, which only grows into a real distinction when the head is
		 * large. `retainPatch` still answers correctly for it.
		 */
		function retainPatch(mode, value, headTokens) {
			if (mode === "ratio") return { retainRatio: value };
			var wanted = Math.max(0, Math.round(value));
			if (mode !== "target") return { retainTokens: wanted };
			var head = typeof headTokens === "number" ? headTokens : 0;
			return { retainTokens: Math.max(0, wanted - head - SUMMARY_ALLOWANCE_TOKENS) };
		}

		/**
		 * Render the official `/compact` result in the panel's own language.
		 *
		 * The command reports in English. Only its two known success shapes are
		 * translated; anything else — every classified failure included — is shown
		 * verbatim, so an upstream rewording degrades to readable text rather than
		 * to a confidently wrong translation.
		 */
		function localizeCompactText(text, t) {
			if (typeof text !== "string") return null;
			var s = text.trim();
			if (/^No compactable history yet\.?$/.test(s)) return t("compactNothing");
			var m = /^Compacted (\d+) history items \(~(\d+) tokens\)\.?$/.exec(s);
			if (m !== null) return t("compactResult", { count: m[1], tokens: fmtTokens(Number(m[2])) });
			// The two failures a user actually reaches: clicking while a turn runs
			// (busy is the common one — the button only knows about compactions,
			// not about the agent being mid-turn) and cancelling.
			if (/^Compaction is unavailable because this process has an active compaction, or the agent is not idle\.?$/.test(s)) return t("compactBusy");
			if (/^Compaction cancelled\.?$/.test(s)) return t("compactCancelled");
			return s;
		}

		async function callApi(url, method, body) {
			try {
				const res = await fetch(url, {
					method: method ?? "GET",
					headers: body === undefined ? undefined : { "content-type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body)
				});
				let payload = null;
				try { payload = await res.json(); } catch { payload = null; }
				return { ok: res.ok, status: res.status, payload };
			} catch (error) {
				return { ok: false, status: 0, payload: { error: { message: String(error) } } };
			}
		}

		/**
		 * Last-resort translator. The slot host supplies `t` whenever the
		 * registration carries `locale`, but a component that throws on the first
		 * line because a prop was absent is not acceptable — fall back to the
		 * Chinese dictionary with `{name}` substitution.
		 */
		function fallbackT(key, params) {
			var dict = (DICT && DICT.zh) || {};
			var s = typeof dict[key] === "string" ? dict[key] : String(key);
			if (params) {
				for (var k in params) {
					if (Object.prototype.hasOwnProperty.call(params, k)) s = s.split("{" + k + "}").join(String(params[k]));
				}
			}
			return s;
		}

		// ── the one panel ─────────────────────────────────────────────────────
		function Panel(props) {
			const t = props.t ?? fallbackT;
			const sessionId = props.sessionId ?? null;
			const [state, setState] = React.useState(null);
			const [models, setModels] = React.useState(null);
			/** Why the model list is empty, when it is empty because the call failed. */
			const [modelsError, setModelsError] = React.useState(null);
			const [log, setLog] = React.useState(null);
			/** Why the record list could not be read. Never turned into an empty list. */
			const [logError, setLogError] = React.useState(null);
			const [draft, setDraft] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [sending, setSending] = React.useState(false);
			/** Which expression of retention the user picked; null re-derives from state. */
			const [retainMode, setRetainMode] = React.useState(null);
			/** Uncommitted number for the absolute / target inputs and the ratio slider. */
			const [retainDraft, setRetainDraft] = React.useState(null);
			const [compactNote, setCompactNote] = React.useState(null);
			// Collapsed on every open. The list is pure history and can run to a dozen rows,
			// so it was the first thing the panel showed and the last thing anyone wanted
			// there. The choice is deliberately not remembered: "default collapsed" that
			// stays expanded after one click is not a default.
			const [logOpen, setLogOpen] = React.useState(false);
			const panelRef = React.useRef(null);

			const stateUrl = sessionId === null || sessionId === ""
				? STATE_URL
				: STATE_URL + "?session=" + encodeURIComponent(sessionId);

			const load = React.useCallback(async () => {
				const r = await callApi(stateUrl);
				if (r.ok) { setState(r.payload?.value ?? null); setError(null); }
				else setError(r.payload?.error?.message ?? t("loadFailed"));
			}, [stateUrl, t]);
			const loadLog = React.useCallback(async () => {
				const url = sessionId === null || sessionId === ""
					? LOG_URL
					: LOG_URL + "?session=" + encodeURIComponent(sessionId);
				const r = await callApi(url);
				// A failed poll must not touch the list. This used to fall back to `[]`, so
				// one 5xx -- or the host's 403 for a non-loopback Host -- wiped the rows on
				// screen, reset the counter to 0 and made the panel say "nothing compacted in
				// this session yet". That asserts "never compacted" from "could not read",
				// and it re-asserted it every five seconds.
				if (!r.ok) {
					setLogError(r.payload?.error?.message ?? t("loadFailed"));
					return;
				}
				// `/log` answers `{ ok, value: { entries, total, limit } }`; testing
				// `value` itself for an array left this list permanently empty.
				setLogError(null);
				setLog(Array.isArray(r.payload?.value?.entries) ? r.payload.value.entries : []);
			}, [sessionId, t]);

			React.useEffect(() => { load(); }, [load]);
			React.useEffect(() => {
				loadLog();
				const id = setInterval(loadLog, 5000);
				return () => clearInterval(id);
			}, [loadLog]);
			React.useEffect(() => { panelRef.current?.focus(); }, []);
			// A compaction outlives the card, so a panel opened while one is running would
			// show "压缩中…" with a disabled button forever: nothing else re-reads `/state`.
			// Polled only while that flag is up, and the interval dies with it.
			const serverCompacting = state?.compacting === true;
			React.useEffect(() => {
				if (!serverCompacting) return undefined;
				const id = setInterval(load, 3000);
				return () => clearInterval(id);
			}, [serverCompacting, load]);

			const commit = React.useCallback(async (patch) => {
				setBusy(true);
				const r = await callApi(stateUrl, "POST", patch);
				if (r.ok) { setState(r.payload?.value ?? null); setError(null); }
				else setError(r.payload?.error?.message ?? t("saveFailed"));
				// Cleared on failure too. `draft` is what makes the panel preview the derived
				// numbers as if they were already live, so a rejected value left in it turned one
				// failed save into a permanent display of a policy that was never installed -- the
				// numbers looked right, the host still had the old ones, and nothing short of
				// closing the card would clear it.
				setDraft(null);
				setBusy(false);
			}, [stateUrl, t]);

			/**
			 * Store one retention field, or clear both when `value` is null.
			 *
			 * The engine validates `retainRatio` and `retainTokens` as mutually
			 * exclusive, so the host resolves the pair and this only ever names one.
			 */
			const commitRetention = React.useCallback(async (patch) => {
				setBusy(true);
				const r = await callApi(stateUrl, "POST", patch);
				if (r.ok) { setState(r.payload?.value ?? null); setError(null); }
				else setError(r.payload?.error?.message ?? t("saveFailed"));
				// Cleared on failure too, for the same reason as `commit` above. `retainDraft`
				// and `retainMode` are what make the panel render a policy as if it were already
				// installed: a rejected number stayed in the box and a rejected mode stayed
				// highlighted while the host still held the old pair -- and because both are
				// component state, closing the card "fixed" it and reopening showed the truth,
				// which is a difference nobody can act on.
				setRetainMode(null);
				setRetainDraft(null);
				setBusy(false);
			}, [stateUrl, t]);


			const compactNow = React.useCallback(async () => {
				if (sessionId === null || sessionId === "") {
					setCompactNote({ kind: "dcs-warn", text: t("noSession") });
					return;
				}
				setSending(true);
				setCompactNote(null);
				const r = await callApi(COMPACT_URL + "?session=" + encodeURIComponent(sessionId), "POST", {});
				setSending(false);
				if (!r.ok) {
					setCompactNote({ kind: "dcs-err", text: r.payload?.error?.message ?? t("compactFailed") });
					return;
				}
				const value = r.payload?.value ?? {};
				setCompactNote({
					kind: value.kind === "success" ? "dcs-ok" : "dcs-warn",
					text: localizeCompactText(value.text, t) ?? t("compactDone")
				});
				// A compaction changes both the record list and the engine's own view.
				loadLog();
				load();
			}, [sessionId, t, loadLog, load]);

			const toggleLog = React.useCallback(() => {
				setLogOpen((prev) => !prev);
			}, []);

			const enabled = state?.enabled ?? true;
			// `draft` only ever carries a ratio; a route never goes through it.
			const route = state?.route ?? { provider: FOLLOW, model: FOLLOW };
			const following = route.provider === FOLLOW && route.model === FOLLOW;
			const min = state?.minRatio ?? 0.2;
			const max = state?.maxRatio ?? 0.95;
			// Clamped for display, and clamped here rather than trusted to the range input.
			// A stored ratio can sit below the current floor -- switching retention to
			// "default" raises the floor without touching the slider -- and then the label
			// said "5%" while the input's own sanitization parked the thumb at 20% and the
			// engines fired at 20%. One setting, two numbers on screen; and a stray click
			// committed the floor back into the stored value the user never touched.
			const ratio = Math.min(Math.max(draft?.thresholdRatio ?? state?.thresholdRatio ?? 0.8, min), max);
			const engines = state?.engines ?? null;
			// What the takeover actually achieved, not how many engines exist. The
			// override is written by replacing the engine's resolved config, so a
			// count of engines found is no evidence that any of them accepted it.
			const owned = typeof state?.ownedEngines === "number" ? state.ownedEngines : null;
			// A compaction outlives this panel, so the server's own flag wins:
			// reopening mid-run must not show an idle button for a live job.
			const compacting = sending || state?.compacting === true;
			// Named `windowTokens`, not `window`: the latter shadows the global.
			const windowTokens = state?.contextWindow ?? null;
			// Whether the handle is in flight. Declared before the numbers that depend on it:
			// while the handle moves the host has not been told yet, so its trigger is one
			// step behind and the panel has to do the arithmetic itself.
			const dragging = draft?.thresholdRatio !== undefined;
			// The slider's own arithmetic. This is a ceiling and nothing more: the retention
			// floor can push the trigger back up above it.
			const sliderThreshold = windowTokens === null ? null : Math.floor(windowTokens * ratio);
			// The trigger the engines actually carry, from the host -- the only place that
			// knows about the floor. Recomputing it here from the slider is how the panel
			// came to advertise "窗口 1.0M · 触发于 800K" while the engines were firing at
			// 50K. Mid-drag the host's number is stale, so the slider arithmetic is the
			// right answer for exactly as long as the handle is moving.
			const hostThreshold = typeof state?.thresholdTokens === "number" ? state.thresholdTokens : null;
			const thresholdTokens = dragging || hostThreshold === null ? sliderThreshold : hostThreshold;
			// Which of the three won, straight from the host rather than inferred here.
			const boundBy = typeof state?.triggerBoundBy === "string" ? state.triggerBoundBy : null;
			// Retention. Two numbers matter and they differ on purpose: `ratio` is the
			// slider's ceiling, `effectiveRatio` is what the engines were actually told,
			// which the retention floor can raise.
			const retainTokens = typeof state?.retainTokens === "number" ? state.retainTokens : null;
			const retainRatio = typeof state?.retainRatio === "number" ? state.retainRatio : null;
			const headTokens = typeof state?.headTokens === "number" ? state.headTokens : null;
			const effectiveRatio = typeof state?.effectiveRatio === "number" ? state.effectiveRatio : ratio;
			const effectiveThreshold = windowTokens === null ? null : Math.floor(windowTokens * effectiveRatio);
			const floorTokens = typeof state?.compactionFloorTokens === "number" ? state.compactionFloorTokens : null;
			const clampedUp = effectiveRatio > ratio + 0.001;
			// Automatic policy: retention is a conversion problem,
			// not a decision problem, so the panel can answer "keep it small enough that
			// the model stays quick" directly and leave the arithmetic to the host.
			const auto = state?.auto === true;
			const autoPolicy = state?.autoPolicy ?? null;
			// The setting reaching the host is not the same as an engine carrying it.
			//
			// Only the field actually set is compared: in "default" mode neither is set
			// and the engine legitimately keeps its own 0.16, so an unconditional compare
			// would report a mismatch that is really just the default working as intended.
			const engineRetention = state?.engineRetention ?? null;
			const retentionMismatch = enabled && engineRetention !== null
				&& retainTokens !== null && engineRetention.retainTokens !== retainTokens
				|| enabled && engineRetention !== null
				&& retainRatio !== null && engineRetention.retainRatio !== retainRatio;
			// Which expression of retention is on screen. Derived from what the host
			// actually stored, so a reload shows the truth rather than the last click.
			const mode = retainMode ?? (retainTokens !== null ? "tokens" : retainRatio !== null ? "ratio" : "default");
			// Live preview of the derived policy.
			//
			// What the host commits only changes on commit, so while the handle is moving it
			// is one step behind -- and with the slider as the primary control that lag is
			// the whole feature. The fractions and the caps come from the host, so there is
			// one set of constants here rather than two that can drift apart.
			const autoParams = state?.autoParams ?? null;
			const previewPolicy = auto && dragging && autoParams !== null && windowTokens !== null
				? (() => {
					const threshold = windowTokens * ratio;
					const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
					return {
						retainTokens: clamp(Math.round(threshold * autoParams.retainFraction), autoParams.retainMin, autoParams.retainMax)
					};
				})()
				: null;
			const shownPolicy = previewPolicy ?? autoPolicy;

			/**
			 * Switch between the derived policy and manual control.
			 *
			 * Manual freezes the retention auto computed. It must **not** carry the *effective*
			 * ratio back into the slider: `effectiveRatio` is what the engines ended up with
			 * after the floor had its say, not what the user asked for. Sending it moved a
			 * setting the user owns -- with growth mode on, a slider parked at 80% reported an
			 * effective 0.0846, and one click on 手动 wrote that 8% into the slider itself,
			 * permanently, with nothing on screen to say the panel had done it.
			 *
			 * Declared here, below the derived values it closes over: a `useCallback`
			 * dependency array is evaluated where it is written, so naming a `const` that
			 * is still in its temporal dead zone throws on render -- which is exactly how
			 * this crashed the panel, and the slot machinery retires a crashed entry for
			 * the life of the page.
			 */
			const setPolicy = React.useCallback((next) => {
				if (next === "auto") {
					commitRetention({ auto: true });
					return;
				}
				commitRetention({ auto: false, retainTokens: retainTokens });
			}, [commitRetention, retainTokens]);

			/**
			 * Switch which retention field the host stores.
			 *
			 * These buttons used to be view-only: they set a local mode and committed nothing,
			 * so the panel looked switched while the host still carried the previous field.
			 * Closing the card dropped the local mode and the panel re-derived itself from the
			 * host -- always "绝对值", because that is what a stored `retainTokens` means.
			 * Committing the switch is the only way the choice survives a reopen, so each mode
			 * writes the value it would display and "默认" writes the null that clears both
			 * (the host resolves the pair as mutually exclusive, so one field covers it).
			 *
			 * When there is nothing honest to write, nothing is written and the button does
			 * not light up. It used to highlight first and then return without a request, so
			 * "绝对值" looked selected on a session whose window is unknown and reverted to
			 * "默认" the moment the card was reopened -- the same silent reversal, still there.
			 */
			const switchMode = React.useCallback((next) => {
				setRetainDraft(null);
				if (next === "default") {
					setRetainMode(next);
					commitRetention({ retainTokens: null });
					return;
				}
				if (next === "ratio") {
					// The same number the ratio slider shows when nothing is stored, held below
					// the trigger so the host's own validation cannot reject it.
					const suggested = Math.max(0.01, Math.min(0.16, Math.round((ratio - 0.02) * 100) / 100));
					setRetainMode(next);
					commitRetention({ retainRatio: retainRatio ?? suggested });
					return;
				}
				// Absolute: freeze what is already in force -- the stored value, else the
				// engine's own read-back, else what auto would keep for this trigger. The
				// engine's number is what makes this work without a measured window; only when
				// none of the three exists is there nothing to write, and then the mode is
				// deliberately left unset rather than shown as applied.
				const kept = retainTokens
					?? (engineRetention !== null && typeof engineRetention.retainTokens === "number" ? engineRetention.retainTokens : null)
					?? (windowTokens !== null && autoParams !== null
						? Math.min(
							Math.max(Math.round(windowTokens * ratio * autoParams.retainFraction), autoParams.retainMin),
							autoParams.retainMax
						)
						: null);
				if (kept === null) {
					setError(t("modeNeedsTokens"));
					return;
				}
				setRetainMode(next);
				commitRetention({ retainTokens: kept });
			}, [commitRetention, windowTokens, ratio, autoParams, retainRatio, retainTokens, engineRetention, t]);

			const providerList = state?.providers ?? [];
			// Do not silently collapse an unknown provider to "follow the session
			// model": that made a stored-but-unavailable route look like a choice
			// the user never made.
			const knownProvider = providerList.some((p) => p.id === route.provider);
			const providerValue = route.provider === FOLLOW ? FOLLOW : route.provider;
			const providerStale = route.provider !== FOLLOW && !knownProvider;
			const modelMissing = providerValue !== FOLLOW && route.model === "";

			React.useEffect(() => {
				if (providerValue === "") { setModels([]); setModelsError(null); return undefined; }
				let alive = true;
				callApi(MODELS_URL + "?provider=" + encodeURIComponent(providerValue)).then((r) => {
					if (!alive) return;
					// An empty list and a failed call are different facts. Collapsing them
					// told the user "this provider has no models" when the host had answered
					// 502 with a readable reason -- which the panel then threw away.
					if (!r.ok) {
						setModels([]);
						setModelsError(r.payload?.error?.message ?? t("loadFailed"));
						return;
					}
					setModelsError(null);
					setModels(Array.isArray(r.payload?.value) ? r.payload.value : []);
				});
				return () => { alive = false; };
			}, [providerValue, t]);

			return e("div", {
				className: "dcs-panel",
				ref: panelRef,
				tabIndex: -1,
				role: "dialog",
				"aria-label": t("title"),

			},
				e("div", { className: "dcs-head" },
					e("span", { className: "dcs-title" }, t("title"))
				),

				e("label", { className: "dcs-sw" },
					e("input", {
						type: "checkbox",
						checked: enabled,
						disabled: busy,
						onChange: (ev) => commit({ enabled: ev.target.checked })
					}),
					e("span", null, t("enabled"))
				),

				e("div", { className: "dcs-sec" },
					e("span", { className: "dcs-lab" }, t("route")),
					e("select", {
						className: "dcs-sel",
						value: following ? FOLLOW : providerValue,
						disabled: busy,
						"aria-label": t("routeProvider"),
						onChange: (ev) => {
							const v = ev.target.value;
							if (v === "") commit({ summarizationProvider: "", summarizationModel: "" });
							else commit({ summarizationProvider: v, summarizationModel: "" });
						}
					},
						e("option", { value: FOLLOW }, t("followSession")),
						providerStale
							? e("option", { value: route.provider }, route.provider + " " + t("unavailable"))
							: null,
						providerList.map((p) => e("option", { key: p.id, value: p.id }, p.name || p.id))
					),
					providerValue === "" ? null : e("select", {
						className: "dcs-sel",
						value: route.model,
						disabled: busy || models === null,
						"aria-label": t("routeModel"),
						onChange: (ev) => commit({ summarizationModel: ev.target.value })
					},
						e("option", { value: "" }, models === null ? t("loading") : t("pickModel")),
						(models ?? []).map((m) => e("option", { key: m.id, value: m.id }, m.name || m.id))
					),
					modelMissing
						? e("div", { className: "dcs-note dcs-warn" }, t("modelMissing"))
						: null,
					modelsError === null
						? null
						: e("div", { className: "dcs-note dcs-warn" }, t("modelsFailed", { why: modelsError }))
				),

				e("div", { className: "dcs-sec" },
					e("div", { className: "dcs-line" },
						e("span", { className: "dcs-lab" }, t("threshold")),
						e("span", { className: "dcs-num" }, Math.round(ratio * 100) + "%")
					),
					e("input", {
						className: "dcs-range",
						type: "range",
						min: min,
						max: max,
						step: 0.01,
						value: ratio,
						// The slider is the primary control in both modes: auto derives retention
						// from it rather than overriding it.
						disabled: busy || !enabled,
						"aria-label": t("threshold"),
						onChange: (ev) => setDraft({ thresholdRatio: Number(ev.target.value) }),
						onMouseUp: (ev) => commit({ thresholdRatio: Number(ev.currentTarget.value) }),
						onKeyUp: (ev) => commit({ thresholdRatio: Number(ev.currentTarget.value) }),
						onTouchEnd: (ev) => commit({ thresholdRatio: Number(ev.currentTarget.value) })
					}),
					e("div", { className: "dcs-note" },
						sliderThreshold === null
							? t("windowUnknown")
							: t("windowMath", { window: fmtTokens(windowTokens), at: fmtTokens(sliderThreshold) })
					),
					// The slider is a ceiling, not the trigger. Printing only "触发于 800K"
					// while the engines fired at 50K is worse than printing nothing, so name
					// the term that actually decided it. Suppressed mid-drag for the same
					// reason as the notes below: the host's answer predates the handle.
					!dragging && thresholdTokens !== null
						&& sliderThreshold !== null && thresholdTokens !== sliderThreshold
						? e("div", { className: "dcs-note dcs-warn" }, t("triggerFrom", {
							real: fmtTokens(thresholdTokens),
							at: fmtTokens(sliderThreshold),
							why: t(boundBy === "floor" ? "whyFloor" : boundBy === "slider" ? "whySlider" : "whyOther")
						}))
						: null,
					// `!dragging`: both of these compare the host last known value against the draft,
					// so mid-drag they fire on a stale reading and contradict the numbers above them.
					state !== null && state.ratioIsBinding === false && !dragging
						? e("div", { className: "dcs-note dcs-warn" }, t("notBinding"))
						: null,
					providerStale
						? e("div", { className: "dcs-note dcs-warn" }, t("providerGone", { provider: route.provider }))
						: null
				),

				// ── 压缩策略 ──────────────────────────────────────────────────
				e("div", { className: "dcs-sec" },
					e("div", { className: "dcs-line" },
						e("span", { className: "dcs-lab" }, t("retention")),
						e("span", { className: "dcs-actions" },
							["auto", "manual"].map((m) =>
								e("button", {
									key: m,
									type: "button",
									className: "dcs-mini",
									"aria-pressed": auto === (m === "auto"),
									disabled: busy || !enabled,
									onClick: () => setPolicy(m)
								}, t("policy_" + m))
							)
						)
					),
					auto
						? e(React.Fragment, null,
							autoPolicy === null
								? e("div", { className: "dcs-note" }, t("autoNoWindow"))
								: e("div", { className: "dcs-note" },
									t("autoLine", { keep: fmtTokens(shownPolicy.retainTokens) })
								),
							// Gated on `autoParams` as well: without them the panel cannot recompute the
							// derived numbers at all, and naming a retention split the host is not using
							// would be worse than saying nothing.
							autoPolicy === null || autoParams === null
								? null
								: e("div", { className: "dcs-note" },
									t("autoWhy", { rp: Math.round(autoParams.retainFraction * 100) })
								),
							retentionMismatch
								? e("div", { className: "dcs-note dcs-warn" }, t("retentionMismatch"))
								: null
						)
						: e(React.Fragment, null,
							e("div", { className: "dcs-line" },
								e("span", { className: "dcs-lab" }, t("retainManual")),
								e("span", { className: "dcs-actions" },
									// "target" is deliberately not offered: with a measured head of a
									// couple of thousand tokens it differs from "tokens" by that offset
									// and nothing else, so it was a second control saying the same thing.
									// The derivation stays in `retainPatch` (and the host still accepts
									// the values it produces) in case a large system prompt makes the
									// distinction worth surfacing again.
									["default", "ratio", "tokens"].map((m) =>
										e("button", {
											key: m,
											type: "button",
											className: "dcs-mini",
											"aria-pressed": mode === m,
											disabled: busy || !enabled,
											onClick: () => switchMode(m)
										}, t("mode_" + m))
									)
								)
							),
							mode === "default"
						? e("div", { className: "dcs-note" }, t("retainDefault"))
						: mode === "ratio"
							? e("input", {
								className: "dcs-range",
								type: "range",
								min: 0.01,
								max: Math.max(0.02, Math.round((ratio - 0.02) * 100) / 100),
								step: 0.01,
								value: retainDraft ?? retainRatio ?? 0.16,
								disabled: busy || !enabled,
								"aria-label": t("retention"),
								onChange: (ev) => setRetainDraft(Number(ev.currentTarget.value)),
								onMouseUp: (ev) => commitRetention({ retainRatio: Number(ev.currentTarget.value) }),
								onKeyUp: (ev) => commitRetention({ retainRatio: Number(ev.currentTarget.value) })
							})
							: e("input", {
								className: "dcs-sel",
								type: "number",
								min: 0,
								step: 256,
								value: retainDraft ?? (mode === "target"
									? (floorTokens === null ? "" : floorTokens)
									: (retainTokens ?? "")),
								disabled: busy || !enabled,
								placeholder: t("retainPlaceholder"),
								"aria-label": t("retention"),
								onChange: (ev) => setRetainDraft(ev.currentTarget.value === "" ? null : Number(ev.currentTarget.value)),
								onKeyDown: (ev) => { if (ev.key === "Enter" && retainDraft !== null) { setRetainMode(null); commitRetention(retainPatch(mode, retainDraft, headTokens)); } },
								onBlur: () => { if (retainDraft !== null) commitRetention(retainPatch(mode, retainDraft, headTokens)); }
							}),

					// What is actually in effect, in the units each mode can honestly state.
					mode === "ratio"
						? e("div", { className: "dcs-note" }, t("retainRatioNote", { pct: Math.round((retainRatio ?? 0.16) * 100) }))
						: retainTokens !== null
							? e("div", { className: "dcs-note" }, t("retainTokensNote", { kept: fmtTokens(retainTokens), at: fmtTokens(effectiveThreshold) }))
							: null,
					headTokens === null
						? e("div", { className: "dcs-note" }, t("headUnknown"))
						: e("div", { className: "dcs-note" },
							t("headNote", { head: fmtTokens(headTokens) }),
							floorTokens === null ? "" : "　" + t("floorNote", { floor: fmtTokens(floorTokens) })
						),
					// Suppressed while the handle is moving: `clampedUp` compares the host last known
					// effective ratio against the draft, so mid-drag it reports a conflict with the
					// "trigger at" line sitting directly above the slider.
					clampedUp && !dragging
						? e("div", { className: "dcs-note dcs-warn" }, t("clampedUp", { at: fmtTokens(effectiveThreshold) }))
						: null,

					retentionMismatch
						? e("div", { className: "dcs-note dcs-warn" }, t("retentionMismatch"))
						: null
						)
				),

				e("div", { className: "dcs-sec" },
					engines === null
						? e("span", { className: "dcs-note" }, t("loading"))
						: engines === 0
							? e("span", { className: "dcs-note dcs-warn" }, t("noEngines"))
							: owned === null
								? e("span", { className: "dcs-note" }, t("found", { count: engines }))
								: !enabled
									? e("span", { className: "dcs-note" }, t("paused", { count: engines }))
									: owned === 0
										? e("span", { className: "dcs-note dcs-warn" }, t("notOwned", { count: engines }))
										: owned < engines
											? e("span", { className: "dcs-note dcs-warn" }, t("partial", { owned: owned, count: engines }))
											: e("span", { className: "dcs-note dcs-ok" }, t("engines", { owned: owned, count: engines }))
				),

				error === null ? null : e("div", { className: "dcs-err" },
					e("span", null, error),
					e("button", { type: "button", className: "dcs-link", onClick: load }, t("retry"))
				),

				e("div", { className: "dcs-sep" }),
				e("div", { className: "dcs-sec" },
					e("div", { className: "dcs-line" },
						e("button", {
							type: "button",
							className: "dcs-disc",
							"aria-expanded": logOpen,
							onClick: toggleLog
						},
							e("span", { className: "dcs-caret" }, logOpen ? "▾" : "▸"),
							t("log")
						),
						e("span", { className: "dcs-actions" },
							log === null ? null : e("span", { className: "dcs-lab" }, String(log.length)),
							e("button", {
								type: "button",
								className: "dcs-mini",
								disabled: compacting,
								onClick: compactNow
							}, compacting ? t("compacting") : t("compactNow"))
						)
					),
					compactNote === null ? null : e("div", { className: "dcs-note " + compactNote.kind }, compactNote.text),
					logError === null ? null : e("div", { className: "dcs-note dcs-warn" }, t("logFailedRead", { why: logError })),
					logOpen === false
						? null
						: log === null
							? e("span", { className: "dcs-empty" }, t("loading"))
							: log.length === 0
								? e("span", { className: "dcs-empty" }, t("logEmpty"))
								: e("div", { className: "dcs-list" }, log.map((row, i) =>
									e("div", { className: "dcs-item", key: String(i) },
										e("span", { className: "dcs-time" }, fmtTime(row.at ?? row.time)),
										// Why it ran. Pressure is the normal case; an overflow means the
										// provider refused the request, so the route's configured window is
										// larger than what that endpoint actually accepts.
										e("span", {
											className: "dcs-tag" + (row.trigger === "context-overflow" ? " dcs-warn" : "")
										}, t("trig_" + (row.trigger ?? "unknown"))),
										// A compaction that failed still carries `error`; it did NOT
										// save zero tokens. Rendering the numbers alone turned three
										// aborted attempts into what looked like real 0 -> 0 rows.
										row.error
											? e("span", {
												className: "dcs-val-fail",
												title: row.error
											}, t("logFailed"), " · ", row.error)
											// Five fixed cells rather than one run of text: the counts are
											// aligned around the arrow and the saved total has a column of
											// its own, so nothing shifts when a number gains a digit.
											: e("span", { className: "dcs-val" },
												e("b", { className: "dcs-num dcs-num-before" }, fmtTokens(row.beforeTokens)),
												e("span", { className: "dcs-arrow" }, "→"),
												e("b", { className: "dcs-num" }, fmtTokens(row.afterTokens)),
												e("span", { className: "dcs-saved" }, row.savedTokens > 0 ? "−" + fmtTokens(row.savedTokens) : ""),
												e("span", {
													className: "dcs-model",
													title: row.model ?? ""
												}, row.model ? fmtModel(row.model) : "")
											)
									)
								))
				)
			);
		}

		// ── the composer chip ─────────────────────────────────────────────────
		function CompactChip(props) {
			const t = props.t ?? fallbackT;
			const [open, setOpen] = React.useState(false);
			const triggerRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const wrapRef = React.useRef(null);
			const position = primitives.useAnchoredPosition({
				open,
				anchorRef: triggerRef,
				panelRef,
				gap: 8,
				margin: 12
			});
			// Dismissal lives here rather than on a close button. The panel renders
			// inside the wrapper, so a capture-phase mousedown anywhere outside it
			// means "dismiss". Escape is a keyboard dismissal and must return focus to
			// the trigger, or it lands on <body> and the next Tab restarts from the
			// top of the document; an outside click deliberately does NOT refocus,
			// because that click was aimed somewhere else on purpose.
			React.useEffect(() => {
				if (!open) return undefined;
				const onDown = (ev) => {
					if (!(ev.target instanceof Node)) return;
					if (wrapRef.current !== null && wrapRef.current.contains(ev.target)) return;
					setOpen(false);
				};
				const onKey = (ev) => {
					if (ev.key !== "Escape") return;
					setOpen(false);
					triggerRef.current?.focus();
				};
				document.addEventListener("mousedown", onDown, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("mousedown", onDown, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);

			return e("div", { className: "dcs-wrap", ref: wrapRef },
				e("button", {
					type: "button",
					className: "dcs-btn",
					ref: triggerRef,
					title: t("title"),
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: () => setOpen((v) => !v)
				}, t("chip")),
				open ? e("div", {
					style: Object.assign({}, position, { position: "fixed", zIndex: 60 }),
					ref: panelRef
				}, e(Panel, {
					sessionId: props.sessionId ?? null,
					t: t
				})) : null
			);
		}

		// ── dictionaries ──────────────────────────────────────────────────────
		var NS = "compactSuite";
		var DICT = {
			zh: {
				chip: "压缩",
				title: "上下文压缩",

				enabled: "接管压缩阈值",
				route: "摘要模型（压缩那一次调用）",
				routeProvider: "摘要 provider",
				routeModel: "摘要 model",
				followSession: "跟随会话模型",
				pickModel: "选择模型…",
				unavailable: "（当前不可用）",
				modelMissing: "已选 provider 但未选模型 —— 摘要仍然跟随会话模型。",
				threshold: "触发阈值",
				windowMath: "窗口 {window} · 滑块上限 {at}（这是上限，不一定就是实际触发点）",
				windowUnknown: "本会话的模型窗口还未知（发一条消息后出现）",
				triggerFrom: "实际触发于 {real}，不是滑块上限 {at} —— 由{why}决定。",
				whyFloor: "触发点下限",
				whySlider: "滑块（被引擎余量夹住）",
				whyOther: "引擎实际携带的那个值",
				notBinding: "注意：有引擎的上下文余量不是本插件写的那份，那里的阈值不一定由这个滑块决定。",
				engines: "已接管 {owned}/{count} 个压缩引擎",
				found: "找到 {count} 个压缩引擎",
				paused: "已暂停：{count} 个引擎已还原成原样",
				notOwned: "找到 {count} 个压缩引擎，但没有任何一个接受改写 —— 阈值没有生效。",
				partial: "只接管了 {owned}/{count} 个压缩引擎，其余没有接受改写。",
				providerGone: "摘要 provider「{provider}」当前不可用 —— 压缩那一次调用会失败。",
				retention: "保留与再触发",
				mode_default: "默认",
				mode_ratio: "比例",
				mode_tokens: "绝对值",
				modeNeedsTokens: "窗口还没量出来，也没有可冻结的保留量 —— 先发一条消息再切「绝对值」，否则存下来的还是「默认」。",
				mode_target: "压缩后目标",
				policy_auto: "自动",
				policy_manual: "手动",
				autoNoWindow: "本会话的模型窗口还未知 —— 发一条消息后自动算。",
				autoLine: "保留约 {keep}，到上面的触发点就压。",
				autoWhy: "保留按触发阈值推算（{rp}%），拖动滑块会实时跟着变。",
				retainManual: "保留方式",
				retainDefault: "跟随引擎默认（保留 16% 的可用消息预算）。",
				retainPlaceholder: "令牌",
				retainRatioNote: "保留比例 {pct}%。注意它的绝对值随窗口放大：1M 窗口下 16% 就是十几万令牌。",
				retainTokensNote: "保留 {kept} 令牌，触发点 {at}。",
				headUnknown: "压不动的头部还未知（发一条消息后实测）。",
				headNote: "压不动的头部 {head}（系统提示，引擎永不压缩它）。",
				floorNote: "压缩后下限 ≈ {floor}。",
				clampedUp: "保留量把触发点顶到了 {at} —— 阈值不能低于保留量，否则引擎每次判定都会报错。",
				retentionMismatch: "引擎还没带上这个保留量（它携带的值与上面不一致）。下一条消息会重新下发；若一直如此，暂停后再恢复。",
				trig_pressure: "压力",
				"trig_context-overflow": "溢出",
				trig_manual: "手动",
				trig_unknown: "—",
				noEngines: "未找到压缩引擎 —— compaction-basic 可能没挂载。",
				log: "压缩记录",
				logEmpty: "本会话还没有压缩过。",
				compactNow: "立即压缩",
				compacting: "压缩中…",
				compactNothing: "没有可压缩的历史。",
				compactResult: "已压缩 {count} 项历史（约 {tokens} 令牌）。",
				compactDone: "压缩已完成。",
				compactFailed: "压缩失败",
				logFailed: "失败",
				compactBusy: "现在不能压缩：已有一次压缩在进行，或当前会话正忙 —— 等这一轮跑完再试。",
				compactCancelled: "压缩已取消。",
				noSession: "无法确定当前会话。",
				loading: "读取中…",
				loadFailed: "无法读取状态",
				modelsFailed: "读不到模型列表：{why}",
				logFailedRead: "读不到压缩记录：{why}（列表保留上一次读到的内容）",
				saveFailed: "保存失败",
				retry: "重试"
			},
			en: {
				chip: "Compact",
				title: "Context compaction",

				enabled: "Take over the compaction threshold",
				route: "Summary model (the compaction call)",
				routeProvider: "Summary provider",
				routeModel: "Summary model",
				followSession: "Follow the session model",
				pickModel: "Pick a model…",
				unavailable: "(unavailable)",
				modelMissing: "Provider selected without a model — summaries still follow the session model.",
				threshold: "Trigger threshold",
				windowMath: "window {window} · slider ceiling {at} (a ceiling, not necessarily the trigger)",
				windowUnknown: "This session's model window is not known yet (send a message)",
				triggerFrom: "Actually compacts at {real}, not the slider ceiling {at} — decided by {why}.",
				whyFloor: "the trigger floor",
				whySlider: "the slider (capped by the engine's capacity term)",
				whyOther: "the value the engines actually carry",
				notBinding: "Note: at least one engine is not carrying the context headroom this plugin writes, so its threshold may not follow this slider.",
				engines: "{owned}/{count} compaction engine(s) under control",
				found: "{count} compaction engine(s) found",
				paused: "Paused: {count} engine(s) restored to their original config",
				notOwned: "{count} compaction engine(s) found, but none accepted the override — the threshold is not in effect.",
				partial: "Only {owned}/{count} compaction engine(s) accepted the override.",
				providerGone: "Summary provider \"{provider}\" is not available — the compaction call will fail.",
				retention: "Retention & re-trigger",
				mode_default: "Default",
				mode_ratio: "Ratio",
				mode_tokens: "Tokens",
				modeNeedsTokens: "The window has not been measured and there is no retention to freeze — send a message, then switch to Tokens; until then \"Default\" is what would be stored.",
				mode_target: "Target",
				policy_auto: "Auto",
				policy_manual: "Manual",
				autoNoWindow: "This session's model window is not known yet — send a message and it will be computed.",
				autoLine: "Keep about {keep}; compact at the trigger above.",
				autoWhy: "Retention follows the trigger ({rp}%); drag the slider and it moves with it.",
				retainManual: "Retention",
				retainDefault: "Follow the engine's default (keep 16% of the message budget).",
				retainPlaceholder: "tokens",
				retainRatioNote: "Keeping {pct}%. Its absolute size scales with the window: 16% of 1M is over a hundred thousand tokens.",
				retainTokensNote: "Keeping {kept} tokens, triggering at {at}.",
				headUnknown: "The incompressible head is not measured yet (send a message).",
				headNote: "Incompressible head {head} (the system prompt; the engine never compacts it).",
				floorNote: "Post-compaction floor ≈ {floor}.",
				clampedUp: "Retention pushed the trigger up to {at} — the threshold cannot sit below what is retained, or every decision throws.",
				retentionMismatch: "The engines are not carrying this retention yet (theirs differs from the value above). The next message re-applies it; if it persists, pause and resume.",
				trig_pressure: "pressure",
				"trig_context-overflow": "overflow",
				trig_manual: "manual",
				trig_unknown: "—",
				noEngines: "No compaction engine found — compaction-basic may not be mounted.",
				log: "Compaction log",
				logEmpty: "Nothing compacted in this session yet.",
				compactNow: "Compact now",
				compacting: "Compacting…",
				compactNothing: "No compactable history yet.",
				compactResult: "Compacted {count} history items (~{tokens} tokens).",
				compactDone: "Compaction finished.",
				compactFailed: "Compaction failed",
				logFailed: "Failed",
				compactBusy: "Cannot compact right now: a compaction is already running, or the session is busy — try again once the current turn finishes.",
				compactCancelled: "Compaction cancelled.",
				noSession: "Cannot determine the current session.",
				loading: "Loading…",
				loadFailed: "Cannot read the state",
				modelsFailed: "Could not read the model list: {why}",
				logFailedRead: "Could not read the compaction log: {why} (the list keeps its last contents)",
				saveFailed: "Save failed",
				retry: "Retry"
			}
		};

		// ── registration ──────────────────────────────────────────────────────
		exports.inject = ["slots", "locale"];

		exports.apply = function apply(ctx) {
			ctx.effect(installStyles, "dsh-compact-suite: stylesheet");
			ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-compact-suite: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-compact-suite",
				order: 45,
				label: () => t("chip"),
				locale: NS
			}, CompactChip));
		};

		return module.exports;
	}
});
