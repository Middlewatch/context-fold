/*
 * config.ts — the knob table and CONTEXTFOLD_* resolution. Kept import-light (no Pi types) so
 * tests can exercise the parsing without loading the extension entry point.
 *
 * Every user-facing setting is one KnobSpec row: its env var, its saved-settings key, its
 * validation, and its default all live here, so the env parser, the settings file, and the
 * /context-fold config menu cannot drift apart. Precedence per knob: default < saved file < env.
 */
import type { FoldConfig } from "./store";
import { LADDER_DEFAULTS, type LadderConfig } from "../../core/policy/fold-ladder";

/** How the extension answers Pi's hard compaction (`session_before_compact`). */
export type CompactMode = "det" | "native";

/** Footer status line: `full` adds the trigger gauge; `compact` shows the count and warnings only. */
export type FooterFormat = "full" | "compact";

export type KnobValue = number | CompactMode | FooterFormat | "on" | "off";

/** Settings persisted by the /context-fold config menu (same keys in the JSON file). */
export interface SavedSettings {
	foldAt?: number;
	foldStep?: number;
	coldFoldAt?: number;
	budgetFraction?: number;
	budgetCap?: number;
	tail?: number;
	compact?: CompactMode;
	footerFormat?: FooterFormat;
	reconTokens?: number;
	cacheIdleMinutes?: number;
	confirmColdPrompt?: "on" | "off";
	providerCacheIdleMinutes?: Record<string, number>;
}

export type KnobKey = Exclude<keyof SavedSettings, "providerCacheIdleMinutes">;

export interface KnobSpec {
	readonly key: KnobKey;
	readonly env: string;
	readonly label: string;
	/** One-line meaning shown in the menu's edit prompt. */
	readonly hint: string;
	readonly def: KnobValue;
	/** Present → the menu offers a pick list instead of free numeric input. */
	readonly choices?: readonly string[];
	/** False → a change only takes effect at the next session start. */
	readonly live: boolean;
	parse(raw: string): KnobValue | undefined;
	format(v: KnobValue): string;
}

const fraction = (raw: string): number | undefined => {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
};
const nonNegative = (raw: string): number | undefined => {
	if (raw.trim() === "") return undefined; // Number("") is 0, and blank is not a spelling of zero
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const plain = (v: KnobValue): string => String(v);
const offOrNumber = (v: KnobValue): string => (v === 0 ? "off" : String(v));

export const KNOBS: readonly KnobSpec[] = [
	{
		key: "cacheIdleMinutes",
		env: "CONTEXTFOLD_CACHE_IDLE_MINUTES",
		label: "Cache inactivity warning (minutes)",
		hint: "warn after this many idle minutes; investigate your provider's retention; 'off' or 0 disables",
		def: 30,
		live: true,
		parse: (raw) => raw === "off" ? 0 : nonNegative(raw),
		format: offOrNumber,
	},
	{
		key: "confirmColdPrompt",
		env: "CONTEXTFOLD_CONFIRM_COLD_PROMPT",
		label: "Confirm potentially cold prompts",
		hint: "interactive send confirmation when a large session's cache may have expired",
		def: "off",
		choices: ["off", "on"],
		live: true,
		parse: (raw) => raw === "on" || raw === "off" ? raw : undefined,
		format: plain,
	},
	{
		key: "foldAt",
		env: "CONTEXTFOLD_FOLD_AT",
		label: "Fold threshold",
		hint: "first fold when usage reaches this fraction of the context window (0–1]",
		def: LADDER_DEFAULTS.foldAt,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "foldStep",
		env: "CONTEXTFOLD_FOLD_STEP",
		label: "Fold step",
		hint: "a fold event must save at least this fraction of the window (0–1]",
		def: LADDER_DEFAULTS.foldStep,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "coldFoldAt",
		env: "CONTEXTFOLD_COLD_FOLD_AT",
		label: "Cold fold threshold",
		hint: "first-fold threshold when no live cache read has been observed (0–1]",
		def: LADDER_DEFAULTS.coldFoldAt,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "budgetFraction",
		env: "CONTEXTFOLD_BUDGET_FRACTION",
		label: "Budget fraction",
		hint: "fold down toward this fraction of the context window (0–1]",
		def: 0.75,
		live: true,
		parse: fraction,
		format: plain,
	},
	{
		key: "budgetCap",
		env: "CONTEXTFOLD_BUDGET_CAP",
		label: "Budget cap",
		hint: "absolute token ceiling on the budget; 'off' or 0 disables",
		def: 200_000,
		live: true,
		parse: (raw) => (raw === "off" ? 0 : nonNegative(raw)),
		format: offOrNumber,
	},
	{
		key: "tail",
		env: "CONTEXTFOLD_TAIL",
		label: "Protected tail",
		hint: "the newest ~N tokens never fold (clamped to half the budget)",
		def: 20_000,
		live: true,
		parse: nonNegative,
		format: plain,
	},
	{
		key: "compact",
		env: "CONTEXTFOLD_COMPACT",
		label: "Hard compaction",
		hint: "det = deterministic seed-index summary; native = Pi's stock LLM summary",
		def: "det",
		choices: ["det", "native"],
		live: true,
		parse: (raw) => {
			const m = raw.toLowerCase();
			return m === "det" || m === "native" ? m : undefined;
		},
		format: plain,
	},
	{
		key: "footerFormat",
		env: "CONTEXTFOLD_FOOTER_FORMAT",
		label: "Footer format",
		hint: "full = fold count, masked tokens, and the trigger gauge; compact = count and warnings only",
		def: "full",
		choices: ["full", "compact"],
		live: true,
		parse: (raw) => {
			const m = raw.toLowerCase();
			return m === "full" || m === "compact" ? m : undefined;
		},
		format: plain,
	},
	{
		key: "reconTokens",
		env: "CONTEXTFOLD_RECON_TOKENS",
		label: "Reconstruction estimate",
		hint: "input-token cost assumed for rebuilding context after /new (reset flag)",
		def: 18_000,
		live: true,
		parse: (raw) => {
			const n = Number(raw);
			return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
		},
		format: plain,
	},
];

export function knob(key: KnobKey): KnobSpec {
	const spec = KNOBS.find((s) => s.key === key);
	if (!spec) throw new Error(`unknown knob: ${key}`);
	return spec;
}

export type KnobSource = "default" | "saved" | "env";

export interface ResolvedKnob {
	value: KnobValue;
	source: KnobSource;
}

/** Effective value for one knob: env (when set and valid) over saved file over default. */
export function resolveKnob(spec: KnobSpec, saved: SavedSettings = {}, provider?: string): ResolvedKnob {
	const raw = process.env[spec.env];
	if (raw !== undefined) {
		const v = spec.parse(raw.trim());
		if (v !== undefined) return { value: v, source: "env" };
	}
	if (spec.key === "cacheIdleMinutes" && provider && saved.providerCacheIdleMinutes &&
		Object.hasOwn(saved.providerCacheIdleMinutes, provider)) {
		return { value: saved.providerCacheIdleMinutes[provider], source: "saved" };
	}
	const s = saved[spec.key];
	if (s !== undefined) return { value: s, source: "saved" };
	return { value: spec.def, source: "default" };
}

/**
 * Revalidate a settings-file payload with the same rules as env parsing; unknown keys and
 * invalid values are dropped silently (fail-open — a hand-edited file never breaks a session).
 */
export function parseSavedSettings(json: unknown): SavedSettings {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
	const out: Record<string, KnobValue> = {};
	for (const spec of KNOBS) {
		const v = (json as Record<string, unknown>)[spec.key];
		if (typeof v !== "string" && typeof v !== "number") continue;
		const parsed = spec.parse(String(v).trim());
		if (parsed !== undefined) out[spec.key] = parsed;
	}
	const saved: SavedSettings = out as SavedSettings;
	const providers = (json as Record<string, unknown>).providerCacheIdleMinutes;
	if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
		const valid: [string, number][] = [];
		for (const [provider, raw] of Object.entries(providers)) {
			if (!provider.trim() || (typeof raw !== "number" && typeof raw !== "string")) continue;
			const minutes = knob("cacheIdleMinutes").parse(String(raw).trim());
			if (typeof minutes === "number") valid.push([provider, minutes]);
		}
		if (valid.length) saved.providerCacheIdleMinutes = Object.fromEntries(valid);
	}
	return saved;
}

/** How the extension answers Pi's hard compaction, plus the other adapter-level settings. */
export interface AdapterConfig {
	ladder: LadderConfig;
	/** Reconstruction cost estimate for the reset yellow flag, in input-token equivalents. */
	reconTokens: number;
	compact: CompactMode;
	footerFormat: FooterFormat;
}

export const ADAPTER_DEFAULTS: AdapterConfig = {
	ladder: LADDER_DEFAULTS,
	reconTokens: 18_000,
	compact: "det",
	footerFormat: "full",
};

export function configFromEnv(saved: SavedSettings = {}): Partial<FoldConfig> {
	const cfg: Partial<FoldConfig> = {};
	const frac = resolveKnob(knob("budgetFraction"), saved);
	if (frac.source !== "default") cfg.budgetFraction = frac.value as number;
	const cap = resolveKnob(knob("budgetCap"), saved);
	if (cap.source !== "default") cfg.absoluteTokenCap = cap.value as number;
	const tail = resolveKnob(knob("tail"), saved);
	if (tail.source !== "default") cfg.tailTarget = tail.value as number;
	if (debugEnabled()) cfg.debug = true;
	return cfg;
}

/** One spelling of the debug switch for both the engine config and adapter diagnostics. */
export function debugEnabled(): boolean {
	return process.env.CONTEXTFOLD_DEBUG === "1" || process.env.CONTEXTFOLD_DEBUG === "true";
}

export function adapterConfigFromEnv(saved: SavedSettings = {}): AdapterConfig {
	const ladder: LadderConfig = {
		foldAt: resolveKnob(knob("foldAt"), saved).value as number,
		foldStep: resolveKnob(knob("foldStep"), saved).value as number,
		coldFoldAt: resolveKnob(knob("coldFoldAt"), saved).value as number,
	};
	const reconTokens = resolveKnob(knob("reconTokens"), saved).value as number;
	const compact = resolveKnob(knob("compact"), saved).value as CompactMode;
	const footerFormat = resolveKnob(knob("footerFormat"), saved).value as FooterFormat;
	return { ladder, reconTokens, compact, footerFormat };
}
