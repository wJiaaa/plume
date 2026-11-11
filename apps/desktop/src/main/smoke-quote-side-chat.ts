import assert from "node:assert/strict";
import { join } from "node:path";
import type { Remote } from "@plume/rpc";
import { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import type { ModelOverride } from "./smoke-browser.ts";
import { windowClosed } from "./smoke-panels.ts";

/** 专项入口只准备主会话、一个其他面板和侧聊，复用完整冒烟的同一组断言。 */
export async function prepareQuoteSideChat(
	options: Parameters<typeof checkQuoteSideChat>[0] & {
		agent: Remote<AgentProcessApi>;
		plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	},
): Promise<void> {
	const { window, agent, plugin, page, until, click, setModel } = options;
	if (!plugin.cli) throw new Error("没有插件安装命令");
	await plugin.install("side-chat");
	const end = Date.now() + 15_000;
	while (!(await agent.plugins()).some((item) => item.name === "plume.side-chat" && item.state === "active")) {
		if (Date.now() > end) throw new Error("侧边聊天插件未加载");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	setModel((request) => ({
		text: (request.tools as Array<{ name: string }> | undefined)?.some((tool) => tool.name === "read_main_chat")
			? "划词侧边聊天准备好了。"
			: "划词主会话准备好了。",
	}));
	await click('[data-plume-section-action] button[aria-label="新建项目"]');
	await click("[data-plume-add-folder]");
	await until("document.querySelector('[data-plume-source-folder]') !== null", "划词专项选择目录");
	await click("button", "创建项目");
	await until("document.querySelector('[data-screen=empty] h1')?.textContent.includes('workspace')", "划词专项项目就绪");
	await click("[data-model-trigger]");
	await click("button", "fake-model");
	await page("document.querySelector('.cm-content').focus()");
	await window.webContents.insertText("为划词提问准备主会话");
	await until("document.querySelector('[data-composer-send=send]')?.disabled === false", "主会话可发送");
	await click("[data-composer-send=send]");
	await until(
		"document.querySelector('[data-screen=chat]')?.textContent.includes('划词主会话准备好了。') && document.querySelector('[data-composer-send=stop]') === null",
		"主会话准备好",
	);
	await click('button[aria-label="打开面板"]');
	await until("document.querySelector('[data-panel-launch=\"plume.diagnostics/tasks\"]') !== null", "任务面板入口就绪");
	await click('[data-panel-launch="plume.diagnostics/tasks"]');
	await page("document.querySelector('[data-screen=chat] .cm-content').focus()");
	await window.webContents.insertText("/btw 准备一个侧边聊天");
	await click("[data-screen=chat] [data-composer-send=send]");
	await until("document.querySelector('[data-panel=\"plume.side-chat/chat\"]:not([inert])')?.textContent.includes('划词侧边聊天准备好了。')", "侧聊准备好");
	await until("document.querySelector('[data-panel=\"plume.side-chat/chat\"]:not([inert]) [data-composer-send=stop]') === null", "侧聊已结束");
}

/** 选区只交给侧聊草稿：复用前台标签，保留附件、来源和旧草稿，搬窗后再由人发送。 */
export async function checkQuoteSideChat(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel } = options;
	const side = '[data-panel="plume.side-chat/chat"]:not([inert])';
	const tab = (await page(
		`document.querySelector('[data-panel-tab="plume.side-chat/chat"] [role=tab][aria-selected=true]').closest('[data-panel-tab-id]').dataset.panelTabId`,
	)) as string;
	const countTabs = `document.querySelectorAll('[data-panel-tab="plume.side-chat/chat"]').length`;
	const activeSideTab = `document.querySelector('[data-panel-tab="plume.side-chat/chat"] [role=tab][aria-selected=true]')?.closest('[data-panel-tab-id]').dataset.panelTabId`;
	const tabs = await page(countTabs);
	const draft = `JSON.parse(localStorage.getItem(${JSON.stringify(`plume.child-draft:${tab}`)}))`;
	const question = "请解释刚才引用的两段";
	const requests: Record<string, unknown>[] = [];
	setModel((request) => {
		if ((request.tools as Array<{ name: string }> | undefined)?.some((tool) => tool.name === "read_main_chat")) requests.push(request);
		return { text: "侧边聊天已经读到引文和附件。" };
	});
	let menuCaptured = false;
	const select = async (from: "user" | "assistant") => {
		// 真实按下正文会先让编辑器失焦；只改 Selection 会被仍聚焦的 CodeMirror 拉回光标。
		await page("new Promise(resolve => { document.activeElement?.blur(); requestAnimationFrame(resolve); })");
		const selectText = async () =>
			(await page(`(() => {
			const holder = [...document.querySelectorAll('[data-screen=chat] [data-plume-quote=${from}]')].at(-1);
			const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode())) {
				if (node.data.trim().length < 4 || node.parentElement.closest('button')) continue;
				node.parentElement.scrollIntoView({ block: 'center' });
				const range = document.createRange();
				range.setStart(node, 0);
				range.setEnd(node, Math.min(node.length, 24));
				const selection = window.getSelection();
				selection.removeAllRanges(); selection.addRange(range);
				holder.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
				return selection.toString().trim();
			}
			throw new Error('没有可划选的消息');
		})()`)) as string;
		const menu = `Array.from(document.querySelectorAll('[role=menuitem]')).some(item => item.textContent === '在侧边聊天中提问')`;
		// 机器忙时侧边聊天的输入框可能晚一步抢回焦点、把刚划的选区收掉，菜单就不出来：没出来就重新划一次。
		let quoted = await selectText();
		for (let attempt = 0; attempt < 4; attempt++) {
			const end = Date.now() + 2000;
			while (Date.now() < end && !(await page(menu))) await new Promise((resolve) => setTimeout(resolve, 100));
			if (await page(menu)) break;
			await page("new Promise(resolve => { document.activeElement?.blur(); requestAnimationFrame(resolve); })");
			quoted = await selectText();
		}
		await until(menu, "划词菜单包含侧聊动作");
		if (!menuCaptured) {
			await capture(window, join(outDir, "smoke-quote-side-chat-menu.png"));
			menuCaptured = true;
		}
		await click("[role=menuitem]", "在侧边聊天中提问");
		return quoted;
	};
	try {
		await page(`document.querySelector('${side} .cm-content').focus()`);
		await window.webContents.insertText(question);
		await page(`(() => {
			const input = document.querySelector('${side} input[type=file]');
			const transfer = new DataTransfer();
			transfer.items.add(new File(['引文附件正文'], 'quote-note.txt', { type: 'text/plain' }));
			input.files = transfer.files;
			input.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await until(`${draft}?.attachments.length === 1`, "已有附件保存到标签草稿");
		const first = await select("assistant");
		await until(`${draft}?.quotes.length === 1`, "助手引文挂入草稿");
		const second = await select("user");
		await until(`${draft}?.quotes.length === 2`, "用户引文追加到同一份草稿");
		assert.equal(await page(countTabs), tabs, "前台侧聊继续使用原标签");
		assert.equal(requests.length, 0, "划词不会发起模型调用");
		assert.equal(await page(`${draft}.text.includes(${JSON.stringify(question)}) && ${draft}.attachments[0].name === 'quote-note.txt'`), true);
		assert.deepEqual(await page(`${draft}.quotes.map(({text, from}) => ({text, from}))`), [
			{ text: first, from: "assistant" },
			{ text: second, from: "user" },
		]);
		await until(`document.activeElement === document.querySelector('${side} .cm-content')`, "引用后光标落在侧聊输入框");
		await capture(window, join(outDir, "smoke-quote-side-chat.png"));
		const original = await page(draft);
		const quoteIntoNewTab = async (from: "user" | "assistant", label: string) => {
			const before = (await page(countTabs)) as number;
			const existing = (await page(
				`Array.from(document.querySelectorAll('[data-panel-tab="plume.side-chat/chat"]'), row => row.dataset.panelTabId)`,
			)) as string[];
			const text = await select(from);
			await until(`${countTabs} === ${before + 1} && ${activeSideTab} !== undefined`, `${label}另开侧聊标签`);
			const created = (await page(activeSideTab)) as string;
			assert.ok(created !== tab && !existing.includes(created), `${label}不复用后台或弹出标签`);
			const createdDraft = `JSON.parse(localStorage.getItem(${JSON.stringify(`plume.child-draft:${created}`)}))`;
			// 草稿攒一会儿才写进 localStorage（child-drafts.ts），等它落下再读。
			await until(`${createdDraft}?.quotes.length === 1`, `${label}的引文写进新标签的草稿`);
			assert.deepEqual(await page(`${createdDraft}.quotes.map(({text, from}) => ({text, from}))`), [{ text, from }]);
			assert.equal(await page(`${createdDraft}.text === '' && ${createdDraft}.attachments.length === 0`), true, "新标签不带走原草稿");
			assert.deepEqual(await page(draft), original, `${label}保留原标签整份草稿`);
			assert.equal(requests.length, 0, `${label}不自动发送`);
			await until(`document.querySelector('${side} [data-child-conversation]')?.dataset.childConversation === ''`, "只有草稿时不创建子会话");
			await click(`[data-panel-tab="plume.side-chat/chat"][data-panel-tab-id="${created}"] button[aria-label^="关闭"]`);
			await until(`document.querySelector('[data-panel-tab="plume.side-chat/chat"][data-panel-tab-id="${created}"]') === null`, "关闭未发送的临时标签");
			assert.equal(await page(`localStorage.getItem(${JSON.stringify(`plume.child-draft:${created}`)})`), null, "关闭清掉该标签的引用草稿");
		};

		await click('button[aria-label="收起面板"]');
		await until("document.querySelector('[data-panel-area]').inert", "面板已收起");
		await quoteIntoNewTab("assistant", "面板收起后");
		await click(`[data-panel-tab="plume.side-chat/chat"][data-panel-tab-id="${tab}"] [role=tab]`);
		await until(`${activeSideTab} === ${JSON.stringify(tab)}`, "回到原侧聊");

		const other = (await page(
			`Array.from(document.querySelectorAll('[data-panel-tab]')).find(row => !['plume.side-chat/chat', 'start'].includes(row.dataset.panelTab))?.dataset.panelTabId`,
		)) as string | undefined;
		assert.ok(other, "已有其他面板供切换验收");
		await click(`[data-panel-tab-id="${other}"] [role=tab]`);
		await until(`document.querySelector('[data-panel-tab-id="${other}"] [role=tab]')?.getAttribute('aria-selected') === 'true'`, "其他面板在前台");
		await quoteIntoNewTab("user", "其他面板在前台时");
		await click(`[data-panel-tab="plume.side-chat/chat"][data-panel-tab-id="${tab}"] [role=tab]`);
		await until(`${activeSideTab} === ${JSON.stringify(tab)}`, "原侧聊重新选中");

		await click('button[aria-label="在新窗口中打开"]');
		await until("window.plume.panelWindows.list().then(list => list.length === 1)", "侧聊弹出独立窗口");
		const detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
		assert.ok(detached);
		const detachedPage = (code: string) => detached.webContents.executeJavaScript(code) as Promise<unknown>;
		const end = Date.now() + 15_000;
		while (!(await detachedPage(`document.querySelectorAll('${side} [data-plume-quote-chip]').length === 2`))) {
			if (Date.now() > end) throw new Error("独立窗口没有恢复引用草稿");
			await detachedPage("new Promise(requestAnimationFrame)");
		}
		assert.equal(
			await detachedPage(
				`document.querySelector('${side} .cm-content').textContent.includes(${JSON.stringify(question)}) && ${draft}.attachments.length === 1`,
			),
			true,
		);
		await capture(detached, join(outDir, "smoke-quote-side-chat-window.png"));
		await quoteIntoNewTab("assistant", "原侧聊已弹出时");
		assert.deepEqual(await detachedPage(draft), original, "主窗口的新引用不改弹出窗口里的草稿");
		assert.equal(await page("window.plume.panelWindows.list().then(list => list.length)"), 1, "新引用不收回或复制弹出的原侧聊");
		// 点「收回」时独立窗口跟着关掉，这一次脚本的结果可能回不来（Render frame was disposed）；收回了没有由下一步核对。
		await detachedPage("document.querySelector('button[aria-label=收回]').click()").catch(windowClosed);
		await until(`document.querySelectorAll('${side} [data-plume-quote-chip]').length === 2`, "收回仍有两段引文");
		assert.equal(await page(countTabs), tabs, "三种新标签验收结束后原标签集合保留");
		// 收回后面板重新挂上，会话读回来之前输入框是禁用的，这时点发送什么都不做：等它能发再点。只认看得见的那个按钮
		// （换过草稿的输入框还挂着、藏着，见宿主的 ChildConversation）。
		const sideSend = `[...document.querySelectorAll('${side} [data-composer-send=send]')].find((button) => button.checkVisibility())`;
		await until(`${sideSend}?.disabled === false`, "收回后侧聊可以发送");
		await page(`${sideSend}.click()`);
		await until(`document.querySelector('${side}')?.textContent.includes('侧边聊天已经读到引文和附件。')`, "手动发送才开始回答");
		assert.ok(requests.length > 0);
		const sent = JSON.stringify(requests.at(-1)?.messages);
		for (const text of [first, second, question, "引文附件正文"]) assert.ok(sent.includes(text), `发送包含：${text}`);
		assert.equal(await page(`localStorage.getItem(${JSON.stringify(`plume.child-draft:${tab}`)})`), null, "发送清空整份草稿");
		console.log(
			"PLUME_QUOTE_SIDE_CHAT_SMOKE",
			JSON.stringify({ menu: true, reuse: true, collapsed: true, otherPanel: true, detached: true, preserved: true, manualSend: true }),
		);
	} finally {
		setModel(undefined);
	}
}
