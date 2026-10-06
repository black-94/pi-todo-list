import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("real Pi extension loader", () => {
	it("loads the public index.ts entry through jiti and registers exactly two tools", async () => {
		const result = await discoverAndLoadExtensions([ENTRY], process.cwd());
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		const extension = result.extensions[0]!;
		expect([...extension.tools.keys()].sort()).toEqual(["todo_read", "todo_write"]);
		expect(extension.commands.size).toBe(0);
	});
});
