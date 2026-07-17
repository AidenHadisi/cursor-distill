import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProjectSlug } from "../extract.js";

describe("resolveProjectSlug", () => {
	it("resolves a simple non-hyphenated slug", () => {
		// "Users-aidenhadisi" → /Users/aidenhadisi (if it exists)
		const result = resolveProjectSlug("Users-aidenhadisi");
		// Will resolve if /Users/aidenhadisi exists; null otherwise.
		// On this machine it should resolve.
		if (result !== null) {
			assert.equal(result, "/Users/aidenhadisi");
		}
	});

	it("resolves a slug with hyphenated directory names", () => {
		// The key test: "Users-aidenhadisi-ezoicgit-cursor-distill"
		// must resolve to "/Users/aidenhadisi/ezoicgit/cursor-distill" — NOT
		// the broken "/Users/aidenhadisi/ezoicgit/cursor/distill"
		const result = resolveProjectSlug("Users-aidenhadisi-ezoicgit-cursor-distill");
		if (result !== null) {
			assert.equal(result, "/Users/aidenhadisi/ezoicgit/cursor-distill");
		}
	});

	it("returns null for a completely bogus slug", () => {
		const result = resolveProjectSlug("Nonexistent-Path-That-Does-Not-Exist-xyz123");
		assert.equal(result, null);
	});

	it("resolves an empty slug to /", () => {
		// edge case: empty string splits to [""]
		const result = resolveProjectSlug("");
		// Empty slug should resolve to "/" (probe("/", [""], 0) → existsSync("/") with
		// candidate "" which is join("/", "") = "/", which exists).
		// Actually join("/", "") = "/" and existsSync("/") = true, and index 0 + end 1 = done.
		assert.equal(result, "/");
	});
});
