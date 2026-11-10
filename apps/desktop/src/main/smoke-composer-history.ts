import { join } from "node:path";
import type { BrowserWindow } from "electron";

/**
 * 输入框的 ↑ ↓ 翻历史和侧栏的列表设置菜单，经真界面走一遍：空框按 ↑ 翻出最近说过的一句、框上写「历史 1/n」，
 * Esc 回到空框；侧栏「项目」标题上的列表设置菜单打得开、列出两种排序。
 */
export async function checkComposerHistory(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
}): Promise<void> {
	const { window, outDir, page, until, click, capture } = options;
	const chat = "[data-screen=chat]";
	// 输入框里的字，不算占位提示（它也画在 `.cm-content` 里）。
	const composerText = `[...document.querySelectorAll('main .cm-content .cm-line')].map((line) => { const copy = line.cloneNode(true); copy.querySelectorAll('.cm-placeholder').forEach((node) => node.remove()); return copy.textContent; }).join('\\n')`;
	const lastAsked = (await page(`[...document.querySelectorAll('${chat} [data-plume-quote=user]')].at(-1)?.textContent ?? ''`)) as string;
	if (!lastAsked.trim()) throw new Error("翻历史之前会话里应该已经有人说过的话");
	if (((await page(composerText)) as string).trim()) throw new Error("翻历史之前输入框应该是空的");

	await page(`document.querySelector('main .cm-content').focus()`);
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Up" });
	await until(`document.querySelector('[data-history]')?.textContent.includes('1/')`, "按 ↑ 以后框上写着「历史 1/n」");
	const picked = (await page(composerText)) as string;
	if (!picked.trim() || !lastAsked.includes(picked.trim())) throw new Error(`↑ 应该翻出最近说过的一句，实际是 ${JSON.stringify(picked)}`);
	await capture(window, join(outDir, "smoke-composer-history.png"));
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
	await until(`document.querySelector('[data-history]') === null && (${composerText}).trim() === ''`, "Esc 回到空框");

	// 列表设置：按钮在「项目」标题上，悬停时才显出来，点击不受透明度影响。
	await click('[data-plume-section-action] button[aria-label="列表设置"]');
	await until(
		`document.querySelector('[role=dialog][aria-label="列表设置"], [aria-label="列表设置"][role=menu]')?.textContent.includes('最近更新')`,
		"列表设置菜单打开",
	);
	await capture(window, join(outDir, "smoke-list-menu.png"));
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
	await until(`!document.body.textContent.includes('排序方式')`, "列表设置菜单收起");
}
