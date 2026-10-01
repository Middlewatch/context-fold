# context-fold

> **Status (2026-09-30):** context-fold is going through a round of usefulness testing and may be
> retired indefinitely.

Deterministic, reversible context compaction for the [Pi coding agent](https://github.com/earendil-works/pi).
Long agentic sessions stay under budget by folding stale content (mostly long chains of tool
calls) out of the model's view. Every fold is reversible, indexed, and computed without a model
call. Built for Pi and supported on Pi only.

**Requirements:** Node ≥ 22.19.0 and Pi ≥ 0.87.1.

```bash
pi install npm:context-fold
```

## The idea

Context management is annoying, and I know plenty of people who are too lazy to summarize and hand
off to a new session. They let context grow unmanaged right up until they smash `/compact`. This
system came out of iterative research over various compaction methods, and it is an attempt at
economically optimizing context over a long session: eating as few cache-read hits as possible
until you decide to end the session or the work is done.

## Why deterministic

Deterministic masking of stale tool output matches or beats LLM summarization on agentic coding
tasks, at equal or lower cost ([The Complexity Trap](https://arxiv.org/abs/2508.21433),
[SWE-agent](https://arxiv.org/abs/2405.15793),
[Anthropic's context editing](https://claude.com/blog/context-management)).

LLM summaries lose exactly what matters. File and identifier trails are the weakest-preserved
category even in good production summarizers
([Factory.ai](https://factory.ai/news/evaluating-compression)). In one fixed-interval math
experiment, 40.4 % of post-summary answer-state transitions went from correct to wrong, even
though summarization was net positive overall
([Self-Compacting Agents](https://arxiv.org/abs/2606.23525)). A summary can also fabricate
instructions that then become post-compaction "ground truth"
([claude-code #46602](https://github.com/anthropics/claude-code/issues/46602)).

For precise recall, retrieval over raw stored history beats an in-context summary by a wide margin
([MemGPT](https://arxiv.org/abs/2310.08560), [LongMemEval](https://arxiv.org/abs/2410.10813)).
But grep only finds what lexically matches ([NoLiMa](https://arxiv.org/abs/2502.05167)). This is
why every fold emits a deterministic index of exact tokens rather than a paraphrase.

## The system in short

**1. Per-turn: the fold ladder.** Once usage crosses ~45 % of the context window, a
fold event masks stale `tool_result` and `thinking` blocks. User intent, assistant conclusions, and
the record of every action are never touched. Fresh tool results are always delivered in full at
least once.

**2. The floor.** Eventually no more tool calls can be masked. At that point context-fold says so
rather than churning. What remains is the irreducible floor, and it cannot compress past it.

**3. Hard compaction.** Pi decides when this fires. By default (`CONTEXTFOLD_COMPACT=det`)
context-fold intercepts it and renders a verbatim seed index re-extracted from the active branch's
compacted history. Re-extraction honors content replacements and omissions, including edits to
previously compacted messages. Old index records and narrative summaries remain archival rather
than being replayed into automatic summaries. `CONTEXTFOLD_COMPACT=native` opts back into Pi's stock
behavior.

At this stage compaction removes the raw messages from live context. What survives is the index
and Pi's session file, both on disk and both reachable through `recall_folded`. The loss is bounded
and reversible rather than lossy and final. There is no paraphrase step and nothing that can
hallucinate. The extension warns you after a second forced compaction. Consider running a handoff
well before that, at a task finish line.

**4. Handoff.** *(manual, `/fold-handoff`)* Writes a seed file for starting a fresh session: the
same verbatim index plus the goal you state. Interactively it then offers, behind one
confirmation, to start the replacement session directly. The seed becomes the first user
message and the new session opens idle, spending nothing until you type. Decline (or run
headless) and the flow stays write, review, `/new`, paste.

> **On the thresholds.** Every percentage above is a default, not a tuned constant. The right
> first-fold point trades the initial cache write against how many times you compact over a
> session, and I have not settled it. All of them are environment variables (see
> [Configuration](#configuration)) and all of them may move in a future minor release.

## What it does

### Discrete fold events

Between fold events the context is append-only. Rewriting history invalidates the provider's
prompt-cache suffix, so mutations are batched at points where that cost is paid once:

- First fold when usage crosses ~45 % of the context window (25 % when telemetry shows the session
  has never had a live cache read, since there is no warm prefix worth protecting).
- A fold event masks stale `tool_result`/`thinking` blocks outside the protected tail to their
  deterministic digests, keeping detected risk lines verbatim, and commits them as a *frozen layer*
  whose bytes never change again. The context head stays byte-identical turn over turn, which is
  what keeps prefix caches warm.
- Each further event needs at least a ladder step (~12 % of the window) of maskable mass. Crossing
  the absolute budget cap (`min(200k, 0.75 × window)`) folds immediately.

### What folds and what doesn't

| Block kind | Ladder behavior | Folded form |
|---|---|---|
| `tool_result` | Masked once stale and outside the protected tail | `name → N lines, ~T tok · first line`, plus detected error/risk lines verbatim |
| `thinking` | Masked once stale and outside the protected tail | `thought · ~T tok · first line` |
| `text` (assistant reply) | Never masked | Delivered in full |
| `tool_call` | Never masked | Delivered in full; the action record carries the implicit decision |
| `user` | Never masked | Delivered in full |

The protected tail (the newest ~N tokens) is exempt regardless of kind, and a result carrying
non-text parts such as an image is never substituted.

This means context-fold's savings track how much of your history is observations and reasoning
rather than replies. A session whose context grows mostly from long assistant replies compacts
very little, by design: those are the conclusions the ladder exists to protect. A thinking-heavy
session folds hard, provided the provider replays prior-turn thinking into context at all.
Whether it does varies by provider and model. Claude Opus 4.5 and every 4.6+ model keep prior
turns' thinking blocks in context and bill them as input, so folding them saves real tokens there;
Claude Sonnet 4.5, Haiku 4.5, and earlier stripped them server-side
([thinking block preservation](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#migrating-to-adaptive-thinking)).
OpenAI reasoning models return reasoning encrypted or omit it, so there is no thinking text in
the history to fold. The ladder triggers on provider-reported token counts when Pi has them, so it
will not fire on thinking mass the provider is not counting, though the projected savings figure
for a fold can overstate what that fold buys on a provider that strips thinking.

### Ledger-backed recovery

Pi's session file is append-only, so every raw payload stays in it for the life of the session,
through hard compaction and resume. A committed ladder fold therefore records the masked block's
identity and a sha256 of its exact bytes rather than copying the payload. Recall re-locates the
original in the session ledger and verifies it against that sha before serving it. The model sees a
deterministic `{#code FOLDED}` digest and can retrieve the original through `recall_folded` or
restore it through `unfold`. This happens only when context pressure folds stale material;
context-fold never hides a fresh result before its first delivery.

Pi's append-only content edits create separate fold identities. A replacement cannot reuse the
original's frozen digest or recall handle, and both recorded revisions remain available through
explicit recall after compaction or resume. Replacement recalls use the edited ledger content
rather than the original tool's full-output file.

### The seed index

Every fold event appends one deterministic record to `seed-index.jsonl` under
`<sessionDir>/context-fold/<sessionId>/` (spec: `docs/SEED_INDEX_SPEC.md`): files touched,
commands run, error lines in every spelling the lexicon knows (lowercase `failed`, `npm ERR!`,
…), exact identifiers and numbers harvested from the masked output, first lines of user
messages, and recovery spans naming each folded block's ledger anchor, extent, and fold-time
sha256. Extraction uses pure regex and produces byte-identical output for the same input.

### Starting fresh with the seed index

`/new` starts an empty session. It does not import the previous session's seed index or fold
handles. To carry indexed context forward, run this in the old session:

```text
/fold-handoff <goal for the next session>
```

The command writes `<sessionDir>/context-fold/<sessionId>/handoff-<sessionId>.md` and offers to
open a replacement session with that seed as its first user message. Accept, then type your next
instruction. Creating the seed and opening the session make no model request.

To review the seed first, decline the switch, open the file at the printed path, then run `/new`
and paste its contents or ask the new agent to read that path. If you already ran `/new` without
making a seed, use `/resume` to return to the old session and run `/fold-handoff` there.

The seed contains a bounded rendering of existing fold and compaction records, so recent work
that has not been indexed may be absent. Include the next task in the goal. The complete index
remains in `seed-index.jsonl` beside the seed. For a saved session, raw content remains in its
parent session file, whose path the seed includes when Pi provides it. Old fold codes do not
resolve through the new session's `recall_folded` or `unfold`; read the parent files directly or
resume the parent session to use those handles.

### Getting detail back

- `recall_folded search=<term>`: one sweep over every folded block, with matching lines grouped by code.
  Finding a detail lost behind N pointers takes one call rather than N.
- `recall_folded <code>`, with optional `grep=<term>` or `lines=<a-b>`: whole or partial retrieval,
  token-capped so a recall can never re-flood what folding saved. When the tool recorded its own
  full-output file (a truncated bash result), grep and line reads answer from that file, so recall
  reaches even the bytes truncation dropped before folding ever saw them.
- `unfold <code>`: sticky re-expansion. The block stays expanded and is never re-masked.

Recall works live, after resume, and after hard compaction: masked content resolves from Pi's
append-only session file even once the raw message has left live context.

### Status and advisories

- **Cache inactivity warning**: in interactive Pi, a session carrying at least 20k tokens warns
  on resume or when its configured idle interval expires:
  `cache may have expired: ~85k tok may rebill. Consider /fold-handoff`.
  The clock starts at the last successful response for the selected provider and model, restored
  from the active session branch. Typing, tool activity, and failed responses do not refresh it.
  Each idle interval gets one notice. A model with no recorded activity instead says
  `cache unverified`. The token count is an estimate, including after compaction; elapsed time
  does not prove cache expiry or guarantee that the provider will bill the whole context again.
  Hosts that cannot estimate the retained context skip prediction while its size is unknown.
- **Observed cold input**: after the agent settles, a final response with zero cached reads and
  at least 20k input tokens can trigger
  `session cold: rebilled ~40k tok as fresh input. Consider /fold-handoff`.
  Detection requires at least two responses observed since the extension loaded and excludes
  the first response after a fold. The notice appears at most once per cold streak and reports
  input already processed. Interactive notices use Pi's renderer; headless notices use stderr.
- **`/context-fold` menu**: choose **Status**, **Settings**, or **Discard retained images**.
  Escape or **Close** dismisses it. Status shows fold position (usage %, the next-fold gauge),
  cache hit ratios, and advisory flags: folds committed but not observed on the wire, a second
  forced compaction, irreducible context past half the window, cold with a large carry, and recall
  churn. See [Configuration](#configuration) for settings.
- **Footer status line (TUI)**: a persistent one-line summary in Pi's footer (`⧉ context-fold ×3
  · ~41k masked · next fold 3.1k/9.6k`), updated as fold events fire. The line is purely visual.
  It adds nothing to the transcript or the model's context and leaves headless modes unaffected.
  The last segment is the ladder's trigger gauge, showing whichever fold condition is actually
  binding. Below the entry threshold it names it (`next fold at 45%`); once usage is past the
  threshold, which is permanent from then on, it tracks maskable mass toward the next fold step
  (`next fold 3.1k/9.6k`, counting up from 0 right after a fold as new observations land).
  `⚠ over budget` appears only in the terminal state where the irreducible tail and roots exceed
  the budget and no further fold is possible. Footers that stack every extension's status on one
  row can still wrap in a narrow pane: `CONTEXTFOLD_FOOTER_FORMAT=compact` (or the Footer format
  menu row) trims the line to the count and the warning states (`⧉ ×3 (~41k) · ⚠ over budget`).
  Cache hit ratios stay in Pi's own footer and in the `/context-fold` status output.
- **Fold cost accounting**: once a fold event has fired, the status reports both sides: tokens
  masked per turn against tokens the provider re-prefilled because the fold moved the prefix, plus
  the running net. A fold rewrites history from the earliest masked block forward, so that
  re-prefill is a real cost this extension causes, and reporting only the savings would be
  dishonest accounting. It is charged to the single turn carrying the new bytes, because every
  later turn reads them back from cache. The cost side needs a provider that reports cache
  writes: Anthropic and Bedrock Converse do, while the Codex route reports cached reads only and
  Pi hardcodes Google's write to zero. Where writes are unreported the line says so instead of
  showing a zero, because "nothing was rewritten" and "this provider never says" are different facts.

For continuity when starting fresh, use the [seed handoff workflow](#starting-fresh-with-the-seed-index).

**Optional send confirmation.** Enable **Confirm potentially cold prompts** in
`/context-fold` → **Settings** to offer **Keep draft** or **Send anyway** before an interactive prompt
reaches the provider. Escape keeps the draft. A model change during confirmation also keeps the
draft and requires another submission. The same inactivity and 20k-token thresholds
apply. Automation, RPC, and prompts queued during streaming bypass this confirmation.
An advisory or selector failure also lets input proceed, while an explicit cancellation consumes
the input without sending it.

Cancelled text returns to the editor, including pasted-image file paths. Structured images
remain in memory for the next interactive prompt in the same session, even if you edit the text.
A notice lists the retained image count. To clear them, choose **Discard retained images** in
`/context-fold`.
Session navigation, reload, and shutdown discard them. The extension never resets a session or
submits a handoff automatically.

## Guarantees

- **History is never mutated.** Folding exists only in the per-call outgoing copy; the session file
  keeps every raw payload.
- **Nothing is destroyed.** Ground truth is Pi's session file, and the extension writes no copy of
  it. Every `{#code}` handle resolves through `recall_folded`/`unfold` for as long as the session
  file exists, verified against a sha256 recorded at fold time.
- **Tool pairs cannot orphan.** Folding is in-place content substitution and never changes the
  message count, so a `tool_call` can never lose its `tool_result`. The structure guarantees this
  without a separate check.
- **Failure signals survive compression** at every fidelity level; the error lexicon is
  deliberately broad and any-case.
- **No model is ever called.** Folding, digests, compaction, and the handoff seed are all
  deterministic. Nothing this extension produces is a paraphrase.
- **Fail-open, bounded blast radius.** A defect costs one result's folding, one block's fidelity,
  or one turn's folding, never the turn itself. `CONTEXTFOLD=0` disables everything per session.
- **Deterministic core.** The pure core has no clock, no randomness, and no I/O; all disk I/O lives
  in the adapter.

## Limitations

- **Token counts are estimates.** The estimator is a uniform ~4-characters-per-token heuristic, not
  a per-model tokenizer, so every threshold in this document is approximate. It drives budget
  decisions well enough; do not read it as billing truth.
- **Images are invisible to the budget math.** A tool result carrying non-text parts (screenshots,
  rendered pages) is never folded, so nothing is ever lost, but its real token cost is not
  counted either. Image-heavy sessions read as further from the fold
  threshold than they are, so folding starts later than it should.
- **The tool names are global.** The extension registers `recall_folded` and `unfold` as global
  tools. If another extension registers the same names, one will shadow the other (`unfold` is the
  generic one; `recall_folded` was named to avoid this collision).
- **Primarily exercised against one model family.** Development and testing have mostly used
  `gpt-5.6-sol` via the openai-codex provider. Folding only reads Pi's usage numbers and message
  shapes, so other providers should work; fold cost accounting is the one feature with a known
  provider dependency, since it needs reported cache writes. The figures quoted above come from
  individual runs rather than a repeatable harness.
- **Folding changes what the model sees.** A pointer is not the payload. Agents handle this well in
  practice, since the teaching text explains the contract, but if you see an agent confused by a
  `{#code FOLDED}` marker, `CONTEXTFOLD=0` turns everything off for a session.
- **Pre-1.0.** The on-disk formats are versioned but not frozen. While the major version is `0`, a
  change to fold timing or to the seed-index record shape is a minor bump, documented in
  `CHANGELOG.md`.

## Known integrations

A fold can be committed and correct locally yet still be discarded or deferred by another Pi
extension. Context-fold watches provider usage for that outcome. Known interactions follow.

- **`@howaboua/pi-codex-conversion` defers folds to user-turn boundaries.** Its cached WebSocket
  continuation answers a mid-chain prefix change by sending only the pending tool output as a delta
  against the server-held previous response, so a fold's rewrite of older history stays local for
  the rest of that tool chain. At the next user message there is no pending tool output, the
  changed prefix forces a full resend, and provider-reported input drops all at once. Folding still
  works (recall, the fold records, and compaction are unaffected), but a long autonomous tool chain can
  approach the provider's context limit before any fold takes effect on the wire.
- **`pi-with-claude` holds the conversation in its `claude` child.** The bridge sends only new
  input down the wire, keys its history diff by identity so a fold's in-place mask counts as history
  already absorbed, and reports the CLI's own occupancy as cache read with nothing prefilled. A fold
  there rewrites a copy the model never receives. Context-fold recognises that usage shape after two
  responses and pauses the ladder for the session (footer: `paused: provider holds context`). Recall and the seed index keep working, and the CLI manages the real window itself.
- **`codex-lite` does not rewrite context.** Its dialect mode replaces Pi's stock tools and appends
  prompt guidance. There is no fold bypass in that pairing; fresh shell output reaches the model
  before it can age into a ladder fold. Focused shell commands still reduce context growth.
- **Pi 0.87.1 chains two context-transform phases.** Context-fold uses `context_with_system`
  and preserves system messages and tool declarations in place. The ordinary `context` hook
  collapses system patches when a handler replaces message objects, which would invalidate the
  prefix on later prompt changes. Other extensions and providers can still collapse that prefix.
  `session_before_compact` selects one compaction result. See `docs/pi-api-surface.md`.
- **Do not load the package twice.** `pi install npm:context-fold` plus a `-e npm:context-fold`
  flag registers `recall_folded`/`unfold` twice and fails loudly at load with a tool-name conflict.
  Choose either the installed copy or `-e`.

**The wire watchdog.** Because every one of these failure modes is invisible in the extension's own
output, the telemetry checks the outcome instead: a fold that masked tokens strictly shrinks the
outgoing prompt, so if the next turn's provider usage reads the whole pre-fold prompt back from
cache, the rewrite provably never reached the wire. When that happens the extension warns once per
session on stderr and raises a flag in `/context-fold` and the footer status line. A response that
reports no usage at all (a bridged CLI's tool-pause messages) is skipped rather than judged; the
watchdog waits for the next response that reports.

## Install

```bash
# Try it for one session, without installing:
pi -e npm:context-fold

# Install persistently:
pi install npm:context-fold
```

From a clone, point Pi at the checkout instead: `pi -e /path/to/context-fold`.

## Configuration

Run `/context-fold` and choose **Settings** to see every knob below (except the debug seams and
the kill switch), with its effective value and where it came from. Edits persist to
`<agent dir>/context-fold.json` (normally `~/.pi/agent/context-fold.json`) and, where marked live,
apply to the running session immediately. Already-frozen folds keep their bytes, and new values
steer future folds only. Direct shortcuts still work: `/context-fold status`, `/context-fold config`
(or `settings`), and `/context-fold discard-images`. Headless use skips the menu and keeps the
status path. The config shortcut uses an effective-settings listing.

Precedence per knob: built-in default < saved settings file < environment variable. An env var
keeps working exactly as before and shadows the saved value for that session; the menu flags the
shadowing when it applies.

| Var | Default | Meaning |
|---|---|---|
| `CONTEXTFOLD` | _(on)_ | Master kill switch: `0`/`off` = the extension registers nothing this session. |
| `CONTEXTFOLD_FOLD_AT` | `0.45` | First fold when usage ≥ this fraction of the context window. |
| `CONTEXTFOLD_FOLD_STEP` | `0.12` | A fold event must save at least this fraction of the window (spaces events). |
| `CONTEXTFOLD_COLD_FOLD_AT` | `0.25` | First-fold threshold when no live cache read has ever been observed. |
| `CONTEXTFOLD_BUDGET_FRACTION` | `0.75` | Budget = this fraction of the context window… |
| `CONTEXTFOLD_BUDGET_CAP` | `200000` | …capped at this absolute ceiling (attention degrades at absolute depth). `0`/`off` disables. |
| `CONTEXTFOLD_TAIL` | `20000` | Protected-tail target: the newest ~N tokens never fold (clamped to half the budget). |
| `CONTEXTFOLD_COMPACT` | `det` | Hard-compaction answer: `det` = deterministic seed-index summary; `native` = Pi stock. |
| `CONTEXTFOLD_FOOTER_FORMAT` | `full` | Footer status line: `full` = count, masked tokens, and the trigger gauge; `compact` = count and warnings only. |
| `CONTEXTFOLD_RECON_TOKENS` | `18000` | Reconstruction estimate used by the reset flag (input-token equivalents). |
| `CONTEXTFOLD_CACHE_IDLE_MINUTES` | `30` | Cache inactivity warning threshold; `off` or `0` disables prediction and send confirmation. |
| `CONTEXTFOLD_CONFIRM_COLD_PROMPT` | `off` | `on` enables interactive pre-request confirmation. |
| `CONTEXTFOLD_DEBUG` | _(off)_ | One-line fold/cache summary to stderr each turn. |
| `CONTEXTFOLD_DUMP` | _(unset)_ | Debug/e2e seam: write each turn's outgoing (folded) view to this JSON path. |

The **Cache inactivity warning (minutes)** menu row names the selected Pi provider. Edits to
that row save a provider-specific override. Unconfigured providers use the fallback above.
This setting controls warnings rather than claiming how long a provider retains its cache.
Investigate the retention policy for your provider, model, and request settings, then tune the
value accordingly.

The saved JSON supports a global fallback and provider overrides, for example:

```json
{
  "cacheIdleMinutes": 30,
  "providerCacheIdleMinutes": {
    "openai": 30,
    "my-provider": 10
  },
  "confirmColdPrompt": "off"
}
```

Provider keys are Pi provider IDs. The environment timeout overrides every saved provider value.
Choosing `default` in the provider's menu row removes only that provider's override. Menu edits
apply immediately; direct JSON edits take effect when the extension reloads.

## Verification

```bash
npm install && npm run typecheck && npm test   # unit + integration suite
```

```bash
scripts/e2e-ladder.sh          # live: fold event fires, index emitted, head byte-stable, buried value recalled
scripts/e2e-resume.sh          # live: folds survive a session restart
scripts/e2e-compact-resume.sh  # live: folds survive real hard compaction plus a restart, recalled from the session ledger
```

With Pi and tmux installed, `bash scripts/check-cache-warning.sh` checks cancellation, edited
resubmission, and image preservation through the provider boundary in a 48-column Pi terminal.
It uses a local throwing fixture provider, makes no network request, and prints the directory
containing its screen captures.

The unit suite also exercises Pi 0.87.1's real extension runner and session projection without
provider calls, including system patches, content edits, recovery cuts, and revision recall.

The live scripts drive real Pi sessions against a real provider, so they cost money and need
provider auth plus `python3`. They load the working copy explicitly, so they test the checkout
rather than an installed build. Override the model with `E2E_PROVIDER` / `E2E_MODEL`. These
liveness checks assert that folding happens and survives. They do not benchmark savings.

## Develop

```bash
npm install
npm run typecheck
npm test
```

The core (`src/core/*`) has zero harness dependencies, and the Pi adapter (`src/adapters/pi/*`)
owns all I/O and hook wiring. `DESIGN.md` describes the architecture,
`docs/SEED_INDEX_SPEC.md` defines the index format, and `docs/pi-api-surface.md` lists the Pi APIs
that the extension uses.

Pi loads the TypeScript source directly through jiti, so there is no build step. The package ships
`src/` as-is and installs no dependencies of its own.

`typebox` and `@earendil-works/pi-coding-agent` are declared as optional peer dependencies. Use the
copies Pi injects at runtime rather than bundling them.

## Provenance & license

MIT. The pure core is ported from [Accordion](https://github.com/a-Fig/Accordion) (pinned commit
`0c22434`), stripped of UI coupling and hardened since; the discrete fold ladder, seed index,
ledger-backed recovery, and advisor layers are original to this project.

Much of this documentation was drafted with an LLM and edited by hand. The design decisions,
thresholds, and measurements are mine.
