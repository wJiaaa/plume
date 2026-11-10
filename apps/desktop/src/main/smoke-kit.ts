/**
 * 冒烟各段共用的几样操作。这些是冒烟偶发失败最多的地方，各段各写一份时同样的坑会一段段重踩：
 * - 点元素：同一个选择器常同时匹配藏着的那份（面板换走的子会话输入框、收着的菜单）和看得见的那份，
 *   只取第一个就点到了藏着的；还没能点（`disabled`）时点了等于没点。`clickVisible` 先找看得见、能点的那个。
 * - 真点击（经 DevTools 发鼠标事件）：窗口刚改过尺寸、页面刚滚过时，算好的落点可能已经不在目标上，这一下点空。
 *   `clickReal` 在目标上听 pointerdown，没收到才再点，收到就停，不会多发。
 * 页面里的等待都要有上限（`waitFor`），出错时带上在等什么。
 */

import type { BrowserWindow } from "electron";

export async function waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > end) throw new Error(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * 页面里找一个看得见、能点的元素（`text` 给了就再按去掉滚动复本后的文字比对），点它。
 * 一个看得见的都没有时退回第一个匹配的：有的步骤本来就点藏着的东西（收着的菜单项）。点不到返回 false。
 */
export function clickVisibleScript(selector: string, text?: string): string {
	return `(() => {
		const label = (element) => { const copy = element.cloneNode(true); copy.querySelectorAll('[data-plume-scroll-dup]').forEach(node => node.remove()); return copy.textContent.trim(); };
		const matches = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => ${text === undefined ? "true" : `label(element) === ${JSON.stringify(text)}`});
		const usable = (element) => element.getClientRects().length > 0 && !element.closest('[inert], [hidden], [aria-hidden=true]') && !element.disabled;
		const found = matches.find(usable) ?? matches[0];
		if (!found) return false;
		found.click();
		return true;
	})()`;
}

/** 经 DevTools 真点 `selector` 的中心；目标没收到 pointerdown 就重新滚到中间再点，最多五次。 */
export async function clickReal(window: BrowserWindow, selector: string, label = selector): Promise<void> {
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const target = `document.querySelector(${JSON.stringify(selector)})`;
	const listen = `addEventListener('pointerdown', (event) => { window.__smokePressed = ${target}?.contains(event.target) ? true : event.target.outerHTML.slice(0, 120); }, { capture: true, once: true })`;
	await page(`(() => { window.__smokePressed = null; ${listen}; })()`);
	for (let attempt = 0; attempt < 5; attempt++) {
		await page(`${target}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		const point = await page<{ x: number; y: number }>(
			`(() => { const r = ${target}.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
		);
		await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
		await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
		if ((await page<true | string | null>("window.__smokePressed")) === true) return;
		await page(listen);
	}
	throw new Error(`点不到 ${label}（落在 ${await page<string | null>("window.__smokePressed")}）`);
}
