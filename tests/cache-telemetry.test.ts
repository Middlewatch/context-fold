/*
 * cache-telemetry.test.ts — the pure cache accounting: ratios, ring bound, reset, dirty input.
 */
import { describe, expect, it } from "vitest";
import { CacheTelemetry } from "../src/adapters/pi/cache-telemetry";

describe("CacheTelemetry", () => {
	it("computes per-turn and aggregate hit ratios", () => {
		const t = new CacheTelemetry();
		t.record({ input: 1000, cacheRead: 0, cacheWrite: 1000 });
		t.record({ input: 100, cacheRead: 900, cacheWrite: 100 });
		const s = t.snapshot();
		expect(s.turns).toBe(2);
		expect(s.lastHitRatio).toBeCloseTo(0.9);
		// Aggregate: 900 / (900 + 1100)
		expect(s.hitRatio).toBeCloseTo(0.45);
		expect(s.totals.cacheWrite).toBe(1100);
	});

	it("returns null ratios before any input-side tokens exist", () => {
		const t = new CacheTelemetry();
		expect(t.snapshot().hitRatio).toBeNull();
		expect(t.snapshot().lastHitRatio).toBeNull();
		t.record({ input: 0, cacheRead: 0, cacheWrite: 0 });
		expect(t.snapshot().lastHitRatio).toBeNull();
		expect(t.snapshot().hitRatio).toBeNull();
	});

	it("treats missing/garbage usage fields as zero", () => {
		const t = new CacheTelemetry();
		t.record({ input: Number.NaN, cacheRead: -5 } as never);
		t.record(null);
		const s = t.snapshot();
		expect(s.turns).toBe(2);
		expect(s.totals.input).toBe(0);
		expect(s.totals.cacheRead).toBe(0);
	});

	it("keeps only the last turn while totals keep accumulating", () => {
		const t = new CacheTelemetry();
		for (let i = 0; i < 75; i++) t.record({ input: 1, cacheRead: i, cacheWrite: 0 });
		const s = t.snapshot();
		expect(s.last).toEqual({ input: 1, cacheRead: 74, cacheWrite: 0 });
		expect(s.turns).toBe(75);
		expect(s.totals.input).toBe(75);
	});

	it("reset clears everything", () => {
		const t = new CacheTelemetry();
		t.record({ input: 10, cacheRead: 5, cacheWrite: 2 });
		t.reset();
		const s = t.snapshot();
		expect(s.turns).toBe(0);
		expect(s.last).toBeNull();
		expect(s.totals.cacheRead).toBe(0);
	});

	it("statusLine reads sanely", () => {
		const t = new CacheTelemetry();
		expect(t.statusLine()).toBe("cache: no usage yet");
		t.record({ input: 100, cacheRead: 12_300, cacheWrite: 600 });
		expect(t.statusLine()).toBe("cache read 12.3k/wr 600 (hit 99%, last 99%)");
	});

	// A fold rewrites the prefix, so the provider re-prefills from the earliest masked block
	// forward on the very next request. That cost is the extension's own, and it gets attributed
	// to exactly one turn — the first one carrying the new bytes.
	it("attributes the post-fold turn's cacheWrite to the fold, and only that turn", () => {
		const t = new CacheTelemetry();
		t.record({ input: 200, cacheRead: 40_000, cacheWrite: 300 });
		expect(t.snapshot().foldEvents).toBe(0);
		expect(t.snapshot().foldNetTokens).toBeNull();

		t.noteFoldEvent(9_000);
		// The re-prefill turn: read collapses to the surviving head, write covers the rest.
		t.record({ input: 100, cacheRead: 9_000, cacheWrite: 31_000 });
		expect(t.snapshot().lastTurnAfterFold).toBe(true);
		// Two ordinary turns after it must not add to the fold's cost.
		t.record({ input: 100, cacheRead: 40_000, cacheWrite: 400 });
		expect(t.snapshot().lastTurnAfterFold).toBe(false);
		t.record({ input: 100, cacheRead: 40_400, cacheWrite: 350 });

		const s = t.snapshot();
		expect(s.foldEvents).toBe(1);
		expect(s.foldSavedTokens).toBe(9_000);
		expect(s.foldReprefillTokens).toBe(31_000);
		// Savings accrue per turn since the fold (2), the re-prefill was paid once.
		expect(s.foldNetTokens).toBe(9_000 * 2 - 31_000);
	});

	it("accumulates across fold events and survives a fold with no measured savings", () => {
		const t = new CacheTelemetry();
		t.noteFoldEvent(5_000);
		t.record({ input: 0, cacheRead: 1_000, cacheWrite: 12_000 });
		t.noteFoldEvent(0);
		t.record({ input: 0, cacheRead: 1_000, cacheWrite: 8_000 });
		const s = t.snapshot();
		expect(s.foldEvents).toBe(2);
		expect(s.foldSavedTokens).toBe(5_000);
		expect(s.foldReprefillTokens).toBe(20_000);
	});

	it("foldCostLine is null until a fold happens, then reports both sides", () => {
		const t = new CacheTelemetry();
		expect(t.foldCostLine()).toBeNull();
		t.noteFoldEvent(9_000);
		t.record({ input: 100, cacheRead: 9_000, cacheWrite: 31_000 });
		expect(t.foldCostLine()).toBe("folds 1: masked 9.0k tok/turn, cost 31.0k re-prefilled · net -31.0k behind");
		t.record({ input: 100, cacheRead: 40_000, cacheWrite: 400 });
		t.record({ input: 100, cacheRead: 40_400, cacheWrite: 350 });
		t.record({ input: 100, cacheRead: 40_800, cacheWrite: 350 });
		t.record({ input: 100, cacheRead: 41_200, cacheWrite: 350 });
		// 4 turns × 9k masked = 36k against 31k paid once.
		expect(t.foldCostLine()).toBe("folds 1: masked 9.0k tok/turn, cost 31.0k re-prefilled · net +5.0k ahead");
	});

	// The Codex dialect reports cached_tokens only and Pi hardcodes Google's write to 0, so a
	// zero cost can mean "nothing was rewritten" or "this provider never says". Claiming a net win
	// against the second case is the dishonest accounting this feature exists to prevent.
	it("reports the cost as unavailable when the provider never reports a cache write", () => {
		const t = new CacheTelemetry();
		t.noteFoldEvent(15_500);
		t.record({ input: 0, cacheRead: 7_680, cacheWrite: 0 });
		t.record({ input: 0, cacheRead: 7_680, cacheWrite: 0 });
		const s = t.snapshot();
		expect(s.writeReported).toBe(false);
		expect(s.foldNetTokens).toBeNull();
		expect(t.foldCostLine()).toBe("folds 1: masked 15.5k tok/turn, re-prefill cost not reported by this provider");
	});

	it("reports a real zero cost once the provider has proven it reports writes", () => {
		const t = new CacheTelemetry();
		// A non-zero write anywhere in the session establishes that this dialect does report them.
		t.record({ input: 100, cacheRead: 0, cacheWrite: 20_000 });
		t.noteFoldEvent(9_000);
		t.record({ input: 100, cacheRead: 20_000, cacheWrite: 0 });
		t.record({ input: 100, cacheRead: 20_000, cacheWrite: 0 });
		const s = t.snapshot();
		expect(s.writeReported).toBe(true);
		expect(s.foldReprefillTokens).toBe(0);
		expect(s.foldNetTokens).toBe(9_000);
		expect(t.foldCostLine()).toBe("folds 1: masked 9.0k tok/turn, cost 0 re-prefilled · net +9.0k ahead");
	});

	// A second fold must not erase what the first one already banked: the ladder fires repeatedly
	// in a normal session, and net is accrued turn by turn, not recomputed from the latest fold.
	it("keeps savings accrued before a later fold in the net", () => {
		const t = new CacheTelemetry();
		t.noteFoldEvent(10_000);
		t.record({ input: 100, cacheRead: 5_000, cacheWrite: 20_000 });
		// Three ordinary turns bank 10k each.
		for (let i = 0; i < 3; i++) {
			t.record({ input: 100, cacheRead: 25_000, cacheWrite: 300 });
		}
		t.noteFoldEvent(2_000);
		t.record({ input: 100, cacheRead: 10_000, cacheWrite: 8_000 });
		// One turn after fold 2 banks the combined 12k rate.
		t.record({ input: 100, cacheRead: 18_000, cacheWrite: 300 });
		const s = t.snapshot();
		expect(s.foldReprefillTokens).toBe(28_000);
		// 3 × 10k before fold 2, plus 1 × 12k after it — the earlier accrual survives.
		expect(s.foldNetTokens).toBe(30_000 + 12_000 - 28_000);
	});

	it("reset clears fold accounting too", () => {
		const t = new CacheTelemetry();
		t.noteFoldEvent(1_000);
		t.record({ input: 0, cacheRead: 0, cacheWrite: 5_000 });
		t.reset();
		const s = t.snapshot();
		expect(s.foldEvents).toBe(0);
		expect(s.foldSavedTokens).toBe(0);
		expect(s.foldReprefillTokens).toBe(0);
		expect(s.lastTurnAfterFold).toBe(false);
		expect(s.foldNetTokens).toBeNull();
		expect(t.foldCostLine()).toBeNull();
	});
});

describe("wire watchdog", () => {
	it("flags a fold whose next turn read the whole pre-fold prompt from cache", () => {
		const t = new CacheTelemetry();
		// Turn N: prompt was 100k (90k cached + 10k fresh).
		t.record({ input: 10_000, cacheRead: 90_000, cacheWrite: 10_000 });
		t.noteFoldEvent(40_000);
		// Turn N+1 reads ≥ the full pre-fold prompt — impossible if the prefix changed on the wire.
		t.record({ input: 5_000, cacheRead: 100_000, cacheWrite: 5_000 });
		expect(t.snapshot().wireDeferredFolds).toBe(1);
	});

	it("a fold that landed (cache read drops below the fold point) is clean", () => {
		const t = new CacheTelemetry();
		t.record({ input: 10_000, cacheRead: 90_000, cacheWrite: 10_000 });
		t.noteFoldEvent(40_000);
		// Rewrite reached the wire: only the prefix before the earliest masked block is still cached.
		t.record({ input: 2_000, cacheRead: 55_000, cacheWrite: 7_000 });
		expect(t.snapshot().wireDeferredFolds).toBe(0);
	});

	it("never false-positives on a provider that reports no cache reads at all", () => {
		const t = new CacheTelemetry();
		t.record({ input: 100_000, cacheRead: 0, cacheWrite: 0 });
		t.noteFoldEvent(40_000);
		t.record({ input: 65_000, cacheRead: 0, cacheWrite: 0 });
		expect(t.snapshot().wireDeferredFolds).toBe(0);
	});

	it("judges only the first turn after the fold, and disarms after judging", () => {
		const t = new CacheTelemetry();
		t.record({ input: 10_000, cacheRead: 90_000, cacheWrite: 10_000 });
		t.noteFoldEvent(40_000);
		t.record({ input: 2_000, cacheRead: 55_000, cacheWrite: 7_000 });
		// Later warm turns re-reading the (new, folded) full prompt must not retro-flag the fold.
		t.record({ input: 1_000, cacheRead: 120_000, cacheWrite: 0 });
		expect(t.snapshot().wireDeferredFolds).toBe(0);
	});

	it("a first-turn fold (no prior usage to baseline against) never arms", () => {
		const t = new CacheTelemetry();
		t.noteFoldEvent(40_000);
		t.record({ input: 60_000, cacheRead: 0, cacheWrite: 60_000 });
		expect(t.snapshot().wireDeferredFolds).toBe(0);
	});

	it("reset clears the watchdog", () => {
		const t = new CacheTelemetry();
		t.record({ input: 10_000, cacheRead: 90_000, cacheWrite: 0 });
		t.noteFoldEvent(40_000);
		t.record({ input: 5_000, cacheRead: 100_000, cacheWrite: 0 });
		expect(t.snapshot().wireDeferredFolds).toBe(1);
		t.reset();
		expect(t.snapshot().wireDeferredFolds).toBe(0);
	});

	it("a response reporting no usage at all neither judges nor disarms (a bridged CLI's tool-pause messages)", () => {
		const t = new CacheTelemetry();
		t.record({ input: 0, cacheRead: 100_000, cacheWrite: 0 });
		t.noteFoldEvent(40_000);
		t.record({ input: 0, cacheRead: 0, cacheWrite: 0 });
		expect(t.snapshot().wireDeferredFolds).toBe(0);
		t.record({ input: 0, cacheRead: 130_000, cacheWrite: 0 });
		expect(t.snapshot().wireDeferredFolds).toBe(1);
	});

	it("arms against the last response that reported usage, not a usage-less one in between", () => {
		const t = new CacheTelemetry();
		t.record({ input: 0, cacheRead: 100_000, cacheWrite: 0 });
		t.record({ input: 0, cacheRead: 0, cacheWrite: 0 });
		t.noteFoldEvent(40_000);
		t.record({ input: 0, cacheRead: 120_000, cacheWrite: 0 });
		expect(t.snapshot().wireDeferredFolds).toBe(1);
	});
});

describe("provider-held context (a fold rewrites a copy the model never receives)", () => {
	it("two responses booking the whole prompt as cache read with nothing prefilled flag the transport", () => {
		const t = new CacheTelemetry();
		t.record({ input: 0, cacheRead: 50_000, cacheWrite: 0 });
		expect(t.snapshot().providerHoldsContext).toBe(false); // one response is not a pattern
		t.record({ input: 0, cacheRead: 62_000, cacheWrite: 0 });
		expect(t.snapshot().providerHoldsContext).toBe(true);
	});

	it("a stateless provider prefills at least the new message every turn, so any input or write clears it", () => {
		const t = new CacheTelemetry();
		t.record({ input: 10_000, cacheRead: 0, cacheWrite: 10_000 });
		t.record({ input: 2_000, cacheRead: 20_000, cacheWrite: 1_000 });
		expect(t.snapshot().providerHoldsContext).toBe(false);

		const late = new CacheTelemetry();
		late.record({ input: 0, cacheRead: 50_000, cacheWrite: 0 });
		late.record({ input: 0, cacheRead: 62_000, cacheWrite: 0 });
		late.record({ input: 3_000, cacheRead: 70_000, cacheWrite: 0 });
		expect(late.snapshot().providerHoldsContext).toBe(false);
	});

	it("usage-less responses and providers that report nothing never count", () => {
		const t = new CacheTelemetry();
		t.record({ input: 0, cacheRead: 0, cacheWrite: 0 });
		t.record({ input: 0, cacheRead: 0, cacheWrite: 0 });
		t.record({ input: 0, cacheRead: 50_000, cacheWrite: 0 });
		expect(t.snapshot().providerHoldsContext).toBe(false);
	});

	it("reset clears it", () => {
		const t = new CacheTelemetry();
		t.record({ input: 0, cacheRead: 50_000, cacheWrite: 0 });
		t.record({ input: 0, cacheRead: 62_000, cacheWrite: 0 });
		t.reset();
		expect(t.snapshot().providerHoldsContext).toBe(false);
	});
});
