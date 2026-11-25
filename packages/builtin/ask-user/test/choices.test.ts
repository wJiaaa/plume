/** 选择卡：围栏里的 JSON 怎么认、这张卡答没答怎么从会话里推、教给哪些会话、关掉的那张怎么记。 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Hooks, Message, QueuedMessage, SessionSummary } from "@plume/contract";
import { loadPlugin } from "@plumeai/plugin-sdk/testing";
import { type AskUserApi, DISMISSED } from "../src/api.ts";
import { CHOICE_SECTION, CHOICES, CHOICES_PROMPT, choicesText, outcomeOf, readChoices } from "../src/choices.ts";
import plugin from "../src/index.ts";

const CARD = {
	summary: "两条路都查过了，还没动手。",
	question: "走哪一条？",
	options: [
		{ label: "方案 B", send: "用方案 B，改解析器。", recommended: true },
		{ label: "方案 A", send: "用方案 A，只改调用处。" },
	],
};
const code = JSON.stringify(CARD);
const choices = readChoices(code)!;

const fence = (body: string) => `两条路如下。\n\n\`\`\`${CHOICES}\n${body}\n\`\`\`\n`;
// 只有角色和文字的消息：推断答没答只看这几样。
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as Message;
const said = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: [{ type: "text", text }], ...extra }) as unknown as Message;
const queued = (text: string, extra: Record<string, unknown> = {}) =>
	({ id: "q", preview: text, message: { content: [{ type: "text", text }] }, createdAt: 0, ...extra }) as unknown as QueuedMessage;

it("认出一张卡；提示词里的例子也认得出来", () => {
	expect(choices).toEqual({ ...CARD, options: [CARD.options[0], { ...CARD.options[1], recommended: false }] });
	expect(choicesText(choices)).toBe("两条路都查过了，还没动手。\n\n走哪一条？\n- 方案 B\n- 方案 A");
	const example = new RegExp(`\`\`\`${CHOICES}\\n([^\\n]+)\\n`).exec(CHOICES_PROMPT);
	expect(readChoices(example![1]!)?.options).toHaveLength(2);
});

it("不成立的照源码画：写了一半、少问题、选项太少太多、缺字、两项发同一句", () => {
	const option = (index: number) => ({ label: `${index}`, send: `选 ${index}` });
	const bad: unknown[] = [
		null,
		[],
		{ ...CARD, question: " " },
		{ ...CARD, summary: 1 },
		{ ...CARD, options: [option(1)] },
		{ ...CARD, options: [1, 2, 3, 4, 5, 6, 7].map(option) },
		{ ...CARD, options: [option(1), { label: "缺 send" }] },
		{ ...CARD, options: [option(1), { ...option(2), recommended: "yes" }] },
		{ ...CARD, options: [option(1), { label: "另一项", send: " 选 1 " }] },
	];
	for (const value of bad) expect(readChoices(JSON.stringify(value)), JSON.stringify(value)).toBeUndefined();
	expect(readChoices(code.slice(0, -5))).toBeUndefined();
});

it("推荐只认第一个", () => {
	const both = readChoices(JSON.stringify({ ...CARD, options: CARD.options.map((option) => ({ ...option, recommended: true })) }));
	expect(both?.options.map((option) => option.recommended)).toEqual([true, false]);
});

it("答没答看这条回复之后人说的第一句", () => {
	const card = reply(fence(code));
	const [first, second] = choices.options;
	expect(outcomeOf(choices, [], [])).toBe("open");
	expect(outcomeOf(choices, [said(first!.send), card], [])).toBe("open");
	expect(outcomeOf(choices, [card, said(` ${second!.send}\n`)], [])).toEqual(second);
	expect(outcomeOf(choices, [card, said("展开后的话", { displayText: first!.send })], [])).toEqual(first);
	expect(outcomeOf(choices, [card, said("都不要"), said(first!.send)], [])).toBe("passed");
	expect(outcomeOf(choices, [card, reply("接着说"), said(first!.send)], [])).toEqual(first);
	// 换一种排版写的、围栏更长的，认的是同一张。
	const pretty = reply(`\`\`\`\`${CHOICES}\r\n${JSON.stringify(CARD, null, 2)}\r\n\`\`\`\`\r\n`);
	expect(outcomeOf(choices, [pretty, said("别的")], [])).toBe("passed");
});

it("不是人说的不算：后台送达、别的会话的信、子会话交的事；排着的人话算", () => {
	const card = reply(fence(code));
	const send = choices.options[0]!.send;
	expect(outcomeOf(choices, [card, said("后台跑完了", { synthetic: true }), said("交过来的事", { origin: "child" })], [])).toBe("open");
	expect(outcomeOf(choices, [card], [queued("交过来的事", { origin: "child" })])).toBe("open");
	expect(outcomeOf(choices, [card], [queued("交过来的事", { origin: "child" }), queued(send)])).toEqual(choices.options[0]);
	expect(outcomeOf(choices, [card], [queued("先别动")])).toBe("passed");
});

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-choices-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const file = () => join(dir, "dismissed.json");
async function load(sessions: string[] = []) {
	const list = async () => sessions.map((id) => ({ id }) as SessionSummary);
	return loadPlugin(plugin, { ctx: { dataDir: dir, sessions: { list } } });
}

it("只教侧栏里、没有代管的会话", async () => {
	const loaded = await load();
	const sections = async (session: Record<string, unknown>) => {
		// 插件只看 session 和 sections。
		const input = { session: { id: "s", ...session }, sections: [] } as unknown as Hooks["model.context"][0];
		let seen: string[] = [];
		await loaded.hook("model.context", input, async (inner) => {
			seen = inner.sections.map((section) => section.id);
			return inner as unknown as Hooks["model.context"][1];
		});
		return seen;
	};
	expect(await sections({ kind: "top" })).toEqual([CHOICE_SECTION]);
	expect(await sections({ kind: "top", steward: "plume.im" })).toEqual([]);
	expect(await sections({ kind: "child" })).toEqual([]);
});

it("关掉的那张记在磁盘上，重载还在；删会话时一起丢，没在跑时删掉的会话加载时清", async () => {
	const loaded = await load(["a", "b"]);
	const api = loaded.api as AskUserApi;
	api.dismiss("a", "1:1/0:0");
	api.dismiss("a", "3:3/0:0");
	api.dismiss("b", "5:5/0:0");
	expect(loaded.sessionStore(DISMISSED).get("a")).toBe("3:3/0:0");
	await expect.poll(async () => JSON.parse(await readFile(file(), "utf8").catch(() => "null"))).toEqual({ a: "3:3/0:0", b: "5:5/0:0" });

	const again = await load(["a", "b"]);
	expect(again.sessionStore(DISMISSED).get("a")).toBe("3:3/0:0");
	expect(again.sessionStore(DISMISSED).get("没关过")).toBe("");
	await again.emit("onDeleted", "a");
	await expect.poll(async () => JSON.parse(await readFile(file(), "utf8"))).toEqual({ b: "5:5/0:0" });

	const later = await load([]);
	expect(later.sessionStore(DISMISSED).get("b")).toBe("");
	await expect.poll(async () => JSON.parse(await readFile(file(), "utf8"))).toEqual({});
});

it("记录读不出来只写日志，插件照常加载", async () => {
	await writeFile(file(), "{");
	const loaded = await load(["a"]);
	expect(loaded.logs).toEqual([expect.objectContaining({ level: "warn" })]);
	expect(loaded.sessionStore(DISMISSED).get("a")).toBe("");
});
