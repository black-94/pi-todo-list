import { afterEach, describe, expect, it } from "vitest";
import { renderTodoLines, type RenderTheme } from "../src/widget/render.ts";
import { TodoWidget } from "../src/widget/widget.ts";
import { buildReadResult } from "../src/domain/view.ts";
import { __resetStore, clearActiveRenderSession, setActiveRenderSession, setSnapshot } from "../src/state/store.ts";
import { makeChained } from "./chained.ts";
import type { LeafStatus, Snapshot, Topic } from "../src/domain/types.ts";

const plain: RenderTheme = { fg: (_token, value) => value };
const tagging: RenderTheme = { fg: (token, value) => `<${token}>${value}</${token}>` };
const plainTruncate = (line: string, width: number, ellipsis = "…") =>
	line.length <= width ? line : line.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;

/** A topic mixing a layer-2 leaf and a layer-2 container (2.1/2.2), one leaf completed. */
function mixedSnapshot(): Snapshot {
	const chained = makeChained();
	chained.write({
		topics: [
			{
				title: "Auth",
				items: [
					{ title: "analyse" },
					{ title: "fix", subtasks: [{ title: "spec", status: "completed" as LeafStatus }, { title: "implement" }] },
				],
			},
		],
	});
	return chained.state;
}

function twoTopicSnapshot(): Snapshot {
	const chained = makeChained();
	chained.write({
		topics: [
			{ title: "Flat", items: [{ title: "single leaf" }] },
			{ title: "Multi", items: [{ title: "a" }, { title: "b" }] },
		],
	});
	return chained.state;
}

/** A fully completed multi-leaf topic retained beside an active one. */
function completedAndActiveSnapshot(): Snapshot {
	const chained = makeChained();
	chained.write({
		topics: [
			{ title: "Done", items: [{ title: "d1" }, { title: "d2" }] },
			{ title: "Active", items: [{ title: "a1" }, { title: "a2" }] },
		],
	});
	const [done, active] = chained.state.topics as [Topic, Topic];
	const result = chained.write({
		topics: [
			{ id: done.id, title: "Done", items: done.items.map((i) => ({ id: i.id, title: i.title, status: "completed" as LeafStatus })) },
			{ id: active.id, title: "Active", items: active.items.map((i) => ({ id: i.id, title: i.title })) },
		],
	});
	if (!result.ok) throw new Error(result.error);
	return chained.state;
}

afterEach(() => {
	__resetStore();
	clearActiveRenderSession();
});

describe("renderTodoLines", () => {
	const opts = { width: 120, expanded: true, maxRows: 12 } as const;

	it("hides the panel for an empty tree", () => {
		expect(renderTodoLines(buildReadResult({ revision: "", topics: [] }), { ...opts, theme: plain, truncate: plainTruncate })).toEqual([]);
	});

	it("renders the heading with completed/total executable-leaf counts", () => {
		const lines = renderTodoLines(buildReadResult(twoTopicSnapshot()), { ...opts, theme: plain, truncate: plainTruncate });
		expect(lines[0]).toBe("● TODOS (0/3)");
	});

	it("counts only completed leaves in the numerator; pending, in_progress and blocked pending are excluded", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "T", items: [{ title: "a", status: "completed" }, { title: "b", status: "in_progress" }, { title: "c" }] }] });
		const [a, b, c] = chained.state.topics[0]!.items as Array<{ id: string }>;
		chained.write({ topics: [{ id: chained.state.topics[0]!.id, title: "T", items: [{ id: a!.id, title: "a", status: "completed" }, { id: b!.id, title: "b", status: "in_progress" }, { id: c!.id, title: "c", blockedBy: [b!.id] }] }] });
		const read = buildReadResult(chained.state);
		expect(read.counts.completed).toBe(1);
		expect(read.counts.inProgress).toBe(1);
		expect(read.counts.pending).toBe(1);
		const lines = renderTodoLines(read, { ...opts, theme: plain, truncate: plainTruncate });
		expect(lines[0]).toBe("● TODOS (1/3)");
	});

	it("keeps a fully completed retained topic in the total and shows completed over total", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "T", items: [{ title: "a" }, { title: "b" }] }] });
		const topic = chained.state.topics[0]!;
		chained.write({ topics: [{ id: topic.id, title: "T", items: topic.items.map((i) => ({ id: i.id, title: i.title, status: "completed" as LeafStatus })) }] });
		const lines = renderTodoLines(buildReadResult(chained.state), { ...opts, theme: plain, truncate: plainTruncate });
		expect(lines[0]).toBe("○ TODOS (2/2)");
	});

	it("includes a folded completed topic's leaves in the total alongside an active topic", () => {
		const lines = renderTodoLines(buildReadResult(completedAndActiveSnapshot()), { ...opts, theme: plain, truncate: plainTruncate });
		// Done: 2 completed (folded, retained); Active: 2 pending -> 2 of 4 completed.
		expect(lines[0]).toBe("● TODOS (2/4)");
	});

	it("drops a capacity-evicted topic's leaves from the total", () => {
		const chained = makeChained();
		const leafTopic = (title: string) => ({ title, items: [{ title: "L" }] });
		chained.write({ topics: [leafTopic("A"), leafTopic("B"), leafTopic("C")] });
		const [a, b, c] = chained.state.topics as [Topic, Topic, Topic];
		const complete = (x: Topic) => ({ id: x.id, title: x.title, items: [{ id: x.items[0]!.id, title: "L", status: "completed" as LeafStatus }] });
		const keep = (x: Topic) => ({ id: x.id, title: x.title, items: [{ id: x.items[0]!.id, title: "L" }] });
		chained.write({ topics: [complete(a), keep(b), keep(c)] });
		chained.write({ topics: [keep(chained.state.topics[0]!), complete(b), keep(c)] });
		const evicted = chained.write({ topics: [keep(chained.state.topics[0]!), keep(chained.state.topics[1]!), keep(chained.state.topics[2]!), leafTopic("D")] });
		expect(evicted.ok).toBe(true);
		if (evicted.ok) expect(evicted.summary.evictedTopics).toEqual(["A"]);
		const lines = renderTodoLines(buildReadResult(chained.state), { ...opts, theme: plain, truncate: plainTruncate });
		// A is evicted, so its leaf is gone from the total: 3 leaves (B completed, C/D pending).
		expect(lines[0]).toBe("● TODOS (1/3)");
	});

	it("keeps a completed leaf visible with ✓ while its topic is not fully complete (no per-turn hiding)", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "T", items: [{ title: "done", status: "completed" as LeafStatus }, { title: "todo" }] }] });
		// Re-read the same committed state as separate turns would: the completed
		// child must never be hidden just because it is completed.
		for (let turn = 0; turn < 2; turn++) {
			const read = buildReadResult(chained.state);
			expect(read.counts.completed).toBe(1);
			expect(read.topics[0]!.completed).toBe(false);
			for (const expanded of [false, true]) {
				const joined = renderTodoLines(read, { width: 120, expanded, maxRows: 12, theme: plain, truncate: plainTruncate }).join("\n");
				expect(joined).toContain("✓ 1 done");
				expect(joined).toContain("○ 2 todo");
				expect(joined).not.toContain("more");
			}
		}
		// The completed leaf is still present in the read data (data, not just widget).
		const read = buildReadResult(chained.state);
		const doneLeaf = read.topics[0]!.items[0]!;
		expect(read.display.some((row) => row.leafId === doneLeaf.id && row.status === "completed")).toBe(true);
	});

	it("renders mixed-layer numbering and connectors", () => {
		const lines = renderTodoLines(buildReadResult(mixedSnapshot()), { ...opts, theme: plain, truncate: plainTruncate });
		const joined = lines.join("\n");
		expect(joined).toContain("1 analyse");
		expect(joined).toContain("2 fix");
		expect(joined).toContain("2.1 spec");
		expect(joined).toContain("2.2 implement");
		expect(joined).toMatch(/[├└]─/);
	});

	it("flattens a single-leaf topic (two or three layers) with no numbering", () => {
		const twoLayer = buildReadResult({ revision: "r", topics: [{ id: "t", title: "T", items: [{ type: "leaf", id: "l", title: "only", status: "pending", blockedBy: [] }] }] });
		const lines = renderTodoLines(twoLayer, { ...opts, theme: plain, truncate: plainTruncate });
		expect(lines.join("\n")).toContain("only");
		expect(lines.join("\n")).not.toContain("T\n");
		const flatRow = lines.find((l) => l.includes("only"))!;
		expect(flatRow).not.toMatch(/[0-9]+\.[0-9]+/);

		const flatMulti = buildReadResult(twoTopicSnapshot());
		expect(flatMulti.flattened).toHaveLength(1);
		expect(renderTodoLines(flatMulti, { ...opts, theme: plain, truncate: plainTruncate }).join("\n")).not.toContain("Flat");
	});

	it("shows dependency markers and highlights unmet prerequisites", () => {
		const chained = makeChained();
		const write = chained.write({ topics: [{ title: "A", items: [{ title: "one" }, { title: "two" }] }] });
		expect(write.ok).toBe(true);
		const first = chained.state.topics[0]!.items[0]!.id;
		const second = chained.state.topics[0]!.items[1]!.id;
		chained.write({ topics: [{ id: chained.state.topics[0]!.id, title: "A", items: [{ id: first, title: "one" }, { id: second, title: "two", blockedBy: [first] }] }] });
		const unmet = renderTodoLines(buildReadResult(chained.state), { ...opts, theme: tagging, truncate: plainTruncate });
		expect(unmet.join("\n")).toContain("<warning>⛓ 1</warning>");

		chained.write({ topics: [{ id: chained.state.topics[0]!.id, title: "A", items: [{ id: first, title: "one", status: "completed" }, { id: second, title: "two", blockedBy: [first] }] }] });
		const met = renderTodoLines(buildReadResult(chained.state), { ...opts, theme: tagging, truncate: plainTruncate });
		expect(met.join("\n")).toContain("<dim>⛓ 1</dim>");
	});

	it("truncates every line to the terminal width", () => {
		const width = 12;
		const lines = renderTodoLines(buildReadResult(mixedSnapshot()), { width, expanded: true, maxRows: 12, theme: plain, truncate: plainTruncate });
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
	});

	it("keeps every topic visible in compact mode even when one topic is large", () => {
		const chained = makeChained();
		chained.write({
			topics: [
				{ title: "BigTopic", items: [{ title: "G", subtasks: [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }, { title: "e" }, { title: "f" }] }] },
				{ title: "MidTopic", items: [{ title: "x" }, { title: "y" }] },
				{ title: "SmallTopic", items: [{ title: "z" }, { title: "w" }] },
			],
		});
		const read = buildReadResult(chained.state);
		const compact = renderTodoLines(read, { width: 120, expanded: false, maxRows: 12, theme: plain, truncate: plainTruncate }).join("\n");
		expect(compact).toContain("BigTopic");
		expect(compact).toContain("MidTopic");
		expect(compact).toContain("SmallTopic");
		expect(compact).toContain("more");
		// ancestor row of the big topic is preserved, numbers not renumbered
		expect(compact).toContain("1 G");
		const expanded = renderTodoLines(read, { width: 120, expanded: true, maxRows: 12, theme: plain, truncate: plainTruncate }).join("\n");
		expect(expanded).not.toContain("more");
		expect(expanded).toContain("1.6");
	});

	it("uses theme tokens rather than hard-coded colors", () => {
		const lines = renderTodoLines(buildReadResult(mixedSnapshot()), { ...opts, theme: tagging, truncate: plainTruncate });
		const joined = lines.join("\n");
		expect(joined).toContain("<accent>");
		expect(joined).toContain("<dim>");
		expect(joined).toContain("<success>");
	});

	it("folds a completed topic to one line and never expands its descendants", () => {
		const read = buildReadResult(completedAndActiveSnapshot());
		for (const expanded of [false, true]) {
			const joined = renderTodoLines(read, { width: 120, expanded, maxRows: 12, theme: plain, truncate: plainTruncate }).join("\n");
			expect(joined).toContain("✓ Done");
			expect(joined).not.toContain("d1");
			expect(joined).not.toContain("d2");
			expect(joined).toContain("a1");
			expect(joined).toContain("a2");
			expect(joined).not.toContain("more");
		}
	});

	it("keeps a single-leaf completed topic as one flattened leaf line", () => {
		const chained = makeChained();
		chained.write({ topics: [{ title: "Solo", items: [{ title: "only" }] }] });
		const topic = chained.state.topics[0]!;
		const leaf = topic.items[0]!;
		chained.write({ topics: [{ id: topic.id, title: "Solo", items: [{ id: leaf.id, title: "only", status: "completed" }] }] });
		const read = buildReadResult(chained.state);
		const joined = renderTodoLines(read, { width: 120, expanded: true, maxRows: 12, theme: plain, truncate: plainTruncate }).join("\n");
		expect(joined).toContain("✓ only");
		expect(joined).not.toContain("Solo");
		expect(read.topics[0]!.completed).toBe(true);
		expect(read.completedTopicCount).toBe(1);
	});

	it("marks a completed topic folded in display while returning full descendants", () => {
		const read = buildReadResult(completedAndActiveSnapshot());
		const done = read.topics.find((topic) => topic.title === "Done")!;
		expect(done.completed).toBe(true);
		expect(done.items).toHaveLength(2);
		expect(read.completedTopicCount).toBe(1);
		expect(read.activeTopicCount).toBe(1);
		const doneRows = read.display.filter((row) => row.topicId === done.id);
		expect(doneRows).toHaveLength(1);
		expect(doneRows[0]!.folded).toBe(true);
	});
});

interface FakeUI {
	ui: unknown;
	registry: Map<string, unknown>;
	lastComponent: { render(width: number): string[] } | undefined;
	requestRenders: boolean[];
}

function fakeUI(): FakeUI {
	const registry = new Map<string, unknown>();
	const requestRenders: boolean[] = [];
	const tui = { requestRender: (force?: boolean) => requestRenders.push(force === true) };
	const state: FakeUI = { ui: undefined, registry, lastComponent: undefined, requestRenders };
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
			if (typeof content === "function") state.lastComponent = (content as (t: unknown, th: unknown) => { render(width: number): string[] })(tui, theme);
		},
		notify() {},
	};
	state.ui = ui;
	return state;
}

describe("TodoWidget", () => {
	it("registers when non-empty, re-renders on update, and hides when empty", () => {
		const fake = fakeUI();
		const widget = new TodoWidget();
		widget.setUICtx(fake.ui as never);
		setActiveRenderSession("s1");
		widget.update();
		expect(fake.registry.size).toBe(0);
		setSnapshot("s1", mixedSnapshot());
		widget.update();
		expect(fake.registry.has("pi-todo-list")).toBe(true);
		expect(fake.lastComponent!.render(120)[0]).toBe("● TODOS (1/3)");
		setSnapshot("s1", { revision: "empty", topics: [] });
		widget.update();
		expect(fake.registry.size).toBe(0);
	});

	it("toggles expanded with a forced re-render", () => {
		const fake = fakeUI();
		const widget = new TodoWidget();
		widget.setUICtx(fake.ui as never);
		setActiveRenderSession("s1");
		setSnapshot("s1", mixedSnapshot());
		widget.update();
		widget.toggleExpanded();
		expect(fake.requestRenders).toContain(true);
	});

	it("works headless without a UI context", () => {
		const widget = new TodoWidget();
		expect(() => widget.update()).not.toThrow();
		expect(widget.isRegistered()).toBe(false);
	});

	it("re-renders with the current theme after a theme change", () => {
		const fake = fakeUI();
		const widget = new TodoWidget();
		widget.setUICtx(fake.ui as never);
		setActiveRenderSession("s1");
		setSnapshot("s1", mixedSnapshot());
		widget.update();
		const before = fake.lastComponent!.render(120).join("\n");
		expect(before).not.toContain("*");
		(fake.ui as { theme: unknown }).theme = { fg: (_t: string, s: string) => `*${s}*` };
		const after = fake.lastComponent!.render(120).join("\n");
		expect(after).toContain("*");
		expect(after).not.toBe(before);
	});
});
