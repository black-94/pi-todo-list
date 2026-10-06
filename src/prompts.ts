/**
 * Model-facing prompt copy for pi-todo-list.
 *
 * Kept in one place so the tool descriptions, the system-prompt snippet, and
 * the guideline bullets stay consistent. The README reproduces this content.
 */

export const PROMPT_SNIPPET =
	"Track multi-step work as a hierarchical todo tree with prerequisite dependencies";

const TODO_UPDATE_WORKFLOW =
	"Assume no concurrent todo updates by default. If the conversation already contains the full todo tree and its latest revision from todo_read or a successful todo_write, call todo_write directly using those details; do not read before each update. Call todo_read only when those details are missing or once after todo_write fails. After that read, merge/fix the intended update and retry todo_write. Do not repeatedly query without another write attempt. Resuming, navigating the session tree, or compacting alone does not require a read when the details remain in the conversation.";

export const TODO_WRITE_DESCRIPTION = [
	"Replace the session's todo tree with a complete snapshot.",
	TODO_UPDATE_WORKFLOW,
	"Three layers: a topic (container), layer-2 items, and layer-3 leaves. A layer-2 item is either an executable leaf (numbered 1, 2, ...) or a container of layer-3 leaves (numbered 1.1, 1.2, ...); a topic may mix both.",
	"Only executable leaves carry status (pending | in_progress | completed) and blockedBy; container status is derived and cannot be set by hand.",
	"At most 3 topics, at most one in-progress leaf per topic, and at most 3 in-progress leaves overall.",
	"A topic whose leaves are all completed is kept in the tree and shown as one folded summary line; it is never dropped just for being complete.",
	"Completed topics still occupy the 3 topic slots. When adding new topics would exceed 3, the tool automatically evicts the minimum number of completed topics, earliest completed first; a topic with any unfinished leaf is never evicted, so adding a fourth topic while all three are unfinished fails the write.",
	"Pass every existing node back unless you explicitly cancel it via removeIds — including completed topics. Never omit or cancel a completed topic to make room; the tool evicts completed topics itself. Prefer copying the `writable` object returned by todo_read or todo_write.",
].join(" ");

export const TODO_READ_DESCRIPTION = [
	"Read the current session branch's todo tree. Returns the revision, stable IDs, derived status, display numbers, the single-leaf flattening map, dependency/blocking details, leaf and topic counts (active/completed), and a `writable` object you can copy into the next todo_write. Completed topics are retained with their full descendants in the returned hierarchy even though the panel folds them to one line. Read-only: it never changes state.",
	TODO_UPDATE_WORKFLOW,
].join(" ");

export const PROMPT_GUIDELINES: string[] = [
	"Use todo_read/todo_write for complex or multi-step work (three or more steps), when the user gives a list of tasks, or right after receiving new instructions. Skip it for single trivial tasks and pure conversation.",
	TODO_UPDATE_WORKFLOW,
	"Prefer writing back the latest `writable` object already in the conversation from a successful todo_write or todo_read, changing only statuses, blockedBy, and the nodes you add or remove. Its `topics` field uses exactly the shape todo_write accepts; reuse its latest revision as expectedRevision. A successful todo_write returns the full writable tree for the next update; no intervening read is needed.",
	"A layer-2 item without `subtasks` is an executable leaf; with `subtasks` it is a container. Do not put status or blockedBy on a container, and never nest subtasks inside a leaf.",
	"Keep at most 3 independent topics. Completed topics still count toward the limit: start a new topic freely while a slot is free, and rely on the tool to evict the earliest-completed topics when starting new ones would exceed 3. Never drop an unrelated active topic to make room.",
	"Mark a leaf in_progress before starting it and completed immediately after it is done. Never mark a leaf completed while its verification (tests, checks) fails, the work is partial, or errors are unresolved.",
	"At most one leaf per topic may be in_progress at a time. Leave other work pending.",
	"todo_write submits the whole tree. Every existing topic, item, and leaf must appear again unless listed in removeIds; omitting one is rejected. This includes completed topics — keep submitting them with status completed. Completing a leaf means submitting it with status completed, never leaving it out.",
	"Stable IDs are identity. Display numbers (1, 2.1, ...) are computed from position and may change as the tree grows; never treat a number as an ID.",
	"Never flatten the submitted data yourself. Even a topic with a single executable leaf keeps its topic/item/leaf layers in the write; the widget flattens it for display only.",
	"To create leaves that depend on each other in one write, give the new leaves request-scoped keys and reference those keys in blockedBy. Keys are resolved to stable IDs on commit; only stable IDs are stored. Layer-2 and layer-3 leaves in the same topic may depend on each other.",
	"Do not advance a leaf to in_progress or completed while any prerequisite listed in blockedBy is not completed.",
	"Use removeIds only to cancel work the user confirmed should be dropped. Never use removeIds to hide a dependency you do not want to satisfy, never delete a prerequisite to bypass blocking, and never use it to free a topic slot for a new topic.",
	"When a topic's leaves are all completed it is kept in the tree with its IDs and dependencies and shown as one folded summary line. It keeps its slot until starting new topics would exceed 3, at which point the tool evicts the earliest-completed topics automatically.",
];
