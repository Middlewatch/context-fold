/*
 * cache-expiry.test.ts — the pure expiry heuristic: tier selection from real usage counters,
 * TTL resolution from Pi's promptCache metadata, fake-clock expiry timing, and warming gating.
 */
import { describe, expect, it } from "vitest";
import { CacheExpiryTracker, type CacheModelMeta } from "../src/adapters/pi/cache-expiry";

function fakeClock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const SHORT: CacheModelMeta = { promptCache: { short: 300 } };
const BOTH: CacheModelMeta = { promptCache: { short: 300, long: 3600 } };

function evaluate(
	expiry: CacheExpiryTracker,
	model: CacheModelMeta | undefined,
	extra: {
		ttlOverrideMs?: number;
		cacheWarming?: "off" | "streaming" | "idle" | null;
		activeRun?: boolean;
		enabled?: boolean;
	} = {},
) {
	return expiry.evaluate({ model, cacheWarming: "off", ...extra });
}

describe("cache expiry tier selection", () => {
	it("selects the short tier and expires only after its TTL", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({ cacheWrite: 5_000 });

		clock.advance(299_999);
		expect(evaluate(expiry, SHORT)).toMatchObject({ expired: false, ttlMs: 300_000, tier: "short" });

		// Strictly greater than the TTL: exactly at the boundary is still warm.
		clock.advance(1);
		expect(evaluate(expiry, SHORT).expired).toBe(false);
		clock.advance(1);
		expect(evaluate(expiry, SHORT).expired).toBe(true);
	});

	it("a 1h write selects the long tier and a later read keeps it", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({ cacheWrite: 5_000, cacheWrite1h: 5_000 });
		expect(evaluate(expiry, BOTH)).toMatchObject({ tier: "long", ttlMs: 3_600_000 });

		clock.advance(120_000); // past the short tier
		expect(evaluate(expiry, BOTH).expired).toBe(false);

		// A read-only response must not downgrade the tier chosen by the write.
		expiry.record({});
		clock.advance(3_600_000);
		expect(evaluate(expiry, BOTH)).toMatchObject({ expired: false, tier: "long" });

		clock.advance(1);
		expect(evaluate(expiry, BOTH).expired).toBe(true);
	});

	it("a 1h write without long metadata falls back to the short tier", () => {
		const expiry = new CacheExpiryTracker(fakeClock().now);
		expiry.record({ cacheWrite: 5_000, cacheWrite1h: 5_000 });
		expect(evaluate(expiry, SHORT)).toMatchObject({ tier: "short", ttlMs: 300_000 });
	});

	it("uses the configured TTL when the model declares none", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({});
		expect(evaluate(expiry, undefined, { ttlOverrideMs: 600_000 })).toMatchObject({
			enabled: true,
			ttlMs: 600_000,
			tier: "configured",
			expired: false,
		});

		clock.advance(600_001);
		expect(evaluate(expiry, undefined, { ttlOverrideMs: 600_000 }).expired).toBe(true);
	});

	it("an explicit override enables expiry without model metadata", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({});
		clock.advance(600_001);

		const decision = evaluate(expiry, undefined, { ttlOverrideMs: 600_000 });
		expect(decision).toMatchObject({ enabled: true, expired: true, ttlMs: 600_000, tier: "configured" });
	});

	it("model TTL metadata alone is enough to enable expiry folding", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({});
		clock.advance(300_001);
		expect(evaluate(expiry, SHORT).expired).toBe(true);
	});

	it("waits for a first response before comparing timestamps", () => {
		const expiry = new CacheExpiryTracker(fakeClock().now);
		const decision = evaluate(expiry, SHORT);
		expect(decision).toMatchObject({ enabled: true, expired: false, ttlMs: 300_000 });
		expect(decision.reason).toContain("no response observed yet");
	});
});

describe("cache warming gate", () => {
	it("idle warming disables expiry folding; streaming does not", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({ cacheWrite: 5_000 });
		clock.advance(10_000_000);

		// Streaming warms only during active runs; a user-idle gap still expires normally.
		expect(evaluate(expiry, SHORT, { cacheWarming: "streaming" }).expired).toBe(true);
		const active = evaluate(expiry, SHORT, { cacheWarming: "streaming", activeRun: true });
		expect(active).toMatchObject({ enabled: false, expired: false, ttlMs: null });
		expect(active.reason).toContain("active run");

		// Idle warming can keep the prefix alive between runs, so expiry is unknowable.
		const idle = evaluate(expiry, SHORT, { cacheWarming: "idle" });
		expect(idle).toMatchObject({ enabled: false, expired: false, ttlMs: null });
		expect(idle.reason).toContain("cache warming");
	});

	it("unknown warming disables expiry folding", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({ cacheWrite: 5_000 });
		clock.advance(10_000_000);

		const decision = evaluate(expiry, SHORT, { cacheWarming: null });
		expect(decision).toMatchObject({ enabled: false, expired: false, ttlMs: null });
		expect(decision.reason).toContain("unknown");
	});
});

describe("reset", () => {
	it("cache-warm activity moves the expiry clock", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({});
		clock.advance(299_000);
		expiry.noteActivity(clock.now());
		clock.advance(120_000);
		expect(evaluate(expiry, SHORT).expired).toBe(false);
	});

	it("can be disabled explicitly", () => {
		const expiry = new CacheExpiryTracker(fakeClock().now);
		expiry.record({});
		expect(evaluate(expiry, SHORT, { enabled: false })).toMatchObject({ enabled: false, expired: false });
	});
	it("forgets the timestamp and tier", () => {
		const clock = fakeClock();
		const expiry = new CacheExpiryTracker(clock.now);
		expiry.record({ cacheWrite: 5_000, cacheWrite1h: 5_000 });
		clock.advance(3_600_001);
		expect(evaluate(expiry, BOTH).expired).toBe(true);

		expiry.reset();
		const afterReset = evaluate(expiry, BOTH);
		expect(afterReset).toMatchObject({ expired: false, ttlMs: 300_000 });
		expect(afterReset.reason).toContain("no response observed yet");
		const configured = evaluate(expiry, undefined, { ttlOverrideMs: 600_000 });
		expect(configured).toMatchObject({ enabled: true, ttlMs: 600_000, tier: "configured" });
	});
});
