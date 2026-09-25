# Changelog 
Note: This is largely LLM written, I won't hand write much in here unless I have to

Notable changes to context-fold.

## Unreleased

### Changed

- Require Pi 0.87.1 or newer and pin the development dependency to 0.87.1.
- Hard-compaction summaries re-extract the active branch's compacted history with current
  context edits applied, rather than replaying archival index records or previous summaries.
- Shorter footer status line, so it fits a footer row shared with other extensions in narrow or
  split panes (#1): `⧉ ×3 · ~7.9k masked · ⚠ over budget · cache 100%` replaces
  `⧉ ×3 · ~7.9k tok masked · ⚠ no more folds possible (over budget) · cache avg 100%`. The trigger
  gauge now reads `next fold at 45%`, `next fold 3.1k/9.6k`, and `paused: provider holds context`.

### Fixed

- Preserve system-prompt and tool deltas in place by folding through `context_with_system`.
- Give persisted content replacements distinct fold identities and recover their exact bytes
  from the corresponding edit entry after compaction and resume. Original handles stay valid.
- Invalidate cached digests when equal-length source content changes.
- Keep omitted or superseded evidence out of automatic compaction summaries and retain
  user-only recovery input in the seed index.
- Resolve test dependencies with npm's hoisted layout so Pi integration tests do not silently skip.

- The ladder pauses on a transport that holds the conversation itself (a bridged CLI such as
  pi-with-claude): two responses booking the whole prompt as cache read with nothing prefilled
  mean Pi's message array is not the prompt, so a fold would rewrite a copy the model never
  receives. Previously the 200k budget cap fired an emergency fold every turn on a 1M-window model
  there and reported "no more folds possible" for the rest of the session. The footer now reads
  `folding paused: provider holds the context`.
- The wire watchdog skips a response that reports no usage at all instead of judging it. A
  bridged CLI's tool-pause responses carry zero usage, which either disarmed the watchdog or kept
  it from arming, so folds that never reached the wire went unflagged.

## 0.5.1 - 2026-09-08

### Fixed

- `/fold-handoff` no longer throws after starting the replacement session. A successful
  `ctx.newSession()` invalidates the original command context, so the "handoff seed written"
  notice now goes through `withSession`, which receives the fresh context. Display-only change;
  the seed file and its content are unaffected.

## 0.5.0 - 2026-09-08

### Added

- Interactive cache-inactivity warnings on resume and after an idle interval for sessions
  carrying at least 20k tokens. The default interval is 30 minutes, with saved provider-specific
  overrides and `CONTEXTFOLD_CACHE_IDLE_MINUTES` as a session override. Warnings estimate risk
  from successful responses for the selected provider and model; they do not prove cache expiry.
- Optional confirmation before sending a potentially cold interactive prompt. Enable it in
  Settings or with `CONTEXTFOLD_CONFIRM_COLD_PROMPT=on`. **Keep draft** and Escape cancel the
  send and restore the text; structured images remain available for the next interactive prompt
  in that session. Automation, RPC, and prompts queued during streaming bypass confirmation.
- A local, network-free terminal check for cancellation, edited resubmission, and image
  preservation at the provider boundary (`bash scripts/check-cache-warning.sh`).

### Changed

- `/context-fold` now opens a menu with **Status**, **Settings**, and **Discard retained images**.
  Existing subcommands still work, and headless use keeps the status path.
- Observed cold-input notices use Pi's renderer interactively and stderr headlessly. The shorter
  message recommends `/fold-handoff`; the README explains how to carry the seed into a new
  session and recover details from its parent.
- User and contributor docs use plainer prose, and the architecture introduction and headless
  integration notes describe the current implementation.

### Fixed

- Cache prediction estimates retained context when Pi reports unknown usage after compaction,
  rather than reusing the larger pre-compaction count. Hosts without a retained-context estimate
  skip prediction while usage is unknown.
- A model change during send confirmation preserves the cancelled draft and its images and
  requires another submission, even if **Send anyway** was selected.

Fold timing and the seed-index record format are unchanged.

## 0.4.0 — 2026-08-31

The spool is gone: Pi's own append-only session file is the durability floor behind every fold.

- **Ledger-backed recovery replaces the spool.** A paid probe confirmed what Pi's contract
  states: raw tool results survive hard compaction, resume, and re-compaction in
  `sessionManager.getEntries()`. A fold now records only metadata — the block's durable id, its
  code, its extent, and a sha256 of the block text — and `recall_folded` re-locates the original
  in the session ledger and verifies it against that sha. No copy of any tool result is written
  anywhere. `spool.ts`, `retention.ts`, the GC sweep, the `.alive` heartbeat, dedup aliasing,
  and the `CONTEXTFOLD_SPOOL_RETAIN_DAYS` knob are deleted, and with them both documented
  spool-GC known issues (the race against a quiet-but-live session, and the 24-hour recall
  cliff). ADR 0002 records the decision.
- **Seed index v2.** Spans anchor into the session ledger instead of spool envelopes:
  `spans[].log` drops `path`/`byteStart`/`byteEnd`, keeps `bytes` and `lines`, and each span
  gains a fold-time `sha256`. The JSONL moves from `<sessionDir>/spool/<sessionId>/` to
  `<sessionDir>/context-fold/<sessionId>/`, and handoff seeds are written beside it.
- **Handoff seeds name their parent session.** The seed header carries the parent session file
  path, and the preamble states that fold codes in the seed are provenance from that session,
  not live handles in the new one (Pi lineage does not carry entries across sessions).
- **Pre-redesign sessions resume fail-open.** Legacy `spool`/`gate` records degrade to fold
  entries without a sha: recall serves them from the ledger with an unverified note where the
  block is present, and reports unavailable where it is not. Old spool files are inert; delete
  them freely.
- **`/context-fold config`: an interactive settings menu.** Every knob — fold thresholds,
  budget fraction and cap, tail target, compaction mode, reconstruction budget — lives in one
  table backing the menu, the env parser, and a new saved-settings file
  (`<agentDir>/context-fold.json`). Menu edits persist and steer future folds in the live
  session immediately; already-frozen layers never change. Env vars stay a per-session override
  on top of the saved file, and the menu flags that shadowing rather than hiding it. A corrupt
  or hand-edited file revalidates on read and degrades to defaults.
- **Recall slices answer from the tool's recorded full output.** Fold records carry the
  persisted full-output path from the paired tool call, so `recall_folded` with `grep=` or
  `lines=` searches the complete output rather than only the text that was delivered into
  context.
- **`/fold-handoff` offers to start the successor session.** The seed file is still written
  first as the reviewable record; interactively the command then asks once and, on yes, opens a
  new session seeded with the handoff and linked to its parent. Declining, headless runs, older
  Pi builds, and any switch failure keep the write-review-paste flow.
- **Compaction and cache accounting settle on terminal events.** Compactions count when they
  complete, so a cancelled or failed attempt no longer trips the forced-compaction advisor; an
  index record from a compaction that then fails is voided by an append-only retract line; and
  a real model change restarts cache telemetry, since the new model's cache is genuinely cold.
- **Footer status drops the redundant extension name.** Pi's footer already labels each status
  with its key; the fold glyph stays as the visual anchor.

## 0.3.2 — 2026-08-17

A compaction data-loss fix, a trim of the injected tool guidance, plus documentation and comment
cleanup.

- **Shorter `recall_folded` / `unfold` prompt text.** The one-line snippets no longer repeat the
  tool name and signature Pi already prints, and the guidelines drop to three lines total: recall
  is a fallback with `search=`/`grep=`/`lines=` slicing, rerun a narrower command rather than page
  a broad result through recall, and unfold only what ongoing work keeps needing. Behavior is
  unchanged; this only cuts system-prompt weight.
- **Contributor docs brought to the house prose standard.** `DESIGN.md`, `AGENTS.md`,
  `RELEASING.md`, and both files under `docs/` lose their em dashes and clause-joining punctuation
  in favor of plain sentences, and two dated incident comments in the source drop their dates. One
  stale name fixed: `RELEASING.md` now says `recall_folded` where it said `recall`. No claim changed.

- **Deterministic compaction no longer drops the turn it cuts through.** Pi hands
  `session_before_compact` two disjoint arrays, and removes both from live history:
  `messagesToSummarize` (whole turns before the cut) and `turnPrefixMessages` (the head of the
  turn the cut lands inside). The det summary was built from the first array only, so on any
  mid-turn cut — the normal case when compaction fires during a long tool loop — the prefix left
  live context with no summary text and no spool entry to recall it back. Returning a summary
  from the hook replaces Pi's native path outright, including the turn-prefix summary it would
  otherwise have written, so nothing else covered the gap. Worst case, observed live on
  2026-08-10: the cut fell inside the opening turn, `messagesToSummarize` was empty, and a
  67k-token session compacted to a six-line header whose recall pointers resolved to nothing.
  Both arrays are now spooled and indexed. Every prior test passed `turnPrefixMessages: []`,
  which is why this held for three releases.

- **Docs re-verified against the source.** Every operational claim in `README.md` and `DESIGN.md`
  — configuration defaults, ladder constants, the tool surface, footer status strings, seed-index
  spec constants — was checked against the code. One stale claim fixed: `DESIGN.md` described
  itself as covering 0.2.x behavior.
- **Code comments no longer lean on pre-release design vocabulary.** Level taxonomy from before
  the discrete fold ladder ("C-layer", "L3" — the `L3_RISK_*` constants are now `DIGEST_RISK_*`),
  a component name that never shipped, and references to development-machine tooling are replaced
  with descriptions of current behavior. A spool dedup doc comment that contradicted its own scope
  note now states the real boundary: dedup spans one process, not one session.
- **The obsolete-`L0` guard test explains itself.** It now says the `CONTEXTFOLD_L0*` settings it
  sets were removed in 0.3.0 and must stay inert.

## 0.3.1 — 2026-08-09

Fixes from an adversarial functionality audit of 0.3.0, plus a deliberate narrowing of the
agent-facing recall surface and a retention rework.

- **A fold-code collision no longer disables folding for the session.** Two durable block ids can
  rarely hash to the same 6-char code; the spool's overwrite refusal used to reject the entire fold
  event, and because the collider stayed eligible, every later event too. The colliding block alone
  is now dropped (it stays raw and held, announced on stderr) and the rest of the event commits.
- **Every recall route is now bounded and sliceable, including live history.** Recall served from
  the live snapshot (a fold whose spool entry was dropped at resume, or a legacy session) used to
  return the whole payload uncapped and silently ignore `grep`/`lines`; it now goes through the
  same caps and slicing as spool-backed recall. A spool file that becomes unreadable mid-session
  falls back to the same bounded live read instead of returning only an error.
- **`unfold` on a compacted-away code now names that state.** It used to claim "no folded block
  with that code" while `recall` still served the content; it now says the block left live history
  at compaction and points at `recall` with its slicing options.
- **The `recall` tool is renamed `recall_folded`.** The old name read as a general memory tool —
  an invitation to browse — and could collide with other extensions' generic `recall`. The new name
  binds the tool to the `{#code FOLDED}` markers it dereferences. `unfold` keeps its name (it
  already lexically matches the marker). Every model-facing reference — tool prompts, recall
  notes, and the deterministic compaction summary — moves with it.
- **Hard compaction now spools the whole leaving span.** Blocks that never folded (inside the
  protected tail at compaction time, or a session compacted before its first fold) used to leave
  live history with no recall route beyond Pi's session JSONL. They are now spooled per-block
  fail-open just before the compact index record is emitted, so `recall` covers the entire
  compacted span and the record carries recovery pointers for it.
- **Spool retention default is now 24 hours, and the GC reaches abandoned workspaces.** The spool
  is a working artifact for the session that made it (Pi's session JSONL keeps every raw payload
  regardless), so two weeks of retention mostly stored dead weight. The sweep also gained a
  sibling-workspace pass: per-session sweeping only runs for a workspace when a new session starts
  in it, so a workspace that stopped being used previously retained its last spools forever.
  `CONTEXTFOLD_SPOOL_RETAIN_DAYS` still overrides (fractional days allowed; `0`/`off` disables).
- **`recall`/`unfold` now resolve folded blocks only, and their prompts frame recall as a
  fallback.** Every live block's id hashes to a code, so a never-folded block's code used to
  resolve to its full live content — a general history reader recall was never meant to be. Both
  tools now answer only for frozen or spooled blocks. The tool descriptions and guidelines are
  rewritten to the narrow contract: recall only when a `{#code FOLDED}` pointer blocks the current
  step, prefer rerunning cheap commands, and `search=` is documented as a pointer lookup (which
  folded block holds a known identifier), not a search engine.

## 0.3.0 — 2026-08-08

- **The arrival-time ingestion gate has been removed.** Fresh tool results now always reach the
  model in full before they can age into a pressure-driven ladder fold. This removes the
  `CONTEXTFOLD_L0*` configuration surface, the `tool_result` observer, born-folded pointer digests,
  and the known immediate-recall churn path. The shared spool/recovery machinery remains: ladder
  folds are still exact, reversible, indexed, and recoverable after hard compaction. Resume accepts
  legacy `kind:"gate"` records so old handles continue to resolve.
- **Cold-session advice now waits until Pi's agent run has settled.** The old `message_end` check
  ran after every intermediate tool-call response, so a transient cache miss could print a stale
  warning while the agent was still visibly working. The advisory now evaluates at
  `agent_settled`, after retries, compaction, and queued continuations finish, and ignores the
  expected one-response cache miss caused by context-fold's own prefix rewrite.
- **Recall guidance now discourages sequential paging of broad shell output.** When most of a
  folded result would be needed, the model is told to rerun a narrower command instead; targeted
  `grep`, line-range recall, span search, and sticky unfold remain available.
- **A fold now reaches the model only after its recovery state is durable.** The exact spool
  payload, seed-index record, session spool records, and frozen layer must all persist successfully;
  otherwise the complete fold event is rejected and that turn is sent raw.
- **Compaction recovery records can no longer be shadowed by later folds.** Fold-layer sequence
  numbering now advances past deterministic-compaction index records, including after resume, so a
  later fold cannot reuse the compaction record's sequence and hide its recovery map.
- **Readable compacted folds remain span-searchable after the raw block leaves history.**
  `recall search=<term>` now sweeps their persisted spools as well as the live snapshot. Direct code
  recall reports a missing or corrupt spool explicitly; span search skips unreadable spool entries.
- **Current Pi integration guidance is versioned.** Pi 0.83.0 and 0.84.1 chain context transforms
  as middleware; the former last-wins warning remains relevant only to older builds that predate
  transform chaining. `codex-lite` is documented separately from the cached
  `@howaboua/pi-codex-conversion` transport. The development fixture now uses Pi 0.84.1.
- The minimum Pi version is now stated precisely as 0.80.4, where `agent_settled` was introduced.
- **Pi now displays the local development package as `context-fold`.** Its manifest points through
  a shipped root entry point instead of exposing the adapter directory name (`pi`) in the startup
  extension list.

## 0.2.3 — 2026-08-05

- **Spool GC no longer reaps a live session that has been quiet.** The sweep dated a sibling
  session's spool by its newest file, which measures when that session last *folded*, not whether
  it is still running — so a session that folded early and then ran past the retention window could
  have its spool deleted out from under it by a freshly started sibling. Each session now refreshes
  a `.alive` heartbeat in its own spool directory from the `context` hook, throttled to once an
  hour and inert until the session has actually spooled something, so liveness is recorded
  independently of fold activity. The residual edge is a stopped process, which stops heartbeating
  and can still be reaped. Tests in `retention.test.ts`.
- **Documentation pass.** The README no longer describes the project as 0.1.0; `RELEASING.md` is a
  release checklist rather than a first-publish guide; the ingestion gate is named and defined in
  prose (`L0` is documented as the historical name that survives in the `CONTEXTFOLD_L0*`
  variables, which are unchanged); notes-to-self and local filesystem paths are gone from published
  docs; the hook-collision table moved into `docs/pi-api-surface.md`; and `TODO.md`, which was
  internal working state, was removed. Gate measurements are now labeled as single observed runs
  rather than a benchmark, because there is no public harness behind them.
- **`DESIGN.md` §2 had the policy/mechanism split backwards** — `policy/fold-ladder.ts` is the
  policy and `apply.ts` is the mechanism, not the reverse. Documentation only; the code was always
  correct.

## 0.2.2 — 2026-08-03

Display-only: no change to fold timing, the seed-index record shape, or any wire behavior.

- **Footer: the fold gauge now shows the binding condition, not the static threshold.**
  `fold 65%/45%` went stale the moment usage passed the threshold: the usage gate is satisfied
  permanently from then on, the 45% never changes again in a warm session, and the real trigger
  for the next fold is maskable mass reaching one ladder step — which the gauge never showed. The
  gauge now renders whichever condition is actually unmet: `next fold at 45% ctx` below the entry
  threshold, and `next fold: 3.1k/9.6k maskable` above it — counting up from 0 right after a fold,
  since an empty gauge is an interim state that refills as new observations land. The terminal
  message `⚠ no more folds possible (over budget)` replaces the old `at floor`, and appears only
  when the irreducible tail/roots exceed the budget. The usage percentage is gone from the
  footer — Pi's own footer already shows one; `/context-fold` still reports it, now with the `~`
  chars÷4 estimate marker the old footer gauge carried.
- **`/context-fold` shows the same gauge** in place of the former static `(next fold ≥ 45%)`.
- The ladder's fold-event and irreducible-floor metrics now publish `maskable_tokens` and
  `step_tokens` (the idle branch already did), so the gauge renders from published metrics in
  every state without re-deriving policy internals.

## 0.2.1 — 2026-07-30

Display-only release: no change to fold timing, the seed-index record shape, or any wire behavior.

- **Footer: the context number is now the fold gauge.** `ctx 72%` read as a second context meter
  and invited comparison with Pi's own footer percentage (different rounding, one turn of update
  lag). It is now `fold 72%/45%` — usage as the fold ladder sees it, against the configured
  next-fold threshold. The threshold is read from the ladder's published `fold_at` metric each
  turn (so `CONTEXTFOLD_FOLD_AT` and the cold-branch lowering both show up live), a `~` prefix
  marks the post-compaction window where Pi reports no token count and the fraction is the
  chars÷4 fallback estimate, and `at floor` replaces the gauge when nothing maskable remains.
- **Footer: `cache 66%` → `cache avg 66%`.** The footer ratio is the whole-session aggregate
  (cold first turns included), while Pi's `CH` stat is the last turn only; the label now says
  which one it is.
- The fold-event status metrics now publish `fold_at` alongside `usage_fraction`, as the idle
  branch already did, so the threshold stays visible on the turn a fold fires.

## 0.2.0 — 2026-07-30

- **Wire watchdog.** A fold that masked tokens strictly shrinks the outgoing prompt, so if the
  next turn's provider usage reads the whole pre-fold prompt back from cache, the rewrite provably
  never reached the provider. The telemetry now detects this (once-per-session stderr warning, a
  `/context-fold` flag, a footer warning) — it measures the outcome, so it covers hook clobbering,
  transport-level deferral, and discard mechanisms that don't exist yet. Motivated by the
  2026-07-30 finding that `@howaboua/pi-codex-conversion`'s cached WebSocket continuation defers
  fold rewrites to the next user-turn boundary.
- **Persistent footer status (TUI).** One keyed line in Pi's footer (`ctx.ui.setStatus`) with fold
  count, tokens masked, context usage, and cache hit ratio — a live fold notification with zero
  transcript pollution. Headless modes are untouched (Pi stubs `setStatus` to a no-op there).
- **e2e check (e): assert the wire, not just the dump.** `e2e-ladder.sh` now parses the session
  JSONL and requires the first layer commit to be followed by a smaller provider-reported prompt.
  The previous checks read `CONTEXTFOLD_DUMP` — the extension's own output — which is exactly why
  the deferral above was invisible to them.
- **Docs: known integrations + corrected hook contract.** README gained a "Known integrations"
  section (codex deferral, load-order rule, double-load failure); `docs/pi-api-surface.md` no
  longer claims `context` handlers chain — Pi dispatch is last-non-`undefined`-wins in load order,
  so context-fold must be listed after any other context rewriter.

## 0.1.0

First public release. context-fold was developed privately before this point, so this entry
describes what the package does rather than how it got here.

### What it does

- **The discrete fold ladder** — the folding policy. Fold events fire at thresholds (~45 % of the
  context window, 25 % when telemetry shows no live cache read has ever landed) and must save at
  least a ladder step (~12 %) to fire at all; crossing the absolute budget cap folds immediately.
  Between events the context is append-only, so the provider's prompt cache keeps hitting.
- **Prefix-stable frozen layers.** Each fold event's substitutions commit as a layer whose bytes
  never change again, persisted verbatim so a resumed session's context head is byte-identical to
  the one the provider already cached.
- **The L0 ingestion gate** (`CONTEXTFOLD_L0`, off by default). Large tool results are spooled to
  disk and enter the model's view already folded to a `{#code FOLDED}` pointer, so a flood never
  reaches full-fidelity context at all.
- **Reversible by design.** Folding rewrites only the outgoing copy of the conversation; the
  session history on disk is never touched. Any folded block comes back through `recall {code}`,
  `recall {code} grep=<term>`, or `recall {code} lines=<a-b>`. `unfold {code}` keeps it expanded.
- **`recall search=<term>`** — one sweep over every folded block, matching lines grouped by code,
  so a detail lost somewhere behind N pointers costs one call rather than N.
- **The seed index** (`docs/SEED_INDEX_SPEC.md`) — one deterministic record appended to
  `seed-index.jsonl` at every fold event: files touched, commands run, error lines in every
  spelling the lexicon knows, exact identifiers harvested from the masked output, first lines of
  user messages, and byte extents into the spool. Pure regex extraction: same input, byte-identical
  output.
- **Deterministic hard compaction** (`CONTEXTFOLD_COMPACT=det`, the default). When Pi's own
  compaction fires, the extension supplies a summary rendered verbatim from the seed index instead
  of an LLM rewrite. Every listed token is a lexical hook for `recall`. `native` restores Pi's stock
  behaviour.
- **`/fold-handoff`** — writes a seed for a fresh session: the deterministic index plus the goal you
  state on the command line. Nothing is injected into context; nothing fires on its own.
- **No model calls anywhere.** Every path in the package — folding, digests, compaction, the
  handoff seed — is deterministic. There is no hallucination surface because nothing is generated.
- **Fail-open throughout.** A gate, index, spool, or fold failure costs that piece of work and says
  so on stderr; it never costs the turn. `CONTEXTFOLD=0` disables the extension entirely.
- **Cache telemetry and the advisor.** Measured per-message `cacheRead`/`cacheWrite` drives cold
  detection (one stderr notice when an expected-warm turn reads zero cached tokens) and the
  `/context-fold` status command's flags.
- **Fold-cost accounting.** Cache telemetry attributes re-prefill to context-fold's own fold
  events, and `/context-fold` plus the `CONTEXTFOLD_DEBUG` line report both sides: tokens masked
  per turn against tokens the provider re-prefilled because the fold moved the prefix, plus the
  running net. The cost is charged to the single turn carrying the new bytes, since every later
  turn reads them back from cache. Measuring it needs a provider that reports cache *writes*; where
  they are unreported the status says so rather than showing a zero — "nothing was rewritten" and
  "this provider never says" are different facts.
- **Deferred L0 substitution** (`CONTEXTFOLD_L0_KEEP_RECENT`, default `0` = born-folded). Holds the
  newest N gate-registered blocks at full fidelity, folding them once stale, as a mitigation for
  recall churn. Experimental: its first live A/B did not support it, and the README records the
  reasoning and the open question that keep the flag alive.

### Behaviour worth knowing

- The error lexicon deliberately covers lowercase and tool-specific spellings — `failed`, `fatal`,
  `npm ERR!`, `Segmentation fault`, `Permission denied`, `✗`, tracebacks — because a test-runner
  wall that reports `isError=false` would otherwise fold at the normal threshold and drop its
  failure line. Detected risk lines are kept verbatim inside the pointer.
- Every recall surface clips and windows single enormous lines. A payload arriving as one 40 KB
  line would otherwise ride through the caps on an "always keep at least one line" rule and undo
  what folding saved.
- Token counts are estimates (~4 characters per token), not a per-model tokenizer, so every
  threshold is approximate.

### Evidence

Deterministic masking of stale tool output matches or beats LLM summarization on agentic coding
tasks at equal or lower cost ([The Complexity Trap](https://arxiv.org/abs/2508.21433),
[SWE-agent](https://arxiv.org/abs/2405.15793)), while LLM summaries measurably lose exactly what
matters — file and identifier trails are the weakest-preserved category even in good production
summarizers ([Factory.ai](https://factory.ai/news/evaluating-compression)) — and summaries can
fabricate instructions that then become post-compaction ground truth. For precise recall, retrieval
over raw stored history beats an in-context summary by a wide margin
([MemGPT](https://arxiv.org/abs/2310.08560),
[LongMemEval](https://arxiv.org/abs/2410.10813)), but grep only finds what lexically matches
([NoLiMa](https://arxiv.org/abs/2502.05167)) — which is why every fold emits a deterministic index
of exact tokens rather than a paraphrase.

A three-arm evaluation of the L0 ingestion gate found it near-inert where a capable model already
scopes its own reads, and decisive where a flood genuinely lands: a buried-error task went from
26,750 to 4,793 input tokens, a web-fetch task from 14,380 to 3,225. It saves most of the cost
where a flood lands and costs a few percent elsewhere — not a flat ratio. That is why it ships off
by default.

Fold thresholds were measured before settling on the defaults: folding *earlier* is worse. The
dominant cost is the number of fold events rather than the size of any one re-prefill, so a tighter
budget fired more events and spent more input tokens for fewer cache reads. Fidelity held at every
threshold, with planted risk lines preserved verbatim inside every folded digest.
