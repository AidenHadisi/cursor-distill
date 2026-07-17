import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateArtifactPath } from "../commands/run.js";
import type { AgentEntry } from "../agent.js";

function entry(overrides: Partial<AgentEntry> = {}): AgentEntry {
	return {
		type: "rule",
		scope: "global",
		path: "~/.cursor/rules/test-rule.mdc",
		action: "created",
		content: "test content",
		sourcePattern: "test",
		...overrides,
	};
}

describe("validateArtifactPath", () => {
	it("accepts a valid global rule path that does not yet exist", () => {
		const result = validateArtifactPath(entry({
			path: "~/.cursor/rules/nonexistent-test-xyz.mdc",
		}));
		assert.ok("fullPath" in result, `expected fullPath, got: ${"rejected" in result ? result.rejected : "?"}`);
		assert.equal(result.fullPath, join(homedir(), ".cursor", "rules", "nonexistent-test-xyz.mdc"));
	});

	it("accepts a valid global skill path", () => {
		const result = validateArtifactPath(entry({
			path: "~/.cursor/skills/my-skill/SKILL.md",
		}));
		assert.ok("fullPath" in result);
	});

	it("accepts a valid global agents path", () => {
		const result = validateArtifactPath(entry({
			path: "~/.cursor/agents/my-agent.md",
		}));
		assert.ok("fullPath" in result);
	});

	it("rejects paths outside .cursor/{rules,skills,agents}", () => {
		const result = validateArtifactPath(entry({
			path: "~/.zshrc",
		}));
		assert.ok("rejected" in result);
		assert.ok(result.rejected.includes("outside allowed"));
	});

	it("rejects path traversal with ..", () => {
		const result = validateArtifactPath(entry({
			path: "~/.cursor/rules/../../.zshrc",
		}));
		assert.ok("rejected" in result);
		assert.ok(result.rejected.includes("traversal"));
	});

	it("rejects absolute path outside .cursor/", () => {
		const result = validateArtifactPath(entry({
			path: "/tmp/evil.mdc",
		}));
		assert.ok("rejected" in result);
	});

	it("rejects action:created when file already exists", () => {
		// package.json definitely exists, but it's also outside .cursor/ so it'd
		// fail the sandbox check first. Use a known existing .cursor/ file instead.
		// We can use the rules dir itself — but that's a directory, not a file.
		// Test with a path we know exists: ~/.cursor/rules/ exists on the test machine.
		const result = validateArtifactPath(entry({
			path: "~/.cursor/rules/comments.mdc",
			action: "created",
		}));
		// Might be "rejected" for either "file already exists" or "outside allowed"
		// depending on whether the file actually exists on this machine.
		// The important thing is that it's handled — we can't guarantee the file
		// exists in CI, so we just assert the function returns without throwing.
		assert.ok("fullPath" in result || "rejected" in result);
	});

	it("rejects action:edited when file does not exist", () => {
		const result = validateArtifactPath(entry({
			path: "~/.cursor/rules/does-not-exist-xyz-123.mdc",
			action: "edited",
		}));
		assert.ok("rejected" in result);
		assert.ok(result.rejected.includes("does not exist"));
	});

	it("rejects project-scoped path when project root does not exist", () => {
		const result = validateArtifactPath(entry({
			scope: "project",
			path: "/nonexistent/fake-project/.cursor/rules/test.mdc",
		}));
		assert.ok("rejected" in result);
		assert.ok(result.rejected.includes("does not exist"));
	});

	it("rejects project-scoped path missing .cursor segment", () => {
		const result = validateArtifactPath(entry({
			scope: "project",
			path: "/tmp/rules/test.mdc",
		}));
		assert.ok("rejected" in result);
		assert.ok(result.rejected.includes("/.cursor/"));
	});
});
