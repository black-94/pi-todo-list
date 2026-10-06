import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { replayFromEntries } from "../src/state/replay.ts";
import { __resetStore } from "../src/state/store.ts";
import { appendUserMessage, callRead, callWrite, makeCtx, makeHarness, resetCallCounter, resetHarnessState } from "./harness.ts";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-todo-list-"));
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

function dirs() {
	return { cwd: mkdtempSync(join(root, "cwd-")), dir: mkdtempSync(join(root, "sessions-")) };
}

/** Create a file-backed session, add a user turn, and run the real tool once. */
async function persistedWrite() {
	const { cwd, dir } = dirs();
	const sm = SessionManager.create(cwd, dir);
	appendUserMessage(sm, "start");
	const harness = makeHarness();
	const write = await callWrite(harness, makeCtx(sm), {
		expectedRevision: "",
		topics: [
			{
				title: "Persisted",
				items: [
					{ title: "analyse" },
					{ title: "fix", subtasks: [{ title: "spec" }, { title: "impl" }] },
				],
			},
		],
	});
	return { sm, harness, write, cwd, dir, file: sm.getSessionFile()! };
}

describe("persistent session files (temp dir only, real tool output)", () => {
	it("writes the real tool envelope to disk and reopens it", async () => {
		const { write, cwd, dir, file } = await persistedWrite();
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("pi-todo-list.snapshot");
		expect(readFileSync(file, "utf8")).toContain('"summary"');

		const reopened = SessionManager.open(file, dir, cwd);
		const replay = replayFromEntries(reopened.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.revision).toBe(write.details.revision);
		expect(replay.snapshot.topics).toEqual(write.details.topics);
	});

	it("reads the replayed real envelope through the tool after reopening", async () => {
		const { write, cwd, dir, file } = await persistedWrite();
		__resetStore();
		const reopened = SessionManager.open(file, dir, cwd);
		const read = await callRead(makeHarness(), makeCtx(reopened));
		expect(read.content[0].text).toContain("Persisted");
		expect(read.details.revision).toBe(write.details.revision);
		expect(read.details.topics[0].items.map((i: { type: string }) => i.type)).toEqual(["leaf", "container"]);
	});

	it("replays the real envelope through a compaction entry after reopening", async () => {
		const { sm, write, cwd, dir, file } = await persistedWrite();
		sm.appendCompaction("summary of earlier work", sm.getLeafId()!, 5000);
		const reopened = SessionManager.open(file, dir, cwd);
		const replay = replayFromEntries(reopened.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.revision).toBe(write.details.revision);
	});

	it("forks a persisted real session and replays the fork's branch", async () => {
		const { write, dir, file } = await persistedWrite();
		const forkedCwd = mkdtempSync(join(root, "fork-cwd-"));
		const forked = SessionManager.forkFrom(file, forkedCwd, dir);
		const replay = replayFromEntries(forked.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.revision).toBe(write.details.revision);
		expect(replay.snapshot.topics[0]!.title).toBe("Persisted");
	});

	it("persists and replays a retained completed topic produced by a completed write", async () => {
		const { sm, harness, write } = await persistedWrite();
		const ctx = makeCtx(sm);
		const topic = write.details.topics[0];
		const l2 = topic.items[0].id;
		const container = topic.items[1];
		const done = await callWrite(harness, ctx, {
			expectedRevision: write.details.revision,
			topics: [
				{
					id: topic.id,
					title: "Persisted",
					items: [
						{ id: l2, title: "analyse", status: "completed" },
						{
							id: container.id,
							title: "fix",
							subtasks: [
								{ id: container.subtasks[0].id, title: "spec", status: "completed" },
								{ id: container.subtasks[1].id, title: "impl", status: "completed" },
							],
						},
					],
				},
			],
		});
		expect(done.details.topics).toHaveLength(1);
		expect(done.details.topics[0].title).toBe("Persisted");
		expect(typeof done.details.topics[0].completedSeq).toBe("number");
		expect(done.details.summary.completedTopics).toEqual(["Persisted"]);
		expect(done.details.revision).not.toBe(write.details.revision);

		__resetStore();
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.diagnostics).toEqual([]);
		expect(replay.snapshot.revision).toBe(done.details.revision);
		expect(replay.snapshot.topics).toHaveLength(1);
		expect(replay.snapshot.topics[0]!.completedSeq).toBe(done.details.topics[0].completedSeq);

		const read = await callRead(makeHarness(), makeCtx(sm));
		expect(read.details.revision).toBe(done.details.revision);
		expect(read.details.topics).toHaveLength(1);
		expect(read.details.topics[0].completed).toBe(true);
	});
});
