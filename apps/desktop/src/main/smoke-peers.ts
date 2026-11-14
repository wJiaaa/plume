import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { clickVisible, clickVisibleIn } from "./smoke-kit.ts";

const PLAN = "冒烟：先定个计划";
const READY = "计划定了：用 SQLite。";
const EXEC = "冒烟：去问问定计划的那个会话";
const QUESTION = "为什么选 SQLite？";
const ASKED = "发过去了，等它回话。";
const ANSWER = "因为只在单机上跑，不用另起服务。";
const REPLIED = "回过去了。";
const GOT = "收到答复：单机，所以 SQLite。";

/**
 * 会话之间互发消息（市场插件 plume.sessions）：先装上它。开两个对话，第二个让假模型用 `send_message` 发给第一个；第一个闲着，
 * 为这封信开一轮，假模型同样用 `send_message` 回一条；回话送进第二个、叫起它一轮。消息是单向的，两边对话里各有一行「来自 …」，
 * 不画成人的气泡；点开读全文，旁边的箭头跳到对方会话。发的那一行标着回执：第二个对话那条收到回话后是「已回复」，
 * 第一个对话那条是「已送达」；点了那一行跳到对方。
 */
export async function checkPeers(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
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
		await clickVisible(page, `[data-composer-send=send]`);
		let id = "";
		await wait(async () => {
			id = (await agent.sessions()).find((item) => !previous.has(item.id))?.id ?? "";
			return id !== "";
		}, "新会话已创建");
		return id;
	};
	const ref = (id: string) => id.replace(/-/g, "").slice(0, 6);

	if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
	await plugin.install("sessions");
	await wait(async () => (await agent.plugins()).some((status) => status.key === "sessions" && status.state === "active"), "装上会话互通插件");

	let planId = "";
	/** 收到信的那几次请求：哪一方（按第一条消息）、整段对话。 */
	const letters: Array<{ exec: boolean; all: string }> = [];
	// 按整段对话认走到哪一步，越往后的状态越先认：最后一条消息未必是人那句（钩子会在后面补几句上下文）。
	setModel((request) => {
		const all = JSON.stringify(request.messages ?? []);
		// 信的 from 带着对方的标题（就是它的第一句），所以按第一条消息认是哪一方。
		const opening = JSON.stringify((request.messages as unknown[] | undefined)?.[0] ?? null);
		if (all.includes("<session-message")) letters.push({ exec: opening.includes(EXEC), all });
		if (opening.includes(EXEC)) {
			if (all.includes(ANSWER)) return { text: GOT };
			if (all.includes("toolu_peer_ask")) return { text: ASKED };
			return { toolCalls: [{ id: "toolu_peer_ask", name: "send_message", args: { to: ref(planId), message: QUESTION } }] };
		}
		if (all.includes("toolu_peer_reply")) return { text: REPLIED };
		if (all.includes("<session-message")) {
			const from = /from=\\"[^"\\]*\[([0-9a-f]{6})\]\\"/.exec(all)?.[1] ?? "";
			return { toolCalls: [{ id: "toolu_peer_reply", name: "send_message", args: { to: from, message: ANSWER } }] };
		}
		return { text: READY };
	});
	try {
		planId = await open(PLAN);
		await until(chatHas(READY), "第一个对话定好计划");
		const execId = await open(EXEC);
		await until(chatHas(ASKED), "第二个对话问完就收尾");
		await until(chatHas(GOT), "回话送回来、叫起第二个对话一轮");
		const letterRow = "[data-screen=chat] [data-peer-letter]";
		await until(`document.querySelector(${JSON.stringify(letterRow)})?.textContent.includes('来自') === true`, "第二个对话里有「来自 …」那一行");
		if (!(await page<string>(`document.querySelector(${JSON.stringify(letterRow)}).textContent`)).includes(ANSWER))
			throw new Error("来信那一行的摘要不是回话的开头");
		if (
			await page<boolean>(`[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].some(e => e.textContent.includes('session-message'))`)
		)
			throw new Error("信画成了人的气泡");
		const sent = letters.find((letter) => !letter.exec)?.all;
		if (!sent?.includes("不是用户说的话") || !sent.includes(QUESTION)) throw new Error("送给第一个对话的信不对");
		if (!letters.some((letter) => letter.exec && letter.all.includes(ANSWER))) throw new Error("送回第二个对话的回话不对");
		// 第二个对话发的那条：对方回了话，回执是「已回复」。
		await until(`document.querySelector('[data-screen=chat] [data-peer-receipt]')?.dataset.peerReceipt === 'replied'`, "发出的那条标「已回复」");
		await clickVisibleIn(page, `[document.querySelector(${JSON.stringify(letterRow)})?.querySelector('[data-flow-row], button')]`, "来信那一行");
		await capture("smoke-peers-answer.png");

		// 第二个对话里来信那一行的箭头跳到第一个对话：那边有「来自 …」那一行和它回的那句，它发的那条是「已送达」。
		await clickVisible(page, `[data-peer-open]`);
		await until(chatHas(REPLIED), "箭头跳到第一个对话");
		await until(`document.querySelector(${JSON.stringify(letterRow)})?.textContent.includes('来自') === true`, "第一个对话里有「来自 …」那一行");
		if (!(await page<string>(`document.querySelector(${JSON.stringify(letterRow)}).textContent`)).includes(QUESTION))
			throw new Error("来信那一行的摘要不是问题");
		await until(`document.querySelector('[data-screen=chat] [data-peer-receipt]')?.dataset.peerReceipt === 'delivered'`, "回的那条标「已送达」");
		await capture("smoke-peers-request.png");
		// 点发出的那一行跳到对方。
		await clickVisibleIn(
			page,
			`[document.querySelector('[data-screen=chat] [data-peer-receipt] [data-flow-row], [data-screen=chat] [data-peer-receipt] button')]`,
			"发出的那一行",
		);
		await until(chatHas(GOT), "点发出的那一行跳回第二个对话");
		if (!(await agent.sessions()).some((item) => item.id === execId)) throw new Error("第二个对话不见了");
	} finally {
		setModel(undefined);
	}
}
