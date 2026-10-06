import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROMPT_GUIDELINES } from "../src/prompts.ts";
import { TodoWriteParamsSchema } from "../src/tool/schemas.ts";
import { callRead, callWrite, makeCtx, makeHarness, newSession, resetCallCounter, resetHarnessState } from "./harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
	resetHarnessState();
	resetCallCounter();
});

// Both tools emit the complete canonical next-write input on their last line.
function nextWrite(result: { content: { text: string }[] }) {
	return JSON.parse(result.content[0]!.text.split("\n").at(-1)!);
}

describe("update-first prompt copy", () => {
	it("uses the same no-concurrency, direct-update and single-read recovery guidance on both tools", () => {
		const harness = makeHarness();
		const write = harness.tools.get("todo_write")!;
		const workflow = write.promptGuidelines![1]!;
		expect(workflow).toContain("Assume no concurrent todo updates by default");
		expect(workflow).toContain("call todo_write directly using those details");
		expect(workflow).toContain("Call todo_read only when those details are missing or once after todo_write fails");
		expect(workflow).toContain("Do not repeatedly query without another write attempt");
		expect(workflow).toContain("alone does not require a read when the details remain in the conversation");
		for (const tool of harness.tools.values()) {
			expect(tool.description).toContain(workflow);
		}
		expect(write.promptGuidelines![2]).toContain("A successful todo_write returns the full writable tree");
		expect(write.promptGuidelines!.join(" ")).not.toMatch(/Call todo_read first|Re-read after resuming/);
	});

	it("does not tell the model to prefer a new read in parameter descriptions", () => {
		const fields = TodoWriteParamsSchema.properties as unknown as Record<"expectedRevision" | "topics", { description: string }>;
		expect(fields.expectedRevision.description).toContain("Reuse it directly; do not query before each update");
		expect(fields.expectedRevision.description).toContain("after a failed write, call todo_read once");
		expect(fields.topics.description).toContain("already in the conversation from a successful todo_write or todo_read");
	});

	it("keeps the README's workflow guidelines in sync with the registered prompt", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		for (const index of [1, 2]) {
			const line = readme.split("\n").find((line) => line.startsWith(`${index + 1}. `));
			expect(line?.replace(/^\d+\. /, "").replaceAll("`", "")).toBe(PROMPT_GUIDELINES[index]!.replaceAll("`", ""));
		}
	});
});

describe("update-first real-tool contract", () => {
	it("chains successful writes and a no-op from their returned details without reading", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const read = vi.spyOn(harness.tools.get("todo_read")!, "execute");
		const created = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "Work", items: [{ title: "first" }, { title: "second" }] }],
		});
		expect(created.isError).toBeFalsy();
		const input = nextWrite(created);
		input.topics[0].items[0].status = "completed";
		const updated = await callWrite(harness, ctx, input);
		expect(updated.isError).toBeFalsy();
		const unchanged = await callWrite(harness, ctx, nextWrite(updated));
		expect(unchanged.isError).toBeFalsy();
		expect(unchanged.details.changed).toBe(false);
		expect(unchanged.details.revision).toBe(updated.details.revision);
		const finish = nextWrite(unchanged);
		finish.topics[0].items[1].status = "completed";
		const completed = await callWrite(harness, ctx, finish);
		expect(completed.isError).toBeFalsy();
		expect(completed.details.topics[0].items.map((item: { status: string }) => item.status)).toEqual(["completed", "completed"]);
		expect(nextWrite(completed).topics[0].id).toBe(input.topics[0].id);
		expect(read).not.toHaveBeenCalled();
	});

	it("reads once when no tree/revision is available, then writes from that result", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const read = vi.spyOn(harness.tools.get("todo_read")!, "execute");
		const current = await callRead(harness, ctx);
		const input = nextWrite(current);
		expect(input).toEqual({ expectedRevision: "", topics: [] });
		input.topics.push({ title: "Work", items: [{ title: "first" }] });
		const created = await callWrite(harness, ctx, input);
		expect(created.isError).toBeFalsy();
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("rejects stale details, then allows one read and a merged retry without losing current changes", async () => {
		const harness = makeHarness();
		const ctx = makeCtx(newSession());
		const read = vi.spyOn(harness.tools.get("todo_read")!, "execute");
		const created = await callWrite(harness, ctx, {
			expectedRevision: "",
			topics: [{ title: "Work", items: [{ title: "first" }, { title: "second" }] }],
		});
		// Simulate an unexpected intervening update; revision safety stays enabled.
		const intervening = nextWrite(created);
		intervening.topics[0].items[0].title = "renamed first";
		expect((await callWrite(harness, ctx, intervening)).isError).toBeFalsy();

		const stale = nextWrite(created);
		stale.topics[0].items[0].status = "completed";
		const rejected = await callWrite(harness, ctx, stale);
		expect(rejected.isError).toBe(true);
		expect(rejected.details.message).toContain("Call todo_read once");
		expect(read).not.toHaveBeenCalled();

		const current = await callRead(harness, ctx);
		const merged = nextWrite(current);
		expect(merged.topics[0].items[0].id).toBe(stale.topics[0].items[0].id);
		merged.topics[0].items[0].status = "completed";
		const retried = await callWrite(harness, ctx, merged);
		expect(retried.isError).toBeFalsy();
		expect(retried.details.topics[0].items[0]).toMatchObject({ title: "renamed first", status: "completed" });
		expect(retried.details.topics[0].items[1]).toMatchObject({ title: "second", status: "pending" });
		expect(read).toHaveBeenCalledTimes(1);
	});
});
