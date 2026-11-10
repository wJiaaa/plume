import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { runPluginCli } from "./smoke-plugin-cli.ts";

const PLAN = "冒烟：先定个计划";
const READY = "计划定了：用 SQLite。";
const EXEC = "冒烟：去问问定计划的那个会话";
const QUESTION = "为什么选 SQLite？";
const ASKED = "问过了，等它的答复。";
const ANSWER = "因为只在单机上跑，不用另起服务。";
const REPLIED = "回过去了。";
const GOT = "收到答复：单机，所以 SQLite。";

/**
 * 会话之间互发消息（市场插件 plume.sessions）：先装上它。开两个对话，第二个让假模型用 `ask_session` 问第一个；第一个闲着，
 * 为这封信开一轮，假模型用 `reply_session` 回；答复送回第二个、叫起它一轮。两边对话里各有一行「来自 …」「… 的答复」，
 * 不画成人的气泡；点开读全文，旁边的箭头跳到对方会话。
 */
export async function checkPeers(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; pluginsDir: string; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`会话互发消息等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => setTimeout(resolve, 500))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const chatHas = (text: string) => `document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(text)}) === true`;
	const open = async (prompt: string) => {
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(prompt);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		let id = "";
		await wait(async () => {
			id = (await agent.sessions()).find((item) => !previous.has(item.id))?.id ?? "";
			return id !== "";
		}, "新会话已创建");
		return id;
	};
	const ref = (id: string) => id.replace(/-/g, "").slice(0, 6);

	if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
	await runPluginCli(plugin.cli, ["install", join(plugin.pluginsDir, "sessions"), "--to", plugin.installDir]);
	await wait(async () => (await agent.plugins()).some((status) => status.key === "sessions" && status.state === "active"), "装上会话互通插件");

	let planId = "";
	const letters: string[] = [];
	// 按整段对话认是哪一方、走到哪一步，越往后的状态越先认：最后一条消息未必是人那句（钩子会在后面补几句上下文）。
	setModel((request) => {
		const all = JSON.stringify(request.messages ?? []);
		if (all.includes("<session-message")) letters.push(all);
		if (all.includes('answer=\\"replied\\"')) return { text: GOT };
		if (all.includes("toolu_peer_reply")) return { text: REPLIED };
		if (all.includes('reply=\\"expected\\"')) {
			const from = /from=\\"[^"\\]*\[([0-9a-f]{6})\]\\"/.exec(all)?.[1] ?? "";
			return { toolCalls: [{ id: "toolu_peer_reply", name: "reply_session", args: { to: from, message: ANSWER } }] };
		}
		if (all.includes("toolu_peer_ask")) return { text: ASKED };
		if (all.includes(EXEC)) return { toolCalls: [{ id: "toolu_peer_ask", name: "ask_session", args: { to: ref(planId), message: QUESTION } }] };
		return { text: READY };
	});
	try {
		planId = await open(PLAN);
		await until(chatHas(READY), "第一个对话定好计划");
		const execId = await open(EXEC);
		await until(chatHas(ASKED), "第二个对话问完就收尾");
		await until(chatHas(GOT), "答复送回来、叫起第二个对话一轮");
		const answer = "[data-screen=chat] [data-peer-letter]";
		await until(`document.querySelector(${JSON.stringify(answer)})?.textContent.includes('的答复') === true`, "第二个对话里有「… 的答复」那一行");
		if (!(await page<string>(`document.querySelector(${JSON.stringify(answer)}).textContent`)).includes(ANSWER))
			throw new Error("答复那一行的摘要不是答复的开头");
		if (
			await page<boolean>(`[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].some(e => e.textContent.includes('session-message'))`)
		)
			throw new Error("信画成了人的气泡");
		const request = letters.find((text) => text.includes('reply=\\"expected\\"'));
		if (!request?.includes("不是用户说的话") || !request.includes(QUESTION)) throw new Error("送给被问的一方的信不对");
		if (!letters.some((text) => text.includes('answer=\\"replied\\"') && text.includes(ANSWER))) throw new Error("送回问的一方的答复不对");
		await page(`document.querySelector(${JSON.stringify(answer)}) .querySelector('[data-flow-row], button')?.click()`);
		await capture("smoke-peers-answer.png");

		// 第二个对话里那一行的箭头跳到第一个对话：那边有「来自 …」那一行和它回的那句。
		await page(`document.querySelector('[data-peer-open]').click()`);
		await until(chatHas(REPLIED), "箭头跳到被问的那个对话");
		await until(`document.querySelector(${JSON.stringify(answer)})?.textContent.includes('来自') === true`, "被问的对话里有「来自 …」那一行");
		if (!(await page<string>(`document.querySelector(${JSON.stringify(answer)}).textContent`)).includes(QUESTION)) throw new Error("来信那一行的摘要不是问题");
		await until(chatHas("回复会话"), "被问的对话里有回复会话那一行");
		await capture("smoke-peers-request.png");
		if (!(await agent.sessions()).some((item) => item.id === execId)) throw new Error("第二个对话不见了");
	} finally {
		setModel(undefined);
	}
}
