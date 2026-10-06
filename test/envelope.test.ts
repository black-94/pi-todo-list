import { afterEach, describe, expect, it } from "vitest";
import { parseSnapshotPayload } from "../src/domain/snapshot.ts";
import { replayFromEntries } from "../src/state/replay.ts";
import { __resetStore } from "../src/state/store.ts";
import { appendUserMessage, callRead, callWrite, emit, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";

afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

describe("real write envelope is replay-compatible", () => {
	it("parses the exact details returned by the registered tool", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const write = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] });
		expect(write.details.kind).toBe("pi-todo-list.snapshot");
		expect(write.details.changed).toBe(true);
		expect(write.details.summary).toBeDefined();
		const parsed = parseSnapshotPayload(write.details);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.snapshot.revision).toBe(write.details.revision);
	});

	it("replays a real envelope after the cache is cleared and a new factory is used", async () => {
		const sm = newSession();
		appendUserMessage(sm, "start");
		const harness = makeHarness();
		const write = await callWrite(harness, ctxOf(sm), {
			expectedRevision: "",
			topics: [
				{
					title: "Auth",
					items: [
						{ title: "analyse" },
						{ title: "fix", subtasks: [{ title: "spec" }, { title: "impl" }] },
					],
				},
			],
		});
		const original = JSON.parse(JSON.stringify(write.details.topics));

		// Clear the in-memory cache and register a fresh factory, then restore from
		// the branch only.
		__resetStore();
		const harness2 = makeHarness();
		await emit(harness2, "session_start", makeCtx(sm));

		const replay = replayFromEntries(sm.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.revision).toBe(write.details.revision);

		const read = await callRead(harness2, makeCtx(sm));
		expect(read.details.revision).toBe(write.details.revision);
		expect(read.content[0].text).toContain("Auth");
		expect(replay.snapshot.topics).toEqual(original);
	});

	it("preserves stable IDs, status, and dependencies across a cleared-cache replay", async () => {
		const sm = newSession();
		appendUserMessage(sm, "start");
		const harness = makeHarness();
		const ctx = makeCtx(sm);
		const created = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [
				{
					title: "Auth",
					items: [
						{ title: "first" },
						{ title: "second", subtasks: [{ title: "spec" }, { title: "impl" }] },
					],
				},
			],
		});
		const topic = created.details.topics[0];
		const firstId = topic.items[0].id;
		const containerId = topic.items[1].id;
		const specId = topic.items[1].subtasks[0].id;
		const implId = topic.items[1].subtasks[1].id;

		// Complete the layer-2 leaf and start a layer-3 leaf dependent on it.
		const second = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			topics: [
				{
					id: topic.id,
					title: "Auth",
					items: [
						{ id: firstId, title: "first", status: "completed" },
						{ id: containerId, title: "second", subtasks: [{ id: specId, title: "spec", status: "in_progress", blockedBy: [firstId] }, { id: implId, title: "impl" }] },
					],
				},
			],
		});
		expect(second.isError, JSON.stringify(second.details)).toBeFalsy();

		__resetStore();
		const read = await callRead(makeHarness(), makeCtx(sm));
		const restoredTopic = read.details.topics[0];
		expect(restoredTopic.items[0].id).toBe(firstId);
		expect(restoredTopic.items[0].status).toBe("completed");
		expect(restoredTopic.items[1].id).toBe(containerId);
		expect(restoredTopic.items[1].subtasks[0].id).toBe(specId);
		expect(restoredTopic.items[1].subtasks[0].blockedBy).toEqual([firstId]);
		expect(restoredTopic.items[1].subtasks[0].isBlocked).toBe(false);
		expect(replayFromEntries(sm.getBranch()).diagnostics).toEqual([]);
	});

	it("replays a real retained completed topic after the last leaf completes", async () => {
		const sm = newSession();
		appendUserMessage(sm, "start");
		const harness = makeHarness();
		const ctx = makeCtx(sm);
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "Solo", items: [{ title: "only" }] }] });
		const leafId = created.details.topics[0].items[0].id;
		const done = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			topics: [{ id: created.details.topics[0].id, title: "Solo", items: [{ id: leafId, title: "only", status: "completed" }] }],
		});
		expect(done.details.topics).toHaveLength(1);
		expect(done.details.topics[0].title).toBe("Solo");
		expect(done.details.topics[0].completedSeq).toBeTypeOf("number");
		expect(done.details.summary.completedTopics).toEqual(["Solo"]);
		expect(done.details.summary.evictedTopics).toEqual([]);
		expect(done.details.revision).not.toBe(created.details.revision);

		__resetStore();
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.revision).toBe(done.details.revision);
		expect(replay.snapshot.topics).toHaveLength(1);
		expect(replay.snapshot.topics[0]!.completedSeq).toBe(done.details.topics[0].completedSeq);

		const read = await callRead(makeHarness(), makeCtx(sm));
		expect(read.details.revision).toBe(done.details.revision);
		expect(read.details.topics[0].title).toBe("Solo");
		expect(read.details.topics[0].completed).toBe(true);
		expect(read.details.topics[0].items[0].status).toBe("completed");
	});

	it("flags a corrupt envelope summary as a diagnostic instead of resurrecting old state", async () => {
		const sm = newSession();
		appendUserMessage(sm, "start");
		const harness = makeHarness();
		const ctx = makeCtx(sm);
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] });
		// Append a corrupt same-schema envelope after the valid one.
		const corrupt = { ...created.details, summary: { ...created.details.summary, cancelled: 5 } };
		sm.appendMessage({ role: "toolResult", toolCallId: "bad", toolName: "todo_write", content: [{ type: "text", text: "x" }], details: corrupt, isError: false, timestamp: Date.now() } as never);

		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe(created.details.revision);
		expect(replay.diagnostics.some((d) => d.includes("corrupt"))).toBe(true);
	});
});

function ctxOf(sm: ReturnType<typeof newSession>) {
	return makeCtx(sm);
}
