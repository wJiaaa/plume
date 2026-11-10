import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";

export function checkSidebarResize(window: BrowserWindow, screenshot: string): Promise<void> {
	return checkResize(window, screenshot, "sidebar");
}

export function checkPanelResize(window: BrowserWindow, screenshot: string): Promise<void> {
	return checkResize(window, screenshot, "panel");
}

/** 用真实鼠标验证把手的绘制、跟随和离开，避免只测到宽度变化却漏掉指示器。 */
async function checkResize(window: BrowserWindow, screenshot: string, pane: "sidebar" | "panel"): Promise<void> {
	const web = window.webContents;
	const panel = pane === "panel";
	const selector = `[role="separator"][aria-label="${panel ? "调整面板宽度" : "调整侧边栏宽度"}"]`;
	const beyondX = panel ? ((await web.executeJavaScript("innerWidth - 100")) as number) : 100;
	const growKey = panel ? "Left" : "Right";
	const handle = `document.querySelector(${JSON.stringify(selector)})`;
	const settle = () =>
		web.executeJavaScript(`(async () => {
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await Promise.all([...${handle}.getAnimations({ subtree: true })].map(animation => animation.finished.catch(() => {})));
	})()`);
	const state = () =>
		web.executeJavaScript(`(() => {
		const handle = ${handle}, rect = handle.getBoundingClientRect();
		const grip = handle.querySelector('span'), box = grip?.getBoundingClientRect();
		return {
			x: ${panel ? "rect.right - 1" : "rect.left + 1"}, width: Number(handle.getAttribute('aria-valuenow')),
			min: Number(handle.getAttribute('aria-valuemin')), max: Number(handle.getAttribute('aria-valuemax')),
			grip: box ? { width: box.width, height: box.height, y: box.top + box.height / 2,
				active: grip.classList.contains('bg-accent'), color: getComputedStyle(grip).backgroundColor,
				inGap: ${panel ? "box.left >= document.querySelector('main > div').getBoundingClientRect().right && box.right <= document.querySelector('[data-panel-area]').getBoundingClientRect().left" : "true"},
				visible: document.elementFromPoint(box.left + 1, box.top + 1) === grip } : null,
		};
	})()`) as Promise<{
			x: number;
			width: number;
			min: number;
			max: number;
			grip: null | { width: number; height: number; y: number; active: boolean; color: string; inGap: boolean; visible: boolean };
		}>;
	const move = async (x: number, y: number) => {
		web.sendInputEvent({ type: "mouseMove", x: Math.round(x), y });
		await settle();
	};

	await move(600, 200);
	const initial = await state();
	assert.equal(initial.grip, null, "指针离开时不显示把手");
	await move(initial.x, 200);
	const hover = await state();
	assert.ok(hover.grip?.visible, "悬停时把手应可见且不被覆盖");
	assert.equal(hover.grip.width, 3);
	assert.equal(hover.grip.height, 30);
	assert.equal(hover.grip.y, 200);
	assert.equal(hover.grip.active, false);
	assert.ok(hover.grip.inGap, "面板指示器应落在两张卡片的间隙内");

	web.sendInputEvent({ type: "mouseDown", x: Math.round(initial.x), y: 200, button: "left", clickCount: 1 });
	await settle();
	assert.equal((await state()).width, initial.width, "按下时宽度不跳变");
	await move(initial.x + (panel ? -50 : 50), 260);
	const dragging = await state();
	assert.equal(dragging.width, Math.min(initial.max, initial.width + 50));
	assert.ok(dragging.grip?.visible && dragging.grip.active, "拖动时显示强调色把手");
	assert.equal(dragging.grip.y, 260);
	assert.ok(dragging.grip.inGap, "拖动时面板边缘必须跟上指示器");
	assert.notEqual(dragging.grip.color, hover.grip.color);
	await writeFile(screenshot, (await web.capturePage()).toPNG());

	// 越过宽度下限后指针离开抓取区，把手仍需跟随；在外面松开才隐藏。
	await move(beyondX, 300);
	const beyond = await state();
	assert.equal(beyond.width, initial.min);
	assert.ok(beyond.grip?.active);
	assert.equal(beyond.grip.y, 300);
	web.sendInputEvent({ type: "mouseUp", x: beyondX, y: 300, button: "left", clickCount: 1 });
	await settle();
	assert.equal((await state()).grip, null);

	await web.executeJavaScript(`${handle}.focus()`);
	web.sendInputEvent({ type: "keyDown", keyCode: growKey });
	web.sendInputEvent({ type: "keyUp", keyCode: growKey });
	await settle();
	assert.equal((await state()).width, initial.min + 16, "键盘调宽仍可用");
	const resized = await state();
	await move(resized.x, 200);
	web.sendInputEvent({ type: "mouseDown", x: Math.round(resized.x), y: 200, button: "left", clickCount: 2 });
	web.sendInputEvent({ type: "mouseUp", x: Math.round(resized.x), y: 200, button: "left", clickCount: 2 });
	await settle();
	if (panel) {
		const available = (await web.executeJavaScript("document.querySelector('[data-panel-layout]').clientWidth")) as number;
		assert.equal((await state()).width, Math.max(initial.min, Math.min(initial.max, Math.round(available / 2))), "面板双击均分可用空间");
	} else assert.equal((await state()).width, initial.width, "双击恢复默认宽度");
	await move(600, 200);
	assert.equal((await state()).grip, null);
}
