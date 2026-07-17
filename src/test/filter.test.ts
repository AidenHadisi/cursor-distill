import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesProjectFilter } from "../store.js";

describe("matchesProjectFilter", () => {
	it("allows all slugs when no filters are set", () => {
		assert.ok(matchesProjectFilter("Users-jane-projects-myapp", {}));
	});

	it("allows all slugs with empty arrays", () => {
		assert.ok(matchesProjectFilter("anything", {
			includeProjects: [],
			ignoreProjects: [],
		}));
	});

	it("includes only matching slugs", () => {
		const filter = { includeProjects: ["Users-jane-projects-myapp"] };
		assert.ok(matchesProjectFilter("Users-jane-projects-myapp", filter));
		assert.ok(!matchesProjectFilter("Users-jane-projects-other", filter));
	});

	it("supports * wildcards in include", () => {
		const filter = { includeProjects: ["*myapp*"] };
		assert.ok(matchesProjectFilter("Users-jane-projects-myapp", filter));
		assert.ok(matchesProjectFilter("myapp-test", filter));
		assert.ok(!matchesProjectFilter("Users-jane-projects-other", filter));
	});

	it("supports trailing * wildcard", () => {
		const filter = { includeProjects: ["Users-aidenhadisi-ezoicgit-*"] };
		assert.ok(matchesProjectFilter("Users-aidenhadisi-ezoicgit-cursor-distill", filter));
		assert.ok(matchesProjectFilter("Users-aidenhadisi-ezoicgit-sol", filter));
		assert.ok(!matchesProjectFilter("Users-aidenhadisi-other-repo", filter));
	});

	it("ignore takes priority over include", () => {
		const filter = {
			includeProjects: ["*ezoicgit*"],
			ignoreProjects: ["*cursor-distill*"],
		};
		assert.ok(matchesProjectFilter("Users-aidenhadisi-ezoicgit-sol", filter));
		assert.ok(!matchesProjectFilter("Users-aidenhadisi-ezoicgit-cursor-distill", filter));
	});

	it("ignore works without include", () => {
		const filter = { ignoreProjects: ["*test*"] };
		assert.ok(matchesProjectFilter("Users-jane-projects-myapp", filter));
		assert.ok(!matchesProjectFilter("Users-jane-test-app", filter));
	});

	it("supports multiple include patterns", () => {
		const filter = { includeProjects: ["*sol", "*corp"] };
		assert.ok(matchesProjectFilter("Users-aidenhadisi-ezoicgit-sol", filter));
		assert.ok(matchesProjectFilter("Users-aidenhadisi-ezoicgit-corp", filter));
		assert.ok(!matchesProjectFilter("Users-aidenhadisi-ezoicgit-other", filter));
	});

	it("matches are case-sensitive", () => {
		const filter = { includeProjects: ["*MyApp*"] };
		assert.ok(!matchesProjectFilter("Users-jane-projects-myapp", filter));
		assert.ok(matchesProjectFilter("Users-jane-projects-MyApp", filter));
	});

	it("treats ? as a literal, not a glob", () => {
		const filter = { includeProjects: ["foo?bar"] };
		assert.ok(matchesProjectFilter("foo?bar", filter));
		assert.ok(!matchesProjectFilter("foobar", filter));
		assert.ok(!matchesProjectFilter("fooxbar", filter));
	});
});
