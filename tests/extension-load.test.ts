/*
 * extension-load.test.ts — the published entry point actually loads.
 *
 * Every other test exercises the engine directly. This one imports what Pi imports and drives it
 * with a stub ExtensionAPI, so a broken import, a missing module, or a throw during registration
 * fails here rather than in a user's first session. Skipped when the Pi CLI is not installed
 * alongside (the adapter imports `typebox`, which Pi injects at runtime — see vitest.config.ts).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PI_PRESENT = existsSync(resolve(__dirname, "../node_modules/@earendil-works/pi-coding-agent/package.json"));

interface Recorded {
	hooks: string[];
	tools: string[];
	commands: string[];
	api: any;
}

function stubPi(): Recorded {
	const hooks: string[] = [];
	const tools: string[] = [];
	const commands: string[] = [];
	return {
		hooks,
		tools,
		commands,
		api: {
			on: (name: string) => hooks.push(name),
			registerTool: (t: { name: string }) => tools.push(t.name),
			registerCommand: (name: string) => commands.push(name),
			appendEntry: () => {},
			setLabel: () => {},
		},
	};
}

describe("package manifest", () => {
	it("uses a shipped root entry point so Pi displays context-fold", () => {
		const manifest = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));

		expect(manifest.pi?.extensions).toEqual(["./index.ts"]);
		expect(manifest.files).toContain("index.ts");
	});
});

describe.skipIf(!PI_PRESENT)("extension entry point", () => {
	it("registers every hook, tool and command", async () => {
		const { default: contextFold } = await import("../index");
		const s = stubPi();
		contextFold(s.api);

		expect(s.hooks).toEqual(
			expect.arrayContaining(["session_start", "message_end", "agent_settled", "context_with_system", "session_before_compact"]),
		);
		expect(s.hooks).not.toContain("context");
		expect(s.hooks).not.toContain("tool_result");
		expect(s.hooks).not.toContain("before_agent_start");
		expect(s.tools).toEqual(expect.arrayContaining(["recall_folded", "unfold"]));
		expect(s.commands).toEqual(expect.arrayContaining(["context-fold", "fold-handoff"]));
	});

	it("registers nothing at all when CONTEXTFOLD=0 (the master kill switch)", async () => {
		const { default: contextFold } = await import("../index");
		const prev = process.env.CONTEXTFOLD;
		process.env.CONTEXTFOLD = "0";
		const s = stubPi();
		try {
			contextFold(s.api);
		} finally {
			if (prev === undefined) delete process.env.CONTEXTFOLD;
			else process.env.CONTEXTFOLD = prev;
		}

		expect(s.hooks).toEqual([]);
		expect(s.tools).toEqual([]);
		expect(s.commands).toEqual([]);
	});
});
