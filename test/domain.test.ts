import { describe, expect, it } from "vitest";
import { graphemeLength, validateTitle } from "../src/domain/graphemes.ts";
import { deriveStatus, countSnapshot, isFlattenedTopic, topicLeaves } from "../src/domain/status.ts";
import { buildReadResult } from "../src/domain/view.ts";
import { cloneSnapshot, parseSnapshotPayload, toWritable } from "../src/domain/snapshot.ts";
import type { Container, Leaf, Snapshot, Topic } from "../src/domain/types.ts";
import { makeChained } from "./chained.ts";

function L(id: string, title: string, status: Leaf["status"] = "pending", blockedBy: string[] = []): Leaf {
	return { type: "leaf", id, title, status, blockedBy };
}
function C(id: string, title: string, subtasks: Leaf[]): Container {
	return { type: "container", id, title, subtasks };
}
function topic(id: string, title: string, items: Topic["items"]): Topic {
	return { id, title, items };
}
function snapshot(topics: Topic[], revision = "r1"): Snapshot {
	return { revision, topics };
}

describe("grapheme counting and title validation", () => {
	it("counts an emoji and a combining sequence as one grapheme", () => {
		expect(graphemeLength("ab")).toBe(2);
		expect(graphemeLength("👩‍💻")).toBe(1);
		expect(graphemeLength("e\u0301")).toBe(1);
		expect(graphemeLength("中文")).toBe(2);
	});

	it("trims, rejects empty/control/newline, and enforces the limit", () => {
		expect(validateTitle("  hello  ", 10, "topic")).toMatchObject({ ok: true, value: "hello" });
		expect(validateTitle("   ", 10, "topic").ok).toBe(false);
		expect(validateTitle("line\nbreak", 10, "topic").ok).toBe(false);
		expect(validateTitle("tab\there", 10, "topic").ok).toBe(false);
		expect(validateTitle("bell\u0007", 10, "topic").ok).toBe(false);
		expect(validateTitle("12345", 5, "topic").ok).toBe(true);
		const tooLong = validateTitle("123456", 5, "topic");
		expect(tooLong.ok).toBe(false);
		expect(tooLong.error).toContain("at most 5");
	});
});

describe("derived container status", () => {
	it("never treats an empty leaf set as completed", () => {
		expect(deriveStatus([])).toBe("pending");
		expect(deriveStatus([L("a", "a", "completed")])).toBe("completed");
		expect(deriveStatus([L("a", "a", "completed"), L("b", "b", "pending")])).toBe("pending");
		expect(deriveStatus([L("a", "a", "pending"), L("b", "b", "in_progress")])).toBe("in_progress");
	});

	it("counts executable leaves across mixed layers", () => {
		const s = snapshot([
			topic("t1", "A", [L("l1", "x", "completed"), C("c1", "B", [L("l2", "y", "in_progress")])]),
			topic("t2", "B", [L("l3", "z", "pending")]),
		]);
		expect(countSnapshot(s)).toEqual({ topics: 2, leaves: 3, pending: 1, inProgress: 1, completed: 1 });
	});
});

describe("read view numbering, flattening, and dependencies", () => {
	it("mixes layer-2 leaf numbers with layer-3 dotted numbers", () => {
		const s = snapshot([
			topic("topicA", "Auth", [
				L("a", "analyse"),
				C("c1", "fix", [L("b1", "spec"), L("b2", "implement")]),
			]),
		]);
		const read = buildReadResult(s);
		const items = read.topics[0]!.items;
		expect(items[0]!.type).toBe("leaf");
		expect((items[0] as { number: string | null }).number).toBe("1");
		expect(items[1]!.type).toBe("container");
		expect((items[1] as { number: string }).number).toBe("2");
		expect((items[1] as { subtasks: Array<{ number: string | null }> }).subtasks.map((l) => l.number)).toEqual(["2.1", "2.2"]);
		const numbers = read.display.filter((r) => r.kind !== "topic").map((r) => r.number);
		expect(numbers).toEqual(["1", "2", "2.1", "2.2"]);
		expect(read.flattened).toEqual([]);
	});

	it("flattens a two-layer topic (topic -> leaf)", () => {
		const s = snapshot([topic("t", "Auth", [L("a", "only")])]);
		const read = buildReadResult(s);
		expect(isFlattenedTopic(s.topics[0]!)).toBe(true);
		expect(read.flattened).toEqual([{ topicId: "t", itemId: "a", leafId: "a" }]);
		expect(read.display[0]).toMatchObject({ kind: "leaf", depth: 0, number: null, leafId: "a", flattened: true, text: "only" });
	});

	it("flattens a three-layer topic (topic -> container -> leaf)", () => {
		const s = snapshot([topic("t", "Auth", [C("c", "T", [L("a", "only")])])]);
		const read = buildReadResult(s);
		expect(isFlattenedTopic(s.topics[0]!)).toBe(true);
		expect(read.flattened).toEqual([{ topicId: "t", itemId: "c", leafId: "a" }]);
		expect(read.display[0]).toMatchObject({ kind: "leaf", depth: 0, number: null, leafId: "a", itemId: "c", flattened: true });
		// The rich view must agree with the display: a flattened topic has no numbers.
		const containerView = read.topics[0]!.items[0]!;
		expect(containerView.type).toBe("container");
		if (containerView.type === "container") {
			expect(containerView.number).toBeNull();
			expect(containerView.subtasks[0]!.number).toBeNull();
		}
	});

	it("keeps stable ids across flat/tree and preserves every layer in data", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "Auth", items: [{ title: "C", subtasks: [{ title: "spec" }] }] }] });
		const topicNode = chained.state.topics[0]!;
		const containerId = (topicNode.items[0] as Container).id;
		const singleId = (topicNode.items[0] as Container).subtasks[0]!.id;
		expect(buildReadResult(chained.state).flattened[0]).toEqual({ topicId: topicNode.id, itemId: containerId, leafId: singleId });

		chained.write({
			topics: [
				{
					id: topicNode.id,
					title: "Auth",
					items: [{ id: containerId, title: "C", subtasks: [{ id: singleId, title: "spec" }, { title: "impl" }] }],
				},
			],
		});
		const read = buildReadResult(chained.state);
		expect(read.flattened).toEqual([]);
		expect((chained.state.topics[0]!.items[0] as Container).subtasks[0]!.id).toBe(singleId);
		expect(read.topics[0]!.items[0]!.type).toBe("container");
	});

	it("renders dependencies across layer-2 and layer-3 leaves as display numbers", () => {
		const s = snapshot([topic("t", "A", [L("a", "first"), C("c", "B", [L("b", "second", "pending", ["a"])])])]);
		const read = buildReadResult(s);
		const leaf = (read.topics[0]!.items[1] as { subtasks: Array<{ blockedByNumbers: string[]; isBlocked: boolean }> }).subtasks[0]!;
		expect(leaf.blockedByNumbers).toEqual(["1"]);
		expect(leaf.isBlocked).toBe(true);

		const done = snapshot([topic("t", "A", [L("a", "first", "completed"), C("c", "B", [L("b", "second", "pending", ["a"])])])]);
		const leaf2 = (buildReadResult(done).topics[0]!.items[1] as { subtasks: Array<{ isBlocked: boolean }> }).subtasks[0]!;
		expect(leaf2.isBlocked).toBe(false);
	});
});

describe("snapshot payload parsing", () => {
	const validSnapshot = snapshot([topic("t", "T", [L("a", "one"), C("c", "C", [L("b", "two")])])], "r");
	const validPayload = { kind: "pi-todo-list.snapshot", schemaVersion: 2, revision: "r", topics: validSnapshot.topics };

	it("accepts a valid payload and deep-clones it", () => {
		const parsed = parseSnapshotPayload(validPayload);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(topicLeaves(parsed.snapshot.topics[0]!)).toHaveLength(2);
			parsed.snapshot.topics[0]!.title = "MUTATED";
			expect(parsed.snapshot.topics[0]!.title).toBe("MUTATED");
			// parse returns a clone, so mutating the result cannot affect the source payload
			expect(validPayload.topics[0]!.title).toBe("T");
		}
	});

	it("classifies foreign, unsupported, and corrupt payloads", () => {
		expect(parseSnapshotPayload({ tasks: [], nextId: 1 })).toMatchObject({ ok: false, category: "foreign" });
		expect(parseSnapshotPayload({ kind: "pi-todo-list.snapshot", schemaVersion: 1, revision: "r", topics: [] })).toMatchObject({
			ok: false,
			category: "unsupported",
		});
		expect(parseSnapshotPayload({ kind: "pi-todo-list.snapshot", schemaVersion: 2, revision: "r", topics: [{ id: "t" }] })).toMatchObject({
			ok: false,
			category: "corrupt",
		});
	});

	it("rejects structural and invariant violations as corrupt", () => {
		const wrap = (topics: unknown[]) => ({ kind: "pi-todo-list.snapshot", schemaVersion: 2, revision: "r", topics });
		// >3 topics
		expect(parseSnapshotPayload(wrap([topic("1", "a", [L("x1", "x")]), topic("2", "b", [L("x2", "x")]), topic("3", "c", [L("x3", "x")]), topic("4", "d", [L("x4", "x")])])).ok).toBe(false);
		// empty container
		expect(parseSnapshotPayload(wrap([topic("t", "a", [C("c", "empty", [])])])).ok).toBe(false);
		// empty topic
		expect(parseSnapshotPayload(wrap([topic("t", "a", [])])).ok).toBe(false);
		// container carrying status
		expect(parseSnapshotPayload(wrap([topic("t", "a", [{ type: "container", id: "c", title: "x", subtasks: [L("l", "l")], status: "pending" } as never])])).ok).toBe(false);
		// fourth layer
		expect(parseSnapshotPayload(wrap([topic("t", "a", [C("c", "x", [{ type: "leaf", id: "l", title: "l", status: "pending", blockedBy: [], subtasks: [] } as unknown as Leaf])])])).ok).toBe(false);
		// dangling dependency
		expect(parseSnapshotPayload(wrap([topic("t", "a", [L("l", "l", "pending", ["nope"])])])).ok).toBe(false);
		// cyclic dependency
		expect(parseSnapshotPayload(wrap([topic("t", "a", [L("l1", "1", "pending", ["l2"]), L("l2", "2", "pending", ["l1"])])])).ok).toBe(false);
		// blocked but completed
		expect(parseSnapshotPayload(wrap([topic("t", "a", [L("l1", "1"), L("l2", "2", "completed", ["l1"])])])).ok).toBe(false);
		// multiple in-progress in one topic
		expect(parseSnapshotPayload(wrap([topic("t", "a", [L("l1", "1", "in_progress"), L("l2", "2", "in_progress")])])).ok).toBe(false);
		// duplicate id
		expect(parseSnapshotPayload(wrap([topic("t", "a", [L("dup", "1"), L("dup", "2")])])).ok).toBe(false);
		// non-normalized title
		expect(parseSnapshotPayload(wrap([topic("t", "  padded  ", [L("l", "l")])])).ok).toBe(false);
		// over-long title
		expect(parseSnapshotPayload(wrap([topic("t", "x".repeat(25), [L("l", "l")])])).ok).toBe(false);
	});
});

describe("snapshot payload schema compatibility", () => {
	const baseTopics = () => [topic("t", "T", [L("a", "one")])];

	it("accepts both v2 and v3, and rejects versions outside the supported range", () => {
		const v2 = { kind: "pi-todo-list.snapshot", schemaVersion: 2, revision: "r", topics: baseTopics() };
		const v3 = { kind: "pi-todo-list.snapshot", schemaVersion: 3, revision: "r", topics: baseTopics() };
		expect(parseSnapshotPayload(v2).ok).toBe(true);
		expect(parseSnapshotPayload(v3).ok).toBe(true);
		expect(parseSnapshotPayload({ ...v2, schemaVersion: 1 })).toMatchObject({ ok: false, category: "unsupported" });
		expect(parseSnapshotPayload({ ...v3, schemaVersion: 4 })).toMatchObject({ ok: false, category: "unsupported" });
	});

	it("accepts each summary shape only under its own version", () => {
		const summaryV2 = {
			createdTopics: 0,
			createdContainers: 0,
			createdLeaves: 0,
			completedLeaves: 0,
			statusChanges: [],
			cancelled: [],
			completedTopicsRemoved: ["A"],
		};
		const summaryV3 = {
			createdTopics: 0,
			createdContainers: 0,
			createdLeaves: 0,
			completedLeaves: 0,
			statusChanges: [],
			cancelled: [],
			completedTopics: [],
			evictedTopics: [],
		};
		const base = { kind: "pi-todo-list.snapshot", revision: "r", topics: baseTopics() };
		expect(parseSnapshotPayload({ ...base, schemaVersion: 2, summary: summaryV2 }).ok).toBe(true);
		expect(parseSnapshotPayload({ ...base, schemaVersion: 3, summary: summaryV3 }).ok).toBe(true);
		expect(parseSnapshotPayload({ ...base, schemaVersion: 3, summary: summaryV2 })).toMatchObject({ ok: false, category: "corrupt" });
		expect(parseSnapshotPayload({ ...base, schemaVersion: 2, summary: summaryV3 })).toMatchObject({ ok: false, category: "corrupt" });
	});

	it("round-trips a completedSeq and rejects a non-numeric one", () => {
		const withSeq = {
			kind: "pi-todo-list.snapshot",
			schemaVersion: 3,
			revision: "r",
			topics: [{ id: "t", title: "T", completedSeq: 7, items: [{ type: "leaf", id: "a", title: "one", status: "completed", blockedBy: [] }] }],
		};
		const parsed = parseSnapshotPayload(withSeq);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.snapshot.topics[0]!.completedSeq).toBe(7);
		const bad = { ...withSeq, topics: [{ id: "t", title: "T", completedSeq: "x", items: [] }] };
		expect(parseSnapshotPayload(bad)).toMatchObject({ ok: false, category: "corrupt" });
	});
});

describe("writable projection", () => {
	it("drops the internal type and derived fields and matches the write input shape", () => {
		const s = snapshot([topic("t", "T", [L("a", "one", "in_progress"), C("c", "C", [L("b", "two", "pending", ["a"])])])], "r");
		const writable = toWritable(s);
		expect(writable.revision).toBe("r");
		const items = writable.topics[0]!.items;
		expect(items[0]).toEqual({ id: "a", title: "one", status: "in_progress", blockedBy: [] });
		expect(items[1]).toEqual({ id: "c", title: "C", subtasks: [{ id: "b", title: "two", status: "pending", blockedBy: ["a"] }] });
		expect("type" in (items[0] as object)).toBe(false);
	});

	it("drops the internal completedSeq from the writable projection", () => {
		const s: Snapshot = { revision: "r", topics: [{ id: "t", title: "T", completedSeq: 3, items: [L("a", "one", "completed")] }] };
		const writable = toWritable(s);
		expect(Object.keys(writable.topics[0]!)).toEqual(["id", "title", "items"]);
		expect(JSON.stringify(writable)).not.toContain("completedSeq");
	});

	it("clones so the source is unaffected", () => {
		const s = snapshot([topic("t", "T", [L("a", "one")])]);
		const clone = cloneSnapshot(s);
		clone.topics[0]!.title = "X";
		expect(s.topics[0]!.title).toBe("T");
	});
});
