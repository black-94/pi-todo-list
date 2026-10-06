import { randomUUID } from "node:crypto";

/**
 * Generate a short, stable, collision-checked node id. Ids are opaque: display
 * numbering never derives from them, and they never change when the tree is
 * flattened or renumbered.
 */
export function newNodeId(isTaken: (id: string) => boolean): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().replace(/-/g, "").slice(0, 8);
		if (!isTaken(id)) return id;
	}
	// Astronomically unlikely; fall back to a full UUID to guarantee progress.
	return randomUUID();
}

/** Revision identifier for a committed snapshot. */
export function newRevision(): string {
	return randomUUID();
}
