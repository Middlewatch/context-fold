/*
 * artifacts.test.ts — artifact placement never lands inside the workspace.
 *
 * Pi normally puts artifacts beside its session files. A host that sets the session dir to the
 * workspace (or a subdirectory) must not turn a fold into untracked files, so those sessions fall
 * back under the agent dir.
 */
import { describe, it, expect } from "vitest";
import { isWithin, resolveArtifactDir } from "../src/adapters/pi/artifacts";

const agentDir = "/home/user/.pi/agent";

describe("artifact placement", () => {
	it("keeps a normal session-dir layout", () => {
		expect(
			resolveArtifactDir({
				sessionDir: "/home/user/.pi/agent/sessions/--repo--",
				sessionId: "s1",
				agentDir,
				cwd: "/home/user/repo",
			}),
		).toBe("/home/user/.pi/agent/sessions/--repo--/context-fold/s1");
	});

	it("falls back to Pi's default session layout when the session dir is the workspace", () => {
		expect(
			resolveArtifactDir({
				sessionDir: "/home/user/repo",
				sessionId: "s1",
				agentDir,
				cwd: "/home/user/repo",
			}),
		).toBe("/home/user/.pi/agent/sessions/--home-user-repo--/context-fold/s1");
	});

	it("falls back when the session dir is a workspace subdirectory", () => {
		expect(
			resolveArtifactDir({
				sessionDir: "/home/user/repo/.sessions",
				sessionId: "s1",
				agentDir,
				cwd: "/home/user/repo",
			}),
		).toBe("/home/user/.pi/agent/sessions/--home-user-repo-.sessions--/context-fold/s1");
	});

	it("keeps a custom dir outside the workspace, including a workspace parent", () => {
		expect(
			resolveArtifactDir({
				sessionDir: "/mnt/sessions",
				sessionId: "s1",
				agentDir,
				cwd: "/home/user/repo",
			}),
		).toBe("/mnt/sessions/context-fold/s1");
		expect(
			resolveArtifactDir({
				sessionDir: "/home/user",
				sessionId: "s1",
				agentDir,
				cwd: "/home/user/repo",
			}),
		).toBe("/home/user/context-fold/s1");
	});

	it("does not require a cwd", () => {
		expect(
			resolveArtifactDir({ sessionDir: "/tmp/sessions", sessionId: "s1", agentDir }),
		).toBe("/tmp/sessions/context-fold/s1");
	});

	it("compares resolved paths, so `..` cannot slip inside", () => {
		expect(isWithin("/home/user/repo", "/home/user/repo/../repo/.sessions")).toBe(true);
		expect(isWithin("/home/user/repo", "/home/user/repository")).toBe(false);
	});
});
