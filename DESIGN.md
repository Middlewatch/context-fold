# context-fold architecture

This file describes the current implementation for contributors: its structure, invariants, and
the reasoning behind them. `README.md` is the user-facing document.

## 1. Core idea

The design was derived independently but ends up close to native Claude Code compaction. I have
not stress-tested Anthropic models extensively inside Pi, so treat any comparison between the two
as untested.

1. **Avoid Destructive Editing.** A folded block stays in the outgoing
   message array and keeps its `callId`. Only its rendered content is swapped, and the message
   count never moves. A `tool_call`/`tool_result` pair therefore cannot orphan. This both
   preserves the stable prefix and retains proper history.

2. **Reversible by default.** Every folded block carries a deterministic `{#<code> FOLDED}` tag.
   The agent reads the code and calls `recall_folded`/`unfold` to get the original back.

3. **Protected working tail.** The newest ~N tokens never fold, so recent reasoning stays at full
   fidelity. The tail is never empty, because the newest block is always protected.

The session file is never modified.

---

## 2. Layout: pure core, thin adapter

```
src/
  core/                    # pure and testable; no Pi dependencies, clock, randomness, or I/O
    tokens.ts              # estTokens = ceil(len/4), BLOCK_OVERHEAD, clip, firstLine, safeSlice
    digest.ts              # the {#code FOLDED} tag, foldCode (FNV-1a), per-kind digests
    contract.ts            # PolicyView / FoldCommand / ViewBlock
    block.ts               # the WireBlock model, linearize(), blockId(), isDurableId()
    apply.ts               # applyPlan(messages, ops)
    fold-registry.ts       # folded block id → code, extent, fold-time sha256
    index/seed-index.ts    # deterministic extraction of the seed index record
    policy/
      fold-ladder.ts       # the shipped fold policy
      ledger.ts            # the error/risk lexicon
  adapters/pi/             # every Pi API call and all disk I/O
    index.ts               # the extension entry point: hooks, tools, commands
    store.ts               # the engine
    ledger.ts              # the ledger read route: re-locate a block in getEntries(), sha verify
    index-store.ts         # seed-index.jsonl emission
    persistence.ts         # event-sourced fold state
    compact.ts             # the deterministic hard-compaction summary
    handoff.ts             # /fold-handoff: writes a deterministic seed for a fresh session
    advisor.ts             # observed cold input and the reset yellow flag
    cache-warning.ts       # idle/resume cache-risk notices and opt-in input confirmation
    cache-telemetry.ts     # measured cacheRead/cacheWrite accounting
    unfold-tool.ts         # the recall_folded / unfold tools
    config.ts              # the knob table: defaults < saved settings < CONTEXTFOLD_* env
    settings.ts            # saved settings and the Settings submenu of /context-fold
```

The core speaks only its own `AgentMessage`-shaped block model and a
`conduct(view) → FoldCommand[]` policy interface. The Pi adapter converts Pi's `AgentMessage[]`
to and from core blocks and owns every Pi API call. Context-fold serves Pi only (ADR 0001), so
this boundary separates pure code from effects rather than providing a porting seam. The core
stays free of clock, randomness, and I/O to keep deterministic, reversible folding testable.

**Policy/mechanism split:** `policy/fold-ladder.ts` is the policy and decides what and when to
fold. `apply.ts` is the mechanism. It performs the rewrite and has no opinion about timing.
Keeping them apart is what lets fold timing change without touching the rewrite.

---

## 3. The per-turn pipeline

Pi's `context` hook fires before every model call with a deep copy of the outgoing
`AgentMessage[]`. Pi sends the returned array. Each turn follows this pipeline:

```
on "context" (messages, ctx):
  blocks   = linearize(messages)                  # provider messages → typed Block[]
  frozen   = computeFrozenOps(blocks)             # committed layer bytes (every turn)
  view     = buildView(blocks, protect, budget, …)
  cmds     = policy.conduct(view)                 # the fold ladder; [] = nothing to do
  ops      = lower(cmds, blocks, protect)         # FoldCommand[] → FoldOp[]
  commit(ops)                                     # freeze as a layer, emit the seed index
  return applyPlan(messages, merge(frozen, ops))
```

Frozen bytes outrank any late policy op for the same id.

---

## 4. Why discrete fold events

Between fold events the context is append-only. Any mutation of history moves bytes and
invalidates the provider's prompt-cache suffix, so masking is batched at chosen boundaries where
that invalidation is paid once, and each event's substitutions are committed as a frozen layer
whose bytes never change again. The head of the context therefore stays byte-identical turn over
turn, which is what keeps prefix caches warm.

A fold event fires when both hold: usage is past the first-fold threshold (by default at 45 % of
the window, or 25 % when telemetry shows the session has never had a live cache read), and the
maskable mass is worth at least one ladder step (~12 % of the window). Crossing the budget cap is
an urgent event regardless of ladder position.

A transport that holds the conversation itself pauses the ladder. Every response from such a
transport books the whole prompt as cache read with nothing prefilled, where a stateless API
prefills at least the new message every turn. The adapter measures that from two usage reports and
feeds the policy a flag, the same way it feeds the cold branch; while it holds, a fold would rewrite
a copy the model never receives, so even the cap branch stays quiet.

Tool results after the latest assistant response are first-delivery results. That assistant issued
their calls, and no provider request has received their output yet. They are held regardless of
tail size or budget pressure. Parallel results are held together. Once a later assistant response
exists, they become ordinary ladder candidates.

Only an explicit `unfold` releases a committed layer. The engine never decides to re-plan one. An
unfold deliberately breaks and re-prefills the prefix once, and later turns keep that raw block
byte-identical.

Layers accumulate for the life of the session. Nothing scans them per turn. The engine keeps a
flat `id → digestText` map and the newest seq, so there is no bound to enforce and no reason to
merge them.

---

## 5. Ledger-backed recovery

Fresh tool results always reach the model at full fidelity. The durability floor behind every
fold is Pi's own session ledger: the session file is append-only ("Entries cannot be modified or
deleted", per `SessionManager`), so the raw payload of a folded block survives hard compaction,
resume, and re-compaction in `sessionManager.getEntries()`. When the ladder commits a fold, the
adapter records per masked block a fold entry naming its durable id, its `{#code FOLDED}` handle,
its byte extent, and a sha256 of the block text at fold time. No copy of the content is written
anywhere.

`recall_folded` re-locates the block by re-linearizing the ledger's message entries with the same
durable-id formula that named it, verifies the text against the recorded sha256, and serves it
whole or through bounded grep/line slices. `unfold` restores the live block on the next turn.
Linearization is cached per session and invalidated by entry count, so recall does not re-walk
the file on every call. When the persisted message's `details` name a tool-owned full-output file
(a truncated bash result), grep and line recalls prefer that file over the truncated content and
fall back to the ledger text when it is gone. A block the ledger cannot serve, or whose text
fails the sha check, produces a typed error naming the code. If the block is still live in raw
history, recall serves it from the snapshot instead, through the same caps.

One documented edge follows from verifying against the ledger: the fold-time sha is computed over
the text the `context` hook saw, and Pi chains context transforms, so a block another extension
rewrote before folding diverges from the raw persisted bytes. While the block is live, recall
serves it from the snapshot with a warning; once it leaves history, recall reports the sha
mismatch as a typed error rather than serving bytes the model never saw as if they were the
folded view. Pi's session file still holds the raw payload either way.

The fold record and seed-index record are commit preconditions. The engine prepares a layer, the
adapter appends both records durably, and only then does the engine freeze and apply its bytes. A
durability failure (record, index, or layer persistence) rejects the entire event and sends that
turn raw. A fold-code collision is the one per-block exception. The code space is
`hash mod 36^6`, so two durable ids can rarely share a code, and the collision is a permanent
condition for the second id. That block alone is dropped from the event, held raw for the
session, and announced on stderr, while the rest of the event commits. At hard compaction, every
foldable block leaving live history that never folded gets a code and a fold record then
(per-block fail-open), so the recall route covers the entire compacted span rather than only the
blocks earlier fold events reached.

## 6. Fold-state persistence

Fold entries, agent unfold decisions, and committed layers are event-sourced as custom entries
(`contextfold.fold`) and replayed on `session_start`. Legacy `kind:"spool"`/`kind:"gate"` records
(from sessions created before the spool's removal) degrade to fold entries without a fold-time
sha256: recall serves them from the ledger unverified and says so, and a block absent from the
ledger reports unavailable. Neither case crashes or silently increases the token count.

The extension's own on-disk artifacts, the seed index and handoff seeds, live in
`<sessionDir>/context-fold/<sessionId>/`. They are append-only text measured in kilobytes and
retained like Pi's own session files, with no garbage collection.

---

## 7. Failure posture

Every hook is fail-open with a bounded blast radius. Folding degradations are announced on stderr,
and cache-advisory failures use Pi's notification UI when available. A failed notification sink
cannot prevent the turn.

| failure | cost |
|---|---|
| fold pass throws | that one turn's context goes out raw |
| fold-record, seed-index, or layer persistence throws | that fold event is rejected; the turn goes out raw |
| fold-code collision on one block | that block alone stays raw for the session; the rest of the event folds |
| deterministic compaction throws | Pi's own compaction runs instead |
| resume restore throws | prior folds render raw this session |
| cache-risk estimate or confirmation throws | input proceeds without the advisory; an explicit cancellation still consumes the input |
| ledger cannot serve a block (absent, or sha mismatch) | a live block still resolves from raw history, through the same recall caps and slices; only a block that also left live history errors |

`CONTEXTFOLD=0` disables the extension entirely for one session, which is the escape hatch for
testing or for isolating a suspected fold-related problem.

---

### Cache-risk input boundary

Cache prediction reads successful assistant completion timestamps from the active session branch,
keyed by provider and model. Runtime timers, notification deduplication, and cancelled structured
images live only in `cache-warning.ts`. Session navigation and shutdown reset them. No additional
session record or provider request is needed. Saved provider warning intervals control the
advisory rather than guaranteeing provider retention.

The `input` hook can consume a potentially cold interactive prompt before Pi sends it. Automation
and queued streaming input continue unchanged. Cancellation restores the editor text and retains
structured images for the next interactive prompt in that session. `/context-fold discard-images`
clears them. The confirmation is disabled by default and never changes fold policy or starts a new
session.

## 8. Invariants

1. **Only durable ids may be folded.** Ids prefixed `u:`/`a:`/`r:`/`s:` are content-anchored and
   stable; positional `m<i>:…` ids re-point once folding makes the array non-append-only. The
   `isDurableId` gate is separate from the kind-based `wireFoldable` gate and stays that way.
   Recovery depends on it: the ledger route re-locates a folded block by recomputing exactly
   these ids over `getEntries()`, so an id that could drift would strand its content.
2. **The engine is the sole author of the `{#code}` tag.** Strip any tag a policy supplies and
   prepend the authoritative one.
3. **Single disposition.** Each block id appears in at most one op.
4. **A block's token cost is uniform `ceil(chars/4) + 4`** (`estTokens` plus `BLOCK_OVERHEAD`),
   one swappable oracle in `tokens.ts`.
5. **Frozen bytes are immutable** for the life of the layer. Only an explicit unfold or a recorded
   layer break releases one.
6. **Risk lines survive every fidelity level.** The error lexicon is deliberately broad and
   any-case. A failure signal that vanishes into an elision marker is the bug this project exists
   to prevent.
7. **No model call anywhere**, on any path. Folding, digests, compaction and the handoff seed are
   all deterministic, so nothing this extension produces can be a paraphrase or a fabrication.
8. **`typebox` and the `@earendil-works/*` packages are peer dependencies, never vendored.** Pi
   injects bundled virtual modules at runtime, so a separately installed copy would not be the one
   the engine uses.

---

## 9. Provenance

The pure core is derived from [Accordion](https://github.com/a-Fig/Accordion) (pinned commit
`0c22434`), stripped of all Svelte/Tauri/browser coupling and hardened since. `digest.ts` and
`tokens.ts` are close to verbatim, and `applyPlan` and the block model are adapted. The discrete
fold ladder, seed index, ledger-backed recovery, and advisor layers are original to this project.
