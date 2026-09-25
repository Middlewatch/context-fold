/*
 * vitest.config.ts — test-time resolution for the modules Pi injects at runtime.
 *
 * Pi injects bundled peer modules at runtime. Tests resolve those modules through Pi's
 * dependency graph, whether npm nests or hoists the installed packages.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const piRequire = createRequire(resolve(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json"));

function bundled(name: string): Record<string, string> {
	try { return { [name]: piRequire.resolve(name) }; }
	catch { return {}; }
}

export default defineConfig({
	resolve: {
		alias: {
			...bundled("typebox"),
			...bundled("@earendil-works/pi-ai"),
		},
	},
});
