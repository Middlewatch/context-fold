/*
 * Where the seed index and handoff seeds live. A session dir inside the workspace (including an
 * in-memory session's empty one) would leave an untracked `context-fold/` in the user's tree, so
 * those sessions fall back under the agent dir.
 */
import { isAbsolute, join, relative, resolve } from "node:path";

/** True when `child` is `parent` itself or nested inside it. */
export function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Pi's own cwd encoding for a default session directory name (`--home-user-repo--`). */
function encodeSessionDir(sessionDir: string): string {
	return `--${resolve(sessionDir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function resolveArtifactDir({
	sessionDir,
	sessionId,
	agentDir,
	cwd,
}: {
	sessionDir: string;
	sessionId: string;
	agentDir: string;
	cwd: string;
}): string {
	const dir = resolve(cwd, sessionDir);
	return isWithin(cwd, dir)
		? join(agentDir, "sessions", encodeSessionDir(dir), "context-fold", sessionId)
		: join(dir, "context-fold", sessionId);
}
