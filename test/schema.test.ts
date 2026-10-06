import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { TodoReadParamsSchema, TodoWriteParamsSchema } from "../src/tool/schemas.ts";

function accepts(write: unknown): boolean {
	return Value.Check(TodoWriteParamsSchema, write);
}

function wrap(items: unknown[], title = "A") {
	return { expectedRevision: "", topics: [{ title, items }] };
}

describe("todo_write schema validation (TypeBox additionalProperties:false)", () => {
	it("accepts a mixed tree and a minimal leaf", () => {
		expect(accepts(wrap([{ title: "analyse" }, { title: "fix", subtasks: [{ title: "spec" }] }]))).toBe(true);
		expect(accepts({ expectedRevision: "", topics: [] })).toBe(true);
	});

	it("rejects container status and blockedBy", () => {
		expect(accepts(wrap([{ title: "C", subtasks: [{ title: "x" }], status: "pending" }]))).toBe(false);
		expect(accepts(wrap([{ title: "C", subtasks: [{ title: "x" }], blockedBy: [] }]))).toBe(false);
	});

	it("rejects a leaf that carries subtasks together with status", () => {
		expect(accepts(wrap([{ title: "x", subtasks: [{ title: "y" }], status: "pending" }]))).toBe(false);
	});

	it("rejects unknown fields on items, topics, and the root", () => {
		expect(accepts(wrap([{ title: "x", bogus: 1 }]))).toBe(false);
		expect(accepts({ expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }], extra: true }] })).toBe(false);
		expect(accepts({ expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }], extra: true })).toBe(false);
	});

	it("accepts empty subtasks/items (domain prunes only existing emptied containers) and rejects bad types", () => {
		// Empty arrays are schema-valid so an explicit cancellation of the last
		// leaf can be expressed; the domain rejects *new* empty containers/topics.
		expect(accepts(wrap([{ title: "C", subtasks: [] }]))).toBe(true);
		expect(accepts({ expectedRevision: "", topics: [{ title: "A", items: [] }] })).toBe(true);
		expect(accepts(wrap([{ title: "x", blockedBy: [1] }]))).toBe(false);
		expect(accepts(wrap([{ title: "x", status: "done" }]))).toBe(false);
		expect(accepts(wrap([{ title: "x", id: 5 }]))).toBe(false);
		expect(accepts(wrap([{ title: "C", subtasks: "nope" }]))).toBe(false);
	});

	it("accepts valid keys, ids, and dependencies", () => {
		expect(accepts(wrap([{ key: "k", title: "x" }, { title: "y", blockedBy: ["k"] }]))).toBe(true);
	});

	it("todo_read rejects arguments", () => {
		expect(Value.Check(TodoReadParamsSchema, {})).toBe(true);
		expect(Value.Check(TodoReadParamsSchema, { bogus: 1 })).toBe(false);
	});
});
