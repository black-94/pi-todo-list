import { isLeaf, type Container, type DerivedStatus, type Leaf, type Snapshot, type Topic } from "./types.ts";

/** Executable leaves of a layer-2 container. */
export function containerLeaves(container: Container): Leaf[] {
	return container.subtasks;
}

/** All executable leaves of a topic, in display order (layer-2 leaves and layer-3 leaves). */
export function topicLeaves(topic: Topic): Leaf[] {
	const leaves: Leaf[] = [];
	for (const item of topic.items) {
		if (isLeaf(item)) leaves.push(item);
		else for (const leaf of item.subtasks) leaves.push(leaf);
	}
	return leaves;
}

/** All executable leaves of a snapshot. */
export function snapshotLeaves(snapshot: Snapshot): Leaf[] {
	const leaves: Leaf[] = [];
	for (const topic of snapshot.topics) for (const leaf of topicLeaves(topic)) leaves.push(leaf);
	return leaves;
}

/**
 * Derive a container's status from its leaves.
 *
 * An empty leaf set is *never* reported as completed: an empty set is not "all
 * completed". Empty containers are rejected or pruned before reaching display,
 * but this guards derived status regardless.
 */
export function deriveStatus(leaves: readonly Leaf[]): DerivedStatus {
	if (leaves.length === 0) return "pending";
	let allCompleted = true;
	let anyInProgress = false;
	for (const leaf of leaves) {
		if (leaf.status !== "completed") allCompleted = false;
		if (leaf.status === "in_progress") anyInProgress = true;
	}
	if (allCompleted) return "completed";
	if (anyInProgress) return "in_progress";
	return "pending";
}

export function topicStatus(topic: Topic): DerivedStatus {
	return deriveStatus(topicLeaves(topic));
}

export function containerStatus(container: Container): DerivedStatus {
	return deriveStatus(container.subtasks);
}

export interface SnapshotCounts {
	topics: number;
	leaves: number;
	pending: number;
	inProgress: number;
	completed: number;
}

/** Aggregate executable-leaf counts across the whole tree. */
export function countSnapshot(snapshot: Snapshot): SnapshotCounts {
	const counts: SnapshotCounts = { topics: snapshot.topics.length, leaves: 0, pending: 0, inProgress: 0, completed: 0 };
	for (const leaf of snapshotLeaves(snapshot)) {
		counts.leaves++;
		if (leaf.status === "pending") counts.pending++;
		else if (leaf.status === "in_progress") counts.inProgress++;
		else counts.completed++;
	}
	return counts;
}

/**
 * A topic is flattened in the widget when its subtree holds exactly one
 * executable leaf, whether the structure is topic -> leaf (two layers) or
 * topic -> container -> leaf (three layers). The data still keeps every layer.
 */
export function isFlattenedTopic(topic: Topic): boolean {
	return topicLeaves(topic).length === 1;
}
