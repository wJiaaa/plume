import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HookTrace, Plugin, SessionObservation, ToolExecution, ToolOutput } from "@plume/contract";
import { createAgent, type Agent } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";

/**
 * 运行观察里的 `hooks`：一次钩子调用经过了哪几层、每层做了什么（放行、改了参数、改了结果、自己交了结果、出错），
 * 本体走没走到最里层。只记有没有改，不记改成了什么。
 */

let dir: string;
let agent: Agent | undefined;
let model: FakeModel | undefined;

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
});

type Next = (input: ToolExecution) => Promise<ToolOutput>;

/** 按工具名分派的一层：命中的那几件按 `act` 做，别的原样往里交。 */
const only = (tools: string[], act: (input: ToolExecution, next: Next) => Promise<ToolOutput>) => (input: ToolExecution, next: Next) =>
	tools.includes(input.call.name) ? act(input, next) : next(input);

it("tool.execute、tool.approve 各层的放行、改参数、改结果、短路、出错按调用记下，prompt.submit、model.context 也记", async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-hook-trace-"));
	model = await fakeAnthropic([
		{
			toolCalls: [
				{ id: "c-echo", name: "echo", args: { text: "原样" } },
				{ id: "c-blocked", name: "blocked", args: {} },
				{ id: "c-broken", name: "broken", args: {} },
				{ id: "c-guarded", name: "guarded", args: { secret: "不该出现在观察里" } },
			],
		},
		{ text: "好" },
	]);
	const seen: SessionObservation[] = [];
	const received: Record<string, unknown> = {};
	const tool = (name: string, mutating = false) => ({
		name,
		description: name,
		parameters: { type: "object" },
		...(mutating ? { mutating: true } : {}),
		execute: async (args: Record<string, unknown>): Promise<ToolOutput> => {
			received[name] = args;
			return { output: name };
		},
	});
	const plugins: Plugin[] = [
		{
			name: "test.tools",
			apply(ctx) {
				for (const name of ["echo", "blocked", "broken"]) ctx.tools.register(tool(name));
				ctx.tools.register(tool("guarded", true));
			},
		},
		{
			name: "test.watch",
			observe: "all",
			apply(ctx) {
				ctx.sessions.observe((observation) => void seen.push(observation));
				// 照原样展开再交下去：值没变，不算改。
				ctx.hook("tool.execute", async (input, next) => ({ ...(await next({ ...input })) }), { order: -10 });
				ctx.hook("prompt.submit", (input, next) => next(input));
				ctx.hook("model.context", async (input, next) => {
					const context = await next(input);
					return { ...context, sections: [...context.sections, { id: "test", text: "补一段" }] };
				});
			},
		},
		{
			name: "test.redact",
			apply: (ctx) =>
				ctx.hook(
					"tool.execute",
					only(["echo"], async (input, next) => {
						const result = await next(input);
						return { ...result, output: `${result.output}（已脱敏）` };
					}),
					{ order: -5 },
				),
		},
		{
			name: "test.rewrite",
			apply: (ctx) =>
				ctx.hook(
					"tool.execute",
					only(["echo"], (input, next) => next({ ...input, call: { ...input.call, args: { text: "改过" } } })),
				),
		},
		{
			name: "test.short",
			apply: (ctx) =>
				ctx.hook(
					"tool.execute",
					only(["blocked"], async () => ({ output: "拦下", isError: true })),
					{ order: 5 },
				),
		},
		{
			name: "test.broken",
			apply: (ctx) =>
				ctx.hook(
					"tool.execute",
					only(["broken"], async () => {
						throw new Error("坏了");
					}),
					{ order: 10 },
				),
		},
		{ name: "test.approver", apply: (ctx) => ctx.hook("tool.approve", async () => "once") },
	];
	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin })),
		log: () => undefined,
	});
	const service = agent.service;
	await service.saveProvider({
		id: "",
		name: "测试",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		apiKey: "private-test-key",
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
	});
	const session = await service.createSession({ cwd: dir });
	service.send(session.id, { content: [{ type: "text", text: "跑一下" }] });
	await vi.waitFor(() => expect(seen.some((observation) => observation.event.type === "turnEnd")).toBe(true), { timeout: 5_000, interval: 10 });

	const hooks = seen.flatMap(({ event }) => (event.type === "hooks" ? [event] : []));
	const of = (toolCallId: string, hook: HookTrace["hook"]) =>
		hooks.filter((event) => event.toolCallId === toolCallId && event.hook === hook).map(({ layers, inner }) => ({ layers, ...(inner ? { inner } : {}) }));
	const pass = (plugin: string, order: number, extra: Partial<HookTrace["layers"][number]> = {}) => ({ plugin, order, outcome: "next", ...extra });
	const outer = pass("test.watch", -10);

	// 放行、改结果、改参数，最里层的工具收到的是改过的参数。
	expect(of("c-echo", "tool.execute")).toEqual([
		{
			layers: [
				outer,
				pass("test.redact", -5, { changedOutput: true }),
				pass("test.rewrite", 0, { changedInput: true }),
				pass("test.short", 5),
				pass("test.broken", 10),
			],
			inner: "ran",
		},
	]);
	expect(received.echo).toEqual({ text: "改过" });
	// 自己交了结果：里面的层和最里层都没走到。
	expect(of("c-blocked", "tool.execute")).toEqual([
		{ layers: [outer, pass("test.redact", -5), pass("test.rewrite", 0), { plugin: "test.short", order: 5, outcome: "answered" }] },
	]);
	expect(received.blocked).toBeUndefined();
	// 出错记在出错的那一层，外面的层照样是往里交了。
	expect(of("c-broken", "tool.execute")).toEqual([
		{ layers: [outer, pass("test.redact", -5), pass("test.rewrite", 0), pass("test.short", 5), { plugin: "test.broken", order: 10, outcome: "failed" }] },
	]);
	// 会改动的工具执行前经 tool.approve 问：那一层替人答了，没弹给人。
	expect(of("c-guarded", "tool.execute")).toEqual([
		{ layers: [outer, pass("test.redact", -5), pass("test.rewrite", 0), pass("test.short", 5), pass("test.broken", 10)], inner: "ran" },
	]);
	expect(of("c-guarded", "tool.approve")).toEqual([{ layers: [{ plugin: "test.approver", order: 0, outcome: "answered" }] }]);
	expect(received.guarded).toEqual({ secret: "不该出现在观察里" });
	// 只记有没有改，不记参数和结果的内容。
	expect(JSON.stringify(hooks)).not.toContain("不该出现在观察里");
	expect(JSON.stringify(hooks)).not.toContain("改过");

	// prompt.submit 每条要写进会话的消息一条，不带调用和请求。
	const submits = hooks.filter((event) => event.hook === "prompt.submit");
	expect(submits).toEqual([{ type: "hooks", hook: "prompt.submit", layers: [pass("test.watch", 0)], inner: "ran" }]);
	// model.context 每次请求一条，带那次请求的 id。
	const requests = seen.flatMap(({ event }) => (event.type === "request" ? [event.id] : []));
	const contexts = hooks.filter((event) => event.hook === "model.context");
	expect(requests).toHaveLength(2);
	expect(contexts.map((event) => event.requestId)).toEqual(requests);
	expect(contexts[0]).toEqual(expect.objectContaining({ layers: [pass("test.watch", 0, { changedOutput: true })], inner: "ran" }));
});

it("外层设了只读，写文件的工具在本体停下：最里层记成 stopped", async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-hook-trace-"));
	model = await fakeAnthropic([{ toolCalls: [{ id: "c-write", name: "scribble", args: {} }] }, { text: "好" }]);
	const seen: SessionObservation[] = [];
	let ran = false;
	const plugins: Plugin[] = [
		{
			name: "test.plan",
			observe: "all",
			apply(ctx) {
				ctx.sessions.observe((observation) => void seen.push(observation));
				ctx.tools.register({
					name: "scribble",
					description: "写",
					parameters: { type: "object" },
					kind: "create",
					execute: async () => ((ran = true), { output: "写了" }),
				});
				ctx.hook("tool.execute", (input, next) => next({ ...input, readOnly: { refusal: "只读" } }));
			},
		},
	];
	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin })),
		log: () => undefined,
	});
	await agent.service.saveProvider({
		id: "",
		name: "测试",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		apiKey: "private-test-key",
		models: [
			{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
		],
	});
	const session = await agent.service.createSession({ cwd: dir });
	agent.service.send(session.id, { content: [{ type: "text", text: "写一下" }] });
	await vi.waitFor(() => expect(seen.some((observation) => observation.event.type === "turnEnd")).toBe(true), { timeout: 5_000, interval: 10 });
	const traces = seen.flatMap(({ event }) => (event.type === "hooks" && event.toolCallId === "c-write" ? [event] : []));
	expect(traces).toEqual([
		{
			type: "hooks",
			toolCallId: "c-write",
			hook: "tool.execute",
			layers: [{ plugin: "test.plan", order: 0, outcome: "next", changedInput: true }],
			inner: "stopped",
		},
	]);
	expect(ran).toBe(false);
});
