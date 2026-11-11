import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentEvent, Plugin } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

let dir: string | undefined;
let model: FakeModel | undefined;
let agent: Agent | undefined;

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	if (dir) await rm(dir, { recursive: true, force: true });
	agent = model = dir = undefined;
});

const names = (request: Record<string, unknown> | undefined) => (request?.tools as Array<{ name: string }> | undefined)?.map((tool) => tool.name);

// 工具表按会话冻结（plume.prompt）：一轮跑到一半装上的插件，它的工具这一轮不出现，前缀逐字节不变；下一轮开头才接在最后。
it("一轮中途装上带工具的插件，这一轮后续请求的工具表不变，下一轮新工具接在最后", async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-tool-freeze-"));
	const workspace = join(dir, "workspace");
	await mkdir(workspace);
	const extra: Plugin = {
		name: "test.extra",
		apply(ctx) {
			ctx.tools.register({
				name: "extra_tool",
				description: "后装的工具",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ output: "" }),
			});
		},
	};
	// 模型调它的那一步里装上 test.extra：正好落在这一轮第一次和第二次请求之间。
	const installer: Plugin = {
		name: "test.installer",
		apply(ctx) {
			ctx.tools.register({
				name: "install_extra",
				description: "装上 test.extra",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					await agent!.addPlugin({ key: extra.name, load: async () => extra });
					return { output: "装好了" };
				},
			});
		},
	};
	model = await fakeAnthropic([{ toolCalls: [{ id: "call_install", name: "install_extra", args: {} }] }, { text: "好了" }, { text: "第二轮" }]);
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [...BUILTINS, { key: installer.name, load: async () => installer }],
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
	const watching = new AbortController();
	const events: AgentEvent[] = [];
	const waiters = new Set<() => void>();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) {
			events.push(event);
			for (const waiter of waiters) waiter();
		}
	})();
	const idle = (from: number) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("等待一轮结束超时")), 5_000);
			const check = () => {
				if (!events.slice(from).some((event) => event.type === "sessions" && event.sessions.every((summary) => !summary.running))) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve();
			};
			waiters.add(check);
			check();
		});
	try {
		let done = idle(events.length);
		service.send(session.id, { content: [{ type: "text", text: "装上它" }] });
		await done;
		expect(model.requests).toHaveLength(2);
		const [first, second] = model.requests;
		expect(names(first)).toContain("install_extra");
		expect(names(first)).not.toContain("extra_tool");
		expect(names(second)).toEqual(names(first));
		expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(first?.tools));

		done = idle(events.length);
		service.send(session.id, { content: [{ type: "text", text: "下一轮" }] });
		await done;
		expect(model.requests).toHaveLength(3);
		expect(names(model.requests[2])).toEqual([...names(first)!, "extra_tool"]);
	} finally {
		watching.abort();
	}
});
