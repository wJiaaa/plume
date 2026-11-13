/**
 * 冒烟各段共用的几样操作。这些是冒烟偶发失败最多的地方，各段各写一份时同样的坑会一段段重踩：
 * - 点元素：同一个选择器常同时匹配藏着的那份（面板换走的子会话输入框、收着的菜单里还画着的上一份）和看得见的那份，
 *   只取第一个就点到了藏着的；还没能点（`disabled`）时点了等于没点；同时摆着两个都能点的，点了第一个未必是想验的那个。
 *   `clickVisible` 只点唯一一个看得见、能点的，没有就等。各段的点击都经这里（右键 `contextMenuVisible`、收尾时一次关掉
 *   好几个 `clickEachVisible`、要真鼠标的 `clickReal`），不各写一份「取第一个就点」。
 * - 真点击（经 DevTools 发鼠标事件）：窗口刚改过尺寸、页面刚滚过时，算好的落点可能已经不在目标上，这一下点空。
 *   `clickReal` 在目标上听 pointerdown，没收到才再点，收到就停，不会多发。
 * 页面里的等待都要有上限（`waitFor`），出错时带上在等什么。
 */

import type { BrowserWindow } from "electron";

type Page = (code: string) => Promise<unknown>;

/** `clickVisible` 一类辅助的 `text`：字符串要和去掉滚动复本后的文字整段相等，正则只要匹配上。 */
type TextMatch = string | RegExp;

/** 文字里含着 `text` 就算（按字面，不当正则），给 `clickVisible` 的 `text`。 */
export function containing(text: string): RegExp {
	return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

export async function waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > end) throw new Error(`等待超时：${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * 页面里找那个看得见、能点的元素（`text` 给了就再按文字比对），点它；还没有、或者同时有好几个都能点，就接着等，
 * 超时报出选择器、匹配到几个、各自为什么不算。
 *
 * 不退回去点藏着的：脚本里的 `click()` 不管 `inert`，收起的补全菜单里还画着的上一份条目照样会响应，点下去等于人碰不到的一下，
 * 这一步就在菜单真正打开之前判过了。藏着的东西要点，先让它露出来（打开菜单、给出地方），那正是这一步要验的。
 * 也不在几个都能点的里头随便挑第一个：人面前摆着两个一样的按钮，冒烟点了其中一个，验到的未必是想验的那个。
 * 选择器写到只剩一个（限定在哪一行、哪张卡片里）；确实要挑某一个（最后一条回复）就用 `clickVisibleIn` 把挑法写出来。
 */
export function clickVisible(page: Page, selector: string, text?: TextMatch, timeoutMs = 15_000): Promise<void> {
	return actVisible(page, all(selector), describe(selector, text), text, timeoutMs, "found.click()");
}

/**
 * 同 `clickVisible`，候选由页面里的一段表达式给出（得到元素的列表，`null` 跳过；表达式抛错当作还没有，接着等）：
 * 要挑某一个（`.slice(-1)` 最后一条回复）、按祖先的文字挑这样 CSS 选择器写不出来时用。`label` 只用在超时的报错里。
 */
export function clickVisibleIn(page: Page, candidates: string, label: string, text?: TextMatch, timeoutMs = 15_000): Promise<void> {
	return actVisible(page, candidates, describe(label, text), text, timeoutMs, "found.click()");
}

/**
 * 在那个看得见的元素上发一次右键（`contextmenu`），落点在它左上角往里 `dx`、`dy`（负数从右、下边往回算）。挑元素的规矩同
 * `clickVisible`：右键菜单是人对着看得见的那一行按出来的，脚本对着藏着的那份发事件，菜单照样弹，验不到这一行能不能右键。
 * 先滚进视野（`nearest`，已经看得见就不动），菜单才弹在人看得到的地方。不经 DevTools 真点，是因为几处右键要落在元素里
 * 某个具体位置（行的左边、链接的下沿）。
 */
export function contextMenuVisible(page: Page, selector: string, dx = 40, dy = 12, timeoutMs = 15_000): Promise<void> {
	return contextMenuVisibleIn(page, all(selector), selector, dx, dy, timeoutMs);
}

/** 同 `contextMenuVisible`，候选由页面里的一段表达式给出，用法同 `clickVisibleIn`。 */
export function contextMenuVisibleIn(page: Page, candidates: string, label: string, dx = 40, dy = 12, timeoutMs = 15_000): Promise<void> {
	const x = dx < 0 ? `r.right - ${-dx}` : `r.left + ${dx}`;
	const y = dy < 0 ? `r.bottom - ${-dy}` : `r.top + ${dy}`;
	const action = `found.scrollIntoView({ block: 'nearest' }); const r = found.getBoundingClientRect(); found.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`;
	return actVisible(page, candidates, `${label}（右键）`, undefined, timeoutMs, action);
}

/**
 * 收尾时一次点掉所有看得见、能点的（关掉开着的几个标签、几条提示条），返回点了几个。个数不定、可能一个都没有，所以不等、
 * 也不要求唯一；藏着的照样不点（人碰不到的那个不算关掉了，后面的步骤要自己核对剩下什么）。
 */
export async function clickEachVisible(page: Page, selector: string): Promise<number> {
	return (await page(`(() => {
		${WHY}
		const usable = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => why(element) === '');
		usable.forEach((element) => element.click());
		return usable.length;
	})()`)) as number;
}

/** 经 DevTools 真点 `selector` 选出的那一个（挑法同 `clickVisible`）的中心；目标没收到 pointerdown 就重新滚到中间再点，最多五次。 */
export function clickReal(window: BrowserWindow, selector: string, label = selector): Promise<void> {
	return pressReal(window, all(selector), label);
}

/** 同 `clickReal`，候选由页面里的一段表达式给出，用法同 `clickVisibleIn`（消息操作要点最后一条消息上的那个按钮）。 */
export function clickRealIn(window: BrowserWindow, candidates: string, label: string): Promise<void> {
	return pressReal(window, candidates, label);
}

async function pressReal(window: BrowserWindow, candidates: string, label: string): Promise<void> {
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	// 先按 clickVisible 的规矩挑出唯一一个，打上记号，后面的滚动、量位置、核对落点都对着它。
	await actVisible(page, candidates, label, undefined, 15_000, "found.setAttribute('data-smoke-press', '')");
	const target = "document.querySelector('[data-smoke-press]')";
	const listen = `addEventListener('pointerdown', (event) => { window.__smokePressed = ${target}?.contains(event.target) ? true : event.target.outerHTML.slice(0, 120); }, { capture: true, once: true })`;
	try {
		await page(`(() => { window.__smokePressed = null; ${listen}; })()`);
		for (let attempt = 0; attempt < 5; attempt++) {
			await page(`${target}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
			await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
			const point = await page<{ x: number; y: number }>(
				`(() => { const r = ${target}.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
			);
			// 先移过去：悬停才显出的按钮（消息上的编辑、分叉）人也是先把鼠标挪上去才点得到。
			await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
			await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
			if ((await page<true | string | null>("window.__smokePressed")) === true) return;
			await page(listen);
		}
		throw new Error(`点不到 ${label}（落在 ${await page<string | null>("window.__smokePressed")}）`);
	} finally {
		// 点下去可能关掉了这扇窗（「收回」），这时没有记号可清。
		await page("document.querySelectorAll('[data-smoke-press]').forEach((node) => node.removeAttribute('data-smoke-press'))").catch(() => {});
	}
}

const all = (selector: string) => `document.querySelectorAll(${JSON.stringify(selector)})`;

/** 给 `clickVisibleIn` 一类的候选：`selector` 匹配到的第一个（列表里排头那行）。它得自己看得见、能点，不往后找。 */
export function firstOf(selector: string): string {
	return `[...${all(selector)}].slice(0, 1)`;
}

/** 给 `clickVisibleIn` / `clickRealIn` 的候选：`selector` 匹配到的最后一个（最后一条消息上的按钮）。它得自己看得见、能点，不往前找。 */
export function lastOf(selector: string): string {
	return `[...${all(selector)}].slice(-1)`;
}

function describe(target: string, text: TextMatch | undefined): string {
	return `${target}${text === undefined ? "" : `「${text}」`}`;
}

/** 页面里的 `why(element)`：这个元素为什么人点不到，点得到时是空串。 */
const WHY = `const why = (element) => {
	if (element.getClientRects().length === 0) return '没有排版（display: none）';
	if (!element.checkVisibility({ visibilityProperty: true })) return '看不见（visibility）';
	if (element.closest('[inert]')) return '在 inert 里';
	if (element.closest('[hidden], [aria-hidden=true]')) return '在 hidden / aria-hidden 里';
	if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return 'disabled';
	return '';
};`;

async function actVisible(page: Page, candidates: string, label: string, text: TextMatch | undefined, timeoutMs: number, action: string): Promise<void> {
	const textMismatch =
		text === undefined
			? "false"
			: typeof text === "string"
				? `label(element) !== ${JSON.stringify(text)}`
				: `!new RegExp(${JSON.stringify(text.source)}, ${JSON.stringify(text.flags)}).test(label(element))`;
	const script = `(() => {
		const label = (element) => { const copy = element.cloneNode(true); copy.querySelectorAll('[data-plume-scroll-dup]').forEach(node => node.remove()); return copy.textContent.trim(); };
		${WHY}
		const reason = (element) => ${textMismatch} ? '文字是「' + label(element).slice(0, 40) + '」' : why(element);
		let matches;
		try { matches = [...(${candidates})].filter(Boolean); } catch (error) { return ['候选还拿不到：' + error.message]; }
		const usable = matches.filter((element) => reason(element) === '');
		if (usable.length !== 1) return matches.map((element) => (reason(element) || '能点，但能点的有 ' + usable.length + ' 个') + ' ' + element.outerHTML.slice(0, 120));
		const found = usable[0];
		${action};
		return true;
	})()`;
	const end = Date.now() + timeoutMs;
	for (;;) {
		const result = (await page(script)) as true | string[];
		if (result === true) return;
		if (Date.now() > end) {
			const detail = result.map((reason, index) => `  ${index + 1}. ${reason}`).join("\n");
			throw new Error(`点不到 ${label}：等了 ${timeoutMs / 1000}s，匹配到 ${result.length} 个，没有唯一一个看得见、能点的${detail ? `\n${detail}` : ""}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
