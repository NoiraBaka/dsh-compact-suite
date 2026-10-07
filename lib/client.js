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
			".dcs-list{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow:auto}",
			".dcs-item{display:flex;justify-content:space-between;gap:8px;font-size:12px;",
			"color:var(--dsw-alias-label-secondary)}",
			".dcs-item b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}",
			".dcs-val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
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
		function fmtTime(value) {
			if (typeof value === "number" && isFinite(value)) {
				const d = new Date(value);
				return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
			}
			return typeof value === "string" ? value : "";
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
			const [log, setLog] = React.useState(null);
			const [draft, setDraft] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
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
				setLog(r.ok && Array.isArray(r.payload?.value) ? r.payload.value : []);
			}, [sessionId]);

			React.useEffect(() => { load(); }, [load]);
			React.useEffect(() => {
				loadLog();
				const id = setInterval(loadLog, 5000);
				return () => clearInterval(id);
			}, [loadLog]);
			React.useEffect(() => { panelRef.current?.focus(); }, []);

			const commit = React.useCallback(async (patch) => {
				setBusy(true);
				const r = await callApi(stateUrl, "POST", patch);
				if (r.ok) { setState(r.payload?.value ?? null); setDraft(null); setError(null); }
				else setError(r.payload?.error?.message ?? t("saveFailed"));
				setBusy(false);
			}, [stateUrl, t]);

			const enabled = state?.enabled ?? true;
			const route = draft?.route ?? state?.route ?? { provider: FOLLOW, model: FOLLOW };
			const following = route.provider === FOLLOW && route.model === FOLLOW;
			const ratio = draft?.thresholdRatio ?? state?.thresholdRatio ?? 0.8;
			const min = state?.minRatio ?? 0.2;
			const max = state?.maxRatio ?? 0.95;
			const engines = state?.engines ?? null;
			const window = state?.contextWindow ?? null;
			const thresholdTokens = window === null ? null : Math.floor(window * ratio);

			const providerList = state?.providers ?? [];
			// Do not silently collapse an unknown provider to "follow the session
			// model": that made a stored-but-unavailable route look like a choice
			// the user never made.
			const knownProvider = providerList.some((p) => p.id === route.provider);
			const providerValue = route.provider === FOLLOW ? FOLLOW : route.provider;
			const providerStale = route.provider !== FOLLOW && !knownProvider;
			const modelMissing = providerValue !== FOLLOW && route.model === "";

			React.useEffect(() => {
				if (providerValue === "") { setModels([]); return undefined; }
				let alive = true;
				callApi(MODELS_URL + "?provider=" + encodeURIComponent(providerValue)).then((r) => {
					if (alive) setModels(r.ok && Array.isArray(r.payload?.value) ? r.payload.value : []);
				});
				return () => { alive = false; };
			}, [providerValue]);

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
						: null
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
						disabled: busy || !enabled,
						"aria-label": t("threshold"),
						onChange: (ev) => setDraft({ thresholdRatio: Number(ev.target.value) }),
						onMouseUp: (ev) => commit({ thresholdRatio: Number(ev.target.value) }),
						onKeyUp: (ev) => commit({ thresholdRatio: Number(ev.target.value) }),
						onTouchEnd: (ev) => commit({ thresholdRatio: Number(ev.currentTarget.value) })
					}),
					e("div", { className: "dcs-note" },
						thresholdTokens === null
							? t("windowUnknown")
							: t("windowMath", { window: fmtTokens(window), at: fmtTokens(thresholdTokens) })
					),
					state !== null && state.ratioIsBinding === false
						? e("div", { className: "dcs-note dcs-warn" }, t("notBinding"))
						: null
				),

				e("div", { className: "dcs-sec" },
					engines === null
						? e("span", { className: "dcs-note" }, t("loading"))
						: engines === 0
							? e("span", { className: "dcs-note dcs-warn" }, t("noEngines"))
							: e("span", { className: "dcs-note dcs-ok" }, t("engines", { count: engines }))
				),

				error === null ? null : e("div", { className: "dcs-err" },
					e("span", null, error),
					e("button", { type: "button", className: "dcs-link", onClick: load }, t("retry"))
				),

				e("div", { className: "dcs-sep" }),
				e("div", { className: "dcs-sec" },
					e("div", { className: "dcs-line" },
						e("span", { className: "dcs-lab" }, t("log")),
						log === null ? null : e("span", { className: "dcs-lab" }, String(log.length))
					),
					log === null
						? e("span", { className: "dcs-empty" }, t("loading"))
						: log.length === 0
							? e("span", { className: "dcs-empty" }, t("logEmpty"))
							: e("div", { className: "dcs-list" }, log.map((row, i) =>
								e("div", { className: "dcs-item", key: String(i) },
									e("span", null, fmtTime(row.at ?? row.time)),
									e("span", { className: "dcs-val" },
										e("b", null, fmtTokens(row.beforeTokens)),
										" → ",
										e("b", null, fmtTokens(row.afterTokens)),
										row.savedTokens > 0 ? "  −" + fmtTokens(row.savedTokens) : "",
										row.model ? e("span", { className: "dcs-lab" }, "  " + row.model) : null
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
				close: "关闭",
				enabled: "接管压缩阈值",
				route: "摘要模型（压缩那一次调用）",
				routeProvider: "摘要 provider",
				routeModel: "摘要 model",
				followSession: "跟随会话模型",
				pickModel: "选择模型…",
				unavailable: "（当前不可用）",
				modelMissing: "已选 provider 但未选模型 —— 摘要仍然跟随会话模型。",
				threshold: "触发阈值",
				windowMath: "窗口 {window} → 触发于 {at}",
				windowUnknown: "本会话的模型窗口还未知（发一条消息后出现）",
				notBinding: "注意：阈值被上下文余量夹住了，滑块比例未真正生效。",
				engines: "已接管 {count} 个压缩引擎",
				noEngines: "未找到压缩引擎 —— compaction-basic 可能没挂载。",
				log: "压缩记录",
				logEmpty: "本会话还没有压缩过。",
				loading: "读取中…",
				loadFailed: "无法读取状态",
				saveFailed: "保存失败",
				retry: "重试"
			},
			en: {
				chip: "Compact",
				title: "Context compaction",
				close: "Close",
				enabled: "Take over the compaction threshold",
				route: "Summary model (the compaction call)",
				routeProvider: "Summary provider",
				routeModel: "Summary model",
				followSession: "Follow the session model",
				pickModel: "Pick a model…",
				unavailable: "(unavailable)",
				modelMissing: "Provider selected without a model — summaries still follow the session model.",
				threshold: "Trigger threshold",
				windowMath: "window {window} → compacts at {at}",
				windowUnknown: "This session's model window is not known yet (send a message)",
				notBinding: "Note: the capacity term is capping the threshold, so the ratio is not in effect.",
				engines: "{count} compaction engine(s) under control",
				noEngines: "No compaction engine found — compaction-basic may not be mounted.",
				log: "Compaction log",
				logEmpty: "Nothing compacted in this session yet.",
				loading: "Loading…",
				loadFailed: "Cannot read the state",
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
