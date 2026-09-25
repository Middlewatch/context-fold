/*
 * store.ts — the fold engine: the mechanism half of the policy ⇄ mechanism contract.
 *
 * One pass per model call: linearize the outgoing messages into blocks, compute the protected
 * tail, build the `PolicyView`, ask the policy what to fold, lower its `FoldCommand[]` into wire
 * ops, and apply them. The policy decides WHICH blocks fold; this file owns everything else.
 *
 * It holds the session's mutable fold state: the set of agent-unfolded block ids (sticky — an
 * unfolded block is never re-folded), the committed prefix-stable layers, and a per-turn snapshot
 * of the linearized blocks so the recall/unfold tools can resolve a fold code back to its block.
 * That state is persisted separately as an event-sourced ledger (persistence.ts) so it survives
 * resume.
 */
import type { FoldCommand, PolicyHost, PolicyView, ViewBlock } from "../../core/contract";
import type { FoldPolicy } from "../../core/contract";
import type { AgentMessage, FoldOp, WireBlock } from "../../core/block";
import { blockId, linearize, isDurableId } from "../../core/block";
import { applyPlan } from "../../core/apply";
import { digest, wireFoldable, foldCode, substTokens } from "../../core/digest";
import { estTokens, safeSlice, BLOCK_OVERHEAD } from "../../core/tokens";
import { MapFoldRegistry, type FoldEntry } from "../../core/fold-registry";
import { reviseBlocks, sha256Hex, type LedgerLookup } from "./ledger";
import { readFileSync } from "node:fs";

/** The newest block is always protected (target>0); adding an older block may not overflow this. */
const PROTECT_OVERFLOW_CAP = 1.25;

const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface FoldConfig {
	/** Fraction of the context window to fold down toward (the policy's `budget`). */
	budgetFraction: number;
	/**
	 * Absolute token ceiling on the fold budget regardless of context window; 0 disables.
	 * Attention lossiness is absolute, not window-relative: a 1M-window model does not read
	 * token 600k any better than a 272k one, so the budget is min(cap, fraction × window).
	 */
	absoluteTokenCap: number;
	/** Protected-tail token target — the newest ~N tokens are never folded. */
	tailTarget: number;
	/** Fallback context window when the host can't report one. */
	defaultContextWindow: number;
	/** Emit a one-line fold summary to stderr each turn. */
	debug: boolean;
}

export const DEFAULT_CONFIG: FoldConfig = {
	budgetFraction: 0.75,
	absoluteTokenCap: 200_000,
	tailTarget: 20_000,
	defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
	debug: false,
};

/** What the engine reports after committing a fold event's frozen layer (index emission seam). */
export interface FoldEventReport {
	/** The committed layer's seq. */
	seq: number;
	/** Why the policy folded. */
	trigger: "threshold" | "cap";
	/** Ids masked by THIS event. */
	maskedIds: string[];
	/** Every block in this turn's view, full content — the extractor's span input. */
	blocks: WireBlock[];
	usage: { tokens: number; contextWindow: number; fraction: number };
}

/** One committed prefix-stable layer (persisted verbatim; see persistence.ts). */
export interface FrozenLayer {
	seq: number;
	entries: { id: string; digestText: string }[];
}

/** Host context accounting. `tokens` is provider-anchored when Pi has a valid prior response. */
export interface ContextFrame {
	contextWindow: number | null;
	tokens: number | null;
}

type ContextFrameInput = number | null | ContextFrame;

function normalizeContextFrame(input: ContextFrameInput): ContextFrame {
	return typeof input === "number" || input === null
		? { contextWindow: input, tokens: null }
		: input;
}

/** Walk back from the newest block, protecting the newest ~`target` tokens (≤1.25× overflow cap). */
export function protectedFromIndex(blocks: { tokens: number }[], target: number): number {
	const n = blocks.length;
	if (n === 0) return 0;
	if (target === 0) return n; // protection off, all foldable
	const cap = target * PROTECT_OVERFLOW_CAP;
	let sum = blocks[n - 1].tokens; // newest block ALWAYS protected if target>0
	if (sum >= target) return n - 1;
	for (let i = n - 2; i >= 0; i--) {
		const next = sum + blocks[i].tokens;
		if (next > cap) return i + 1; // adding this older block overflows the cap
		sum = next;
		if (sum >= target) return i;
	}
	return 0;
}

/** One recall/unfold match: a fold-code resolved to one or more blocks. */
export interface CodeMatch {
	code: string;
	label: string;
	ids: string[];
	text: string;
	/** A recall-side note (dedup origin, slice/truncation nudge). */
	note?: string;
}

/** A recall failure naming the code and why the ledger route could not serve it. Surfaced to the
 *  agent as text, never thrown. */
export interface CodeError {
	code: string;
	message: string;
}

/** Partial-retrieval options for recall — honored on both the ledger and live-history routes. */
export interface RecallOptions {
	/** Return only lines matching this term (case-insensitive substring), with line numbers. */
	grep?: string;
	/** Return only lines in this 1-based inclusive range, e.g. "40-80". */
	lines?: string;
}

/** Cap a recall slice to roughly the pointer budget before nudging the agent to narrow the query. */
const RECALL_SLICE_TOKEN_CAP = 500;
/** Cap a cross-fold search sweep (span recall) — generous enough to cover many pointers at once,
 *  small enough that one sweep can't re-flood what folding saved. */
const SEARCH_TOKEN_CAP = 1000;

/** One folded block's hits from a cross-fold search sweep. */
export interface SearchHit {
	code: string;
	label: string;
	/** Matching lines, `<lineNo>: <text>` numbered against the block's full content. */
	lines: string[];
}
/**
 * Cap on a WHOLE-result recall (no grep/lines). A single recovery call must not re-flood the
 * context that the pressure-driven ladder just reduced.
 */
const RECALL_WHOLE_TOKEN_CAP = 2000;

export class ContextFoldEngine {
	private readonly cfg: FoldConfig;
	private readonly policy: FoldPolicy;

	/** Agent-unfolded block ids — held (protected from re-folding) for the rest of the session. */
	private readonly unfolded = new Set<string>();
	/** Ids whose fold was rejected permanently (fold-code collision). Held for the session so the
	 *  ladder stops proposing them — the colliding block just renders raw, per-block fail-open. */
	private readonly foldRejected = new Set<string>();
	/** Per-turn snapshot: durable id → wire block (full content), for the unfold/recall tool. */
	private snapshot = new Map<string, WireBlock>();
	/** Cross-turn deterministic digest cache (id + exact text to digest/tokens). linearize recreates
	 *  block objects every turn, so the WeakMap caches in digest.ts never hit across turns — without
	 *  this the full risk-line regex sweep re-runs over every foldable block on every model call. */
	private readonly detCache = new Map<string, { text: string; digest: string; tokens: number }>();
	/** Last status the policy published (display-only). */
	private lastStatus: { text: string | null; metrics?: Record<string, number | string | boolean> } | null = null;

	private readonly host: PolicyHost;

	// Metadata for folded blocks; recall re-locates the bytes in the session ledger by durable id.
	private readonly registry: MapFoldRegistry;
	/** The session ledger, attached by the adapter (null in bare-engine tests → live-only recall). */
	private ledger: LedgerLookup | null = null;

	// ── recall-churn accounting (display-only; feeds the reset yellow flag) ──────────────────────
	/** Total recall/search tool invocations this session. */
	private recallCallCount = 0;
	/** Per-code recall counts — a code recalled again and again is the measured churn signature. */
	private readonly recallByCode = new Map<string, number>();

	// ── Prefix-stable frozen layers ──────────────────────────────────────────────────────────────
	/** Committed substitutions: id → frozen digestText. Bytes are fixed once committed; an agent
	 *  unfold masks a single id at render time rather than changing what is stored here. */
	private frozenById = new Map<string, string>();
	/** Seq of the newest committed layer (layers are numbered from 1). */
	private lastLayerSeq = 0;
	/** Adapter callback: persist a prepared layer. False rejects the fold before it reaches the wire. */
	onLayerCommit: ((layer: FrozenLayer) => unknown) | null = null;
	/** Adapter callback: durably record/index a prepared event. `false` rejects the whole fold;
	 *  an array of block ids drops just those blocks (fold-code collision) and commits the rest.
	 *  Dropped ids are held for the session. */
	onFoldEvent: ((event: FoldEventReport) => unknown) | null = null;

	constructor(policy: FoldPolicy, cfg: Partial<FoldConfig> = {}, registry: MapFoldRegistry = new MapFoldRegistry()) {
		this.cfg = { ...DEFAULT_CONFIG, ...cfg };
		this.policy = policy;
		this.registry = registry;
		this.host = {
			setStatus: (text, metrics) => {
				this.lastStatus = { text, metrics };
			},
		};
		this.policy.attach?.(this.host);
	}

	/** Live-apply seam (settings menu): budget knobs change for future turns; frozen layers keep their bytes. */
	setConfig(partial: Partial<FoldConfig>): void {
		Object.assign(this.cfg, partial);
	}

	/** Attach the session ledger recall reads from (adapter-owned; swapped on session switch). */
	attachLedger(ledger: LedgerLookup | null): void {
		this.ledger = ledger;
	}

	get status() {
		return this.lastStatus;
	}

	/** Reset per-session state (session switch in one process): unfolds and per-block caches. */
	resetForSession(): void {
		this.recallCallCount = 0;
		this.recallByCode.clear();
		this.unfolded.clear();
		this.foldRejected.clear();
		this.snapshot = new Map();
		this.detCache.clear();
		this.frozenById = new Map();
		this.lastLayerSeq = 0;
		this.lastStatus = null; // stale metrics would feed the new session's advisor
	}

	/** Raise the fold-event seq floor. The compact index record claims max(index)+1, and neither
	 *  commitLayer nor a resume's restoreLayers knows about it — without this floor the next fold
	 *  event reuses that seq, and under the seed-index "latest record per seq wins" contract the
	 *  shadowed record is the compaction recovery map. */
	ensureLayerSeqAtLeast(seq: number): void {
		if (Number.isFinite(seq) && seq > this.lastLayerSeq) this.lastLayerSeq = seq;
	}

	/** Restore committed layers on session resume (event-sourced; bytes verbatim). */
	restoreLayers(layers: FrozenLayer[]): void {
		for (const layer of [...layers].sort((a, b) => a.seq - b.seq)) {
			for (const e of layer.entries) this.frozenById.set(e.id, e.digestText);
			if (layer.seq > this.lastLayerSeq) this.lastLayerSeq = layer.seq;
		}
	}

	/** Frozen substitutions for blocks present this turn (skipping agent unfolds — an unfold is a
	 *  deliberate single-point prefix break and the block stays held, never re-frozen). */
	private computeFrozenOps(blocks: WireBlock[]): Map<string, string> {
		const out = new Map<string, string>();
		if (this.frozenById.size === 0) return out;
		for (const b of blocks) {
			const digestText = this.frozenById.get(b.id);
			if (digestText === undefined || this.unfolded.has(b.id)) continue;
			out.set(b.id, digestText);
		}
		return out;
	}

	/**
	 * The per-turn pipeline. Takes the outgoing message array (a deep copy pi already made) and the
	 * host-reported context window; returns the rewritten array to send. Pure with respect to the
	 * input (applyPlan clones touched messages); mutates only this engine's instance memory.
	 */
	process(messages: AgentMessage[], context: ContextFrameInput, revisions: ReadonlyMap<string, string> = new Map()): AgentMessage[] {
		const blocks = reviseBlocks(linearize(messages), revisions);
		// Refresh the snapshot for the unfold/recall tool (full content — folding never mutates it).
		this.snapshot = new Map(blocks.map((b) => [b.id, b] as const));
		this.pruneCaches(blocks);
		const firstDelivery = new Set([...firstDeliveryResultIds(messages)].map(id => revisions.get(id) ?? id));

		const frame = normalizeContextFrame(context);

		const frozenOps = this.computeFrozenOps(blocks);
		const { cw, budget, tailTarget, protectFrom } = this.frame(blocks, frame.contextWindow, frozenOps);
		const view = this.buildView(blocks, protectFrom, budget, cw, tailTarget, frozenOps, frame.tokens, firstDelivery);

		const cmds = this.policy.conduct(view);

		const ops: FoldOp[] = cmds != null && cmds.length > 0 ? this.lower(cmds, blocks, protectFrom, firstDelivery) : [];

		// Commit only after the adapter has durably recorded and indexed the event.
		let committedOps: FoldOp[] = [];
		if (ops.length > 0) {
			const used = frame.tokens ?? view.liveTokens;
			committedOps = this.commitLayer(ops, blocks, { tokens: used, contextWindow: cw, fraction: cw > 0 ? used / cw : 0 });
		}

		// Frozen bytes outrank any late policy op for the same id (defense in depth — candidates
		// already exclude frozen blocks).
		const allOps = mergeOpsById(frozenOps, committedOps);
		if (allOps.length === 0) return messages; // nothing to fold → send unchanged

		if (this.cfg.debug) {
			const fz = frozenOps.size ? ` frozen=${frozenOps.size}` : "";
			// Report BOTH counts when the provider gave us one. The policy decides on `reported`
			// (Pi's whole-context number, system prompt included) but `live` only sums the message
			// array, so a fold can fire with live *under* budget — printing live alone makes a
			// correct fold look inexplicable to anyone reading this line to diagnose fold timing.
			const rep = view.reportedTokens !== undefined ? ` reported=${view.reportedTokens}` : "";
			process.stderr.write(
				`[context-fold] ${ops.length} folds${fz}, live=${view.liveTokens}${rep} budget=${budget} ${this.lastStatus?.text ?? ""}\n`,
			);
		}

		// The wire keeps Pi's message metadata; only fold identities carry revision suffixes.
		const originalIds = new Map([...revisions].map(([original, revised]) => [revised, original]));
		return applyPlan(messages, allOps.map(op => ({ ...op, id: originalIds.get(op.id) ?? op.id })));
	}

	/**
	 * Commit this fold event's substitutions as a new frozen layer, then report the event so the
	 * adapter can record the masked blocks and append their seed-index record.
	 *
	 * Ids owned by an earlier layer are skipped: their bytes are committed and are not this event's
	 * to change. One layer per event, numbered from 1 — the seq is the seed index's key, so it must
	 * never repeat.
	 */
	private commitLayer(
		ops: FoldOp[],
		blocks: WireBlock[],
		usage: FoldEventReport["usage"],
	): FoldOp[] {
		const entries = ops
			.filter((op) => !this.frozenById.has(op.id))
			.map((op) => ({ id: op.id, digestText: op.digestText }));
		if (entries.length === 0) return [];

		const seq = this.lastLayerSeq + 1;
		const trigger = this.lastStatus?.metrics?.trigger === "cap" ? "cap" : "threshold";
		const event = { seq, trigger, maskedIds: entries.map((e) => e.id), blocks, usage } satisfies FoldEventReport;
		const res = this.onFoldEvent?.(event);
		if (res === false) return [];

		// Per-block rejection (fold-code collision): freeze only what was durably recorded and hold
		// the dropped ids so one unrecordable block can never poison every later fold event.
		let kept = entries;
		const dropped = Array.isArray(res) ? res.filter((x): x is string => typeof x === "string") : [];
		if (dropped.length > 0) {
			for (const id of dropped) this.foldRejected.add(id);
			const droppedSet = new Set(dropped);
			kept = entries.filter((e) => !droppedSet.has(e.id));
		}
		if (kept.length === 0) return [];

		const layer: FrozenLayer = { seq, entries: kept };
		if (this.onLayerCommit?.(layer) === false) return [];

		this.lastLayerSeq = layer.seq;
		for (const entry of kept) this.frozenById.set(entry.id, entry.digestText);
		if (this.cfg.debug) process.stderr.write(`[context-fold] layer ${layer.seq} committed (${kept.length} blocks frozen)\n`);
		return kept;
	}

	/** Inspection seam for tests and diagnostics. */
	viewFor(messages: AgentMessage[], context: ContextFrameInput): PolicyView {
		const blocks = linearize(messages);
		const frozenOps = this.computeFrozenOps(blocks);
		const frame = normalizeContextFrame(context);
		const { cw, budget, tailTarget, protectFrom } = this.frame(blocks, frame.contextWindow, frozenOps);
		return this.buildView(blocks, protectFrom, budget, cw, tailTarget, frozenOps, frame.tokens);
	}

	/**
	 * Per-turn budget frame. The tail target is CLAMPED to half the budget — an unclamped default
	 * (20k) against a small context window would protect everything and permanently disable folding.
	 * Protection walks rendered weights so previously frozen blocks consume their actual wire cost.
	 */
	private frame(
		blocks: WireBlock[],
		contextWindow: number | null,
		frozenOps: Map<string, string> = new Map(),
	): { cw: number; budget: number; tailTarget: number; protectFrom: number } {
		const cw = contextWindow ?? this.cfg.defaultContextWindow;
		const cap = this.cfg.absoluteTokenCap > 0 ? this.cfg.absoluteTokenCap : Infinity;
		const budget = Math.min(cap, Math.floor(cw * this.cfg.budgetFraction));
		const tailTarget = Math.min(this.cfg.tailTarget, Math.floor(budget / 2));
		const rendered = blocks.map((b) => {
			const p = frozenOps.get(b.id);
			return { tokens: p !== undefined ? substTokens(p) : b.tokens };
		});
		return { cw, budget, tailTarget, protectFrom: protectedFromIndex(rendered, tailTarget) };
	}

	/**
	 * Resolve fold-codes to original content (read-only, no fold-state change). Registry-backed
	 * codes re-locate their bytes in the session ledger by durable id, verify them against the
	 * fold-time sha256, and support bounded whole, grep, and line-range reads — recoverable after
	 * hard compaction because the ledger is append-only. A block the ledger cannot serve becomes a
	 * typed error naming the code rather than an exception.
	 */
	resolveRecall(codes: string[], opts: RecallOptions = {}): { matches: CodeMatch[]; missing: string[]; errors: CodeError[] } {
		this.recallCallCount++;
		for (const raw of codes) {
			const c = normalizeCode(raw);
			this.recallByCode.set(c, (this.recallByCode.get(c) ?? 0) + 1);
		}
		const snapByCode = this.snapshotByCode();
		const foldByCode = new Map<string, FoldEntry>();
		for (const e of this.registry.entries()) foldByCode.set(e.code, e);

		const matches: CodeMatch[] = [];
		const missing: string[] = [];
		const errors: CodeError[] = [];

		for (const raw of codes) {
			const code = normalizeCode(raw);
			const entry = foldByCode.get(code);
			// Recall serves FOLDED content only: a snapshot hit counts only when the block is frozen.
			// Every live block's id hashes to a code, but a block that was never folded is already in
			// view — resolving it would make recall a general history reader, which this tool is
			// deliberately not.
			const hits = (snapByCode.get(code) ?? []).filter((b) => this.frozenById.has(b.id));
			if (entry) {
				const located = this.ledger?.blockById(entry.blockId);
				if (located && (entry.sha256 === undefined || sha256Hex(located.text) === entry.sha256)) {
					const { text, note } = this.recallFromLedger(entry, located.text, opts);
					const verifyNote = entry.sha256 === undefined ? "unverified (legacy record without a fold-time sha256)" : "";
					matches.push({
						code,
						label: `${entry.tool} · ledger`,
						ids: [entry.blockId],
						text,
						note: [verifyNote, note].filter(Boolean).join(" · ") || undefined,
					});
					continue;
				}
				const why = located
					? `ledger content for #${code} failed the fold-time sha256 check`
					: `block for #${code} was not found in the session ledger`;
				if (hits.length > 0) {
					// The ledger cannot serve it but the block is still live in raw history — serve it
					// from the snapshot through the same caps (DESIGN §7: a live block still resolves),
					// carrying the warning as the note so the degradation stays visible. Routed through
					// recallFromLedger so a recorded full-output file still backs grep/lines.
					const { text, note } = this.recallFromLedger(entry, joinTexts(hits), opts);
					matches.push({
						code,
						label: labelFor(hits),
						ids: hits.map((b) => b.id),
						text,
						note: [`${why} — served from live history`, note].filter(Boolean).join(" · "),
					});
				} else {
					errors.push({ code, message: `recall unavailable — ${why}` });
				}
				continue;
			}
			if (hits.length === 0) {
				missing.push(raw);
				continue;
			}
			// Live-history route (a frozen fold with no registry entry). Bounded and sliced exactly
			// like the ledger route — recall must never re-flood, whichever haystack serves it.
			const { text, note } = sliceLiveText(joinTexts(hits), opts);
			matches.push({ code, label: labelFor(hits), ids: hits.map((b) => b.id), text, note });
		}
		return { matches, missing, errors };
	}

	/**
	 * Slice a fold's ledger-located content. grep and lines= read the SAME haystack (the tool's
	 * full-output file when readable, else the ledger content), so a grep hit's line number is
	 * always a valid input for a lines= follow-up. Whole recall is token-capped: recall must never
	 * re-flood the context the ladder reduced.
	 */
	private recallFromLedger(entry: FoldEntry, content: string, opts: RecallOptions): { text: string; note?: string } {
		if (opts.lines || opts.grep) {
			let haystack = content;
			let source = "ledger";
			if (entry.fullOutputPath) {
				try {
					haystack = readFileSync(entry.fullOutputPath, "utf8");
					source = "full output";
				} catch {
					/* fall back to ledger content */
				}
			}
			if (opts.lines) return sliceByLines(haystack, opts.lines, source);
			return grepContent(haystack, opts.grep as string, source);
		}
		return capWholeRecall(content);
	}

	/**
	 * SPAN RECALL: one sweep over every currently folded block's full content, returning matching
	 * lines grouped by fold code.
	 * This is the anti-churn primitive — recovering identifiers scattered across N pointers costs
	 * one call, not N probing recalls. Line numbers agree with `recall {code} lines=<a-b>` so a
	 * follow-up slice is always valid. Token-capped like every recall surface.
	 */
	searchFolded(term: string): { hits: SearchHit[]; scanned: number; note: string } {
		this.recallCallCount++;
		const needle = term.toLowerCase();
		const hits: SearchHit[] = [];
		let scanned = 0;
		let tokens = 0;
		let truncated = false;

		const sweep = (code: string, label: string, content: string): void => {
			scanned++;
			const lines: string[] = [];
			const all = content.split("\n");
			for (let i = 0; i < all.length; i++) {
				const idx = all[i].toLowerCase().indexOf(needle);
				if (idx === -1) continue;
				// Match-centered window — the single-huge-line guard applies to the sweep too.
				const numbered = `${i + 1}: ${clipLineTo(all[i], GREP_LINE_CHAR_CAP, idx)}`;
				tokens += estTokens(numbered) + 1;
				if (tokens > SEARCH_TOKEN_CAP && (hits.length > 0 || lines.length > 0)) {
					truncated = true;
					break;
				}
				lines.push(numbered);
			}
			if (lines.length) hits.push({ code, label, lines });
		};

		const blocks = [...this.snapshot.values()].sort((a, b) => a.order - b.order);
		for (const b of blocks) {
			if (!this.frozenById.has(b.id) || this.unfolded.has(b.id)) continue;
			sweep(foldCode(b.id), labelFor([b]), b.text);
			if (truncated) break;
		}

		// Compacted-away folds: once hard compaction removes a raw message from history the block
		// leaves the snapshot, but the det compaction summary points the agent at exactly this sweep.
		// Serve those from the session ledger — the registry survives compaction for precisely this
		// reason. A block the ledger cannot serve (or that fails its sha check) is skipped here;
		// recalling that code surfaces the typed error.
		if (!truncated) {
			for (const e of this.registry.entries()) {
				if (this.snapshot.has(e.blockId) || this.unfolded.has(e.blockId)) continue;
				const located = this.ledger?.blockById(e.blockId);
				if (!located) continue;
				if (e.sha256 !== undefined && sha256Hex(located.text) !== e.sha256) continue;
				sweep(e.code, `${e.tool} · ledger (compacted out of view)`, located.text);
				if (truncated) break;
			}
		}
		const total = hits.reduce((n, h) => n + h.lines.length, 0);
		const note = truncated
			? `capped at ~${SEARCH_TOKEN_CAP} tok — narrow the term, or follow up with recall_folded {code} lines=<a-b>`
			: `${total} matching line${total === 1 ? "" : "s"} across ${hits.length} of ${scanned} folded blocks`;
		return { hits, scanned, note };
	}

	/** Recall-churn accounting for the reset yellow flag (display-only). */
	get recallStats(): { calls: number; maxPerCode: number } {
		let max = 0;
		for (const n of this.recallByCode.values()) if (n > max) max = n;
		return { calls: this.recallCallCount, maxPerCode: max };
	}

	private snapshotByCode(): Map<string, WireBlock[]> {
		const byCode = new Map<string, WireBlock[]>();
		for (const b of this.snapshot.values()) {
			const c = foldCode(b.id);
			const arr = byCode.get(c);
			if (arr) arr.push(b);
			else byCode.set(c, [b]);
		}
		return byCode;
	}

	/** Mark fold-codes' blocks unfolded (held). They expand in the view on the next turn.
	 *  A code that resolves only through the registry is reported as `compacted`: its raw message
	 *  left live history at hard compaction, so there is nothing to re-expand — but the content
	 *  still reads back through recall, and the tool message must say that rather than "no such
	 *  code". */
	markUnfold(codes: string[]): { matches: CodeMatch[]; missing: string[]; compacted: string[] } {
		const res = this.resolve(codes);
		for (const m of res.matches) for (const id of m.ids) this.unfolded.add(id);
		const foldCodes = new Set<string>();
		for (const e of this.registry.entries()) foldCodes.add(e.code);
		const missing: string[] = [];
		const compacted: string[] = [];
		for (const raw of res.missing) (foldCodes.has(normalizeCode(raw)) ? compacted : missing).push(raw);
		return { matches: res.matches, missing, compacted };
	}

	/** Restore the agent's unfold decisions on session resume (event-sourced). */
	restoreUnfolded(ids: Iterable<string>): void {
		for (const id of ids) this.unfolded.add(id);
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private resolve(codes: string[]): { matches: CodeMatch[]; missing: string[] } {
		const byCode = this.snapshotByCode();
		const matches: CodeMatch[] = [];
		const missing: string[] = [];
		for (const raw of codes) {
			const code = normalizeCode(raw);
			// Folded blocks only, same as recall: unfolding a block that was never folded is a no-op
			// wearing a success message, and would hold it against future folding as a side effect.
			const hits = (byCode.get(code) ?? []).filter((b) => this.frozenById.has(b.id));
			if (hits.length === 0) {
				missing.push(raw);
				continue;
			}
			matches.push({
				code,
				label: labelFor(hits),
				ids: hits.map((b) => b.id),
				text: hits.map((b) => b.text).join("\n\n"),
			});
		}
		return { matches, missing };
	}

	private buildView(
		blocks: WireBlock[],
		protectFrom: number,
		budget: number,
		contextWindow: number,
		tailTarget: number,
		frozenOps: Map<string, string>,
		reportedTokens: number | null,
		firstDelivery: ReadonlySet<string> = new Set(),
	): PolicyView {
		let liveTokens = 0;
		const viewBlocks: ViewBlock[] = blocks.map((b, i) => {
			const frozenText = frozenOps.get(b.id);
			const frozen = frozenText !== undefined;
			const foldable = wireFoldable(b);
			const foldedTokens = frozen ? substTokens(frozenText) : foldable ? this.detDigestTokens(b) : b.tokens;
			liveTokens += frozen ? foldedTokens : b.tokens;
			return {
				id: b.id,
				kind: b.kind,
				tokens: b.tokens,
				foldedTokens,
				held: this.unfolded.has(b.id) || firstDelivery.has(b.id) || this.foldRejected.has(b.id),
				frozen,
				protected: i >= protectFrom,
			};
		});
		return {
			blocks: viewBlocks,
			budget,
			contextWindow,
			liveTokens,
			reportedTokens: reportedTokens ?? undefined,
			reportedBudget: reportedTokens === null ? undefined : budget,
		};
	}

	/** Reuse a digest only when the source text is unchanged. */
	private detDigest(b: WireBlock): string {
		const hit = this.detCache.get(b.id);
		if (hit && hit.text === b.text) return hit.digest;
		const d = digest(b);
		this.detCache.set(b.id, { text: b.text, digest: d, tokens: estTokens(d) + BLOCK_OVERHEAD });
		return d;
	}

	private detDigestTokens(b: WireBlock): number {
		const hit = this.detCache.get(b.id);
		if (hit && hit.text === b.text) return hit.tokens;
		this.detDigest(b);
		return this.detCache.get(b.id)!.tokens;
	}

	/**
	 * Lower the policy's `FoldCommand[]` into wire ops. The engine is the SOLE author of both the
	 * digest text and its `{#code FOLDED}` tag. Single disposition: a fold on a protected, held,
	 * frozen or already-emitted id is dropped. Defense in depth — the policy already enforces
	 * these, but the wire re-checks so a bad command can never corrupt context.
	 */
	private lower(commands: FoldCommand[], blocks: WireBlock[], protectFrom: number, firstDelivery: ReadonlySet<string>): FoldOp[] {
		const byId = new Map(blocks.map((b) => [b.id, b] as const));
		const protectedAt = (id: string): boolean => {
			const b = byId.get(id);
			return b !== undefined && b.order >= protectFrom;
		};
		const canFold = (id: string): boolean => {
			const b = byId.get(id);
			return (
				!!b &&
				isDurableId(id) &&
				wireFoldable(b) &&
				!firstDelivery.has(id) &&
				!protectedAt(id) &&
				!this.unfolded.has(id) &&
				!this.foldRejected.has(id) &&
				!this.frozenById.has(id)
			);
		};

		const ops: FoldOp[] = [];
		const opIds = new Set<string>();

		for (const cmd of commands) {
			for (const id of cmd.ids) {
				if (opIds.has(id) || !canFold(id)) continue;
				ops.push({ id, digestText: this.detDigest(byId.get(id)!) });
				opIds.add(id);
			}
		}

		return ops;
	}

	/** Drop cached digests for blocks no longer in the session (bounds memory). */
	private pruneCaches(blocks: WireBlock[]): void {
		const present = new Set(blocks.map((b) => b.id));
		for (const id of [...this.detCache.keys()]) if (!present.has(id)) this.detCache.delete(id);
	}
}

/**
 * Tool results after the latest assistant response have not appeared in any provider request yet:
 * that latest assistant message issued their calls. Holding this suffix is deterministic, handles
 * parallel results, and survives resume without an adapter-side "seen" ledger.
 */
function firstDeliveryResultIds(messages: AgentMessage[]): Set<string> {
	let lastAssistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	const ids = new Set<string>();
	for (let i = lastAssistant + 1; i < messages.length; i++) {
		if (messages[i].role === "toolResult") ids.add(blockId(messages[i], i));
	}
	return ids;
}

/**
 * Clip one line to a character budget. THE single-huge-line guard: a payload that is one
 * enormous line (minified JS, JSONL, base64, a shell wrapper echoing a file as one string)
 * must not ride through any recall cap on an "always keep at least one line" rule — that is
 * exactly the re-flood hole (a live `recall lines=2-2` once returned a 40KB line and undid
 * the context reduction). When `around` is given the window CENTERS on it, so a grep
 * match deep inside the line stays visible.
 */
function clipLineTo(line: string, maxChars: number, around?: number): string {
	if (line.length <= maxChars) return line;
	if (around === undefined || around <= maxChars / 2) {
		return `${safeSlice(line, maxChars)}…[line clipped: ${line.length} chars — grep=<term> targets content inside it]`;
	}
	const start = Math.min(Math.max(0, around - Math.floor(maxChars / 2)), line.length - maxChars);
	return `[…chars ${start + 1}-${start + maxChars} of ${line.length}…] ${safeSlice(line.slice(start), maxChars)}…`;
}

/** Max chars a single kept line may occupy inside a capped recall (leaves cap headroom). */
const RECALL_LINE_CHAR_CAP = (RECALL_WHOLE_TOKEN_CAP - 200) * 4;
/** Grep/search hit lines are windows, not reads — keep them short and match-centered. */
const GREP_LINE_CHAR_CAP = 320;

/** Return the 1-based inclusive line range `a-b` of `content` (partial recall), token-capped. */
function sliceByLines(content: string, spec: string, source: string): { text: string; note?: string } {
	const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec);
	const lines = content.split("\n");
	if (!m) return { text: "", note: `malformed lines="${spec}" (want "start-end", e.g. lines=40-80) — nothing returned` };
	const a = Math.max(1, parseInt(m[1], 10));
	const b = Math.min(lines.length, parseInt(m[2], 10));
	if (a > b) return { text: "", note: `empty range ${a}-${b} (${source} has ${lines.length} lines)` };
	// Token-cap the slice: lines= must stay PARTIAL retrieval (an unbounded range would hand the
	// whole flood back and undo the fold's savings in one call). Every line is char-clipped too —
	// the cap must hold even when the "range" is one enormous line.
	const kept: string[] = [];
	let tokens = 0;
	let clipped = false;
	for (let i = a - 1; i < b; i++) {
		const body = clipLineTo(lines[i], RECALL_LINE_CHAR_CAP);
		if (body !== lines[i]) clipped = true;
		const numbered = `${i + 1}: ${body}`;
		tokens += estTokens(numbered) + 1;
		if (kept.length > 0 && tokens > RECALL_WHOLE_TOKEN_CAP) break;
		kept.push(numbered);
	}
	const last = a + kept.length - 1;
	const note =
		last < b || clipped
			? `lines ${a}-${last} of ${a}-${b} requested (${source}, ~${RECALL_WHOLE_TOKEN_CAP} tok cap${clipped ? ", long line clipped" : ""}) — narrow the range or grep`
			: `lines ${a}-${b} of ${lines.length} (${source})`;
	return { text: kept.join("\n"), note };
}

/** Cap a whole-result recall so one call can never re-flood what folding saved. */
function capWholeRecall(content: string): { text: string; note?: string } {
	if (estTokens(content) <= RECALL_WHOLE_TOKEN_CAP) return { text: content };
	const lines = content.split("\n");
	const kept: string[] = [];
	let tokens = 0;
	let clipped = false;
	for (const l of lines) {
		const body = clipLineTo(l, RECALL_LINE_CHAR_CAP);
		if (body !== l) clipped = true;
		tokens += estTokens(body) + 1;
		if (kept.length > 0 && tokens > RECALL_WHOLE_TOKEN_CAP) break;
		kept.push(body);
	}
	// When a long line was clipped, say exactly what to do next — an agent that only sees
	// "…clipped" tends to stop; the unseen content is reachable ONLY through grep.
	const clipNote = clipped
		? " · LONG LINE CLIPPED: unseen content inside it is reachable only via recall_folded {code} grep=<term> — grep for the exact token you need"
		: " — use lines=<a-b> or grep=<term> for the rest";
	return {
		text: kept.join("\n"),
		note: `result is ~${estTokens(content)} tok; showing lines 1-${kept.length} of ${lines.length} (~${RECALL_WHOLE_TOKEN_CAP} tok cap)${clipNote}`,
	};
}

/**
 * Grep `content` for a case-insensitive substring, returning matching lines with 1-based numbers,
 * capped at ~the pointer budget with a "narrow your query" nudge past the cap. The caller resolves
 * WHICH haystack (full output vs ledger) so
 * grep and lines= always share one numbering space.
 */
function grepContent(haystack: string, term: string, source: string): { text: string; note?: string } {
	const needle = term.toLowerCase();
	const hits: string[] = [];
	const linesArr = haystack.split("\n");
	for (let i = 0; i < linesArr.length; i++) {
		const idx = linesArr[i].toLowerCase().indexOf(needle);
		if (idx === -1) continue;
		// Window huge lines AROUND the match — grep is for finding, and the found term must stay
		// visible even at char 30,000 of a one-line flood.
		hits.push(`${i + 1}: ${clipLineTo(linesArr[i], GREP_LINE_CHAR_CAP, idx)}`);
	}
	if (hits.length === 0) return { text: "", note: `no lines match "${term}" (searched ${source}, ${linesArr.length} lines)` };
	const kept: string[] = [];
	let tokens = 0;
	for (const h of hits) {
		tokens += estTokens(h) + 1;
		if (kept.length > 0 && tokens > RECALL_SLICE_TOKEN_CAP) break;
		kept.push(h);
	}
	const note =
		kept.length < hits.length
			? `${kept.length} of ${hits.length} matches for "${term}" (${source}) — narrow your query or use lines=<a-b>`
			: `${hits.length} match${hits.length === 1 ? "" : "es"} for "${term}" (${source})`;
	return { text: kept.join("\n"), note };
}

/** Join a code's snapshot blocks into the one haystack recall slices (colliding ids share a code). */
function joinTexts(blocks: WireBlock[]): string {
	return blocks.map((b) => b.text).join("\n\n");
}

/** Bounded read of live-history text — the same caps and slicing as the ledger route. */
function sliceLiveText(text: string, opts: RecallOptions): { text: string; note?: string } {
	if (opts.lines) return sliceByLines(text, opts.lines, "live block");
	if (opts.grep) return grepContent(text, opts.grep, "live block");
	return capWholeRecall(text);
}

/** Existing frozen ops first, then new policy ops whose id was not already claimed. */
function mergeOpsById(existing: Map<string, string>, policyOps: FoldOp[]): FoldOp[] {
	const out: FoldOp[] = [];
	for (const [id, digestText] of existing) out.push({ id, digestText });
	for (const op of policyOps) if (!existing.has(op.id)) out.push(op);
	return out;
}

// ── small pure helpers ─────────────────────────────────────────────────────────

/** Accept a bare code or a full `{#code FOLDED}` tag from the agent. */
function normalizeCode(raw: string): string {
	const m = /\{#([a-z0-9]{1,8})\s+FOLDED\}/i.exec(raw);
	if (m) return m[1].toLowerCase();
	return raw.trim().replace(/^#/, "").toLowerCase();
}

function labelFor(blocks: WireBlock[]): string {
	const b = blocks[0];
	const more = blocks.length > 1 ? ` (+${blocks.length - 1})` : "";
	const name = b.toolName ? ` ${b.toolName}` : "";
	return `${b.kind}${name} · turn ${b.turn}${more}`;
}
