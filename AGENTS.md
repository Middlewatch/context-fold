# Working on context-fold

Deterministic, reversible context compaction for the Pi coding agent. This file orients a
contributor (human or agent) before changing anything. `README.md` explains what the extension
does for a user, and `DESIGN.md` is the behavioral authority for how it does it.

## Invariants

These are frozen. A change that weakens one is a redesign rather than a patch:

1. **Every fold is deterministic, reversible, and indexed.** Same input, byte-identical output. A
   `{#code}` handle always resolves through `recall_folded`/`unfold`, and every fold event appends
   a record to the seed index.
2. **No model call on any path.** Folding, digests, compaction, and the handoff seed are all
   mechanical. Nothing this extension emits may be a paraphrase. That is the entire premise.
3. **History is never mutated.** Folding exists only in the per-call outgoing copy. Pi's session
   file always keeps the raw payload.
4. **The pure core has no clock, no randomness, and no I/O.** All of that lives in the adapter.

`DESIGN.md` §8 carries the full list, including the subtler ones (durable-id gating, single
disposition per block, frozen-layer immutability). Read it before touching fold mechanics.

## Layout

- `src/core/`: pure. The block model, digests, the fold ladder policy, seed-index
  extraction. No Pi imports belong here.
- `src/adapters/pi/`: every Pi API call and all disk I/O, meaning hooks, tools, the ledger
  read route, persistence, telemetry.

context-fold serves Pi only (`docs/adr/0001-pi-only.md`). The split survives as a pure/effectful
boundary: keeping the core free of effects is what keeps deterministic folding testable.

## Build and test

```bash
npm install
npm run typecheck
npm test
```

There is no build step. Pi loads the TypeScript directly through jiti, so `src/` ships as-is.

To run your working copy inside a real Pi session: `pi -e /path/to/context-fold`. Load it from one
place only, since an installed copy plus `-e` registers `recall_folded`/`unfold` twice and fails
at load.

`scripts/e2e-*.sh` drive real Pi sessions against a real provider and cost money. They are
deliberately outside `npm test`. Run them only when the folding path itself changed.

## Things that will bite you

- **`typebox` and `@earendil-works/*` are peer dependencies, never vendored.** Pi injects bundled
  virtual modules at runtime, so a separately installed copy is not the one the engine uses.
- **Pi 0.87.1 is the minimum.** Folding uses `context_with_system` so system patches and tool
  declarations keep their positions. Ordinary `context` handlers can collapse that state when
  they replace messages. `session_before_compact` selects one result. See `docs/pi-api-surface.md`.
- **Every hook is fail-open.** A defect should cost one result's folding or one turn's folding
  rather than the turn itself. Preserve that when adding code to a hook.

## Documentation conventions

Published docs stand alone: no notes-to-self, no local filesystem paths, no internal working state,
and no measurement presented as a benchmark unless a public harness backs it. `CHANGELOG.md` is
append-only history and keeps its original wording. Releases follow `RELEASING.md`.
