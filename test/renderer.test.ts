import { afterEach, describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SNAPSHOT_KIND, WRITE_ERROR_KIND } from "../src/domain/types.ts";
import { callWrite, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

afterEach(() => {
	resetHarnessState();
	resetCallCounter();
});

const theme = { fg: (_token: string, value: string) => value } as unknown as Theme;

interface Renderable {
	render(width: number): string[];
	invalidate(): void;
}

describe("tool renderers respect terminal width", () => {
	it("truncates renderResult to the width, including wide characters", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const result = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "认证流程修复与检查", items: [{ title: "分析错误日志中的异常并定位根因" }, { title: "修复认证流程", subtasks: [{ title: "编写回归测试" }, { title: "更新文档" }] }] }],
		});
		const tool = harness.tools.get("todo_write")!;
		const component = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {} as never) as Renderable;

		for (const width of [8, 16, 30, 60]) {
			const lines = component.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		component.invalidate();
		expect(() => component.render(20)).not.toThrow();
	});

	it("truncates the renderResult error line", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] });
		const bad = await callWrite(harness, ctx, { expectedRevision: "stale", topics: [] });
		expect(bad.details.kind).toBe(WRITE_ERROR_KIND);
		const tool = harness.tools.get("todo_write")!;
		const component = tool.renderResult!(bad, { expanded: false, isPartial: false }, theme, {} as never) as Renderable;
		for (const line of component.render(12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
	});

	it("renders renderCall within the width", () => {
		const harness = makeHarness();
		const tool = harness.tools.get("todo_write")!;
		const component = tool.renderCall!({ expectedRevision: "", topics: [{ title: "A", items: [] }] } as never, theme, {} as never) as Renderable;
		for (const line of component.render(10)) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
	});

	it("read renderer stays within the width", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		await callWrite(harness, ctx, { expectedRevision: "", topics: [{ title: "A", items: [{ title: "x" }] }] });
		const read = await harness.tools.get("todo_read")!.execute("c", {}, undefined, undefined, ctx);
		expect(read.details.kind).toBe("pi-todo-list.read");
		const tool = harness.tools.get("todo_read")!;
		const component = tool.renderResult!(read, { expanded: false, isPartial: false }, theme, {} as never) as Renderable;
		for (const line of component.render(8)) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
		void SNAPSHOT_KIND;
	});
});
