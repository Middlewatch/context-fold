/*
 * artifacts.test.ts — artifact placement never lands inside the workspace.
 *
 * Pi normally puts artifacts beside its session files. A host that sets the session dir to the
 * workspace (or a subdirectory) must not turn a fold into untracked files, and an in-memory session
 * reports an empty dir. Both fall back under the agent dir.
 */
import { describe, it, expect } from "vitest";
import { isWithin, resolveArtifactDir } from "../src/adapters/pi/artifacts";

const agentDir = "/home/user/.pi/agent";

const placements = [
	{
		name: "keeps a normal session-dir layout",
		sessionDir: "/home/user/.pi/agent/sessions/--repo--",
		cwd: "/home/user/repo",
		expected: "/home/user/.pi/agent/sessions/--repo--/context-fold/s1",
	},
	{
		name: "falls back when the session dir is the workspace",
		sessionDir: "/home/user/repo",
		cwd: "/home/user/repo",
		expected: "/home/user/.pi/agent/sessions/--home-user-repo--/context-fold/s1",
	},
	{
		name: "falls back when an in-memory session reports an empty session dir",
		sessionDir: "",
		cwd: "/home/user/repo",
		expected: "/home/user/.pi/agent/sessions/--home-user-repo--/context-fold/s1",
	},
	{
		name: "falls back when the session dir is a workspace subdirectory",
		sessionDir: "/home/user/repo/.sessions",
		cwd: "/home/user/repo",
		expected: "/home/user/.pi/agent/sessions/--home-user-repo-.sessions--/context-fold/s1",
	},
	{
		name: "resolves a relative session dir against the workspace",
		sessionDir: ".sessions",
		cwd: "/home/user/repo",
		expected: "/home/user/.pi/agent/sessions/--home-user-repo-.sessions--/context-fold/s1",
	},
	{
		name: "keeps a custom dir outside the workspace",
		sessionDir: "/mnt/sessions",
		cwd: "/home/user/repo",
		expected: "/mnt/sessions/context-fold/s1",
	},
	{
		name: "keeps a workspace parent",
		sessionDir: "/home/user",
		cwd: "/home/user/repo",
		expected: "/home/user/context-fold/s1",
	},
];

describe("artifact placement", () => {
	it.each(placements)("$name", ({ sessionDir, cwd, expected }) => {
		expect(resolveArtifactDir({ sessionDir, sessionId: "s1", agentDir, cwd })).toBe(expected);
	});

	it("compares resolved paths, so `..` cannot slip inside", () => {
		expect(isWithin("/home/user/repo", "/home/user/repo/../repo/.sessions")).toBe(true);
		expect(isWithin("/home/user/repo", "/home/user/repository")).toBe(false);
	});
});
