import { applyWrite, type WriteInput } from "../src/domain/write.ts";
import { emptySnapshot } from "../src/domain/snapshot.ts";
import type { Snapshot } from "../src/domain/types.ts";

export interface Chained {
	write: (partial: Omit<WriteInput, "expectedRevision">) => ReturnType<typeof applyWrite>;
	readonly state: Snapshot;
}

/** Apply a sequence of writes against evolving state, tracking the revision. */
export function makeChained(): Chained {
	let current: Snapshot = emptySnapshot();
	return {
		write(partial) {
			const result = applyWrite(current, { expectedRevision: current.revision, ...partial });
			if (result.ok) current = result.snapshot;
			return result;
		},
		get state() {
			return current;
		},
	};
}

/** A layer-2 executable leaf input. */
export function leafSpec(title: string, extra: Record<string, unknown> = {}) {
	return { title, ...extra };
}

/** A layer-2 container input. */
export function containerSpec(title: string, subtasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
	return { title, subtasks, ...extra };
}

/** A one-off topic input with a single layer-2 leaf. */
export function simpleTopic(title: string, leafTitle = "L") {
	return { title, items: [{ title: leafTitle }] };
}
