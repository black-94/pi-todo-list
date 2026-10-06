import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildReadResult, type ReadResult } from "./domain/view.ts";
import { READ_KIND, WRITE_ERROR_KIND, type Snapshot } from "./domain/types.ts";
import { buildSnapshotEnvelope, type SnapshotEnvelope } from "./domain/snapshot.ts";
import { applyWrite, type WriteInput } from "./domain/write.ts";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET, TODO_READ_DESCRIPTION, TODO_WRITE_DESCRIPTION } from "./prompts.ts";
import { replayFromEntries, type BranchEntryLike } from "./state/replay.ts";
import {
	clearActiveRenderSession,
	ensureSession,
	evictSession,
	getActiveRenderSession,
	setActiveRenderSession,
	setSnapshot,
	sid,
} from "./state/store.ts";
import { TodoReadParamsSchema, TodoWriteParamsSchema } from "./tool/schemas.ts";
import { formatReadText, formatWriteText } from "./tool/format.ts";
import { TodoWidget } from "./widget/widget.ts";

const TOOL_WRITE = "todo_write";
const TOOL_READ = "todo_read";
const EXPAND_SHORTCUT = "alt+t";

interface ReadDetails extends ReadResult {
	kind: typeof READ_KIND;
}

interface WriteErrorDetails {
	kind: typeof WRITE_ERROR_KIND;
	message: string;
	revision: string;
}

type WriteDetails = SnapshotEnvelope | WriteErrorDetails;

/** Replay the active branch into a fresh snapshot, surfacing diagnostics. */
function replayFromBranch(ctx: { sessionManager: { getBranch(): unknown[] } }): Snapshot {
	const result = replayFromEntries(ctx.sessionManager.getBranch() as Iterable<BranchEntryLike>);
	if (result.diagnostics.length > 0) {
		console.warn(`[pi-todo-list] ${result.diagnostics.join("; ")}`);
	}
	return result.snapshot;
}

function text(value: string): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text: value }] };
}

/** A width-safe, theme-at-render-time component with no cached themed strings. */
function lineComponent(getLine: () => string): Component {
	return {
		render: (width: number) => [truncateToWidth(getLine(), width, "…")],
		invalidate: () => {
			// Nothing themed is cached; render() recomputes from the live theme.
		},
	};
}

export default function register(pi: ExtensionAPI): void {
	const widget = new TodoWidget();
	let uiCtx: ExtensionUIContext | undefined;

	const refreshForeground = (sessionId: string): void => {
		if (!uiCtx) return;
		if (sessionId !== getActiveRenderSession()) return;
		try {
			widget.update();
		} catch (error) {
			console.warn(`[pi-todo-list] widget refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const abortResult = (current: Snapshot, message: string) => {
		const details: WriteErrorDetails = { kind: WRITE_ERROR_KIND, message, revision: current.revision };
		return { ...text(`Error: ${message}`), details, structuredContent: details as unknown as never, isError: true };
	};

	// --- todo_write --------------------------------------------------------
	pi.registerTool({
		name: TOOL_WRITE,
		label: "Todo Write",
		description: TODO_WRITE_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoWriteParamsSchema,
		outputSchema: Type.Any(),
		// Never callable through ctx.executeTool(): a nested call would not be
		// persisted as its own tool result, so the written snapshot could not be
		// replayed after a reload. Model-only keeps the write observable.
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionId = sid(ctx);
			// The committed cache is authoritative during a turn: a sibling write in
			// the same assistant message may not be on the branch yet. Lifecycle
			// events re-seed the cache from the branch. Seed lazily if needed.
			const current = ensureSession(sessionId, () => replayFromBranch(ctx));

			if (signal?.aborted) return abortResult(current, "cancelled before execution");

			const input = params as unknown as WriteInput;
			const result = applyWrite(current, input);
			if (!result.ok) {
				const details: WriteErrorDetails = { kind: WRITE_ERROR_KIND, message: result.error, revision: current.revision };
				return { ...text(`Error: ${result.error}`), details, structuredContent: details as unknown as never, isError: true };
			}

			// Commit boundary: an abort between validation and commit must not change
			// state or report a success snapshot.
			if (signal?.aborted) return abortResult(current, "cancelled before commit");

			setSnapshot(sessionId, result.snapshot);
			refreshForeground(sessionId);

			const details = buildSnapshotEnvelope(result.snapshot, result.changed, result.summary);
			const body = formatWriteText({
				changed: result.changed,
				revision: result.revision,
				snapshot: result.snapshot,
				summary: result.summary,
			});
			return { ...text(body), details, structuredContent: details as unknown as never };
		},

		renderCall(args, theme) {
			return lineComponent(() => {
				const count = Array.isArray(args.topics) ? args.topics.length : 0;
				return theme.fg("toolTitle", "todo_write ") + theme.fg("muted", `${count} topic(s)`);
			});
		},

		renderResult(result, _options, theme) {
			return lineComponent(() => {
				const details = result.details as WriteDetails | undefined;
				if (details && details.kind === WRITE_ERROR_KIND) {
					return theme.fg("error", `todo_write error: ${details.message}`);
				}
				const first = result.content[0];
				const line = first && first.type === "text" ? first.text.split("\n")[0] ?? "" : "";
				return theme.fg("success", line);
			});
		},
	});

	// --- todo_read ---------------------------------------------------------
	pi.registerTool({
		name: TOOL_READ,
		label: "Todo Read",
		description: TODO_READ_DESCRIPTION,
		parameters: TodoReadParamsSchema,
		outputSchema: Type.Any(),
		exposure: "direct",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const sessionId = sid(ctx);
			const current = ensureSession(sessionId, () => replayFromBranch(ctx));
			if (signal?.aborted) return abortResult(current, "cancelled before execution");
			const read = buildReadResult(current);
			const details: ReadDetails = { kind: READ_KIND, ...read };
			return { ...text(formatReadText(read)), details, structuredContent: details as unknown as never };
		},

		renderCall(_args, theme) {
			return lineComponent(() => theme.fg("toolTitle", "todo_read") + theme.fg("muted", " current tree"));
		},

		renderResult(result, _options, theme) {
			return lineComponent(() => {
				const read = result.details as ReadDetails | undefined;
				if (!read || read.kind !== READ_KIND) return theme.fg("warning", "todo_read: no data");
				return theme.fg("success", `todo_read ${read.counts.topics} topic(s), ${read.counts.completed}/${read.counts.leaves} leaves`);
			});
		},
	});

	// --- lifecycle ---------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = sid(ctx);
		setSnapshot(sessionId, replayFromBranch(ctx));
		if (!ctx.hasUI) return;
		if (getActiveRenderSession() === "") setActiveRenderSession(sessionId);
		if (sessionId !== getActiveRenderSession()) return;
		uiCtx = ctx.ui;
		widget.setUICtx(ctx.ui);
		widget.update();
	});

	const replayAndRefresh = (ctx: ExtensionContext): void => {
		let sessionId: string;
		try {
			sessionId = sid(ctx);
		} catch {
			return;
		}
		setSnapshot(sessionId, replayFromBranch(ctx));
		refreshForeground(sessionId);
	};

	pi.on("session_tree", async (_event, ctx) => replayAndRefresh(ctx));
	pi.on("session_compact", async (_event, ctx) => replayAndRefresh(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		let sessionId: string;
		try {
			sessionId = sid(ctx);
		} catch {
			sessionId = "";
		}
		evictSession(sessionId);
		if (sessionId === "" || sessionId === getActiveRenderSession()) {
			uiCtx = undefined;
			try {
				widget.dispose();
			} finally {
				clearActiveRenderSession();
			}
		}
	});

	// Refresh the widget from the already-committed snapshot. Do NOT replay the
	// branch here: at tool_execution_end the just-written result is not yet part
	// of the branch, so a replay would render stale state.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== TOOL_WRITE || event.isError) return;
		let sessionId: string;
		try {
			sessionId = sid(ctx as ExtensionToolContext);
		} catch {
			return;
		}
		refreshForeground(sessionId);
	});

	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut(EXPAND_SHORTCUT, {
			description: "Expand or collapse the todo panel",
			handler: (ctx) => {
				if (!ctx.hasUI || !widget.isRegistered()) return;
				widget.toggleExpanded();
			},
		});
	}
}
