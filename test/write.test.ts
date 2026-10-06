import { describe, expect, it } from "vitest";
import { applyWrite, type ItemInput } from "../src/domain/write.ts";
import { emptySnapshot } from "../src/domain/snapshot.ts";
import { makeChained } from "./chained.ts";
import type { Container, Leaf, LeafStatus, Topic } from "../src/domain/types.ts";

function mixedScenario() {
	const chained = makeChained();
	const result = chained.write({
		topics: [
			{
				title: "Auth",
				items: [{ title: "analyse" }, { title: "fix", subtasks: [{ title: "first" }, { title: "second" }] }],
			},
		],
	});
	expect(result.ok).toBe(true);
	const topic = chained.state.topics[0]!;
	const l2 = topic.items[0] as Leaf;
	const container = topic.items[1] as Container;
	return {
		chained,
		topicId: topic.id,
		l2Id: l2.id,
		containerId: container.id,
		firstId: container.subtasks[0]!.id,
		secondId: container.subtasks[1]!.id,
	};
}

function oneTopic(title: string): { title: string; items: ItemInput[] } {
	return { title, items: [{ title: "L" }] };
}

/** Convert a stored topic back into write input, preserving statuses/dependencies. */
function inputTopic(topic: Topic) {
	return {
		id: topic.id,
		title: topic.title,
		items: topic.items.map((item) =>
			item.type === "leaf"
				? { id: item.id, title: item.title, status: item.status, blockedBy: [...item.blockedBy] }
				: {
						id: item.id,
						title: item.title,
						subtasks: item.subtasks.map((leaf) => ({ id: leaf.id, title: leaf.title, status: leaf.status, blockedBy: [...leaf.blockedBy] })),
					},
		),
	};
}

/** A one-leaf topic input with the leaf forced to `status`. */
function completedInput(topic: Topic, status: LeafStatus = "completed") {
	return { id: topic.id, title: topic.title, items: topic.items.map((item) => ({ id: item.id, title: item.title, status })) };
}

describe("write: hierarchy limits", () => {
	it("accepts a topic mixing a layer-2 leaf and a layer-2 container", () => {
		const { chained } = mixedScenario();
		expect(chained.state.topics[0]!.items.map((i) => i.type)).toEqual(["leaf", "container"]);
	});

	it("rejects a fourth topic", () => {
		const result = applyWrite(emptySnapshot(), {
			expectedRevision: "",
			topics: [oneTopic("A"), oneTopic("B"), oneTopic("C"), oneTopic("D")],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("at most 3");
	});

	it("rejects a fourth layer (nested subtasks under a leaf)", () => {
		const result = makeChained().write({
			topics: [{ title: "A", items: [{ title: "L", subtasks: [{ title: "L3", subtasks: [{ title: "deep" }] }] } as never] }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("three layers");
	});

	it("rejects a new empty topic and a new empty container", () => {
		expect(makeChained().write({ topics: [{ title: "A", items: [] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "A", items: [{ title: "C", subtasks: [] }] }] }).ok).toBe(false);
	});
});

describe("write: titles and invalid field types", () => {
	it("enforces per-layer grapheme limits", () => {
		expect(makeChained().write({ topics: [{ title: "x".repeat(25), items: [{ title: "L" }] }] }).ok).toBe(false);
		// layer-2 leaf title limit 32
		expect(makeChained().write({ topics: [{ title: "ok", items: [{ title: "L".repeat(33) }] }] }).ok).toBe(false);
		// layer-3 leaf title limit 40
		expect(makeChained().write({ topics: [{ title: "ok", items: [{ title: "C", subtasks: [{ title: "L".repeat(41) }] }] }] }).ok).toBe(false);
		// 32 graphemes exactly is allowed at layer 2
		expect(makeChained().write({ topics: [{ title: "ok", items: [{ title: "👩‍💻".repeat(32) }] }] }).ok).toBe(true);
	});

	it("rejects empty, control, and newline titles", () => {
		expect(makeChained().write({ topics: [{ title: "  ", items: [{ title: "L" }] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "bad\nline", items: [{ title: "L" }] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "ok", items: [{ title: "L\u0007" }] }] }).ok).toBe(false);
	});

	it("rejects container status/blockedBy, unknown fields, and bad field types", () => {
		const withContainerStatus = { title: "A", items: [{ title: "C", subtasks: [{ title: "L" }], status: "pending" }] as never };
		const statusResult = makeChained().write({ topics: [withContainerStatus] });
		expect(statusResult.ok).toBe(false);
		if (!statusResult.ok) expect(statusResult.error).toContain("must not declare status");

		expect(makeChained().write({ topics: [{ title: "A", items: [{ title: "L", bogus: 1 } as never] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "A", items: [{ id: 5, title: "L" } as never] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "A", items: [{ title: "L", status: "done" } as never] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "A", items: [{ title: "L", blockedBy: [1] } as never] }] }).ok).toBe(false);
		expect(makeChained().write({ topics: [{ title: "A", items: [{ title: "C", subtasks: [{ title: "L" }], blockedBy: [] } as never] }] }).ok).toBe(false);
	});
});

describe("write: container/leaf conversion and moves", () => {
	it("rejects conversion and cross-parent moves", () => {
		const { chained, topicId, containerId, firstId, secondId, l2Id } = mixedScenario();
		// reuse a leaf id where a container is expected
		const asContainer = chained.write({
			topics: [{ id: topicId, title: "Auth", items: [{ title: "analyse" , id: l2Id, subtasks: [{ title: "x" }] } as never] }],
		});
		expect(asContainer.ok).toBe(false);
		// reuse a container id where a leaf is expected
		const asLeaf = chained.write({
			topics: [{ id: topicId, title: "Auth", items: [{ title: "analyse", id: containerId } as never] }],
		});
		expect(asLeaf.ok).toBe(false);
		// move a layer-3 leaf to the layer-2 position
		const moved = chained.write({
			topics: [
				{
					id: topicId,
					title: "Auth",
					items: [
						{ id: l2Id, title: "analyse" },
						{ id: firstId, title: "first" } as never,
						{ id: containerId, title: "fix", subtasks: [{ id: secondId, title: "second" }] },
					],
				},
			],
		});
		expect(moved.ok).toBe(false);
	});

	it("rejects moving a container between topics", () => {
		const chained = makeChained();
		chained.write({
			topics: [
				{ title: "A", items: [{ title: "C", subtasks: [{ title: "x" }] }] },
				{ title: "B", items: [{ title: "b" }] },
			],
		});
		const a = chained.state.topics[0]!;
		const b = chained.state.topics[1]!;
		const container = a.items[0] as Container;
		const result = chained.write({
			topics: [
				{ id: a.id, title: "A", items: [{ id: a.id, title: "stub" } as never] },
				{ id: b.id, title: "B", items: [{ id: b.items[0]!.id, title: "b" }, { id: container.id, title: "C", subtasks: [{ id: container.subtasks[0]!.id, title: "x" }] }] },
			],
		});
		expect(result.ok).toBe(false);
	});
});

describe("write: in-progress limits", () => {
	it("counts layer-2 and layer-3 leaves of one topic together", () => {
		const { chained, topicId, l2Id, containerId, firstId, secondId } = mixedScenario();
		const result = chained.write({
			topics: [
				{
					id: topicId,
					title: "Auth",
					items: [
						{ id: l2Id, title: "analyse", status: "in_progress" },
						{ id: containerId, title: "fix", subtasks: [{ id: firstId, title: "first", status: "in_progress" }, { id: secondId, title: "second" }] },
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("at most one is allowed per topic");
	});

	it("allows three in-progress leaves across three topics", () => {
		const make = (title: string) => ({ title, items: [{ title: "L", status: "in_progress" as const }] });
		expect(makeChained().write({ topics: [make("A"), make("B"), make("C")] }).ok).toBe(true);
	});
});

describe("write: dependencies (mixed layers)", () => {
	it("supports a layer-3 leaf depending on a layer-2 leaf", () => {
		const { chained, topicId, l2Id, containerId, firstId, secondId } = mixedScenario();
		const ok = chained.write({
			topics: [
				{
					id: topicId,
					title: "Auth",
					items: [
						{ id: l2Id, title: "analyse", status: "completed" },
						{ id: containerId, title: "fix", subtasks: [{ id: firstId, title: "first", status: "in_progress", blockedBy: [l2Id] }, { id: secondId, title: "second" }] },
					],
				},
			],
		});
		expect(ok.ok).toBe(true);
	});

	it("rejects self, dangling, cross-topic, container, and cyclic dependencies", () => {
		const self = makeChained().write({ topics: [{ title: "A", items: [{ key: "x", title: "x", blockedBy: ["x"] }] }] });
		expect(self.ok).toBe(false);
		const dangling = makeChained().write({ topics: [{ title: "A", items: [{ title: "x", blockedBy: ["missing"] }] }] });
		expect(dangling.ok).toBe(false);
		const containerTarget = makeChained().write({
			topics: [{ title: "A", items: [{ key: "c", title: "C", subtasks: [{ title: "z" }] }, { title: "x", blockedBy: ["c"] }] }],
		});
		expect(containerTarget.ok).toBe(false);
		const cycle = makeChained().write({
			topics: [{ title: "A", items: [{ key: "x", title: "x", blockedBy: ["y"] }, { key: "y", title: "y", blockedBy: ["x"] }] }],
		});
		expect(cycle.ok).toBe(false);
		const crossTopic = makeChained().write({
			topics: [
				{ title: "A", items: [{ title: "a", blockedBy: ["b"] }] },
				{ title: "B", items: [{ key: "b", title: "b" }] },
			],
		});
		expect(crossTopic.ok).toBe(false);
		if (!crossTopic.ok) expect(crossTopic.error).toContain("another topic");
	});

	it("blocks advancing a leaf whose prerequisite is incomplete", () => {
		const { chained, topicId, l2Id, containerId, firstId, secondId } = mixedScenario();
		const attempt = (status: "in_progress" | "completed") =>
			chained.write({
				topics: [
					{
						id: topicId,
						title: "Auth",
						items: [
							{ id: l2Id, title: "analyse" },
							{ id: containerId, title: "fix", subtasks: [{ id: firstId, title: "first", status, blockedBy: [l2Id] }, { id: secondId, title: "second" }] },
						],
					},
				],
			});
		expect(attempt("in_progress").ok).toBe(false);
		expect(attempt("completed").ok).toBe(false);
	});

	it("rejects keys colliding with existing ids and duplicate keys", () => {
		const { chained, topicId, containerId } = mixedScenario();
		const collide = chained.write({ topics: [{ id: topicId, title: "Auth", items: [{ key: containerId, title: "x" }] }] });
		expect(collide.ok).toBe(false);
		const dup = makeChained().write({ topics: [{ title: "A", items: [{ key: "k", title: "a" }, { key: "k", title: "b" }] }] });
		expect(dup.ok).toBe(false);
	});
});

describe("write: omission protection and cancellation", () => {
	it("rejects omitting an existing node without removeIds", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "A", items: [{ title: "x" }, { title: "y" }] }] });
		const topic = chained.state.topics[0]!;
		const omitted = chained.write({ topics: [{ id: topic.id, title: "A", items: [{ id: topic.items[0]!.id, title: "x" }] }] });
		expect(omitted.ok).toBe(false);
		if (!omitted.ok) expect(omitted.error).toContain("omitted without removeIds");

		const withRemove = chained.write({
			removeIds: [topic.items[1]!.id],
			topics: [{ id: topic.id, title: "A", items: [{ id: topic.items[0]!.id, title: "x" }] }],
		});
		expect(withRemove.ok).toBe(true);
	});

	it("records direct removeIds cancellations in the summary", () => {
		const { chained, topicId, containerId, firstId, secondId } = mixedScenario();
		const result = chained.write({
			removeIds: [containerId],
			topics: [{ id: topicId, title: "Auth", items: [{ id: (chained.state.topics[0]!.items[0] as Leaf).id, title: "analyse" }] }],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summary.cancelled.some((c) => c.includes("cancelled container") && c.includes('"fix"'))).toBe(true);
		}
		expect(chained.state.topics[0]!.items.some((i) => i.id === firstId || i.id === secondId)).toBe(false);
	});

	it("rejects unknown and duplicate removeIds", () => {
		expect(makeChained().write({ removeIds: ["nope"], topics: [] }).ok).toBe(false);
		const chained = makeChained();
		chained.write({ topics: [{ title: "A", items: [{ title: "x" }, { title: "y" }] }] });
		const leaf = chained.state.topics[0]!.items[0]!.id;
		const dup = chained.write({ removeIds: [leaf, leaf], topics: [] });
		expect(dup.ok).toBe(false);
		if (!dup.ok) expect(dup.error).toContain("duplicate");
	});

	it("prunes a container/topic emptied by cancellation and reports it", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "A", items: [{ title: "C", subtasks: [{ title: "only" }] }] }] });
		const topic = chained.state.topics[0]!;
		const container = topic.items[0] as Container;
		const leafId = container.subtasks[0]!.id;
		const result = chained.write({
			removeIds: [leafId],
			topics: [{ id: topic.id, title: "A", items: [{ id: container.id, title: "C", subtasks: [] }] }],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summary.cancelled.some((c) => c.includes("emptied by cancellation"))).toBe(true);
		}
		expect(chained.state.topics).toHaveLength(0);
	});
});

describe("write: validate before eviction (regressions)", () => {
	it("rejects an all-completed cycle instead of retaining/evicting the topic", () => {
		const result = makeChained().write({
			topics: [
				{ title: "A", items: [{ key: "x", title: "x", status: "completed", blockedBy: ["y"] }, { key: "y", title: "y", status: "completed", blockedBy: ["x"] }] },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("cycle");
	});

	it("rejects an all-completed self-dependency", () => {
		const result = makeChained().write({ topics: [{ title: "A", items: [{ key: "x", title: "x", status: "completed", blockedBy: ["x"] }] }] });
		expect(result.ok).toBe(false);
	});

	it("rejects an all-completed container-target dependency", () => {
		const result = makeChained().write({
			topics: [{ title: "A", items: [{ key: "c", title: "C", subtasks: [{ title: "z" }] }, { title: "x", status: "completed", blockedBy: ["c"] }] }],
		});
		expect(result.ok).toBe(false);
	});

	it("rejects an all-completed cross-topic dependency", () => {
		const result = makeChained().write({
			topics: [
				{ title: "A", items: [{ title: "a", status: "completed", blockedBy: ["b"] }] },
				{ title: "B", items: [{ key: "b", title: "b", status: "completed" }] },
			],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("another topic");
	});

	it("rejects cancelling a prerequisite while a completed dependent keeps the reference", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "A", items: [{ title: "p" }, { title: "d" }, { title: "z" }] }] });
		const topic = chained.state.topics[0]!;
		const [p, d, z] = topic.items as Leaf[];
		// complete p, then d (dependent) and leave z pending
		chained.write({
			topics: [
				{
					id: topic.id,
					title: "A",
					items: [
						{ id: p!.id, title: "p", status: "completed" },
						{ id: d!.id, title: "d", status: "pending", blockedBy: [p!.id] },
						{ id: z!.id, title: "z" },
					],
				},
			],
		});
		chained.write({
			topics: [
				{
					id: topic.id,
					title: "A",
					items: [
						{ id: p!.id, title: "p", status: "completed" },
						{ id: d!.id, title: "d", status: "completed", blockedBy: [p!.id] },
						{ id: z!.id, title: "z" },
					],
				},
			],
		});
		const revisionBefore = chained.state.revision;
		const treeBefore = JSON.stringify(chained.state.topics);
		const result = chained.write({
			removeIds: [p!.id],
			topics: [
				{
					id: topic.id,
					title: "A",
					items: [
						{ id: d!.id, title: "d", status: "completed" },
						{ id: z!.id, title: "z" },
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(chained.state.revision).toBe(revisionBefore);
		expect(JSON.stringify(chained.state.topics)).toBe(treeBefore);
	});
});

describe("write: completion retention, capacity eviction, no-op, revision, atomicity", () => {
	it("retains a topic whose leaves are all completed instead of removing it", () => {
		const { chained, topicId, l2Id, containerId, firstId, secondId } = mixedScenario();
		const result = chained.write({
			topics: [
				{
					id: topicId,
					title: "Auth",
					items: [
						{ id: l2Id, title: "analyse", status: "completed" },
						{ id: containerId, title: "fix", subtasks: [{ id: firstId, title: "first", status: "completed" }, { id: secondId, title: "second", status: "completed" }] },
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summary.completedTopics).toEqual(["Auth"]);
			expect(result.summary.evictedTopics).toEqual([]);
		}
		expect(chained.state.topics).toHaveLength(1);
		expect(chained.state.topics[0]!.id).toBe(topicId);
		expect(typeof chained.state.topics[0]!.completedSeq).toBe("number");
	});

	it("keeps a completed topic when there is room and preserves it on a no-op write", () => {
		const chained = makeChained();
		chained.write({ topics: [oneTopic("A"), oneTopic("B")] });
		const [a, b] = chained.state.topics as [Topic, Topic];
		expect(chained.write({ topics: [completedInput(a), inputTopic(b)] }).ok).toBe(true);
		const seq = chained.state.topics[0]!.completedSeq;

		const added = chained.write({ topics: [inputTopic(chained.state.topics[0]!), inputTopic(chained.state.topics[1]!), oneTopic("C")] });
		expect(added.ok).toBe(true);
		if (added.ok) expect(added.summary.evictedTopics).toEqual([]);
		expect(chained.state.topics.map((t) => t.title)).toEqual(["A", "B", "C"]);
		expect(chained.state.topics[0]!.completedSeq).toBe(seq);

		const revision = chained.state.revision;
		const noop = chained.write({ topics: chained.state.topics.map(inputTopic) });
		expect(noop.ok).toBe(true);
		if (noop.ok) expect(noop.changed).toBe(false);
		expect(chained.state.revision).toBe(revision);
		expect(chained.state.topics).toHaveLength(3);
	});

	it("evicts the earliest-completed topic to admit a new one when full, regardless of array order", () => {
		const chained = makeChained();
		chained.write({ topics: [oneTopic("A"), oneTopic("B"), oneTopic("C")] });
		const [a, b, c] = chained.state.topics as [Topic, Topic, Topic];
		// Complete A, then B, then C (completion order A < B < C).
		chained.write({ topics: [completedInput(a), inputTopic(b), inputTopic(c)] });
		chained.write({ topics: [inputTopic(chained.state.topics[0]!), completedInput(b), inputTopic(c)] });
		chained.write({ topics: [inputTopic(chained.state.topics[0]!), inputTopic(chained.state.topics[1]!), completedInput(c)] });
		expect(chained.state.topics.every((t) => typeof t.completedSeq === "number")).toBe(true);

		// Reorder the array so completion order no longer matches position.
		const reordered = [chained.state.topics[2]!, chained.state.topics[0]!, chained.state.topics[1]!];
		const result = chained.write({ topics: [...reordered.map(inputTopic), oneTopic("D")] });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.summary.evictedTopics).toEqual(["A"]);
		expect(chained.state.topics.map((t) => t.title).sort()).toEqual(["B", "C", "D"]);
	});

	it("evicts the minimum number for multiple new topics, keeping the rest", () => {
		const chained = makeChained();
		chained.write({ topics: [oneTopic("A"), oneTopic("B"), oneTopic("C")] });
		const [a, b, c] = chained.state.topics as [Topic, Topic, Topic];
		chained.write({ topics: [completedInput(a), inputTopic(b), inputTopic(c)] });
		chained.write({ topics: [inputTopic(chained.state.topics[0]!), completedInput(b), inputTopic(c)] });
		chained.write({ topics: [inputTopic(chained.state.topics[0]!), inputTopic(chained.state.topics[1]!), completedInput(c)] });

		const result = chained.write({ topics: [...chained.state.topics.map(inputTopic), oneTopic("D"), oneTopic("E")] });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.summary.evictedTopics).toEqual(["A", "B"]);
		expect(chained.state.topics.map((t) => t.title).sort()).toEqual(["C", "D", "E"]);
	});

	it("rejects a new topic while all three topics are unfinished and leaves state untouched", () => {
		const chained = makeChained();
		chained.write({ topics: [oneTopic("A"), oneTopic("B"), oneTopic("C")] });
		const before = JSON.stringify(chained.state);
		const result = chained.write({ topics: [...chained.state.topics.map(inputTopic), oneTopic("D")] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("at most 3");
		expect(JSON.stringify(chained.state)).toBe(before);
	});

	it("clears completion order when a completed topic is reopened and assigns a new one on recommit", () => {
		const chained = makeChained();
		chained.write({ topics: [oneTopic("A"), oneTopic("B")] });
		const [a, b] = chained.state.topics as [Topic, Topic];
		chained.write({ topics: [completedInput(a), inputTopic(b)] });
		const firstSeq = chained.state.topics[0]!.completedSeq!;

		// Reopen A, then complete B (seq 1) and A (seq 2 > firstSeq).
		chained.write({ topics: [completedInput(chained.state.topics[0]!, "pending"), inputTopic(b)] });
		expect(chained.state.topics[0]!.completedSeq).toBeUndefined();
		chained.write({ topics: [inputTopic(chained.state.topics[0]!), completedInput(chained.state.topics[1]!)] });
		chained.write({ topics: [completedInput(chained.state.topics[0]!), inputTopic(chained.state.topics[1]!)] });
		expect(chained.state.topics[0]!.completedSeq!).toBeGreaterThan(firstSeq);
	});

	it("preserves blockedBy inside a retained completed topic across writes", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "A", items: [{ title: "p" }, { title: "d" }] }] });
		const topic = chained.state.topics[0]!;
		const [p, d] = topic.items as [Leaf, Leaf];
		const result = chained.write({
			topics: [
				{
					id: topic.id,
					title: "A",
					items: [
						{ id: p.id, title: "p", status: "completed" },
						{ id: d.id, title: "d", status: "completed", blockedBy: [p.id] },
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		const retained = chained.state.topics[0]!;
		expect((retained.items[1] as Leaf).blockedBy).toEqual([p.id]);
		expect(typeof retained.completedSeq).toBe("number");
	});


	it("treats an identical write as a no-op with the same revision", () => {
		const { chained, topicId, l2Id, containerId, firstId, secondId } = mixedScenario();
		const before = chained.state.revision;
		const result = chained.write({
			topics: [
				{
					id: topicId,
					title: "Auth",
					items: [
						{ id: l2Id, title: "analyse" },
						{ id: containerId, title: "fix", subtasks: [{ id: firstId, title: "first" }, { id: secondId, title: "second" }] },
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.changed).toBe(false);
			expect(result.revision).toBe(before);
		}
	});

	it("rejects a revision conflict and leaves state untouched", () => {
		const { chained } = mixedScenario();
		const before = JSON.stringify(chained.state);
		const result = applyWrite(chained.state, { expectedRevision: "stale", topics: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("revision conflict");
		expect(JSON.stringify(chained.state)).toBe(before);
	});

	it("is atomic: an invalid write does not change state", () => {
		const { chained, topicId, l2Id, containerId, firstId, secondId } = mixedScenario();
		const before = JSON.stringify(chained.state);
		const result = chained.write({
			topics: [
				{
					id: topicId,
					title: "Auth",
					items: [
						{ id: l2Id, title: "analyse", status: "in_progress" },
						{ id: containerId, title: "fix", subtasks: [{ id: firstId, title: "first", status: "in_progress" }, { id: secondId, title: "second" }] },
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(chained.state)).toBe(before);
	});

	it("generates a UUID revision", () => {
		const chained = makeChained();
		chained.write({ topics: [oneTopic("A")] });
		expect(chained.state.revision).toMatch(/[0-9a-f-]{36}/);
	});
});
