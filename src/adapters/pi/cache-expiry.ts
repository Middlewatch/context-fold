/*
 * cache-expiry.ts — decide whether the provider prompt cache has elapsed before a request.
 * The response gives cache usage but no TTL; Pi's model record gives promptCache.short/long.
 */

export type CacheTier = "short" | "long" | "configured";
export type CacheWarmingMode = "off" | "streaming" | "idle";

export interface CacheModelMeta {
	promptCache?: { short?: number; long?: number };
}

export interface CacheExpiryInput {
	enabled?: boolean;
	model?: CacheModelMeta | null;
	/** Fallback lifetime when the model declares no tier; 0/undefined = none. */
	ttlOverrideMs?: number;
	cacheWarming?: CacheWarmingMode | null;
	/** True inside a tool loop; streaming warming can keep the prefix warm then. */
	activeRun?: boolean;
}

export interface CacheExpiryDecision {
	enabled: boolean;
	expired: boolean;
	ttlMs: number | null;
	tier: CacheTier | null;
	reason: string;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const off = (reason: string): CacheExpiryDecision => ({ enabled: false, expired: false, ttlMs: null, tier: null, reason });

export class CacheExpiryTracker {
	private lastResponseAt: number | null = null;
	/** Tier of the most recent cache write; read-only turns preserve it. */
	private writeTier: "short" | "long" | null = null;

	constructor(private readonly now: () => number = () => Date.now()) {}

	record(usage: { cacheWrite?: number; cacheWrite1h?: number } | null | undefined): void {
		const clean = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
		const cacheWrite = clean(usage?.cacheWrite);
		const cacheWrite1h = clean(usage?.cacheWrite1h);
		this.lastResponseAt = this.now();
		// The 1h share is a subset of cacheWrite, so check it first.
		if (cacheWrite1h > 0) this.writeTier = "long";
		else if (cacheWrite > 0) this.writeTier = "short";
	}

	reset(): void {
		this.lastResponseAt = null;
		this.writeTier = null;
	}

	/**
	 * Cache-warming refreshes move the expiry clock too. They never start it: after a reset the
	 * write tier is unknown, and a persisted entry judged against the short tier could call a
	 * long-tier prefix expired while it is still warm.
	 */
	noteActivity(at: number): void {
		if (!Number.isFinite(at) || at <= 0) return;
		if (this.lastResponseAt !== null && at > this.lastResponseAt) this.lastResponseAt = at;
	}

	evaluate(input: CacheExpiryInput): CacheExpiryDecision {
		if (input.enabled === false) return off("cache-expiry folding is off");
		if (input.cacheWarming == null) return off("cache warming is unknown; expiry disabled");
		if (input.cacheWarming === "idle") return off("idle cache warming can keep the prefix warm between runs");
		if (input.cacheWarming === "streaming" && input.activeRun) return off("streaming cache warming can keep the prefix warm during an active run");
		const resolved = this.resolveTtl(input.model?.promptCache, input.ttlOverrideMs);
		if (resolved.ttlMs === null) return off("no model promptCache for this tier and no cacheTtlMs override");
		if (this.lastResponseAt === null) {
			return { enabled: true, expired: false, ttlMs: resolved.ttlMs, tier: resolved.tier, reason: "no response observed yet" };
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
		promptCache: { short?: number; long?: number } | undefined,
		configuredTtlMs: number | undefined,
	): { ttlMs: number | null; tier: CacheTier | null } {
		if (this.writeTier === "long" && positive(promptCache?.long)) {
			return { ttlMs: promptCache.long * 1000, tier: "long" };
		}
		if (positive(promptCache?.short)) return { ttlMs: promptCache.short * 1000, tier: "short" };
		if (positive(configuredTtlMs)) return { ttlMs: configuredTtlMs, tier: "configured" };
		return { ttlMs: null, tier: null };
	}
}
