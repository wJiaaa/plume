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

const ORIGIN = "冒烟：开个会话去删旧的解析代码";
const TASK = "把旧的解析代码删掉";
const SPAWNED = "开出去了，等它的汇报。";
const FIRST = "删掉了 a.ts，还剩 b.ts。";
const GOT_FIRST = "收到第一份汇报。";
const ASK = "冒烟：问问它还剩什么";
const LEFT_QUESTION = "还剩什么没做？";
const ASKED_CHILD = "问过了，答案会随它的汇报回来。";
const LEFT = "只剩 b.ts 的测试没改。";
const GOT_LEFT = "收到答复：只剩 b.ts 的测试。";
const BACKGROUND =
	"我们在把命令行的参数解析换成新的库，这是这次重构的第一步，后面还要换配置文件的读法；对外的命令名和参数名都不改，用户的脚本不用跟着动。旧的解析代码要删干净，不留兼容分支，相关的测试跟着改到新库上。别的会话在改文档，docs 目录这里不要碰。";

/**
 * 会话之间互发消息（市场插件 plume.sessions）：先装上它。开两个对话，第二个让假模型用 `send_message` 发给第一个；第一个闲着，
 * 为这封信开一轮，假模型同样用 `send_message` 回一条；回话送进第二个、叫起它一轮。消息是单向的，两边对话里各有一行「来自 …」，
 * 不画成人的气泡；点开读全文，旁边的箭头跳到对方会话。发的那一行标着回执：第二个对话那条收到回话后是「已回复」，
 * 第一个对话那条是「已送达」；点了那一行跳到对方。
 *
 * 然后是开出来、每轮交回来处的会话（`spawn_session` 开的，`spawnedFrom.reportBack`）：来处问它一句，它在那一轮里想回寄来处被退回，
 * 改把答案写在收尾回复里；来处只收到一份（交回的汇报，没有信），只为它被叫起一次，问的那一行照样标「已回复」。
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
		await clickVisible(page, `${letterRow} [data-peer-open]`);
		await until(chatHas(REPLIED), "箭头跳到第一个对话");
		await until(`document.querySelector(${JSON.stringify(letterRow)})?.textContent.includes('来自') === true`, "第一个对话里有「来自 …」那一行");
		if (!(await page<string>(`document.querySelector(${JSON.stringify(letterRow)}).textContent`)).includes(QUESTION))
			throw new Error("来信那一行的摘要不是问题");
		await until(`document.querySelector('[data-screen=chat] [data-peer-receipt]')?.dataset.peerReceipt === 'delivered'`, "回的那条标「已送达」");
		await capture("smoke-peers-request.png");
		// 点发出的那一行展开显示发出去的内容、不跳转；点旁边的箭头跳回第二个对话。
		const sentRow = "[data-screen=chat] [data-peer-receipt]";
		await clickVisibleIn(page, `[document.querySelector('${sentRow} [data-flow-row], ${sentRow} button')]`, "发出的那一行");
		await until(
			`document.querySelector(${JSON.stringify(sentRow)})?.textContent.includes(${JSON.stringify(ANSWER)}) === true && ${chatHas(REPLIED)}`,
			"发出的那一行点开显示内容且留在当前对话",
		);
		await capture("smoke-peers-sent-open.png");
		await clickVisible(page, `${sentRow} [data-peer-open]`);
		await until(chatHas(GOT), "点发出的那一行旁边的箭头跳回第二个对话");
		if (!(await agent.sessions()).some((item) => item.id === execId)) throw new Error("第二个对话不见了");
	} finally {
		setModel(undefined);
	}

	// 见文件头第二段：来处问每轮交回它的会话，只收到一份答复。
	let originId = "";
	let childId = "";
	/** 来处在答复到了以后被叫起的次数；开出来的会话回寄被退回后那次请求；来处最后一次请求。 */
	let answered = 0;
	let refused = "";
	let originSeen = "";
	setModel((request) => {
		const all = JSON.stringify(request.messages ?? []);
		const opening = JSON.stringify((request.messages as unknown[] | undefined)?.[0] ?? null);
		// 先认开出来的会话：它的第一句里可能带着来处的话。
		if (opening.includes(TASK)) {
			// 来处的信叫起的那一轮先试着回寄（会被退回），读到退回的话后把答案写进收尾回复。
			if (all.includes("toolu_rep_back")) {
				refused = all;
				return { text: LEFT };
			}
			if (all.includes("<session-message")) return { toolCalls: [{ id: "toolu_rep_back", name: "send_message", args: { to: ref(originId), message: LEFT } }] };
			return { text: FIRST };
		}
		if (!opening.includes(ORIGIN)) return { text: "好" };
		originSeen = all;
		if (all.includes(LEFT)) {
			answered++;
			return { text: GOT_LEFT };
		}
		if (all.includes("toolu_rep_ask")) return { text: ASKED_CHILD };
		if (all.includes(ASK)) return { toolCalls: [{ id: "toolu_rep_ask", name: "send_message", args: { to: ref(childId), message: LEFT_QUESTION } }] };
		if (all.includes("<session-report")) return { text: GOT_FIRST };
		if (all.includes("toolu_rep_spawn")) return { text: SPAWNED };
		return {
			toolCalls: [
				{
					id: "toolu_rep_spawn",
					name: "spawn_session",
					args: { initiation: "user_asked", title: "删旧解析", name: "parser", prompt: TASK, background: BACKGROUND },
				},
			],
		};
	});
	try {
		originId = await open(ORIGIN);
		await wait(async () => {
			childId = (await agent.sessions()).find((item) => item.spawnedFrom?.sessionId === originId)?.id ?? "";
			return childId !== "";
		}, "来处开出一个会话").catch((error: unknown) => {
			throw new Error(`${error instanceof Error ? error.message : String(error)}；来处最后读到：${originSeen.slice(-800)}`);
		});
		await until(chatHas(GOT_FIRST), "第一轮的汇报交回来处、叫起它");
		// 人在来处接着问一句，来处寄信问开出来的会话。
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(ASK);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await clickVisible(page, `[data-composer-send=send]`);
		await until(chatHas(GOT_LEFT), "答复随交回送到、叫起来处");
		// 再等一阵：不该再有第二份（回寄的信）叫起来处。
		await page(`new Promise(resolve => setTimeout(resolve, 2500))`);
		if (answered !== 1) throw new Error(`来处为答复被叫起了 ${answered} 次，应该是 1 次`);
		if (!refused.includes("final reply")) throw new Error("开出来的会话回寄来处没被退回");
		if (originSeen.includes("<session-message")) throw new Error("来处收到了回寄的信");
		if (originSeen.split("<session-report").length - 1 !== 2) throw new Error("来处收到的汇报不是两份（第一轮、答复那一轮）");
		await until(`document.querySelector('[data-screen=chat] [data-peer-receipt]')?.dataset.peerReceipt === 'replied'`, "问的那一行标「已回复」");
		await clickVisibleIn(
			page,
			`[document.querySelector('[data-screen=chat] [data-delivery-row][data-delivery-session] button[aria-expanded]')]`,
			"来自关联会话那一行",
		);
		await until(
			`document.querySelector('[data-screen=chat] [data-delivery-row][data-delivery-session]')?.textContent.includes(${JSON.stringify(FIRST)}) === true`,
			"点开来自关联会话一行显示汇报内容",
		);
		await clickVisibleIn(page, `[document.querySelector('[data-screen=chat] [data-peer-receipt] button[aria-expanded]')]`, "发消息给那一行");
		await until(
			`document.querySelector('[data-screen=chat] [data-peer-receipt]')?.textContent.includes(${JSON.stringify(LEFT_QUESTION)}) === true`,
			"点开发消息给一行显示发出的内容",
		);
		await capture("smoke-peers-reported.png");
	} finally {
		setModel(undefined);
	}
}
