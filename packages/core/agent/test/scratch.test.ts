/**
 * 会话的临时目录和工具结果里的图，按产品真实的样子（带上内置插件）走一遍：
 * 系统提示词里写着临时目录和地址清单，`scratch://` 落在宿主给的目录、会话删掉时一起删，
 * read 读图片交给模型（模型不看图时请求那一层换成说明），只给人看的图和交给模型的图一样挪进媒体目录。
 */

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentEvent, Plugin, ToolResultMessage } from "@plume/contract";
import { type Agent, createAgent } from "../src/index.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

/** 一个 1×1 的 PNG。 */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dir: string;
let workspace: string;
let model: FakeModel | undefined;
let agent: Agent | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-scratch-"));
	workspace = join(dir, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "dot.png"), Buffer.from(PIXEL, "base64"));
});

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	await rm(dir, { recursive: true, force: true });
});

async function start(replies: FakeReply[], { supportsImages = false, plugins = [] as Plugin[] } = {}) {
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
		models: [{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages, supportsTools: true }],
		apiKey: "test-key",
	});
	const session = await service.createSession({ cwd: workspace });
	const events: AgentEvent[] = [];
	const watching = new AbortController();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) events.push(event);
	})();
	/** 发一句话，等这一轮跑完。 */
	const turn = async (text: string) => {
		service.send(session.id, { content: [{ type: "text", text }] });
		const deadline = Date.now() + 5_000;
		while (!(await service.getSession(session.id)).summary.stop || service.listSessions().some((entry) => entry.running)) {
			if (Date.now() > deadline) throw new Error("等这一轮跑完超时");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const results = async () => (await service.getSession(session.id)).messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
	return { service, session, turn, results };
}

it.each([true, false])("read 读 PNG：图交给模型（模型看图：%s）", async (supportsImages) => {
	const { turn, results } = await start([{ toolCalls: [{ id: "call_read", name: "read", args: { path: "dot.png" } }] }, { text: "看到了" }], {
		supportsImages,
	});
	await turn("看看这张图");
	const [result] = await results();
	expect(result?.isError).toBe(false);
	expect(result?.content).toContainEqual({ type: "image", data: PIXEL, mimeType: "image/png" });
	expect(result?.details).toMatchObject({ kind: "image", path: "dot.png", mimeType: "image/png" });
	const sent = JSON.stringify(model?.requests[1]?.messages);
	if (supportsImages) expect(sent).toContain(PIXEL);
	else {
		expect(sent).not.toContain(PIXEL);
		expect(sent).toContain("image omitted");
	}
});

it("系统提示词写着会话的临时目录和地址清单；scratch:// 落在那里，会话删掉时一起删", async () => {
	const { service, session, turn } = await start([
		{ toolCalls: [{ id: "call_write", name: "write", args: { path: "scratch://notes/a.md", content: "草稿" } }] },
		{ text: "写好了" },
	]);
	await turn("记一笔");
	const scratch = join(dir, "data", "scratch", session.id);
	const system = JSON.stringify(model?.requests[0]?.system);
	expect(system).toContain(`Scratch directory: ${scratch}`);
	expect(system).toContain("## Addresses");
	expect(system).toContain("`scratch://` 本次会话的临时目录");
	expect(await readFile(join(scratch, "notes", "a.md"), "utf8")).toBe("草稿");

	await service.deleteSession(session.id);
	const deadline = Date.now() + 2_000;
	while (
		await access(scratch).then(
			() => true,
			() => false,
		)
	) {
		if (Date.now() > deadline) throw new Error("临时目录没删掉");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
});

it("shownImages 里只给人看的大图也挪进媒体目录，会话里只留名字；details 里同名的键本体不碰", async () => {
	const big = Buffer.alloc(9000, 7).toString("base64");
	const tool: Plugin = {
		name: "test.parked",
		apply(ctx) {
			ctx.tools.register({
				name: "shot",
				description: "截一张大图",
				parameters: { type: "object", properties: {} },
				execute: async () => ({
					output: "图太大，存在别处",
					shownImages: [{ data: big, mimeType: "image/png" }],
					details: { images: [{ media: "插件自己的" }] },
				}),
			});
		},
	};
	const { turn, results } = await start([{ toolCalls: [{ id: "call_shot", name: "shot", args: {} }] }, { text: "好" }], { plugins: [tool] });
	await turn("截一张");
	const [result] = await results();
	const [image] = result?.shownImages ?? [];
	expect(result?.details).toEqual({ images: [{ media: "插件自己的" }] });
	expect(image?.data).toBe("");
	expect(image?.media).toMatch(/^[0-9a-f]{40}\.png$/);
	expect((await readFile(join(dir, "data", "session-media", image?.media ?? ""))).toString("base64")).toBe(big);
	// 只给人看：模型那边没有它。
	expect(JSON.stringify(model?.requests[1]?.messages)).not.toContain(big);
});
