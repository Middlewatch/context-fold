/*
 * fold-ladder.ts — the discrete fold ladder: the folding policy.
 *
 * Deterministic observation masking at DISCRETE fold events rather than continuous per-turn
 * folding (the published evidence says deterministic masking matches LLM summarization at lower
 * cost, and continuous folding measurably drove recall churn here). Between fold
 * events the context is append-only: any mutation of history moves bytes and invalidates the
 * provider's prompt-cache suffix, so masking is batched at chosen boundaries where that
 * invalidation is paid once, and each event's substitutions are committed by the engine as a
 * prefix-stable frozen layer whose bytes never change again.
 *
 * A fold event fires when BOTH hold:
 *   • usage ≥ the first-fold threshold (~45 % of the context window; the cold branch lowers it —
 *     with no live cache read there is no prefix to protect, so fold earlier), and
 *   • the maskable mass is worth a fold (≥ step × window) — this is what spaces warm events: each
 *     fold must buy at least one ladder step, so a fresh fold can't re-fire on the next turn.
 * Crossing the budget cap is an emergency event with no minimum. An expired prefix past the
 * threshold folds every eligible block outside the tail (floor min(2k, one step)): the prefix is
 * gone, so the step no longer protects anything.
 *
 * Aggressive mode sizes the thresholds and step by the fold budget instead, drops the step
 * requirement for a cold prefix, and lets expiry fold below the usage threshold.
 *
 * What masks: stale tool_result and thinking blocks outside the protected tail — never user
 * intent, assistant conclusions, or tool_call records (the actions carry the implicit decisions).
 * Each masked block folds to its deterministic per-kind digest — a `{#code FOLDED}` pointer that
 * keeps risk/error lines verbatim and stays reversible via recall/unfold. Stateless across turns
 * (a pure function of the view), so resume needs no ladder state.
 */
import type { FoldCommand, FoldPolicy, PolicyHost, PolicyView, ViewBlock } from "../contract";
import { isDurableId } from "../block";

export type FoldMode = "standard" | "aggressive";

export interface LadderConfig {
	/** First fold when usage ≥ this fraction of the window (or the budget in aggressive mode). */
	foldAt: number;
	/** A warm fold event must save at least this fraction of the window (or the budget in aggressive mode). */
	foldStep: number;
	/** First-fold threshold when the session has never observed a live cache read. */
	coldFoldAt: number;
	/** Standard sizes by the context window; aggressive sizes by the fold budget and folds earlier when expired. */
	mode: FoldMode;
}

export const LADDER_DEFAULTS: LadderConfig = { foldAt: 0.45, foldStep: 0.12, coldFoldAt: 0.25, mode: "standard" };

/** The kinds a fold event masks: observations and ephemeral reasoning. */
const MASKABLE_KINDS = new Set<ViewBlock["kind"]>(["tool_result", "thinking"]);

export class FoldLadderPolicy implements FoldPolicy {
	readonly id: string = "fold-ladder";
	readonly label: string = "Discrete fold ladder";

	private host: PolicyHost | null = null;
	/** No live cache read observed yet (adapter feeds this from measured telemetry each turn). */
	private cold = false;
	/** The provider prompt cache has elapsed; fold eligible blocks now (adapter feeds this per request). */
	private expired = false;
	/** The transport holds the conversation itself, so a fold rewrites a copy the model never receives
	 *  (adapter feeds this from measured usage, like `cold`). The ladder pauses while it holds. */
	private providerHoldsContext = false;

	constructor(private cfg: LadderConfig = LADDER_DEFAULTS) {}

	/** Live-apply seam (settings menu): new thresholds steer future fold decisions only. */
	setConfig(cfg: LadderConfig): void {
		this.cfg = cfg;
	}

	attach(host: PolicyHost): void {
		this.host = host;
	}

	setCold(cold: boolean): void {
		this.cold = cold;
	}

	setExpired(expired: boolean): void {
		this.expired = expired;
	}

	setProviderHoldsContext(held: boolean): void {
		this.providerHoldsContext = held;
	}

	conduct(view: PolicyView): FoldCommand[] {
		const mode = this.cfg.mode;
		const window = view.contextWindow ?? 0;
		const unit = mode === "aggressive" ? view.budget : window;
		// Provider-anchored usage when Pi has it; the chars÷4 estimator otherwise.
		const used = view.reportedTokens ?? view.liveTokens;
		const fraction = unit > 0 ? used / unit : 0;
		const foldAt = this.cold ? Math.min(this.cfg.coldFoldAt, this.cfg.foldAt) : this.cfg.foldAt;

		const eligible = view.blocks.filter(maskable);
		let savings = 0;
		for (const b of eligible) savings += b.tokens - b.foldedTokens;

		const stepTokens = unit > 0 ? Math.floor(this.cfg.foldStep * unit) : Math.floor(this.cfg.foldStep * view.budget);
		// A warm fold must buy a full step: it invalidates the cached suffix. The floor shrinks
		// with the step on tiny windows instead of swallowing it.
		const minFoldTokens = Math.max(1, Math.min(2_000, stepTokens));
		const overCap =
			view.liveTokens > view.budget ||
			(view.reportedTokens !== undefined && view.reportedBudget !== undefined && view.reportedTokens > view.reportedBudget);
		const coldStep = mode === "aggressive" ? minFoldTokens : stepTokens;
		const thresholdHit = unit > 0 && fraction >= foldAt && savings >= (this.cold ? coldStep : stepTokens);
		const expiryHit =
			this.expired &&
			unit > 0 &&
			savings >= minFoldTokens &&
			(mode === "aggressive" || fraction >= foldAt);

		if (this.providerHoldsContext) {
			// Nothing this policy masks can reach the model, so even the cap branch stays quiet.
			this.host?.setStatus("folding paused: the transport holds the conversation, so a fold never reaches the model", {
				fold_event: false,
				provider_holds_context: true,
				usage_fraction: round3(fraction),
				fold_at: round3(foldAt),
				maskable_tokens: savings,
				step_tokens: stepTokens,
				live_tokens: view.liveTokens,
				over_budget: false,
				irreducible_floor: irreducibleFloor(view.blocks),
			});
			return [];
		}
		if (!overCap && !thresholdHit && !expiryHit) {
			this.publishIdle(view, fraction, foldAt, savings, stepTokens);
			return [];
		}
		if (eligible.length === 0 || savings <= 0) {
			// Over cap with nothing left to mask: announce honestly (the tail/roots are the floor).
			this.publishIrreducible(view, overCap, fraction, foldAt, stepTokens);
			return [];
		}

		let trigger: "cap" | "threshold" | "expiry";
		// A fold past both the threshold and the cap is recorded as a threshold fold, as it always was.
		if (thresholdHit) {
			trigger = "threshold";
		} else if (overCap) {
			trigger = "cap";
		} else {
			trigger = "expiry";
		}
		// Every trigger folds the whole eligible set; the step/target only decides whether to fire.
		const projected = view.liveTokens - savings;
		this.host?.setStatus(
			`fold event (${trigger}): masking ${eligible.length} block${eligible.length === 1 ? "" : "s"}, ~${k(savings)} tok`,
			{
				fold_event: true,
				trigger,
				tokens_saved: savings,
				live_tokens: projected,
				usage_fraction: round3(fraction),
				fold_at: round3(foldAt),
				// Post-fold position: every eligible block is in this command, so nothing maskable
				// remains until new observations land. Published so the trigger gauge stays renderable
				// on the turn a fold fires without special-casing this branch.
				maskable_tokens: 0,
				step_tokens: stepTokens,
				irreducible_floor: irreducibleFloor(view.blocks),
				over_budget: projected > view.budget,
			},
		);
		return [{ kind: "fold", ids: eligible.map((b) => b.id) }];
	}

	private publishIdle(view: PolicyView, fraction: number, foldAt: number, savings: number, stepTokens: number): void {
		// Between events the ladder is quiet; publish the position so the status command can show
		// "next fold at N %" without the engine re-deriving policy internals.
		this.host?.setStatus(null, {
			fold_event: false,
			usage_fraction: round3(fraction),
			fold_at: round3(foldAt),
			maskable_tokens: savings,
			step_tokens: stepTokens,
			live_tokens: view.liveTokens,
			over_budget: false,
			irreducible_floor: irreducibleFloor(view.blocks),
		});
	}

	private publishIrreducible(view: PolicyView, overCap: boolean, fraction: number, foldAt: number, stepTokens: number): void {
		this.host?.setStatus(
			overCap ? "OVER BUDGET: nothing left to mask (tail/roots are the floor)" : null,
			{
				fold_event: false,
				usage_fraction: round3(fraction),
				fold_at: round3(foldAt),
				maskable_tokens: 0,
				step_tokens: stepTokens,
				live_tokens: view.liveTokens,
				over_budget: overCap,
				irreducible_floor: irreducibleFloor(view.blocks),
			},
		);
	}
}

function maskable(b: ViewBlock): boolean {
	return (
		MASKABLE_KINDS.has(b.kind) &&
		isDurableId(b.id) &&
		!b.protected &&
		!b.held &&
		!b.frozen &&
		b.foldedTokens < b.tokens
	);
}

/** Full-token sum of everything the ladder never masks (user + protected tail + held). */
function irreducibleFloor(blocks: ViewBlock[]): number {
	let n = 0;
	for (const b of blocks) if (b.kind === "user" || b.protected || b.held) n += b.tokens;
	return n;
}

function k(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}
