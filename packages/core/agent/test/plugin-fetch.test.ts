import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PluginContext, PluginFetch } from "@plume/contract";
import { PluginHost } from "../src/host.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});
async function setup(fetch: PluginFetch) {
	const dir = await mkdtemp(join(tmpdir(), "plume-plugin-fetch-"));
	disposers.push(() => rm(dir, { recursive: true, force: true }));
	const host = new PluginHost({
		dataDir: dir,
		appDataDir: dir,
		fetch,
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
	await host.load([
		{
			key: "network",
			load: async () => ({
				name: "network",
				apply: (context: PluginContext) => {
					ctx = context;
				},
			}),
		},
	]);
	return { host, ctx };
}

it("插件请求经系统实现发送，不共享 cookie 或跨域跟随", async () => {
	let received: { url: string; init?: RequestInit } | undefined;
	const { ctx } = await setup(async (url, init) => {
		received = { url, init };
		return new Response("answer");
	});
	const signal = new AbortController();
	const response = await ctx.fetch("https://example.test/api", {
		method: "POST",
		body: "{}",
		headers: { Authorization: "Bearer fixture" },
		credentials: "include",
		redirect: "follow",
		signal: signal.signal,
	});
	expect(await response.text()).toBe("answer");
	expect(received?.url).toBe("https://example.test/api");
	expect(received?.init).toMatchObject({ method: "POST", body: "{}", headers: { Authorization: "Bearer fixture" }, credentials: "omit", redirect: "error" });
	signal.abort();
	expect(received?.init?.signal?.aborted).toBe(true);
});

it("停用插件中止网络请求，不能复用旧入口或访问本地协议", async () => {
	const signals: AbortSignal[] = [];
	const { host, ctx } = await setup(async (_url, init) => {
		signals.push(init!.signal!);
		return new Response("ok");
	});
	await expect(ctx.fetch("file:///etc/hosts")).rejects.toThrow(/HTTP/);
	await expect(ctx.fetch("https://user@example.test/")).rejects.toThrow(/credentials/);
	expect(signals).toHaveLength(0);
	await ctx.fetch("http://localhost/test");
	await host.setEnabled("network", false);
	expect(signals[0]!.aborted).toBe(true);
	await expect(ctx.fetch("https://example.test/")).rejects.toThrow();
	expect(signals).toHaveLength(1);
});
