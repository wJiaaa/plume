/**
 * 内置子智能体插件 plume.subagents 和会话种类：本体只让顶层会话建子会话（`session.nestedChild`），所以 `task` 和介绍子智能体名单的那一段
 * 只给顶层会话；插件的子会话、独立会话（比如运维助手）里看不到，调到了也是一句说得清的拒绝。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Plugin, PluginContext } from "@plume/contract";
import subagents from "../../../builtin/subagents/src/index.ts";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-subagents-kind-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
});

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	await rm(dir, { recursive: true, force: true });
});

it("task 和子智能体名单只给顶层会话；插件的子会话、独立会话里不列，硬调到了是一句说得清的拒绝", async () => {
	let ctx!: PluginContext;
	const owner: Plugin = { name: "test.owner", apply: (context) => void (ctx = context) };
	/**
	 * 顶层会话只看工具表（真派出去的话子会话也来问模型，请求就分不清是谁的）；另两种硬调一次 `task`，拿到结果后收尾：
	 * 模型照着自己记得的工具名调，工具表里藏没藏都一样会到执行这一下。
	 */
	model = await fakeAnthropic((request) => {
		const messages = request.messages as Array<{ content: unknown }>;
		const last = messages[messages.length - 1]?.content;
		const answered = Array.isArray(last) && last.some((block: { type?: string }) => block.type === "tool_result");
		return answered || JSON.stringify(messages).includes("只看看")
			? { text: "好" }
			: { toolCalls: [{ id: `call-${Math.random()}`, name: "task", args: { description: "查一下", prompt: "看看", subagent_type: "explore" } }] };
	});
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: subagents.name, load: async () => subagents }, { key: owner.name, load: async () => owner }],
		log: () => undefined,
	});
	const service = agent.service;
	const providerId = await service.saveProvider({
		id: "",
		name: "假模型",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
		apiKey: "test-key",
	});
	await service.setDefaultModel(`${providerId}/fake`);
	await service.setPermissionMode("full");

	const top = await ctx.sessions.launch({ cwd: workspace, message: "只看看" });
	await top.done;
	const child = await ctx.sessions.create({ parentId: top.session.id });
	expect(await ctx.sessions.send(child.id, "你好")).toEqual({ reason: "done" });
	const standalone = await ctx.sessions.create({ cwd: workspace });
	expect(await ctx.sessions.send(standalone.id, "你好")).toEqual({ reason: "done" });

	// 顶层会话一次；另两种各两次：调 task、拿到结果收尾。
	const offered = model.requests.map((request) => ({
		task: (request.tools as Array<{ name: string }>).some((tool) => tool.name === "task"),
		catalogue: JSON.stringify(request.system).includes("<available_subagents>"),
	}));
	expect(offered).toEqual([
		{ task: true, catalogue: true },
		{ task: false, catalogue: false },
		{ task: false, catalogue: false },
		{ task: false, catalogue: false },
		{ task: false, catalogue: false },
	]);
	const result = async (sessionId: string) => {
		const found = (await service.getSession(sessionId)).messages.find((message) => message.role === "toolResult");
		return found?.role === "toolResult" ? { isError: found.isError, text: JSON.stringify(found.content) } : undefined;
	};
	// 拿到的拒绝说清了为什么，不是本体建子会话时的内部报错。
	for (const id of [child.id, standalone.id]) {
		const refused = await result(id);
		expect(refused?.isError).toBe(true);
		expect(refused?.text).toContain("Only a main conversation can dispatch sub-agents");
		expect(refused?.text).not.toContain("下面不能再建子会话");
	}
});
