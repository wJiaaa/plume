/**
 * 钩子输入和 `ToolRun` 上的 `session`：本体按会话摘要照实填 `kind`、`parentId`、`owner`；`ModelContext` 另带的 `parentId`、`owner`
 * 没有就不带这个键。plume.tools 凭 `session.kind` 在子会话、独立会话里藏起只有顶层会话用得上的工具。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ModelContext, Plugin, PluginContext, SessionScope } from "@plume/contract";
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

it("顶层、子会话、独立会话：每个钩子输入和 ToolRun 上的 session 照实带着种类和来处", async () => {
	let ctx!: PluginContext;
	/** 会话 id → 在哪儿看到的 `session`。 */
	const seen = new Map<string, Map<string, SessionScope>>();
	const record = (where: string, session: SessionScope) => {
		const byPlace = seen.get(session.id) ?? new Map<string, SessionScope>();
		byPlace.set(where, session);
		seen.set(session.id, byPlace);
	};
	const legacy = new Map<string, Pick<ModelContext, "parentId" | "owner">>();
	const recorder: Plugin = {
		name: "test.recorder",
		apply(context) {
			ctx = context;
			ctx.hook("prompt.submit", async (input, next) => (record("prompt.submit", input.session), next(input)));
			ctx.hook("model.context", async (input, next) => {
				record("model.context", input.session);
				legacy.set(input.sessionId, Object.fromEntries(Object.entries(input).filter(([key]) => key === "parentId" || key === "owner")));
				return next(input);
			});
			ctx.hook("context.compact", async (input, next) => (record("context.compact", input.session), next(input)));
			ctx.hook("tool.execute", async (input, next) => (record("tool.execute", input.session), next(input)));
			// 最外层直接答放行：只为看输入，不弹卡。
			ctx.hook("tool.approve", async (input) => (record("tool.approve", input.session), "once"), { order: -10_000 });
			ctx.hook("step.end", async (input, next) => (record("step.end", input.session), next(input)));
			ctx.tools.register({
				name: "probe",
				description: "probe",
				parameters: { type: "object", properties: {} },
				mutating: true,
				async execute(_args, run) {
					record("ToolRun", run.session);
					return { output: "ok" };
				},
			});
		},
	};
	// 每个会话：先调一次 probe，拿到结果后说一句收尾。
	model = await fakeAnthropic((request) => {
		const messages = request.messages as Array<{ content: unknown }>;
		const last = messages[messages.length - 1]?.content;
		const answered = Array.isArray(last) && last.some((block: { type?: string }) => block.type === "tool_result");
		return answered ? { text: "好" } : { toolCalls: [{ id: `call-${messages.length}-${Math.random()}`, name: "probe", args: {} }] };
	});
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
	// 完全访问会在本体里直接放行、不经 tool.approve：用「询问」看那一层的输入。
	await service.setPermissionMode("ask");

	const top = await ctx.sessions.launch({ cwd: workspace, message: "你好" });
	expect(await top.done).toEqual({ reason: "done" });
	const child = await ctx.sessions.create({ parentId: top.session.id });
	expect(await ctx.sessions.send(child.id, "你好")).toEqual({ reason: "done" });
	const standalone = await ctx.sessions.create({ cwd: workspace });
	expect(await ctx.sessions.send(standalone.id, "你好")).toEqual({ reason: "done" });

	const places = ["prompt.submit", "model.context", "context.compact", "tool.execute", "tool.approve", "ToolRun", "step.end"];
	const expected: Array<[string, SessionScope]> = [
		[top.session.id, { id: top.session.id, kind: "top" }],
		[child.id, { id: child.id, kind: "child", parentId: top.session.id, owner: "test.recorder" }],
		[standalone.id, { id: standalone.id, kind: "standalone", owner: "test.recorder" }],
	];
	for (const [id, scope] of expected) {
		expect([...(seen.get(id)?.keys() ?? [])].sort()).toEqual([...places].sort());
		for (const place of places) expect(seen.get(id)?.get(place), `${place} 上的 ${scope.kind}`).toEqual(scope);
	}
	// 摘要上的 `kind` 和钩子里的一致；`ctx.sessions.get` 找不到的是 undefined。
	expect((await ctx.sessions.get(top.session.id))?.kind).toBe("top");
	expect((await ctx.sessions.get(child.id))?.kind).toBe("child");
	expect((await ctx.sessions.get(standalone.id))?.kind).toBe("standalone");
	expect(await ctx.sessions.get("missing")).toBeUndefined();

	// `ModelContext` 另带的两个键照旧：顶层不带，子会话两个都有，独立会话只有 owner。
	expect(legacy.get(top.session.id)).toEqual({});
	expect(legacy.get(child.id)).toEqual({ parentId: top.session.id, owner: "test.recorder" });
	expect(legacy.get(standalone.id)).toEqual({ owner: "test.recorder" });

	// plume.tools 看 `session.kind`：monitor 只给顶层会话，子会话、独立会话都收不到它的输出，不列。
	const listed = model.requests.map((request) => (request.tools as Array<{ name: string }>).some((tool) => tool.name === "monitor"));
	expect(listed).toEqual([true, true, false, false, false, false]);
});
