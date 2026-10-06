import { isLeaf, SNAPSHOT_KIND, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION_MIN, type Container, type Leaf, type LeafStatus, type Snapshot, type Topic, type TopicItem, type WriteSummary } from "./types.ts";
import { validateCapacity, validateGraph, validateStoredTitles } from "./validate.ts";

/** Empty authoritative state. */
export function emptySnapshot(): Snapshot {
	return { revision: "", topics: [] };
}

/** Copy an optional topic field only when present, so clones stay key-identical. */
function withCompletedSeq(topic: Topic): { completedSeq?: number } {
	return topic.completedSeq === undefined ? {} : { completedSeq: topic.completedSeq };
}

/** Deep clone a snapshot so committed state never shares references with history or callers. */
export function cloneSnapshot(snapshot: Snapshot): Snapshot {
	return {
		revision: snapshot.revision,
		topics: snapshot.topics.map((topic) => ({
			id: topic.id,
			title: topic.title,
			...withCompletedSeq(topic),
			items: topic.items.map((item) =>
				isLeaf(item)
					? { type: "leaf", id: item.id, title: item.title, status: item.status, blockedBy: [...item.blockedBy] }
					: {
							type: "container",
							id: item.id,
							title: item.title,
							subtasks: item.subtasks.map((leaf) => ({
								type: "leaf" as const,
								id: leaf.id,
								title: leaf.title,
								status: leaf.status,
								blockedBy: [...leaf.blockedBy],
							})),
						},
			),
		})),
	};
}

// ---------------------------------------------------------------------------
// Persisted payload: the one envelope both the writer and the parser use
// ---------------------------------------------------------------------------

/**
 * A successful `todo_write` result `details`. The writer builds it through
 * `buildSnapshotEnvelope` and the replay parser accepts exactly this shape, so
 * the two can never drift.
 */
export interface SnapshotEnvelope {
	kind: typeof SNAPSHOT_KIND;
	schemaVersion: number;
	revision: string;
	topics: Topic[];
	/** Report metadata. Always written; optional only for hand-authored payloads. */
	changed: boolean;
	summary: WriteSummary;
}

/** Build the persisted/returned envelope for a successful write. */
export function buildSnapshotEnvelope(snapshot: Snapshot, changed: boolean, summary: WriteSummary): SnapshotEnvelope {
	return {
		kind: SNAPSHOT_KIND,
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		revision: snapshot.revision,
		topics: snapshot.topics,
		changed,
		summary,
	};
}

// ---------------------------------------------------------------------------
// Canonical, model-writable projection (no derived fields, no `type`)
// ---------------------------------------------------------------------------

export interface WritableLeaf {
	id: string;
	title: string;
	status: LeafStatus;
	blockedBy: string[];
}

export interface WritableContainer {
	id: string;
	title: string;
	subtasks: WritableLeaf[];
}

export type WritableItem = WritableLeaf | WritableContainer;

export interface WritableTopic {
	id: string;
	title: string;
	items: WritableItem[];
}

export interface WritableSnapshot {
	revision: string;
	topics: WritableTopic[];
}

/**
 * Project a snapshot into the exact shape `todo_write` accepts (plus the
 * revision to send as `expectedRevision`). Derived fields and the internal
 * `type` discriminator are dropped, so the model can copy this back verbatim.
 */
export function toWritable(snapshot: Snapshot): WritableSnapshot {
	return {
		revision: snapshot.revision,
		topics: snapshot.topics.map((topic) => ({
			id: topic.id,
			title: topic.title,
			items: topic.items.map((item) =>
				isLeaf(item)
					? { id: item.id, title: item.title, status: item.status, blockedBy: [...item.blockedBy] }
					: {
							id: item.id,
							title: item.title,
							subtasks: item.subtasks.map((leaf) => ({
								id: leaf.id,
								title: leaf.title,
								status: leaf.status,
								blockedBy: [...leaf.blockedBy],
							})),
						},
			),
		})),
	};
}

// ---------------------------------------------------------------------------
// Persisted payload parsing
// ---------------------------------------------------------------------------

export type SnapshotParse =
	| { ok: true; snapshot: Snapshot }
	| { ok: false; category: "foreign" | "unsupported" | "corrupt"; reason: string };

const LEAF_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
// The envelope also carries report metadata; it must be accepted (and checked)
// or every real write result would be treated as corrupt on replay.
const ROOT_KEYS = new Set(["kind", "schemaVersion", "revision", "topics", "changed", "summary"]);
const SUMMARY_NUMBER_KEYS = ["createdTopics", "createdContainers", "createdLeaves", "completedLeaves"] as const;
// v2 reported auto-removal as `completedTopicsRemoved`; v3 splits completion
// into folded (`completedTopics`) and capacity eviction (`evictedTopics`).
const SUMMARY_V2_ARRAY_KEYS = ["statusChanges", "cancelled", "completedTopicsRemoved"] as const;
const SUMMARY_V3_ARRAY_KEYS = ["statusChanges", "cancelled", "completedTopics", "evictedTopics"] as const;
const TOPIC_KEYS = new Set(["id", "title", "items", "completedSeq"]);
const LEAF_KEYS = new Set(["type", "id", "title", "status", "blockedBy"]);
const CONTAINER_KEYS = new Set(["type", "id", "title", "subtasks"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) return `unexpected field "${key}"`;
	}
	return undefined;
}

/** Validate the report metadata attached to a snapshot envelope. */
function validateSummary(raw: unknown, version: number): string | undefined {
	if (!isObject(raw)) return "summary must be an object";
	const arrayKeys = version >= 3 ? SUMMARY_V3_ARRAY_KEYS : SUMMARY_V2_ARRAY_KEYS;
	const allowed = new Set<string>([...SUMMARY_NUMBER_KEYS, ...arrayKeys]);
	const extra = onlyKeys(raw, allowed);
	if (extra) return `summary ${extra}`;
	for (const key of SUMMARY_NUMBER_KEYS) {
		const value = raw[key];
		if (value === undefined) return `summary.${key} is required`;
		if (typeof value !== "number" || !Number.isFinite(value)) return `summary.${key} must be a number`;
	}
	for (const key of arrayKeys) {
		const value = raw[key];
		if (value === undefined) return `summary.${key} is required`;
		if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return `summary.${key} must be an array of strings`;
	}
	return undefined;
}

function parseLeaf(raw: unknown): { leaf: Leaf } | { error: string } {
	if (!isObject(raw)) return { error: "leaf must be an object" };
	const keys = onlyKeys(raw, LEAF_KEYS);
	if (keys) return { error: `leaf ${keys}` };
	if (raw.type !== "leaf") return { error: 'leaf must have type "leaf"' };
	if (typeof raw.id !== "string" || raw.id.length === 0) return { error: "leaf id must be a non-empty string" };
	if (typeof raw.title !== "string") return { error: "leaf title must be a string" };
	if (typeof raw.status !== "string" || !LEAF_STATUSES.has(raw.status)) return { error: `leaf ${raw.id} has an invalid status` };
	if (!Array.isArray(raw.blockedBy) || !raw.blockedBy.every((d) => typeof d === "string")) {
		return { error: `leaf ${raw.id} blockedBy must be an array of strings` };
	}
	return { leaf: { type: "leaf", id: raw.id, title: raw.title, status: raw.status as LeafStatus, blockedBy: [...(raw.blockedBy as string[])] } };
}

/**
 * Strictly parse an unknown value as a persisted snapshot payload.
 *
 * Categories let replay distinguish "not ours" (foreign) from "ours but a
 * schema we do not support" (unsupported) from "ours, current schema, but
 * invalid" (corrupt), so a corrupt newer snapshot is reported rather than
 * silently masked by an older state.
 */
export function parseSnapshotPayload(value: unknown): SnapshotParse {
	if (!isObject(value)) return { ok: false, category: "foreign", reason: "details is not an object" };
	if (value.kind !== "pi-todo-list.snapshot") {
		return { ok: false, category: "foreign", reason: "details kind is not pi-todo-list.snapshot" };
	}
	const version = value.schemaVersion;
	if (typeof version !== "number" || !Number.isInteger(version) || version < SNAPSHOT_SCHEMA_VERSION_MIN || version > SNAPSHOT_SCHEMA_VERSION) {
		return {
			ok: false,
			category: "unsupported",
			reason: `unsupported snapshot schemaVersion ${String(version)} (supported ${SNAPSHOT_SCHEMA_VERSION_MIN}..${SNAPSHOT_SCHEMA_VERSION})`,
		};
	}
	const keys = onlyKeys(value, ROOT_KEYS);
	if (keys) return { ok: false, category: "corrupt", reason: keys };
	if (typeof value.revision !== "string") return { ok: false, category: "corrupt", reason: "revision must be a string" };
	if (value.changed !== undefined && typeof value.changed !== "boolean") {
		return { ok: false, category: "corrupt", reason: "changed must be a boolean when present" };
	}
	if (value.summary !== undefined) {
		const summaryError = validateSummary(value.summary, version);
		if (summaryError) return { ok: false, category: "corrupt", reason: summaryError };
	}
	if (!Array.isArray(value.topics)) return { ok: false, category: "corrupt", reason: "topics must be an array" };

	const topics: Topic[] = [];
	for (const rawTopic of value.topics) {
		if (!isObject(rawTopic)) return { ok: false, category: "corrupt", reason: "topic must be an object" };
		const topicKeys = onlyKeys(rawTopic, TOPIC_KEYS);
		if (topicKeys) return { ok: false, category: "corrupt", reason: `topic ${topicKeys}` };
		if (typeof rawTopic.id !== "string" || rawTopic.id.length === 0) {
			return { ok: false, category: "corrupt", reason: "topic id must be a non-empty string" };
		}
		if (typeof rawTopic.title !== "string") return { ok: false, category: "corrupt", reason: "topic title must be a string" };
		if (rawTopic.completedSeq !== undefined && (typeof rawTopic.completedSeq !== "number" || !Number.isFinite(rawTopic.completedSeq))) {
			return { ok: false, category: "corrupt", reason: `topic ${rawTopic.id} completedSeq must be a number` };
		}
		if (!Array.isArray(rawTopic.items)) return { ok: false, category: "corrupt", reason: `topic ${rawTopic.id} items must be an array` };

		const items: TopicItem[] = [];
		for (const rawItem of rawTopic.items) {
			if (!isObject(rawItem)) return { ok: false, category: "corrupt", reason: `topic ${rawTopic.id} has a non-object item` };
			if (rawItem.type === "leaf") {
				const parsed = parseLeaf(rawItem);
				if ("error" in parsed) return { ok: false, category: "corrupt", reason: parsed.error };
				items.push(parsed.leaf);
				continue;
			}
			if (rawItem.type === "container") {
				const itemKeys = onlyKeys(rawItem, CONTAINER_KEYS);
				if (itemKeys) return { ok: false, category: "corrupt", reason: `container ${itemKeys}` };
				if (typeof rawItem.id !== "string" || rawItem.id.length === 0) {
					return { ok: false, category: "corrupt", reason: "container id must be a non-empty string" };
				}
				if (typeof rawItem.title !== "string") return { ok: false, category: "corrupt", reason: "container title must be a string" };
				if (!Array.isArray(rawItem.subtasks)) {
					return { ok: false, category: "corrupt", reason: `container ${rawItem.id} subtasks must be an array` };
				}
				const subtasks: Leaf[] = [];
				for (const rawLeaf of rawItem.subtasks) {
					const parsedLeaf = parseLeaf(rawLeaf);
					if ("error" in parsedLeaf) return { ok: false, category: "corrupt", reason: parsedLeaf.error };
					subtasks.push(parsedLeaf.leaf);
				}
				const container: Container = { type: "container", id: rawItem.id, title: rawItem.title, subtasks };
				items.push(container);
				continue;
			}
			return { ok: false, category: "corrupt", reason: `item in topic ${rawTopic.id} must have type "leaf" or "container"` };
		}
		const topic: Topic = { id: rawTopic.id, title: rawTopic.title, items };
		if (typeof rawTopic.completedSeq === "number") topic.completedSeq = rawTopic.completedSeq;
		topics.push(topic);
	}

	const snapshot: Snapshot = { revision: value.revision, topics };

	const titles = validateStoredTitles(snapshot);
	if (titles) return { ok: false, category: "corrupt", reason: titles };
	const graph = validateGraph(snapshot);
	if (graph) return { ok: false, category: "corrupt", reason: graph };
	const capacity = validateCapacity(snapshot);
	if (capacity) return { ok: false, category: "corrupt", reason: capacity };

	return { ok: true, snapshot: cloneSnapshot(snapshot) };
}
