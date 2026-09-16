/*
 * fold-ladder.test.ts — the discrete fold ladder, the shipped folding policy:
 * threshold crossing, step spacing, cold branch, cap emergency, byte-stable layers,
 * and fold-event reporting.
 */
import { describe, expect, it } from "vitest";
import { ContextFoldEngine, type FoldEventReport, type FrozenLayer } from "../src/adapters/pi/store";
import { FoldLadderPolicy, LADDER_DEFAULTS } from "../src/core/policy/fold-ladder";
import { MapFoldRegistry } from "../src/core/fold-registry";
import type { AgentMessage } from "../src/core/block";
import type { FoldPolicy } from "../src/core/contract";
import { user, assistantText, assistantWithCalls, bigResult, toolResult, isBalanced } from "./helpers";

function ladderEngine(cfg: Record<string, unknown> = {}, ladderCfg = LADDER_DEFAULTS) {
	const policy = new FoldLadderPolicy(ladderCfg);
	const e = new ContextFoldEngine(policy, { tailTarget: 100, ...cfg }, new MapFoldRegistry());
	const committed: FrozenLayer[] = [];
	const events: FoldEventReport[] = [];
	e.onLayerCommit = (layer) => committed.push(layer);
	e.onFoldEvent = (ev) => events.push(ev);
	return { e, policy, committed, events };
}

function session(n: number, linesEach = 400): { messages: AgentMessage[]; callIds: string[] } {
	const messages: AgentMessage[] = [user("build the thing")];
	const callIds: string[] = [];
	for (let i = 0; i < n; i++) {
		const id = `c${i}`;
		callIds.push(id);
		messages.push(assistantWithCalls([{ id, name: "read" }]));
		messages.push(bigResult(id, linesEach));
	}
	messages.push(user("now the newest question"));
	return { messages, callIds };
}

function resultText(messages: AgentMessage[], callId: string): string {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const tr = m as { toolCallId?: string; content?: { type: string; text?: string }[] };
		if (tr.toolCallId === callId) return tr.content?.[0]?.text ?? "";
	}
	throw new Error(`no toolResult for ${callId}`);
}

/** The parts of one assistant message as `{type, text}`, so each kind can be asserted separately. */
function assistantParts(messages: AgentMessage[], responseId: string): { type: string; text: string }[] {
	for (const m of messages) {
		const a = m as { role?: string; responseId?: string; content?: unknown };
		if (a.role !== "assistant" || a.responseId !== responseId) continue;
		return (a.content as { type: string; text?: string; thinking?: string; name?: string }[]).map((p) => ({
			type: p.type,
			text: p.type === "thinking" ? (p.thinking ?? "") : p.type === "text" ? (p.text ?? "") : (p.name ?? ""),
		}));
	}
	throw new Error(`no assistant message ${responseId}`);
}

describe("discrete fold events", () => {
	it("below the first-fold threshold the context goes out untouched (append-only between events)", () => {
		const { e, committed } = ladderEngine();
		const { messages } = session(3); // ~15k live
		const out = e.process(messages, { contextWindow: 80_000, tokens: null }); // ~0.19 of window
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
	});

	it("setConfig lowers the threshold live: the same view that stayed raw now folds", () => {
		const { e, policy, committed } = ladderEngine();
		const { messages } = session(3); // ~15k live → ~0.19 of an 80k window
		expect(e.process(messages, { contextWindow: 80_000, tokens: null })).toBe(messages);
		expect(committed.length).toBe(0);

		policy.setConfig({ ...LADDER_DEFAULTS, foldAt: 0.1, coldFoldAt: 0.1 });
		e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(committed.length).toBe(1);
	});

	it("crossing the threshold fires ONE fold event: observations mask, intent and actions stay", () => {
		const { e, committed, events } = ladderEngine();
		const { messages, callIds } = session(8); // ~39k live
		const out = e.process(messages, { contextWindow: 80_000, tokens: null }); // ~0.49 ≥ 0.45

		expect(committed.length).toBe(1);
		expect(events.length).toBe(1);
		expect(events[0].trigger).toBe("threshold");
		expect(events[0].maskedIds.length).toBeGreaterThan(0);
		expect(isBalanced(out)).toBe(true);

		// Oldest observation masked to a reversible pointer digest…
		expect(resultText(out, callIds[0])).toContain("FOLDED");
		// …while user intent survives verbatim.
		const users = out.filter((m) => (m as { role?: string }).role === "user");
		expect(users.length).toBe(2);
	});

	it("masks thinking, but never an assistant conclusion or the record of an action", () => {
		const { e, committed } = ladderEngine();
		// The oldest exchange carries all three kinds, so one fold event decides all three at once.
		const messages: AgentMessage[] = [user("build the thing")];
		messages.push(
			assistantWithCalls([{ id: "c0", name: "read" }], {
				responseId: "rA",
				thinking: "weighing options: " + "consider the parser path ".repeat(1200), // ephemeral
				text: "Conclusion: the parser is the bottleneck.", // a durable conclusion
			}),
		);
		messages.push(bigResult("c0", 400));
		for (let i = 1; i < 8; i++) {
			messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
			messages.push(bigResult(`c${i}`, 400));
		}
		messages.push(user("now the newest question"));

		const out = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(committed.length).toBe(1);

		const parts = assistantParts(out, "rA");
		const thinking = parts.find((p) => p.type === "thinking");
		const text = parts.find((p) => p.type === "text");
		const call = parts.find((p) => p.type === "toolCall");

		// Ephemeral reasoning masks to a reversible pointer keeping only a tag, a token count and a
		// short gist — the bulk is gone, but enough remains to know what was there.
		expect(thinking?.text).toContain("FOLDED");
		expect(thinking?.text).toContain("thought · ~");
		expect(thinking!.text.length).toBeLessThan(200);
		// …while the conclusion and the action record survive byte-for-byte.
		expect(text?.text).toBe("Conclusion: the parser is the bottleneck.");
		expect(call?.text).toBe("read");
	});

	it("a fresh fold cannot re-fire next turn: frozen bytes hold and no second layer commits", () => {
		const { e, committed } = ladderEngine();
		const { messages, callIds } = session(8);
		const first = e.process(messages, { contextWindow: 80_000, tokens: null });
		const firstText = resultText(first, callIds[0]);
		const second = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(committed.length).toBe(1);
		expect(resultText(second, callIds[0])).toBe(firstText);
	});

	it("step spacing: over the threshold but with too little maskable mass, no event fires", () => {
		const { e, committed } = ladderEngine();
		// A huge (unmaskable) user brief + one small observation: fraction ≥ 0.45, savings ≪ step.
		const messages: AgentMessage[] = [
			user("brief: " + "requirements ".repeat(12_000)), // ~39k tokens of user intent
			assistantWithCalls([{ id: "c0", name: "read" }]),
			bigResult("c0", 150), // ~2k — under the 0.12 × 80k step
			user("go"),
		];
		const out = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
	});

	it("provider-held context: the ladder pauses even over the cap, and resumes when the flag clears", () => {
		const { e, policy, committed } = ladderEngine({ absoluteTokenCap: 10_000 });
		const { messages } = session(6); // ~29k live, far past a 10k cap
		policy.setProviderHoldsContext(true);
		const out = e.process(messages, { contextWindow: 100_000, tokens: 90_000 });
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
		expect(e.status?.metrics?.provider_holds_context).toBe(true);
		expect(e.status?.metrics?.over_budget).toBe(false);
		expect(e.status?.text).toContain("folding paused");

		policy.setProviderHoldsContext(false);
		e.process(messages, { contextWindow: 100_000, tokens: 90_000 });
		expect(committed.length).toBe(1);
	});

	it("cold branch: with no live cache read there is no prefix to protect — folds from 25 %", () => {
		const { e, policy, committed } = ladderEngine();
		const { messages } = session(6); // ~29k live → 0.29 of 100k
		policy.setCold(true);
		e.process(messages, { contextWindow: 100_000, tokens: null });
		expect(committed.length).toBe(1);

		// Same session, warm: 0.29 < 0.45 → no event.
		const warm = ladderEngine();
		warm.policy.setCold(false);
		warm.e.process(session(6).messages, { contextWindow: 100_000, tokens: null });
		expect(warm.committed.length).toBe(0);
	});

	it("crossing the budget cap is an emergency event regardless of the ladder position", () => {
		const { e, committed, events } = ladderEngine({ absoluteTokenCap: 10_000 });
		const { messages } = session(3); // ~15k live > 10k cap; 0.075 of a 200k window
		e.process(messages, { contextWindow: 200_000, tokens: null });
		expect(committed.length).toBe(1);
		expect(events[0].trigger).toBe("cap");
	});

	it("never masks a tool result before its first provider delivery", () => {
		const { e, committed } = ladderEngine({ absoluteTokenCap: 1_000, tailTarget: 0 });
		const messages: AgentMessage[] = [user("read it"), assistantWithCalls([{ id: "fresh", name: "read" }]), bigResult("fresh", 500)];

		const first = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(first, "fresh")).not.toContain("FOLDED");
		expect(committed).toHaveLength(0);

		messages.push(assistantText("finished reading", "after-fresh"), user("continue"));
		const second = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(second, "fresh")).toContain("FOLDED");
		expect(committed).toHaveLength(1);
	});

	it("protects every parallel result on their shared first delivery", () => {
		const { e, committed } = ladderEngine({ absoluteTokenCap: 1_000, tailTarget: 0 });
		const messages: AgentMessage[] = [
			user("read both"),
			assistantWithCalls([{ id: "p1", name: "read" }, { id: "p2", name: "read" }]),
			bigResult("p1", 300),
			bigResult("p2", 300),
		];

		const first = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(first, "p1")).not.toContain("FOLDED");
		expect(resultText(first, "p2")).not.toContain("FOLDED");
		expect(committed).toHaveLength(0);

		messages.push(assistantText("finished reading", "after-parallel"), user("continue"));
		const second = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(second, "p1")).toContain("FOLDED");
		expect(resultText(second, "p2")).toContain("FOLDED");
	});

	it("engine lowering rejects a fresh result even when a defective policy requests it", () => {
		const hostile: FoldPolicy = {
			id: "hostile",
			label: "hostile",
			conduct: (view) => [{ kind: "fold", ids: view.blocks.filter((block) => block.kind === "tool_result").map((block) => block.id) }],
		};
		const engine = new ContextFoldEngine(hostile, { tailTarget: 0 }, new MapFoldRegistry());
		const messages: AgentMessage[] = [user("read it"), assistantWithCalls([{ id: "fresh", name: "read" }]), bigResult("fresh", 300)];

		const out = engine.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(out, "fresh")).not.toContain("FOLDED");
	});

	it("keeps a fold raw when its durability callback rejects the commit", () => {
		const { e, committed } = ladderEngine({ absoluteTokenCap: 10_000 });
		const { messages, callIds } = session(3);
		e.onFoldEvent = () => false;

		const rejected = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(rejected, callIds[0])).not.toContain("FOLDED");
		expect(committed).toHaveLength(0);

		e.onFoldEvent = () => true;
		const accepted = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(accepted, callIds[0])).toContain("FOLDED");
		expect(committed[0].seq).toBe(1);
	});

	it("provider-reported usage drives the fraction when present", () => {
		const { e, committed } = ladderEngine();
		const { messages } = session(8); // estimator says ~0.49 of 80k
		// Provider says the context is actually tiny — trust it, no fold.
		const out = e.process(messages, { contextWindow: 80_000, tokens: 8_000 });
		expect(out).toBe(messages);
		expect(committed.length).toBe(0);
	});
});


describe("reversibility", () => {
	it("recall and unfold still resolve a ladder-masked block", () => {
		const { e, committed } = ladderEngine();
		const { messages } = session(8);
		e.process(messages, { contextWindow: 80_000, tokens: null });
		const frozenId = committed[0].entries[0].id;
		const code = frozenId.replace(/^r:/, "");

		const { matches, missing } = e.resolveRecall([codeOf(frozenId)]);
		expect(missing).toEqual([]);
		expect(matches[0].text).toContain("line 0:");

		e.markUnfold([codeOf(frozenId)]);
		const after = e.process(messages, { contextWindow: 80_000, tokens: null });
		expect(resultText(after, code)).toContain("line 0:");
	});
});

// local: avoid importing digest just for the code helper
import { foldCode } from "../src/core/digest";
function codeOf(id: string): string {
	return foldCode(id);
}
