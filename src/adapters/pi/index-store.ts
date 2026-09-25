/*
 * index-store.ts — seed-index emission at fold events (docs/SEED_INDEX_SPEC.md).
 *
 * On every fold event the adapter (1) appends one `kind:"fold"` record per masked block to the
 * session ledger — the durable recall route: Pi's append-only session file keeps the raw payload,
 * and the record carries the sha256 that lets recall verify what it re-locates there — and
 * (2) appends one deterministic index record to `seed-index.jsonl`. The JSONL is append-only and
 * IS the persistence: resume just keeps appending under later seqs, and `latest record per seq
 * wins` is the consumer contract.
 *
 * The caller treats successful fold-record + index emission as a fold commit precondition. A
 * failure keeps that turn raw rather than creating an unrecallable frozen layer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractIndex, extractCompactionIndex, buildIndexRecord, type IndexSpan, type SeedIndexRecord } from "../../core/index/seed-index";
import { foldCode, wireFoldable } from "../../core/digest";
import { isDurableId, type WireBlock } from "../../core/block";
import type { FoldEventReport } from "./store";
import { sha256Hex } from "./ledger";
import type { FoldEntry, MapFoldRegistry } from "../../core/fold-registry";

const INDEX_FILENAME = "seed-index.jsonl";
const INDEX_HARNESS = "pi-context-fold";

/** A retraction line: voids fold-index records with this seq that appear EARLIER in the file.
 *  Appended when Pi reports `session_compact_failed` after a compact record was already emitted —
 *  the compaction never happened, so its recovery map must not shadow later summaries. The JSONL
 *  stays append-only; a later record may legitimately reuse the seq (latest-per-seq wins). */
interface RetractRecord {
	v: number;
	kind: "fold-retract";
	seq: number;
	at: string;
}

function foldEntryFor(b: WireBlock, code: string): FoldEntry {
	return {
		blockId: b.id,
		code,
		tool: b.toolName ?? b.kind,
		isError: b.isError ?? false,
		bytes: Buffer.byteLength(b.text, "utf8"),
		sha256: sha256Hex(b.text),
		fullOutputPath: b.fullOutputPath,
	};
}

function spanFor(b: WireBlock, entry: FoldEntry): IndexSpan {
	return {
		blockId: b.id,
		code: entry.code,
		tool: entry.tool,
		turn: b.turn,
		log: { bytes: entry.bytes, lines: countLines(b.text) },
		sha256: entry.sha256,
		fullOutputPath: entry.fullOutputPath,
	};
}

/** code → owning blockId across the registry: the fold-code collision check. The code space is
 *  `hash mod 36^6`, so two durable ids CAN rarely share a code; the second id must never claim
 *  the first one's handle. */
function codeOwners(registry: MapFoldRegistry): Map<string, string> {
	const owners = new Map<string, string>();
	for (const e of registry.entries()) owners.set(e.code, e.blockId);
	return owners;
}

export class SeedIndexStore {
	private ensured = false;
	constructor(private readonly dir: string) {}

	get path(): string {
		return join(this.dir, INDEX_FILENAME);
	}

	append(record: SeedIndexRecord): void {
		if (!this.ensured) {
			mkdirSync(dirname(this.path), { recursive: true });
			this.ensured = true;
		}
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}

	/** Void earlier fold-index records carrying `seq` (see RetractRecord). */
	appendRetraction(seq: number, now?: number): void {
		const rec: RetractRecord = { v: 2, kind: "fold-retract", seq, at: new Date(now ?? Date.now()).toISOString() };
		if (!this.ensured) {
			mkdirSync(dirname(this.path), { recursive: true });
			this.ensured = true;
		}
		appendFileSync(this.path, `${JSON.stringify(rec)}\n`, "utf8");
	}

	/** All effective records, file order: junk lines and unknown higher versions are tolerated,
	 *  and a fold-retract line drops the fold-index records with its seq appended before it. */
	readAll(): SeedIndexRecord[] {
		if (!existsSync(this.path)) return [];
		let out: SeedIndexRecord[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const rec = JSON.parse(t) as SeedIndexRecord | RetractRecord;
				if (rec && rec.kind === "fold-index" && Array.isArray((rec as SeedIndexRecord).spans)) out.push(rec as SeedIndexRecord);
				else if (rec && rec.kind === "fold-retract" && typeof rec.seq === "number") out = out.filter((r) => r.seq !== rec.seq);
			} catch {
				/* junk line — skip */
			}
		}
		return out;
	}
}

/**
 * Handle one engine fold event: record each masked block's fold entry, build spans, extract index
 * fields, and append the record. A block may already own a fold entry (restored at resume,
 * recorded at compaction, or by an earlier event); reuse it rather than re-recording. A fold-code
 * collision drops only that block, reported via `droppedIds` so the engine leaves it raw and
 * holds it. Deterministic except for `now`.
 */
export function emitFoldIndex(
	event: FoldEventReport,
	deps: {
		registry: MapFoldRegistry;
		index: SeedIndexStore;
		sessionId: string;
		now?: number;
		/** Durably append each new fold entry to the session ledger before it becomes visible in
		 *  the in-memory registry. A throw rejects the whole event (the turn goes out raw). */
		persistEntry?: (entry: FoldEntry) => void;
	},
): { record: SeedIndexRecord; newEntries: FoldEntry[]; droppedIds: string[] } {
	const byId = new Map(event.blocks.map((b) => [b.id, b] as const));
	const masked: WireBlock[] = [];
	for (const id of event.maskedIds) {
		const b = byId.get(id);
		if (b) masked.push(b);
	}

	const owners = codeOwners(deps.registry);
	const spans: IndexSpan[] = [];
	const newEntries: FoldEntry[] = [];
	/** Blocks whose fold entry is settled — the only ones the record may claim as masked. */
	const recorded: WireBlock[] = [];
	const droppedIds: string[] = [];
	for (const b of masked) {
		const existing = deps.registry.get(b.id);
		if (existing) {
			spans.push(spanFor(b, existing));
			recorded.push(b);
			continue;
		}
		const code = foldCode(b.id);
		const owner = owners.get(code);
		if (owner !== undefined && owner !== b.id) {
			// Fold-code collision: permanent for this id. Fail open per block — drop the collider
			// from the event and fold the rest; one unlucky hash must never end folding for the
			// session.
			droppedIds.push(b.id);
			continue;
		}
		const entry = foldEntryFor(b, code);
		owners.set(code, b.id);
		spans.push(spanFor(b, entry));
		// Stage the registry entry; publish it only after record + index are durably appended.
		newEntries.push(entry);
		recorded.push(b);
	}

	const record = buildIndexRecord(
		{
			harness: INDEX_HARNESS,
			session: deps.sessionId,
			seq: event.seq,
			at: new Date(deps.now ?? Date.now()).toISOString(),
			trigger: event.trigger,
			usage: {
				tokens: Math.round(event.usage.tokens),
				contextWindow: event.usage.contextWindow,
				fraction: Math.round(event.usage.fraction * 1000) / 1000,
			},
		},
		// Extraction covers only the recorded blocks: a dropped collider stays raw in the live
		// view, so nothing of it is leaving history and nothing of it needs indexing.
		extractIndex({ masked: recorded, all: event.blocks }),
		spans,
	);
	// Fold records first, index second: the index is the consumer-facing artifact, so a partial
	// failure must never leave it advertising spans whose fold records were not durably appended.
	// (Fold records without an index record are harmless — the registry is not published and the
	// turn goes out raw.) Either append throwing rejects the whole event.
	for (const entry of newEntries) deps.persistEntry?.(entry);
	deps.index.append(record);
	for (const entry of newEntries) deps.registry.set(entry);
	return { record, newEntries, droppedIds };
}

/**
 * Record-at-compaction: register every foldable, durable, not-yet-recorded block that is about to
 * leave live history, so recall covers the ENTIRE compacted span rather than only the blocks a
 * fold event happened to reach first (a result inside the protected tail at compaction time, or
 * a session compacted before its first fold, would otherwise leave no recall route). Runs before
 * `emitCompactIndex` so the new entries carry recovery spans in the compact record. No content is
 * copied anywhere — the entry just names the block in Pi's own ledger.
 *
 * Per-block fail-open: an unrecordable block (code collision, persistence throw) just isn't
 * recallable afterwards — Pi's session JSONL still keeps it — and compaction itself never fails
 * over recording.
 */
export function recordCompactedBlocks(
	blocks: WireBlock[],
	deps: {
		registry: MapFoldRegistry;
		/** Durably append each new fold entry so the recall route survives resume. */
		persistEntry?: (entry: FoldEntry) => void;
	},
): { added: FoldEntry[]; skippedIds: string[] } {
	const owners = codeOwners(deps.registry);
	const added: FoldEntry[] = [];
	const skippedIds: string[] = [];
	for (const b of blocks) {
		if (!wireFoldable(b) || !isDurableId(b.id) || !b.text || deps.registry.has(b.id)) continue;
		const code = foldCode(b.id);
		const owner = owners.get(code);
		if (owner !== undefined && owner !== b.id) {
			skippedIds.push(b.id);
			continue;
		}
		const entry = foldEntryFor(b, code);
		try {
			deps.persistEntry?.(entry);
		} catch {
			skippedIds.push(b.id);
			continue;
		}
		owners.set(code, b.id);
		deps.registry.set(entry);
		added.push(entry);
	}
	return { added, skippedIds };
}

/**
 * Emit the FINAL index record at hard compaction: the whole span being summarized is about to
 * leave live history, so index it all (Pi's session JSONL keeps the raw entries; recorded blocks
 * additionally carry recovery spans here). Returns the record for the det-summary renderer.
 */
export function emitCompactIndex(
	blocks: WireBlock[],
	deps: {
		registry: MapFoldRegistry;
		index: SeedIndexStore;
		sessionId: string;
		tokensBefore: number;
		contextWindow: number | null;
		now?: number;
	},
): SeedIndexRecord {
	const masked = blocks.filter((b) => b.kind !== "user");
	const spans: IndexSpan[] = [];
	for (const b of masked) {
		const e = deps.registry.get(b.id);
		if (!e) continue;
		spans.push(spanFor(b, e));
	}
	const seq = deps.index.readAll().reduce((m, r) => Math.max(m, r.seq), 0) + 1;
	const cw = deps.contextWindow ?? 0;
	const record = buildIndexRecord(
		{
			harness: INDEX_HARNESS,
			session: deps.sessionId,
			seq,
			at: new Date(deps.now ?? Date.now()).toISOString(),
			trigger: "compact",
			usage: {
				tokens: deps.tokensBefore,
				contextWindow: cw,
				fraction: cw > 0 ? Math.round((deps.tokensBefore / cw) * 1000) / 1000 : 0,
			},
		},
		extractCompactionIndex(blocks),
		spans,
	);
	deps.index.append(record);
	return record;
}

function countLines(s: string): number {
	if (!s) return 0;
	let n = 1;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}
