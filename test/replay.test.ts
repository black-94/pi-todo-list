import { describe, expect, it } from "vitest";
import { replayFromEntries } from "../src/state/replay.ts";
import { appendUserMessage, appendWriteResult, newSession } from "./harness.ts";
import type { Leaf, Topic } from "../src/domain/types.ts";

function leaf(id: string, title: string, status: Leaf["status"] = "pending", blockedBy: string[] = []): Leaf {
	return { type: "leaf", id, title, status, blockedBy };
}

function topic(id: string, title: string): Topic {
	return { id, title, items: [{ type: "leaf", id: `${id}-leaf`, title: "L", status: "pending", blockedBy: [] }] };
}

function details(revision: string, topics: Topic[], schemaVersion = 2) {
	return { kind: "pi-todo-list.snapshot", schemaVersion, revision, topics };
}

describe("replay from branch", () => {
	it("returns empty state when there is no snapshot", () => {
		const sm = newSession();
		appendUserMessage(sm, "hello");
		expect(replayFromEntries(sm.getBranch()).snapshot).toEqual({ revision: "", topics: [] });
	});

	it("replays the latest successful write snapshot", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		appendWriteResult(sm, "w2", details("r2", [topic("b", "B")]));
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe("r2");
		expect(replay.snapshot.topics.map((t) => t.title)).toEqual(["B"]);
		expect(replay.diagnostics).toEqual([]);
	});

	it("ignores read results, failed writes, and foreign tool details", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		appendWriteResult(sm, "read1", { kind: "pi-todo-list.read", revision: "r1", topics: [] }, { toolName: "todo_read" });
		appendWriteResult(sm, "w2", details("r2", [topic("bad", "BAD")]), { isError: true });
		appendWriteResult(sm, "old", { tasks: [], nextId: 1 }, { toolName: "todo" });
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe("r1");
		expect(replay.diagnostics).toEqual([]);
	});

	it("lets a latest empty valid snapshot win over an older non-empty one", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		appendWriteResult(sm, "w2", details("r2", []));
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe("r2");
		expect(replay.snapshot.topics).toEqual([]);
	});

	it("reports an unsupported schema version and keeps the last valid snapshot", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		appendWriteResult(sm, "w2", details("r9", [topic("z", "Z")], 99));
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe("r1");
		expect(replay.diagnostics.some((d) => d.includes("unsupported"))).toBe(true);
	});

	it("reports a corrupt current-schema snapshot and keeps the last valid snapshot", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		// Cycle: both completed, mutually dependent — corrupt under our invariants.
		const corrupt: Topic = {
			id: "bad",
			title: "Bad",
			items: [leaf("x", "x", "completed", ["y"]), leaf("y", "y", "completed", ["x"])],
		};
		appendWriteResult(sm, "w2", details("r2", [corrupt]));
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe("r1");
		expect(replay.diagnostics.some((d) => d.includes("corrupt"))).toBe(true);
	});

	it("clears diagnostics when a newer valid snapshot supersedes the damage", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		appendWriteResult(sm, "w2", details("r2", [topic("b", "B")], 99));
		appendWriteResult(sm, "w3", details("r3", [topic("c", "C")]));
		const replay = replayFromEntries(sm.getBranch());
		expect(replay.snapshot.revision).toBe("r3");
		expect(replay.diagnostics).toEqual([]);
	});

	it("keeps independent branch histories", () => {
		const sm = newSession();
		const root = appendUserMessage(sm, "root");
		appendWriteResult(sm, "wA", details("A", [topic("a", "A")]));
		const branchA = sm.getLeafId()!;

		sm.branch(root);
		appendWriteResult(sm, "wB", details("B", [topic("b", "B")]));
		expect(replayFromEntries(sm.getBranch()).snapshot.revision).toBe("B");

		sm.branch(branchA);
		expect(replayFromEntries(sm.getBranch()).snapshot.revision).toBe("A");
	});

	it("replays through a compaction entry", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		const kept = sm.getLeafId()!;
		sm.appendCompaction("summarized", kept, 1000);
		expect(replayFromEntries(sm.getBranch()).snapshot.revision).toBe("r1");
		appendWriteResult(sm, "w2", details("r2", [topic("b", "B")]));
		expect(replayFromEntries(sm.getBranch()).snapshot.revision).toBe("r2");
	});

	it("does not share cloned state with the source entries", () => {
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", [topic("a", "A")]));
		const replayed = replayFromEntries(sm.getBranch()).snapshot;
		replayed.topics[0]!.title = "MUTATED";
		expect(replayFromEntries(sm.getBranch()).snapshot.topics[0]!.title).toBe("A");
	});
});
