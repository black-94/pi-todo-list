import { cloneSnapshot, emptySnapshot, parseSnapshotPayload } from "../domain/snapshot.ts";
import type { Snapshot } from "../domain/types.ts";

/**
 * Structural shape of the session entries we replay. Kept Pi-import-free so the
 * domain and tests do not depend on the host runtime.
 */
export interface BranchEntryLike {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
	};
}

export interface ReplayResult {
	snapshot: Snapshot;
	/** Human-readable notes about snapshots that were ours but unusable. */
	diagnostics: string[];
}

/**
 * Reconstruct the authoritative snapshot from the current branch's ancestor
 * chain, in chronological order. Only a successful `todo_write` result whose
 * details is a valid `pi-todo-list.snapshot` participates; the last valid one
 * wins.
 *
 * Foreign payloads (other tools, the legacy `{ tasks, nextId }` shape) are
 * ignored silently. Payloads that are clearly this extension's but unsupported
 * or corrupt are skipped *and* reported in `diagnostics`, so a damaged newer
 * snapshot is surfaced rather than silently masked by an older state. An
 * empty-but-valid snapshot still wins over an older non-empty one.
 */
export function replayFromEntries(entries: Iterable<BranchEntryLike>): ReplayResult {
	let snapshot = emptySnapshot();
	const diagnostics: string[] = [];
	for (const entry of entries) {
		if (!entry || entry.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "toolResult") continue;
		if (message.toolName !== "todo_write") continue;
		if (message.isError === true) continue;
		const parsed = parseSnapshotPayload(message.details);
		if (parsed.ok) {
			snapshot = parsed.snapshot;
			diagnostics.length = 0; // a newer valid snapshot supersedes earlier damage
			continue;
		}
		if (parsed.category === "foreign") continue;
		diagnostics.push(`${parsed.category} snapshot ignored: ${parsed.reason}`);
	}
	return { snapshot: cloneSnapshot(snapshot), diagnostics };
}
