/**
 * Domain types for pi-todo-list.
 *
 * The tree has at most three layers:
 *   topic (container, unnumbered)
 *     -> item  (layer 2): either an executable leaf, or a container of layer-3 leaves
 *        -> leaf (layer 3): executable
 *
 * Executable leaves (layer 2 leaves and layer-3 leaves) carry status and
 * blockedBy. Containers derive their status. Display numbers are a pure view
 * computation and are never stored as identity. Numbering mixes layers, e.g.
 * `1` for a layer-2 leaf and `2.1` for a layer-3 leaf.
 */

/** Executable-leaf lifecycle status. There is no stored "blocked" status. */
export type LeafStatus = "pending" | "in_progress" | "completed";

/** Status of a container, derived from its descendant executable leaves. */
export type DerivedStatus = LeafStatus;

/** Maximum title length per layer, counted in Unicode grapheme clusters. */
export const TITLE_MAX = {
	/** Topic title. */
	topic: 24,
	/** Layer-2 item title (leaf or container). */
	item: 32,
	/** Layer-3 leaf title. */
	leaf: 40,
} as const;

/** Hard cap on simultaneously present top-level topics. */
export const MAX_TOPICS = 3;

/** Hard cap on nesting depth: topic -> item -> leaf. */
export const MAX_DEPTH = 3;

/** Hard cap on concurrently in-progress executable leaves, globally. */
export const MAX_IN_PROGRESS_GLOBAL = 3;

/** Snapshot discriminator stored in a successful `todo_write` result `details`. */
export const SNAPSHOT_KIND = "pi-todo-list.snapshot";

/** Discriminator for a `todo_read` result `details` (never replayed as state). */
export const READ_KIND = "pi-todo-list.read";

/** Discriminator for a failed `todo_write` result `details` (never replayed). */
export const WRITE_ERROR_KIND = "pi-todo-list.write-error";

/**
 * Current persisted schema version.
 *
 * v3 adds an internal, tool-only `completedSeq` on topics (completion order for
 * retention/eviction) and replaces `summary.completedTopicsRemoved` with
 * `summary.completedTopics` / `summary.evictedTopics`. v2 snapshots stay
 * readable (see `parseSnapshotPayload`); new writes always emit v3.
 */
export const SNAPSHOT_SCHEMA_VERSION = 3;

/** Oldest persisted schema version the parser still accepts and migrates. */
export const SNAPSHOT_SCHEMA_VERSION_MIN = 2;

/** An executable leaf, at layer 2 or layer 3. */
export interface Leaf {
	type: "leaf";
	/** Stable identity. Never changes because of display numbering or flattening. */
	id: string;
	title: string;
	status: LeafStatus;
	/** Stable IDs of prerequisite executable leaves in the same topic; empty when none. */
	blockedBy: string[];
}

/** A layer-2 container holding layer-3 leaves. */
export interface Container {
	type: "container";
	id: string;
	title: string;
	subtasks: Leaf[];
}

/** A layer-2 item: an executable leaf or a container. */
export type TopicItem = Leaf | Container;

export interface Topic {
	id: string;
	title: string;
	items: TopicItem[];
	/**
	 * Internal completion-order marker, assigned and maintained only by the
	 * tool. Present iff the topic is currently fully completed. It orders
	 * eviction when the topic cap is exceeded; it is never user- or
	 * model-authorable (the `writable` projection omits it and the writer
	 * restores it from committed state by stable id). Absent in v2 snapshots.
	 */
	completedSeq?: number;
}

/** Canonical authoritative state. `revision` identifies this exact tree. */
export interface Snapshot {
	revision: string;
	topics: Topic[];
}

/**
 * Report metadata attached to a successful `todo_write` envelope. Lives in
 * `details` alongside the snapshot and is validated on replay.
 */
export interface WriteSummary {
	createdTopics: number;
	createdContainers: number;
	createdLeaves: number;
	completedLeaves: number;
	statusChanges: string[];
	cancelled: string[];
	/** Topics that became fully completed in this write and were folded (kept). */
	completedTopics: string[];
	/** Completed topics evicted to make room when new topics exceeded the cap. */
	evictedTopics: string[];
}

/** Empty authoritative state. `revision` is `""` when no snapshot exists yet. */
export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({ revision: "", topics: [] }) as Snapshot;

export function isLeaf(item: TopicItem): item is Leaf {
	return item.type === "leaf";
}

export function isContainer(item: TopicItem): item is Container {
	return item.type === "container";
}

/** A leaf located within the tree, with its container context. */
export interface LeafLocation {
	topic: Topic;
	topicIndex: number;
	/** The layer-2 item that directly owns the leaf. */
	item: TopicItem;
	itemIndex: number;
	leaf: Leaf;
	/** Index inside a container's subtasks, or undefined for a layer-2 leaf. */
	subtaskIndex: number | undefined;
}
