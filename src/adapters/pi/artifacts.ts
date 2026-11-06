/*
 * artifacts.ts — where the seed index and handoff seeds live.
 *
 * Pi normally keeps session files under `<agentDir>/sessions`, and artifacts sit beside them in
 * `<sessionDir>/context-fold/<sessionId>/`. A host can point Pi's session dir at the workspace
 * itself (`--session-dir .`, or a relative `sessionDir` in settings), which would leave untracked
 * files in the user's tree. Artifacts therefore never land inside the workspace: when the session
 * dir is the workspace or a subdirectory of it, they fall back to Pi's own default session layout,
 * `<agentDir>/sessions/<encoded sessionDir>/context-fold/<sessionId>/`. The encoded directory keeps
 * same-id sessions in different workspaces apart.
 *
 * Pure path logic. The caller supplies every root, so the rule is testable without touching disk.
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

export function resolveArtifactDir(input: {
	sessionDir: string;
	sessionId: string;
	agentDir: string;
	cwd?: string;
}): string {
	const root =
		input.cwd && isWithin(input.cwd, input.sessionDir)
			? join(input.agentDir, "sessions", encodeSessionDir(input.sessionDir), "context-fold")
			: join(input.sessionDir, "context-fold");
	return join(root, input.sessionId);
}
