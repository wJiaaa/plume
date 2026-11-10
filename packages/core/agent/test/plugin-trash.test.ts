import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PluginContext } from "@plume/contract";
import { PluginHost } from "../src/host.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function setup(trash?: (path: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "plume-plugin-trash-"));
	disposers.push(() => rm(dir, { recursive: true, force: true }));
	const host = new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		...(trash ? { trash } : {}),
		log: () => {},
		notice: () => {},
		model: {
			complete: async () => "",
			usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
			findImageModel: async () => ({ reason: "none", candidates: [] }),
			image: async () => ({ ok: false, failure: { summary: "" } }),
		},
	});
	disposers.push(() => host.dispose());
	let ctx!: PluginContext;
	await host.load([{ key: "bin", load: async () => ({ name: "bin", apply: (context: PluginContext) => void (ctx = context) }) }]);
	return { host, ctx };
}

it("ctx.trash 交给装配方的系统废纸篓；没有这个能力时抛错，插件停用后不再能用", async () => {
	const moved: string[] = [];
	const { host, ctx } = await setup(async (path) => void moved.push(path));
	await ctx.trash("/work/a.md");
	expect(moved).toEqual(["/work/a.md"]);

	await host.setEnabled("bin", false);
	await expect(ctx.trash("/work/b.md")).rejects.toThrow();
	expect(moved).toEqual(["/work/a.md"]);

	const bare = await setup();
	await expect(bare.ctx.trash("/work/c.md")).rejects.toThrow(/Trash|废纸篓/);
});
