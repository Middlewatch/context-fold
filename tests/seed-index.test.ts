/*
 * seed-index.test.ts — index-fidelity tests: identifiers planted MID tool-output (the
 * summary-boundary class that measurably gets dropped by LLM summarizers) must appear
 * verbatim in the emitted index, error lines must survive in every lexicon spelling, and
 * extraction must be deterministic.
 */
import { describe, expect, it } from "vitest";
import { linearize } from "../src/core/block";
import { extractIndex, extractCompactionIndex, buildIndexRecord } from "../src/core/index/seed-index";
import type { WireBlock } from "../src/core/block";
import { user, assistantWithCalls, toolResult } from "./helpers";

function blocksOf(messages: Parameters<typeof linearize>[0]): WireBlock[] {
	return linearize(messages) as unknown as WireBlock[];
}

/** A flood with load-bearing facts buried in the middle — nowhere near head or tail. */
function burying(lines: number, planted: string[]): string {
	const body = Array.from({ length: lines }, (_, i) => `line ${i}: ${"x".repeat(40)}`);
	planted.forEach((p, j) => {
		body[Math.floor(lines / 2) + j * 7] = p;
	});
	return body.join("\n");
}

function fixture() {
	const flood = burying(600, [
		"    capacity: CAP_X9_LIMIT=52418 (do not exceed)",
		"    request id 3f9a2c7e11d04b22 assigned",
		"    pinned toolchain 3.14.159-rc2",
	]);
	const errWall = [
		"test summary:",
		"  12 passed, 3 failed",
		"npm ERR! code ELIFECYCLE",
		"warning: something minor",
		"Segmentation fault (core dumped) in worker 4",
	].join("\n");
	const messages = [
		user("rebuild the fold ladder with discrete events"),
		assistantWithCalls([{ id: "c1", name: "bash", args: { cmd: "npx vitest run tests/ladder.test.ts" } }]),
		toolResult("c1", errWall, "bash"),
		user("now check the capacity table in the big dump"),
		assistantWithCalls([{ id: "c2", name: "read", args: { path: "src/adapters/pi/store.ts" } }]),
		toolResult("c2", flood, "read"),
	];
	const all = blocksOf(messages);
	const masked = all.filter((b) => b.kind === "tool_result");
	return { all, masked };
}

describe("seed-index extraction", () => {
	it("keeps identifiers planted mid-tool-output (summary-boundary probe class)", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.identifiers).toContain("CAP_X9_LIMIT");
		expect(idx.identifiers).toContain("52418");
		expect(idx.identifiers).toContain("3f9a2c7e11d04b22");
		expect(idx.identifiers).toContain("3.14.159-rc2");
	});

	it("carries whole error lines in every lexicon spelling (lowercase failed, npm ERR!, segfault)", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.errors).toContain("12 passed, 3 failed");
		expect(idx.errors).toContain("npm ERR! code ELIFECYCLE");
		expect(idx.errors).toContain("Segmentation fault (core dumped) in worker 4");
	});

	it("indexes shell commands from paired tool_calls and user first lines across the span", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.commands.some((c) => c.includes("npx vitest run tests/ladder.test.ts"))).toBe(true);
		expect(idx.userMessages.map((u) => u.firstLine)).toEqual([
			"rebuild the fold ladder with discrete events",
			"now check the capacity table in the big dump",
		]);
	});

	it("indexes path-shaped tokens as files", () => {
		const { all, masked } = fixture();
		const idx = extractIndex({ masked, all });
		expect(idx.files.some((f) => f.includes("tests/ladder.test.ts"))).toBe(true);
	});

	it("is deterministic: same input ⇒ byte-identical output", () => {
		const { all, masked } = fixture();
		const a = extractIndex({ masked, all });
		const b = extractIndex({ masked, all });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("caps every field and dedups", () => {
		const noisy = Array.from({ length: 400 }, (_, i) => `VAL_TOKEN_${i} = ${100000 + i}`).join("\n");
		const messages = [
			user("noise"),
			assistantWithCalls([{ id: "n1", name: "bash", args: { cmd: "true" } }]),
			toolResult("n1", noisy, "bash"),
		];
		const all = blocksOf(messages);
		const masked = all.filter((b) => b.kind === "tool_result");
		const idx = extractIndex({ masked, all });
		expect(idx.identifiers.length).toBeLessThanOrEqual(64);
		expect(new Set(idx.identifiers).size).toBe(idx.identifiers.length);
	});

	it("keeps recent turns when re-extracting a long compacted history", () => {
		const messages = [];
		for (let i = 0; i < 40; i++) messages.push(user(`request ${i}`), toolResult(`c${i}`, `Error: MARKER_${i}`));
		const result = extractCompactionIndex(linearize(messages));
		expect(result.errors).toHaveLength(24);
		expect(result.errors[0]).toBe("Error: MARKER_16");
		expect(result.errors.at(-1)).toBe("Error: MARKER_39");
		expect(extractCompactionIndex(linearize([user("preserve a recovered request")])).userMessages)
			.toEqual([{ turn: 1, firstLine: "preserve a recovered request" }]);
	});

	it("assembles a complete v2 record", () => {
		const { all, masked } = fixture();
		const rec = buildIndexRecord(
			{
				harness: "pi-context-fold",
				session: "s1",
				seq: 1,
				at: "2026-07-28T00:00:00.000Z",
				trigger: "threshold",
				usage: { tokens: 90000, contextWindow: 200000, fraction: 0.45 },
			},
			extractIndex({ masked, all }),
			[
				{
					blockId: masked[0].id,
					code: "abc123",
					tool: "bash",
					turn: masked[0].turn,
					log: { bytes: 100, lines: 5 },
					sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
				},
			],
		);
		expect(rec.v).toBe(2);
		expect(rec.kind).toBe("fold-index");
		expect(rec.spans).toHaveLength(1);
		expect(rec.errors.length).toBeGreaterThan(0);
	});
});
