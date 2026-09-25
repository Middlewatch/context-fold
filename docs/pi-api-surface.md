# Pi extension API surface

Context-fold requires Pi 0.87.1 or newer. This reference describes the contracts verified against
0.87.1; the development dependency pins that version. Re-check `docs/extensions.md`,
`docs/compaction.md`, `docs/session-format.md`, and the exported declarations in the installed
`@earendil-works/pi-coding-agent` when updating it.

## Request-local folding and system prompts

Pi's `ExtensionRunner.emitContext()` clones the transcript and dispatches two phases:

1. `context` handlers receive conversation messages without system messages. If a handler returns
   different message objects or changes their order, Pi restores the current prompt and tools as
   one leading system checkpoint.
2. `context_with_system` handlers receive the resulting full transcript. Their returned messages
   are used directly. A leading system message must remain at index zero.

Context-fold uses the second phase. Its core ignores system messages, and its applier preserves
untouched messages and array positions. Thus folding does not collapse prompt sections or tool
additions/removals into the leading prompt. This matters on providers that support mid-conversation
system messages: later prompt changes can remain appended deltas rather than rewriting the prefix.
An earlier extension or provider lowering can still collapse that state.

`before_agent_start` exposes structured `systemPromptOptions`. Context-fold does not register this
hook or author system prompts. Pi records structured changes before the next request. A forced
string prompt is projected onto the leading system message by Pi and can invalidate the prefix
regardless of context-fold.

| Hook | Context-fold behavior | Pi 0.87.1 composition |
|---|---|---|
| `context_with_system` | Substitute folded content; preserve system messages and positions | Chained after all ordinary `context` handlers |
| `session_before_compact` | Return a deterministic summary and the supplied kept boundary | Last non-cancel result wins; cancellation short-circuits |
| `message_end` | Observe provider usage | Context-fold returns no replacement |

Duplicate tool names are a separate load-time conflict. Load context-fold from one place only.

## Canonical context and recovery

`SessionManager` owns finalized model context. Assigning to `agent.state.messages` does not replace
future request history. Context-fold modifies only the outgoing copy and does not append Pi
`context_edit` entries to implement folding.

A `context_edit` names a source entry. `replacement: null` omits it; a replacement changes content
while retaining metadata. The latest edit on the active branch wins, and navigating before an edit
restores the original contribution. Assistant and tool-result string replacements become text
blocks.

Context-fold reads `getBranch()` to select current revision identities. Replacements append
`:edit:<entryId>` to each durable block ID. That suffix is internal to fold state and handles;
message metadata sent to Pi is unchanged. Digest caching compares exact text.

Recall uses `getEntries()`, which retains the whole append-only tree, including abandoned branches
and compacted messages. `sessionEntryToContextMessages()` projects source entries, and the ledger
reader separately indexes every persisted replacement revision. Each recorded handle resolves the
same bytes after later edits, compaction, or resume, verified by its fold-time sha256. Replacement
recalls do not use the original tool's full-output file.

Other extensions can still rewrite content without persisting its revision. Such bytes may fail
ledger verification. A live frozen block can fall back to its snapshot with a warning; after it
leaves live context, recall returns a typed error rather than unrelated raw content.

## Hard compaction

Pi checks canonical projected context after tools complete, before the next assistant request and
its request-local transforms. It also checks before new prompts and handles post-run overflow
recovery. Request-local folding cannot be assumed to prevent these canonical threshold checks.

`session_before_compact.preparation` contains canonical `messagesToSummarize` and
`turnPrefixMessages`, the supplied `firstKeptEntryId`, `tokensBefore`, and effective per-model
settings. Both message arrays leave live context at a split-turn cut. The boundary may identify
context-invisible recovery entries rather than an ordinary message. A retain-none compaction
stores its own entry ID as the kept boundary.

Context-fold preserves Pi's boundary and re-extracts lexical evidence from the active branch before
it, applying the latest edits to earlier compacted source entries too. It renders only the new
compact index record. Historical index records and previous narrative summaries cannot establish
which evidence remains current. Pi attaches the complete system-prompt/tool checkpoint when it
appends the compaction entry; context-fold does not construct one.

On success, `session_compact` settles the index record and increments the advisory count. On failure
or cancellation, `session_compact_failed` retracts the pending compact record. Overflow recovery
omissions persist even when compaction fails, so the next outgoing view still honors those edits.
The newer actionable `turn_end` and `agent_before_settle` boundaries are not required by this
request-local folding design.

## Remaining APIs

| Need | API |
|---|---|
| Pressure | `ctx.getContextUsage()` supplies `contextWindow` and nullable `tokens` |
| Measured cache usage | Assistant `message.usage` on `message_end` |
| Final idle boundary | `agent_settled`, after recovery and queued work |
| Resume and navigation cache advisories | `session_start`, `session_tree`, `model_select`, `session_compact` |
| Optional send confirmation | Interactive `input`, `ctx.ui.select`, and `handled` or `transform` results |
| Draft restoration | `ctx.ui.setEditorText`, notification, and retained structured images |
| Tools and commands | `pi.registerTool`, `pi.registerCommand` |
| Footer | `ctx.ui.setStatus`, guarded where necessary |
| Fold state persistence | `pi.appendEntry` with custom type `contextfold.fold` |
| Session artifacts | `getSessionDir`, `getSessionId`, `getSessionFile` |
| Handoff replacement session | Command-context `newSession({ parentSession, setup, withSession })` |

Successful session replacement invalidates the old command context. Handoff captures plain data
first and uses `withSession` for its success notification. A new session does not inherit recall
handles from its parent; the handoff seed names parent artifacts for explicit recovery.

Pi injects bundled modules at runtime. Keep `typebox` and `@earendil-works/*` as peers rather than
vendoring them. The test resolver follows npm's dependency resolution, including hoisted layouts.

The automatic path works without UI and never calls a model. Cache-send confirmation requires an
interactive TUI; menus guard UI access. Live provider verification scripts require separate paid
requests. `tests/pi-compat.test.ts` exercises the actual Pi runner, session projection, and
compaction preparation locally without a provider.
