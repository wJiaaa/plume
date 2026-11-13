import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { BrowserWindow } from "electron";
import { clickEachVisible, clickVisibleIn, contextMenuVisible } from "./smoke-kit.ts";

/**
 * 会话菜单开出真实独立窗口，验证外壳（贴顶的标题栏、没有卡片、不透明）、置顶、面板或文件交给主窗口、回到主窗口，
 * 会话在主窗口归档时独立窗口跟着关掉，最后恢复原会话。
 */
export async function checkSessionWindow(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	/** 原会话：最后回到它。 */
	sessionId: string;
	finalText: string;
	/** 给了就验证独立窗口里打开文件交给主窗口（不依赖插件）；没给就用已装的终端插件验证面板交给主窗口。 */
	file?: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, sessionId, finalText, file } = options;
	const sessionMenu = '[role=menu][aria-label="会话选项"]';
	const openInMenu = '[role=menu][aria-label="打开方式"]';
	const other = (await page(
		`[...document.querySelectorAll('[data-plume-row]')].map(row => row.dataset.plumeRow).find(id => id !== ${JSON.stringify(sessionId)})`,
	)) as string | undefined;
	if (!other) throw new Error("会话窗口冒烟要侧栏里另有一段会话");
	const row = (id: string) => `[data-plume-row="${id}"]`;
	const selected = (id: string) => `document.querySelector(${JSON.stringify(`${row(id)} > button`)})?.getAttribute('aria-current') === 'page'`;
	const panelOpen = (await page(`document.querySelector('[data-panel-area]')?.inert === false`)) as boolean;
	type Group = { tabs: { id: string; panel?: string }[]; active: string };
	const saved = (await page(`JSON.parse(localStorage.getItem('plume.panel-tabs') ?? '{}')[${JSON.stringify(other)}]`)) as Group | undefined;
	let detached: BrowserWindow | undefined;
	let panelTab: string | undefined;
	const waitUntil = async (check: () => Promise<unknown>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await check())) {
			if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const findDetached = async (): Promise<BrowserWindow> => {
		const end = Date.now() + 15_000;
		for (;;) {
			for (const candidate of BrowserWindow.getAllWindows()) {
				if (candidate === window || candidate.isDestroyed()) continue;
				if ((await candidate.webContents.executeJavaScript("window.plume?.sessionWindows.boot ?? null").catch(() => null)) === other) return candidate;
			}
			if (Date.now() > end) throw new Error("等待超时：会话窗口");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	try {
		await until(`document.querySelector(${JSON.stringify(sessionMenu)}) === null`, "上一次会话菜单已关闭");
		await contextMenuVisible(page, row(other), 80, 16);
		await until(`document.querySelector(${JSON.stringify(sessionMenu)}) !== null`, "会话右键菜单出现");
		assert.equal(
			await page(`document.querySelector(${JSON.stringify(sessionMenu)})?.textContent.includes('分屏')`),
			false,
			"会话菜单不再提供分屏或移动分屏入口",
		);
		await click(`${sessionMenu} [data-open-in] [role=menuitem]`);
		await until(`document.querySelector(${JSON.stringify(openInMenu)}) !== null`, "「打开方式」子菜单出现");
		assert.deepEqual(
			await page(`[...document.querySelectorAll(${JSON.stringify(`${openInMenu} [role=menuitem]`)})].map(item => item.textContent.trim())`),
			["新窗口"],
			"打开方式只保留新窗口，不再提供分屏入口",
		);
		await click(`${openInMenu} [role=menuitem]`, "新窗口");
		await until(`window.plume.sessionWindows.list().then(list => list.includes(${JSON.stringify(other)}))`, "开出会话窗口");
		detached = await findDetached();
		const inDetached = (code: string) => detached!.webContents.executeJavaScript(code) as Promise<unknown>;
		const untilDetached = (code: string, label: string) => waitUntil(() => inDetached(code), label);
		await untilDetached(
			`document.querySelector('[data-session-window-chrome] [data-plume-screen-title]')?.textContent.length > 0 && document.querySelector('[data-screen=chat] [data-plume-quote=assistant]') !== null`,
			"会话窗口画出标题和对话",
		);
		const title = (await inDetached(`document.querySelector('[data-plume-screen-title]').textContent`)) as string;
		await until(selected(other), "开在独立窗口里的会话侧栏点亮");
		assert.equal(await inDetached(`document.querySelector('[data-plume-row], [data-panel-area]') !== null`), false, "会话窗口没有侧栏和面板区");
		// 外壳：一份文档，不是第二个工作区。整面是对话的底色，没有浮起的卡片；标题栏贴着窗口顶，红绿灯在它里面居中。
		const shell = (await inDetached(`(() => {
			const chrome = document.querySelector('[data-session-window-chrome]');
			const main = chrome.closest('main') ?? document.querySelector('main');
			const style = getComputedStyle(main);
			return {
				top: chrome.getBoundingClientRect().top,
				height: chrome.getBoundingClientRect().height,
				paddingLeft: getComputedStyle(chrome).paddingLeft,
				mainLeft: main.getBoundingClientRect().left,
				border: style.borderTopWidth,
				radius: style.borderTopLeftRadius,
			};
		})()`)) as { top: number; height: number; paddingLeft: string; mainLeft: number; border: string; radius: string };
		if (process.platform === "darwin") {
			assert.deepEqual(
				{ top: shell.top, height: shell.height, mainLeft: shell.mainLeft, border: shell.border, radius: shell.radius },
				{ top: 0, height: 44, mainLeft: 0, border: "0px", radius: "0px" },
				"会话窗口的标题栏贴窗口顶，正文没有卡片",
			);
			assert.equal(shell.paddingLeft, "96px", "标题从红绿灯后面的第一格再让 10px 起");
			assert.deepEqual(detached.getWindowButtonPosition(), { x: 16, y: 15 }, "红绿灯在贴顶的 44px 标题栏里居中");
		}
		await capture(detached, join(outDir, "smoke-session-window.png"));
		await clickVisibleIn(inDetached, `[document.querySelector('[data-keep-on-top]')?.closest('button')]`, "置顶按钮");
		await untilDetached(`document.querySelector('[data-keep-on-top]')?.dataset.keepOnTop === 'true'`, "会话窗口置顶");
		assert.ok(detached.isAlwaysOnTop(), "会话窗口应该置顶了");
		// 同一段会话再开一次只把那个窗口拿到前面来，不开第二个。
		await page(`window.plume.sessionWindows.open(${JSON.stringify(other)})`);
		assert.deepEqual(await page(`window.plume.sessionWindows.list()`), [other], "同一段会话只开一个窗口");

		// 从真实会话窗口经预加载和 IPC 请求面板或文件，必须由主窗口接住；主窗口收在程序坞里时也要拿出来。
		window.minimize();
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (file) {
			const name = basename(file);
			await inDetached(`window.plume.panelWindows.reveal({ file: { path: ${JSON.stringify(file)}, sessionId: ${JSON.stringify(other)} } })`);
			const tab = `[data-panel-area] [data-panel-tab="plume/file"]`;
			await until(
				`${selected(other)} && document.querySelector('[data-plume-screen-title]')?.textContent === ${JSON.stringify(title)} && document.querySelector('[data-panel-area]')?.inert === false && [...document.querySelectorAll('${tab}')].some(tab => tab.textContent.includes(${JSON.stringify(name)}))`,
				"会话窗口里打开的文件交给主窗口，开在来源会话的面板区",
			);
			panelTab = (await page(
				`[...document.querySelectorAll('${tab}')].find(tab => tab.textContent.includes(${JSON.stringify(name)})).dataset.panelTabId`,
			)) as string;
		} else {
			await inDetached(`window.plume.panelWindows.reveal({ panel: 'plume.terminal/terminal' })`);
			const terminal = '[data-panel="plume.terminal/terminal"]:not([inert])';
			await until(
				`${selected(other)} && document.querySelector('[data-plume-screen-title]')?.textContent === ${JSON.stringify(title)} && document.querySelector('[data-panel-area]')?.inert === false && document.querySelector('${terminal} [data-terminal-id]:not([data-terminal-id=""])') !== null`,
				"会话窗口的面板请求交给主窗口，在来源会话旁边打开真实终端",
			);
			panelTab = (await page(`document.querySelector('${terminal}').closest('[data-panel-tab-id]').dataset.panelTabId`)) as string;
		}
		assert.ok(!window.isMinimized() && window.isVisible(), "面板交给主窗口时主窗口从程序坞里拿出来");
		assert.equal(await inDetached(`document.querySelector('[data-panel-area]') !== null`), false, "打开面板后会话窗口仍只有对话");
		assert.ok(!detached.isDestroyed(), "面板交给主窗口不关闭会话窗口");
		await capture(window, join(outDir, "smoke-session-window-panel-in-main.png"));
		window.hide();

		// 先切回另一段会话，避免面板交接已经选中来源会话而掩盖回到主窗口失败。
		await click(`${row(sessionId)} > button`);
		await until(
			`${selected(sessionId)} && document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(finalText)})`,
			"回到主窗口前先切走来源会话",
		);
		await clickVisibleIn(inDetached, `[document.querySelector('[data-open-in-main]')?.closest('button')]`, "回到主窗口");
		await until(
			`(async () => (await window.plume.sessionWindows.list()).length === 0 && ${selected(other)} && document.querySelector('[data-plume-screen-title]')?.textContent === ${JSON.stringify(title)} && document.querySelector('[data-screen=chat] [data-plume-quote=assistant]') !== null)()`,
			"回到主窗口：会话窗口关掉，主窗口打开那段会话",
		);
		assert.ok(detached.isDestroyed(), "回到主窗口以后会话窗口应该关掉");

		// 会话在主窗口归档：独立窗口只为它而开，跟着关掉；取消归档后侧栏照旧。
		await page(`window.plume.sessionWindows.open(${JSON.stringify(other)})`);
		detached = await findDetached();
		const reopened = detached;
		await until(`window.plume.sessionWindows.list().then(list => list.includes(${JSON.stringify(other)}))`, "再开一次会话窗口");
		// 等它读到会话列表、画出对话：在这之前归档，它读到的就是一段本来就归档的会话，按规矩照常显示。
		await waitUntil(
			() => reopened.webContents.executeJavaScript(`document.querySelector('[data-screen=chat] [data-plume-quote=assistant]') !== null`),
			"再开的会话窗口画出对话",
		);
		await contextMenuVisible(page, row(other), 80, 16);
		await until(`document.querySelector(${JSON.stringify(sessionMenu)}) !== null`, "归档用的会话菜单出现");
		await click(`${sessionMenu} [role=menuitem]`, "归档");
		await until(`window.plume.sessionWindows.list().then(list => list.length === 0)`, "会话归档后独立窗口关掉");
		const closed = Date.now() + 5_000;
		while (!detached.isDestroyed() && Date.now() < closed) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(detached.isDestroyed(), "会话归档以后会话窗口应该关掉");
		await click("button", "设置");
		await click("[aria-label=设置章节] button", "已归档的聊天");
		const archivedRow = `[data-plume-archive-row="${other}"]`;
		await until(`document.querySelector('[data-plume-archive-group]') !== null`, "已归档里列出会话");
		await clickEachVisible(page, "[data-plume-archive-group][data-open=false] > button");
		await until(`document.querySelector(${JSON.stringify(archivedRow)}) !== null`, "已归档里找到这段会话");
		await click(`${archivedRow} button`, "取消归档");
		await until(`document.querySelector(${JSON.stringify(archivedRow)}) === null`, "取消归档");
		await click("button", "返回工作区");
		await until(`document.querySelector(${JSON.stringify(row(other))}) !== null`, "取消归档后回到侧栏");
		window.hide();
	} catch (error) {
		await capture(window, join(outDir, "smoke-session-window-failed.png"));
		throw error;
	} finally {
		if (detached && !detached.isDestroyed()) detached.close();
		try {
			if (panelTab) {
				await click(`${row(other)} > button`);
				await until(selected(other), "收尾回到面板来源会话");
				if (!saved?.tabs.some((tab) => tab.id === panelTab)) {
					await click(`[data-panel-area] [data-panel-tab-id="${panelTab}"] button[aria-label^="关闭"]`);
					await until(
						`!JSON.parse(localStorage.getItem('plume.panel-tabs') ?? '{}')[${JSON.stringify(other)}]?.tabs.some(tab => tab.id === ${JSON.stringify(panelTab)})`,
						"只关闭会话窗口冒烟新开的面板标签",
					);
				}
				if (saved?.tabs.some((tab) => !tab.panel) && !(await page(`document.querySelector('[data-panel-area] [data-panel-tab="start"]') !== null`))) {
					await click("[data-panel-area] button[data-panel-add]");
					await until(`document.querySelector('[data-panel-area] [data-panel-tab="start"]') !== null`, "恢复原来的开始页标签");
				}
				const active = saved?.tabs.find((tab) => tab.id === saved.active);
				if (active)
					await click(
						active.panel ? `[data-panel-area] [data-panel-tab-id="${active.id}"] [role=tab]` : '[data-panel-area] [data-panel-tab="start"] [role=tab]',
					);
			}
			await click(`${row(sessionId)} > button`);
			await until(
				`${selected(sessionId)} && document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(finalText)})`,
				"收尾恢复原会话",
			);
			if ((await page(`document.querySelector('[data-panel-area]')?.inert === false`)) !== panelOpen) {
				await click(panelOpen ? "[data-panel-toggle] button" : '[data-panel-area] button[aria-label="收起面板"]');
				await until(`document.querySelector('[data-panel-area]')?.inert === ${!panelOpen}`, "恢复面板原来的开合状态");
			}
		} finally {
			window.hide();
		}
	}
	console.log(
		"PLUME_SESSION_WINDOW_SMOKE",
		JSON.stringify({
			noSplitMenu: true,
			sessionWindow: true,
			edgeChrome: true,
			keepOnTop: true,
			singleWindow: true,
			[file ? "fileInMain" : "panelInMain"]: true,
			openInMain: true,
			closeOnArchive: true,
		}),
	);
}
