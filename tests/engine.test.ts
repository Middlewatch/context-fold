/*
 * engine.test.ts — the full per-turn pipeline through the Pi adapter's headless engine:
 * fold-under-budget, provider-safety on the real output, and the recall/unfold roundtrip.
 */
import { describe, it, expect } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import type { AgentMessage } from "../src/core/block";
import { user, assistantWithCalls, toolResult, bigResult, isBalanced, liveTokensOf } from "./helpers";

/** Build an over-budget session: N turns, each a user ask + assistant call + a big tool result. */
function bigSession(n: number): AgentMessage[] {
	const out: AgentMessage[] = [user("start the project")];
	for (let i = 0; i < n; i++) {
		out.push(user(`step ${i}: read a file`));
		out.push(assistantWithCalls([{ id: `c${i}`, name: "read" }], { text: `reading file ${i}`, thinking: `I should read file ${i} now` }));
		out.push(bigResult(`c${i}`, 80));
	}
	out.push(user("now summarize"));
	return out;
}

const CW = 8_000; // small context window so the session blows the budget
const CONFIG = { budgetFraction: 0.75, tailTarget: 800, defaultContextWindow: CW };
const CAP = Math.floor(CW * CONFIG.budgetFraction);

describe("fold under budget", () => {
	it("folds cold blocks to digests and drives liveTokens to ≤ cap", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const messages = bigSession(12);
		const before = liveTokensOf(messages);
		expect(before).toBeGreaterThan(CAP); // precondition: genuinely over budget

		const out = engine.process(messages, CW);
		const after = liveTokensOf(out);

		expect(after).toBeLessThan(before); // it actually compressed
		expect(after).toBeLessThanOrEqual(CAP); // the budget guarantee (irreducible floor < cap here)
		expect(JSON.stringify(out)).toContain("FOLDED"); // reversible handles emitted
	});

	it("keeps every tool pair balanced in the output (no orphans reach the provider)", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const out = engine.process(bigSession(12), CW);
		expect(isBalanced(out)).toBe(true);
	});

	it("passes through unchanged when under budget", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const small: AgentMessage[] = [user("hi"), assistantWithCalls([{ id: "c0", name: "read" }], { text: "ok" }), toolResult("c0", "short")];
		const out = engine.process(small, CW);
		expect(out).toBe(small); // identity — nothing folded
	});

	it("folds when Pi reports pressure even if the local estimator says under budget", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const messages = bigSession(5);
		expect(liveTokensOf(messages)).toBeLessThan(CAP);

		// The provider-anchored count, not the chars÷4 estimator, decides: 7,900 of the 8,000
		// window is 99 % usage, past the ladder's 45 % first-fold threshold.
		const out = engine.process(messages, { contextWindow: CW, tokens: 7_900 });

		expect(out).not.toBe(messages);
		expect(JSON.stringify(out)).toContain("FOLDED");
		expect(engine.status?.metrics?.fold_event).toBe(true);
		expect(engine.status?.metrics?.usage_fraction).toBeCloseTo(7_900 / CW, 2);
		// The fold consumes every eligible block, and the trigger gauge reads these fields on the
		// fold turn too: nothing maskable remains until new observations land.
		expect(engine.status?.metrics?.maskable_tokens).toBe(0);
		expect(engine.status?.metrics?.step_tokens).toBeGreaterThan(0);
	});

	it("keeps the fold applied once reported usage falls back under the threshold", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const messages = bigSession(5);
		const pressured = engine.process(messages, { contextWindow: CW, tokens: 7_900 });
		// The ladder is idle on the second turn, but the committed frozen layer still governs those
		// bytes — un-folding them would move the head and throw the warm prefix away for nothing.
		const settled = engine.process(messages, { contextWindow: CW, tokens: 5_000 });

		expect(JSON.stringify(settled)).toBe(JSON.stringify(pressured));
		expect(engine.status?.metrics?.fold_event).toBe(false);
	});

	it("falls back to estimator behavior when Pi has no token value", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const small: AgentMessage[] = [user("hi"), assistantWithCalls([{ id: "fallback", name: "read" }], { text: "ok" }), toolResult("fallback", "short")];
		const out = engine.process(small, { contextWindow: CW, tokens: null });
		expect(out).toBe(small);
	});

	it("never folds the protected working tail", () => {
		// Tail target large enough to comfortably include the newest big result (~1k tok) — so it
		// is genuinely inside the protected tail and must survive verbatim. (A tail smaller than a
		// single block correctly protects only the newest block — covered in core.test.ts.)
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { ...CONFIG, tailTarget: 2500 });
		const messages = bigSession(12);
		const out = engine.process(messages, CW);
		const lastResult = [...out].reverse().find((m) => m.role === "toolResult");
		expect(lastResult).toBeDefined();
		expect((lastResult!.content as any)[0].text).not.toContain("FOLDED");
	});
});

describe("recall — read the original back verbatim", () => {
	it("returns the exact original content of a folded block", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const messages = bigSession(12);
		const out = engine.process(messages, CW);

		// Find a folded tool result in the output and its fold code.
		const foldedTR = out.find((m) => m.role === "toolResult" && (m.content as any)[0].text.includes("FOLDED"));
		expect(foldedTR).toBeDefined();
		const codeMatch = /\{#([0-9a-z]{6}) FOLDED\}/.exec((foldedTR!.content as any)[0].text)!;
		const code = codeMatch[1];

		// The original block's content (re-derived from the un-folded session).
		const original = bigSession(12); // identical fixture (deterministic ids)
		const origTR = original.find((m) => m.role === "toolResult" && m.toolCallId === foldedTR!.toolCallId)!;
		const origText = (origTR.content as any)[0].text;

		const { matches, missing } = engine.resolveRecall([code]);
		expect(missing).toHaveLength(0);
		expect(matches).toHaveLength(1);
		expect(matches[0].text).toBe(origText); // verbatim
	});
});

describe("unfold — sticky re-expansion next turn", () => {
	it("a block the agent unfolds is no longer folded on the next pass", () => {
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), CONFIG);
		const messages = bigSession(12);
		const out1 = engine.process(messages, CW);

		const foldedTR = out1.find((m) => m.role === "toolResult" && (m.content as any)[0].text.includes("FOLDED"))!;
		const callId = foldedTR.toolCallId!;
		const code = /\{#([0-9a-z]{6}) FOLDED\}/.exec((foldedTR.content as any)[0].text)![1];

		engine.markUnfold([code]);

		// Next turn: Pi passes the same real history; the unfolded block must come back full.
		const out2 = engine.process(messages, CW);
		const sameTR = out2.find((m) => m.role === "toolResult" && m.toolCallId === callId)!;
		expect((sameTR.content as any)[0].text).not.toContain("FOLDED"); // expanded
		expect(isBalanced(out2)).toBe(true);
	});
});
