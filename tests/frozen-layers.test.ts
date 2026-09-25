/*
 * frozen-layers.test.ts — the prefix-stability mechanism: a fold event's substitutions are
 * committed as a frozen layer whose bytes never change again, so the context head stays
 * byte-identical turn over turn (what keeps a provider's prompt cache warm). Covers commit,
 * re-emission, unfold masking, and the byte-exact persistence roundtrip.
 */
import { describe, expect, it } from "vitest";
import { ContextFoldEngine, type FrozenLayer } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapFoldRegistry } from "../src/core/fold-registry";
import { restoreFoldState, recordLayer, FOLD_CUSTOM_TYPE, type EntryLike } from "../src/adapters/pi/persistence";
import type { AgentMessage } from "../src/core/block";
import { foldCode } from "../src/core/digest";
import { user, assistantWithCalls, bigResult } from "./helpers";

function engine(cfg: Record<string, unknown> = {}) {
	const e = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100, ...cfg }, new MapFoldRegistry());
	const committed: FrozenLayer[] = [];
	e.onLayerCommit = (layer) => committed.push(layer);
	return { e, committed };
}

/** A session with `n` big tool results followed by a small tail exchange. */
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

describe("frozen layers", () => {
	it("ensureLayerSeqAtLeast floors the next layer's seq (compact-record continuity)", () => {
		// A det compaction appends an index record at max(seq)+1; the next fold event must start
		// past it or the JSONL's latest-per-seq rule shadows the compaction recovery map.
		const { e, committed } = engine();
		e.ensureLayerSeqAtLeast(5);
		const { messages } = session(3);
		e.process(messages, 16_000);
		expect(committed.length).toBe(1);
		expect(committed[0].seq).toBe(6);
	});

	it("commits a fold event as a layer and re-emits byte-identical substitutions", () => {
		const { e, committed } = engine();
		const { messages, callIds } = session(3);
		const cw = 16_000; // ~13.5k live against a 16k window → past the 45 % fold threshold

		const first = e.process(messages, cw);
		expect(committed.length).toBe(1);
		expect(committed[0].seq).toBe(1);
		expect(committed[0].entries.length).toBeGreaterThan(0);
		const frozenId = committed[0].entries[0].id;
		const frozenCall = frozenId.replace(/^r:/, "");
		const firstText = resultText(first, frozenCall);
		expect(firstText).toContain("FOLDED");

		const second = e.process(messages, cw);
		// No second layer for an unchanged view, and the frozen bytes are identical.
		expect(committed.length).toBe(1);
		expect(resultText(second, frozenCall)).toBe(firstText);
		// The event masks every stale observation, oldest included.
		expect(committed[0].entries.map((x) => x.id)).toContain(`r:${callIds[0]}`);
	});

	it("invalidates cached digests for equal-length content changes before folding", () => {
		const { e } = engine();
		const { messages } = session(3);
		e.process(messages, 10_000_000);
		const result = messages.find(m => m.role === "toolResult")!;
		const content = result.content as { text: string }[];
		content[0].text = content[0].text.replace("line 0:", "Error!:");
		expect(resultText(e.process(messages, 16_000), "c0")).toContain("Error!:");
	});

	it("keeps frozen substitutions applied when pressure drops", () => {
		const { e, committed } = engine();
		const { messages } = session(3);
		e.process(messages, 16_000);
		expect(committed.length).toBe(1);
		const frozenCall = committed[0].entries[0].id.replace(/^r:/, "");

		// Same session, huge window: the ladder is idle but the frozen head must stay folded —
		// un-folding it would move bytes and cost the warm prefix for nothing.
		const relaxed = e.process(messages, 10_000_000);
		expect(resultText(relaxed, frozenCall)).toContain("FOLDED");
	});

	it("an unfold masks a frozen id and renders it raw (deliberate prefix break)", () => {
		const { e, committed } = engine();
		const { messages } = session(3);
		e.process(messages, 16_000);
		const frozenId = committed[0].entries[0].id;
		const frozenCall = frozenId.replace(/^r:/, "");

		const res = e.markUnfold([foldCode(frozenId)]);
		expect(res.missing).toEqual([]);
		const after = e.process(messages, 10_000_000);
		expect(resultText(after, frozenCall)).toContain("line 0:"); // raw content back
	});

	it("reports over-budget honestly rather than disturbing frozen bytes", () => {
		const { e, committed } = engine();
		const base = session(6, 400);
		e.process(base.messages, 20_000); // fold event → freeze a layer
		expect(committed.length).toBe(1);
		const layer1 = committed[0];

		// Shrink the window until the frozen digests plus the protected tail exceed the cap. There
		// is nothing left to mask (everything foldable is already frozen), so the honest answer is
		// to say so — not to un-freeze and re-fold, which would re-prefill the cache to reproduce
		// byte-identical digests.
		const out = e.process(base.messages, 700);
		expect(committed.length).toBe(1); // no second commit, and nothing re-frozen
		for (const entry of layer1.entries) {
			expect(resultText(out, entry.id.replace(/^r:/, ""))).toBe(entry.digestText);
		}
		expect(e.status?.text).toContain("OVER BUDGET");
		expect(e.status?.metrics?.over_budget).toBe(true);
	});

	it("frozen bytes are byte-stable across turns even as the window shrinks", () => {
		const { e, committed } = engine();
		const grown = session(6, 400);
		e.process(grown.messages, 20_000);
		const layer1 = committed[0];
		// Squeeze the window: a committed layer's bytes are fixed for the session, so every frozen
		// block must still render exactly the digest that was committed.
		const out = e.process(grown.messages, 6_000);
		for (const entry of layer1.entries) {
			expect(resultText(out, entry.id.replace(/^r:/, ""))).toBe(entry.digestText);
		}
	});
});

describe("persistence roundtrip", () => {
	it("layers survive record → restore byte-exactly", () => {
		const entries: EntryLike[] = [];
		const appender = { appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }) };

		const { e, committed } = engine();
		const { messages } = session(3);
		const before = e.process(messages, 16_000);
		for (const layer of committed) recordLayer(appender, layer);
		const frozenCall = committed[0].entries[0].id.replace(/^r:/, "");
		const frozenText = resultText(before, frozenCall);

		// Fresh engine (resume): restore from the recorded entries only.
		const fresh = engine();
		const restored = restoreFoldState(entries);
		expect(restored.layers.length).toBe(1);
		fresh.e.restoreLayers(restored.layers);
		const after = fresh.e.process(messages, 10_000_000);
		expect(resultText(after, frozenCall)).toBe(frozenText);

		expect(entries.every((x) => x.customType === FOLD_CUSTOM_TYPE)).toBe(true);
	});
});
