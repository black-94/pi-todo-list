import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseSnapshotPayload } from "../src/domain/snapshot.ts";
import { replayFromEntries } from "../src/state/replay.ts";
import { __resetStore } from "../src/state/store.ts";
import { appendUserMessage, appendWriteResult, callRead, callWrite, emit, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";

afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

/** A one-leaf topic input. */
function t(title: string) {
	return { title, items: [{ title: "L" }] };
}

/** Preserve a stored (details) topic's statuses when resubmitting it. */
function preserve(topic: { id: string; title: string; items: Array<Record<string, unknown>> }) {
	return {
		id: topic.id,
		title: topic.title,
		items: topic.items.map((item) => ({
			id: item.id as string,
			title: item.title as string,
			status: item.status as "pending" | "in_progress" | "completed" | undefined,
		})),
	};
}

/** Force a one-leaf topic's leaf to `status`. */
function mark(topic: { id: string; title: string; items: Array<{ id: string; title: string }> }, status: "completed" | "pending") {
	return { id: topic.id, title: topic.title, items: [{ id: topic.items[0]!.id, title: topic.items[0]!.title, status }] };
}

describe("completed-topic retention and folding", () => {
	it("returns the full completed hierarchy on read while the display folds it to one row", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "Done", items: [{ title: "d1" }, { title: "d2" }] }] });
		const topic = created.details.topics[0];
		const done = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			topics: [
				{
					id: topic.id,
					title: "Done",
					items: [
						{ id: topic.items[0].id, title: "d1", status: "completed" },
						{ id: topic.items[1].id, title: "d2", status: "completed" },
					],
				},
			],
		});
		expect(done.isError).toBeFalsy();

		const read = await callRead(harness, ctx);
		expect(read.details.topics[0].items).toHaveLength(2);
		expect(read.details.topics[0].completed).toBe(true);
		expect(read.details.completedTopicCount).toBe(1);
		expect(read.details.display.filter((row: { topicId: string }) => row.topicId === topic.id)).toHaveLength(1);
		// The model-facing text still carries every descendant.
		expect(read.content[0].text).toContain("d1");
		expect(read.content[0].text).toContain("d2");
	});

	it("round-trips the writable projection without losing completion metadata", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [t("Solo")] });
		const topic = created.details.topics[0];
		const done = await callWrite(harness, ctx, { expectedRevision: created.details.revision, topics: [mark(topic, "completed")] });
		const seq = done.details.topics[0].completedSeq;
		expect(typeof seq).toBe("number");

		const read = await callRead(harness, ctx);
		expect(JSON.stringify(read.details.writable)).not.toContain("completedSeq");
		const back = await callWrite(harness, ctx, { expectedRevision: read.details.writable.revision, topics: read.details.writable.topics });
		expect(back.isError).toBeFalsy();
		expect(back.details.changed).toBe(false);
		expect(back.details.topics[0].completedSeq).toBe(seq);
	});

	it("rename and reorder do not change eviction priority", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [t("A"), t("B"), t("C")] });
		const [a, b, c] = created.details.topics as Array<{ id: string; title: string; items: Array<{ id: string; title: string }> }>;
		// Complete A, then B.
		let r = await callWrite(harness, ctx, { expectedRevision: created.details.revision, topics: [mark(a!, "completed"), preserve(b as never), preserve(c as never)] });
		r = await callWrite(harness, ctx, {
			expectedRevision: r.details.revision,
			topics: [mark(r.details.topics[0], "completed"), mark(r.details.topics[1], "completed"), preserve(r.details.topics[2])],
		});
		// Rename A and reorder (C, B, A2); no new topic, so no eviction.
		const renamed = await callWrite(harness, ctx, {
			expectedRevision: r.details.revision,
			topics: [
				{ ...preserve(r.details.topics[2]), title: "C2" },
				mark(r.details.topics[1], "completed"),
				{ ...mark(r.details.topics[0], "completed"), title: "A2" },
			],
		});
		expect(renamed.isError).toBeFalsy();
		expect(renamed.details.summary.evictedTopics).toEqual([]);

		// Adding D still evicts the earliest-completed topic (A, now renamed/moved).
		const after = await callRead(harness, ctx);
		const inputs = after.details.writable.topics.map(preserve);
		const added = await callWrite(harness, ctx, { expectedRevision: after.details.writable.revision, topics: [...inputs, t("D")] });
		expect(added.isError).toBeFalsy();
		expect(added.details.summary.evictedTopics).toEqual(["A2"]);
		expect(added.details.topics.map((x: { title: string }) => x.title).sort()).toEqual(["B", "C2", "D"]);
	});

	it("validates the whole candidate before eviction so a bad evicted topic is not masked", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "l1" }, { title: "l2" }] }, t("B"), t("C")] });
		const a = created.details.topics[0];
		const [l1, l2] = a.items;
		const completed = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			topics: [
				{ id: a.id, title: "A", items: [{ id: l1.id, title: "l1", status: "completed" }, { id: l2.id, title: "l2", status: "completed" }] },
				preserve(created.details.topics[1]),
				preserve(created.details.topics[2]),
			],
		});
		expect(completed.isError).toBeFalsy();
		const bLeafId = completed.details.topics[1].items[0].id;
		const revisionBefore = completed.details.revision;

		// The eviction candidate A carries a cross-topic dependency. Validation
		// must fail on the full candidate; evicting A first would hide it.
		const bad = await callWrite(harness, ctx, {
			expectedRevision: revisionBefore,
			topics: [
				{ id: a.id, title: "A", items: [{ id: l1.id, title: "l1", status: "completed" }, { id: l2.id, title: "l2", status: "completed", blockedBy: [bLeafId] }] },
				preserve(completed.details.topics[1]),
				preserve(completed.details.topics[2]),
				t("D"),
			],
		});
		expect(bad.isError).toBe(true);
		expect(bad.details.message).toContain("another topic");
		const read = await callRead(harness, ctx);
		expect(read.details.revision).toBe(revisionBefore);
		expect(read.details.topics.map((x: { title: string }) => x.title).sort()).toEqual(["A", "B", "C"]);
		expect(read.details.topics[0].items).toHaveLength(2); // A was not evicted
	});

	it("replays an explicitly emptied snapshot as empty after clearing the cache", async () => {
		const sm = newSession();
		appendUserMessage(sm, "start");
		const harness = makeHarness();
		const ctx = makeCtx(sm);
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "Solo", items: [{ title: "C", subtasks: [{ title: "only" }] }] }] });
		const topic = created.details.topics[0];
		const container = topic.items[0];
		const leafId = container.subtasks[0].id;
		const cancelled = await callWrite(harness, ctx, {
			expectedRevision: created.details.revision,
			removeIds: [leafId],
			topics: [{ id: topic.id, title: "Solo", items: [{ id: container.id, title: "C", subtasks: [] }] }],
		});
		expect(cancelled.details.topics).toEqual([]);
		expect(cancelled.details.summary.completedTopics).toEqual([]);
		expect(cancelled.details.summary.evictedTopics).toEqual([]);
		expect(cancelled.details.summary.cancelled.some((x: string) => x.includes("cancelled container"))).toBe(true);

		__resetStore();
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.topics).toEqual([]);
		expect(replay.snapshot.revision).toBe(cancelled.details.revision);
	});

	it("reads a legacy v2 snapshot and migrates completion order on the next write", async () => {
		const sm = newSession();
		appendUserMessage(sm, "start");
		appendWriteResult(sm, "wv2", {
			kind: "pi-todo-list.snapshot",
			schemaVersion: 2,
			revision: "r-v2",
			topics: [{ id: "t1", title: "Legacy", items: [{ type: "leaf", id: "l1", title: "L", status: "completed", blockedBy: [] }] }],
		});
		const harness = makeHarness();
		const ctx = makeCtx(sm);
		const read = await callRead(harness, ctx);
		expect(read.details.revision).toBe("r-v2");
		expect(read.details.topics[0].completed).toBe(true);

		const added = await callWrite(harness, ctx, {
			expectedRevision: "r-v2",
			topics: [{ id: "t1", title: "Legacy", items: [{ id: "l1", title: "L", status: "completed" }] }, t("New")],
		});
		expect(added.isError).toBeFalsy();
		expect(added.details.schemaVersion).toBe(3);
		expect(typeof added.details.topics[0].completedSeq).toBe("number");
		expect(added.details.topics.map((x: { title: string }) => x.title)).toEqual(["Legacy", "New"]);
	});

	it("strictly rejects corrupt completion metadata but accepts the real writer output", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const write = await callWrite(harness, ctx, { expectedRevision: "", topics: [t("A")] });
		expect(parseSnapshotPayload(write.details).ok).toBe(true);
		const corrupt = { ...write.details, topics: [{ ...write.details.topics[0], completedSeq: "x" }] };
		expect(parseSnapshotPayload(corrupt)).toMatchObject({ ok: false, category: "corrupt" });
	});
});

describe("branch-independent eviction", () => {
	it("reproduces each branch's completion order and eviction choice", async () => {
		const harness = makeHarness();
		const sm = newSession();
		appendUserMessage(sm, "start");
		const ctx = makeCtx(sm);
		const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [t("A"), t("B"), t("C")] });
		const [a, b, c] = created.details.topics as Array<{ id: string; title: string; items: Array<{ id: string; title: string }> }>;
		const rootLeaf = created.details.revision;
		const branchPoint = sm.getLeafId()!;

		// Branch 1: complete A then B, add D -> evict A (earliest).
		let r = await callWrite(harness, ctx, { expectedRevision: rootLeaf, topics: [mark(a!, "completed"), preserve(b as never), preserve(c as never)] });
		r = await callWrite(harness, ctx, {
			expectedRevision: r.details.revision,
			topics: [mark(r.details.topics[0], "completed"), mark(r.details.topics[1], "completed"), preserve(r.details.topics[2])],
		});
		const b1 = await callWrite(harness, ctx, { expectedRevision: r.details.revision, topics: [...r.details.topics.map(preserve), t("D")] });
		expect(b1.details.summary.evictedTopics).toEqual(["A"]);
		expect(b1.details.topics.map((x: { title: string }) => x.title).sort()).toEqual(["B", "C", "D"]);

		// Branch 2 from the same root: complete B then A, add E -> evict B.
		sm.branch(branchPoint);
		await emit(harness, "session_tree", ctx);
		let s = await callWrite(harness, ctx, { expectedRevision: rootLeaf, topics: [preserve(a as never), mark(b!, "completed"), preserve(c as never)] });
		s = await callWrite(harness, ctx, { expectedRevision: s.details.revision, topics: [preserve(s.details.topics[0]), mark(s.details.topics[1], "completed"), preserve(s.details.topics[2])] });
		s = await callWrite(harness, ctx, { expectedRevision: s.details.revision, topics: [mark(s.details.topics[0], "completed"), mark(s.details.topics[1], "completed"), preserve(s.details.topics[2])] });
		const b2 = await callWrite(harness, ctx, { expectedRevision: s.details.revision, topics: [...s.details.topics.map(preserve), t("E")] });
		expect(b2.details.summary.evictedTopics).toEqual(["B"]);
		expect(b2.details.topics.map((x: { title: string }) => x.title).sort()).toEqual(["A", "C", "E"]);
	});
});

describe("real file persistence of retention/eviction", () => {
	it("persists eviction metadata through a real file, reopen, fork, compact, and rollback", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-todo-retention-"));
		try {
			const cwd = mkdtempSync(join(root, "cwd-"));
			const dir = mkdtempSync(join(root, "sessions-"));
			const sm = SessionManager.create(cwd, dir);
			appendUserMessage(sm, "start");
			const harness = makeHarness();
			const ctx = makeCtx(sm);
			const created = await callWrite(harness, ctx, { expectedRevision: "", topics: [t("A"), t("B"), t("C")] });
			const [a, b, c] = created.details.topics as Array<{ id: string; title: string; items: Array<{ id: string; title: string }> }>;

			let r = await callWrite(harness, ctx, { expectedRevision: created.details.revision, topics: [mark(a!, "completed"), preserve(b as never), preserve(c as never)] });
			r = await callWrite(harness, ctx, {
				expectedRevision: r.details.revision,
				topics: [mark(r.details.topics[0], "completed"), mark(r.details.topics[1], "completed"), preserve(r.details.topics[2])],
			});
			const beforeEviction = sm.getLeafId()!;
			const evicted = await callWrite(harness, ctx, { expectedRevision: r.details.revision, topics: [...r.details.topics.map(preserve), t("D")] });
			expect(evicted.details.summary.evictedTopics).toEqual(["A"]);
			expect(evicted.details.topics.map((x: { title: string }) => x.title).sort()).toEqual(["B", "C", "D"]);

			const file = sm.getSessionFile()!;
			const raw = readFileSync(file, "utf8");
			expect(raw).toContain('"completedSeq"');
			expect(raw).toContain('"evictedTopics"');

			// Clear cache + a fresh factory, then replay from the branch only.
			__resetStore();
			const harness2 = makeHarness();
			await emit(harness2, "session_start", makeCtx(sm));
			expect(replayFromEntries(sm.getBranch()).snapshot.topics.map((x) => x.title).sort()).toEqual(["B", "C", "D"]);

			// Reopen the file and replay.
			const reopened = SessionManager.open(file, dir, cwd);
			const replayed = replayFromEntries(reopened.getBranch());
			expect(replayed.diagnostics).toEqual([]);
			expect(replayed.snapshot.topics.map((x) => x.title).sort()).toEqual(["B", "C", "D"]);

			// Fork and replay.
			const forkedCwd = mkdtempSync(join(root, "fork-"));
			const forked = SessionManager.forkFrom(file, forkedCwd, dir);
			expect(replayFromEntries(forked.getBranch()).snapshot.topics.map((x) => x.title).sort()).toEqual(["B", "C", "D"]);

			// Compact, then replay still sees the evicted head...
			sm.appendCompaction("summary", sm.getLeafId()!, 1000);
			expect(replayFromEntries(sm.getBranch()).snapshot.topics.map((x) => x.title).sort()).toEqual(["B", "C", "D"]);

			// ...and rolling back to before the eviction restores the old head.
			sm.branch(beforeEviction);
			const rolled = replayFromEntries(sm.getBranch());
			expect(rolled.diagnostics).toEqual([]);
			expect(rolled.snapshot.topics.map((x) => x.title).sort()).toEqual(["A", "B", "C"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
