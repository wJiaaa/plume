import assert from "node:assert/strict";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { clickReal, contextMenuVisible } from "./smoke-kit.ts";

/**
 * 分屏：会话菜单「打开方式 › 分屏」开出左右两屏，两屏各有自己的面板区，各开一个终端；真鼠标点另一屏时焦点先换过去、
 * 这一下照常落在按下的按钮上；换焦点时两个终端、关掉一屏时留下的那个终端都还是原来那个 shell（面板内容只有一层，按屏摆，不重挂）。
 */
export async function checkSplit(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	/** 屏上的会话；侧栏里要另有一段会话开到另一屏。 */
	sessionId: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, sessionId } = options;
	const other = (await page(
		`[...document.querySelectorAll('[data-plume-row]')].map(row => row.dataset.plumeRow).find(id => id !== ${JSON.stringify(sessionId)})`,
	)) as string | undefined;
	if (!other) throw new Error("分屏冒烟要侧栏里另有一段会话");
	const sessionMenu = '[role=menu][aria-label="会话选项"]';
	const openInMenu = '[role=menu][aria-label="打开方式"]';
	const pane = (side: "left" | "right") => `[data-split-pane=${side}][data-panel-layout]`;
	const terminal = (side: "left" | "right") => `[data-split-pane=${side}] [data-panel="plume.terminal/terminal"]:not([inert]) [data-terminal-id]`;
	const terminalId = (side: "left" | "right") => page(`document.querySelector(${JSON.stringify(terminal(side))})?.dataset.terminalId`) as Promise<string>;
	const selected = (id: string) => `document.querySelector('[data-plume-row="${id}"] > button')?.getAttribute('aria-current') === 'page'`;
	const original = window.getSize();
	window.setSize(1600, 900);
	await until("innerWidth === 1600", "窗口拉宽到放得下两屏");

	await contextMenuVisible(page, `[data-plume-row="${other}"]`, 80, 16);
	await until(`document.querySelector(${JSON.stringify(sessionMenu)}) !== null`, "会话右键菜单出现");
	await click(`${sessionMenu} [data-open-in] [role=menuitem]`);
	await until(`document.querySelector(${JSON.stringify(openInMenu)}) !== null`, "「打开方式」子菜单出现");
	await click(`${openInMenu} [role=menuitem]`, "分屏");
	await until(`document.querySelectorAll('[data-split-pane][data-panel-layout]').length === 2`, "开出左右两屏");
	// 新开的那屏在右边、拿到焦点；原来的会话留在左边。两段会话在侧栏里都点亮。
	await until(`document.querySelector('${pane("right")}')?.hasAttribute('data-screen-focused')`, "焦点在右边新开的那屏");
	await until(`document.querySelector('${pane("left")} [data-screen=chat] [data-plume-quote=assistant]') !== null`, "左屏画出原会话的对话");
	await until(`document.querySelector('${pane("right")} [data-screen=chat] [data-plume-quote=assistant]') !== null`, "右屏画出新开会话的对话");
	await until(`${selected(sessionId)} && ${selected(other)}`, "两屏的会话在侧栏里都点亮");
	assert.equal(await page(`document.querySelector('${pane("right")} [data-split-title=focused]') !== null`), true, "右屏标题是焦点那一屏");
	assert.equal(await page(`document.querySelector('${pane("left")} [data-split-title=other]') !== null`), true, "左屏标题淡一档");
	const veiled = () => page(`[...document.querySelectorAll('[data-split-veil]')].map(veil => veil.closest('[data-split-pane]').dataset.splitPane).join()`);
	assert.equal(await veiled(), "left", "只有焦点不在的左屏盖着压淡的那一层");

	// 右屏（焦点）开面板区、开一个终端。
	await clickReal(window, `${pane("right")} [data-panel-toggle] button`, "右屏的面板开关");
	await until(`document.querySelector('${pane("right")} [data-panel-area]')?.inert === false`, "右屏面板区打开");
	await clickReal(window, `${pane("right")} [data-panel-area] [data-panel-launch="plume.terminal/terminal"]`, "右屏开终端");
	await until(`Boolean(document.querySelector(${JSON.stringify(terminal("right"))})?.dataset.terminalId)`, "右屏终端接上 shell");
	// 左屏不是焦点：真鼠标点它的面板开关，按下时焦点先换到左屏，这一下照常打开左屏的面板区。
	await clickReal(window, `${pane("left")} [data-panel-toggle] button`, "左屏的面板开关");
	await until(`document.querySelector('${pane("left")}')?.hasAttribute('data-screen-focused')`, "点左屏后焦点换到左屏");
	assert.equal(await veiled(), "right", "焦点换到左屏后压淡的换成右屏");
	await until(`document.querySelector('${pane("left")} [data-panel-area]')?.inert === false`, "左屏面板区打开");
	await until(`document.querySelector('${pane("right")} [data-panel-area]')?.inert === false`, "右屏面板区仍开着");
	await clickReal(window, `${pane("left")} [data-panel-area] [data-panel-launch="plume.terminal/terminal"]`, "左屏开终端");
	await until(`Boolean(document.querySelector(${JSON.stringify(terminal("left"))})?.dataset.terminalId)`, "左屏终端接上 shell");
	const left = await terminalId("left");
	const right = await terminalId("right");
	assert.notEqual(left, right, "两屏各是自己的终端");
	// 两个终端各在自己那一屏的范围里。
	const inside = (await page(`(() => {
		const within = (side) => {
			const box = document.querySelector('[data-split-pane=' + side + '][data-panel-layout]').getBoundingClientRect();
			const content = document.querySelector('[data-split-pane=' + side + '] [data-panel="plume.terminal/terminal"]:not([inert])').getBoundingClientRect();
			return content.width > 100 && content.left >= box.left - 0.5 && content.right <= box.right + 0.5;
		};
		return within('left') && within('right');
	})()`)) as boolean;
	assert.equal(inside, true, "终端摆在各自那一屏的面板区里");
	await capture(window, join(outDir, "smoke-split.png"));

	// 换焦点：点右屏的对话，两个终端都不重挂。
	await clickReal(window, `${pane("right")} [data-screen=chat] [data-plume-quote=assistant]`, "右屏的回复");
	await until(`document.querySelector('${pane("right")}')?.hasAttribute('data-screen-focused')`, "焦点回到右屏");
	assert.equal(await terminalId("left"), left, "换焦点后左屏终端还是原来那个");
	assert.equal(await terminalId("right"), right, "换焦点后右屏终端还是原来那个");

	// 关掉左屏：剩下右屏那段会话，它的面板区和终端原样留着；左屏会话的面板标签按会话留着。
	await clickReal(window, `${pane("left")} [data-split-close]`, "关掉左屏");
	await until(`document.querySelectorAll('[data-split-pane][data-panel-layout]').length === 0`, "回到一屏");
	await until(`document.querySelector('[data-panel-layout] [data-screen=chat] [data-plume-quote=assistant]') !== null`, "剩下的一屏画着对话");
	await until(selected(other), "剩下的是右屏那段会话");
	await until(
		`document.querySelector('[data-panel="plume.terminal/terminal"]:not([inert]) [data-terminal-id]')?.dataset.terminalId === ${JSON.stringify(right)}`,
		"右屏的终端原样留在一屏里",
	);
	assert.equal(
		await page(
			`(JSON.parse(localStorage.getItem('plume.panel-tabs') ?? '{}')[${JSON.stringify(sessionId)}]?.tabs ?? []).some(tab => tab.panel === 'plume.terminal/terminal')`,
		),
		true,
		"左屏会话的终端标签按会话留着，回到它时还在",
	);
	window.setSize(original[0]!, original[1]!);
	await until(`innerWidth === ${original[0]}`, "恢复窗口大小");
}
