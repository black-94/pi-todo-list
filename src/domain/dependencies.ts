import { isLeaf, type Leaf, type LeafLocation, type Snapshot } from "./types.ts";

/** Index every executable leaf (layer 2 and layer 3) by stable id. */
export function indexLeaves(snapshot: Snapshot): Map<string, LeafLocation> {
	const index = new Map<string, LeafLocation>();
	snapshot.topics.forEach((topic, topicIndex) => {
		topic.items.forEach((item, itemIndex) => {
			if (isLeaf(item)) {
				index.set(item.id, { topic, topicIndex, item, itemIndex, leaf: item, subtaskIndex: undefined });
			} else {
				item.subtasks.forEach((leaf, subtaskIndex) => {
					index.set(leaf.id, { topic, topicIndex, item, itemIndex, leaf, subtaskIndex });
				});
			}
		});
	});
	return index;
}

/** Index every container id (topic and layer-2 container) by id, mapped to its topic. */
export function indexContainers(snapshot: Snapshot): Map<string, { topic: string }> {
	const index = new Map<string, { topic: string }>();
	for (const topic of snapshot.topics) {
		index.set(topic.id, { topic: topic.id });
		for (const item of topic.items) {
			if (!isLeaf(item)) index.set(item.id, { topic: topic.id });
		}
	}
	return index;
}

/** A leaf is blocked when at least one prerequisite is not completed. */
export function isBlocked(leaf: Leaf, index: Map<string, LeafLocation>): boolean {
	for (const depId of leaf.blockedBy) {
		const dep = index.get(depId);
		if (!dep || dep.leaf.status !== "completed") return true;
	}
	return false;
}

/** Detect a cycle in the leaf dependency graph; returns the cycle path or undefined. */
export function findDependencyCycle(snapshot: Snapshot): string[] | undefined {
	const edges = new Map<string, string[]>();
	const index = indexLeaves(snapshot);
	for (const [id, loc] of index) {
		edges.set(
			id,
			loc.leaf.blockedBy.filter((dep) => index.has(dep)),
		);
	}

	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const visit = (node: string): string[] | undefined => {
		const current = state.get(node) ?? 0;
		if (current === 1) {
			const start = stack.indexOf(node);
			return stack.slice(start).concat(node);
		}
		if (current === 2) return undefined;
		state.set(node, 1);
		stack.push(node);
		for (const next of edges.get(node) ?? []) {
			const cycle = visit(next);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(node, 2);
		return undefined;
	};

	for (const node of edges.keys()) {
		const cycle = visit(node);
		if (cycle) return cycle;
	}
	return undefined;
}

/**
 * Structural dependency validation over a candidate snapshot. Enforced: every
 * reference resolves, only executable leaves are referenced (never containers),
 * both ends live in the same topic, no self-dependency, no duplicate reference,
 * and no cycles.
 */
export function validateDependencies(snapshot: Snapshot): string | undefined {
	const leaves = indexLeaves(snapshot);
	const containers = indexContainers(snapshot);

	for (const [id, loc] of leaves) {
		const seen = new Set<string>();
		for (const depId of loc.leaf.blockedBy) {
			if (depId === id) return `leaf ${id} cannot be blocked by itself`;
			if (seen.has(depId)) return `leaf ${id} lists prerequisite ${depId} more than once`;
			seen.add(depId);
			if (containers.has(depId)) {
				return `leaf ${id} cannot depend on container ${depId}; dependencies are between executable leaves`;
			}
			const dep = leaves.get(depId);
			if (!dep) return `leaf ${id} depends on unknown node ${depId}`;
			if (dep.topic.id !== loc.topic.id) {
				return `leaf ${id} depends on ${depId} in another topic; dependencies must stay within one topic`;
			}
		}
	}

	const cycle = findDependencyCycle(snapshot);
	if (cycle) return `dependency cycle: ${cycle.join(" -> ")}`;
	return undefined;
}

/**
 * Status/precondition consistency over a candidate snapshot. A leaf that is
 * `in_progress` or `completed` must have every prerequisite `completed`.
 * Validating the whole candidate guarantees a single write cannot leave a
 * prerequisite incomplete while a dependent is advanced.
 */
export function validatePreconditions(snapshot: Snapshot): string | undefined {
	const index = indexLeaves(snapshot);
	for (const [id, loc] of index) {
		if (loc.leaf.status === "pending") continue;
		for (const depId of loc.leaf.blockedBy) {
			const dep = index.get(depId);
			if (!dep) return `leaf ${id} depends on unknown node ${depId}`;
			if (dep.leaf.status !== "completed") {
				return `leaf ${id} is ${loc.leaf.status} but prerequisite ${depId} is ${dep.leaf.status}`;
			}
		}
	}
	return undefined;
}

/** At most one in-progress leaf per topic, and at most `maxGlobal` overall. */
export function validateInProgressLimits(snapshot: Snapshot, maxGlobal: number): string | undefined {
	let global = 0;
	for (const topic of snapshot.topics) {
		let inTopic = 0;
		for (const item of topic.items) {
			const leaves = isLeaf(item) ? [item] : item.subtasks;
			for (const leaf of leaves) {
				if (leaf.status === "in_progress") {
					inTopic++;
					global++;
				}
			}
		}
		if (inTopic > 1) {
			return `topic "${topic.title}" has ${inTopic} in-progress leaves; at most one is allowed per topic`;
		}
	}
	if (global > maxGlobal) {
		return `at most ${maxGlobal} leaves may be in progress at once (got ${global})`;
	}
	return undefined;
}
