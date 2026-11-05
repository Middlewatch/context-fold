/*
 * cache-expiry.ts — detect an expired provider prompt cache before a request is assembled.
 *
 * The provider response reports cache usage (read/write, and the 1h share of writes) but no TTL.
 * Pi's model record declares the lifetimes (`promptCache.short`/`.long`, in seconds), so the two
 * are combined: remember which tier the last cache write landed in, then compare the age of the
 * latest assistant response against that tier's lifetime. If the model declares no usable tier, a
 * configured fallback can stand in — but only once cache usage has actually been observed.
 *
 * Pure except for the injected clock: no Pi imports, no persistence. The adapter records usage
 * from `message_end`, resets on session/model changes, and asks for a decision in the pre-request
 * context hook. Expiry feeds the ladder's existing cold branch; it never adds a fold threshold.
 */

export type CacheTier = "short" | "long" | "configured";
export type CacheWarmingMode = "off" | "streaming" | "idle";

/** Model-declared prompt-cache lifetimes, in seconds. */
export interface CachePromptCache {
	short?: number;
	long?: number;
}

/** The slice of Pi's model record this module needs. */
export interface CacheModelMeta {
	promptCache?: CachePromptCache;
}

/** The usage fields this module needs; all other provider usage is ignored. */
export interface CacheUsageLike {
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
}

export interface CacheExpiryInput {
	/** Explicit switch; undefined/true means enabled. */
	enabled?: boolean;
	model?: CacheModelMeta | null;
	/** Explicit fallback lifetime when the model declares no usable tier. 0/undefined = none. */
	ttlOverrideMs?: number;
	/** Effective Pi cache-warming mode. Warming can mask an expired idle prefix, so it gates us off. */
	cacheWarming?: string | null;
	/** True when a tool loop is in progress; streaming warming can keep the prefix warm then. */
	activeRun?: boolean;
}

export interface CacheExpiryDecision {
	/** Whether a model TTL (or observed cache use plus an explicit override) applies at all. */
	enabled: boolean;
	/** True only when enabled, a response has been observed, and its age exceeds the TTL. */
	expired: boolean;
	ttlMs: number | null;
	/** Tier the last cache write established, if any. */
	tier: CacheTier | null;
	/** Human-readable explanation for status/debug output. */
	reason: string;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export class CacheExpiryTracker {
	private lastResponseAt: number | null = null;
	/** Any cache counter observed this session — distinguishes "no cache" from "no write reported". */
	private everCacheUsage = false;
	/** Tier of the most recent cache WRITE; read-only turns preserve it. */
	private writeTier: "short" | "long" | null = null;

	constructor(private readonly now: () => number = () => Date.now()) {}

	/**
	 * Record one finalized assistant response. A response with no cache counters still moves the
	 * timestamp: the next request is that much further from the provider's last seen prompt.
	 */
	record(usage: CacheUsageLike | null | undefined): void {
		const clean = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
		const cacheRead = clean(usage?.cacheRead);
		const cacheWrite = clean(usage?.cacheWrite);
		const cacheWrite1h = clean(usage?.cacheWrite1h);
		this.lastResponseAt = this.now();
		if (cacheRead + cacheWrite + cacheWrite1h > 0) this.everCacheUsage = true;
		// The 1h share is a subset of cacheWrite, so check it first. A read-only turn leaves the
		// tier untouched: it read whatever the last write created.
		if (cacheWrite1h > 0) this.writeTier = "long";
		else if (cacheWrite > 0) this.writeTier = "short";
	}

	/** Session switch, model change, or resume: never carry a TTL observation across them. */
	reset(): void {
		this.lastResponseAt = null;
		this.everCacheUsage = false;
		this.writeTier = null;
	}

	/** A cache-warming refresh is cache activity too; it must move the expiry clock. */
	noteActivity(at: number): void {
		if (!Number.isFinite(at) || at <= 0) return;
		if (this.lastResponseAt === null || at > this.lastResponseAt) this.lastResponseAt = at;
	}

	evaluate(input: CacheExpiryInput): CacheExpiryDecision {
		if (input.enabled === false) {
			return { enabled: false, expired: false, ttlMs: null, tier: null, reason: "cache-expiry folding is off" };
		}
		// Pi's "idle" warming can keep the prefix alive between runs, so an idle gap may not
		// mean the cache is cold. "streaming" only warms during active runs; a user-idle gap
		// still expires normally, so it must not disable expiry folding.
		if (input.cacheWarming === "idle") {
			return {
				enabled: false,
				expired: false,
				ttlMs: null,
				tier: null,
				reason: `cache warming is "${input.cacheWarming}" — the prefix may stay warm between runs`,
			};
		}
		// "streaming" warms during active runs. At a user-turn boundary the previous run is
		// settled and cannot be warm; inside a tool loop it may be, so expiry is not knowable.
		if (input.cacheWarming === "streaming" && input.activeRun) {
			return {
				enabled: false,
				expired: false,
				ttlMs: null,
				tier: null,
				reason: "streaming cache warming may keep the prefix warm during an active run",
			};
		}
		const resolved = this.resolveTtl(input.model?.promptCache, input.ttlOverrideMs);
		if (resolved.ttlMs === null) {
			return {
				enabled: false,
				expired: false,
				ttlMs: null,
				tier: null,
				reason: this.everCacheUsage
					? "no model promptCache for this tier and no cacheTtlMs override"
					: "no cache usage and no model promptCache metadata",
			};
		}
		if (this.lastResponseAt === null) {
			return {
				enabled: true,
				expired: false,
				ttlMs: resolved.ttlMs,
				tier: resolved.tier,
				reason: "no response observed yet",
			};
		}
		const idleMs = Math.max(0, this.now() - this.lastResponseAt);
		return {
			enabled: true,
			expired: idleMs > resolved.ttlMs,
			ttlMs: resolved.ttlMs,
			tier: resolved.tier,
			reason: "ok",
		};
	}

	private resolveTtl(
		promptCache: CachePromptCache | undefined,
		configuredTtlMs: number | undefined,
	): { ttlMs: number | null; tier: CacheTier | null } {
		// A 1h write selects the long tier when the model declares one; otherwise the provider's
		// default write is the short tier. No write seen yet still prefers short metadata.
		if (this.writeTier === "long" && positive(promptCache?.long)) {
			return { ttlMs: promptCache.long * 1000, tier: "long" };
		}
		if (positive(promptCache?.short)) return { ttlMs: promptCache.short * 1000, tier: "short" };
		// The configured fallback is a real assertion only after this session has seen cache usage;
		// "no cache counters and no model TTL" deliberately disables expiry folding.
		if (this.everCacheUsage && positive(configuredTtlMs)) {
			return { ttlMs: configuredTtlMs, tier: "configured" };
		}
		return { ttlMs: null, tier: null };
	}
}
