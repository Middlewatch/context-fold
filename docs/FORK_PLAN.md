# Fork plan: cache-expiry-aware folding

Status: implemented on `fork/cache-aware`
Base: `main` @ `7bce0b7` (release 0.7.0)
Branch: `fork/cache-aware`

## Scope

One change: teach the existing fold ladder when the provider prompt cache has
expired, so folding happens at the next request boundary without first paying an
uncached request.

Everything else stays as it is:

- keep the current **20K protected tail**; no turn-based protection
- keep **uniform fold-all** eligibility
- keep `unfold`
- keep `recall_folded` untouched
- keep the existing digest, thresholds, frozen layers, seed index, and `applyPlan`

## Current behavior (baseline)

- **Protected tail:** newest ~20K tokens (`tailTarget`, clamped to half the budget).
- **Current batch:** tool results after the latest assistant message are held.
- **Eligibility:** every `tool_result` / `thinking` block outside the protected
  tail, not current-batch, not frozen, not agent-unfolded. One fold command
  contains all of them; no per-block importance ranking.
- **Fold ladder:** `foldAt = 0.45` when maskable savings ≥ `foldStep = 0.12` of
  the window, or on budget `min(200K, 0.75 × window)`.
- **Cold branch:** `coldFoldAt = 0.25` when no live cache read has ever been
  observed after 3 turns. This means “provider does not cache,” not “cache
  expired.”
- **Cache telemetry:** `cacheRead`, `cacheWrite`, `cacheWrite1h`, `input` are
  recorded from assistant `message.usage` on `message_end`.
- **Recall / unfold:** both complete and unchanged.

## Cache-expiry design

The API response does **not** report a TTL directly. It reports cache usage, and
Pi’s model metadata declares the cache lifetimes. Use those together.

### Signals

From the latest assistant response:

- `cacheRead > 0` — the request hit a warm prefix
- `cacheWrite > 0` — a new prefix was written
- `cacheWrite1h > 0` — the write used the one-hour retention tier
- no cache counters at all (`cacheRead == 0 && cacheWrite == 0`) — caching is not
  in use, or the provider does not report it

From the model record:

- `promptCache.short` — short-tier lifetime in seconds (e.g. 300)
- `promptCache.long` — long-tier lifetime in seconds (e.g. 3600)

Provider configuration fallback:

- per-model `cacheTtlMs` override
- global default `300000` (5 min) only when the model declares a short tier but
  no explicit value is available
- if no cache usage and no `promptCache` metadata: disable expiry folding

### Tier selection

Use the most recent observed write:

```
if lastUsage.cacheWrite1h > 0 and model.promptCache.long: ttl = long
else if model.promptCache.short: ttl = short
else: ttl = configured default or disabled
```

If the last response only read from cache, keep the tier selected when that cache
was written (store `activeCacheTier` when `cacheWrite > 0`). A later
`cacheWrite1h > 0` upgrades it.

### Timing

- Record `lastResponseAt` when an assistant message with usage is observed.
- At every **request assembly** — before sending — compute:
  `cacheExpired = lastResponseAt != null && now - lastResponseAt > ttl`
- If expired: feed the existing cold branch (`setCold(true)` for this decision).
  The existing `coldFoldAt = 0.25` then applies. No new threshold.
- The user-message boundary is the main case. A long tool call can also exceed
  TTL; the same check at the next tool-result request covers that. `firstDelivery`
  already protects the current batch, so folding mid-tool-loop cannot remove the
  result that just arrived.
- Never send a probe request to discover expiry. Never fold after sending. The
  check happens before the request is assembled.
- Do not persist `lastResponseAt` across resume; start unknown, then learn from
  the first response.

### Cache warming

Pi can keep a prefix warm (`cacheWarming = "streaming" | "idle"`). They are not
the same for expiry:

- `"streaming"` warms during active runs. At a user-turn boundary the previous
  run is settled and cannot be warm, so expiry folding is allowed. Inside a tool
  loop the run is active and warming may keep the prefix warm, so expiry is gated
  off there. This is Pi's default.
- `"idle"` warms between runs and can keep the prefix alive past the nominal TTL,
  so expiry folding is gated off in that mode.
- `"off"` has no warming; expiry folding is enabled at every boundary.

Log the decision in status so it is clear why a fold did or did not fire.

### No-cache sessions

If no cache counters have ever been observed, keep the existing cold branch
(no-cache provider). This change does not alter that behavior.

## What is not changing

- 20K protected tail
- current-batch holding
- uniform all-eligible fold command
- `foldAt`, `foldStep`, `coldFoldAt`, budget fractions, absolute cap
- digest format and risk lines
- `recall_folded`
- `unfold`
- frozen layers, seed index, hard-compaction recovery

## Acceptance criteria

1. With a fake clock, a request after the selected TTL sets the cold flag; a
   request before it does not.
2. A `cacheWrite1h > 0` response selects the long TTL; otherwise the short TTL.
3. No cache counters and no `promptCache` metadata → no expiry folding.
4. Expiry folding uses `coldFoldAt`, not the warm `foldAt`.
5. Existing 20K tail, uniform fold-all, recall, and unfold behavior are unchanged.
6. Existing test suite passes; new tests cover TTL selection, expiry timing, and
   cache-warming gating.

## Open questions

1. Exact `promptCache` metadata for the models actually used by this session; if
   absent, the per-model override becomes the main knob.
2. Whether `cacheWarming = "idle"` should disable expiry folding entirely or only
   extend the TTL. Streaming is treated as safe (it does not warm across idle gaps).
3. Whether a later `cacheRead == 0` turn should be used to recalibrate the TTL.
   Start by logging it; do not fold after the fact.
