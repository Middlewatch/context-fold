import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import contextFold from "../src/adapters/pi/index";
import { assistantText, assistantWithCalls, bigResult, toolResult, user } from "./helpers";
import type { AgentMessage } from "../src/core/block";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-pi-compat-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("CONTEXTFOLD_TAIL", "100");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function fixture(fullOutputPath?: string, persist = false) {
	const sm = persist ? SessionManager.create(dir, dir) : SessionManager.inMemory(dir);
	vi.spyOn(sm, "getSessionDir").mockReturnValue(dir);
	const append = (m: AgentMessage) => sm.appendMessage(m as Parameters<typeof sm.appendMessage>[0]);
	append(user("investigate"));
	append(assistantWithCalls([{ id: "old", name: "read" }]));
	const raw = bigResult("old", 800);
	if (fullOutputPath) raw.details = { fullOutputPath };
	(raw.content as { text: string }[])[0].text += "\nError: OLD_MARKER";
	const target = append(raw);
	append(assistantText("observed"));
	const tail = append(user("keep working"));
	return { sm, append, target, tail };
}

function load(sm: SessionManager) {
	// Pi owns dispatch and canonical projection; only UI/model services are stubbed.
	const hooks = new Map<string, ((event: any, ctx: any) => any)[]>();
	const tools = new Map<string, any>();
	contextFold({
		on: (name: string, fn: any) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
	} as never);
	const ctx = {
		sessionManager: sm,
		getContextUsage: () => ({ contextWindow: 16_000, tokens: 15_000 }),
		ui: { setStatus: () => {}, notify: () => {} },
	};
	const runner = {
		createContext: () => ctx,
		extensions: [{ path: "context-fold", handlers: hooks }],
		emitError: (error: unknown) => { throw new Error(JSON.stringify(error)); },
	};
	return {
		hooks,
		invoke: async (name: string, event: unknown = {}) => {
			let result;
			for (const fn of hooks.get(name) ?? []) result = await fn(event, ctx);
			return result;
		},
		context: () => ExtensionRunner.prototype.emitContext.call(runner as never, sm.buildSessionProjection().messages),
		recall: async (code: string) => {
			const result = await tools.get("recall_folded").execute("recall", { codes: [code], grep: "MARKER" });
			return result.content.map((c: { text: string }) => c.text).join("\n");
		},
	};
}

function resultText(messages: readonly { role: string }[]): string {
	const m = messages.find(m => m.role === "toolResult") as { content: { text: string }[] } | undefined;
	return m?.content[0].text ?? "";
}
const codeOf = (text: string) => /\{#(\w+) FOLDED\}/.exec(text)![1];
const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 200 };

async function compact(h: ReturnType<typeof load>, sm: SessionManager) {
	const preparation = prepareCompaction(sm.getBranch(), { ...settings, keepRecentTokens: 1 })!;
	expect(preparation).toBeDefined();
	const result = await h.invoke("session_before_compact", { preparation, branchEntries: sm.getBranch() });
	const c = result.compaction;
	sm.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
	await h.invoke("session_compact");
	return c.summary as string;
}

describe("Pi 0.87 compatibility", () => {
	it("preserves system sections and tool deltas in place through real runner dispatch", async () => {
		const { sm } = fixture();
		const entries = sm.getEntries();
		const head = { role: "system", content: "", sections: { preamble: "BASE", cwd: "OLD" }, toolsAdded: [{ name: "write", description: "Write", parameters: { type: "object" } }], timestamp: 1 };
		const delta = { role: "system", content: "", sections: { cwd: "NEW" }, toolsRemoved: [{ name: "write" }], toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object" } }], timestamp: 2 };
		// Place the system messages in a valid persisted transcript, separated by conversation.
		const restored = SessionManager.inMemory(dir);
		vi.spyOn(restored, "getSessionDir").mockReturnValue(dir);
		restored.appendMessage(head as never);
		for (let i = 0; i < entries.length; i++) {
			if (i === 3) restored.appendMessage(delta as never);
			if (entries[i].type === "message") restored.appendMessage((entries[i] as any).message);
		}
		const h = load(restored);
		const before = restored.buildSessionProjection().messages;
		const out = await h.context();
		expect(resultText(out)).toContain("FOLDED");
		expect(out.filter(m => m.role === "system")).toEqual([head, delta]);
		expect(out.map(m => m.role)).toEqual(before.map(m => m.role));
		expect(restored.buildSessionProjection().messages).toEqual(before);
		restored.appendMessage({ role: "system", content: "", sections: { rules: "new rule" }, timestamp: 3 } as never);
		const updated = await h.context();
		expect(updated.slice(0, out.length)).toEqual(out);
		expect(updated.at(-1)).toMatchObject({ role: "system", sections: { rules: "new rule" } });
	});

	it("keeps successive replacement handles recallable after compaction and a disk reopen", async () => {
		const { sm, target } = fixture(undefined, true);
		let h = load(sm);
		const original = resultText(await h.context());
		const code = codeOf(original);
		const replacement = (sm.getEntry(target) as any).message.content[0].text.replace("OLD_MARKER", "NEW_MARKER");
		sm.appendContextEdit(target, { content: replacement });
		const edited = resultText(await h.context());
		expect(edited).not.toBe(original);
		expect(edited).not.toContain("OLD_MARKER");
		const editedCode = codeOf(edited);
		expect(editedCode).not.toBe(code);
		sm.appendContextEdit(target, { content: replacement.replace("NEW_MARKER", "THIRD_MARKER") });
		const thirdCode = codeOf(resultText(await h.context()));
		expect(thirdCode).not.toBe(editedCode);
		await compact(h, sm);
		const reopened = SessionManager.open(sm.getSessionFile()!, dir);
		h = load(reopened);
		await h.invoke("session_start");
		await h.context();
		expect(await h.recall(code)).toContain("OLD_MARKER");
		expect(await h.recall(editedCode)).toContain("NEW_MARKER");
		expect(await h.recall(thirdCode)).toContain("THIRD_MARKER");
	});

	it("rebuilds summary evidence after omissions instead of replaying old index records or summaries", async () => {
		const { sm, target } = fixture();
		const h = load(sm);
		await h.context();
		sm.appendContextEdit(target, null);
		const summary = await compact(h, sm);
		expect(summary).not.toContain("OLD_MARKER");
	});

	it("recalls an unfrozen replacement recorded at compaction without reading the original output file", async () => {
		const path = join(dir, "original-output.txt");
		writeFileSync(path, "Error: ORIGINAL_FILE_MARKER");
		const { sm, target } = fixture(path);
		const h = load(sm);
		sm.appendContextEdit(target, { content: "Error: REPLACEMENT_MARKER\n".repeat(500) });
		const summary = await compact(h, sm);
		await h.context();
		const text = await h.recall(codeOf(summary));
		expect(text).toContain("REPLACEMENT_MARKER");
		expect(text).not.toContain("ORIGINAL_FILE_MARKER");
	});

	it("re-extracts previous compacted spans after a later omission", async () => {
		const { sm, target, append } = fixture();
		const h = load(sm);
		expect(await compact(h, sm)).toContain("OLD_MARKER");
		sm.appendContextEdit(target, null);
		append(assistantText("Error: CURRENT_MARKER"));
		append(user("continue"));
		const summary = await compact(h, sm);
		expect(summary).toContain("CURRENT_MARKER");
		expect(summary).not.toContain("OLD_MARKER");
	});

	it("retains new errors across repeated compactions within one user turn", async () => {
		const { sm, target, tail, append } = fixture();
		sm.branch(sm.getEntry(tail)!.parentId!);
		sm.appendContextEdit(target, { content: Array.from({ length: 24 }, (_, i) => `Error: EARLY_${i}`).join("\n") });
		const h = load(sm);
		await compact(h, sm);
		append(assistantWithCalls([{ id: "late", name: "read" }]));
		append(toolResult("late", "Error: CURRENT_FAILURE"));
		append(assistantText("continuing the same request"));
		const summary = await compact(h, sm);
		expect(summary).toContain("Error: CURRENT_FAILURE");
	});

	it("handles recovery omissions and a metadata kept boundary, including failed compaction", async () => {
		const sm = SessionManager.inMemory(dir);
		vi.spyOn(sm, "getSessionDir").mockReturnValue(dir);
		sm.appendMessage(user("KEEP_THIS_REQUEST\n".repeat(500)) as never);
		const failed = sm.appendMessage({ ...assistantText("Error: ABANDONED_MARKER"), stopReason: "error" } as never);
		sm.appendContextEdit(failed, null);
		const h = load(sm);
		const preparation = prepareCompaction(sm.getBranch(), settings)!;
		expect(preparation).toBeDefined();
		const result = await h.invoke("session_before_compact", { preparation, branchEntries: sm.getBranch() });
		expect(result.compaction.firstKeptEntryId).toBe(preparation.firstKeptEntryId);
		expect(result.compaction.summary).toContain("KEEP_THIS_REQUEST");
		expect(result.compaction.summary).not.toContain("ABANDONED_MARKER");
		await h.invoke("session_compact_failed", { reason: "overflow", aborted: true, willRetry: true });
		expect(JSON.stringify(await h.context())).not.toContain("ABANDONED_MARKER");
		expect(sm.getEntries().some(e => e.type === "compaction")).toBe(false);
	});

	it("rebuilds prompt/tool checkpoints and supports a preceding retain-none compaction", async () => {
		const { sm, append } = fixture();
		sm.appendMessage({ role: "system", content: "", sections: { preamble: "CURRENT" }, toolsAdded: [], timestamp: 1 } as never);
		sm.appendCompaction("obsolete summary", null, 20_000);
		append(user("next request"));
		append(assistantText("Error: CURRENT_MARKER"));
		append(user("continue"));
		const h = load(sm);
		const summary = await compact(h, sm);
		expect(summary).toContain("OLD_MARKER");
		expect(summary).toContain("CURRENT_MARKER");
		expect(summary).not.toContain("obsolete summary");
		expect(await h.context()).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system", sections: { preamble: "CURRENT" } })]));
	});

	it("uses the active branch after navigating before an edit", async () => {
		const { sm, target, tail } = fixture();
		const h = load(sm);
		const original = resultText(await h.context());
		sm.appendContextEdit(target, { content: "Error: NEW_MARKER\n".repeat(2000) });
		await h.context();
		sm.branch(tail);
		await h.invoke("session_tree");
		expect(resultText(await h.context())).toBe(original);
		const summary = await compact(h, sm);
		expect(summary).toContain("OLD_MARKER");
		expect(summary).not.toContain("NEW_MARKER");
	});

	it("keeps an oversized first-delivery result with its assistant call", () => {
		const { sm, append } = fixture();
		append(assistantWithCalls([{ id: "fresh", name: "read" }]));
		append(bigResult("fresh", 4000));
		const prep = prepareCompaction(sm.getBranch(), settings)!;
		expect([...prep.messagesToSummarize, ...prep.turnPrefixMessages].some(m => m.role === "toolResult" && m.toolCallId === "fresh")).toBe(false);
		expect((sm.getEntry(prep.firstKeptEntryId) as any).message.role).toBe("assistant");
	});
});
