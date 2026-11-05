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
 *   • usage ≥ the first-fold threshold (~45 % of the fold budget; the cold branch lowers it —
 *     with no live cache read there is no prefix to protect, so fold earlier and more freely), and
 *   • the maskable mass is worth a fold (≥ step × budget) — this is what spaces warm events: each
 *     fold must buy at least one ladder step, so a fresh fold can't re-fire on the next turn.
 * The budget is min(200k, fraction × window), so the thresholds do not grow with a 1M window.
 * Crossing the budget cap is an emergency event with no minimum. A cold or expired prefix folds
 * every eligible block (floor min(2k, one step)): the prefix is gone, so there is no suffix left
 * to protect.
 *
 * What masks: stale tool_result and thinking blocks outside the protected tail — never user
 * intent, assistant conclusions, or tool_call records (the actions carry the implicit decisions).
 * Each masked block folds to its deterministic per-kind digest — a `{#code FOLDED}` pointer that
 * keeps risk/error lines verbatim and stays reversible via recall/unfold. Stateless across turns
 * (a pure function of the view), so resume needs no ladder state.
 */
import type { FoldCommand, FoldPolicy, PolicyHost, PolicyView, ViewBlock } from "../contract";
import { isDurableId } from "../block";

export interface LadderConfig {
	/** First fold when usage ≥ this fraction of the fold budget. */
	foldAt: number;
	/** A warm fold event must save at least this fraction of the budget (spaces the events). */
	foldStep: number;
	/** First-fold threshold when the session has never observed a live cache read. */
	coldFoldAt: number;
}

export const LADDER_DEFAULTS: LadderConfig = { foldAt: 0.45, foldStep: 0.12, coldFoldAt: 0.25 };

/** The kinds a fold event masks: observations and ephemeral reasoning. */
const MASKABLE_KINDS = new Set<ViewBlock["kind"]>(["tool_result", "thinking"]);

export class FoldLadderPolicy implements FoldPolicy {
	readonly id: string = "fold-ladder";
	readonly label: string = "Discrete fold ladder";

	private host: PolicyHost | null = null;
	/** No live cache read observed yet (adapter feeds this from measured telemetry each turn). */
	private cold = false;
	/** The provider prompt cache has elapsed; fold one step now (adapter feeds this per request). */
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
		// The fold budget is the model-independent unit: min(200k, 0.75 × window), so a 1M window
		// does not get a 1M-relative threshold or step.
		const budget = view.budget;
		// Provider-anchored usage when Pi has it; the chars÷4 estimator otherwise.
		const used = view.reportedTokens ?? view.liveTokens;
		const fraction = budget > 0 ? used / budget : 0;
		const foldAt = this.cold ? Math.min(this.cfg.coldFoldAt, this.cfg.foldAt) : this.cfg.foldAt;

		const eligible = view.blocks.filter(maskable);
		let savings = 0;
		for (const b of eligible) savings += b.tokens - b.foldedTokens;

		const stepTokens = budget > 0 ? Math.floor(this.cfg.foldStep * budget) : 0;
		// A warm fold must buy a full step: it invalidates the cached suffix. A cold or expired
		// prefix is already gone, so fold whatever is eligible rather than waiting for the step.
		// The floor shrinks with the step on tiny budgets instead of swallowing it.
		const minFoldTokens = Math.max(1, Math.min(2_000, stepTokens));
		const overCap =
			view.liveTokens > view.budget ||
			(view.reportedTokens !== undefined && view.reportedBudget !== undefined && view.reportedTokens > view.reportedBudget);
		const thresholdHit = budget > 0 && fraction >= foldAt && savings >= (this.cold ? minFoldTokens : stepTokens);
		const expiryHit = this.expired && budget > 0 && savings >= minFoldTokens;

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
		if (overCap) {
			trigger = "cap";
		} else if (thresholdHit) {
			trigger = "threshold";
		} else {
			trigger = "expiry";
		}
		// Every trigger folds the whole eligible set; the step/target only decides whether to fire.
		const selected = eligible;
		const selectedSavings = savings;

		const projected = view.liveTokens - selectedSavings;
		this.host?.setStatus(
			`fold event (${trigger}): masking ${selected.length} block${selected.length === 1 ? "" : "s"}, ~${k(selectedSavings)} tok`,
			{
				fold_event: true,
				trigger,
				tokens_saved: selectedSavings,
				live_tokens: projected,
				usage_fraction: round3(fraction),
				fold_at: round3(foldAt),
				maskable_tokens: savings - selectedSavings,
				step_tokens: stepTokens,
				irreducible_floor: irreducibleFloor(view.blocks),
				over_budget: projected > view.budget,
			},
		);
		return [{ kind: "fold", ids: selected.map((b) => b.id) }];
	}

	private publishIdle(view: PolicyView, fraction: number, foldAt: number, savings: number, stepTokens: number): void {
		// Between events the ladder is quiet; publish the position so the status command can show
		// "next fold at N %" (of the budget) without the engine re-deriving policy internals.
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
