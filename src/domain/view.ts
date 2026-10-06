import { isBlocked, indexLeaves } from "./dependencies.ts";
import { toWritable, type WritableSnapshot } from "./snapshot.ts";
import { containerStatus, countSnapshot, isFlattenedTopic, topicLeaves, topicStatus } from "./status.ts";
import { isLeaf, type Container, type DerivedStatus, type Leaf, type LeafStatus, type Snapshot, type Topic } from "./types.ts";

export interface LeafView {
	type: "leaf";
	id: string;
	title: string;
	status: LeafStatus;
	blockedBy: string[];
	/** Display numbers of prerequisites, in declaration order. */
	blockedByNumbers: string[];
	isBlocked: boolean;
	/** Display number, or null when the owning topic is flattened. */
	number: string | null;
}

export interface ContainerView {
	type: "container";
	id: string;
	title: string;
	status: DerivedStatus;
	/** Display number, or null when the owning topic is flattened. */
	number: string | null;
	subtasks: LeafView[];
}

export type ItemView = LeafView | ContainerView;

export interface TopicView {
	id: string;
	title: string;
	status: DerivedStatus;
	/** True when every executable leaf is completed (the topic is folded to one row). */
	completed: boolean;
	leafCount: number;
	completedLeafCount: number;
	items: ItemView[];
}

/** One rendered row. `depth` is the indentation level; flattened leaf rows sit at depth 0. */
export interface DisplayRow {
	depth: number;
	kind: "topic" | "container" | "leaf";
	topicId: string;
	itemId: string;
	leafId: string | null;
	number: string | null;
	text: string;
	status: DerivedStatus;
	flattened: boolean;
	/** True when this row is a completed topic's single summary row (descendants omitted). */
	folded: boolean;
	blockedBy: string[];
	blockedByNumbers: string[];
	isBlocked: boolean;
}

export interface FlattenedTopic {
	topicId: string;
	itemId: string;
	leafId: string;
}

export interface ReadResult {
	revision: string;
	topics: TopicView[];
	flattened: FlattenedTopic[];
	display: DisplayRow[];
	counts: ReturnType<typeof countSnapshot>;
	/** Topics whose leaves are all completed (retained in the tree, folded to one row). */
	completedTopicCount: number;
	/** Topics with any non-completed leaf. */
	activeTopicCount: number;
	/** Canonical, directly re-writable projection for the next `todo_write`. */
	writable: WritableSnapshot;
}

/**
 * Build the full read view: complete hierarchy with stable ids and derived
 * status, a display-number-to-leaf mapping (mixed layers, e.g. `1` and `2.1`),
 * per-topic flatten mapping, dependency/blocking annotations, and the canonical
 * writable projection.
 */
export function buildReadResult(snapshot: Snapshot): ReadResult {
	const index = indexLeaves(snapshot);
	const numbers = new Map<string, string>();
	const flattened: FlattenedTopic[] = [];

	for (const topic of snapshot.topics) {
		if (isFlattenedTopic(topic)) {
			const single = topicLeaves(topic)[0];
			if (!single) continue;
			const owner = index.get(single.id);
			if (owner) flattened.push({ topicId: topic.id, itemId: owner.item.id, leafId: single.id });
			continue;
		}
		topic.items.forEach((item, itemIndex) => {
			if (isLeaf(item)) {
				numbers.set(item.id, `${itemIndex + 1}`);
			} else {
				item.subtasks.forEach((leaf, subtaskIndex) => {
					numbers.set(leaf.id, `${itemIndex + 1}.${subtaskIndex + 1}`);
				});
			}
		});
	}

	const numberFor = (leafId: string): string => numbers.get(leafId) ?? leafId;

	const topics: TopicView[] = snapshot.topics.map((topic) => buildTopicView(topic, index, numberFor));
	const display: DisplayRow[] = [];
	for (const topic of snapshot.topics) appendTopicDisplay(topic, index, numberFor, display);

	const completedTopicCount = topics.filter((topic) => topic.completed).length;

	return {
		revision: snapshot.revision,
		topics,
		flattened,
		display,
		counts: countSnapshot(snapshot),
		completedTopicCount,
		activeTopicCount: topics.length - completedTopicCount,
		writable: toWritable(snapshot),
	};
}

function buildLeafView(leaf: Leaf, index: ReturnType<typeof indexLeaves>, numberFor: (id: string) => string, number: string | null): LeafView {
	return {
		type: "leaf",
		id: leaf.id,
		title: leaf.title,
		status: leaf.status,
		blockedBy: [...leaf.blockedBy],
		blockedByNumbers: leaf.blockedBy.map(numberFor),
		isBlocked: isBlocked(leaf, index),
		number,
	};
}

function buildTopicView(topic: Topic, index: ReturnType<typeof indexLeaves>, numberFor: (id: string) => string): TopicView {
	const leaves = topicLeaves(topic);
	const flat = isFlattenedTopic(topic);
	const status = topicStatus(topic);
	return {
		id: topic.id,
		title: topic.title,
		status,
		completed: status === "completed",
		leafCount: leaves.length,
		completedLeafCount: leaves.filter((leaf) => leaf.status === "completed").length,
		items: topic.items.map((item, itemIndex) => {
			if (isLeaf(item)) {
				return buildLeafView(item, index, numberFor, flat ? null : `${itemIndex + 1}`);
			}
			return {
				type: "container",
				id: item.id,
				title: item.title,
				status: containerStatus(item),
				number: flat ? null : `${itemIndex + 1}`,
				subtasks: item.subtasks.map((leaf, subtaskIndex) => buildLeafView(leaf, index, numberFor, flat ? null : `${itemIndex + 1}.${subtaskIndex + 1}`)),
			};
		}),
	};
}

function appendTopicDisplay(topic: Topic, index: ReturnType<typeof indexLeaves>, numberFor: (id: string) => string, out: DisplayRow[]): void {
	const completed = topicStatus(topic) === "completed";
	if (isFlattenedTopic(topic)) {
		// Flattened: show the single leaf at the topic position, no topic row and
		// no numbering. The topic and any container layer stay in the data.
		const leaf = topicLeaves(topic)[0];
		if (!leaf) return;
		const owner = index.get(leaf.id);
		if (!owner) return;
		out.push({
			depth: 0,
			kind: "leaf",
			topicId: topic.id,
			itemId: owner.item.id,
			leafId: leaf.id,
			number: null,
			text: leaf.title,
			status: leaf.status,
			flattened: true,
			folded: completed,
			blockedBy: [...leaf.blockedBy],
			blockedByNumbers: leaf.blockedBy.map(numberFor),
			isBlocked: isBlocked(leaf, index),
		});
		return;
	}

	out.push({
		depth: 0,
		kind: "topic",
		topicId: topic.id,
		itemId: topic.id,
		leafId: null,
		number: null,
		text: topic.title,
		status: topicStatus(topic),
		flattened: false,
		folded: completed,
		blockedBy: [],
		blockedByNumbers: [],
		isBlocked: false,
	});

	// A completed topic is folded to its single summary row: full hierarchy data
	// is still returned via `topics`, but the display (and widget) show one line
	// and never expand a completed topic's descendants.
	if (completed) return;

	topic.items.forEach((item, itemIndex) => {
		if (isLeaf(item)) {
			out.push({
				depth: 1,
				kind: "leaf",
				topicId: topic.id,
				itemId: item.id,
				leafId: item.id,
				number: `${itemIndex + 1}`,
				text: item.title,
				status: item.status,
				flattened: false,
				folded: false,
				blockedBy: [...item.blockedBy],
				blockedByNumbers: item.blockedBy.map(numberFor),
				isBlocked: isBlocked(item, index),
			});
			return;
		}
		out.push({
			depth: 1,
			kind: "container",
			topicId: topic.id,
			itemId: item.id,
			leafId: null,
			number: `${itemIndex + 1}`,
			text: item.title,
			status: containerStatus(item),
			flattened: false,
			folded: false,
			blockedBy: [],
			blockedByNumbers: [],
			isBlocked: false,
		});
		item.subtasks.forEach((leaf, subtaskIndex) => {
			out.push({
				depth: 2,
				kind: "leaf",
				topicId: topic.id,
				itemId: item.id,
				leafId: leaf.id,
				number: `${itemIndex + 1}.${subtaskIndex + 1}`,
				text: leaf.title,
				status: leaf.status,
				flattened: false,
				folded: false,
				blockedBy: [...leaf.blockedBy],
				blockedByNumbers: leaf.blockedBy.map(numberFor),
				isBlocked: isBlocked(leaf, index),
			});
		});
	});
}

export type { Container };
