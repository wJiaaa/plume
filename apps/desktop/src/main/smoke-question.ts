import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";

/**
 * 内置插件 plume.ask-user 的提问卡，经真界面走一遍：新对话里让假模型调 `ask_user`，卡片压在输入框上方，标题、说明、推荐、
 * 倒计时、「跳过将采用」都在；深浅色各截一张，按数字键选第二项、确认，模型拿到的结果就是那一项。最后回到原会话。
 */
/** 请求里这次调用的结果的文字；还没有结果时是 undefined。计划模式那段（`smoke-plan.ts`）也用它。 */
export function toolResult(request: Record<string, unknown>, id: string): string | undefined {
	for (const message of (request.messages as { content?: unknown }[] | undefined) ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
			if (block.type !== "tool_result" || block.tool_use_id !== id) continue;
			if (typeof block.content === "string") return block.content;
			return ((block.content as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("");
		}
	}
	return undefined;
}

export async function checkQuestion(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
	/** 原会话：最后回到它，后面的步骤接着用。 */
	sessionId: string;
	finalText: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel, sessionId, finalText } = options;
	const chat = "[data-screen=chat]";
	const card = "[data-approval-card]";
	let answered = "";
	setModel((request) => {
		const result = toolResult(request, "toolu_ask");
		if (result !== undefined) {
			answered = result;
			return { text: "按你选的来。" };
		}
		// 标题这类不带工具的小调用不问。
		const tools = (request.tools as { name?: string }[] | undefined) ?? [];
		if (!tools.some((tool) => tool.name === "ask_user")) return { text: "提问" };
		return {
			toolCalls: [
				{
					id: "toolu_ask",
					name: "ask_user",
					args: {
						question: "改之前要不要先备份 hello.txt？",
						options: [
							{ label: "先备份", description: "复制一份 hello.txt.bak 再改" },
							{ label: "直接改", description: "工作区有 git，改错了能找回", recommended: true },
						],
						defaultOptionIndex: 1,
					},
				},
			],
		};
	});
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "提问前回到空白页");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("问我一个问题再动手");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "提问的那句可以发送");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('${card} [data-ask-form]') !== null`, "提问卡压在输入框上方");
		const text = (await page(`document.querySelector('${card}').textContent`)) as string;
		for (const piece of ["需要你的意见", "改之前要不要先备份 hello.txt？", "推荐", "后失效", "跳过将采用：直接改"])
			if (!text.includes(piece)) throw new Error(`提问卡里应该有「${piece}」，实际是 ${text}`);
		if ((await page(`document.querySelector('${card} [data-ask-custom]')?.placeholder`)) !== "说说你的想法") throw new Error("「其他」一行的输入框占位不对");
		// 默认项先选上；运行行说在等回答，不是等批准。
		if ((await page(`document.querySelectorAll('${card} [data-ask-option][data-on]').length`)) !== 1) throw new Error("默认项应该先选上");
		await until(`document.querySelector('[data-plume-waiting=answer]') !== null`, "运行行说在等你的回答");
		await capture(window, join(outDir, "smoke-question.png"));
		await page(`window.plume.saveAppearance({ theme: 'dark' })`);
		await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "提问卡切到深色");
		// 选项行、按钮的底色换主题时有过渡，等它走完再截，不然截到半浅半深的一帧。
		await delay(300);
		await capture(window, join(outDir, "smoke-question-dark.png"));
		await page(`window.plume.saveAppearance({ theme: 'light' })`);
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "提问卡回到浅色");

		// 1 选第一项，回车交出去。
		await page(`document.querySelector('${card} [data-ask-form]').dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }))`);
		await until(`document.querySelector('${card} [data-ask-option][data-on]')?.textContent.includes('先备份')`, "数字键选中第一项");
		await click(`${card} [data-ask-action=submit]`);
		await until(
			`document.querySelector('${chat}')?.textContent.includes('按你选的来。') && document.querySelector('${card}') === null`,
			"答完卡片收走，模型接着说",
		);
		if (answered !== "先备份") throw new Error(`模型拿到的回答应该是「先备份」，实际是 ${JSON.stringify(answered)}`);
	} finally {
		setModel(undefined);
	}
	window.webContents.send("plume:command", `open-session:${sessionId}`);
	await until(`document.querySelector('${chat}')?.textContent.includes(${JSON.stringify(finalText)})`, "提问以后回到原会话");
}
