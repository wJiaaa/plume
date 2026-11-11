import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";
import { nativeClick, nativeEnter } from "./smoke-message-edits.ts";

/**
 * 排队条的「更多」菜单经真界面走一遍：主会话正忙（假模型挂着不收尾）时回车，话落进排队条；装着侧边聊天时这一行是
 * 「更多」菜单，里面有「编辑」和插件加的「在侧边聊天中打开」。点后者：这一行收走，侧边聊天面板里问这句话、回答画在那里，
 * 主对话里不留。接着在侧边聊天里编辑重问那一句：只有「编辑并重新提问」、没有撤回和分叉，重问照样附上主会话的内容
 * （读到哪里随截掉的那一问退回去）。再让侧边聊天把一件事交给忙着的主会话，看回执条：排着时撤回、那句话回到侧边聊天的输入框；
 * 再交一次，主会话停下后照旧排着，「立即执行」让主会话为它跑一轮，再停下它记成随主会话停下，最后移除；假模型交还。
 */
export async function checkQueueActions(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel } = options;
	const chat = "[data-screen=chat]";
	const side = `[data-panel="plume.side-chat/chat"]:not([inert])`;
	const question = "排着的这句拿去侧边聊天问";
	const answer = "侧边聊天答了排着的那句。";
	const reasked = "改过的问题";
	const reaskAnswer = "侧边聊天答了改过的那句。";
	const task = "把 README 的错字改掉";
	let reaskSawMain = false;
	setModel((request) => {
		if (!((request.tools ?? []) as Array<{ name: string }>).some((tool) => tool.name === "read_main_chat")) return { text: "我先想想。", hang: true };
		// 这一轮的输入：最后一条回复之后的那几条（人的话、附上的主会话内容、工具结果）。
		const messages = request.messages as Array<{ role: string }>;
		const turn = JSON.stringify(messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1));
		if (turn.includes("tool_result")) return { text: "交过去了。" };
		if (turn.includes("错字")) return { toolCalls: [{ id: `dispatch-${Date.now()}`, name: "dispatch_task", args: { instruction: task, user_asked: true } }] };
		if (turn.includes(reasked)) {
			reaskSawMain = turn.includes("先慢慢想");
			return { text: reaskAnswer };
		}
		return { text: answer };
	});
	try {
		await page(`document.querySelector('${chat} .cm-content').focus()`);
		await window.webContents.insertText("先慢慢想");
		await until(`document.querySelector('${chat} [data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		await click(`${chat} [data-composer-send=send]`);
		await until(`document.querySelector('${chat} [data-composer-send=stop]') !== null`, "主会话在跑");

		await page(`document.querySelector('${chat} .cm-content').focus()`);
		await window.webContents.insertText(question);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
		await until(`document.querySelector('[data-queue-row]')?.textContent.includes(${JSON.stringify(question)})`, "忙时回车落进排队条");
		if (await page(`document.querySelector('[data-queue-row] [data-queue-edit]') !== null`))
			throw new Error("装着侧边聊天时排队行应该是「更多」菜单，不是编辑按钮");
		await click("[data-queue-row] [data-queue-more]");
		await until(
			`(() => { const items = [...document.querySelectorAll('[aria-label="更多"][data-plume-popover] [role=menuitem]')].map((item) => item.textContent.trim()); return items[0] === '编辑消息' && items.includes('在侧边聊天中打开'); })()`,
			"「更多」菜单里是编辑和在侧边聊天中打开",
		);
		await capture(window, join(outDir, "smoke-queue-more.png"));
		await click('[aria-label="更多"][data-plume-popover] [role=menuitem]', "在侧边聊天中打开");
		await until(`document.querySelector('[data-queue-row]:not([data-leaving])') === null`, "这一行从排队条收走");
		await until(
			`document.querySelector('${side} [data-child-conversation]')?.textContent.includes(${JSON.stringify(answer)})`,
			"排着的那句在侧边聊天里问，回答画在那里",
		);
		if (
			await page(
				`[...document.querySelectorAll('[data-plume-transcript-rows]')].some((rows) => !rows.closest('[data-child-conversation]') && rows.textContent.includes(${JSON.stringify(question)}))`,
			)
		)
			throw new Error("拿去侧边聊天问的话不该进主对话");
		await capture(window, join(outDir, "smoke-queue-side-chat.png"));

		// 侧边聊天里只有编辑重问：按钮在最后那句底下，编辑框的确认叫「重新提问」。
		if (await page(`document.querySelector('${side} [data-message-undo], ${side} [data-message-fork]') !== null`))
			throw new Error("侧边聊天里不该有撤回和分叉");
		await nativeClick(window, page, `${side} [data-message-edit]`);
		await until(`document.querySelector('${side} textarea') !== null`, "侧边聊天的编辑框出现");
		if (!(await page(`document.querySelector('${side} button[data-plume-tip="重新提问"]') !== null`)))
			throw new Error("侧边聊天编辑框的确认应该叫「重新提问」");
		await page(`(() => {
			const box = document.querySelector('${side} textarea');
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(reasked)});
			box.dispatchEvent(new Event('input', { bubbles: true }));
			box.focus();
		})()`);
		nativeEnter(window);
		await until(
			`(() => { const text = document.querySelector('${side} [data-child-conversation]')?.textContent ?? ''; return text.includes(${JSON.stringify(reaskAnswer)}) && !text.includes(${JSON.stringify(answer)}); })()`,
			"编辑重问换掉了侧边聊天原来的问和答",
		);
		if (!reaskSawMain) throw new Error("编辑重问没有再附上主会话的内容");

		// 回执条：主会话忙着，侧边聊天交过去的排着；撤回，那句话回到侧边聊天的输入框。
		const row = (status: string) => `document.querySelector('${side} [data-task-strip] [data-task=${status}]')?.textContent.includes(${JSON.stringify(task)})`;
		await page(`document.querySelector('${side} .cm-content').focus()`);
		await window.webContents.insertText("交给主会话：改错字");
		await until(`document.querySelector('${side} [data-composer-send=send]')?.disabled === false`, "侧边聊天可以发送");
		await click(`${side} [data-composer-send=send]`);
		await until(row("queued"), "交给忙着的主会话，回执条上排着");
		await capture(window, join(outDir, "smoke-task-strip.png"));
		await click(`${side} [data-task-withdraw]`);
		await until(
			`document.querySelector('${side} [data-task]') === null && document.querySelector('${side} .cm-content')?.textContent.includes(${JSON.stringify(task)})`,
			"撤回：这一行没了，那句话回到侧边聊天的输入框",
		);
		// 收回的那句原样再发，又交过去；主会话停下以后照旧排着。
		await until(`document.querySelector('${side} [data-composer-send=send]')?.disabled === false`, "收回的那句可以再发");
		await click(`${side} [data-composer-send=send]`);
		await until(row("queued"), "再交一次，又排上了");
		await click(`${chat} [data-composer-send=stop]`);
		await until(`document.querySelector('${chat} [data-composer-send=send]') !== null`, "主会话停下");
		if (!(await page(row("queued")))) throw new Error("主会话停下，排着的应该照旧排着");
		await click(`${side} [data-task-run-now]`);
		await until(row("running"), "立即执行：主会话为它跑起来");
		await until(
			`[...document.querySelectorAll('${chat} [data-from-child]')].some((node) => node.textContent.includes("来自侧边聊天"))`,
			"主会话里交来的那句标着插件的显示名",
		);
		await click(`${chat} [data-composer-send=stop]`);
		await until(row("cancelled") + ` && document.querySelector('${side} [data-task-retry]') !== null`, "主会话停下，这件记成随它停下、能继续");
		await capture(window, join(outDir, "smoke-task-strip-stopped.png"));
		await click(`${side} [data-task-dismiss]`);
		await until(`document.querySelector('${side} [data-task]') === null`, "移除以后回执条没了");
	} finally {
		setModel(undefined);
	}
}
