import { afterEach, describe, expect, it } from "vitest";
import { READ_KIND, SNAPSHOT_KIND, WRITE_ERROR_KIND } from "../src/domain/types.ts";
import { replayFromEntries } from "../src/state/replay.ts";
import { abortedSignal, callRead, callWrite, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";

afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

describe("tool registration", () => {
	it("registers exactly todo_write and todo_read, and no commands", () => {
		const harness = makeHarness();
		expect([...harness.tools.keys()].sort()).toEqual(["todo_read", "todo_write"]);
		expect(harness.commands).toEqual([]);
	});

	it("declares write as model-only sequential with its own guidance", () => {
		const harness = makeHarness();
		const write = harness.tools.get("todo_write")!;
		expect(write.exposure).toBe("model-only");
		expect(write.executionMode).toBe("sequential");
		expect(write.promptSnippet!.length).toBeGreaterThan(0);
		expect(write.promptGuidelines!.length).toBeGreaterThan(5);
		expect(harness.tools.get("todo_read")!.exposure).toBe("direct");
	});

	it("registers a non-conflicting expand shortcut", () => {
		const harness = makeHarness();
		expect(harness.shortcuts.map((s) => s.key)).toEqual(["alt+t"]);
	});
});

describe("tool results", () => {
	it("returns a schemaVersion-3 snapshot in details and a re-writable read model", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const write = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "A", items: [{ title: "leaf" }, { title: "C", subtasks: [{ title: "x" }] }] }],
		});
		expect(write.isError).toBeFalsy();
		expect(write.details.kind).toBe(SNAPSHOT_KIND);
		expect(write.details.schemaVersion).toBe(3);
		expect(typeof write.details.revision).toBe("string");
		expect(write.structuredContent.kind).toBe(SNAPSHOT_KIND);
		expect(write.content[0].text).toContain(write.details.revision);

		const read = await callRead(harness, ctx);
		expect(read.details.kind).toBe(READ_KIND);
		expect(read.details.writable.revision).toBe(write.details.revision);
		const firstItem = read.details.writable.topics[0].items[0];
		expect(Object.keys(firstItem).sort()).toEqual(["blockedBy", "id", "status", "title"]);
	});

	it("round-trips the read `writable` object straight back into todo_write", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "Auth", items: [{ title: "analyse" }, { title: "fix", subtasks: [{ title: "spec" }, { title: "impl" }] }] }],
		});
		const read = await callRead(harness, ctx);
		// Simulate the model copying `writable` and changing one leaf's status.
		const writable = JSON.parse(JSON.stringify(read.details.writable));
		writable.topics[0].items[0].status = "completed";
		const writeBack = await callWrite(harness, ctx, { expectedRevision: writable.revision, topics: writable.topics });
		expect(writeBack.isError).toBeFalsy();
		const read2 = await callRead(harness, ctx);
		expect(read2.details.topics[0].items[0].status).toBe("completed");
	});

	it("marks invalid input as a real error and leaves state unchanged", async () => {
		const harness = makeHarness();
		const sm = newSession();
		const ctx = makeCtx(sm);
		await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] });
		const before = JSON.stringify(replayFromEntries(sm.getBranch()).snapshot);

		const bad = await callWrite(harness, ctx, { expectedRevision: "wrong", topics: [] });
		expect(bad.isError).toBe(true);
		expect(bad.details.kind).toBe(WRITE_ERROR_KIND);
		expect(JSON.stringify(replayFromEntries(sm.getBranch()).snapshot)).toBe(before);
	});

	it("rejects a fourth topic as an error result", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const t = (title: string) => ({ title, items: [{ title: "L" }] });
		const result = await callWrite(harness, ctx, { expectedRevision: "", topics: [t("A"), t("B"), t("C"), t("D")] });
		expect(result.isError).toBe(true);
		expect(result.details.kind).toBe(WRITE_ERROR_KIND);
	});

	it("rejects a container that declares status (domain-level, schema-bypassing)", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const result = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "A", items: [{ title: "C", subtasks: [{ title: "x" }], status: "pending" } as never] }],
		});
		expect(result.isError).toBe(true);
	});
});

describe("real-tool cancellation path", () => {
	it("cancels the last leaf and prunes the emptied container and topic", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "Solo", items: [{ title: "C", subtasks: [{ title: "only" }] }] }],
		});
		const topic = created.details.topics[0];
		const container = topic.items[0];
		const leafId = container.subtasks[0].id;

		const cancelled = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			removeIds: [leafId],
			topics: [{ id: topic.id, title: "Solo", items: [{ id: container.id, title: "C", subtasks: [] }] }],
		});
		expect(cancelled.isError).toBeFalsy();
		expect(cancelled.details.topics).toEqual([]);
		expect(cancelled.details.summary.cancelled.some((c: string) => c.includes("cancelled container"))).toBe(true);
		expect(cancelled.details.summary.cancelled.some((c: string) => c.includes("emptied by cancellation"))).toBe(true);
		expect((await callRead(harness, ctx)).details.topics).toEqual([]);
	});

	it("cancels all items of a topic via removeIds and prunes the empty topic", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "T", items: [{ title: "a" }, { title: "b" }] }] });
		const topic = created.details.topics[0];
		const cancelled = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			removeIds: [topic.items[0].id, topic.items[1].id],
			topics: [{ id: topic.id, title: "T", items: [] }],
		});
		expect(cancelled.isError).toBeFalsy();
		expect(cancelled.details.topics).toEqual([]);
		expect(cancelled.details.summary.cancelled.filter((c: string) => c.includes("cancelled item-leaf")).length).toBe(2);
	});

	it("still rejects a new empty topic and a new empty container via the real tool", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		expect((await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [] }] })).isError).toBe(true);
		expect((await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "C", subtasks: [] }] }] })).isError).toBe(true);
	});

	it("rejects converting an existing leaf into a container and vice versa via the real tool", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "A", items: [{ title: "leaf" }, { title: "C", subtasks: [{ title: "x" }] }] }],
		});
		const topic = created.details.topics[0];
		const leafId = topic.items[0].id;
		const containerId = topic.items[1].id;
		const containerLeafId = topic.items[1].subtasks[0].id;

		const leafToContainer = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			topics: [
				{
					id: topic.id,
					title: "A",
					items: [
						{ id: leafId, title: "leaf", subtasks: [{ title: "y" }] } as never,
						{ id: containerId, title: "C", subtasks: [{ id: containerLeafId, title: "x" }] },
					],
				},
			],
		});
		expect(leafToContainer.isError).toBe(true);

		const containerToLeaf = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			topics: [
				{
					id: topic.id,
					title: "A",
					items: [
						{ id: leafId, title: "leaf" },
						{ id: containerId, title: "C" } as never,
					],
				},
			],
		});
		expect(containerToLeaf.isError).toBe(true);
	});
});

describe("abort handling", () => {
	it("does not write or emit a success snapshot when pre-cancelled", async () => {
		const harness = makeHarness();
		const sm = newSession();
		const ctx = makeCtx(sm);
		await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] });
		const revisionBefore = (await callRead(harness, ctx)).details.revision;

		const cancelled = await callWrite(
			harness,
			ctx,
			{ expectedRevision: revisionBefore, topics: [{ title: "B", items: [{ title: "y" }] }] },
			{ signal: abortedSignal(), persist: false },
		);
		expect(cancelled.isError).toBe(true);
		expect(cancelled.details.kind).toBe(WRITE_ERROR_KIND);
		expect(cancelled.details.revision).toBe(revisionBefore);
		const after = await callRead(harness, ctx);
		expect(after.details.revision).toBe(revisionBefore);
		expect(after.details.topics.map((t: { title: string }) => t.title)).toEqual(["A"]);
	});

	it("rejects a read when pre-cancelled", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const result = await callRead(harness, ctx, abortedSignal());
		expect(result.isError).toBe(true);
	});
});
