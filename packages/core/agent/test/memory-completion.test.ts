import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { Message, Plugin, PluginContext } from "@plume/contract";
import { createAgent, type Agent } from "../src/index.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";
import { MIN_AGE_MS, PASS_INTERVAL_MS, runPass } from "../../../../../plume-plugins/plugins/memory/src/extract.ts";

it("不完整的一次性回复不覆盖记忆也不推进游标，完整回复才写；所有回复仍计费", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-memory-completion-"));
	let agent: Agent | undefined;
	let model: FakeModel | undefined;
	try {
		model = await fakeAnthropic([
			{ text: "- 只写到一半", truncated: true },
			{ text: "- 还要调用工具", toolCalls: [{ id: "call", name: "read", args: { path: "unused" } }] },
			{ text: "- 保留原来的条目\n- 完整新增的条目" },
			{ text: "旧调用方仍能收到截断文本", truncated: true },
		]);
		let ctx!: PluginContext;
		const plugin: Plugin = {
			name: "test.complete-memory",
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
		const original = "- 保留原来的条目\n- 被截断会丢失的旧条目\n";
		await writeFile(join(dir, "MEMORY.md"), original);
		await writeFile(join(dir, ".cursor"), "1");
		const now = Date.now();
		const messages: Message[] = Array.from({ length: 6 }, () => ({ role: "user", content: [{ type: "text", text: "值得提炼的会话" }], timestamp: 0 }));
		const options = {
			dir,
			sessions: [{ id: "s1", updatedAt: now - MIN_AGE_MS - 1, running: false }],
			read: async () => messages,
			instructions: "",
			complete: (systemPrompt: string, prompt: string) => ctx.model.complete({ systemPrompt, prompt, requireComplete: true }),
		};
		for (const pass of [0, 1]) {
			const result = await runPass({ ...options, now: now + pass * PASS_INTERVAL_MS });
			expect(result.answered).toBeUndefined();
			expect(result.memory).toBe("");
			expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe(original);
			expect(await readFile(join(dir, ".cursor"), "utf8")).toBe("1");
		}
		const completedAt = now + 2 * PASS_INTERVAL_MS;
		expect(await runPass({ ...options, now: completedAt })).toMatchObject({ answered: true, memory: "- 保留原来的条目\n- 完整新增的条目" });
		expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("- 完整新增的条目");
		expect(await readFile(join(dir, ".cursor"), "utf8")).toBe(String(completedAt - MIN_AGE_MS));
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
