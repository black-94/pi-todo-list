import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory: string, prefix = "src"): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${prefix}/${entry.name}`;
		return entry.isDirectory() ? sourceFiles(join(directory, entry.name), path) : [path];
	});
}

describe("npm publication", () => {
	it("packs the scoped public package and loads its entry outside the checkout", async () => {
		const temporary = mkdtempSync(join(tmpdir(), "pi-todo-list-pack-"));
		try {
			// Skip lifecycle scripts to keep this check independent of publish hooks.
			const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {
				cwd: ROOT,
				encoding: "utf8",
				timeout: 30_000,
			});
			const [packed] = JSON.parse(output) as { filename: string; files: { path: string }[] }[];
			expect(packed).toBeDefined();
			const paths = packed!.files.map((file) => file.path).sort();
			expect(paths).toEqual(["LICENSE", "README.md", "index.ts", "package.json", ...sourceFiles(join(ROOT, "src"))].sort());

			execFileSync("tar", ["-xzf", join(temporary, packed!.filename), "-C", temporary], { timeout: 10_000 });
			const packageRoot = join(temporary, "package");
			const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
			expect(manifest.name).toBe("@black942026/pi-todo-list");
			expect(manifest.publishConfig).toEqual({ access: "public" });
			expect(manifest.engines).toEqual({ node: ">=22.19.0" });
			expect(manifest.keywords).toContain("pi-package");
			expect(manifest.pi.extensions).toEqual(["./index.ts"]);
			expect(manifest.dependencies ?? {}).toEqual({});
			expect(manifest.peerDependencies).toEqual({
				"@earendil-works/pi-coding-agent": "*",
				"@earendil-works/pi-tui": "*",
				typebox: "*",
			});

			// No node_modules is copied or installed. Pi supplies the host peers.
			for (const entry of [join(packageRoot, manifest.pi.extensions[0]), packageRoot]) {
				const result = await discoverAndLoadExtensions([entry], temporary);
				expect(result.errors).toEqual([]);
				expect(result.extensions).toHaveLength(1);
				expect([...result.extensions[0]!.tools.keys()].sort()).toEqual(["todo_read", "todo_write"]);
				expect(result.extensions[0]!.commands.size).toBe(0);
			}
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}, 60_000);
});
