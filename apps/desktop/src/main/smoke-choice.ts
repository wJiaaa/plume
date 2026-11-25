import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";
import { clickReal } from "./smoke-kit.ts";

/** 一条带选择卡的回复。 */
function reply(question: string, options: { label: string; send: string; recommended?: boolean }[]): { text: string } {
	const card = { summary: "两条路都查过了，改动范围已经确认；还没有动任何文件。", question, options };
	return { text: `两条路的差别写在上面。\n\n\x60\x60\x60choices\n${JSON.stringify(card)}\n\x60\x60\x60` };
}

const FIRST = "这次走哪一条？";
const SECOND = "先改哪个文件？";
const THIRD = "要不要补测试？";
const SEND = "用方案 A，只改调用处。";

/**
 * 内置插件 plume.ask-user 的选择卡，经真界面走一遍：新对话里假模型在回复末尾写一个 `choices` 围栏，画成卡片，深浅色各截一张；
 * 脚本点的发不出去，真点一项就当人的消息发出去，卡片只剩说明、问题、答案。再来一张点右上角关闭：卡片拿掉、什么都没发，切走再回来
 * 还关着。第三张直接打字回答：卡片拿掉。最后回到原会话。
 */
export async function checkChoice(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
	/** 最近活动的会话，就是这里开的那个。 */
	latestSession: () => Promise<string>;
	/** 原会话：最后回到它，后面的步骤接着用。 */
	sessionId: string;
	finalText: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel, latestSession, sessionId, finalText } = options;
	const chat = "[data-screen=chat]";
	const open = `${chat} [data-choice-card=open]`;
	const answered = `${chat} [data-choice-card=answered]`;
	const opened = (question: string) =>
		`document.querySelector('${open}')?.textContent.includes('${question}') && document.querySelector('${open} [data-choice-option]')?.disabled === false`;
	const bubbles = () => page(`document.querySelectorAll('${chat} [data-plume-quote=user]').length`);
	const say = async (words: string) => {
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(words);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, `「${words}」可以发送`);
		await click("[data-composer-send=send]");
	};
	const back = async (id: string, words: string) => {
		window.webContents.send("plume:command", `open-session:${id}`);
		await until(`document.querySelector('${chat}')?.textContent.includes(${JSON.stringify(words)})`, `回到有「${words}」的会话`);
	};
	let taught = false;
	setModel((request) => {
		// 标题这类不带工具的小调用不出卡。
		if (!((request.tools as unknown[] | undefined) ?? []).length) return { text: "选择卡" };
		taught ||= JSON.stringify(request.system).includes("Choice card:");
		const talk = JSON.stringify(request.messages);
		if (talk.includes("都不要，先放着")) return { text: "好，先放着。" };
		if (talk.includes("再给我一次选择"))
			return reply(THIRD, [
				{ label: "补上", send: "补上测试。" },
				{ label: "不补", send: "不补测试。" },
			]);
		if (talk.includes(SEND))
			return reply(SECOND, [
				{ label: "hello.txt", send: "先改 hello.txt。" },
				{ label: "child.txt", send: "先改 child.txt。" },
			]);
		return reply(FIRST, [
			{ label: "方案 B", send: "用方案 B，改解析器。", recommended: true },
			{ label: "方案 A", send: SEND },
			{ label: "先写一份名字很长、长到一行放不下、要在按钮里面自己折行的对比说明再决定走哪一条路", send: "先写对比。" },
		]);
	});
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "选择卡前回到空白页");
		await say("给我两个方案");
		await until(opened(FIRST), "回复末尾画出选择卡，按钮可点");
		if (!taught) throw new Error("系统提示词里应该有选择卡的用法");
		const box = (await page(`(() => {
			const card = document.querySelector('${open}').getBoundingClientRect();
			const inside = [...document.querySelectorAll('${open} button')].every((button) => {
				const r = button.getBoundingClientRect();
				return r.left >= card.left && r.right <= card.right && r.top >= card.top && r.bottom <= card.bottom;
			});
			return { width: card.width, inside, source: document.querySelector('${chat}').textContent.includes('"options"') };
		})()`)) as { width: number; inside: boolean; source: boolean };
		if (box.width > 480 || !box.inside || box.source) throw new Error(`选择卡不该超过 480px、按钮不该顶出去、不该露出源码：${JSON.stringify(box)}`);
		await capture(window, join(outDir, "smoke-choice.png"));
		await page(`window.plume.saveAppearance({ theme: 'dark' })`);
		await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "选择卡切到深色");
		await delay(300);
		await capture(window, join(outDir, "smoke-choice-dark.png"));
		await page(`window.plume.saveAppearance({ theme: 'light' })`);
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "选择卡回到浅色");

		// 程序触发的点击不算人话：不发，卡上说没发出去，还能再选。
		await page(`document.querySelectorAll('${open} [data-choice-option]')[1].click()`);
		await until(`document.querySelector('${open} [role=alert]') !== null`, "程序点击发不出去，卡上说明");
		if ((await bubbles()) !== 1) throw new Error("程序点击不该发出消息");

		await page(`document.querySelectorAll('${open} [data-choice-option]')[1].setAttribute('data-smoke-choice', '')`);
		await clickReal(window, "[data-smoke-choice]", "选择卡的「方案 A」");
		await until(
			`[...document.querySelectorAll('${chat} [data-plume-quote=user]')].some((bubble) => bubble.textContent.includes(${JSON.stringify(SEND)}))`,
			"选的那一项当人的消息发出去",
		);
		await until(opened(SECOND), "模型收到选择，接着给第二张卡");
		const done = (await page(`(() => {
			const card = document.querySelector('${answered}');
			return { answer: card?.querySelector('[data-choice-answer]')?.textContent, buttons: card?.querySelectorAll('button').length, text: card?.textContent };
		})()`)) as { answer?: string; buttons?: number; text?: string };
		if (done.answer !== "方案 A" || done.buttons !== 0 || !done.text?.includes(FIRST)) throw new Error(`选完应该只剩说明、问题和答案：${JSON.stringify(done)}`);

		// 关闭：拿掉这张卡，什么都不发；切走再回来还关着。
		await delay(300);
		await capture(window, join(outDir, "smoke-choice-answered.png"));
		await clickReal(window, `${open} [data-choice-close]`, "选择卡的关闭");
		await until(`document.querySelector('${open}') === null`, "关闭后卡片拿掉");
		if ((await bubbles()) !== 2) throw new Error("关闭选择卡不该发消息");
		const current = await latestSession();
		await back(sessionId, finalText);
		await back(current, SEND);
		await until(`document.querySelector('${answered}') !== null`, "切回来，选过的还是选过的样子");
		if ((await page(`document.querySelector('${open}') !== null`)) === true) throw new Error("切回来，关掉的卡不该再出现");

		await say("再给我一次选择");
		await until(opened(THIRD), "第三张卡");
		await say("都不要，先放着");
		await until(
			`document.querySelector('${chat}')?.textContent.includes('好，先放着。') && document.querySelector('${open}') === null`,
			"直接打字回答，卡片拿掉",
		);
		if ((await page(`document.querySelectorAll('${chat} [data-choice-card]').length`)) !== 1) throw new Error("没采用的卡应该都拿掉，只留选过的那张");
	} finally {
		setModel(undefined);
	}
	await back(sessionId, finalText);
}
