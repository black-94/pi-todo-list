import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRenderSnapshot } from "../src/state/store.ts";
import { appendWriteResult, callRead, callWrite, emit, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";

afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

function details(revision: string, title: string) {
	return {
		kind: "pi-todo-list.snapshot",
		schemaVersion: 2,
		revision,
		topics: [
			{
				id: `t-${title}`,
				title,
				items: [{ type: "leaf", id: `l-${title}`, title: "L", status: "pending", blockedBy: [] }],
			},
		],
	};
}

describe("integration with a real SessionManager", () => {
	it("round-trips write and read", async () => {
		const harness = makeHarness();
		const sm = newSession();
		const ctx = makeCtx(sm);
		await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "Auth", items: [{ title: "analyse" }, { title: "fix", subtasks: [{ title: "spec" }] }] }] });
		const read = await callRead(harness, ctx);
		expect(read.content[0].text).toContain("Auth");
		expect(read.content[0].text).toContain("spec");
	});

	it("keeps two sessions isolated", async () => {
		const harness = makeHarness();
		const ctxA = makeCtx(newSession());
		const ctxB = makeCtx(newSession());
		await callWrite(harness, ctxA, { expectedRevision: "", topics: [{ title: "Alpha", items: [{ title: "a" }] }] });
		await callWrite(harness, ctxB, { expectedRevision: "", topics: [{ title: "Beta", items: [{ title: "b" }] }] });
		expect((await callRead(harness, ctxA)).content[0].text).toContain("Alpha");
		expect((await callRead(harness, ctxB)).content[0].text).toContain("Beta");
	});

	it("reflects branch navigation on the next read", async () => {
		const harness = makeHarness();
		const sm = newSession();
		appendWriteResult(sm, "w1", details("r1", "First"));
		const firstLeaf = sm.getLeafId()!;
		appendWriteResult(sm, "w2", details("r2", "Second"));
		sm.branch(firstLeaf);
		await emit(harness, "session_tree", makeCtx(sm));
		const read = await callRead(harness, makeCtx(sm));
		expect(read.content[0].text).toContain("First");
		expect(read.content[0].text).not.toContain("Second");
	});

	it("supports sequential writes before the branch records the first result", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const first = await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] }, { persist: false });
		expect(first.isError).toBeFalsy();
		const topicId = first.details.topics[0].id;
		const leafId = first.details.topics[0].items[0].id;
		const second = await callWrite(
			harness,
			ctx,
			{
				expectedRevision: first.details.revision,
				topics: [
					{ id: topicId, title: "A", items: [{ id: leafId, title: "x", status: "completed" }] },
					{ title: "B", items: [{ title: "y" }] },
				],
			},
			{ persist: false },
		);
		expect(second.isError).toBeFalsy();
	});

	it("restores state when a new manager is created from existing entries (resume/clone)", async () => {
		const sm = newSession();
		appendWriteResult(sm, "w", details("r1", "Resumed"));
		const clone = SessionManager.inMemory("/tmp/pi-todo-list-test", undefined, sm.getEntries());
		const harness = makeHarness();
		const read = await callRead(harness, makeCtx(clone));
		expect(read.content[0].text).toContain("Resumed");
	});

	it("lazily replays from the branch even without a session_start", async () => {
		const harness = makeHarness();
		const sm = newSession();
		appendWriteResult(sm, "w", details("r1", "Lazy"));
		const read = await callRead(harness, makeCtx(sm));
		expect(read.content[0].text).toContain("Lazy");
	});

	it("re-keys the widget on session_start, session_tree, and session_compact", async () => {
		const harness = makeHarness();
		const sm = newSession();
		appendWriteResult(sm, "w", details("r1", "Widget"));
		const renders: string[][] = [];
		const registry = new Map<string, unknown>();
		const tui = { requestRender() {} };
		const theme = { fg: (_t: string, s: string) => s };
		const ui = {
			theme,
			getToolsExpanded: () => false,
			setWidget(key: string, content: unknown) {
				if (content === undefined) {
					registry.delete(key);
					return;
				}
				registry.set(key, content);
				if (typeof content === "function") {
					renders.push((content as (t: unknown, th: unknown) => { render(w: number): string[] })(tui, theme).render(120));
				}
			},
			notify() {},
		};
		const ctx = makeCtx(sm, { hasUI: true, ui });

		await emit(harness, "session_start", ctx);
		expect(registry.has("pi-todo-list")).toBe(true);
		expect(getRenderSnapshot().topics[0]!.title).toBe("Widget");

		await emit(harness, "session_tree", ctx);
		expect(getRenderSnapshot().topics[0]!.title).toBe("Widget");

		sm.appendCompaction("summary", sm.getLeafId()!, 100);
		await emit(harness, "session_compact", ctx);
		expect(getRenderSnapshot().topics[0]!.title).toBe("Widget");
	});

	it("clears the foreground and cache on session_shutdown", async () => {
		const harness = makeHarness();
		const sm = newSession();
		appendWriteResult(sm, "w", details("r1", "Gone"));
		const ui = { theme: { fg: (_t: string, s: string) => s }, getToolsExpanded: () => false, setWidget() {}, notify() {} };
		const ctx = makeCtx(sm, { hasUI: true, ui });
		await emit(harness, "session_start", ctx);
		expect(getRenderSnapshot().topics).toHaveLength(1);
		await emit(harness, "session_shutdown", ctx);
		expect(getRenderSnapshot().topics).toHaveLength(0);
	});
});
