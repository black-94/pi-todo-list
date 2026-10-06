import { afterEach, describe, expect, it } from "vitest";
import { callRead, callWrite, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";

afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

describe("smoke", () => {
	it("registers exactly two tools and writes/reads a mixed tree", async () => {
		const harness = makeHarness();
		expect([...harness.tools.keys()].sort()).toEqual(["todo_read", "todo_write"]);
		expect(harness.commands).toEqual([]);

		const ctx = makeCtx(newSession());
		const write = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "Auth", items: [{ title: "analyse" }, { title: "fix", subtasks: [{ title: "spec" }] }] }],
		});
		expect(write.isError).toBeFalsy();
		const read = await callRead(harness, ctx);
		expect(read.content[0].text).toContain("Auth");
		expect(read.content[0].text).toContain("analyse");
	});
});
