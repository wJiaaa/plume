import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";

/**
 * 真实的鼠标点击：消息操作只接受用户真按下的那一下（脚本的 `element.click()` 不算），这里经 `sendInputEvent` 按在元素中间。
 * 取同一选择器的最后一个，先滚进视口、先悬停（悬停才显出的按钮）。
 */
export async function nativeClick(window: BrowserWindow, page: (code: string) => Promise<unknown>, selector: string): Promise<void> {
	const point = (await page(`(() => {
		const element = [...document.querySelectorAll(${JSON.stringify(selector)})].at(-1);
		if (!element) return null;
		element.scrollIntoView({ block: 'center' });
		const rect = element.getBoundingClientRect();
		return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
	})()`)) as { x: number; y: number } | null;
	if (!point) throw new Error(`找不到 ${selector}`);
	window.webContents.sendInputEvent({ type: "mouseMove", ...point });
	await new Promise((resolve) => setTimeout(resolve, 120));
	window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
	window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}

/** 真实的回车：同上，编辑框只认用户按下的键。 */
export function nativeEnter(window: BrowserWindow): void {
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
	window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
}

/**
 * 消息底下那排的分叉、编辑重发、撤回，经真界面走一遍：从最后那条回复分叉出一个新会话（原会话不动），在分叉里问一句，
 * 改掉它重发（转录里换成新问的和新答的），再撤回它（转录空回到分叉时的样子，那句话回到输入框）。再把它发出去、写到一半按停，
 * 经「已暂停」那一行的「重试」确认后原样重问；最后发一句请求被放弃的，那一行不出现。最后回到原会话。
 */
export async function checkMessageEdits(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
	/** 原会话：最后回到它，后面的步骤接着用。 */
	sessionId: string;
	/** 原会话最后那条回复里的字：认得出是不是回到了原会话。 */
	finalText: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel, sessionId, finalText } = options;
	const chat = "[data-screen=chat]";
	const userCount = `document.querySelectorAll('${chat} [data-plume-quote=user]').length`;
	// 输入框里的字，不算占位提示（它也画在 `.cm-content` 里）。
	const composerText = `[...document.querySelectorAll('.cm-content .cm-line')].map((line) => { const copy = line.cloneNode(true); copy.querySelectorAll('.cm-placeholder').forEach((node) => node.remove()); return copy.textContent; }).join('\\n')`;
	setModel((request) => {
		const sent = JSON.stringify(request.messages);
		return { text: sent.includes("改过的问题") ? "改过以后的回答" : "分叉里的回答" };
	});
	try {
		const before = (await page(userCount)) as number;
		// 分叉按钮只在悬停时显出来，点击不受透明度影响；取最后那条回复底下的那颗。
		await nativeClick(window, page, `${chat} [data-plume-quote=assistant] [data-message-fork]`);
		await until(
			`document.querySelector('[data-plume-screen-title]')?.textContent.endsWith('（分叉）') && document.querySelector('${chat}')?.textContent.includes(${JSON.stringify(finalText)})`,
			"分叉出的会话打开，带着那条回复",
		);
		if ((await page(userCount)) !== before) throw new Error("从回复分叉的会话应该带着那条回复之前的全部问题");
		const left = (await page(composerText)) as string;
		if (left.trim()) throw new Error(`从回复分叉，输入框应该是空的，实际是 ${JSON.stringify(left)}`);

		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("原来的问题");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "分叉里可以发送");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('${chat}')?.textContent.includes('分叉里的回答')`, "分叉里问的一句有了回答");

		// 编辑最后一条：气泡换成编辑框，改完回车重发。
		await nativeClick(window, page, `${chat} [data-message-edit]`);
		await until(`document.querySelector('${chat} textarea') !== null`, "编辑框出现");
		const box = `${chat} textarea`;
		await page(`(() => {
			const box = document.querySelector('${box}');
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, '改过的问题');
			box.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
		await capture(window, join(outDir, "smoke-message-edit.png"));
		await page(`document.querySelector('${box}').focus()`);
		nativeEnter(window);
		await until(
			`document.querySelector('${chat}')?.textContent.includes('改过以后的回答') && !document.querySelector('${chat}').textContent.includes('原来的问题') && !document.querySelector('${chat}').textContent.includes('分叉里的回答')`,
			"编辑重发换掉了原来的问和答",
		);

		// 撤回最后一条：不用确认，转录回到分叉时的样子，那句话回到输入框。
		await nativeClick(window, page, `${chat} [data-message-undo]`);
		await until(
			`!document.querySelector('${chat}')?.textContent.includes('改过以后的回答') && ${composerText} === '改过的问题'`,
			"撤回截掉了那一轮，问题回到输入框",
		);
		if ((await page(userCount)) !== before) throw new Error("撤回以后应该只剩分叉时带着的那些问题");
		await capture(window, join(outDir, "smoke-message-revert.png"));

		// 重试：把退回输入框的那句发出去，写到一半按停；转录底下「已暂停」那一行的「重试」确认后原样重问，写到一半的回复被换掉。
		let attempt = 0;
		setModel(() => (attempt++ === 0 ? { text: "写到一半的回答", hang: true } : { text: "重答的回答" }));
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "退回的问题可以再发");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('${chat}')?.textContent.includes('写到一半的回答')`, "回复写到一半");
		await nativeClick(window, page, "[data-composer-send=stop]");
		await until(`document.querySelector('${chat} [data-resume=user] [data-resume-retry]') !== null`, "按停以后「已暂停」旁边有重试");
		await click(`${chat} [data-resume-retry]`);
		await until(`document.querySelector('[role=dialog]')?.textContent.includes('重新生成这次回答')`, "重试先确认");
		await capture(window, join(outDir, "smoke-message-retry.png"));
		await click("[role=dialog] button", "重新生成");
		// 只看「已暂停」那一行撤下：跟在前面各段后面跑时，分叉带着一份没做完的清单，底下照常留着「计划还有 1 项未完成」。
		await until(
			`document.querySelector('[role=dialog]') === null && document.querySelector('${chat}')?.textContent.includes('重答的回答') && !document.querySelector('${chat}').textContent.includes('写到一半的回答') && !document.querySelector('${chat} [data-resume=user]')`,
			"重试换掉了写到一半的回复",
		);
		if ((await page(userCount)) !== before + 1) throw new Error("重试是原样重问，不应该多出一条问题");

		// 放弃了的请求：失败已经由连接记录讲完，「已暂停 · 继续 · 重试」那一行不出现。
		setModel(() => ({ status: 401 }));
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("会失败的问题");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "失败的问题可以发送");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('${chat} [data-hiccup=gave_up]') !== null && document.querySelector('[data-composer-send=send]') !== null`, "请求放弃");
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (await page(`document.querySelector('${chat} [data-resume-retry]') !== null`)) throw new Error("已有放弃记录时不应该出现重试");
	} finally {
		setModel(undefined);
	}
	window.webContents.send("plume:command", `open-session:${sessionId}`);
	await until(
		`!document.querySelector('[data-plume-screen-title]')?.textContent.endsWith('（分叉）') && document.querySelector('${chat}')?.textContent.includes(${JSON.stringify(finalText)})`,
		"回到原会话",
	);
}
