import { validateDependencies, validateInProgressLimits, validatePreconditions } from "./dependencies.ts";
import { validateTitle } from "./graphemes.ts";
import { isLeaf, MAX_IN_PROGRESS_GLOBAL, MAX_TOPICS, TITLE_MAX, type Snapshot } from "./types.ts";

/** Every node id present in a snapshot (topics, layer-2 items, layer-3 leaves). */
export function collectIds(snapshot: Snapshot): Set<string> {
	const ids = new Set<string>();
	for (const topic of snapshot.topics) {
		ids.add(topic.id);
		for (const item of topic.items) {
			ids.add(item.id);
			if (!isLeaf(item)) for (const leaf of item.subtasks) ids.add(leaf.id);
		}
	}
	return ids;
}

/**
 * Structural checks independent of dependency semantics: unique ids, no empty
 * containers, and the three-layer shape. Depth > 3 is impossible to express in
 * the type, so this also guards malformed runtime objects.
 */
export function validateStructure(snapshot: Snapshot): string | undefined {
	const ids = new Set<string>();
	for (const topic of snapshot.topics) {
		if (ids.has(topic.id)) return `duplicate node id ${topic.id}`;
		ids.add(topic.id);
		if (!Array.isArray(topic.items) || topic.items.length === 0) {
			return `topic ${topic.id} has no items; every topic must contain at least one item`;
		}
		for (const item of topic.items) {
			if (ids.has(item.id)) return `duplicate node id ${item.id}`;
			ids.add(item.id);
			if (isLeaf(item)) continue;
			if (!Array.isArray(item.subtasks) || item.subtasks.length === 0) {
				return `container ${item.id} has no subtasks; every container must contain at least one leaf`;
			}
			for (const leaf of item.subtasks) {
				if (ids.has(leaf.id)) return `duplicate node id ${leaf.id}`;
				ids.add(leaf.id);
			}
		}
	}
	return undefined;
}

/**
 * Domain graph invariants shared by `todo_write` and snapshot replay:
 * structure, dependency legality, preconditions, and in-progress limits.
 * Capacity (max topics) is intentionally excluded so a write can finish an old
 * topic and add a new one in the same call before the cap is enforced.
 */
export function validateGraph(snapshot: Snapshot): string | undefined {
	const structural = validateStructure(snapshot);
	if (structural) return structural;
	const dep = validateDependencies(snapshot);
	if (dep) return dep;
	const pre = validatePreconditions(snapshot);
	if (pre) return pre;
	return validateInProgressLimits(snapshot, MAX_IN_PROGRESS_GLOBAL);
}

/** Capacity check, applied after any completed-topic eviction. */
export function validateCapacity(snapshot: Snapshot): string | undefined {
	if (snapshot.topics.length > MAX_TOPICS) {
		return `at most ${MAX_TOPICS} topics are allowed at once; the candidate has ${snapshot.topics.length}`;
	}
	return undefined;
}

/**
 * Enforce stored titles exactly as they would be produced by a write: valid for
 * their layer, already trimmed, no control characters. Used when replaying a
 * persisted snapshot so a corrupt title cannot silently enter the tree.
 */
export function validateStoredTitles(snapshot: Snapshot): string | undefined {
	for (const topic of snapshot.topics) {
		const topicCheck = validateTitle(topic.title, TITLE_MAX.topic, "topic");
		if (!topicCheck.ok) return `corrupt snapshot: ${topicCheck.error}`;
		if (topicCheck.value !== topic.title) return `corrupt snapshot: topic title ${topic.id} is not normalized`;
		for (const item of topic.items) {
			const itemCheck = validateTitle(item.title, TITLE_MAX.item, "item");
			if (!itemCheck.ok) return `corrupt snapshot: ${itemCheck.error}`;
			if (itemCheck.value !== item.title) return `corrupt snapshot: item title ${item.id} is not normalized`;
			if (!isLeaf(item)) {
				for (const leaf of item.subtasks) {
					const leafCheck = validateTitle(leaf.title, TITLE_MAX.leaf, "leaf");
					if (!leafCheck.ok) return `corrupt snapshot: ${leafCheck.error}`;
					if (leafCheck.value !== leaf.title) return `corrupt snapshot: leaf title ${leaf.id} is not normalized`;
				}
			}
		}
	}
	return undefined;
}
