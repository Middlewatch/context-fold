/*
 * compact.ts — the deterministic hard-compaction summary (CONTEXTFOLD_COMPACT=det, the default).
 *
 * When Pi's hard compaction fires, the default path would have an LLM rewrite history — the one
 * mechanism the evidence base indicts (fabricated instructions, artifact-trail loss, laundered
 * failure signals). Instead we hand Pi a summary RENDERED VERBATIM from the seed index: files,
 * commands, error lines, exact identifiers, user intents, and recovery pointers. No model call,
 * no paraphrase, nothing that can hallucinate — and everything it lists is a lexical hook the
 * agent can pull back through `recall` (Pi's append-only session file keeps every raw payload).
 *
 * Pure rendering: no Pi imports, no disk, no clock. Fully unit-testable.
 */
import type { SeedIndexRecord } from "../../core/index/seed-index";

const CAP_USER = 12;
const CAP_FILES = 40;
const CAP_COMMANDS = 24;
const CAP_ERRORS = 24;
const CAP_IDENTIFIERS = 80;
const CAP_SPANS = 30;

export interface DetCompactionInput {
	records: SeedIndexRecord[];
	/** The session's JSONL file — the append-only ledger holding every raw payload (named so the
	 *  agent can grep it directly if tools allow). */
	sessionFilePath?: string;
}

export function renderDetCompactionSummary(input: DetCompactionInput): string {
	const { records } = input;
	const userMessages = dedupBy(
		records.flatMap((r) => r.userMessages),
		(u) => `${u.turn}:${u.firstLine}`,
	).slice(-CAP_USER);
	const files = union(records, (r) => r.files, CAP_FILES);
	const commands = union(records, (r) => r.commands, CAP_COMMANDS);
	const errors = union(records, (r) => r.errors, CAP_ERRORS);
	const identifiers = union(records, (r) => r.identifiers, CAP_IDENTIFIERS);
	const spans = dedupBy(
		records.flatMap((r) => r.spans),
		(s) => s.blockId,
	).slice(-CAP_SPANS);

	const parts: string[] = [
		"# Compaction summary (deterministic seed index — no model involved)",
		"",
		"Everything below is extracted VERBATIM from the session; nothing is paraphrased.",
		"Full history is preserved on disk. To recover detail: `recall_folded search=<term>` sweeps every",
		"folded block in one call; `recall_folded <code>` / `recall_folded <code> lines=<a-b>` pulls a specific one.",
		`Ground truth: the session ledger${input.sessionFilePath ? ` at ${input.sessionFilePath}` : ""}`,
	];

	if (userMessages.length) {
		parts.push("", "## User intents (first lines, in order)");
		for (const u of userMessages) parts.push(`- [turn ${u.turn}] ${u.firstLine}`);
	}
	if (files.length) parts.push("", "## Files touched", listed(files));
	if (commands.length) {
		parts.push("", "## Commands run");
		for (const c of commands) parts.push(`- \`${c}\``);
	}
	if (errors.length) {
		parts.push("", "## Error lines observed (verbatim)");
		for (const e of errors) parts.push(`- ${e}`);
	}
	if (identifiers.length) parts.push("", "## Exact identifiers (grep keys for recall_folded)", listed(identifiers));
	if (spans.length) {
		parts.push("", "## Recovery pointers");
		for (const s of spans) parts.push(`- {#${s.code ?? "?"} FOLDED} ${s.tool ?? "?"} · turn ${s.turn} · ${s.log.lines} lines`);
	}
	return parts.join("\n");
}

/**
 * Union a field across records, keeping the `cap` values seen most recently.
 *
 * Order is LAST-seen, not first-seen: re-encountering a value moves it to the end. That matters
 * because the tail is what survives the cap — a value that recurs in every record is exactly the
 * load-bearing one, and ordering by first sighting would drop it in favour of a one-off from the
 * final record.
 */
function union(records: SeedIndexRecord[], pick: (r: SeedIndexRecord) => string[], cap: number): string[] {
	const seen = new Set<string>();
	for (const r of records) {
		for (const v of pick(r)) {
			seen.delete(v); // re-sighting refreshes position; Set preserves insertion order
			seen.add(v);
		}
	}
	return [...seen].slice(-cap);
}

/** Dedup by key, keeping the newest value per key in first-sighting (chronological) order. */
function dedupBy<T>(items: T[], key: (t: T) => string): T[] {
	const seen = new Map<string, T>();
	for (const it of items) seen.set(key(it), it);
	return [...seen.values()];
}

function listed(items: string[]): string {
	return items.map((f) => `\`${f}\``).join(" · ");
}
