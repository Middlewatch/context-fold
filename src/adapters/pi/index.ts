/*
 * index.ts — the context-fold Pi extension entry point.
 *
 * Wires the folding policy into Pi's per-turn `context` hook: before every model call Pi hands
 * us a deep copy of the outgoing message array; we replace the content of stale blocks with
 * short reversible digests and return it. The real session history is never touched — folding
 * lives only in the outgoing copy. The agent pulls any folded block back with the
 * `unfold`/`recall_folded` tools by its `{#<code> FOLDED}` handle.
 *
 * The policy is the discrete fold ladder: fold events mask stale observations into prefix-stable
 * frozen layers, with a deterministic seed index emitted at every event. No model call ever fires
 * on the automatic path. Folding runs identically headless; cache-risk confirmation is opt-in UI.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage as CoreAgentMessage } from "../../core/block";
import { FoldLadderPolicy } from "../../core/policy/fold-ladder";
import { ContextFoldEngine, DEFAULT_CONFIG } from "./store";
import { SeedIndexStore, emitFoldIndex, emitCompactIndex, recordCompactedBlocks } from "./index-store";
import { renderDetCompactionSummary } from "./compact";
import { registerHandoffCommand } from "./handoff";
import { linearize, type WireBlock } from "../../core/block";
import { registerFoldTools } from "./unfold-tool";
import { MapFoldRegistry } from "../../core/fold-registry";
import { LedgerReader } from "./ledger";
import { recordFoldEntry, recordLayer, recordUnfold, restoreFoldState } from "./persistence";
import { CacheTelemetry, k } from "./cache-telemetry";
import { advise } from "./advisor";
import { CacheWarning, notifyCacheWarning } from "./cache-warning";

import { adapterConfigFromEnv, configFromEnv, debugEnabled, type SavedSettings } from "./config";
import { loadSavedSettings, runSettingsMenu, settingsReport } from "./settings";

export default function contextFold(pi: ExtensionAPI): void {
	// MASTER kill switch: CONTEXTFOLD=0/off/false disables the whole extension — no hooks, no
	// tools, no folding — without changing the installed package.
	const master = process.env.CONTEXTFOLD?.trim().toLowerCase();
	if (master === "0" || master === "off" || master === "false") {
		process.stderr.write("[context-fold] disabled by CONTEXTFOLD=0 — no folding this session\n");
		return;
	}
	let savedSettings = loadSavedSettings();
	const cacheWarning = new CacheWarning(() => savedSettings);
	const acfg = adapterConfigFromEnv(savedSettings);
	const foldCfg = configFromEnv(savedSettings);
	const ladderPolicy = new FoldLadderPolicy(acfg.ladder);

	// Fold metadata for ladder folds, shared by fold-index emission and recall.
	const registry = new MapFoldRegistry();
	const engine = new ContextFoldEngine(ladderPolicy, foldCfg, registry);

	// Settings-menu live apply: re-resolve the whole effective config (default < saved < env) so a
	// cleared knob falls back correctly, then push it into the policy, the engine, and acfg. Frozen
	// layers keep their bytes; new values steer future folds only.
	const applySavedSettings = (saved: SavedSettings) => {
		savedSettings = saved;
		const a = adapterConfigFromEnv(saved);
		acfg.ladder = a.ladder;
		acfg.reconTokens = a.reconTokens;
		acfg.compact = a.compact;
		ladderPolicy.setConfig(a.ladder);
		engine.setConfig({
			budgetFraction: DEFAULT_CONFIG.budgetFraction,
			absoluteTokenCap: DEFAULT_CONFIG.absoluteTokenCap,
			tailTarget: DEFAULT_CONFIG.tailTarget,
			...configFromEnv(saved),
		});
	};

	const debug = debugEnabled();
	const dumpPath = process.env.CONTEXTFOLD_DUMP?.trim() || null;
	const telemetry = new CacheTelemetry();
	engine.onLayerCommit = (layer) => {
		try {
			recordLayer(pi, layer);
			const saved = engine.status?.metrics?.tokens_saved;
			telemetry.noteFoldEvent(typeof saved === "number" ? saved : 0);
			return true;
		} catch (err) {
			process.stderr.write(`[context-fold] layer persistence failed (fold skipped): ${err instanceof Error ? err.message : String(err)}\n`);
			return false;
		}
	};

	// ── advisory state (display-only; nothing here gates a turn) ─────────────────────────────────
	// Counted on session_compact (the terminal event), never on session_before_compact: an
	// attempted compaction that Pi cancels or that fails must not read as a forced one.
	let compactions = 0;
	// The seq the det-compaction handler's index record claimed, retracted if Pi then reports
	// the compaction failed — a recovery map for a compaction that never happened must not
	// shadow later summaries.
	let pendingCompactSeq: number | null = null;
	let lastContextWindow: number | null = null;
	let wasCold = false;
	let warnedWireDeferral = false;
	let announcedProviderHeld = false;
	// True when Pi couldn't report a token count this turn (post-compaction window) and the ladder
	// fell back to its chars÷4 liveTokens estimate — /context-fold marks its usage % with `~` there.
	let ctxUsageIsEstimate = false;
	const buildAdvisory = () => {
		const t = telemetry.snapshot();
		const m = engine.status?.metrics ?? {};
		const carried = t.last
			? t.last.cacheRead + t.last.input
			: typeof m.live_tokens === "number"
				? m.live_tokens
				: null;
		return advise({
			turns: t.turns,
			everWarm: t.everWarm,
			lastCacheRead: t.last?.cacheRead ?? 0,
			lastInput: t.last?.input ?? 0,
			lastTurnAfterFold: t.lastTurnAfterFold,
			carriedTokens: carried,
			contextWindow: lastContextWindow,
			irreducibleFloor: typeof m.irreducible_floor === "number" ? m.irreducible_floor : null,
			reconTokens: acfg.reconTokens,
			recallCalls: engine.recallStats.calls,
			maxRecallsPerCode: engine.recallStats.maxPerCode,
			compactions,
			wireDeferredFolds: t.wireDeferredFolds,
		});
	};

	// The trigger gauge: render whichever ladder condition is actually binding, so the line stays
	// meaningful in every state. Below the entry threshold that IS the threshold ("next fold at
	// 45% ctx"); at or past it the usage threshold is permanently satisfied and the real trigger is
	// maskable mass reaching one ladder step, so the gauge tracks that instead — counting up from
	// 0 right after a fold, since interim emptiness refills as new observations land. "No more
	// folds possible" is reserved for the terminal state where the irreducible floor is over
	// budget. Everything comes from the ladder's published metrics (env-configured, cold-branch
	// aware) — never re-derived or hard-coded here.
	const foldGauge = (m: Record<string, unknown>): string | null => {
		if (m.provider_holds_context === true) return "folding paused: provider holds the context";
		if (m.over_budget === true) return "⚠ no more folds possible (over budget)";
		if (typeof m.usage_fraction !== "number" || typeof m.fold_at !== "number") return null;
		if (m.usage_fraction < m.fold_at) return `next fold at ${Math.round(m.fold_at * 100)}% ctx`;
		if (typeof m.maskable_tokens !== "number" || typeof m.step_tokens !== "number") return null;
		return `next fold: ${k(m.maskable_tokens)}/${k(m.step_tokens)} maskable`;
	};

	// Persistent footer status: one keyed line in Pi's footer (TUI renders it below the stats
	// line; headless modes stub setStatus to a no-op). Updated per turn rather than flashed per
	// event — the numbers ticking up ARE the fold notification, with no transcript pollution.
	const updateFooter = (hctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } }) => {
		const setStatus = hctx.ui?.setStatus?.bind(hctx.ui);
		if (!setStatus) return;
		const s = telemetry.snapshot();
		const parts = [
			// The footer labels this line with the extension key, so the text stays name-free.
			s.foldEvents === 0 ? "⧉ idle" : `⧉ ×${s.foldEvents} · ~${k(s.foldSavedTokens)} tok masked`,
		];
		const gauge = foldGauge(engine.status?.metrics ?? {});
		if (gauge) parts.push(gauge);
		if (s.hitRatio !== null) parts.push(`cache avg ${Math.round(s.hitRatio * 100)}%`);
		if (s.wireDeferredFolds > 0) parts.push("⚠ folds not on wire");
		setStatus("context-fold", parts.join(" · "));
	};

	// Recall's ledger route: one cached reader per session, attached on every hook that carries a
	// ctx so recall works regardless of hook arrival order.
	let ledgerKey = "";
	const ensureLedger = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string; getEntries(): unknown[] } }): void => {
		// Keyed by dir + id like the index store: a same-id session in another directory must not
		// be served by a stale reader.
		const sid = join(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
		if (ledgerKey === sid) return;
		ledgerKey = sid;
		engine.attachLedger(new LedgerReader(() => ctx.sessionManager.getEntries() as { type?: string; message?: unknown }[]));
	};

	// The extension's on-disk home: append-only text (seed index, handoff seeds) measured in
	// kilobytes, retained like Pi's own session files — no GC.
	const artifactDirFor = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } }): string =>
		join(ctx.sessionManager.getSessionDir(), "context-fold", ctx.sessionManager.getSessionId());

	let indexStore: SeedIndexStore | null = null;
	let indexKey = "";
	const indexFor = (ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } }): SeedIndexStore => {
		const dir = artifactDirFor(ctx);
		if (!indexStore || indexKey !== dir) {
			indexStore = new SeedIndexStore(dir);
			indexKey = dir;
		}
		return indexStore;
	};

	// On resume, rebuild the fold registry, unfold set, and frozen layers from the event-sourced
	// fold records, and point recall's ledger route at this session's entries.
	// Keyed by SESSION ID: a session switch inside one process re-restores for the new session and
	// clears the previous session's registry (stale codes must never serve another session's blocks).
	let restoredFor = "";
	pi.on("session_start", (_event, ctx) => {
		cacheWarning.restore(ctx);
		const sid = ctx.sessionManager.getSessionId();
		if (restoredFor === sid) return;
		const isSwitch = restoredFor !== "";
		restoredFor = sid;

		if (isSwitch) {
			registry.clear();
			engine.resetForSession();
			telemetry.reset();
			// Closure-held advisory state is per-session too — stale values would make the new
			// session's first /context-fold report the old session's compactions or cold streak.
			compactions = 0;
			pendingCompactSeq = null;
			wasCold = false;
			lastContextWindow = null;
			warnedWireDeferral = false;
			announcedProviderHeld = false;
			ctxUsageIsEstimate = false;
		}
		ensureLedger(ctx);
		updateFooter(ctx);

		// Seq continuity across resume: a compact index record claims max(index)+1, and restoring
		// layers alone would floor the engine below it — the next fold event would then reuse that
		// seq and shadow the compaction recovery map (the JSONL contract is latest-per-seq wins).
		// Runs AFTER the switch reset (which zeroes the floor) and regardless of whether any fold
		// ledger exists — a compact record can exist without one.
		try {
			engine.ensureLayerSeqAtLeast(indexFor(ctx).readAll().reduce((m, r) => Math.max(m, r.seq), 0));
		} catch (err) {
			process.stderr.write(`[context-fold] seed-index seq floor skipped: ${err instanceof Error ? err.message : String(err)}\n`);
		}

		try {
			const { foldEntries, unfoldedIds, layers } = restoreFoldState(ctx.sessionManager.getEntries() as unknown as { customType?: string; data?: unknown }[]);
			if (foldEntries.length === 0 && unfoldedIds.size === 0 && layers.length === 0) return;
			for (const e of foldEntries) registry.set(e);
			engine.restoreUnfolded(unfoldedIds);
			// Layers restore byte-verbatim — the persisted substitution bytes are replayed rather
			// than recomputed, so a resumed session's context head is byte-identical to the one
			// the provider already cached.
			engine.restoreLayers(layers);
			if (debug)
				process.stderr.write(
					`[context-fold] resume: restored ${foldEntries.length} fold entries, ${unfoldedIds.size} unfolds, ${layers.length} layers\n`,
				);
		} catch (err) {
			// Fail-open: a restore failure just means prior folds render raw this session — but say so,
			// or the only symptom is silent token creep.
			process.stderr.write(`[context-fold] resume restore failed (folds render raw): ${err instanceof Error ? err.message : String(err)}\n`);
		}
	});

	pi.on("session_tree", (_event, ctx) => cacheWarning.restore(ctx));
	pi.on("session_shutdown", () => cacheWarning.dispose());
	pi.on("agent_start", () => cacheWarning.pause());
	pi.on("input", (event, ctx) => cacheWarning.input(event, ctx));

	// OBSERVE-ONLY cache telemetry: every finalized assistant message carries real provider
	// usage (cacheRead/cacheWrite). The per-turn hit ratio is the measured signal for whether
	// folding kept the prefix warm — it collapses on the turn after a head-rewriting fold.
	pi.on("message_end", (event, ctx) => {
		cacheWarning.observe(event.message);
		const message = event.message as { role?: string; usage?: Record<string, number> };
		if (message.role !== "assistant" || !message.usage) return;
		telemetry.record(message.usage);
		updateFooter(ctx);
		// Wire watchdog: a fold committed, yet this turn read the whole pre-fold prompt back from
		// cache — the rewrite never reached the provider. Once per session, not per turn.
		if (!warnedWireDeferral && telemetry.snapshot().wireDeferredFolds > 0) {
			warnedWireDeferral = true;
			process.stderr.write(
				"[context-fold] fold committed but not observed on the wire — another extension or the transport is bypassing it (pi-codex-conversion's continuation defers folds to the next user turn)\n",
			);
		}
		if (debug) {
			// The fold-cost half belongs on stderr too, not only in the interactive status command:
			// headless `-p` runs are where fold cost actually gets measured, and there is no command
			// to invoke there.
			const foldCost = telemetry.foldCostLine();
			process.stderr.write(`[context-fold] ${telemetry.statusLine()}${foldCost ? ` · ${foldCost}` : ""}\n`);
		}
		if (dumpPath) {
			// E2E seam, sibling of the view dump: keep the view payload a message array and write
			// telemetry beside it.
			try {
				writeFileSync(`${dumpPath}.telemetry.json`, JSON.stringify(telemetry.snapshot()), "utf8");
			} catch {
				/* dump is best-effort */
			}
		}
	});

	// A Pi "turn" is one provider response, so message_end also fires for every intermediate
	// tool-call response while the agent is visibly still working. Coldness is a session-level
	// recommendation: evaluate it only once Pi says retries, compaction and queued continuations
	// have all settled. This also lets a transient cache miss recover later in the same agent run.
	pi.on("agent_settled", (_event, ctx) => {
		cacheWarning.refresh(ctx);
		const t = telemetry.snapshot();
		const adv = buildAdvisory();
		if (adv.coldNow && !wasCold) {
			const carried = t.last ? t.last.cacheRead + t.last.input : 0;
			if (carried >= 20_000)
				notifyCacheWarning(ctx,
					`session cold: rebilled ~${Math.round(carried / 1000)}k tok as fresh input. Consider /fold-handoff`,
				);
		}
		// The first response after a fold is intentionally excluded from cold detection because the
		// extension itself rewrote the prefix. Treat it as an ignored sample, not a warm recovery:
		// otherwise a genuinely cold streak would reset here and warn again on its next response.
		if (!t.lastTurnAfterFold) wasCold = adv.coldNow;
	});

	// The make-or-break hook: rewrite the outgoing context before each model call.
	pi.on("context", (event, ctx) => {
		try {
			ensureLedger(ctx);
			lastContextWindow = ctx.getContextUsage()?.contextWindow ?? lastContextWindow;
			// Ladder cold branch: no live cache read observed after a few turns ⇒ there is no warm
			// prefix to protect, so the ladder folds earlier and more freely (measured, not assumed).
			const t = telemetry.snapshot();
			ladderPolicy.setCold(t.turns >= 3 && t.totals.cacheRead === 0);
			// A transport that holds the conversation itself (whole prompt read from cache, nothing
			// prefilled, two responses running) never receives a fold's rewrite: pause the ladder rather
			// than commit layers and index records the model can never see.
			ladderPolicy.setProviderHoldsContext(t.providerHoldsContext);
			if (debug && t.providerHoldsContext && !announcedProviderHeld) {
				announcedProviderHeld = true;
				process.stderr.write("[context-fold] usage shows the transport holds the conversation — folding paused for this session\n");
			}
			// Fold-event → seed-index emission. Bound per turn so the emitter sees this ctx's stores.
			engine.onFoldEvent = (foldEvent) => {
				try {
					const { record: rec, droppedIds } = emitFoldIndex(foldEvent, {
						registry,
						index: indexFor(ctx),
						sessionId: ctx.sessionManager.getSessionId(),
						persistEntry: (entry) => recordFoldEntry(pi, entry),
					});
					if (droppedIds.length)
						process.stderr.write(
							`[context-fold] fold-code collision: ${droppedIds.length} block(s) stay raw for this session (${droppedIds.join(", ")})\n`,
						);
					if (debug)
						process.stderr.write(
							`[context-fold] seed-index seq=${rec.seq} (${rec.trigger}): ${rec.spans.length} spans, ${rec.identifiers.length} ids, ${rec.errors.length} errors\n`,
						);
					return droppedIds.length ? droppedIds : true;
				} catch (err) {
					// Reversibility is a commit precondition. Keep this turn raw when durability fails.
					process.stderr.write(`[context-fold] seed-index emission failed (fold skipped): ${err instanceof Error ? err.message : String(err)}\n`);
					return false;
				}
			};
			const usage = ctx.getContextUsage();
			ctxUsageIsEstimate = usage?.tokens == null;
			const messages = engine.process(event.messages as unknown as CoreAgentMessage[], {
				contextWindow: usage?.contextWindow ?? null,
				tokens: usage?.tokens ?? null,
			});
			// The cast is the pure/effectful boundary (core/block.ts): the core's structural AgentMessage
			// models exactly the fields the bridge reads, and Pi's real AgentMessage satisfies it.
			updateFooter(ctx); // reflect a fold committed this turn (and the fresh trigger gauge)
			if (dumpPath) {
				// e2e seam: dump the outgoing view so the harness can assert the pointer replaced the payload.
				try {
					writeFileSync(dumpPath, JSON.stringify(messages), "utf8");
				} catch {
					/* dump is best-effort */
				}
			}
			return { messages: messages as unknown as typeof event.messages };
		} catch (err) {
			// Fail-open like the sibling hooks: an engine defect costs this turn's folding (context
			// goes out raw), never the turn itself. The host also catches, but degrade locally and say so.
			process.stderr.write(`[context-fold] fold pass failed (context sent raw): ${err instanceof Error ? err.message : String(err)}\n`);
			return { messages: event.messages };
		}
	});

	// HARD COMPACTION (the hard floor): the automatic path NEVER summarizes with a model. With
	// CONTEXTFOLD_COMPACT=det (default) we hand Pi a deterministic summary rendered verbatim from
	// the seed index — no hallucination surface, every listed token a lexical hook for recall —
	// after emitting one final "compact" index record for the span leaving live history.
	// CONTEXTFOLD_COMPACT=native leaves Pi's own compaction untouched. Fail-open: any error here
	// falls through to Pi's default behavior.
	pi.on("session_before_compact", (event, ctx) => {
		if (acfg.compact !== "det") return;
		try {
			const prep = (event as { preparation: { messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; tokensBefore: number; firstKeptEntryId: string; previousSummary?: string } }).preparation;
			ensureLedger(ctx);
			const index = indexFor(ctx);
			// Pi hands a mid-turn cut over in TWO arrays and drops BOTH from live history:
			// `messagesToSummarize` is the whole turns before the cut turn, `turnPrefixMessages` is the
			// cut turn's own head (compaction.ts: historyEnd = isSplitTurn ? turnStartIndex :
			// firstKeptEntryIndex). Pi's native path summarizes the prefix separately; returning a
			// summary here replaces that path outright, so the prefix is ours to carry or lose. The
			// ranges are disjoint and in this order chronological. Reading only the first array once cost
			// a live session its whole history: the cut landed inside the opening turn, so
			// `messagesToSummarize` was empty and the summary rendered as a bare header.
			const leaving = [
				...(prep.messagesToSummarize ?? []),
				...(prep.turnPrefixMessages ?? []),
			] as unknown as CoreAgentMessage[];
			const blocks = linearize(leaving) as unknown as WireBlock[];
			// Record-at-compaction: blocks leaving live history that never folded get codes and fold
			// records too — the compact record below then carries recovery spans for the whole span,
			// and recall resolves them from the ledger.
			const recordedNow = recordCompactedBlocks(blocks, {
				registry,
				persistEntry: (entry) => recordFoldEntry(pi, entry),
			});
			if (recordedNow.skippedIds.length)
				// Per-block fail-open, announced: these blocks leave live history with no recall route
				// beyond Pi's session file itself.
				process.stderr.write(
					`[context-fold] compaction: ${recordedNow.skippedIds.length} block(s) not recallable (record failed): ${recordedNow.skippedIds.join(", ")}\n`,
				);
			if (debug && recordedNow.added.length)
				process.stderr.write(`[context-fold] compaction: recorded ${recordedNow.added.length} unfolded block(s) leaving history\n`);
			const compactRecord = emitCompactIndex(blocks, {
				registry,
				index,
				sessionId: ctx.sessionManager.getSessionId(),
				tokensBefore: prep.tokensBefore,
				contextWindow: lastContextWindow,
			});
			// The compact record claimed a seq; the next fold event must start past it. Remember it
			// so a failed compaction can retract it.
			engine.ensureLayerSeqAtLeast(compactRecord.seq);
			pendingCompactSeq = compactRecord.seq;
			const summary = renderDetCompactionSummary({
				records: index.readAll(),
				sessionFilePath: ctx.sessionManager.getSessionFile?.(),
				previousSummary: prep.previousSummary,
			});
			if (debug)
				process.stderr.write(`[context-fold] det compaction: ${prep.tokensBefore} tok summarized deterministically (no model)\n`);
			return { compaction: { summary, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore } };
		} catch (err) {
			process.stderr.write(
				`[context-fold] det compaction failed (falling back to Pi default): ${err instanceof Error ? err.message : String(err)}\n`,
			);
			return;
		}
	});

	// Terminal compaction events: the count and the index record settle only here.
	pi.on("session_compact", (_event, ctx) => {
		cacheWarning.refresh(ctx);
		compactions++;
		pendingCompactSeq = null;
	});
	// `session_compact_failed` postdates Pi 0.84 (whose typings this build pins); on an older
	// engine the handler simply never fires and a failed compaction keeps its premature record.
	// Registered through a plain-string signature so both versions load.
	const onAny = pi.on as unknown as (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
	onAny("session_compact_failed", (event, rawCtx) => {
		const ctx = rawCtx as { sessionManager: { getSessionDir(): string; getSessionId(): string } };
		const e = event as { reason?: string; errorMessage?: string; aborted?: boolean };
		const why = e.aborted ? "aborted" : (e.errorMessage ?? "failed");
		process.stderr.write(`[context-fold] compaction (${e.reason ?? "?"}) did not complete (${why}) — not counted\n`);
		if (pendingCompactSeq === null) return;
		try {
			indexFor(ctx).appendRetraction(pendingCompactSeq);
			if (debug) process.stderr.write(`[context-fold] retracted seed-index compact record seq ${pendingCompactSeq}\n`);
		} catch (err) {
			// Fail-open: a stale compact record costs duplicate pointers in a later summary, never a turn.
			process.stderr.write(
				`[context-fold] compact-record retraction failed (record left in place): ${err instanceof Error ? err.message : String(err)}\n`,
			);
		} finally {
			pendingCompactSeq = null;
		}
	});

	// A real model change cold-starts the provider cache: telemetry spanning it would blend two
	// incompatible measurements, so the segment restarts. `restore` precedes a fresh telemetry
	// object and is ignored; re-selecting the same model is not a change.
	pi.on("model_select", (event, ctx) => {
		const e = event as {
			model?: { provider?: string; id?: string };
			previousModel?: { provider?: string; id?: string };
			source?: string;
		};
		if (e.source === "restore" || !e.previousModel || !e.model) return;
		if (e.previousModel.provider === e.model.provider && e.previousModel.id === e.model.id) return;
		telemetry.reset();
		wasCold = false;
		cacheWarning.refresh(ctx);
		updateFooter(ctx as unknown as Parameters<typeof updateFooter>[0]);
		if (debug) process.stderr.write("[context-fold] model changed — cache telemetry segment restarted\n");
	});

	registerFoldTools(pi, engine, (ids) => recordUnfold(pi, ids));
	registerHandoffCommand(pi, {
		indexFor: (hctx) => indexFor(hctx as Parameters<typeof indexFor>[0]),
		seedDirFor: (hctx) => artifactDirFor(hctx as Parameters<typeof artifactDirFor>[0]),
	});

	pi.registerCommand("context-fold", {
		description: "Open the context-fold menu: status, settings, and retained draft images.",
		handler: async (args, cmdCtx) => {
			const ui = cmdCtx.ui;
			const say = (message: string, level: "info" | "warning" | "error") => {
				try { ui?.notify?.(message, level); } catch {}
			};
			let sub = (args ?? "").trim().toLowerCase();
			if (!sub && cmdCtx.hasUI && ui?.select) {
				const actions = new Map([
					["Status", "status"],
					["Settings", "config"],
					["Discard retained images", "discard-images"],
				]);
				try {
					const selected = await ui.select("context-fold", [...actions.keys(), "Close"]);
					const action = selected && actions.get(selected);
					if (!action) return;
					sub = action;
				} catch (err) {
					say(`context-fold menu unavailable; showing status: ${err instanceof Error ? err.message : String(err)}`, "warning");
				}
			}
			if (sub === "discard-images") {
				cacheWarning.discardImages(cmdCtx);
				return;
			}
			if (sub === "config" || sub === "settings") {
				// Headless ui.select is a stub that answers undefined, so gate on hasUI rather than
				// method presence; fail-open — a bad settings write costs a notice, never the command.
				if (cmdCtx.hasUI && ui?.select && ui.input) {
					try {
						await runSettingsMenu(
							{
								select: (title, options) => ui.select(title, options),
								input: (title, placeholder) => ui.input(title, placeholder),
								notify: say,
							},
							(saved) => {
								applySavedSettings(saved);
								cacheWarning.refresh(cmdCtx);
							},
							undefined,
							cmdCtx.model?.provider,
						);
					} catch (err) {
						say(
							`context-fold settings error (nothing else affected): ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
				} else {
					say(
						`context-fold settings (env over saved over default):\n${settingsReport(loadSavedSettings(), cmdCtx.model?.provider)}`,
						"info",
					);
				}
				return;
			}
			const s = engine.status;
			const m = s?.metrics ?? {};
			const state = s?.text ? s.text : "idle (under budget)";
			const gauge = foldGauge(m);
			const pos =
				typeof m.usage_fraction === "number"
					? ` · usage ${ctxUsageIsEstimate ? "~" : ""}${Math.round((m.usage_fraction as number) * 100)}%${gauge ? ` (${gauge})` : ""}`
					: "";
			const adv = buildAdvisory();
			const lines = [
				`context-fold: ${state}${pos}`,
				`${telemetry.statusLine()}${adv.coldNow ? " · COLD" : ""}${adv.paybackTurns !== null ? ` · reset pays back in ~${adv.paybackTurns} warm turns` : ""}`,
				// Both sides of folding, not just the savings — see CacheTelemetry.foldCostLine.
				...(telemetry.foldCostLine() ? [telemetry.foldCostLine() as string] : []),
				...adv.flags.map((f) => `⚑ ${f}`),
				cmdCtx.hasUI ? "tune with /context-fold → Settings" : "tune with /context-fold config",
			];
			say(lines.join("\n"), adv.flags.length ? "warning" : "info");
		},
	});
}
