/**
 * CodeMirror 自带查找框的文案和图标。
 *
 * 那个框由 CodeMirror 自己建，塞不进 React 子元素，所以按钮的图标在这里写成标记，字从同一套词条里取。
 */

import { translate } from "@plume/ui";

/**
 * 和界面别处的 lucide 图标同一套、同样的几何：借正文字体里的 `↓`、`≡` 放在真图标旁边，读起来像另一个程序的工具栏。
 * 描边的写法在 `files.css` 里。
 */
const icon = (paths: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24">${paths}</svg>`;

const BUTTON_ICONS: Record<string, string> = {
	next: icon('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
	prev: icon('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
	select: icon('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
	close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

/** 三个选项（区分大小写、正则、全词），按 CodeMirror 摆放的顺序。 */
const OPTION_ICONS = [
	icon('<path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16"/><path d="M22 9v7"/><path d="M3.304 13h6.392"/><circle cx="18.5" cy="12.5" r="3.5"/>'),
	icon(
		'<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/>',
	),
	icon(
		'<circle cx="7" cy="12" r="3"/><path d="M10 9v6"/><circle cx="17" cy="12" r="3"/><path d="M14 7v8"/><path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"/>',
	),
];

/**
 * 给查找框换上图标和悬停提示。
 *
 * 按钮只剩图标，字要有地方放：`phrases` 只管看得见的字，提示靠 `data-plume-tip`，它本来就是为 React 树外的东西留的。
 * 编辑器底下每变一次都会调一遍，每一步先看做过没有。
 */
export function labelSearchPanel(element: HTMLElement): void {
	const panel = element.querySelector<HTMLElement>(".cm-panel.cm-search");
	// 标记是空串，按「有没有」判断：按真假判断永远当作没做过，每次都改一遍 DOM，又触发盯着它的 MutationObserver，页面卡死。
	if (!panel || panel.dataset.plumeLabelled !== undefined) return;
	panel.dataset.plumeLabelled = "";
	// 和菜单、浮层同一种卡片，从钉着的那个角长出来。
	panel.classList.add("plume-menu-card", "plume-pop-in");

	const tips: Record<string, string> = {
		next: translate("common.next"),
		prev: translate("common.previous"),
		select: translate("find.selectAll"),
		close: translate("find.closeEsc"),
	};
	for (const [name, tip] of Object.entries(tips)) {
		const button = panel.querySelector<HTMLElement>(`button[name=${name}]`);
		if (!button) continue;
		// 图标换掉了字，字留作无障碍名。
		button.setAttribute("aria-label", tip);
		button.dataset.plumeTip = tip;
		button.innerHTML = BUTTON_ICONS[name] ?? "";
	}

	const hints = [translate("find.matchCase"), translate("find.regexFull"), translate("find.wholeWord")];
	panel.querySelectorAll<HTMLElement>("label").forEach((option, index) => {
		const hint = hints[index];
		if (!hint) return;
		// 选项是包着复选框的 label：字拿掉换成图标，名字交给复选框本身，状态也还在它身上。
		for (const node of [...option.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
		option.querySelector("input")?.setAttribute("aria-label", hint);
		option.dataset.plumeTip = hint;
		option.insertAdjacentHTML("beforeend", OPTION_ICONS[index] ?? "");
	});
}

/**
 * CodeMirror 自己界面上的字，换成窗口的语言。`$` 是它的占位符。
 *
 * 是函数不是表：模块级的对象会定死在 import 那一刻的语言上。编辑器建起来时才取。
 */
export function searchPhrases(): Record<string, string> {
	return {
		Find: translate("find.find"),
		next: translate("common.next"),
		previous: translate("common.previous"),
		all: translate("common.all"),
		"match case": translate("find.matchCase"),
		"by word": translate("find.wholeWord"),
		regexp: translate("find.regex"),
		close: translate("common.close"),
		"current match": translate("find.currentMatch"),
		"on line": translate("common.line"),
	};
}
