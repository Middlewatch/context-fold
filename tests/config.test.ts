/*
 * config.test.ts — the knob table: per-knob validation, saved-settings revalidation, and the
 * default < saved < env precedence that configFromEnv/adapterConfigFromEnv build on.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
	KNOBS,
	knob,
	resolveKnob,
	parseSavedSettings,
	configFromEnv,
	adapterConfigFromEnv,
	type SavedSettings,
} from "../src/adapters/pi/config";

const TOUCHED = KNOBS.map((s) => s.env);
const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
	if (!(name in saved)) saved[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const key of Object.keys(saved)) delete saved[key];
});

describe("resolveKnob precedence", () => {
	it("falls back to the table default when nothing is set", () => {
		setEnv("CONTEXTFOLD_FOLD_AT", undefined);
		expect(resolveKnob(knob("foldAt"))).toEqual({ value: 0.45, source: "default" });
	});

	it("a saved value beats the default", () => {
		setEnv("CONTEXTFOLD_FOLD_AT", undefined);
		expect(resolveKnob(knob("foldAt"), { foldAt: 0.6 })).toEqual({ value: 0.6, source: "saved" });
	});

	it("a valid env var beats a saved value", () => {
		setEnv("CONTEXTFOLD_FOLD_AT", "0.3");
		expect(resolveKnob(knob("foldAt"), { foldAt: 0.6 })).toEqual({ value: 0.3, source: "env" });
	});

	it("an invalid env var yields to the saved value", () => {
		setEnv("CONTEXTFOLD_FOLD_AT", "banana");
		expect(resolveKnob(knob("foldAt"), { foldAt: 0.6 })).toEqual({ value: 0.6, source: "saved" });
	});
});

describe("knob parsers", () => {
	it("fractions reject 0, negatives, >1, and garbage", () => {
		for (const raw of ["0", "-0.1", "1.5", "x", ""]) expect(knob("foldAt").parse(raw)).toBeUndefined();
		expect(knob("foldAt").parse("1")).toBe(1);
	});

	it("budget cap accepts 'off' as 0 and rejects negatives", () => {
		expect(knob("budgetCap").parse("off")).toBe(0);
		expect(knob("budgetCap").parse("120000")).toBe(120_000);
		expect(knob("budgetCap").parse("-5")).toBeUndefined();
	});

	it("blank is not a spelling of zero for non-negative knobs", () => {
		// Number("") coerces to 0; a blank env var must yield to saved/default, not disable the knob.
		expect(knob("budgetCap").parse("")).toBeUndefined();
		expect(knob("tail").parse("")).toBeUndefined();
		setEnv("CONTEXTFOLD_TAIL", "   ");
		expect(resolveKnob(knob("tail"), { tail: 10_000 })).toEqual({ value: 10_000, source: "saved" });
	});

	it("compact accepts only det/native (any case)", () => {
		expect(knob("compact").parse("NATIVE")).toBe("native");
		expect(knob("compact").parse("det")).toBe("det");
		expect(knob("compact").parse("llm")).toBeUndefined();
	});

	it("recon tokens floors and requires > 0", () => {
		expect(knob("reconTokens").parse("1500.9")).toBe(1500);
		expect(knob("reconTokens").parse("0")).toBeUndefined();
	});

	it("the removed spool-retention knob is gone from the table", () => {
		expect(KNOBS.some((s) => s.env === "CONTEXTFOLD_SPOOL_RETAIN_DAYS")).toBe(false);
	});
});

describe("parseSavedSettings", () => {
	it("keeps valid entries, coercing numeric strings", () => {
		expect(parseSavedSettings({ foldAt: 0.5, tail: "30000", compact: "native" })).toEqual({
			foldAt: 0.5,
			tail: 30_000,
			compact: "native",
		});
	});

	it("drops invalid values and unknown keys silently", () => {
		expect(parseSavedSettings({ foldAt: 2, mystery: 1, compact: "llm" })).toEqual({});
	});

	it("returns {} for non-objects", () => {
		for (const junk of [null, 3, "x", [1]]) expect(parseSavedSettings(junk)).toEqual({});
	});
});

describe("saved settings flow into the config builders", () => {
	const savedCfg: SavedSettings = {
		budgetFraction: 0.5,
		budgetCap: 100_000,
		tail: 10_000,
		foldAt: 0.35,
		reconTokens: 9_000,
		compact: "native",
		footerFormat: "compact",
	};

	it("configFromEnv layers saved under env", () => {
		setEnv("CONTEXTFOLD_BUDGET_FRACTION", "0.9");
		setEnv("CONTEXTFOLD_BUDGET_CAP", undefined);
		setEnv("CONTEXTFOLD_TAIL", undefined);
		const cfg = configFromEnv(savedCfg);
		expect(cfg.budgetFraction).toBe(0.9);
		expect(cfg.absoluteTokenCap).toBe(100_000);
		expect(cfg.tailTarget).toBe(10_000);
	});

	it("configFromEnv stays a sparse partial with no saved settings and no env", () => {
		for (const name of TOUCHED) setEnv(name, undefined);
		expect(configFromEnv()).toEqual({});
	});

	it("adapterConfigFromEnv picks up saved ladder, compact, and recon values", () => {
		for (const name of TOUCHED) setEnv(name, undefined);
		const acfg = adapterConfigFromEnv(savedCfg);
		expect(acfg.ladder.foldAt).toBe(0.35);
		expect(acfg.ladder.foldStep).toBe(0.12);
		expect(acfg.compact).toBe("native");
		expect(acfg.reconTokens).toBe(9_000);
		expect(acfg.footerFormat).toBe("compact");
		expect(knob("footerFormat").parse("Full")).toBe("full");
		expect(knob("footerFormat").parse("wide")).toBeUndefined();
	});
});

describe("cache warning settings", () => {
	it("defaults to 30 minutes and an opt-in send confirmation", () => {
		expect(resolveKnob(knob("cacheIdleMinutes"))).toEqual({ value: 30, source: "default" });
		expect(resolveKnob(knob("confirmColdPrompt")).value).toBe("off");
	});

	it("resolves the selected provider override beneath the environment", () => {
		const settings = { cacheIdleMinutes: 30, providerCacheIdleMinutes: { openai: 10, custom: 0 } };
		expect(resolveKnob(knob("cacheIdleMinutes"), settings, "openai").value).toBe(10);
		expect(resolveKnob(knob("cacheIdleMinutes"), settings, "custom").value).toBe(0);
		expect(resolveKnob(knob("cacheIdleMinutes"), settings, "unknown").value).toBe(30);
		setEnv("CONTEXTFOLD_CACHE_IDLE_MINUTES", "15");
		expect(resolveKnob(knob("cacheIdleMinutes"), settings, "openai")).toEqual({ value: 15, source: "env" });
	});

	it("validates each provider independently and supports disabling warnings", () => {
		expect(parseSavedSettings({ providerCacheIdleMinutes: { openai: "10", custom: "off", bad: -1, broken: {} } })).toEqual({
			providerCacheIdleMinutes: { openai: 10, custom: 0 },
		});
		expect(parseSavedSettings({ providerCacheIdleMinutes: [] })).toEqual({});
		expect(knob("cacheIdleMinutes").parse(" ")).toBeUndefined();
		expect(knob("confirmColdPrompt").parse("on")).toBe("on");
		expect(knob("confirmColdPrompt").parse("maybe")).toBeUndefined();
	});
});
