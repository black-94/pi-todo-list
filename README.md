# pi-todo-list

A session-scoped, hierarchical todo list extension for [Pi](https://pi.dev).

- **Up to three layers**: a topic (container) → layer-2 items → layer-3 leaves. A layer-2 item is **either an executable leaf** (numbered `1`, `2`, …) **or a container** of layer-3 leaves (numbered `1.1`, `1.2`, …). A topic may mix both.
- **Only executable leaves carry status** (`pending` / `in_progress` / `completed`) and `blockedBy`; container status is derived.
- **Prerequisite dependencies** between executable leaves of the same topic, with a derived blocked state.
- **Completed topics are retained** with their stable IDs, leaves, and dependencies, folded to one summary line. They keep their topic slot and are only evicted (earliest completion first) when starting new topics would exceed the three-topic cap; a topic with any unfinished leaf is never evicted.
- **Branch-safe persistence**: state is reconstructed from the current session branch (rollback, forks, compaction, resume, clone).
- **Two tools only**: `todo_write` and `todo_read`. No `/todos` command, no legacy `todo` tool.

---

## Install

Requires Node.js **22.19.0 or newer** and Pi. The npm package name is **`@black942026/pi-todo-list`**.

```bash
pi install npm:@black942026/pi-todo-list
# Or install from Git:
pi install git:github.com/black-94/pi-todo-list
```

For local development:

```bash
pi -e ./index.ts # try it for one invocation
pi install ./   # install the local package
```

Restart Pi or run `/reload` after installation. The package manifest declares `pi.extensions: ["./index.ts"]`, relative to the **package root**. This public entry forwards to `src/index.ts`; both `index.ts` and the complete `src/` tree are published. Pi loads TypeScript with `jiti`; no build step is required. Do not copy `index.ts` alone into an extensions directory — its relative imports need `src/` beside it.

Host packages are declared as `peerDependencies` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) so a duplicate copy is not bundled.

## What the model is told

All model-facing copy lives in [`src/prompts.ts`](src/prompts.ts) and is wired in through `registerTool`'s `promptSnippet` / `promptGuidelines`. The current text is:

**Prompt snippet**

> Track multi-step work as a hierarchical todo tree with prerequisite dependencies

**Guidelines**

1. Use `todo_read`/`todo_write` for complex or multi-step work (three or more steps), when the user gives a list of tasks, or right after receiving new instructions. Skip it for single trivial tasks and pure conversation.
2. Assume no concurrent todo updates by default. If the conversation already contains the full todo tree and its latest revision from `todo_read` or a successful `todo_write`, call `todo_write` directly using those details; do not read before each update. Call `todo_read` only when those details are missing or once after `todo_write` fails. After that read, merge/fix the intended update and retry `todo_write`. Do not repeatedly query without another write attempt. Resuming, navigating the session tree, or compacting alone does not require a read when the details remain in the conversation.
3. Prefer writing back the latest `writable` object already in the conversation from a successful `todo_write` or `todo_read`, changing only statuses, `blockedBy`, and the nodes you add or remove. Its `topics` field uses exactly the shape `todo_write` accepts; reuse its latest revision as `expectedRevision`. A successful `todo_write` returns the full writable tree for the next update; no intervening read is needed.
4. A layer-2 item without `subtasks` is an executable leaf; with `subtasks` it is a container. Do not put status or `blockedBy` on a container, and never nest subtasks inside a leaf.
5. Keep at most 3 independent topics. Completed topics still count toward the limit: start a new topic freely while a slot is free, and rely on the tool to evict the earliest-completed topics when starting new ones would exceed 3. Never drop an unrelated active topic to make room.
6. Mark a leaf `in_progress` before starting it and `completed` immediately after it is done. Never mark a leaf `completed` while its verification fails, the work is partial, or errors are unresolved.
7. At most one leaf per topic may be `in_progress` at a time.
8. `todo_write` submits the whole tree. Every existing topic, item, and leaf must appear again unless listed in `removeIds`; omitting one is rejected. This includes completed topics — keep submitting them with status `completed`. Completing a leaf means submitting it with status `completed`, never leaving it out.
9. Stable IDs are identity. Display numbers (`1`, `2.1`, …) are computed from position and may change as the tree grows; never treat a number as an ID.
10. Never flatten the submitted data yourself. Even a topic with a single executable leaf keeps its topic/item/leaf layers in the write; the widget flattens it for display only.
11. To create leaves that depend on each other in one write, give the new leaves request-scoped keys and reference those keys in `blockedBy`. Keys are resolved to stable IDs on commit; only stable IDs are stored. Layer-2 and layer-3 leaves in the same topic may depend on each other.
12. Do not advance a leaf to `in_progress` or `completed` while any prerequisite in `blockedBy` is not completed.
13. Use `removeIds` only to cancel work the user confirmed should be dropped. Never use `removeIds` to hide a dependency, never delete a prerequisite to bypass blocking, and never use it to free a topic slot for a new topic.
14. When a topic's leaves are all completed it is kept in the tree with its IDs and dependencies and shown as one folded summary line. It keeps its slot until starting new topics would exceed 3, at which point the tool evicts the earliest-completed topics automatically.

---

## Tools

### `todo_write`

Replace the session's todo tree with a complete snapshot. **Exposure: `model-only`**, **execution mode: `sequential`**.

Default update flow (assume no concurrency):

1. If the conversation contains the full tree and latest revision, update directly with `todo_write`.
2. If those details are missing, call `todo_read` once, then update.
3. If the update fails, call `todo_read` once, merge/fix the intended change, and retry `todo_write` rather than repeatedly querying.
4. Reuse each successful write's returned `writable` tree for the next update; do not routinely read between writes, including after resume/tree navigation/compaction when the details remain available.

Revision validation and full-snapshot safety checks still apply; only the model's read/write workflow changes.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `expectedRevision` | `string` | yes | Latest revision already in the conversation from a successful `todo_write` or `todo_read`; reuse directly. `""` when the session has no snapshot yet. A mismatch is rejected; read once, merge, and retry. |
| `topics` | `Topic[]` | yes | The full tree, including completed topics (they are retained, not removed automatically). At most 3 topics. |
| `removeIds` | `string[]` | no | Stable IDs to cancel in this same write (topics, containers, or leaves). Use only for confirmed cancellation — never to free a slot. Removing a container or topic also removes its descendants. |

A topic whose executable leaves are all `completed` is kept in the tree; the panel folds it to a single summary line. It keeps occupying a topic slot. Only when adding new topics would push the tree past three topics does the tool evict completed topics — the minimum number, earliest completion first — and it never evicts a topic with an unfinished leaf. So finishing a topic and starting a new one in the same write still works, but an unfinished tree of three topics cannot accept a fourth (that write fails atomically).

`Topic`

| Field | Type | Notes |
| --- | --- | --- |
| `id` / `key` | `string?` | Stable ID of an existing topic, or a request-scoped key for a new one. |
| `title` | `string` | ≤ 24 grapheme clusters, trimmed, no line breaks/control chars. |
| `items` | `Item[]` | At least one for a new topic. |

`Item` (layer 2) — distinguished by the presence of `subtasks`:

| Shape | Fields | Notes |
| --- | --- | --- |
| executable leaf | `id?`, `key?`, `title`, `status?`, `blockedBy?` | `title` ≤ 32 grapheme clusters. New leaves default to `pending`. |
| container | `id?`, `key?`, `title`, `subtasks` | `title` ≤ 32. `subtasks` is a non-empty array of layer-3 leaves. **No** `status`/`blockedBy`. |

Layer-3 leaf: `id?`, `key?`, `title` (≤ 40), `status?`, `blockedBy?`. A leaf never has `subtasks`.

`blockedBy` entries are either a request key declared in the same write, or a stable leaf ID in the same topic. Omit to keep an existing leaf's dependencies; pass `[]` to clear them. Containers cannot be referenced.

All protocol objects use `additionalProperties: false`, so unknown fields, a container's `status`/`blockedBy`, a leaf with `subtasks`, and any fourth layer are rejected. `subtasks: []` and `items: []` are schema-valid so an explicit `removeIds` of the last child can be expressed; the domain rejects a **new** empty container/topic and prunes (as a cancellation) only an **existing** container/topic whose children were all cancelled. The domain layer re-validates the same rules, so a schema-bypassing caller cannot produce an unreplayable tree.

### `todo_read`

Read the current branch's tree. **Exposure: `direct`**. No parameters. It never changes authoritative state.

Returns the revision, stable IDs, derived status, display numbers, the single-leaf flattening map, dependency/blocking details, leaf counts, and a `writable` object — the canonical shape to copy into the next `todo_write`. Use it when the conversation lacks the full tree/revision or once after an update fails, not as a prerequisite for every update.

### Request-scoped keys

A `key` is an alias valid only inside one `todo_write`, so brand-new leaves can reference each other before stable IDs exist:

```json
{
  "expectedRevision": "",
  "topics": [
    {
      "key": "auth",
      "title": "Auth refactor",
      "items": [
        { "key": "analyse", "title": "Analyse logs" },
        { "title": "Fix flow", "subtasks": [
          { "key": "schema", "title": "Update schema" },
          { "title": "Write migration", "blockedBy": ["schema"] }
        ] }
      ]
    }
  ]
}
```

A `blockedBy` entry resolves to a request key first, then to a stable ID. Keys that duplicate another key or collide with an existing ID are rejected, and keys never appear in stored state.

---

## Examples

Create a mixed tree. This is one valid `todo_write` call for a session with no snapshot yet:

```json
{
  "expectedRevision": "",
  "topics": [
    {
      "title": "Auth refactor",
      "items": [
        { "title": "Analyse error logs" },
        {
          "title": "Fix auth flow",
          "subtasks": [{ "title": "Draft spec" }, { "title": "Review spec" }, { "title": "Implement" }]
        }
      ]
    }
  ]
}
```

Start and complete work. Copy `todo_read`'s `writable` object, then change statuses. Only **one** leaf per topic may be `in_progress`:

```json
{
  "expectedRevision": "…",
  "topics": [
    {
      "id": "t1",
      "title": "Auth refactor",
      "items": [
        { "id": "l0", "title": "Analyse error logs", "status": "completed" },
        {
          "id": "c1",
          "title": "Fix auth flow",
          "subtasks": [
            { "id": "l1", "title": "Draft spec", "status": "completed" },
            { "id": "l2", "title": "Review spec", "status": "in_progress", "blockedBy": ["l1"] },
            { "id": "l3", "title": "Implement" }
          ]
        }
      ]
    }
  ]
}
```

Cancel confirmed work (a layer-3 leaf), and provide the remaining tree. The cancelled node is reported, and `l2`'s dependency is cleared in the same write:

```json
{
  "expectedRevision": "…",
  "removeIds": ["l3"],
  "topics": [
    {
      "id": "t1",
      "title": "Auth refactor",
      "items": [
        { "id": "l0", "title": "Analyse error logs", "status": "completed" },
        {
          "id": "c1",
          "title": "Fix auth flow",
          "subtasks": [
            { "id": "l1", "title": "Draft spec", "status": "completed" },
            { "id": "l2", "title": "Review spec", "status": "in_progress", "blockedBy": ["l1"] }
          ]
        }
      ]
    }
  ]
}
```

To cancel the only leaf of a container, list that leaf in `removeIds` and pass `"subtasks": []` for the container: the emptied container (and an emptied topic) is cancelled and pruned. When every leaf of a topic is `completed`, the topic is retained and folded; it is evicted only if starting new topics would exceed the three-topic cap.

---

## UI

A tree panel is drawn above the editor:

```
● TODOS (2/5)
├─ ◐ Auth refactor
│  ├─ ✓ 1 Analyse error logs
│  └─ ◐ 2 Fix auth flow
│     ├─ ✓ 2.1 Draft spec
│     ├─ ◐ 2.2 Review spec ⛓ 2.1
│     └─ ○ 2.3 Implement
└─ ○ Fix login bug
```

Five executable leaves, two completed; `Auth refactor` and `Fix auth flow` are `in_progress` because `2.2` is, while `Analyse error logs` is complete and the flattened `Fix login bug` is pending. The heading reads `TODOS (2/5)`: two completed leaves (`Analyse error logs`, `Draft spec`) out of five total executable leaves.

- Heading: `● TODOS (completed/total executable leaves)`. There is no topic count and no separator dot. **Completed** = leaves whose status is `completed` — `pending` and `in_progress` are not counted, and a blocked `pending` leaf is still not completed. **Total** = every executable leaf in the tree (`countSnapshot.leaves`), including the leaves of retained, folded completed topics; leaves removed by capacity eviction or explicit `removeIds` cancellation are no longer counted. Containers are never counted. The leading glyph and its color still track activity, not the numerator: `●` when any leaf is unfinished (`pending` + `in_progress` > 0), otherwise `○`.
- Icons: `○` pending, `◐` in progress, `✓` completed.
- Topics are unnumbered; layer-2 items are `1`, `2`, …; layer-3 leaves are `1.1`, `1.2`, ….
- Dependencies render as `⛓ <display number>`; unmet prerequisites are highlighted (`warning`), met ones dimmed.
- **Flattening**: a topic whose subtree holds exactly one executable leaf is shown as a single numberless leaf row — for both `topic → leaf` and `topic → container → leaf`. The data keeps every layer, and the tree view returns once that topic has more leaves.
- **Completed topics fold**: a topic whose leaves are all completed renders as a single `✓ <topic title>` row (a single-leaf completed topic stays its one flattened leaf row). Its descendants are never expanded in the panel, even with the global expand shortcut, and no `+N more` placeholder is shown. `todo_read` still returns the complete hierarchy.
- **Compact mode** caps the body and gives every topic an equal share of rows, so one large topic cannot hide the others. Each topic keeps its overview and ancestor rows (numbers stay correct) and reports `+N more`. Press **`alt+t`** (or expand tool output, default `ctrl+o`) to expand; press again to collapse.
- Colors come from the active Pi theme; lines are truncated to the terminal width. An empty list hides the panel.
- Headless (`json`/`print`) modes work with no TUI dependency.

Tool-call and tool-result lines are rendered as width-safe components that compute themed text at render time (no cached colored strings); they are truncated with Pi's `truncateToWidth`.

---

## Session mechanism

State is persisted in the **`details` of a successful `todo_write` tool result**, not in external files:

```
details = {
  kind: "pi-todo-list.snapshot",
  schemaVersion: 3,
  revision: <uuid>,
  topics: [...],            // each completed topic carries an internal completedSeq
  changed: true,
  summary: { createdTopics, createdContainers, createdLeaves, completedLeaves, statusChanges, cancelled, completedTopics, evictedTopics }
}
```

One shared `SnapshotEnvelope` type builds this on write and parses it on replay, so the writer and parser cannot drift. The report metadata (`changed`, `summary`) is accepted and validated too. `schemaVersion` 3 adds the tool-only `completedSeq` on each completed topic and splits completion reporting into `completedTopics` (newly completed and folded) and `evictedTopics` (completed topics dropped to make room for new ones). It also replaces the v2 `completedTopicsRemoved` summary field. The parser accepts **both v2 and v3**; a v2 snapshot is read as-is (its completed topics simply have no `completedSeq` yet) and is migrated with stable completion-order metadata on the next successful write, so existing sessions never roll back to empty or report `unsupported`.

`completedSeq` is never model-authored: the `writable` projection omits it, and the writer restores it from committed state by stable topic ID. Renaming, reordering, or a no-op write therefore cannot change eviction priority.

On `session_start`, `session_tree`, and `session_compact`, the extension replays `sessionManager.getBranch()` in order:

- Foreign payloads (other tools, the legacy `{ tasks, nextId }` shape) are ignored silently.
- Payloads that are clearly this extension's but have an **unsupported schema version** or are **corrupt** are skipped *and* reported as diagnostics on the console, so a damaged newer snapshot is surfaced instead of silently masked by an older state.
- The last valid snapshot wins; an empty-but-valid snapshot beats an older non-empty one and never resurrects old tasks.
- Parsing reuses the domain invariants (structure, unique IDs, non-empty containers, titles, dependency legality, preconditions, in-progress limits, topic cap), so a snapshot with a cycle, a dangling or container dependency, a blocked-but-advanced leaf, multiple in-progress leaves, a hidden fourth layer, or >3 topics is rejected.

`todo_write` and `todo_read` read the committed per-session snapshot. The first access in a session seeds the cache by replaying the branch; lifecycle events re-seed it. A successful write commits atomically to the cache before its result is persisted, so several sequential writes in one assistant turn compose correctly even before their results reach the branch. The widget refreshes from the just-committed cache, never by replaying the branch at `tool_execution_end` (the branch is one entry behind there).

`todo_write` is `model-only`: nested tool calls made through `ctx.executeTool()` do not create their own persisted tool result, so a nested write could only update memory and would not survive a reload. `todo_read` is `direct` because it is read-only.

**Cancellation and completion are distinct.** `removeIds` cancels nodes (parent removal covers descendants) and every cancelled node is reported in `summary.cancelled`. A topic whose leaves are all completed is **retained** and reported in `summary.completedTopics` (newly completed and folded). Only when new topics exceed the cap does the tool evict completed topics, reported separately in `summary.evictedTopics`; completed is never reported as cancelled. Neither silently hides rows.

**Abort.** Each tool checks the `signal` passed to `execute()` (its third argument) before doing any work and again at the commit boundary. An aborted call returns an error result and changes neither the cache nor the tree; it never emits a success snapshot. Validation and commit are synchronous, so those two checks are the only interruption points.

---

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest --run
npm run pack:check   # real Pi loader + packed-package tests + npm pack --dry-run
```

## Publishing

```bash
npm publish
```

`publishConfig.access` is `public`, so the scoped npm package is published publicly. The `prepublishOnly` hook runs typechecking, the full test suite, and the package checks before publishing. The `pi-package` keyword enables Pi package gallery discovery; no separate extension artifact is needed.

Source layout:

```
index.ts              public Pi extension entry, forwards to src/index.ts
src/
  index.ts            extension factory: two tools, lifecycle, widget, shortcut
  prompts.ts          all model-facing copy
  tool/schemas.ts     TypeBox union schemas with additionalProperties:false
  tool/format.ts      read/write text (IDs, revision, canonical writable JSON)
  domain/             types, graphemes, ids, status, dependencies, validate, view, snapshot, write
  state/              per-session cache and branch replay
  widget/             rendering and the widget controller
```

---

## Boundaries and deliberate decisions

- Three layers only. A topic must have at least one item; a container at least one leaf. A layer-2 leaf has no children, so a fourth layer is impossible to express and is rejected if attempted.
- At most **3 topics**, **one `in_progress` leaf per topic**, **3 `in_progress` leaves overall**.
- Container status is derived (all leaves completed → `completed`; any in-progress → `in_progress`; else `pending`). An empty leaf set is never `completed`. Containers cannot be marked complete by hand.
- Dependencies are only between executable leaves of the same topic, across layer 2 and layer 3. Self-dependencies, cross-topic references, container targets, dangling IDs, and cycles are rejected.
- Validation runs over the whole candidate **before** any completed topic is evicted, so an all-completed subtree cannot hide a cycle, a bad target, or a dangling prerequisite. Capacity is enforced only after eviction, so finishing a topic and starting a new one in the same write works, and a fourth topic with three unfinished ones fails atomically.
- Completed topics are retained, ordered by an internal tool-assigned `completedSeq`; eviction is by true completion order (not array position) and evicts the minimum number needed, earliest first. Never evicts a topic with unfinished leaves, and never all topics.
- Nodes may not change layer or parent (no container/leaf conversion, no moving a container across topics or a leaf across containers). Reordering within the same parent is allowed.
- The only way to drop an existing node is `removeIds`; otherwise omission fails. Removing a node another leaf references requires clearing that reference in the same write.
- `revision` is a UUID per successful snapshot; a write equal to the current tree is a no-op that keeps the revision. A stale `expectedRevision` is rejected.
- Not implemented: free-form `description`/`activeForm`/`metadata`, a `/todos` command, legacy task operations, multi-locale/i18n, lazy overlays.

---

## Verification

```bash
npm run typecheck   # tsc --noEmit — exit 0
npm test            # vitest --run
npm run pack:check  # real Pi loader + packed-package tests; no node_modules in tarball
```

Coverage (see `test/`):

- `domain.test.ts` — graphemes/titles, derived status (empty ≠ completed), mixed numbering (`1` beside `2.1`), flatten for two- and three-layer topics, stable IDs, cross-layer dependency numbers, snapshot categories, v2/v3 schema compatibility (summary shape per version, `completedSeq` round-trip/rejection), `writable` projection (drops `completedSeq`) and clone.
- `write.test.ts` — 3-topic cap, fourth-layer rejection, per-layer title limits, container `status`/`blockedBy` and unknown/invalid fields, conversion/move rejection, per-topic and global in-progress limits, self/cycle/dangling/cross-topic/container dependencies, request keys, blocked start/complete, omission protection, unknown/duplicate `removeIds`, cancellation recording and pruning, **validate-before-eviction regressions** (all-completed cycle/self/container/cross-topic; cancel-prerequisite with a completed dependent), **completed-topic retention**, capacity eviction by true completion order (independent of array order/rename), minimum eviction across multiple new topics, 3-unfinished + new rejection, reopen/re-complete resequencing, dependency preservation in a retained topic, no-op, revision conflict, atomic rollback.
- `retention.test.ts` — **the real tool's `details`** for retained completed topics: read returns full descendants while `display` folds; `writable` round-trip preserves `completedSeq` with `changed:false`; rename/reorder do not change eviction priority; whole-candidate validation runs before eviction (a bad evicted topic is not masked); explicit cancel still replays as empty after a cache clear; **legacy v2 snapshot** reads and migrates on the next write; strict parser rejects corrupt `completedSeq` yet accepts the real writer; **branch A/B reproduce different eviction choices**; **real file-backed session** persists `completedSeq`/`evictedTopics` through reopen, fork, compaction, and rollback to the pre-eviction head.
- `replay.test.ts` — last-valid-wins, foreign ignored, unsupported/corrupt reported as diagnostics, empty snapshot wins, branches, compaction, clone-on-read.
- `envelope.test.ts` — **the real registered tool's full `details`** (with `changed`/`summary`) appended verbatim, then cache cleared and a new factory used: replay from the branch, IDs/status/dependencies preserved, diagnostics empty, and the same for a real retained completed topic after the last leaf completes; a corrupt summary is reported rather than masked.
- `widget.test.ts` — heading counts (`TODOS (completed/total)`: only completed leaves counted, mixed pending/in_progress/completed and blocked pending excluded, fully completed retained, folded completed topic, capacity-evicted leaves excluded), a completed leaf staying visible with `✓` while its topic is not fully complete (not hidden per turn), mixed rendering, flatten, dependency highlight/dim, terminal-width truncation, per-topic compact visibility with `+N more`, **completed-topic folding** (one line, no descendants, no `+N more`, even when expanded), theme tokens and theme refresh, headless.
- `schema.test.ts` — TypeBox `Value.Check` against the real schemas: rejects container status/blockedBy, mixed leaf+subtasks, unknown fields, bad types; accepts empty `subtasks`/`items` (needed for cancellation) which the domain then gates.
- `renderer.test.ts` — tool `renderCall`/`renderResult` truncated to width (CJK/wide characters), error lines, invalidate.
- `registration.test.ts` — exactly two tools, `model-only`/`sequential` write, guidance, `isError` on invalid input, `writable` round-trip, abort handling, and the real-tool cancellation path (last leaf cancelled → empty container/topic pruned) plus node type-conversion rejection.
- `workflow.test.ts` — update-first prompt/description/schema consistency, README workflow parity, successful writes and no-op chained without reads, missing-details initial read, and a stale write recovered with one read and a merged retry preserving current changes.
- `integration.test.ts` — **real `SessionManager`**: round-trip, isolation, branch navigation, sequential writes, resume/clone, lifecycle re-keying, shutdown.
- `persistence.test.ts` — **real session files in a temp dir** (never user sessions), all using the real tool's envelope: reopen, replay through compaction, `forkFrom`, and read via the tool against an opened file, including a retained completed topic.
- `load.test.ts` — loads the public `index.ts` through Pi's real `discoverAndLoadExtensions` (jiti) with zero errors.
- `package.test.ts` — creates and extracts the actual npm tarball in a temporary directory, checks the scoped name, public access, manifest entry and published files, then loads both the declared entry and package directory through Pi's real loader without a local dependency tree.

### Verification limits

- No live interactive TUI session was driven and no real model conversation was run. The widget and tool renderers are exercised through their `render`/component contract.
- Pi's published dist does not expose the validator it uses for tool arguments, so schema rejection is proven with TypeBox's `Value.Check` on the exact schema objects the tools register; the domain layer independently re-validates every rule so validation does not rely on the host.
- `forkFrom` is covered with a real file-backed `SessionManager`; in-process `AgentSessionRuntime.fork()` and `/reload` are not driven end to end.
