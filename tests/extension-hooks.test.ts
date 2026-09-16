/*
 * extension-hooks.test.ts — the entry point's hook BODIES, not just their registration.
 *
 * extension-load.test.ts proves the hooks get registered; this file drives each one the way Pi
 * drives it. Everything here is wiring that only exists in index.ts — resume restore,
 * session-switch reset, cache telemetry, and deterministic compaction — so a regression would
 * otherwise surface first in a user's session.
 *
 * Skipped when the Pi CLI is not installed alongside (the adapter imports `typebox`, which Pi
 * injects at runtime — see vitest.config.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { user, assistantText, assistantWithCalls, bigResult, toolResult } from "./helpers";
import type { AgentMessage } from "../src/core/block";

const PI_PRESENT = existsSync(resolve(__dirname, "../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox"));

type Hook = (event: unknown, ctx: unknown) => unknown;
interface Entry {
	customType: string;
	data: unknown;
}

/** A stub ExtensionAPI that keeps every registration so the test can invoke it. */
function stubPi() {
	const hooks = new Map<string, Hook>();
	const tools = new Map<string, { execute(id: string, p: Record<string, unknown>): Promise<{ content: { text: string }[] }> }>();
	const commands = new Map<string, { handler(args: unknown, ctx: unknown): Promise<void> }>();
	const entries: Entry[] = [];
	return {
		hooks,
		tools,
		commands,
		entries,
		api: {
			on: (name: string, fn: Hook) => hooks.set(name, fn),
			registerTool: (t: never) => tools.set((t as { name: string }).name, t),
			registerCommand: (name: string, c: never) => commands.set(name, c),
			appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
			setLabel: () => {},
		} as never,
	};
}

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"CONTEXTFOLD",
	"CONTEXTFOLD_COMPACT",
	"CONTEXTFOLD_FOLD_AT",
	"CONTEXTFOLD_TAIL",
	"CONTEXTFOLD_L0",
	"CONTEXTFOLD_L0_THRESHOLD",
	"PI_CODING_AGENT_DIR",
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-hooks-"));
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

/** A ctx shaped like Pi's, backed by a real on-disk session dir. */
function ctxFor(
	opts: {
		sessionId?: string;
		entries?: unknown[];
		/** Message payloads for the session ledger, wrapped as Pi's SessionMessageEntry shape. */
		messages?: AgentMessage[];
		usage?: { contextWindow: number; tokens: number | null } | null;
	} = {},
) {
	const notices: string[] = [];
	const statuses: Record<string, string | undefined> = {};
	return {
		notices,
		statuses,
		ctx: {
			model: { id: "test-model", provider: "test" },
			sessionManager: {
				getSessionDir: () => dir,
				getSessionId: () => opts.sessionId ?? "s1",
				getEntries: () => [...(opts.messages ?? []).map((m) => ({ type: "message", message: m })), ...(opts.entries ?? [])],
			},
			getContextUsage: () => opts.usage ?? { contextWindow: 200_000, tokens: null },
			ui: {
				notify: (m: string) => notices.push(m),
				setStatus: (key: string, text: string | undefined) => {
					statuses[key] = text;
				},
			},
		},
	};
}

async function load() {
	const { default: contextFold } = await import("../src/adapters/pi/index");
	const s = stubPi();
	contextFold(s.api);
	return s;
}

/** A session heavy enough to cross the ladder's first-fold threshold on an 80k window. */
function heavySession(): AgentMessage[] {
	const messages: AgentMessage[] = [user("build the thing")];
	for (let i = 0; i < 8; i++) {
		messages.push(assistantWithCalls([{ id: `c${i}`, name: "read" }]));
		messages.push(bigResult(`c${i}`, 400));
	}
	messages.push(user("now the newest question"));
	return messages;
}

describe.skipIf(!PI_PRESENT)("context hook", () => {
	it("ignores obsolete L0 settings and delivers a large fresh result unchanged", async () => {
		// CONTEXTFOLD_L0* configured the arrival-time ingestion gate removed in 0.3.0 (see
		// CHANGELOG.md). Stale settings from an older install must stay inert, never resurrect it.
		process.env.CONTEXTFOLD_L0 = "1";
		process.env.CONTEXTFOLD_L0_THRESHOLD = "1";
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: 79_000 } });
		const messages: AgentMessage[] = [
			user("read it"),
			assistantWithCalls([{ id: "fresh", name: "read" }]),
			bigResult("fresh", 500),
		];

		const out = (await s.hooks.get("context")!({ messages }, ctx)) as { messages: AgentMessage[] };
		expect(out.messages).toBe(messages);
		expect(JSON.stringify(out.messages)).not.toContain("FOLDED");
		expect(s.hooks.has("tool_result")).toBe(false);
		expect(s.entries).toEqual([]);
	});

	it("folds the outgoing messages and leaves the caller's array untouched", async () => {
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		const messages = heavySession();

		const out = (await s.hooks.get("context")!({ messages }, ctx)) as { messages: AgentMessage[] };
		const folded = out.messages.filter((m) => JSON.stringify(m).includes("FOLDED"));

		expect(folded.length).toBeGreaterThan(0);
		// The input array is Pi's copy; folding must not mutate it in place.
		expect(JSON.stringify(messages)).not.toContain("FOLDED");
	});

	it("sends context raw rather than failing the turn when the pass throws", async () => {
		const s = await load();
		const messages = heavySession();
		const broken = {
			model: { id: "m" },
			sessionManager: { getSessionDir: () => dir, getSessionId: () => "s1", getEntries: () => [] },
			getContextUsage: () => {
				throw new Error("usage exploded");
			},
		};

		const out = (await s.hooks.get("context")!({ messages }, broken)) as { messages: AgentMessage[] };
		expect(out.messages).toBe(messages); // fail-open: the same array, unfolded
	});

	it("keeps a fold raw when its seed index cannot be written", async () => {
		const s = await load();
		const blocker = join(dir, "not-a-directory");
		writeFileSync(blocker, "x");
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		ctx.sessionManager.getSessionDir = () => join(blocker, "session");
		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const messages = heavySession();
			const out = (await s.hooks.get("context")!({ messages }, ctx)) as { messages: AgentMessage[] };
			expect(JSON.stringify(out.messages)).not.toContain("FOLDED");
			expect(s.entries.some((entry) => (entry.data as { kind?: string }).kind === "layer")).toBe(false);
		} finally {
			process.stderr.write = originalWrite;
		}
		expect(writes.join("")).toContain("seed-index emission failed (fold skipped)");
	});
});

describe.skipIf(!PI_PRESENT)("session_start hook", () => {
	it("restores a prior session's frozen layers and spool handles", async () => {
		const first = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		const messages = heavySession();
		await first.hooks.get("context")!({ messages }, ctx);
		expect(first.entries.some((entry) => (entry.data as { kind?: string }).kind === "fold")).toBe(true);
		expect(first.entries.some((entry) => (entry.data as { kind?: string }).kind === "layer")).toBe(true);

		// A fresh process: only the recorded ledger entries survive.
		const resumed = await load();
		const ledger = first.entries.map((e) => ({ customType: e.customType, data: e.data }));
		const resumedCtx = ctxFor({ entries: ledger, usage: { contextWindow: 80_000, tokens: null } }).ctx;
		await resumed.hooks.get("session_start")!({}, resumedCtx);

		const out = (await resumed.hooks.get("context")!({ messages }, resumedCtx)) as { messages: AgentMessage[] };
		expect(JSON.stringify(out.messages)).toContain("FOLDED");
	});

	it("a session switch drops the previous session's codes (they must not serve another session)", async () => {
		const s = await load();
		const firstCtx = ctxFor({ sessionId: "s1", usage: { contextWindow: 80_000, tokens: null } }).ctx;
		await s.hooks.get("session_start")!({}, firstCtx);
		await s.hooks.get("context")!({ messages: heavySession() }, firstCtx);
		const foldRecord = s.entries.find((entry) => (entry.data as { kind?: string }).kind === "fold")!;
		const code = (foldRecord.data as { entry: { code: string } }).entry.code;

		// Switch sessions in the same process, carrying no ledger into the new one.
		await s.hooks.get("session_start")!({}, ctxFor({ sessionId: "s2", entries: [] }).ctx);

		const res = await s.tools.get("recall_folded")!.execute("t1", { codes: [code] });
		expect(res.content.map((c) => c.text).join("")).toContain("no folded block with that code");
	});
});

describe.skipIf(!PI_PRESENT)("/context-fold config command", () => {
	it("a menu edit persists under the agent dir and live-applies (compact → native declines det compaction)", async () => {
		delete process.env.CONTEXTFOLD_COMPACT;
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		const steps: (string | undefined)[] = ["Hard compaction", "native", "Done"];
		const cmdCtx = {
			...ctx,
			hasUI: true,
			ui: {
				select: async (_t: string, opts: string[]) => {
					const want = steps.shift();
					return want === undefined ? undefined : opts.find((o) => o.startsWith(want));
				},
				input: async () => steps.shift(),
				notify: () => {},
			},
		};
		await s.commands.get("context-fold")!.handler("config", cmdCtx);

		const file = join(dir, "agent", "context-fold.json");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ compact: "native" });
		const out = await s.hooks.get("session_before_compact")!(
			{ preparation: { messagesToSummarize: heavySession(), turnPrefixMessages: [], tokensBefore: 40_000, firstKeptEntryId: "e9" } },
			ctx,
		);
		expect(out).toBeUndefined();
	});

	it("without interactive UI (hasUI false, dialogs stubbed) the command prints the effective settings instead", async () => {
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		const s = await load();
		const { ctx, notices } = ctxFor();
		// Headless Pi still defines select/input; they just answer undefined. hasUI is what gates.
		const headless = {
			...ctx,
			hasUI: false,
			ui: { ...ctx.ui, select: async () => undefined, input: async () => undefined },
		};
		await s.commands.get("context-fold")!.handler("config", headless as never);
		expect(notices.join("\n")).toContain("context-fold settings");
		expect(notices.join("\n")).toContain("Fold threshold: 0.45");
	});
});

describe.skipIf(!PI_PRESENT)("session_before_compact hook", () => {
	it("replaces Pi's LLM summary with a deterministic one rendered from the seed index", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		// Drive a fold event first so the seed index has something to render from.
		await s.hooks.get("context")!({ messages: heavySession() }, ctx);

		const prep = {
			messagesToSummarize: heavySession(),
			turnPrefixMessages: [],
			tokensBefore: 40_000,
			firstKeptEntryId: "e9",
		};
		const out = (await s.hooks.get("session_before_compact")!({ preparation: prep }, ctx)) as {
			compaction: { summary: string; firstKeptEntryId: string };
		};

		expect(out.compaction.firstKeptEntryId).toBe("e9");
		expect(out.compaction.summary).toContain("deterministic seed index");
		expect(out.compaction.summary).toContain("no model involved");
	});

	it("carries a previous summary forward but marks it untrusted", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		await s.hooks.get("context")!({ messages: heavySession() }, ctx);

		const out = (await s.hooks.get("session_before_compact")!(
			{
				preparation: {
					messagesToSummarize: heavySession(),
					turnPrefixMessages: [],
					tokensBefore: 40_000,
					firstKeptEntryId: "e9",
					previousSummary: "An earlier model wrote this.",
				},
			},
			ctx,
		)) as { compaction: { summary: string } };

		expect(out.compaction.summary).toContain("An earlier model wrote this.");
		expect(out.compaction.summary).toContain("UNTRUSTED");
	});

	// Pi splits a mid-turn cut into TWO arrays: `messagesToSummarize` (whole turns before the
	// cut's turn) and `turnPrefixMessages` (the cut turn's own head). BOTH leave live history —
	// Pi's native path summarizes the prefix separately, and an extension that returns a summary
	// replaces that path entirely. Reading only `messagesToSummarize` therefore drops the prefix
	// with no summary text and no spool route. When the cut lands inside the FIRST turn,
	// `messagesToSummarize` is empty and the whole session would vanish behind a bare header.
	it("covers turnPrefixMessages, the mid-turn half Pi also drops", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();

		// Exactly the live shape that lost a session's history: the cut fell inside the opening turn, so
		// everything the session had done sat in the turn prefix and nothing preceded it.
		const prefix: AgentMessage[] = [
			user("trace the overflow path"),
			assistantWithCalls([{ id: "tp0", name: "read" }]),
			toolResult("tp0", `SENTINEL_PREFIX_BODY\n${"line of prefix output\n".repeat(400)}`),
			assistantText("the prefix turn reached this conclusion"),
		];
		// The session ledger keeps the raw prefix messages — that is where recall re-locates them.
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null }, messages: prefix });

		const out = (await s.hooks.get("session_before_compact")!(
			{ preparation: { messagesToSummarize: [], turnPrefixMessages: prefix, tokensBefore: 40_000, firstKeptEntryId: "e9" } },
			ctx,
		)) as { compaction: { summary: string } };

		// The prefix must survive as recoverable detail, not just as a header. Assert on the block
		// BODY, never on the search term itself — a miss echoes the term back and would pass.
		const hit = await s.tools.get("recall_folded")!.execute("t1", { search: "SENTINEL_PREFIX_BODY" });
		const hitText = hit.content.map((c) => c.text).join("");
		expect(hitText).toContain("1 matching line");
		const code = /=== (\w+) \(/.exec(hitText)?.[1];
		expect(code).toBeTruthy();
		const body = await s.tools.get("recall_folded")!.execute("t2", { codes: [code!] });
		expect(body.content.map((c) => c.text).join("")).toContain("line of prefix output");
		expect(out.compaction.summary).toContain("trace the overflow path");
	});

	it("stands aside for Pi's own compaction under CONTEXTFOLD_COMPACT=native", async () => {
		process.env.CONTEXTFOLD_COMPACT = "native";
		const s = await load();
		const { ctx } = ctxFor();

		const out = await s.hooks.get("session_before_compact")!(
			{ preparation: { messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1, firstKeptEntryId: "e1" } },
			ctx,
		);
		expect(out).toBeUndefined();
	});
});

describe.skipIf(!PI_PRESENT)("message_end hook and the status command", () => {
	it("records provider usage and reports it through /context-fold", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor();

		await s.hooks.get("message_end")!({ message: { role: "assistant", usage: { input: 1000, cacheRead: 3000, cacheWrite: 0, output: 50 } } }, ctx);
		await s.commands.get("context-fold")!.handler("", ctx);

		expect(notices.join("\n")).toContain("cache read 3.0k");
	});

	it("ignores messages that carry no usage", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor();

		await s.hooks.get("message_end")!({ message: { role: "user" } }, ctx);
		await s.commands.get("context-fold")!.handler("", ctx);

		expect(notices.join("\n")).toContain("no usage yet");
	});

	it("waits for agent_settled before warning that a session is cold", async () => {
		const s = await load();
		const { ctx } = ctxFor();
		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 5_000, cacheRead: 30_000, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			expect(writes.join("")).not.toContain("session cold");

			await s.hooks.get("agent_settled")!({}, ctx);
			const warnings = writes.filter((w) => w.includes("session cold"));
			expect(warnings).toEqual(["session cold: rebilled ~40k tok as fresh input. Consider /fold-handoff\n"]);
			expect(warnings[0].trimEnd().length).toBeLessThanOrEqual(80);
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("does not warn when an intermediate miss recovers before the agent settles", async () => {
		const s = await load();
		const { ctx } = ctxFor();
		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 1_000, cacheRead: 40_000, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);
			expect(writes.join("")).not.toContain("session cold");
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("does not misclassify the expected post-fold cache miss at settlement", async () => {
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		await s.hooks.get("message_end")!(
			{ message: { role: "assistant", usage: { input: 5_000, cacheRead: 30_000, cacheWrite: 0, output: 50 } } },
			ctx,
		);
		await s.hooks.get("context")!({ messages: heavySession() }, ctx);

		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);
			expect(writes.join("")).not.toContain("session cold");
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("does not let post-fold suppression reset an existing cold streak", async () => {
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 5_000, cacheRead: 30_000, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);

			await s.hooks.get("context")!({ messages: heavySession() }, ctx);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);

			expect(writes.filter((w) => w.includes("session cold"))).toHaveLength(1);
		} finally {
			process.stderr.write = originalWrite;
		}
	});

	it("warns again after a genuine warm recovery starts a new cold streak", async () => {
		const s = await load();
		const { ctx } = ctxFor();
		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 5_000, cacheRead: 30_000, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);

			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 1_000, cacheRead: 40_000, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 50 } } },
				ctx,
			);
			await s.hooks.get("agent_settled")!({}, ctx);

			expect(writes.filter((w) => w.includes("session cold"))).toHaveLength(2);
		} finally {
			process.stderr.write = originalWrite;
		}
	});
});

describe.skipIf(!PI_PRESENT)("footer status line", () => {
	it("shows idle at session start, then a fold summary with nothing left maskable after a fold event", async () => {
		const s = await load();
		const { ctx, statuses } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		await s.hooks.get("session_start")!({}, ctx);
		expect(statuses["context-fold"]).toContain("idle");

		await s.hooks.get("context")!({ messages: heavySession() }, ctx);
		expect(statuses["context-fold"]).toContain("×1");
		expect(statuses["context-fold"]).toContain("tok masked");
		// The fold consumed every eligible block, so the gauge restarts counting toward the next
		// step — an interim state that refills as new observations land, not a terminal one.
		expect(statuses["context-fold"]).toMatch(/next fold: 0\/\S+ maskable/);
	});

	it("names the configured entry threshold while usage is still below it", async () => {
		process.env.CONTEXTFOLD_FOLD_AT = "0.6";
		const s = await load();
		const { ctx, statuses } = ctxFor({ usage: { contextWindow: 80_000, tokens: 30_000 } });

		await s.hooks.get("context")!({ messages: heavySession() }, ctx);
		expect(statuses["context-fold"]).toContain("next fold at 60% ctx");
		expect(statuses["context-fold"]).not.toContain("×");
	});

	it("tracks maskable mass toward the next step once usage is past the threshold", async () => {
		process.env.CONTEXTFOLD_TAIL = "1000"; // shrink the protected tail so one older result is maskable
		const s = await load();
		const { ctx, statuses } = ctxFor({ usage: { contextWindow: 80_000, tokens: 40_000 } });
		const messages: AgentMessage[] = [
			user("build the thing"),
			assistantWithCalls([{ id: "c0", name: "read" }]),
			bigResult("c0", 200),
			assistantWithCalls([{ id: "c1", name: "read" }]),
			bigResult("c1", 200),
			user("now the newest question"),
		];

		// 40k/80k = 50% ≥ the 45% threshold, but only ~2.5k of maskable mass (< the 9.6k step):
		// no fold fires, and the gauge shows progress toward the step instead of the usage threshold.
		await s.hooks.get("context")!({ messages }, ctx);
		expect(statuses["context-fold"]).toMatch(/next fold: \S+\/\S+ maskable/);
		expect(statuses["context-fold"]).not.toContain("×");
	});

	it("shows an empty step gauge past the threshold with nothing maskable yet", async () => {
		const s = await load();
		const { ctx, statuses } = ctxFor({ usage: { contextWindow: 80_000, tokens: 40_000 } });

		// Pure conversation: no tool results or thinking anywhere, so the ladder has nothing to work
		// with even though usage (50%) is past the 45% threshold. Still interim — a big tool result
		// next turn would start filling the gauge — so it counts from zero rather than declaring
		// folding impossible.
		await s.hooks.get("context")!({ messages: [user("hi"), assistantText("a long answer"), user("more")] }, ctx);
		expect(statuses["context-fold"]).toMatch(/next fold: 0\/\S+ maskable/);
		expect(statuses["context-fold"]).not.toContain("×");
	});

	it("declares no more folds possible only when the irreducible floor is over budget", async () => {
		const s = await load();
		// 70k reported of an 80k window is past the 60k budget (0.75 × window), and a pure-text
		// conversation leaves nothing maskable: the terminal state, not an interim one.
		const { ctx, statuses } = ctxFor({ usage: { contextWindow: 80_000, tokens: 70_000 } });

		await s.hooks.get("context")!({ messages: [user("hi"), assistantText("x".repeat(280_000)), user("more")] }, ctx);
		expect(statuses["context-fold"]).toContain("⚠ no more folds possible (over budget)");
	});

	it("pauses folding and says so when usage shows the transport holds the conversation", async () => {
		const s = await load();
		// A bridged CLI (pi-with-claude) books its whole occupancy as cache read with nothing prefilled,
		// and its tool-pause responses carry no usage at all.
		const { ctx, statuses } = ctxFor({ usage: { contextWindow: 80_000, tokens: 70_000 } });
		const held = (cacheRead: number) => ({ message: { role: "assistant", usage: { input: 0, cacheRead, cacheWrite: 0, output: 50 } } });
		await s.hooks.get("message_end")!(held(60_000), ctx);
		await s.hooks.get("message_end")!({ message: { role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } }, ctx);
		await s.hooks.get("message_end")!(held(70_000), ctx);

		// 70k of 80k is past the 60k budget and heavySession has plenty to mask: the cap branch would fire.
		const messages = heavySession();
		const out = (await s.hooks.get("context")!({ messages }, ctx)) as { messages: AgentMessage[] };
		expect(out.messages).toBe(messages);
		expect(statuses["context-fold"]).toContain("folding paused: provider holds the context");
		expect(statuses["context-fold"]).not.toContain("×");
		expect(statuses["context-fold"]).not.toContain("over budget");
	});

	it("survives a ctx whose ui has no setStatus (headless stubs, older hosts)", async () => {
		const s = await load();
		const bare = ctxFor({ usage: { contextWindow: 80_000, tokens: null } }).ctx as { ui?: unknown };
		bare.ui = undefined;

		await expect(Promise.resolve(s.hooks.get("context")!({ messages: heavySession() }, bare))).resolves.toBeTruthy();
	});
});

describe.skipIf(!PI_PRESENT)("wire watchdog (folds that never reach the provider)", () => {
	/** Turn usage where the next turn reads the whole pre-fold prompt back from cache. */
	async function foldThenDeferredTurn(s: Awaited<ReturnType<typeof load>>, ctx: unknown) {
		await s.hooks.get("message_end")!(
			{ message: { role: "assistant", usage: { input: 10_000, cacheRead: 30_000, cacheWrite: 0, output: 50 } } },
			ctx,
		);
		await s.hooks.get("context")!({ messages: heavySession() }, ctx); // fold event fires here
		await s.hooks.get("message_end")!(
			{ message: { role: "assistant", usage: { input: 5_000, cacheRead: 41_000, cacheWrite: 0, output: 50 } } },
			ctx,
		);
	}

	it("warns on stderr once per session and raises the status flag", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		const writes: string[] = [];
		const originalWrite = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await foldThenDeferredTurn(s, ctx);
			// A second deferred turn must not warn again.
			await s.hooks.get("message_end")!(
				{ message: { role: "assistant", usage: { input: 5_000, cacheRead: 46_000, cacheWrite: 0, output: 50 } } },
				ctx,
			);
		} finally {
			process.stderr.write = originalWrite;
		}

		const warnings = writes.filter((w) => w.includes("not observed on the wire"));
		expect(warnings.length).toBe(1);

		await s.commands.get("context-fold")!.handler("", ctx);
		expect(notices.join("\n")).toContain("not observed on the wire");
	});

	it("a fold whose next turn shows the prefix rewrite stays quiet", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		await s.hooks.get("message_end")!(
			{ message: { role: "assistant", usage: { input: 10_000, cacheRead: 30_000, cacheWrite: 0, output: 50 } } },
			ctx,
		);
		await s.hooks.get("context")!({ messages: heavySession() }, ctx);
		// Cache read collapses below the pre-fold prompt: the rewrite reached the wire.
		await s.hooks.get("message_end")!(
			{ message: { role: "assistant", usage: { input: 3_000, cacheRead: 12_000, cacheWrite: 25_000, output: 50 } } },
			ctx,
		);

		await s.commands.get("context-fold")!.handler("", ctx);
		expect(notices.join("\n")).not.toContain("not observed on the wire");
	});
});

// ── Compaction lifecycle: count and index record ────────────────────────────────────────────────

describe.skipIf(!PI_PRESENT)("compaction lifecycle events own the count and the index record", () => {
	const prep = () => ({
		messagesToSummarize: heavySession(),
		turnPrefixMessages: [],
		tokensBefore: 40_000,
		firstKeptEntryId: "e9",
	});

	it("attempted-but-failed compactions never trip the advisor's forced-compaction flag", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		// Two attempts, both failing afterwards: the old code counted these as forced compactions.
		for (let i = 0; i < 2; i++) {
			await s.hooks.get("session_before_compact")!({ preparation: prep() }, ctx);
			await s.hooks.get("session_compact_failed")!({ reason: "manual", aborted: true }, ctx);
		}
		await s.commands.get("context-fold")!.handler("", ctx);
		expect(notices.join("\n")).not.toContain("second forced compaction");
	});

	it("completed compactions still count (flag appears after two session_compact events)", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });

		for (let i = 0; i < 2; i++) {
			await s.hooks.get("session_before_compact")!({ preparation: prep() }, ctx);
			await s.hooks.get("session_compact")!({ reason: "threshold", fromExtension: true }, ctx);
		}
		await s.commands.get("context-fold")!.handler("", ctx);
		expect(notices.join("\n")).toContain("second forced compaction");
	});

	it("a failed compaction retracts the premature seed-index compact record", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		// A fold event first, so the index holds one legitimate fold record.
		await s.hooks.get("context")!({ messages: heavySession() }, ctx);

		const { SeedIndexStore } = await import("../src/adapters/pi/index-store");
		const index = new SeedIndexStore(join(dir, "context-fold", "s1"));
		const before = index.readAll();
		expect(before.some((r) => r.trigger === "compact")).toBe(false);

		await s.hooks.get("session_before_compact")!({ preparation: prep() }, ctx);
		expect(index.readAll().some((r) => r.trigger === "compact")).toBe(true);

		await s.hooks.get("session_compact_failed")!({ reason: "threshold", errorMessage: "boom" }, ctx);
		const after = index.readAll();
		expect(after.some((r) => r.trigger === "compact")).toBe(false);
		// The fold record survives the retraction.
		expect(after.length).toBe(before.length);
	});

	it("a compaction that completes keeps its compact record", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		await s.hooks.get("context")!({ messages: heavySession() }, ctx);
		await s.hooks.get("session_before_compact")!({ preparation: prep() }, ctx);
		await s.hooks.get("session_compact")!({ reason: "threshold", fromExtension: true }, ctx);

		const { SeedIndexStore } = await import("../src/adapters/pi/index-store");
		const index = new SeedIndexStore(join(dir, "context-fold", "s1"));
		expect(index.readAll().some((r) => r.trigger === "compact")).toBe(true);
	});

	// The spool-removal claim, asserted at the hook level: a full fold → compact → resume cycle
	// leaves the seed index as the only artifact, under context-fold/<sid>/ — never a spool/ dir.
	it("a fold → compact → resume cycle creates no spool directory", async () => {
		process.env.CONTEXTFOLD_COMPACT = "det";
		const s = await load();
		const messages = heavySession();
		const { ctx } = ctxFor({ usage: { contextWindow: 80_000, tokens: null }, messages });
		await s.hooks.get("session_start")!({}, ctx);
		await s.hooks.get("context")!({ messages }, ctx);
		await s.hooks.get("session_before_compact")!({ preparation: prep() }, ctx);
		await s.hooks.get("session_compact")!({ reason: "threshold", fromExtension: true }, ctx);

		// Resume in a fresh process from the recorded entries.
		const resumed = await load();
		const ledger = s.entries.map((e) => ({ customType: e.customType, data: e.data }));
		const resumedCtx = ctxFor({ entries: ledger, messages, usage: { contextWindow: 80_000, tokens: null } }).ctx;
		await resumed.hooks.get("session_start")!({}, resumedCtx);

		expect(existsSync(join(dir, "spool"))).toBe(false);
		expect(existsSync(join(dir, "context-fold", "s1", "seed-index.jsonl"))).toBe(true);
	});
});

describe.skipIf(!PI_PRESENT)("model_select resets cache telemetry", () => {
	const usage = { input: 5_000, cacheRead: 20_000, cacheWrite: 100, output: 50 };

	it("an actual model change starts a fresh telemetry segment", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		await s.hooks.get("message_end")!({ message: { role: "assistant", usage } }, ctx);

		await s.hooks.get("model_select")!(
			{
				model: { provider: "other", id: "big-model" },
				previousModel: { provider: "test", id: "test-model" },
				source: "set",
			},
			ctx,
		);
		await s.commands.get("context-fold")!.handler("", ctx);
		expect(notices.join("\n")).toContain("cache: no usage yet");
	});

	it("restore and same-model reselection keep the segment", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 80_000, tokens: null } });
		await s.hooks.get("message_end")!({ message: { role: "assistant", usage } }, ctx);

		// Restore fires with a differing previousModel shape on some paths — still no reset.
		await s.hooks.get("model_select")!(
			{ model: { provider: "other", id: "big" }, previousModel: { provider: "test", id: "test-model" }, source: "restore" },
			ctx,
		);
		// Re-selecting the same model is not a change.
		await s.hooks.get("model_select")!(
			{ model: { provider: "test", id: "test-model" }, previousModel: { provider: "test", id: "test-model" }, source: "set" },
			ctx,
		);
		await s.commands.get("context-fold")!.handler("", ctx);
		expect(notices.join("\n")).not.toContain("cache: no usage yet");
	});
});

// ── /fold-handoff command ───────────────────────────────────────────────────────────────────────

describe.skipIf(!PI_PRESENT)("/fold-handoff confirm-then-switch", () => {
	/** Invalidate the old ctx at replacement, as Pi does before withSession. */
	function handoffCtx(opts: { hasUI: boolean; confirmAnswer?: boolean; cancelled?: boolean }) {
		const notices: string[] = [];
		const appended: { role?: string; content?: { type: string; text?: string }[] }[] = [];
		const calls: { parentSession?: string; ranSetup: boolean; ranWithSession: boolean }[] = [];
		const replacementNotices: string[] = [];
		let stale = false;
		const assertLive = () => {
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
		};
		const ctx = {
			hasUI: opts.hasUI,
			sessionManager: {
				getSessionDir: () => dir,
				getSessionId: () => "s1",
				getSessionFile: () => join(dir, "s1.jsonl"),
				getEntries: () => [],
			},
			ui: {
				notify: (m: string) => {
					assertLive();
					notices.push(m);
				},
				...(opts.hasUI ? { confirm: async () => opts.confirmAnswer ?? false } : {}),
			},
			newSession: async (o?: {
				parentSession?: string;
				setup?: (sm: { appendMessage(m: unknown): string }) => Promise<void>;
				withSession?: (c: unknown) => Promise<void>;
			}) => {
				const call = { parentSession: o?.parentSession, ranSetup: false, ranWithSession: false };
				calls.push(call);
				if (opts.cancelled) return { cancelled: true };
				if (o?.setup) {
					call.ranSetup = true;
					await o.setup({
						appendMessage: (m: unknown) => {
							appended.push(m as (typeof appended)[number]);
							return "e1";
						},
					});
				}
				stale = true;
				if (o?.withSession) {
					call.ranWithSession = true;
					// Only notification is available: trying to trigger a model turn fails this test.
					await o.withSession({ ui: { notify: (m: string) => replacementNotices.push(m) } });
				}
				return { cancelled: false };
			},
		};
		const guardedCtx = new Proxy(ctx, {
			get(target, key, receiver) {
				assertLive();
				return Reflect.get(target, key, receiver);
			},
		});
		return { ctx: guardedCtx, notices, replacementNotices, appended, calls };
	}

	it("confirm=yes seeds the replacement session as a persisted user message and stays idle", async () => {
		const s = await load();
		const { ctx, notices, replacementNotices, appended, calls } = handoffCtx({ hasUI: true, confirmAnswer: true });

		await s.commands.get("fold-handoff")!.handler("finish the migration", ctx);

		expect(calls.length).toBe(1);
		expect(calls[0].parentSession).toBe(join(dir, "s1.jsonl"));
		expect(calls[0].ranSetup).toBe(true);
		expect(calls[0].ranWithSession).toBe(true);
		expect(appended.length).toBe(1);
		expect(appended[0].role).toBe("user");
		const text = (appended[0].content ?? []).map((p) => p.text ?? "").join("\n");
		expect(text).toContain("finish the migration");
		expect(text).toContain("extracted verbatim");
		// The seed file is still written for the record.
		expect(existsSync(join(dir, "context-fold", "s1", "handoff-s1.md"))).toBe(true);
		expect(notices).toEqual([]);
		expect(replacementNotices).toHaveLength(1);
		expect(replacementNotices[0]).toContain("Replacement session started");
		expect(text).toBe(readFileSync(join(dir, "context-fold", "s1", "handoff-s1.md"), "utf8"));
	});

	it("a cancelled replacement keeps the old ctx live for the manual flow", async () => {
		const s = await load();
		const { ctx, notices, replacementNotices, appended, calls } = handoffCtx({
			hasUI: true, confirmAnswer: true, cancelled: true,
		});

		await s.commands.get("fold-handoff")!.handler("goal", ctx);

		expect(calls).toHaveLength(1);
		expect(calls[0].ranSetup).toBe(false);
		expect(calls[0].ranWithSession).toBe(false);
		expect(appended).toEqual([]);
		expect(replacementNotices).toEqual([]);
		expect(notices.join("\n")).toContain("cancelled by another extension");
		expect(notices.join("\n")).toContain("/new");
		expect(existsSync(join(dir, "context-fold", "s1", "handoff-s1.md"))).toBe(true);
	});

	it("confirm=no keeps today's write-review-paste flow", async () => {
		const s = await load();
		const { ctx, notices, calls } = handoffCtx({ hasUI: true, confirmAnswer: false });

		await s.commands.get("fold-handoff")!.handler("goal", ctx);

		expect(calls.length).toBe(0);
		expect(existsSync(join(dir, "context-fold", "s1", "handoff-s1.md"))).toBe(true);
		expect(notices.join("\n")).toContain("/new");
	});

	it("headless (no UI) never prompts and never switches", async () => {
		const s = await load();
		const { ctx, calls } = handoffCtx({ hasUI: false });

		await s.commands.get("fold-handoff")!.handler("goal", ctx);

		expect(calls.length).toBe(0);
		expect(existsSync(join(dir, "context-fold", "s1", "handoff-s1.md"))).toBe(true);
	});

	it("a throwing newSession degrades to the manual flow, not a command failure", async () => {
		const s = await load();
		const notices: string[] = [];
		const ctx = {
			hasUI: true,
			sessionManager: {
				getSessionDir: () => dir,
				getSessionId: () => "s1",
				getSessionFile: () => join(dir, "s1.jsonl"),
				getEntries: () => [],
			},
			ui: { notify: (m: string) => notices.push(m), confirm: async () => true },
			newSession: async () => {
				throw new Error("switch exploded");
			},
		};

		await s.commands.get("fold-handoff")!.handler("goal", ctx);

		const all = notices.join("\n");
		expect(all).toContain("falling back to the manual flow");
		expect(all).toContain("/new");
		expect(all).not.toContain("fold-handoff failed");
		expect(existsSync(join(dir, "context-fold", "s1", "handoff-s1.md"))).toBe(true);
	});
});

describe.skipIf(!PI_PRESENT)("pre-request warning wiring", () => {
	it("warns at resume, gates the first prompt, and applies the provider timeout live", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(join(dir, "context-fold.json"), JSON.stringify({ confirmColdPrompt: "on" }));
		const s = await load();
		const { ctx, notices } = ctxFor({ usage: { contextWindow: 200_000, tokens: 85_000 } });
		let draft = "";
		const fullCtx = {
			...ctx, hasUI: true, mode: "tui", isIdle: () => true,
			sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "message", timestamp: new Date(Date.now() - 31 * 60_000).toISOString(), message: {
				role: "assistant", provider: "test", model: "test-model", stopReason: "stop", usage: { input: 85_000, output: 0, cacheRead: 0, cacheWrite: 0 },
			} }] },
			ui: { ...ctx.ui, setEditorText: (text: string) => draft = text, select: async () => "Keep draft" },
		};
		await s.hooks.get("session_start")!({}, fullCtx);
		expect(notices).toContain("cache may have expired: ~85k tok may rebill. Consider /fold-handoff");
		const event = { text: "continue", source: "interactive" };
		expect(await s.hooks.get("input")!(event, fullCtx)).toEqual({ action: "handled" });
		expect(draft).toBe("continue");
		const choices = ["Cache inactivity warning", "Done"];
		const menuCtx = { ...fullCtx, ui: { ...fullCtx.ui,
			select: async (_title: string, options: string[]) => options.find(o => o.startsWith(choices.shift()!)),
			input: async () => "60",
		} };
		await s.commands.get("context-fold")!.handler("config", menuCtx);
		expect(JSON.parse(readFileSync(join(dir, "context-fold.json"), "utf8")).providerCacheIdleMinutes).toEqual({ test: 60 });
		expect(await s.hooks.get("input")!(event, fullCtx)).toEqual({ action: "continue" });
		await s.hooks.get("session_shutdown")!({}, fullCtx);
	});

	it("renders the observed cold notice through the UI instead of stderr", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor();
		const uiCtx = { ...ctx, hasUI: true };
		for (let i = 0; i < 2; i++) await s.hooks.get("message_end")!({ message: { role: "assistant", usage: { input: 40_000, cacheRead: 0, cacheWrite: 0 } } }, uiCtx);
		await s.hooks.get("agent_settled")!({}, uiCtx);
		expect(notices).toContain("session cold: rebilled ~40k tok as fresh input. Consider /fold-handoff");
	});
});

describe.skipIf(!PI_PRESENT)("/context-fold menu", () => {
	it("opens settings without arguments and persists an edit", async () => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const s = await load();
		const { ctx, notices } = ctxFor();
		const choices = ["Settings", "Protected tail", "Done"];
		const menus: string[][] = [];
		await s.commands.get("context-fold")!.handler("", {
			...ctx, hasUI: true, isIdle: () => true,
			ui: { ...ctx.ui,
				select: async (_title: string, options: string[]) => {
					menus.push(options);
					const choice = choices.shift();
					return options.find(option => option.startsWith(choice!));
				},
				input: async () => "5000",
			},
		});
		expect(menus[0]).toEqual(["Status", "Settings", "Discard retained images", "Close"]);
		expect(JSON.parse(readFileSync(join(dir, "context-fold.json"), "utf8"))).toEqual({ tail: 5000 });
		expect(notices.join("\n")).toContain("Protected tail → 5000 (applied)");
	});

	it.each(["Status", "Discard retained images"])("routes %s to its existing action", async choice => {
		const s = await load();
		const { ctx, notices } = ctxFor();
		await s.commands.get("context-fold")!.handler("", {
			...ctx, hasUI: true, ui: { ...ctx.ui, select: async () => choice },
		});
		expect(notices.join("\n")).toContain(choice === "Status" ? "no usage yet" : "Retained draft images discarded.");
	});

	it.each([undefined, "Close"])("does nothing when the menu is dismissed (%s)", async choice => {
		const s = await load();
		const { ctx, notices } = ctxFor();
		await s.commands.get("context-fold")!.handler("", {
			...ctx, hasUI: true, ui: { ...ctx.ui, select: async () => choice },
		});
		expect(notices).toEqual([]);
	});

	it.each([{ args: "status", hasUI: true }, { args: "", hasUI: false }])("keeps direct status/headless use out of the menu ($args, $hasUI)", async ({ args, hasUI }) => {
		const s = await load();
		const { ctx, notices } = ctxFor();
		let selected = false;
		await s.commands.get("context-fold")!.handler(args, {
			...ctx, hasUI, ui: { ...ctx.ui, select: async () => { selected = true; return "Close"; } },
		});
		expect(selected).toBe(false);
		expect(notices.join("\n")).toContain("no usage yet");
	});

	it("falls back to status when the selector fails", async () => {
		const s = await load();
		const { ctx, notices } = ctxFor();
		await s.commands.get("context-fold")!.handler("", {
			...ctx, hasUI: true, ui: { ...ctx.ui, select: async () => { throw new Error("selector unavailable"); } },
		});
		expect(notices.join("\n")).toContain("selector unavailable");
		expect(notices.join("\n")).toContain("no usage yet");
	});
});
