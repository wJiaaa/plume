import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow } from "electron";

/** 真窗口验证布局、窗口交接和标签恢复，终端一直是同一个 shell。 */
export async function checkPanelsFramework(window: BrowserWindow, outDir: string): Promise<void> {
	const terminal = '[data-panel="plume.terminal/terminal"]:not([inert]) [data-terminal-id]';
	const page = <T>(expression: string, target = window): Promise<T> => target.webContents.executeJavaScript(expression);
	const until = async (expression: string, label: string, target = window) => {
		const end = Date.now() + 15000;
		while (!(await page<boolean>(expression, target))) {
			if (Date.now() > end) throw new Error(`面板冒烟等待超时：${label}`);
			await page("new Promise(requestAnimationFrame)", target);
		}
	};
	const click = (label: string, target = window) => page(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`, target);
	const settle = () =>
		page(
			`(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); })()`,
		);
	const capture = async (name: string, target = window) => writeFile(join(outDir, name), (await target.webContents.capturePage()).toPNG());
	const original = window.getSize();
	const id = await page<string>(`document.querySelector('${terminal}').dataset.terminalId`);
	const session = await page<string>(`document.querySelector('[data-plume-row].bg-card-hover').dataset.plumeRow`);
	window.setSize(1600, 900);
	await until(
		"innerWidth === 1600 && Number(document.querySelector('[role=separator][aria-label=\"调整面板宽度\"]')?.getAttribute('aria-valuemax')) > 560",
		"宽窗口布局已更新",
	);
	await settle();
	const edge = await page<number>(`document.querySelector('[role=separator][aria-label="调整面板宽度"]').getBoundingClientRect().right - 1`);
	window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(edge), y: 200 });
	window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(edge), y: 200, button: "left", clickCount: 1 });
	await settle();
	window.webContents.sendInputEvent({ type: "mouseMove", x: 700, y: 200 });
	await settle();
	window.webContents.sendInputEvent({ type: "mouseUp", x: 700, y: 200, button: "left", clickCount: 1 });
	await settle();
	assert.ok(await page<boolean>("document.querySelector('[data-panel-area]').getBoundingClientRect().width > 560"), "可拉宽到560px以上");
	await click("全屏");
	await settle();
	assert.equal(await page<boolean>("document.querySelector('main').inert"), true);
	assert.ok(
		await page<boolean>("Math.abs(document.querySelector('[data-panel-area]').clientWidth - document.querySelector('[data-panel-layout]').clientWidth) < 2"),
	);
	await capture("smoke-panel-full.png");
	await click("退出全屏");
	window.setSize(820, 720);
	await until("document.querySelector('[data-panel-layout]').dataset.panelLayout === 'column'", "上下排列");
	await settle();
	assert.ok(
		await page<boolean>(
			"document.querySelector('[data-panel-area]').getBoundingClientRect().top >= document.querySelector('main').getBoundingClientRect().bottom - 1",
		),
	);
	assert.ok(await page<boolean>("document.querySelector('[role=separator][aria-orientation=horizontal]') !== null"));
	assert.ok(
		await page<boolean>(
			"(() => { const a = document.querySelector('main > div').getBoundingClientRect(), b = document.querySelector('[data-panel-area] > div').getBoundingClientRect(); return Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1; })()",
		),
		"上下卡片左右边缘对齐",
	);
	await capture("smoke-panel-stacked.png");
	window.setSize(600, 720);
	await until("document.querySelector('[data-panel-layout]').dataset.panelLayout === 'single'", "单面板");
	await settle();
	assert.equal(await page<boolean>("document.querySelector('main').inert"), true);
	await capture("smoke-panel-compact.png");
	await click("收起面板");
	await until("!document.querySelector('main').inert", "窄窗回到对话");
	await click("打开面板");
	window.setSize(original[0]!, original[1]!);
	await until(`innerWidth === ${original[0]}`, "恢复窗口大小");
	await click("在新窗口中打开");
	const target = await page<{ tab: string }>(
		"(async () => { for (let i = 0; i < 1000; i++) { const list = await window.plume.panelWindows.list(); if (list.length) return list[0]; await new Promise(requestAnimationFrame); } throw new Error('窗口未打开'); })()",
	);
	const detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
	assert.ok(detached, "独立面板窗口已显示");
	await until(`document.querySelector('${terminal}')?.dataset.terminalId === ${JSON.stringify(id)}`, "弹出接回原shell", detached);
	await until(`document.querySelector('${terminal} .xterm-rows')?.textContent.includes('PLUME_42:')`, "弹出保留终端历史输出", detached);
	await capture("smoke-panel-window.png", detached);
	await page(`window.plume.panelWindows.reveal({ file: { path: 'hello.txt', sessionId: ${JSON.stringify(session)} } })`, detached);
	await until("document.querySelector('[data-panel=\"plume/file\"]:not([inert])')?.textContent.includes('hi')", "独立窗口文件请求回到来源会话");
	// 点「收回」时独立窗口跟着关掉，这一次脚本的结果可能回不来（Render frame was disposed）；收回了没有由下一步核对。
	await click("收回", detached).catch(windowClosed);
	await until(
		`document.querySelector('${terminal}')?.dataset.terminalId === ${JSON.stringify(id)} && !document.querySelector('[data-panel-area]').inert`,
		"收回原会话与shell",
	);
	assert.equal((await page<unknown[]>("window.plume.panelWindows.list()")).length, 0);
	assert.ok(
		await page<boolean>(
			`Object.values(JSON.parse(localStorage.getItem('plume.panel-tabs'))).some(group => group.tabs.some(tab => tab.id === ${JSON.stringify(target.tab)}))`,
		),
		"标签已持久化",
	);
	// 等新页面载完再执行脚本：重载途中旧的渲染帧已经销毁，这时 executeJavaScript 会报「Render frame was disposed」。
	const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
	window.webContents.reload();
	await reloaded;
	await until(`document.querySelector('[data-plume-row="${session}"]') !== null`, "刷新后会话列表恢复");
	await page(`document.querySelector('[data-plume-row="${session}"] > button').click()`);
	await until(`document.querySelector('${terminal}')?.dataset.terminalId === ${JSON.stringify(id)}`, "刷新接回原标签和shell");
	await until(`document.querySelector('${terminal} .xterm-rows')?.textContent.includes('PLUME_42:')`, "刷新后历史输出恢复");
	await capture("smoke-panel-restored.png");
	await page("document.querySelector('[data-panel-add]').click()");
	await until("document.querySelector('[data-panel-launch=\"plume.terminal/terminal\"]') !== null", "「+」打开开始页");
	await page("document.querySelector('[data-panel-launch=\"plume.terminal/terminal\"]').click()");
	await until(
		`document.querySelector('${terminal}')?.dataset.terminalId && document.querySelector('${terminal}').dataset.terminalId !== ${JSON.stringify(id)}`,
		"第二个终端独立shell",
	);
	await click("在新窗口中打开");
	await until("window.plume.panelWindows.list().then(list => list.length === 1)", "再次弹出");
	const closing = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
	assert.ok(closing);
	await until(`document.querySelector('${terminal}')?.dataset.terminalId`, "关闭前终端已接上", closing);
	closing.close();
	await until("window.plume.panelWindows.list().then(list => list.length === 0)", "原生窗口关闭完成清理");
	await page("document.querySelector('[data-panel-tab=\"plume.terminal/terminal\"] [role=tab]').click()");
	await until(`document.querySelector('${terminal}')?.dataset.terminalId === ${JSON.stringify(id)}`, "关闭第二窗不影响原终端");
	console.log(
		"PLUME_PANEL_SMOKE",
		JSON.stringify({ wide: true, fullScreen: true, stacked: true, compact: true, popOut: true, dockBack: true, restored: true, nativeClose: true }),
	);
}

/** 已有侧聊的纯文本草稿搬窗，以及异常退出后返回来源会话。 */
export async function checkSideChatWindow(window: BrowserWindow, outDir: string): Promise<void> {
	const panel = '[data-panel="plume.side-chat/chat"]:not([inert])';
	const editor = `${panel} .cm-content`;
	const draft = "尚未发送的搬窗草稿";
	const page = <T>(expression: string, target = window): Promise<T> => target.webContents.executeJavaScript(expression);
	const until = async (expression: string, target = window) => {
		const end = Date.now() + 10000;
		while (!(await page<boolean>(expression, target))) {
			if (Date.now() > end) throw new Error(`侧聊窗口等待超时：${expression}`);
			await page("new Promise(requestAnimationFrame)", target);
		}
	};
	await page(`document.querySelector('${editor}').focus()`);
	await window.webContents.insertText(draft);
	await until(`document.querySelector('${editor}').textContent.includes(${JSON.stringify(draft)})`);
	await page("document.querySelector('button[aria-label=\"在新窗口中打开\"]').click()");
	await until("window.plume.panelWindows.list().then(list => list.length === 1)");
	const detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
	assert.ok(detached);
	await until(`document.querySelector('${editor}')?.textContent.includes(${JSON.stringify(draft)})`, detached);
	await page("document.querySelector('[data-nav=new-chat]').click()");
	await until("document.querySelector('[data-screen=empty]') !== null");
	// 点「收回」时独立窗口跟着关掉，这一次脚本的结果可能回不来（Render frame was disposed）；收回了没有由下一步核对。
	await page("document.querySelector('button[aria-label=收回]').click()", detached).catch(windowClosed);
	await until(`document.querySelector('${editor}')?.textContent.includes(${JSON.stringify(draft)})`);
	await page("document.querySelector('button[aria-label=\"在新窗口中打开\"]').click()");
	await until("window.plume.panelWindows.list().then(list => list.length === 1)");
	const crashed = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
	assert.ok(crashed);
	await until(`document.querySelector('${editor}')?.textContent.includes(${JSON.stringify(draft)})`, crashed);
	crashed.webContents.forcefullyCrashRenderer();
	await until(
		`document.querySelector('${editor}')?.textContent.includes(${JSON.stringify(draft)}) && window.plume.panelWindows.list().then(list => list.length === 0)`,
	);
	await writeFile(join(outDir, "smoke-panel-side-chat.png"), (await window.webContents.capturePage()).toPNG());
	await page(`document.querySelector('${editor}').focus()`);
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "a" });
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
	await until(`!document.querySelector('${editor}').textContent.includes(${JSON.stringify(draft)})`);
	console.log("PLUME_PANEL_SIDE_CHAT_SMOKE", JSON.stringify({ draft: true, dockSource: true, crashRecovery: true }));
}

/** 只放过窗口关掉带来的那一种失败，别的照常抛出。 */
export function windowClosed(error: unknown): void {
	if (!String(error).includes("Render frame was disposed")) throw error;
}
