import { cloneSnapshot, emptySnapshot } from "../domain/snapshot.ts";
import type { Snapshot } from "../domain/types.ts";

/**
 * Per-session cache of the committed snapshot. The session branch is the
 * authority; this map is only a cache so tools and the widget can read the
 * current tree without replaying on every render.
 */
const sessions = new Map<string, Snapshot>();

/**
 * Ctx-free widget render pointer: which session's snapshot the widget shows.
 * Set when the first UI-bearing session claims the foreground.
 */
let activeRenderSession = "";

/** Extract a session id from any context exposing `sessionManager.getSessionId`. */
export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

/** Load-or-replay a session slot exactly once. */
export function ensureSession(sessionId: string, load: () => Snapshot): Snapshot {
	const cached = sessions.get(sessionId);
	if (cached) return cached;
	const loaded = load();
	sessions.set(sessionId, loaded);
	return loaded;
}

/** Replace a session's cached snapshot (replay or commit). Stored as a deep clone. */
export function setSnapshot(sessionId: string, snapshot: Snapshot): void {
	sessions.set(sessionId, cloneSnapshot(snapshot));
}

/** Read a session's cached snapshot, or an empty snapshot when absent. */
export function getSnapshot(sessionId: string): Snapshot {
	return sessions.get(sessionId) ?? emptySnapshot();
}

/** Drop a session's cache entry. */
export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

/** Snapshot for the foreground widget. */
export function getRenderSnapshot(): Snapshot {
	return sessions.get(activeRenderSession) ?? emptySnapshot();
}

export function setActiveRenderSession(sessionId: string): void {
	activeRenderSession = sessionId;
}

export function getActiveRenderSession(): string {
	return activeRenderSession;
}

export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}

/** Test reset. */
export function __resetStore(): void {
	sessions.clear();
	activeRenderSession = "";
}
