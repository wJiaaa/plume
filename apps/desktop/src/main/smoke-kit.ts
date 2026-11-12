/**
 * 冒烟各段共用的几样操作。这些是冒烟偶发失败最多的地方，各段各写一份时同样的坑会一段段重踩：
 * - 点元素：同一个选择器常同时匹配藏着的那份（面板换走的子会话输入框、收着的菜单里还画着的上一份）和看得见的那份，
 *   只取第一个就点到了藏着的；还没能点（`disabled`）时点了等于没点。`clickVisible` 只点看得见、能点的那个，没有就等。
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
 * 页面里找一个看得见、能点的元素（`text` 给了就再按去掉滚动复本后的文字比对），点它；还没有就接着等，超时报出选择器、
 * 匹配到几个、各自为什么不算。
 *
 * 不退回去点藏着的：脚本里的 `click()` 不管 `inert`，收起的补全菜单里还画着的上一份条目照样会响应，点下去等于人碰不到的一下，
 * 这一步就在菜单真正打开之前判过了。藏着的东西要点，先让它露出来（打开菜单、给出地方），那正是这一步要验的。
 */
export async function clickVisible(page: (code: string) => Promise<unknown>, selector: string, text?: string, timeoutMs = 15_000): Promise<void> {
	const script = `(() => {
		const label = (element) => { const copy = element.cloneNode(true); copy.querySelectorAll('[data-plume-scroll-dup]').forEach(node => node.remove()); return copy.textContent.trim(); };
		const why = (element) => {
			if (${text === undefined ? "false" : `label(element) !== ${JSON.stringify(text)}`}) return '文字是「' + label(element).slice(0, 40) + '」';
			if (element.getClientRects().length === 0) return '没有排版（display: none）';
			if (!element.checkVisibility({ visibilityProperty: true })) return '看不见（visibility）';
			if (element.closest('[inert]')) return '在 inert 里';
			if (element.closest('[hidden], [aria-hidden=true]')) return '在 hidden / aria-hidden 里';
			if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return 'disabled';
			return '';
		};
		const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
		const found = matches.find((element) => why(element) === '');
		if (!found) return matches.map((element) => why(element) + ' ' + element.outerHTML.slice(0, 120));
		found.click();
		return true;
	})()`;
	const end = Date.now() + timeoutMs;
	for (;;) {
		const result = (await page(script)) as true | string[];
		if (result === true) return;
		if (Date.now() > end) {
			const target = `${selector}${text === undefined ? "" : `「${text}」`}`;
			const detail = result.map((reason, index) => `  ${index + 1}. ${reason}`).join("\n");
			throw new Error(`点不到 ${target}：等了 ${timeoutMs / 1000}s，匹配到 ${result.length} 个，没有看得见、能点的${detail ? `\n${detail}` : ""}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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
