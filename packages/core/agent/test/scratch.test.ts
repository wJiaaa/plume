/**
 * 会话的临时目录和工具结果里的图，按产品真实的样子（带上内置插件）走一遍：
 * 系统提示词里写着临时目录和地址清单，`scratch://` 落在宿主给的目录、会话删掉时一起删，
 * read 读图片交给模型（模型不看图时请求那一层换成说明），只给人看的图和交给模型的图一样挪进媒体目录。
 */

import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentEvent, Plugin, PluginContext, ToolResultMessage } from "@plume/contract";
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

it("界面能打开同一脉的会话临时目录里的文件和文件夹，别的会话的不行，也不能改掉临时目录本身", async () => {
	let sessions: PluginContext["sessions"] | undefined;
	const owner: Plugin = { name: "test.children", apply: (ctx) => void (sessions = ctx.sessions) };
	agent = await createAgent({
		dataDir: join(dir, "data"),
		settingsFile: join(dir, "model.json"),
		plugins: [{ key: owner.name, load: async () => owner }],
		log: () => undefined,
	});
	const { service } = agent;
	const own = await service.createSession({ cwd: workspace });
	const child = await sessions!.create({ parentId: own.id });
	const other = await service.createSession({ cwd: workspace });
	const scratch = join(dir, "data", "scratch", own.id);
	const report = join(scratch, "report.md");
	await mkdir(scratch, { recursive: true });
	await writeFile(report, "# 报告");
	const childLog = join(dir, "data", "scratch", child.id, "tool-output", "a.log");
	await mkdir(join(childLog, ".."), { recursive: true });
	await writeFile(childLog, "全文");

	expect(await service.readFile(own.id, report)).toMatchObject({ text: "# 报告" });
	expect((await service.listDirectory(own.id, scratch)).map((entry) => entry.name)).toEqual(["report.md"]);
	expect(await agent.filePath(own.id, report)).toBe(await realpath(report));
	// 同一脉：父会话看得到子智能体存下的全文，子会话看得到父会话里的报告。
	expect(await service.readFile(own.id, childLog)).toMatchObject({ text: "全文" });
	expect(await service.readFile(child.id, report)).toMatchObject({ text: "# 报告" });

	expect(await service.readFile(other.id, report)).toBeNull();
	expect(await service.readFile(other.id, childLog)).toBeNull();
	expect(await agent.filePath(other.id, report)).toBeNull();
	await expect(service.listDirectory(other.id, scratch)).rejects.toThrow();

	expect(await service.fileOperation(own.id, { type: "rename", from: scratch, to: `${scratch}-renamed` })).toMatchObject({ ok: false });
	expect(await service.fileOperation(own.id, { type: "remove", paths: [scratch] })).toMatchObject({ ok: false });
	expect(await readFile(report, "utf8")).toBe("# 报告");
});

it("工具和审批拿到的 scratchDirs 是同一脉的会话的临时目录：这一轮中途开出去的子会话也算，别的会话的不算", async () => {
	let child: string | undefined;
	const seen: { run?: readonly string[]; approval?: readonly string[] } = {};
	const probe: Plugin = {
		name: "test.probe",
		apply(ctx) {
			ctx.tools.register({
				name: "spawn",
				description: "开一个子会话",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					child = (await ctx.sessions.create({ parentId: run.sessionId })).id;
					return { output: "开好了" };
				},
			});
			ctx.tools.register({
				name: "probe",
				description: "看看临时目录",
				parameters: { type: "object", properties: {} },
				async execute(_args, run) {
					seen.run = run.scratchDirs;
					await run.ask({ kind: "probe", title: "probe", detail: "", subject: "probe" });
					return { output: "看过了" };
				},
			});
			ctx.hook("tool.approve", async (input) => {
				seen.approval = input.scratchDirs;
				return "once";
			});
		},
	};
	const { service, session, turn } = await start(
		[{ toolCalls: [{ id: "call_spawn", name: "spawn", args: {} }] }, { toolCalls: [{ id: "call_probe", name: "probe", args: {} }] }, { text: "好了" }],
		{ plugins: [probe] },
	);
	const other = await service.createSession({ cwd: workspace });
	await turn("看看");

	const scratch = (id: string) => join(dir, "data", "scratch", id);
	expect([...(seen.run ?? [])].sort()).toEqual([scratch(session.id), scratch(child!)].sort());
	expect([...(seen.approval ?? [])].sort()).toEqual([scratch(session.id), scratch(child!)].sort());
	expect(seen.run).not.toContain(scratch(other.id));
});

it("内置的 write 按同一脉的会话放行：写进子会话的临时目录不问，写别的会话的临时目录被拒", async () => {
	// 审批比的是解析过软链的路径；macOS 的系统临时目录在软链后面，数据目录换成真实路径才和正式环境（`~/.plume`）一样。
	dir = await realpath(dir);
	workspace = join(dir, "workspace");
	let sessions: PluginContext["sessions"] | undefined;
	const owner: Plugin = { name: "test.children", apply: (ctx) => void (sessions = ctx.sessions) };
	// 会话 id 要等建好才知道：参数先占位，建好后填上。
	const writeChild = { path: "", content: "子会话的报告" };
	const writeOther = { path: "", content: "不该写进去" };
	const { service, session, turn, results } = await start(
		[
			{
				toolCalls: [
					{ id: "call_child", name: "write", args: writeChild },
					{ id: "call_other", name: "write", args: writeOther },
				],
			},
			{ text: "好了" },
		],
		{ plugins: [owner] },
	);
	const child = await sessions!.create({ parentId: session.id });
	const other = await service.createSession({ cwd: workspace });
	writeChild.path = join(dir, "data", "scratch", child.id, "report.md");
	writeOther.path = join(dir, "data", "scratch", other.id, "a.md");

	// 要问人的话，这一轮会停在审批卡上，`turn` 等到超时。
	await turn("交接一下");
	expect(await readFile(writeChild.path, "utf8")).toBe("子会话的报告");
	const refused = (await results()).find((result) => result.toolCallId === "call_other");
	expect(refused?.isError).toBe(true);
	expect(JSON.stringify(refused?.content)).toContain("Plume's own data directory");
	await expect(access(writeOther.path)).rejects.toThrow();
});

it("分叉、建议开出的新会话和来源同一脉：两头互相够得着，分叉的分叉也算；来源删掉后连线断开", async () => {
	let sessions: PluginContext["sessions"] | undefined;
	const owner: Plugin = { name: "test.launcher", apply: (ctx) => void (sessions = ctx.sessions) };
	const { service, session, turn } = await start([{ text: "第一句的回复" }, { text: "新会话的回复" }], { plugins: [owner] });
	await turn("第一句");
	const reply = (await service.getSession(session.id)).messages[1]!;
	const fork = await service.forkSession(session.id, 1, reply.timestamp, "分叉");
	const forkOfFork = await service.forkSession(fork.id, 1, reply.timestamp, "分叉的分叉");
	const launched = await sessions!.launch({ cwd: workspace, message: "接着做", spawnedFrom: { sessionId: session.id } });
	await launched.done;
	const other = await service.createSession({ cwd: workspace });

	const put = async (id: string, text: string) => {
		const path = join(dir, "data", "scratch", id, "note.md");
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, text);
		return path;
	};
	const source = await put(session.id, "来源的草稿");
	const forked = await put(forkOfFork.id, "分叉的草稿");
	const spawned = await put(launched.session.id, "新会话的草稿");

	// 分叉里复制过来的链接指着来源的临时目录；来源也看得到分叉、新会话的。
	for (const id of [fork.id, forkOfFork.id, launched.session.id]) expect(await service.readFile(id, source)).toMatchObject({ text: "来源的草稿" });
	expect(await service.readFile(session.id, forked)).toMatchObject({ text: "分叉的草稿" });
	expect(await service.readFile(forkOfFork.id, spawned)).toMatchObject({ text: "新会话的草稿" });
	expect(await service.readFile(other.id, source)).toBeNull();
	expect(await service.readFile(other.id, forked)).toBeNull();

	// 分叉和新会话只经来源连着：来源删掉，它们就不再同一脉。
	await service.deleteSession(session.id);
	expect(await service.readFile(forkOfFork.id, spawned)).toBeNull();
	expect(await service.readFile(fork.id, forked)).toMatchObject({ text: "分叉的草稿" });
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
