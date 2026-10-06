import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { __resetStore } from "../src/state/store.ts";
import type { WriteInput } from "../src/domain/write.ts";

export interface CapturedTool {
	name: string;
	description: string;
	exposure?: string;
	executionMode?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (callId: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<any>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	renderCall?: (...args: any[]) => unknown;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	renderResult?: (...args: any[]) => unknown;
}

export interface Harness {
	tools: Map<string, CapturedTool>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	shortcuts: Array<{ key: string; options: { description?: string } }>;
	commands: string[];
}

/** Register the extension against a capturing fake API. */
export function makeHarness(): Harness {
	const tools = new Map<string, CapturedTool>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const shortcuts: Array<{ key: string; options: { description?: string } }> = [];
	const commands: string[] = [];

	const pi = {
		registerTool(def: CapturedTool) {
			tools.set(def.name, def);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerShortcut(key: string, options: { description?: string }) {
			shortcuts.push({ key, options });
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as unknown as ExtensionAPI;

	register(pi);
	return { tools, handlers, shortcuts, commands };
}

export function resetHarnessState(): void {
	__resetStore();
}

/** A context whose sessionManager is a real in-memory SessionManager. */
export function makeCtx(sessionManager: SessionManager, options: { hasUI?: boolean; ui?: unknown } = {}): unknown {
	return {
		sessionManager,
		hasUI: options.hasUI ?? false,
		mode: options.hasUI ? "tui" : "json",
		cwd: "/tmp",
		ui: options.ui ?? {
			setWidget() {},
			notify() {},
			getToolsExpanded: () => false,
			theme: { fg: (_token: string, value: string) => value },
		},
	};
}

export async function emit(harness: Harness, event: string, ctx: unknown): Promise<void> {
	for (const handler of harness.handlers.get(event) ?? []) {
		await handler({ type: event }, ctx);
	}
}

/** Append a successful todo_write tool result (a persisted snapshot) to a session. */
export function appendWriteResult(
	sessionManager: SessionManager,
	toolCallId: string,
	details: unknown,
	options: { isError?: boolean; toolName?: string } = {},
): string {
	return sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: options.toolName ?? "todo_write",
		content: [{ type: "text", text: "ok" }],
		details: details as never,
		isError: options.isError ?? false,
		timestamp: Date.now(),
	} as never);
}

export function appendUserMessage(sessionManager: SessionManager, text: string): string {
	return sessionManager.appendMessage({
		role: "user",
		content: text,
		timestamp: Date.now(),
	} as never);
}

/** Call todo_write through the registered tool and return its result. */
export async function callWrite(
	harness: Harness,
	ctx: unknown,
	input: WriteInput,
	options: { persist?: boolean; sessionManager?: SessionManager; signal?: AbortSignal } = {},
): Promise<any> {
	const tool = harness.tools.get("todo_write");
	if (!tool) throw new Error("todo_write not registered");
	const result = await tool.execute(`call-${++callCounter}`, input, options.signal, undefined, ctx);
	// Pi appends the tool result to the session after execute() resolves. Mirror
	// that so subsequent reads replay from the branch, as in a real session.
	if (options.persist !== false) {
		const sm = options.sessionManager ?? (ctx as { sessionManager: SessionManager }).sessionManager;
		appendWriteResult(sm, `call-${callCounter}`, result.details, { isError: result.isError === true });
	}
	return result;
}

export async function callRead(harness: Harness, ctx: unknown, signal?: AbortSignal): Promise<any> {
	const tool = harness.tools.get("todo_read");
	if (!tool) throw new Error("todo_read not registered");
	return tool.execute(`call-${++callCounter}`, {}, signal, undefined, ctx);
}

export function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

let callCounter = 0;

export function resetCallCounter(): void {
	callCounter = 0;
}

export function newSession(): SessionManager {
	return SessionManager.inMemory("/tmp/pi-todo-list-test");
}
