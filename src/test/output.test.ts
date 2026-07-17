import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput, extractJson } from "../agent.js";

describe("extractJson", () => {
	it("parses a raw JSON array", () => {
		const result = extractJson('[{"summary":"test"}]');
		assert.deepEqual(result, [{ summary: "test" }]);
	});

	it("parses JSON inside a fenced code block", () => {
		const result = extractJson('Some text\n```json\n[{"a":1}]\n```\nMore text');
		assert.deepEqual(result, [{ a: 1 }]);
	});

	it("falls back to bracket extraction", () => {
		const result = extractJson('Here is the output: [{"b":2}] done.');
		assert.deepEqual(result, [{ b: 2 }]);
	});

	it("returns null for non-array JSON", () => {
		assert.equal(extractJson('{"type":"object"}'), null);
	});

	it("returns null for garbage", () => {
		assert.equal(extractJson("not json at all"), null);
	});
});

describe("parseAgentOutput", () => {
	it("parses a valid Cursor CLI JSON envelope", () => {
		const envelope = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: '[{"summary":"extracted"}]',
		});
		assert.deepEqual(parseAgentOutput(envelope), [{ summary: "extracted" }]);
	});

	it("parses envelope where result contains fenced JSON", () => {
		const fenced = 'Here it is:\n```json\n[{"key":"val"}]\n```\n';
		const envelope = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: fenced,
		});
		assert.deepEqual(parseAgentOutput(envelope), [{ key: "val" }]);
	});

	it("falls back to raw extractJson for non-envelope stdout", () => {
		assert.deepEqual(parseAgentOutput('[{"fallback":true}]'), [{ fallback: true }]);
	});

	it("falls back when envelope has wrong type field", () => {
		const envelope = JSON.stringify({
			type: "error",
			result: '[{"x":1}]',
		});
		assert.equal(parseAgentOutput(envelope), null);
	});

	it("falls back when envelope result is not a string", () => {
		const envelope = JSON.stringify({
			type: "result",
			result: 42,
		});
		assert.equal(parseAgentOutput(envelope), null);
	});

	it("returns null for complete garbage", () => {
		assert.equal(parseAgentOutput("this is not json"), null);
	});

	it("handles empty array in envelope result", () => {
		const envelope = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "[]",
		});
		assert.deepEqual(parseAgentOutput(envelope), []);
	});
});
