/*
 * handoff.ts — `/fold-handoff`: write a seed for starting a fresh session.
 *
 * The seed is the deterministic index (same renderer as det compaction) plus the goal the user
 * stated on the command line. No model is called: everything in the file is extracted verbatim
 * from the session, so there is nothing in it that can be a paraphrase or a fabrication.
 *
 * The seed is WRITTEN TO DISK in the session directory first, always. Interactively, one confirm
 * then offers to start the replacement session directly: `ctx.newSession` injects the seed as a
 * persisted user message and the new session lands IDLE — no kickoff turn, no tokens spent until
 * the user acts. Declining (or running headless) keeps the write-review-paste flow.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDetCompactionSummary } from "./compact";
import type { SeedIndexStore } from "./index-store";

const PREAMBLE = [
	"> Everything below is extracted verbatim from the session — no model wrote any of it, so",
	"> exact identifiers, paths, commands, and error strings are preserved as they appeared.",
	"> Fold codes below are provenance from the parent session, not live handles here: full",
	"> content lives in the parent session file named above and in the seed index beside it.",
].join("\n");

/** Assemble the handoff seed (pure). The parent session file is the seed's ground truth: fold
 *  codes in the body resolve against THAT ledger, not the new session's. */
export function buildHandoffSeed(opts: { goal: string; indexBody: string; at: string; parentSessionPath?: string }): string {
	return [
		`# Session handoff seed — ${opts.at}`,
		...(opts.parentSessionPath ? [`Parent session: ${opts.parentSessionPath}`] : []),
		"",
		PREAMBLE,
		"",
		"## Goal for the next session",
		opts.goal.trim() || "(not stated — set one before starting the new session)",
		"",
		opts.indexBody,
	].join("\n");
}

interface HandoffCtx {
	hasUI?: boolean;
	cwd?: string;
	ui?: {
		notify?(msg: string, level?: string): void;
		confirm?(title: string, message: string): Promise<boolean>;
	};
	sessionManager: {
		getSessionDir(): string;
		getSessionId(): string;
		getSessionFile?(): string | undefined;
	};
	newSession?(options?: {
		parentSession?: string;
		setup?(sessionManager: { appendMessage(message: unknown): string }): Promise<void>;
		withSession?(ctx: Pick<HandoffCtx, "ui">): Promise<void>;
	}): Promise<{ cancelled: boolean }>;
}

export function registerHandoffCommand(
	pi: ExtensionAPI,
	deps: { indexFor(ctx: HandoffCtx): SeedIndexStore; seedDirFor(ctx: HandoffCtx): string },
): void {
	pi.registerCommand("fold-handoff", {
		description:
			"Write a handoff seed for a fresh session, rendered verbatim from the deterministic seed index. Usage: /fold-handoff <goal for the next session>",
		handler: async (args, cmdCtx) => {
			const ctx = cmdCtx as unknown as HandoffCtx;
			const notify = (msg: string, level = "info") => ctx.ui?.notify?.(msg, level);
			try {
				const indexBody = renderDetCompactionSummary({
					records: deps.indexFor(ctx).readAll(),
					sessionFilePath: ctx.sessionManager.getSessionFile?.(),
				});
				const seed = buildHandoffSeed({
					goal: typeof args === "string" ? args : "",
					indexBody,
					at: new Date().toISOString(),
					parentSessionPath: ctx.sessionManager.getSessionFile?.(),
				});
				const seedDir = deps.seedDirFor(ctx);
				mkdirSync(seedDir, { recursive: true });
				const out = join(seedDir, `handoff-${ctx.sessionManager.getSessionId()}.md`);
				writeFileSync(out, seed, "utf8");

				// Confirm-then-switch (interactive only): the seed file above is the reviewable record
				// either way, and every ctx capability is optional — an older Pi or a headless run
				// simply keeps the manual flow.
				if (ctx.hasUI && ctx.ui?.confirm && ctx.newSession) {
					const go = await ctx.ui.confirm(
						"fold-handoff",
						`Seed written to ${out}.\nStart the replacement session now? It opens idle with the seed as its first user message.`,
					);
					if (go) {
						// The seed file is already safe on disk, so a switch failure must degrade to the
						// manual flow below rather than reporting the whole command as failed.
						try {
							const parentSession = ctx.sessionManager.getSessionFile?.();
							const result = await ctx.newSession({
								parentSession,
								// Seeded and idle: a persisted user message only — nothing triggers a turn.
								setup: async (sm) => {
									sm.appendMessage({
										role: "user",
										content: [{ type: "text", text: seed }],
										timestamp: Date.now(),
									});
								},
								withSession: async (replacementCtx) => {
									replacementCtx.ui?.notify?.(
										`handoff seed written: ${out}\nReplacement session started with the seed in context. State your first instruction there.`,
										"info",
									);
								},
							});
							// Successful replacement invalidates the original ctx, including its UI.
							if (!result.cancelled) return;
							notify("replacement session was cancelled by another extension — falling back to the manual flow", "warning");
						} catch (err) {
							notify(
								`starting the replacement session failed (${err instanceof Error ? err.message : String(err)}) — falling back to the manual flow`,
								"warning",
							);
						}
					}
				}
				notify(`handoff seed written: ${out}\nReview it, start a fresh session (/new), and paste or reference it there.`, "info");
			} catch (err) {
				notify(`fold-handoff failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
