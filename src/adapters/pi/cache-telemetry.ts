/*
 * cache-telemetry.ts — observe-only prompt-cache accounting from real provider usage.
 *
 * Pi hands every finalized assistant message a `usage` object carrying cacheRead/cacheWrite.
 * This is the measured signal for whether the
 * fold layout is actually keeping the prefix warm: `input` here is the tokens the provider
 * re-prefilled this turn (Pi normalizes it exclusive of cached tokens), so the per-turn hit
 * ratio cacheRead / (cacheRead + input) collapsing right after a fold is the cost of a
 * head-rewriting fold, and staying high is prefix stability paying off.
 *
 * Pure and in-memory: no Pi imports, no persistence — fully unit-testable.
 */

export interface TurnUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CacheTelemetrySnapshot {
	turns: number;
	last: TurnUsage | null;
	/** Per-turn hit ratio of the last turn, null before any turn or when the turn had no input side. */
	lastHitRatio: number | null;
	totals: TurnUsage;
	/** Session aggregate hit ratio, null until any input-side tokens exist. */
	hitRatio: number | null;
	/** Any non-zero cache read observed this session — the measured "there IS a live cache" bit. */
	everWarm: boolean;
	/** Fold events committed this session. */
	foldEvents: number;
	/** Tokens the fold events removed from the per-turn view (the savings side). */
	foldSavedTokens: number;
	/** Tokens the provider re-prefilled on the turns right after a fold (the cost side). */
	foldReprefillTokens: number;
	/** Whether the latest recorded response was the first request carrying a newly folded view. */
	lastTurnAfterFold: boolean;
	/**
	 * Has this provider ever reported a non-zero cache write? Several dialects never do — the Codex
	 * route reports `cached_tokens` only, and Pi hardcodes Google's write to 0 — so "no write
	 * reported" and "nothing was written" are different facts and must not be conflated.
	 */
	writeReported: boolean;
	/**
	 * Net tokens the folds are ahead by, in input-token equivalents: savings accrue every turn
	 * after the fold, the re-prefill is paid once. Null until a fold event has been measured, and
	 * null when the provider does not report cache writes — a net computed against an unmeasured
	 * cost would be a guess wearing a number's clothes.
	 */
	foldNetTokens: number | null;
	/**
	 * Fold events whose rewrite provably never reached the provider: the next turn read the whole
	 * pre-fold prompt back from cache, which is impossible if the prefix actually changed on the
	 * wire. Non-zero means something downstream — another extension's last-wins hook, or a
	 * transport-level continuation such as pi-codex-conversion's — is discarding or deferring the
	 * folded view. Detection measures the outcome, so it covers discard mechanisms that don't
	 * exist yet.
	 */
	wireDeferredFolds: number;
	/**
	 * Every usage report so far booked the whole prompt as cache read with nothing prefilled. A
	 * stateless API prefills at least the new message every turn (as input or cache write), so this
	 * shape means the transport keeps the conversation itself (a bridged CLI such as pi-with-claude)
	 * and Pi's message array is not what goes out as the prompt: a fold would rewrite a copy the
	 * model never receives. Measured from two reports, so a single odd response cannot set it.
	 */
	providerHoldsContext: boolean;
}

function ratio(cacheRead: number, input: number): number | null {
	const denom = cacheRead + input;
	return denom > 0 ? cacheRead / denom : null;
}

/** Compact token count for status lines: 1234 → `1.2k`, negatives keep their sign. */
export function k(n: number): string {
	return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class CacheTelemetry {
	private lastTurn: TurnUsage | null = null;
	private turns = 0;
	private totals: TurnUsage = { input: 0, cacheRead: 0, cacheWrite: 0 };
	/** Fold-event accounting. `pendingFold` arms the next recorded turn as the post-fold turn. */
	private foldEvents = 0;
	private foldSavedTokens = 0;
	private foldReprefillTokens = 0;
	/** Savings actually banked so far: foldSavedTokens added per post-fold turn as it happens.
	 *  Accrued incrementally rather than multiplied out at snapshot time, because a later fold
	 *  raises the per-turn rate without erasing what earlier folds already earned. */
	private foldAccruedSavedTokens = 0;
	private pendingFold = false;
	private lastTurnAfterFold = false;
	/** Wire watchdog: the last pre-fold prompt size (cacheRead+input), armed by a masking fold. */
	private pendingWireBaseline: number | null = null;
	private wireDeferredFolds = 0;
	/** Responses that carried any usage at all, and the prompt size of the latest one. A response
	 *  with every field zero reported nothing (a bridged CLI's tool-pause messages): it is neither a
	 *  baseline nor a verdict. */
	private usageTurns = 0;
	private lastPromptSize = 0;

	/**
	 * A fold event committed. The *next* recorded turn is the first request carrying the new bytes,
	 * so its cacheWrite is what the mutation cost — measured, not modelled.
	 *
	 * Attribution is deliberately one-turn-wide. A fold rewrites history from the earliest masked
	 * block forward, so the provider re-prefills that region exactly once and every later turn reads
	 * it back; charging the fold for anything beyond that first turn would double-count normal growth.
	 */
	noteFoldEvent(savedTokens: number): void {
		this.foldEvents += 1;
		if (Number.isFinite(savedTokens) && savedTokens > 0) this.foldSavedTokens += savedTokens;
		this.pendingFold = true;
		// Arm the wire watchdog. A fold that masked tokens strictly shrinks the prompt somewhere
		// BEFORE its end, so the next turn can never read the full pre-fold prompt from cache —
		// observing cacheRead ≥ that size proves the rewrite was dropped or deferred downstream.
		// Only armed when the fold masked something and a prior turn gives a non-zero baseline
		// (a no-cache provider reports cacheRead 0 and can never false-positive against > 0).
		if (Number.isFinite(savedTokens) && savedTokens > 0 && this.lastPromptSize > 0) this.pendingWireBaseline = this.lastPromptSize;
	}

	/** Record one finalized assistant message's usage. Non-finite fields count as 0. */
	record(usage: Partial<TurnUsage> | null | undefined): void {
		const clean = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
		const turn: TurnUsage = {
			input: clean(usage?.input),
			cacheRead: clean(usage?.cacheRead),
			cacheWrite: clean(usage?.cacheWrite),
		};
		this.turns += 1;
		this.lastTurn = turn;
		this.totals.input += turn.input;
		this.totals.cacheRead += turn.cacheRead;
		this.totals.cacheWrite += turn.cacheWrite;
		// A response with no usage at all reported nothing (a bridged CLI's tool-pause messages):
		// fold attribution and the wire watchdog wait for the next response that does.
		if (turn.input + turn.cacheRead + turn.cacheWrite === 0) return;
		this.usageTurns += 1;
		this.lastPromptSize = turn.cacheRead + turn.input;
		this.lastTurnAfterFold = this.pendingFold;
		if (this.pendingFold) {
			this.foldReprefillTokens += turn.cacheWrite;
			this.pendingFold = false;
		} else if (this.foldEvents > 0) {
			this.foldAccruedSavedTokens += this.foldSavedTokens;
		}
		if (this.pendingWireBaseline !== null) {
			if (turn.cacheRead >= this.pendingWireBaseline) this.wireDeferredFolds += 1;
			this.pendingWireBaseline = null;
		}
	}

	reset(): void {
		this.lastTurn = null;
		this.turns = 0;
		this.totals = { input: 0, cacheRead: 0, cacheWrite: 0 };
		this.foldEvents = 0;
		this.foldSavedTokens = 0;
		this.foldReprefillTokens = 0;
		this.foldAccruedSavedTokens = 0;
		this.pendingFold = false;
		this.lastTurnAfterFold = false;
		this.pendingWireBaseline = null;
		this.wireDeferredFolds = 0;
		this.usageTurns = 0;
		this.lastPromptSize = 0;
	}

	snapshot(): CacheTelemetrySnapshot {
		const last = this.lastTurn;
		return {
			turns: this.turns,
			last,
			lastHitRatio: last ? ratio(last.cacheRead, last.input) : null,
			totals: { ...this.totals },
			hitRatio: ratio(this.totals.cacheRead, this.totals.input),
			everWarm: this.totals.cacheRead > 0,
			foldEvents: this.foldEvents,
			foldSavedTokens: this.foldSavedTokens,
			foldReprefillTokens: this.foldReprefillTokens,
			lastTurnAfterFold: this.lastTurnAfterFold,
			writeReported: this.totals.cacheWrite > 0,
			foldNetTokens:
				this.foldEvents > 0 && this.totals.cacheWrite > 0
					? this.foldAccruedSavedTokens - this.foldReprefillTokens
					: null,
			wireDeferredFolds: this.wireDeferredFolds,
			providerHoldsContext:
				this.usageTurns >= 2 && this.totals.cacheRead > 0 && this.totals.input === 0 && this.totals.cacheWrite === 0,
		};
	}

	/** One human line for the status command / debug stderr, e.g. `cache read 12.3k/wr 0.6k (hit 66%, last 71%)`. */
	statusLine(): string {
		const s = this.snapshot();
		if (s.turns === 0) return "cache: no usage yet";
		const pct = (r: number | null): string => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
		return `cache read ${k(s.totals.cacheRead)}/wr ${k(s.totals.cacheWrite)} (hit ${pct(s.hitRatio)}, last ${pct(s.lastHitRatio)})`;
	}

	/**
	 * Both sides of what folding did to the cache, or null before any fold event.
	 *
	 * Reporting only the savings would be dishonest accounting: a fold rewrites the prefix, so the
	 * provider re-prefills from the earliest masked block forward, and that is a real token cost the
	 * extension caused. This is the line that lets a user see it.
	 */
	foldCostLine(): string | null {
		const s = this.snapshot();
		if (s.foldEvents === 0) return null;
		const masked = `folds ${s.foldEvents}: masked ${k(s.foldSavedTokens)} tok/turn`;
		// Without a reported write there is no cost side, and printing "cost 0 · net ahead" would
		// claim a win against something never measured.
		if (!s.writeReported) return `${masked}, re-prefill cost not reported by this provider`;
		const net = s.foldNetTokens;
		const verdict = net === null ? "" : net >= 0 ? ` · net +${k(net)} ahead` : ` · net ${k(net)} behind`;
		return `${masked}, cost ${k(s.foldReprefillTokens)} re-prefilled${verdict}`;
	}
}
