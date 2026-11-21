import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import type { CommandProvider, Message, PluginContext, SessionMessage, SessionObservation, SessionSummary, StopReason } from "@plume/contract";
import type { SideChatApi } from "../src/api.ts";
import plugin from "../src/index.ts";

const said = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as Message;
const textOf = (message: string | SessionMessage) =>
	typeof message === "string" ? message : message.content.map((block) => ("text" in block ? block.text : "")).join("");

/**
 * 假的会话：`send` 开一轮、跑起来以后才返回观察；`finish` 收场这一轮，按本体的顺序推 `turnEnd`、`running: false`。
 * 插进去的话（`steer`）由 `read` 写进会话，没 `read` 的收场时就作废了，和本体一样。
 */
async function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "plume-side-chat-"));
	t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const summaries: SessionSummary[] = [
		{ id: "main", title: "", cwd: "/w", running: false, createdAt: 0, updatedAt: 0 } as SessionSummary,
		{ id: "side", title: "", cwd: "/w", running: false, createdAt: 0, updatedAt: 0, parentId: "main", owner: "plume.side-chat" } as SessionSummary,
	];
	const side = summaries[1]!;
	const messages: Message[] = [];
	const sent: string[] = [];
	const steered: string[] = [];
	let api: SideChatApi | undefined;
	let observer: ((observation: SessionObservation) => void) | undefined;
	let commands: CommandProvider | undefined;
	let endTurn: ((reason: StopReason) => void) | undefined;
	let steerFails = false;
	const observe = (event: SessionObservation["event"]) => observer?.({ sessionId: "side", at: messages.length, timestamp: 0, event });
	const ctx = {
		name: "plume.side-chat",
		dataDir: directory,
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		notice() {},
		hook() {},
		tools: { register: () => () => {}, list: () => [] },
		commands: { provide: (provider: CommandProvider) => void (commands = provider) },
		serve: (value: SideChatApi) => void (api = value),
		settings: async (defaults: object) => ({ get: () => defaults, set: async (patch: object) => ({ ...defaults, ...patch }), onChange: () => () => {} }),
		sessions: {
			list: async () => structuredClone(summaries),
			get: async (id: string) => structuredClone(summaries.find((summary) => summary.id === id)),
			messages: async (id: string) => (id === "side" ? structuredClone(messages) : []),
			onDeleted() {},
			observe: (listener: (observation: SessionObservation) => void) => void (observer = listener),
			send(id: string, message: string | SessionMessage) {
				assert.equal(id, "side");
				if (side.running) return Promise.reject(new Error("正在跑"));
				sent.push(textOf(message));
				messages.push(said(textOf(message)));
				side.running = true;
				return new Promise((resolve) => {
					// 跑起来的观察晚一拍到：`ask` 等的是它，不是这一轮做完。
					queueMicrotask(() => observe({ type: "running", running: true }));
					endTurn = (reason) => resolve({ reason });
				});
			},
			async steer(_id: string, message: string | SessionMessage) {
				if (steerFails || !side.running) throw new Error("没在跑");
				steered.push(textOf(message));
			},
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	return {
		api: api!,
		commands: commands!,
		sent,
		steered,
		failSteer: () => (steerFails = true),
		/** 模型读到了插进去的那句：写进会话，下一次请求带着它。 */
		async read(text: string) {
			messages.push(said(text));
			observe({ type: "request", id: "r", provider: "p", model: "m", systemPrompt: "", messages: structuredClone(messages), tools: [] });
			await settle();
		},
		async finish(reason: StopReason = "done") {
			side.running = false;
			endTurn?.(reason);
			observe({ type: "turnEnd", stop: { reason } });
			observe({ type: "running", running: false });
			await settle();
			await settle();
		},
		waiting: async () => (await api!.waiting("side")).map((entry) => `${entry.steered ? "插话" : "排着"}:${entry.preview}`),
	};
}

test("闲着时问一句：跑起来就返回，不等这一轮答完", async (t) => {
	const f = await fixture(t);
	await f.api.ask("side", "第一句");
	assert.deepEqual(f.sent, ["第一句"]);
	assert.deepEqual(await f.waiting(), []);
});

test("在跑时排的话等这一轮以完成收场再一句一句发；被人停下的留着，现在就发才发", async (t) => {
	const f = await fixture(t);
	await f.api.ask("side", "第一句");
	await f.api.queue("side", "第二句");
	// 排队条拿过来的（`ask`）在跑时也排到后面。
	await f.api.ask("side", "第三句");
	assert.deepEqual(await f.waiting(), ["排着:第二句", "排着:第三句"]);
	await f.finish();
	assert.deepEqual(f.sent, ["第一句", "第二句"]);
	await f.finish("aborted");
	assert.deepEqual(f.sent, ["第一句", "第二句"]);
	const [entry] = await f.api.waiting("side");
	await f.api.sendNow("side", entry!.id);
	assert.deepEqual(f.sent, ["第一句", "第二句", "第三句"]);
});

test("停着、前面还有排着的：新问的一句排在它们后面，由这一下推着发队头", async (t) => {
	const f = await fixture(t);
	await f.api.ask("side", "第一句");
	await f.api.queue("side", "第二句");
	await f.finish("aborted");
	await f.api.ask("side", "第三句");
	assert.deepEqual(f.sent, ["第一句", "第二句"]);
	assert.deepEqual(await f.waiting(), ["排着:第三句"]);
});

test("插话交给本体；读到了就从回执条拿掉，收场前没读到的转进队头接着发", async (t) => {
	const f = await fixture(t);
	await f.api.ask("side", "第一句");
	await f.api.steer("side", "只看 src");
	await f.api.steer("side", "顺便看看测试");
	assert.deepEqual(f.steered, ["只看 src", "顺便看看测试"]);
	await f.api.queue("side", "排着的");
	assert.deepEqual(await f.waiting(), ["插话:只看 src", "插话:顺便看看测试", "排着:排着的"]);
	await f.read("只看 src");
	assert.deepEqual(await f.waiting(), ["插话:顺便看看测试", "排着:排着的"]);
	// 这一轮收尾时插的那句本体作废了：不丢，排在原来排着的前面先发。
	await f.finish();
	assert.deepEqual(f.sent, ["第一句", "顺便看看测试"]);
	assert.deepEqual(await f.waiting(), ["排着:排着的"]);
});

test("插不进去（这一轮在收尾）就排到后面；已经停了的插话照常开一轮", async (t) => {
	const f = await fixture(t);
	await f.api.ask("side", "第一句");
	f.failSteer();
	await f.api.steer("side", "插不进去");
	assert.deepEqual(await f.waiting(), ["排着:插不进去"]);
	await f.finish();
	assert.deepEqual(f.sent, ["第一句", "插不进去"]);
	await f.finish();
	await f.api.steer("side", "停了才说");
	assert.deepEqual(f.sent, ["第一句", "插不进去", "停了才说"]);
});

test("排着的能收回（交回字）、删掉；插进去的收不回", async (t) => {
	const f = await fixture(t);
	await f.api.ask("side", "第一句");
	await f.api.steer("side", "插话");
	await f.api.queue("side", { content: [{ type: "text", text: "改一下" }], displayText: "改一下" });
	const [steer, queued] = await f.api.waiting("side");
	assert.equal(await f.api.unqueue("side", steer!.id), undefined);
	assert.equal(await f.api.unqueue("side", queued!.id), "改一下");
	assert.deepEqual(await f.waiting(), ["插话:插话"]);
});

test("侧边聊天里的 / 菜单不列 /btw，别的会话照列", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await f.commands.list({ sessionId: "side" }), []);
	assert.deepEqual(
		(await f.commands.list({ sessionId: "main" })).map((command) => command.name),
		["btw"],
	);
});
