/*
 * settings.ts — the saved-settings file and the /context-fold config menu.
 *
 * Saved settings live in `<agentDir>/context-fold.json`, where agentDir mirrors Pi's own
 * resolution (PI_CODING_AGENT_DIR, else ~/.pi/agent). The file holds only knob-table keys and is
 * revalidated with the same rules as env parsing on every read, so a hand-edited or corrupt file
 * degrades to defaults instead of breaking a session. Env vars stay a per-session override on
 * top of whatever is saved; the menu flags that shadowing rather than hiding it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	KNOBS,
	parseSavedSettings,
	resolveKnob,
	type KnobKey,
	type KnobSpec,
	type KnobValue,
	type SavedSettings,
} from "./config";

/** Mirrors Pi's own agent-dir resolution (PI_CODING_AGENT_DIR, else ~/.pi/agent). */
export function agentDirPath(): string {
	const env = process.env.PI_CODING_AGENT_DIR?.trim();
	return env ? (env.startsWith("~/") ? join(homedir(), env.slice(2)) : env) : join(homedir(), ".pi", "agent");
}

export function settingsFilePath(): string {
	return join(agentDirPath(), "context-fold.json");
}

/** Missing, unreadable, or corrupt file → {} (fail-open). */
export function loadSavedSettings(path = settingsFilePath()): SavedSettings {
	try {
		return parseSavedSettings(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

/** Atomic replace (temp file + rename) so a concurrent reader never sees a truncated file. */
function writeSettings(saved: SavedSettings, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(saved, null, "\t")}\n`);
	renameSync(tmp, path);
}

export function writeSavedSetting(key: KnobKey, value: KnobValue, path = settingsFilePath(), provider?: string): void {
	const saved = loadSavedSettings(path);
	if (key === "cacheIdleMinutes" && provider && typeof value === "number") {
		saved.providerCacheIdleMinutes = { ...saved.providerCacheIdleMinutes, [provider]: value };
		writeSettings(saved, path);
	} else writeSettings({ ...saved, [key]: value }, path);
}

export function removeSavedSetting(key: KnobKey, path = settingsFilePath(), provider?: string): void {
	const saved = loadSavedSettings(path);
	if (key === "cacheIdleMinutes" && provider) {
		const { [provider]: _cleared, ...rest } = saved.providerCacheIdleMinutes ?? {};
		if (Object.keys(rest).length) saved.providerCacheIdleMinutes = rest;
		else delete saved.providerCacheIdleMinutes;
		writeSettings(saved, path);
	} else {
		const { [key]: _cleared, ...rest } = saved;
		writeSettings(rest, path);
	}
}

/** The slice of ctx.ui the menu needs; injectable so tests can script a session. */
export interface MenuUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

const DONE = "Done";
const RESET = "reset to default";

function menuRow(spec: KnobSpec, saved: SavedSettings, provider?: string): string {
	const r = resolveKnob(spec, saved, provider);
	const source = r.source === "default" ? "" : ` (${r.source})`;
	const deferred = spec.live ? "" : " [next session]";
	const scope = spec.key === "cacheIdleMinutes" && provider ? ` [${provider}]` : "";
	return `${spec.label}${scope}: ${spec.format(r.value)}${source}${deferred}`;
}

/** One-line-per-knob effective settings, for headless output and the status fallback. */
export function settingsReport(saved: SavedSettings, provider?: string): string {
	return KNOBS.map((spec) => menuRow(spec, saved, provider)).join("\n");
}

/**
 * The interactive settings loop: pick a knob, edit it, persist, live-apply, repeat until Done.
 * `applyLive` receives the full saved settings after every write so the caller re-resolves the
 * effective config in one place. Esc (select/input returning undefined) backs out.
 */
export async function runSettingsMenu(
	ui: MenuUi,
	applyLive: (saved: SavedSettings) => void,
	path = settingsFilePath(),
	provider?: string,
): Promise<void> {
	for (;;) {
		const saved = loadSavedSettings(path);
		const rows = KNOBS.map((spec) => menuRow(spec, saved, provider));
		const pick = await ui.select("context-fold settings — pick one to change", [...rows, DONE]);
		const idx = pick === undefined ? -1 : rows.indexOf(pick);
		if (idx < 0) return;
		const spec = KNOBS[idx];
		const current = resolveKnob(spec, saved, provider);

		let raw: string | undefined;
		if (spec.choices) {
			const options = saved[spec.key] !== undefined ? [...spec.choices, RESET] : [...spec.choices];
			raw = await ui.select(`${spec.label} — ${spec.hint}`, options);
		} else {
			raw = await ui.input(
				`${spec.label} — ${spec.hint} (now ${spec.format(current.value)}; 'default' clears the saved value)`,
				spec.format(current.value),
			);
		}
		const trimmed = raw?.trim();
		if (!trimmed) continue;

		if (trimmed === RESET || trimmed.toLowerCase() === "default") {
			removeSavedSetting(spec.key, path, provider);
		} else {
			const parsed = spec.parse(trimmed);
			if (parsed === undefined) {
				ui.notify(`${spec.label}: '${trimmed}' is not a valid value (${spec.hint})`, "error");
				continue;
			}
			writeSavedSetting(spec.key, parsed, path, provider);
		}

		const now = loadSavedSettings(path);
		applyLive(now);
		const effective = resolveKnob(spec, now, provider);
		if (effective.source === "env")
			ui.notify(
				`Saved, but ${spec.env} overrides it this session — effective: ${spec.format(effective.value)}`,
				"warning",
			);
		else if (!spec.live) ui.notify(`${spec.label} saved — takes effect next session`, "info");
		else ui.notify(`${spec.label} → ${spec.format(effective.value)} (applied)`, "info");
	}
}
