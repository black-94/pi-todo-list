import { type Static, Type } from "typebox";

const STRICT = { additionalProperties: false } as const;

const idField = Type.Optional(
	Type.String({ description: "Stable ID of an existing node. Omit to create a new node (the tool assigns its ID)." }),
);
const keyField = Type.Optional(
	Type.String({
		description:
			"Request-scoped alias usable only inside this write, so new leaves can reference each other by key before IDs exist. Referenced from blockedBy. Must not duplicate another key or an existing ID.",
	}),
);
const statusField = Type.Optional(
	Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
		description:
			"Leaf status. New leaves default to pending. Existing leaves keep their current status when omitted; completed must be stated explicitly, never implied by omission.",
	}),
);
const blockedByField = Type.Optional(
	Type.Array(Type.String(), {
		description:
			"Prerequisite executable-leaf references. Each entry is either a request key declared in this same write, or a stable leaf ID in the same topic. Layer-2 leaves and layer-3 leaves may reference each other. Containers cannot be referenced. Omit to keep an existing leaf's dependencies; pass [] to clear them.",
	}),
);

/**
 * An executable leaf (layer 2 or layer 3). Presence of `subtasks` on a layer-2
 * item makes it a container instead; the two shapes are mutually exclusive
 * because both reject the other's fields.
 */
export const LeafItemSchema = Type.Object(
	{
		id: idField,
		key: keyField,
		title: Type.String({ description: "Leaf title. At most 40 Unicode characters (grapheme clusters) at layer 3, at most 32 at layer 2; trimmed; no line breaks." }),
		status: statusField,
		blockedBy: blockedByField,
	},
	{ ...STRICT, description: "An executable leaf (has status/blockedBy, no subtasks)." },
);

/** A layer-2 container of layer-3 leaves. */
export const ContainerItemSchema = Type.Object(
	{
		id: idField,
		key: keyField,
		title: Type.String({ description: "Container title. At most 32 Unicode characters (grapheme clusters), trimmed; no line breaks." }),
		subtasks: Type.Array(LeafItemSchema, {
			description:
				"Layer-3 leaves of this container. A new container must have at least one. An empty array is accepted only for an existing container whose leaves were all listed in removeIds, in which case the emptied container is cancelled and pruned. Containers have no status or blockedBy.",
		}),
	},
	{ ...STRICT, description: "A layer-2 container of layer-3 leaves (no status/blockedBy)." },
);

/**
 * A layer-2 item: either an executable leaf (no `subtasks`) or a container
 * (with `subtasks`). The two are unambiguous under `additionalProperties:false`.
 */
export const ItemInputSchema = Type.Union([LeafItemSchema, ContainerItemSchema], {
	description:
		"A layer-2 item. Omit `subtasks` for an executable leaf (status/blockedBy allowed); include `subtasks` for a container (status/blockedBy forbidden). A topic may mix both.",
});

export const TopicInputSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ description: "Stable ID of an existing topic. Omit to create a new topic." })),
		key: Type.Optional(Type.String({ description: "Request-scoped alias for a new topic." })),
		title: Type.String({ description: "Topic title. At most 24 Unicode characters (grapheme clusters), trimmed; no line breaks." }),
		items: Type.Array(ItemInputSchema, {
			description:
				"Items of this topic. A new topic must have at least one. An empty array is accepted only for an existing topic whose items were all listed in removeIds, in which case the emptied topic is cancelled and pruned.",
		}),
	},
	{ ...STRICT },
);

/** `todo_write` parameters. */
export const TodoWriteParamsSchema = Type.Object(
	{
		expectedRevision: Type.String({
			description:
				'Latest revision already in the conversation from a successful todo_write or todo_read. Reuse it directly; do not query before each update. "" for a session with no snapshot yet. If details are missing, read first; after a failed write, call todo_read once, merge/fix, and retry.',
		}),
		topics: Type.Array(TopicInputSchema, {
			description:
				"Complete tree snapshot, including completed topics (they are kept, not removed automatically). Every existing topic/item/leaf must be present unless listed in removeIds. At most 3 topics; adding new topics beyond 3 automatically evicts the earliest-completed topics, never a topic with unfinished leaves. Prefer copying the latest `writable` object already in the conversation from a successful todo_write or todo_read.",
		}),
		removeIds: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Stable IDs to cancel in this same write. Use only for confirmed cancellation, never for completion and never to free a topic slot for a new topic (the tool evicts completed topics when capacity requires it). Removing a topic or container also removes its descendants. Required if a node is intentionally dropped; omission otherwise fails.",
			}),
		),
	},
	{ ...STRICT },
);

/** `todo_read` takes no arguments. */
export const TodoReadParamsSchema = Type.Object({}, { ...STRICT });

export type TodoWriteParams = Static<typeof TodoWriteParamsSchema>;
export type TodoReadParams = Static<typeof TodoReadParamsSchema>;
