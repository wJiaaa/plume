/**
 * `ModelContext.parentId`、`owner`：从会话摘要照实带上，没有就不带这个键；plume.tools 凭 `parentId` 在子会话里藏起顶层专用的工具。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ModelContext, Plugin, PluginContext } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-model-context-session-"));
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

it("顶层会话不带 parentId、owner；子会话两个都有；独立会话只有 owner", async () => {
	let ctx!: PluginContext;
	const seen = new Map<string, Pick<ModelContext, "parentId" | "owner">>();
	const recorder: Plugin = {
		name: "test.recorder",
		apply(context) {
			ctx = context;
			ctx.hook("model.context", async (input, next) => {
				seen.set(input.sessionId, Object.fromEntries(Object.entries(input).filter(([key]) => key === "parentId" || key === "owner")));
				return next(input);
			});
		},
	};
	model = await fakeAnthropic([{ text: "好" }]);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: recorder.name, load: async () => recorder }],
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

	const top = await ctx.sessions.launch({ cwd: workspace, message: "你好" });
	expect(await top.done).toEqual({ reason: "done" });
	const child = await ctx.sessions.create({ parentId: top.session.id });
	expect(await ctx.sessions.send(child.id, "你好")).toEqual({ reason: "done" });
	const standalone = await ctx.sessions.create({ cwd: workspace });
	expect(await ctx.sessions.send(standalone.id, "你好")).toEqual({ reason: "done" });

	expect(seen.get(top.session.id)).toEqual({});
	expect(seen.get(child.id)).toEqual({ parentId: top.session.id, owner: "test.recorder" });
	expect(seen.get(standalone.id)).toEqual({ owner: "test.recorder" });

	// plume.tools 看 `parentId`：monitor 只在子会话里藏起来，独立会话照旧列着。
	const toolNames = model.requests.map((request) => (request.tools as Array<{ name: string }>).map((tool) => tool.name));
	expect(toolNames.map((names) => names.includes("monitor"))).toEqual([true, false, true]);
});
