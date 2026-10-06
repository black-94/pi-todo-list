import { validateCapacity, validateGraph } from "./validate.ts";
import { validateTitle } from "./graphemes.ts";
import { newNodeId, newRevision } from "./ids.ts";
import { cloneSnapshot } from "./snapshot.ts";
import { isLeaf, MAX_TOPICS, TITLE_MAX, type Leaf, type LeafStatus, type Snapshot, type Topic, type TopicItem, type WriteSummary } from "./types.ts";

export type { WriteSummary };

// ---------------------------------------------------------------------------
// Input shapes (mirror the TypeBox schema in tool/schemas.ts)
// ---------------------------------------------------------------------------

export interface LeafInput {
	id?: string;
	key?: string;
	title: string;
	status?: LeafStatus;
	blockedBy?: string[];
}

/** A layer-2 container: presence of `subtasks` distinguishes it from a leaf. */
export interface ContainerInput {
	id?: string;
	key?: string;
	title: string;
	subtasks: LeafInput[];
}

export type ItemInput = LeafInput | ContainerInput;

export interface TopicInput {
	id?: string;
	key?: string;
	title: string;
	items: ItemInput[];
}

export interface WriteInput {
	expectedRevision: string;
	topics: TopicInput[];
	removeIds?: string[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type WriteResult =
	| { ok: true; changed: boolean; revision: string; snapshot: Snapshot; summary: WriteSummary }
	| { ok: false; error: string };

function failure(error: string): WriteResult {
	return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Existing-tree index
// ---------------------------------------------------------------------------

type ExistingNode =
	| { type: "topic"; topicId: string; title: string }
	| { type: "container"; topicId: string; containerId: string; title: string }
	| { type: "leaf"; topicId: string; containerId: string | null; leafId: string; title: string; status: LeafStatus };

function indexExisting(snapshot: Snapshot): Map<string, ExistingNode> {
	const index = new Map<string, ExistingNode>();
	for (const topic of snapshot.topics) {
		index.set(topic.id, { type: "topic", topicId: topic.id, title: topic.title });
		for (const item of topic.items) {
			if (isLeaf(item)) {
				index.set(item.id, {
					type: "leaf",
					topicId: topic.id,
					containerId: null,
					leafId: item.id,
					title: item.title,
					status: item.status,
				});
			} else {
				index.set(item.id, { type: "container", topicId: topic.id, containerId: item.id, title: item.title });
				for (const leaf of item.subtasks) {
					index.set(leaf.id, {
						type: "leaf",
						topicId: topic.id,
						containerId: item.id,
						leafId: leaf.id,
						title: leaf.title,
						status: leaf.status,
					});
				}
			}
		}
	}
	return index;
}

const LEAF_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
const ROOT_KEYS = new Set(["expectedRevision", "topics", "removeIds"]);
const TOPIC_KEYS = new Set(["id", "key", "title", "items"]);
const CONTAINER_KEYS = new Set(["id", "key", "title", "subtasks"]);
const LEAF_KEYS = new Set(["id", "key", "title", "status", "blockedBy"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
	for (const key of Object.keys(value)) if (!allowed.has(key)) return key;
	return undefined;
}

/**
 * Order-insensitive-in-key structural equality for topics. JSON.stringify is
 * key-order sensitive and topics reach this point with `completedSeq` in
 * different positions, so serialize through a canonical field order.
 */
function sameTopics(a: readonly Topic[], b: readonly Topic[]): boolean {
	const canonical = (topics: readonly Topic[]): string =>
		JSON.stringify(topics.map((topic) => ({ id: topic.id, title: topic.title, completedSeq: topic.completedSeq, items: topic.items })));
	return canonical(a) === canonical(b);
}

/**
 * Structural guard for callers that bypass the TypeBox schema. Enforces value
 * types, rejects container `status`/`blockedBy`, unknown fields, and any fourth
 * layer, so an invalid or unreplayable input can never reach the tree.
 */
function structuralError(input: WriteInput): string | undefined {
	if (!isObject(input)) return "write input must be an object";
	const rootExtra = onlyKeys(input as unknown as Record<string, unknown>, ROOT_KEYS);
	if (rootExtra) return `unexpected field "${rootExtra}"`;
	if (!Array.isArray(input.topics)) return "topics must be an array";
	for (const topic of input.topics as unknown[]) {
		if (!isObject(topic)) return "every topic must be an object";
		const extra = onlyKeys(topic, TOPIC_KEYS);
		if (extra) return `topic has unexpected field "${extra}"`;
		if (typeof topic.title !== "string") return "every topic must have a string title";
		if (topic.id !== undefined && typeof topic.id !== "string") return "topic id must be a string";
		if (topic.key !== undefined && typeof topic.key !== "string") return "topic key must be a string";
		if (!Array.isArray(topic.items)) return `topic "${topic.title}" must have an items array`;
		for (const item of topic.items as unknown[]) {
			if (!isObject(item)) return `topic "${topic.title}" contains a non-object item`;
			if (typeof item.title !== "string") return "every item must have a string title";
			if (item.id !== undefined && typeof item.id !== "string") return "item id must be a string";
			if (item.key !== undefined && typeof item.key !== "string") return "item key must be a string";
			const isContainer = Array.isArray(item.subtasks);
			if (isContainer && ("status" in item || "blockedBy" in item)) {
				return `container "${item.title}" must not declare status or blockedBy; container status is derived`;
			}
			const extraItem = onlyKeys(item, isContainer ? CONTAINER_KEYS : LEAF_KEYS);
			if (extraItem) return `item "${item.title}" has unexpected field "${extraItem}"`;
			if (isContainer) {
				for (const leaf of item.subtasks as unknown[]) {
					const leafError = leafStructuralError(leaf, item.title as string);
					if (leafError) return leafError;
				}
			} else {
				const leafError = leafStructuralError(item, item.title as string);
				if (leafError) return leafError;
			}
		}
	}
	return undefined;
}

function leafStructuralError(leaf: unknown, owner: string): string | undefined {
	if (!isObject(leaf)) return `"${owner}" contains a non-object leaf`;
	if (typeof leaf.title !== "string") return "every leaf must have a string title";
	if (leaf.id !== undefined && typeof leaf.id !== "string") return "leaf id must be a string";
	if (leaf.key !== undefined && typeof leaf.key !== "string") return "leaf key must be a string";
	if (Array.isArray(leaf.subtasks)) return `leaf "${leaf.title}" must not contain nested subtasks; the tree has three layers`;
	if (leaf.subtasks !== undefined) return `leaf "${leaf.title}" has an invalid subtasks field`;
	const extra = onlyKeys(leaf, LEAF_KEYS);
	if (extra) return `leaf "${leaf.title}" has unexpected field "${extra}"`;
	if (leaf.status !== undefined && (typeof leaf.status !== "string" || !LEAF_STATUSES.has(leaf.status))) {
		return `leaf "${leaf.title}" has an invalid status`;
	}
	if (leaf.blockedBy !== undefined && (!Array.isArray(leaf.blockedBy) || !(leaf.blockedBy as unknown[]).every((d) => typeof d === "string"))) {
		return `leaf "${leaf.title}" blockedBy must be an array of strings`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Apply a write
// ---------------------------------------------------------------------------

/**
 * Validate and apply a full-tree snapshot write against the current state.
 *
 * Pure: never mutates `current`. Order, as required by the safety contract:
 * resolve input and removals, prune containers emptied by explicit
 * cancellation, validate the whole still-complete candidate (dependencies,
 * preconditions, limits), assign completion-order metadata, evict the minimum
 * completed topics needed to admit new ones, and finally enforce the topic cap.
 */
export function applyWrite(current: Snapshot, input: WriteInput): WriteResult {
	if (!isObject(input)) return failure("write input must be an object");
	if (input.expectedRevision !== current.revision) {
		return failure(
			`revision conflict: expected "${input.expectedRevision}" but current revision is "${current.revision}". Call todo_read once, merge the intended update into the returned tree, and retry todo_write.`,
		);
	}
	const removeList = input.removeIds ?? [];
	if (!Array.isArray(removeList)) return failure("removeIds must be an array when present");
	const structural = structuralError(input);
	if (structural) return failure(structural);

	const existing = indexExisting(current);
	const existingIds = new Set(existing.keys());

	// --- removeIds + cancellation record -----------------------------------
	const removeSet = new Set<string>();
	const summary: WriteSummary = {
		createdTopics: 0,
		createdContainers: 0,
		createdLeaves: 0,
		completedLeaves: 0,
		statusChanges: [],
		cancelled: [],
		completedTopics: [],
		evictedTopics: [],
	};
	for (const id of removeList) {
		if (removeSet.has(id)) return failure(`removeIds contains duplicate id ${id}`);
		const node = existing.get(id);
		if (!node) return failure(`removeIds references unknown id ${id}`);
		removeSet.add(id);
		const kind = node.type === "leaf" ? (node.containerId === null ? "item-leaf" : "leaf") : node.type;
		summary.cancelled.push(`cancelled ${kind} ${id} "${node.title}"`);
	}

	// --- request-scoped keys ----------------------------------------------
	const declaredKeys = new Set<string>();
	for (const node of iterateInputNodes(input)) {
		if (node.key === undefined) continue;
		if (node.id !== undefined) return failure("a node must not declare both id and key");
		if (existingIds.has(node.key)) return failure(`request key "${node.key}" collides with an existing node id`);
		if (declaredKeys.has(node.key)) return failure(`request key "${node.key}" is declared more than once`);
		declaredKeys.add(node.key);
	}

	const generated = new Set<string>();
	const isTaken = (id: string): boolean => existingIds.has(id) || declaredKeys.has(id) || generated.has(id);
	const makeId = (): string => {
		const id = newNodeId(isTaken);
		generated.add(id);
		return id;
	};

	const seen = new Set<string>();
	const keyToId = new Map<string, string>();

	const resolve = (
		node: { id?: string; key?: string },
		expected: "topic" | "container" | "leaf",
		parent: { topicId: string; containerId: string | null },
	): { id: string; existing: boolean } | { error: string } => {
		if (node.id !== undefined) {
			const found = existing.get(node.id);
			if (!found) return { error: `unknown id ${node.id}; new nodes must omit id` };
			if (removeSet.has(node.id)) return { error: `id ${node.id} is listed in removeIds but also appears in topics` };
			if (seen.has(node.id)) return { error: `id ${node.id} appears more than once in topics` };
			seen.add(node.id);
			if (expected === "topic") {
				if (found.type !== "topic") return { error: typeMismatch(node.id, "topic", found.type) };
				return { id: node.id, existing: true };
			}
			if (expected === "container") {
				if (found.type !== "container") return { error: typeMismatch(node.id, "container", found.type) };
				if (found.topicId !== parent.topicId) return { error: `container ${node.id} cannot move between topics` };
				return { id: node.id, existing: true };
			}
			if (found.type !== "leaf") return { error: typeMismatch(node.id, "leaf", found.type) };
			if (found.topicId !== parent.topicId) return { error: `leaf ${node.id} cannot move between topics` };
			if (found.containerId !== parent.containerId) return { error: `leaf ${node.id} cannot move between containers` };
			return { id: node.id, existing: true };
		}
		const id = makeId();
		if (node.key !== undefined) keyToId.set(node.key, id);
		return { id, existing: false };
	};

	const buildLeaf = (
		leafInput: LeafInput,
		topicId: string,
		containerId: string | null,
	): { leaf: Leaf } | { error: string } => {
		const resolved = resolve(leafInput, "leaf", { topicId, containerId });
		if ("error" in resolved) return resolved;
		let prevStatus: LeafStatus | undefined;
		let status: LeafStatus;
		let blockedBy: string[];
		if (resolved.existing) {
			const node = existing.get(resolved.id)!;
			if (node.type === "leaf") {
				prevStatus = node.status;
				status = leafInput.status ?? node.status;
				blockedBy = leafInput.blockedBy ? [...leafInput.blockedBy] : [...readExistingBlockedBy(current, resolved.id)];
				if (status !== prevStatus) summary.statusChanges.push(`${resolved.id}: ${prevStatus} -> ${status}`);
			} else {
				return { error: typeMismatch(resolved.id, "leaf", node.type) };
			}
		} else {
			status = leafInput.status ?? "pending";
			blockedBy = leafInput.blockedBy ? [...leafInput.blockedBy] : [];
			summary.createdLeaves++;
		}
		if (status === "completed" && prevStatus !== "completed") summary.completedLeaves++;
		const titleCheck = validateTitle(leafInput.title, containerId === null ? TITLE_MAX.item : TITLE_MAX.leaf, containerId === null ? "item" : "leaf");
		if (!titleCheck.ok) return { error: titleCheck.error! };
		return { leaf: { type: "leaf", id: resolved.id, title: titleCheck.value, status, blockedBy } };
	};

	const candidateTopics: Topic[] = [];
	for (const topicInput of input.topics) {
		const topicResolved = resolve(topicInput, "topic", { topicId: "", containerId: null });
		if ("error" in topicResolved) return failure(topicResolved.error);
		const topicTitle = validateTitle(topicInput.title, TITLE_MAX.topic, "topic");
		if (!topicTitle.ok) return failure(topicTitle.error!);
		if (!topicResolved.existing) {
			summary.createdTopics++;
			if (topicInput.items.length === 0) return failure(`new topic "${topicTitle.value}" must contain at least one item`);
		}

		const items: TopicItem[] = [];
		for (const rawItem of topicInput.items as unknown[]) {
			const item = rawItem as ItemInput;
			const isContainerInput = Array.isArray((item as ContainerInput).subtasks);
			if (isContainerInput) {
				const containerInput = item as ContainerInput;
				const resolved = resolve(containerInput, "container", { topicId: topicResolved.id, containerId: null });
				if ("error" in resolved) return failure(resolved.error);
				const itemTitle = validateTitle(containerInput.title, TITLE_MAX.item, "item");
				if (!itemTitle.ok) return failure(itemTitle.error!);
				if (!resolved.existing) {
					summary.createdContainers++;
					if (containerInput.subtasks.length === 0) return failure(`new container "${itemTitle.value}" must contain at least one leaf`);
				}
				const subtasks: Leaf[] = [];
				for (const leafInput of containerInput.subtasks) {
					const built = buildLeaf(leafInput, topicResolved.id, resolved.id);
					if ("error" in built) return failure(built.error);
					subtasks.push(built.leaf);
				}
				items.push({ type: "container", id: resolved.id, title: itemTitle.value, subtasks });
				continue;
			}
			const built = buildLeaf(item as LeafInput, topicResolved.id, null);
			if ("error" in built) return failure(built.error);
			items.push(built.leaf);
		}
		candidateTopics.push({ id: topicResolved.id, title: topicTitle.value, items });
	}

	// --- omission protection ----------------------------------------------
	const omitted: string[] = [];
	for (const [id, node] of existing) {
		if (seen.has(id) || removeSet.has(id)) continue;
		if (isDescendantOfRemoved(node, removeSet)) continue;
		omitted.push(id);
	}
	if (omitted.length > 0) {
		const shown = omitted.slice(0, 8).join(", ");
		const more = omitted.length > 8 ? ` (+${omitted.length - 8} more)` : "";
		return failure(
			`existing nodes were omitted without removeIds: ${shown}${more}. Submit the full tree or list each node in removeIds to cancel it.`,
		);
	}

	// --- resolve blockedBy (request keys first, then stable ids) ------------
	for (const key of declaredKeys) if (generated.has(key)) return failure(`request key "${key}" collides with a generated id; choose another key`);
	for (const topic of candidateTopics) {
		for (const item of topic.items) {
			const leaves = isLeaf(item) ? [item] : item.subtasks;
			for (const leaf of leaves) {
				const resolved: string[] = [];
				const seenRefs = new Set<string>();
				for (const ref of leaf.blockedBy) {
					const mapped = keyToId.get(ref);
					const target = mapped ?? (existingIds.has(ref) || generated.has(ref) ? ref : undefined);
					if (target === undefined) return failure(`leaf ${leaf.id} references unknown prerequisite "${ref}"`);
					resolved.push(target);
					seenRefs.add(target);
				}
				leaf.blockedBy = resolved;
			}
		}
	}

	// --- prune containers emptied by explicit cancellation ------------------
	const candidate = { revision: current.revision, topics: pruneEmpty(candidateTopics, summary) };

	// --- validate the still-complete candidate BEFORE any eviction -----------
	// Dependency, precondition, and in-progress checks run over the full
	// candidate, so evicting completed data can never mask a bad reference.
	const graphError = validateGraph(candidate);
	if (graphError) return failure(graphError);

	// --- retain completed topics, in true completion order -------------------
	// Completed topics stay in the tree with their stable ids, leaves, and
	// dependencies. Each gets an internal, tool-assigned `completedSeq`; an
	// existing topic keeps its sequence by stable id, while a topic that newly
	// becomes completed (brand-new, previously active, or reopened) gets the
	// next sequence in submitted order, so one write is deterministic. A topic
	// that is no longer fully completed loses its sequence (reopen).
	const previous = new Map<string, Topic>();
	for (const topic of current.topics) previous.set(topic.id, topic);
	let nextSeq = 0;
	for (const topic of current.topics) {
		if (typeof topic.completedSeq === "number" && topic.completedSeq > nextSeq) nextSeq = topic.completedSeq;
	}
	for (const topic of candidate.topics) {
		if (!isCompletedTopic(topic)) {
			delete topic.completedSeq;
			continue;
		}
		const prior = previous.get(topic.id);
		if (prior && isCompletedTopic(prior) && typeof prior.completedSeq === "number") {
			topic.completedSeq = prior.completedSeq;
			continue;
		}
		topic.completedSeq = ++nextSeq;
		if (!prior || !isCompletedTopic(prior)) summary.completedTopics.push(topic.title);
	}

	// --- evict only enough completed topics to admit new ones ----------------
	// Incomplete topics are never evicted; if the excess cannot be covered by
	// completed topics the whole write fails and state is untouched. Eviction
	// is the minimum necessary, earliest completion first.
	const excess = candidate.topics.length - MAX_TOPICS;
	if (excess > 0) {
		const evictable = candidate.topics
			.filter(isCompletedTopic)
			.sort((a, b) => (a.completedSeq ?? 0) - (b.completedSeq ?? 0));
		if (evictable.length < excess) {
			return failure(
				`at most ${MAX_TOPICS} topics are allowed at once; ${candidate.topics.length} were submitted and only ${evictable.length} completed topic(s) can be evicted — incomplete topics are never dropped to make room. Finish or cancel a topic first.`,
			);
		}
		const evicted = evictable.slice(0, excess);
		const evictedSet = new Set<Topic>(evicted);
		candidate.topics = candidate.topics.filter((topic) => !evictedSet.has(topic));
		for (const topic of evicted) summary.evictedTopics.push(topic.title);
	}
	const capacityError = validateCapacity(candidate);
	if (capacityError) return failure(capacityError);

	if (sameTopics(current.topics, candidate.topics)) {
		return { ok: true, changed: false, revision: current.revision, snapshot: cloneSnapshot(current), summary };
	}
	candidate.revision = newRevision();
	return { ok: true, changed: true, revision: candidate.revision, snapshot: cloneSnapshot(candidate), summary };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeMismatch(id: string, expected: string, actual: string): string {
	return `id ${id} is a ${actual} but a ${expected} was expected; converting or moving between layers is not allowed`;
}

function collectTopicLeaves(topic: Topic): Leaf[] {
	const leaves: Leaf[] = [];
	for (const item of topic.items) {
		if (isLeaf(item)) leaves.push(item);
		else for (const leaf of item.subtasks) leaves.push(leaf);
	}
	return leaves;
}

/** A topic is completed when it has at least one executable leaf and all are completed. */
function isCompletedTopic(topic: Topic): boolean {
	const leaves = collectTopicLeaves(topic);
	return leaves.length > 0 && leaves.every((leaf) => leaf.status === "completed");
}

function readExistingBlockedBy(snapshot: Snapshot, leafId: string): string[] {
	for (const topic of snapshot.topics) {
		for (const item of topic.items) {
			if (isLeaf(item)) {
				if (item.id === leafId) return item.blockedBy;
			} else {
				for (const leaf of item.subtasks) if (leaf.id === leafId) return leaf.blockedBy;
			}
		}
	}
	return [];
}

function pruneEmpty(topics: Topic[], summary: WriteSummary): Topic[] {
	const kept: Topic[] = [];
	for (const topic of topics) {
		const keptItems: TopicItem[] = [];
		for (const item of topic.items) {
			if (isLeaf(item)) {
				keptItems.push(item);
				continue;
			}
			if (item.subtasks.length === 0) {
				summary.cancelled.push(`cancelled container ${item.id} "${item.title}" (emptied by cancellation)`);
				continue;
			}
			keptItems.push(item);
		}
		topic.items = keptItems;
		if (topic.items.length === 0) {
			summary.cancelled.push(`cancelled topic ${topic.id} "${topic.title}" (emptied by cancellation)`);
			continue;
		}
		kept.push(topic);
	}
	return kept;
}

function isDescendantOfRemoved(node: ExistingNode, removeSet: Set<string>): boolean {
	if (node.type === "container") return removeSet.has(node.topicId);
	if (node.type === "leaf") return removeSet.has(node.topicId) || (node.containerId !== null && removeSet.has(node.containerId));
	return false;
}

interface InputNode {
	id?: string;
	key?: string;
}

function* iterateInputNodes(input: WriteInput): Generator<InputNode> {
	for (const topic of input.topics) {
		yield topic;
		for (const item of topic.items) {
			yield item as InputNode;
			if (!Array.isArray((item as ContainerInput).subtasks)) continue;
			for (const leaf of (item as ContainerInput).subtasks) yield leaf;
		}
	}
}
