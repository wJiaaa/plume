/**
 * 滚到几行并让它们亮一下：回复里 `a.ts:42` 那种链接点过来时，文件面板要停在那里。
 *
 * 高亮是一层行装饰，样式和淡出在 `files.css` 的 `.cm-file-reveal`。动画结束后把装饰摘掉，不留在文档上：
 * 它留着的话，那一行滚出视口再滚回来时 CodeMirror 重建了行元素，动画会从头再亮一遍。
 */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

import type { LineRange } from "./open-file.ts";

/** 停留加淡出：和 `.cm-file-reveal` 的 1400ms 停留、两档 slow 的淡出对上，再多留一点让最后一帧画完。 */
const FLASH_MS = 2200;

const flash = StateEffect.define<DecorationSet>();
const mark = Decoration.line({ class: "cm-file-reveal" });

const flashed = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(set, tr) {
		for (const effect of tr.effects) if (effect.is(flash)) return effect.value;
		return set.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});

export const revealHighlight: Extension = flashed;

/**
 * 光标放到第一行，单行居中，一段从顶上留出几行开始摆——一段居中的话，长的那段开头会被推出视口。
 *
 * 行号超出文件（模型记的是改之前的文件）就什么都不做，文件照常从头打开。
 */
export function revealLines(view: EditorView, lines: LineRange): void {
	const doc = view.state.doc;
	if (lines.from > doc.lines) return;
	const first = doc.line(lines.from);
	const last = Math.min(lines.to, doc.lines);
	const marks = [];
	for (let n = first.number; n <= last; n++) marks.push(mark.range(doc.line(n).from));
	view.dispatch({
		selection: { anchor: first.from },
		effects: [flash.of(Decoration.set(marks)), EditorView.scrollIntoView(first.from, last === first.number ? { y: "center" } : { y: "start", yMargin: 60 })],
	});
	const shown = view.state.field(flashed);
	/*
	 * 视图换了文件被销毁，或这期间又跳了一次，这一次的高亮都已经不归它摘。销毁的视图 `dom` 已经离开
	 * 文档；面板只是被藏起来时它还在，照样摘。
	 */
	setTimeout(() => {
		if (view.dom.isConnected && view.state.field(flashed) === shown) view.dispatch({ effects: flash.of(Decoration.none) });
	}, FLASH_MS);
}
