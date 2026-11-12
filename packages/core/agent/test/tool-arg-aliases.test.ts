/**
 * 模型把参数名写错（schema 是 `path`，它写 `file`）时，工具照样认得；那么每个在工具之前按参数做判断的地方——tool.execute 的层、
 * 审批、转录——也得看到同一个名字，否则一条读 `path` 的守卫读到空值、放过去，工具却照样读了。
 * 这里用真实的内置插件和假模型，看层看到的、会话里存下的、工具实际做的是不是同一件事。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentEvent, Message, Plugin, ToolCall } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;
const watching = new AbortController();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-arg-aliases-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
	// 假的「密钥」，只在临时目录里。
	await writeFile(join(workspace, "fake.env"), "TOKEN=not-a-real-secret\n");
	await writeFile(join(workspace, "hello.txt"), "hello\n");
});

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = model = undefined;
	await rm(dir, { recursive: true, force: true });
});

async function start(replies: FakeReply[], plugins: Plugin[]) {
	model = await fakeAnthropic(replies);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, ...plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin }))],
		log: () => undefined,
	});
	const service = agent.service;
	await service.saveProvider({
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
	const session = await service.createSession({ cwd: workspace });
	const events: AgentEvent[] = [];
	const waiters = new Set<() => void>();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) {
			events.push(event);
			for (const waiter of waiters) waiter();
		}
	})();
	const until = <E extends AgentEvent>(match: (event: AgentEvent) => event is E, from = 0): Promise<E> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("等待事件超时")), 5_000);
			const check = () => {
				const found = events.slice(from).find(match);
				if (!found) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve(found);
			};
			waiters.add(check);
			check();
		});
	const idle = () => until((event): event is AgentEvent => event.type === "sessions" && event.sessions.every((summary) => !summary.running), events.length);
	return { service, session, until, idle };
}

/** 一条照常见写法写的守卫：参数里的 `path` 以 `.env` 结尾就拦下。记下它看到的参数。 */
function envGuard(seen: ToolCall[]): Plugin {
	return {
		name: "test.env-guard",
		apply(ctx) {
			ctx.hook("tool.execute", async (input, next) => {
				seen.push(structuredClone(input.call));
				const path = input.call.args.path;
				if (typeof path === "string" && path.endsWith(".env")) return { output: "守卫拦下了 .env", isError: true };
				return next(input);
			});
		},
	};
}

const toolResults = (messages: Message[]) => messages.filter((message) => message.role === "toolResult");
const storedCalls = (messages: Message[]) =>
	messages.flatMap((message) => (message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []));

it("模型用别名写参数时，tool.execute 的层看到的是规范名，守卫照样拦得住", async () => {
	const seen: ToolCall[] = [];
	const { service, session, idle } = await start(
		[
			{
				toolCalls: [
					{ id: "call_file", name: "read", args: { file: "fake.env" } },
					{ id: "call_file_path", name: "read", args: { filePath: "fake.env" } },
					// 规范名和别名都给了：规范名算数，别名不留在参数里，免得层和工具各读一个。
					{ id: "call_both", name: "read", args: { path: "hello.txt", file: "fake.env" } },
				],
			},
			{ text: "好" },
		],
		[envGuard(seen)],
	);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	await done;

	const { messages } = await service.getSession(session.id);
	const results = toolResults(messages);
	expect(JSON.stringify(results)).not.toContain("not-a-real-secret");
	expect(seen.map((call) => call.args)).toEqual([{ path: "fake.env" }, { path: "fake.env" }, { path: "hello.txt" }]);
	expect(results.map((result) => JSON.stringify(result.content))).toEqual([
		expect.stringContaining("守卫拦下了 .env"),
		expect.stringContaining("守卫拦下了 .env"),
		expect.stringContaining("hello"),
	]);
	// 会话里存的也是规范名：转录、导出、压缩读的是同一份参数，不用各自再认一遍别名。
	expect(storedCalls(messages).map((call) => call.arguments)).toEqual([{ path: "fake.env" }, { path: "fake.env" }, { path: "hello.txt" }]);
});

it("别名调用照样能用：grep、glob 的式子和目录、read 的 charOffset 换成规范名后执行", async () => {
	await mkdir(join(workspace, "src"));
	await writeFile(join(workspace, "src", "a.ts"), "export const needle = 1;\n");
	const seen: ToolCall[] = [];
	const { service, session, idle } = await start(
		[
			{
				toolCalls: [
					{ id: "call_grep", name: "grep", args: { query: "needle", dir: "src" } },
					{ id: "call_glob", name: "glob", args: { search: "*.ts", cwd: "src" } },
					{ id: "call_read", name: "read", args: { filePath: "hello.txt", charOffset: 2 } },
				],
			},
			{ text: "好" },
		],
		[envGuard(seen)],
	);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "找一下" }] });
	await done;

	expect(seen.map((call) => call.args)).toEqual([
		{ pattern: "needle", path: "src" },
		{ pattern: "*.ts", path: "src" },
		{ path: "hello.txt", char_offset: 2 },
	]);
	const results = toolResults((await service.getSession(session.id)).messages);
	expect(results.every((result) => !result.isError)).toBe(true);
	expect(JSON.stringify(results[0]?.content)).toContain("a.ts");
	expect(JSON.stringify(results[1]?.content)).toContain("a.ts");
	// 从第 2 个字符读起：`hello` 成了 `ello`。
	expect(JSON.stringify(results[2]?.content)).toContain("ello");
});

it("读密钥文件的审批在工具里按解析后的路径问，别名绕不过去", async () => {
	const keys = join(dir, "home", ".ssh");
	await mkdir(keys, { recursive: true });
	await writeFile(join(keys, "id_fake"), "not-a-real-key\n");
	const { service, session, until, idle } = await start(
		[{ toolCalls: [{ id: "call_key", name: "read", args: { file: join(keys, "id_fake") } }] }, { text: "好" }],
		[],
	);
	const done = idle();
	service.send(session.id, { content: [{ type: "text", text: "读一下" }] });
	const asked = await until((event): event is Extract<AgentEvent, { type: "approval" }> => event.type === "approval" && event.approval !== undefined);
	expect(asked.approval).toMatchObject({ toolCallId: "call_key", tool: "read", kind: "view" });
	service.respond(session.id, "call_key", "reject");
	await done;
	expect(JSON.stringify(toolResults((await service.getSession(session.id)).messages))).not.toContain("not-a-real-key");
});
