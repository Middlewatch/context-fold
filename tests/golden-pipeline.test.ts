/*
 * golden-pipeline.test.ts — byte-level characterization of the whole deterministic pipeline:
 * one fixed session in, fixed hashes out (folded messages, seed-index JSONL, recall). Guards the
 * determinism invariant across refactors; run with GOLDEN_PRINT=1 to see the current hashes when
 * an intentional behavior change moves them.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextFoldEngine } from "../src/adapters/pi/store";
import { FoldLadderPolicy } from "../src/core/policy/fold-ladder";
import { MapFoldRegistry } from "../src/core/fold-registry";
import { LedgerReader } from "../src/adapters/pi/ledger";
import { SeedIndexStore, emitFoldIndex } from "../src/adapters/pi/index-store";
import type { AgentMessage } from "../src/core/block";
import { assistantText, assistantWithCalls, bigResult, toolResult, user } from "./helpers";

const NOW = 1_722_200_000_000;

const GOLDEN = {
	folded: "f759c01722ab2b7eca42453c5ecaf880bbd03298feb754c2087713d3dc67cff2",
	index: "ee7cdd19956479886a6d9f3aa79c918e526865535f4a9319d27e3784777d2bc9",
	recall: "60801419797d23a9486f5fe856fade34745b5f1c4d7062f6295b9a9c9e903382",
};

function sha(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

function fixedSession(): AgentMessage[] {
	const messages: AgentMessage[] = [user("find the capacity limit in the dump")];
	for (let i = 0; i < 7; i++) {
		messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }], { text: `reading ${i}`, thinking: `plan step ${i}` }));
		messages.push(bigResult(`c${i}`, 400));
	}
	messages.push(assistantWithCalls([{ id: "cx", name: "bash", args: { cmd: "npx vitest run" } }]));
	const lines = Array.from({ length: 300 }, (_, i) => `row ${i}: ${"y".repeat(40)}`);
	lines[150] = "    CAP_X9_LIMIT=52418 assigned to shard 3f9a2c7e11d04b22";
	lines[171] = "  2 passed, 1 failed";
	messages.push(toolResult("cx", lines.join("\n"), "bash"));
	messages.push(assistantText("finished reading", "after-cx"));
	messages.push(user("now the newest question"));
	return messages;
}

function filesUnder(dir: string, base = dir): { rel: string; body: string }[] {
	const out: { rel: string; body: string }[] = [];
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...filesUnder(p, base));
		else out.push({ rel: p.slice(base.length + 1), body: readFileSync(p, "utf8") });
	}
	return out;
}

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("golden pipeline", () => {
	it("the fixed session folds, indexes, and recalls to fixed bytes — and writes only the JSONL", () => {
		dir = mkdtempSync(join(tmpdir(), "contextfold-golden-"));
		const registry = new MapFoldRegistry();
		const index = new SeedIndexStore(dir);
		const engine = new ContextFoldEngine(new FoldLadderPolicy(), { tailTarget: 100 }, registry);
		engine.onFoldEvent = (ev) => emitFoldIndex(ev, { registry, index, sessionId: "s-golden", now: NOW });
		const session = fixedSession();
		engine.attachLedger(new LedgerReader(() => session.map((m) => ({ type: "message", message: m }))));

		const out = engine.process(session, 8_000);
		const foldedJson = JSON.stringify(out);
		const codes = [...new Set([...foldedJson.matchAll(/\{#([a-z0-9]+) FOLDED/g)].map((m) => m[1]))].sort();
		expect(codes.length).toBeGreaterThan(0);

		const scrub = (s: string) => s.split(dir).join("<DIR>");
		const files = filesUnder(dir);
		// The seed index is the only on-disk artifact — no spool envelopes, no bookkeeping files.
		expect(files.map((f) => f.rel)).toEqual(["seed-index.jsonl"]);
		const indexBytes = files.map((f) => `${f.rel}\n${scrub(f.body)}`).join("\n---\n");
		const recall = codes.map((c) => [
			engine.resolveRecall([c]),
			engine.resolveRecall([c], { grep: "CAP_X9" }),
			engine.resolveRecall([c], { lines: "10-12" }),
		]);
		const got = {
			folded: sha(foldedJson),
			index: sha(indexBytes),
			recall: sha(scrub(JSON.stringify(recall))),
		};
		if (process.env.GOLDEN_PRINT) console.log("GOLDEN =", JSON.stringify(got, null, "\t"));
		expect(got).toEqual(GOLDEN);
	});
});
