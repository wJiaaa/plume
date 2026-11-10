import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Plugin, PluginContext } from "@plume/contract";
import { createAgent, type Agent } from "../src/index.ts";
import { text } from "../src/i18n.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";

// 插件拿 ctx.model.complete 的结果覆盖自己的数据（记忆插件写 MEMORY.md）时，靠 requireComplete 挡住被截断、想调工具的回复；
// 不要求的老调用方照旧拿到截断的文本。不论结果收不收，每次请求都计费。
it("requireComplete：不完整的一次性回复抛错，完整的才返回；不要求时截断也返回文本；所有回复都计费", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-model-complete-"));
	let agent: Agent | undefined;
	let model: FakeModel | undefined;
	try {
		model = await fakeAnthropic([
			{ text: "- 只写到一半", truncated: true },
			{ text: "- 还要调用工具", toolCalls: [{ id: "call", name: "read", args: { path: "unused" } }] },
			{ text: "- 完整的回复" },
			{ text: "旧调用方仍能收到截断文本", truncated: true },
		]);
		let ctx!: PluginContext;
		const plugin: Plugin = {
			name: "test.complete",
			apply: (context) => {
				ctx = context;
			},
		};
		agent = await createAgent({
			dataDir: join(dir, "data"),
			settingsFile: join(dir, "settings.json"),
			plugins: [{ key: plugin.name, load: async () => plugin }],
			log: () => {},
		});
		await agent.service.saveProvider({
			id: "",
			name: "测试模型",
			api: "anthropic-messages",
			baseUrl: model.url,
			enabled: true,
			apiKey: "test",
			models: [
				{ modelId: "fake", name: "Fake", contextWindow: 200000, maxOutputTokens: 32000, supportsThinking: false, supportsImages: false, supportsTools: true },
			],
		});
		const strict = () => ctx.model.complete({ systemPrompt: "", prompt: "提炼", requireComplete: true });
		for (let attempt = 0; attempt < 2; attempt++) await expect(strict()).rejects.toThrow(text("model.incomplete"));
		expect(await strict()).toBe("- 完整的回复");
		expect(await ctx.model.complete({ systemPrompt: "", prompt: "旧调用" })).toBe("旧调用方仍能收到截断文本");
		const usage = await ctx.model.usage();
		expect(usage.requests.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(4);
		expect(model.requests).toHaveLength(4);
	} finally {
		await agent?.shutdown();
		await model?.close();
		await rm(dir, { recursive: true, force: true });
	}
});
