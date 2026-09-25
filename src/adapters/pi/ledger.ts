/*
 * ledger.ts — the ledger read route behind recall.
 *
 * Pi's session is append-only ("Entries cannot be modified or deleted" — SessionManager docs),
 * so the raw payload of every folded block survives hard compaction and resume in
 * `sessionManager.getEntries()`. Recall re-locates a block by re-linearizing the ledger's
 * message entries with the same durable-id formula that named it at fold time, then verifies
 * the text against the sha256 the fold recorded. No copy of the content is kept anywhere else.
 *
 * Linearization is cached and invalidated by entry count — appends are the only mutation the
 * ledger permits, so a stable count means a stable block map.
 */
import { createHash } from "node:crypto";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { linearize, type AgentMessage, type WireBlock } from "../../core/block";

export function sha256Hex(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Fields needed to identify originals and their append-only content replacements. */
export interface LedgerEntryLike {
	type?: string;
	id?: string;
	message?: unknown;
	targetId?: string;
	replacement?: { content: unknown } | null;
}

/** What the engine needs from the ledger: durable block id → the block's full text. */
export interface LedgerLookup {
	blockById(id: string): { text: string } | undefined;
}

/** An edit is a new immutable content revision; original IDs and handles keep their meaning. */
function revisionId(id: string, editId: string): string {
	return `${id}:edit:${editId}`;
}

function editedMessages(source: LedgerEntryLike, edit?: LedgerEntryLike): AgentMessage[] {
	if (source.type === "message" && (!source.message || typeof source.message !== "object")) return [];
	const messages = sessionEntryToContextMessages(source as SessionEntry) as AgentMessage[];
	if (!edit) return messages;
	if (edit.replacement === null) return [];
	if (!edit.replacement) return messages;
	const replacement = edit.replacement.content;
	return messages.map(message => {
		const content = (message.role === "assistant" || message.role === "toolResult") && typeof replacement === "string"
			? [{ type: "text", text: replacement }]
			: replacement;
		return { ...message, content } as AgentMessage;
	});
}

function latestEdits(entries: readonly LedgerEntryLike[]): Map<string, LedgerEntryLike> {
	const edits = new Map<string, LedgerEntryLike>();
	for (const e of entries) if (e.type === "context_edit" && e.targetId) edits.set(e.targetId, e);
	return edits;
}

/** Only edits on the active branch can name the revision in a request or automatic summary. */
export function contextRevisions(branch: readonly LedgerEntryLike[]): Map<string, string> {
	const edits = latestEdits(branch);
	const revisions = new Map<string, string>();
	for (const source of branch) {
		const edit = source.id ? edits.get(source.id) : undefined;
		if (!edit?.id || !edit.replacement) continue;
		for (const b of linearize(editedMessages(source, edit))) revisions.set(b.id, revisionId(b.id, edit.id));
	}
	return revisions;
}

export function reviseBlocks(blocks: WireBlock[], revisions: ReadonlyMap<string, string>): WireBlock[] {
	return blocks.map(b => {
		const id = revisions.get(b.id);
		// A replacement's content is not the original tool's full-output file.
		return id ? { ...b, id, fullOutputPath: undefined } : b;
	});
}

/** Re-extract historical evidence from the active branch, including earlier compacted spans.
 * Historical indexes and summaries cannot be filtered reliably after content edits. */
export function compactionHistory(branch: readonly LedgerEntryLike[], firstKeptEntryId: string): WireBlock[] | undefined {
	const end = branch.findIndex(e => e.id === firstKeptEntryId);
	if (end < 0) return;
	const edits = latestEdits(branch);
	const messages: AgentMessage[] = [];
	for (const source of branch.slice(0, end)) {
		if (source.type === "compaction") continue;
		messages.push(...editedMessages(source, source.id ? edits.get(source.id) : undefined));
	}
	return reviseBlocks(linearize(messages), contextRevisions(branch));
}

export class LedgerReader implements LedgerLookup {
	private cache: { count: number; byId: Map<string, WireBlock> } | null = null;

	constructor(private readonly getEntries: () => LedgerEntryLike[]) {}

	blockById(id: string): WireBlock | undefined {
		const entries = this.getEntries();
		if (!this.cache || this.cache.count !== entries.length) {
			const messages: AgentMessage[] = [];
			for (const e of entries) messages.push(...editedMessages(e));
			// Latest-per-id wins (a retried tool call re-records under the same durable id); the
			// Map insertion order of linearize is chronological, so later entries overwrite.
			const byId = new Map<string, WireBlock>();
			for (const b of linearize(messages)) byId.set(b.id, b);
			const sources = new Map(entries.filter(e => e.id).map(e => [e.id!, e]));
			for (const edit of entries) {
				if (edit.type !== "context_edit" || !edit.id || !edit.targetId || !edit.replacement) continue;
				const source = sources.get(edit.targetId);
				if (!source) continue;
				for (const b of linearize(editedMessages(source, edit))) {
					const id = revisionId(b.id, edit.id);
					byId.set(id, { ...b, id, fullOutputPath: undefined });
				}
			}
			this.cache = { count: entries.length, byId };
		}
		return this.cache.byId.get(id);
	}
}
