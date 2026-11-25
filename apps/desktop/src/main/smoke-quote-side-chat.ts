import assert from "node:assert/strict";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";
import { windowClosed } from "./smoke-panels.ts";
import { clickVisible } from "./smoke-kit.ts";

/** 专项入口只准备主会话、一个其他面板和侧聊（内置插件，随应用加载），复用完整冒烟的同一组断言。 */
export async function prepareQuoteSideChat(options: Parameters<typeof checkQuoteSideChat>[0]): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel } = options;
	setModel((request) => ({
		text: (request.tools as Array<{ name: string }> | undefined)?.some((tool) => tool.name === "read_main_chat")
			? "划词侧边聊天准备好了。"
			: "划词主会话准备好了。",
	}));
	await click('[data-plume-section-action] button[aria-label="新建项目"]');
	await click("[data-plume-add-folder]");
	await until("document.querySelector('[data-plume-source-folder]') !== null", "划词专项选择目录");
	await click("button", "创建项目");
	await until("document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace')", "划词专项项目就绪");
	await click("[data-model-trigger]");
	await click("[role=menuitem]", "fake-model");
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
	await until(
		"document.activeElement === document.querySelector('[data-panel=\"plume.side-chat/chat\"]:not([inert]) .cm-content')",
		"新开的侧聊输入框拿到焦点",
	);
	await page("window.plume.saveAppearance({ grain: true })");
	await until(
		`(() => { const side = document.querySelector('[data-panel="plume.side-chat/chat"]:not([inert])'); const layers = side?.querySelectorAll('.surface-grain'); return layers?.length === 1 && getComputedStyle(layers[0]).backgroundAttachment === 'fixed' && side.closest('[data-frame-clip]')?.querySelector(':scope > .surface-grain') === null; })()`,
		"侧聊只铺一层固定到视口的会话颗粒",
	);
	await capture(window, join(outDir, "smoke-side-chat-grain.png"));
	await page("window.plume.saveAppearance({ grain: false })");
	await until(`document.querySelector('[data-panel="plume.side-chat/chat"]:not([inert]) .surface-grain') === null`, "侧聊关掉磨砂");
	await checkSideCommands(options);
	await checkUnreadDot(options);
	await checkSideApproval(options);
}

/**
 * 侧聊输入框的 `/` 菜单：输入框挂上时这段还没接上（面板先挂、再接回那段），菜单照样要有，列插件的命令，不列 `/clear`、`/btw`、`/plan`（计划模式只开在主会话上）。
 * 打完再删干净，后面接着用这个输入框。
 */
async function checkSideCommands(options: Parameters<typeof checkQuoteSideChat>[0]): Promise<void> {
	const { window, outDir, page, until, capture } = options;
	const side = '[data-panel="plume.side-chat/chat"]:not([inert])';
	const menu = `${side} .plume-command-menu[data-open="true"]`;
	await page(`document.querySelector('${side} .cm-content').focus()`);
	window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
	await window.webContents.insertText("/");
	await until(`document.querySelector('${menu} [data-command="compact"]') !== null`, "侧聊里敲 / 弹出命令菜单");
	assert.equal(
		await page(`document.querySelector('${menu} [data-command="clear"], ${menu} [data-command="btw"], ${menu} [data-command="plan"]') !== null`),
		false,
		"侧聊的 / 菜单不该列 /clear、/btw、/plan",
	);
	await capture(window, join(outDir, "smoke-side-chat-commands.png"));
	for (const keyCode of ["Escape", "Backspace"]) {
		window.webContents.sendInputEvent({ type: "keyDown", keyCode });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode });
	}
	await until(
		`document.querySelector('${side} [data-composer-send=send]')?.disabled === true && document.querySelector('${menu}') === null`,
		"删掉 / 后菜单收起",
	);
}

/** 看着时回复完不亮点；问了一句就切到别的标签，回复完侧聊标签上亮未读点，切回来灭掉。 */
async function checkUnreadDot(options: Parameters<typeof checkQuoteSideChat>[0]): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel } = options;
	const dot = `document.querySelector('[data-panel-tab="plume.side-chat/chat"] [data-panel-tab-unread]') !== null`;
	assert.equal(await page(dot), false, "看着时回复完不该亮未读点");
	setModel(() => ({ text: "后台标签里慢慢回完这一句。", stream: { chunkSize: 2, delayMs: 150 } }));
	await page("document.querySelector('[data-panel=\"plume.side-chat/chat\"]:not([inert]) .cm-content').focus()");
	await window.webContents.insertText("在后台回一句");
	await click('[data-panel="plume.side-chat/chat"]:not([inert]) [data-composer-send=send]');
	await until("document.querySelector('[data-panel=\"plume.side-chat/chat\"]:not([inert]) [data-composer-send=stop]') !== null", "侧聊开始回复");
	await click('[data-panel-tab="plume.diagnostics/tasks"] [role=tab]');
	assert.equal(await page(dot), false, "还在回复时不该亮未读点");
	await until(dot, "后台回复完亮未读点");
	await capture(window, join(outDir, "smoke-side-chat-unread.png"));
	await click('[data-panel-tab="plume.side-chat/chat"] [role=tab]');
	await until(`!(${dot})`, "切回侧聊标签后未读点灭掉");
}

/**
 * 侧聊的审批卡画在侧聊自己的输入框上方，主输入框上方没有（写的是 Plume 的数据目录，任何权限档都弹卡）；切到别的标签（侧聊看不见）时压回主输入框上方、写明来源，
 * 切回来又挪回侧聊。在侧聊里答，写完收尾。
 */
async function checkSideApproval(options: Parameters<typeof checkQuoteSideChat>[0]): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel } = options;
	const side = '[data-panel="plume.side-chat/chat"]:not([inert])';
	setModel((request) =>
		JSON.stringify(request.messages).includes("toolu_side_write")
			? { text: "侧聊写好了。" }
			: { toolCalls: [{ id: "toolu_side_write", name: "write", args: { path: join(outDir, "home", "side-note.txt"), content: "side\n" } }] },
	);
	await page(`document.querySelector('${side} .cm-content').focus()`);
	await window.webContents.insertText("写一份侧聊笔记");
	await click(`${side} [data-composer-send=send]`);
	const inSideOnly = `document.querySelectorAll('[data-approval-card]').length === 1 && document.querySelector('${side} [data-approval-card]') !== null && document.querySelector('[data-approval-from]') === null`;
	await until(inSideOnly, "侧聊的审批卡画在侧聊里、主输入框上方没有");
	// 标题是一串长绝对路径：窄面板里最多两行，按钮那一排整个留在卡片里，不被挤出卡片的最大高度。
	await until(
		`(() => { const card = document.querySelector('${side} [data-approval-card]').getBoundingClientRect(); const choices = document.querySelector('${side} [data-permission-choices]').getBoundingClientRect(); const title = document.querySelector('${side} [data-approval-title]'); return choices.bottom <= card.bottom + 0.5 && choices.top >= card.top && title.getClientRects().length > 0 && title.scrollHeight > title.clientHeight; })()`,
		"窄面板里长标题收成两行、按钮留在卡片里",
	);
	await capture(window, join(outDir, "smoke-side-chat-approval.png"));
	await click('[data-panel-tab="plume.diagnostics/tasks"] [role=tab]');
	await until(
		`(() => { const from = document.querySelector('[data-approval-from]'); return from !== null && from.closest('[data-panel]') === null; })()`,
		"侧聊看不见时审批卡压回主输入框上方、写明来源",
	);
	await click('[data-panel-tab="plume.side-chat/chat"] [role=tab]');
	await until(inSideOnly, "切回侧聊后审批卡挪回侧聊");
	await clickVisible(page, `${side} [data-approval-card] button`, /允许一次/);
	await until(
		`document.querySelector('[data-approval-card]') === null && document.querySelector('${side}')?.textContent.includes('侧聊写好了。') && document.querySelector('${side} [data-composer-send=stop]') === null`,
		"在侧聊里批准后写完收尾",
	);
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
			// 标签一打开这段就建好（第一句之前命令、模型都按它来），只是还没说过话：关掉不用确认。
			await until(
				`(document.querySelector('${side} [data-child-conversation]')?.dataset.childConversation ?? '') !== '' && document.querySelector('${side} [data-plume-transcript-rows]') === null`,
				"新标签打开就有自己的空会话",
			);
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
		await clickVisible(detachedPage, "button[aria-label=收回]").catch(windowClosed);
		await until(`document.querySelectorAll('${side} [data-plume-quote-chip]').length === 2`, "收回仍有两段引文");
		assert.equal(await page(countTabs), tabs, "三种新标签验收结束后原标签集合保留");
		// 收回后面板重新挂上，会话读回来之前输入框是禁用的，这时点发送什么都不做：等它能发再点。只认看得见的那个按钮
		// （换过草稿的输入框还挂着、藏着，见宿主的 ChildConversation）。
		await clickVisible(page, `${side} [data-composer-send=send]`);
		await until(`document.querySelector('${side}')?.textContent.includes('侧边聊天已经读到引文和附件。')`, "手动发送才开始回答");
		assert.ok(requests.length > 0);
		const sent = JSON.stringify(requests.at(-1)?.messages);
		for (const text of [first, second, question, "引文附件正文"]) assert.ok(sent.includes(text), `发送包含：${text}`);
		assert.equal(await page(`localStorage.getItem(${JSON.stringify(`plume.child-draft:${tab}`)})`), null, "发送清空整份草稿");
		await checkQuoteSwitchSession(options);
		console.log(
			"PLUME_QUOTE_SIDE_CHAT_SMOKE",
			JSON.stringify({ menu: true, reuse: true, collapsed: true, otherPanel: true, detached: true, preserved: true, manualSend: true, switchSession: true }),
		);
	} finally {
		setModel(undefined);
	}
}

/**
 * A 会话双击弹起划词菜单后切到 B 会话：菜单应立即收起，不因切会话滚动重算旧选区而甩到窗口左上角；
 * 双击等待（400ms）期间切会话也不会延迟弹出。
 */
async function checkQuoteSwitchSession(options: Parameters<typeof checkQuoteSideChat>[0]): Promise<void> {
	const { window, page, until, click, setModel } = options;
	const sessionA = (await page(`document.querySelector('[data-plume-row]')?.dataset.plumeRow`)) as string;
	assert.ok(sessionA, "已有会话 A");
	const longReply = Array.from({ length: 40 }, (_, index) => `会话 B 第 ${index + 1} 行，用于触发切换会话后的滚动恢复。`).join("\n\n");
	setModel(() => ({ text: longReply }));
	await click("button", "新对话");
	await until("document.querySelector('[data-screen=empty]') !== null", "打开新对话准备会话 B");
	await page("document.querySelector('[data-screen=empty] .cm-content').focus()");
	await window.webContents.insertText("准备会话 B");
	await until("document.querySelector('[data-composer-send=send]')?.disabled === false", "会话 B 可发送");
	await click("[data-composer-send=send]");
	await until(
		"document.querySelector('[data-screen=chat]')?.textContent.includes('会话 B 第 40 行') && document.querySelector('[data-composer-send=stop]') === null",
		"会话 B 回复完成",
	);
	const sessionB = (await page(
		`Array.from(document.querySelectorAll('[data-plume-row]'), row => row.dataset.plumeRow).find(id => id !== ${JSON.stringify(sessionA)})`,
	)) as string;
	assert.ok(sessionB, "已有会话 B");

	await click(`[data-plume-row="${sessionA}"] > button`);
	await until("document.querySelector('[data-screen=chat]')?.textContent.includes('划词主会话准备好了。')", "切回会话 A");

	const doubleClickQuote = async () => {
		await page("new Promise(resolve => { document.activeElement?.blur(); requestAnimationFrame(resolve); })");
		await page(`(() => {
			const holder = [...document.querySelectorAll('[data-screen=chat] [data-plume-quote=assistant]')].at(-1);
			const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode())) {
				if (node.data.trim().length < 4 || node.parentElement.closest('button')) continue;
				node.parentElement.scrollIntoView({ block: 'center' });
				const range = document.createRange();
				range.setStart(node, 0);
				range.setEnd(node, Math.min(node.length, 10));
				const selection = window.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				holder.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 2 }));
				return;
			}
			throw new Error('没有可双击划选的消息');
		})()`);
	};
	const menuVisible = `Array.from(document.querySelectorAll('[role=menuitem]')).some(item => item.textContent === '引用到输入框')`;

	// 1. A 会话双击弹出划词菜单后切到 B 会话：菜单应彻底消失，不甩到左上角。
	await doubleClickQuote();
	await until(menuVisible, "会话 A 双击弹出划词菜单");
	const beforeRect = (await page(
		`(() => { const r = document.querySelector('[data-plume-popover]')?.getBoundingClientRect(); return r && { left: r.left, top: r.top }; })()`,
	)) as { left: number; top: number } | null;
	assert.ok(beforeRect && beforeRect.left > 40 && beforeRect.top > 40, `会话 A 划词菜单应在正文附近：${JSON.stringify(beforeRect)}`);
	await click(`[data-plume-row="${sessionB}"] > button`);
	await until("document.querySelector('[data-screen=chat]')?.textContent.includes('会话 B 第 40 行')", "切到会话 B");
	await new Promise((resolve) => setTimeout(resolve, 300));
	await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	assert.equal(await page(menuVisible), false, "切到会话 B 后划词菜单不该残留在左上角");
	assert.equal(await page("document.querySelector('[data-plume-popover]') !== null"), false, "切到会话 B 后不应有残留弹层");

	// 2. 双击等待（400ms）期间切回会话 A：延迟回调不该在会话 A 弹出菜单。
	await doubleClickQuote();
	await click(`[data-plume-row="${sessionA}"] > button`);
	await until("document.querySelector('[data-screen=chat]')?.textContent.includes('划词主会话准备好了。')", "双击等待期间切回会话 A");
	await new Promise((resolve) => setTimeout(resolve, 550));
	await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	assert.equal(await page(menuVisible), false, "双击等待期间切会话后不应延迟弹出划词菜单");
}
