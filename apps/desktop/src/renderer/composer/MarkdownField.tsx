import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { composingKey, OverlayScrollbar } from "@plume/ui";
import { useEffect, useRef, useState } from "react";
import type { ComboboxState } from "./CompletionPopup.tsx";
import { liveMarkdown } from "./live-markdown.ts";

/** 没传 extensions 时用同一个空数组：默认参数写 `[]` 每次渲染都是新的。 */
const NO_EXTENSIONS: Extension[] = [];

/** 从外面同步进来的改动（发送后清空、标记改名）：不是人改的字，不再报回 `onChange`。 */
const external = Annotation.define<true>();

/**
 * 编辑区的无障碍属性：带补全菜单的输入框是 combobox，菜单开着时指向菜单和选中的那一行；焦点一直在输入框里，读屏靠这几样念出选中项。
 */
function ariaAttributes(label: string, combobox: ComboboxState | undefined): Record<string, string> {
	if (!combobox) return { "aria-label": label };
	return {
		"aria-label": label,
		role: "combobox",
		"aria-autocomplete": "list",
		"aria-expanded": String(combobox.open),
		...(combobox.open ? { "aria-controls": combobox.id, "aria-activedescendant": `${combobox.id}-${combobox.active}` } : {}),
	};
}

/**
 * 主输入框里打字的那一块：值是 Markdown 原文，就地渲染见 `live-markdown.ts`。
 *
 * Enter 发送，Shift+Enter 换行（在列表、引用里接着写下一项的标记）。输入法组字时的按键一律不接：
 * 选词的那下 Enter 不是发送。高度随字长，到八行或窗口的三分之一为止，再多就在框里滚。
 */
export function MarkdownField({
	value,
	onChange,
	onSubmit,
	placeholder,
	label,
	extensions = NO_EXTENSIONS,
	editorRef,
	combobox,
}: {
	value: string;
	/** 人改了字。外面改的值同步进来时不调。 */
	onChange: (value: string) => void;
	onSubmit: () => void;
	placeholder: string;
	label: string;
	/** 建编辑器时加上的扩展（附件标记），之后不换。 */
	extensions?: Extension;
	/** 编辑器本身，给要读写光标的调用方。 */
	editorRef?: { current: EditorView | null };
	/** 有补全菜单（`/` 命令、`@` 提及）时给：眼下是哪张菜单、选中第几行。 */
	combobox?: ComboboxState;
}) {
	const host = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLElement | null>(null);
	const [view, setView] = useState<EditorView | null>(null);
	// 编辑器只建一次，回调和文案经 ref、compartment 换新，不重建（重建会丢光标和撤销历史）。
	const handlers = useRef({ onChange, onSubmit });
	handlers.current = { onChange, onSubmit };
	const prompt = useRef(new Compartment());
	const aria = useRef(new Compartment());

	useEffect(() => {
		const created = new EditorView({
			parent: host.current!,
			state: EditorState.create({
				doc: value,
				extensions: [
					history(),
					keymap.of([
						{
							key: "Enter",
							run: () => {
								handlers.current.onSubmit();
								return true;
							},
						},
						{ key: "Shift-Enter", run: (target) => insertNewlineContinueMarkup(target) || insertNewline(target) },
						{ key: "Backspace", run: deleteMarkupBackward },
						...defaultKeymap,
						...historyKeymap,
					]),
					EditorView.domEventHandlers({
						// 组字中的按键交给输入法，不进上面的快捷键，也不冒泡到外层。
						keydown: (event) => {
							if (!composingKey(event)) return false;
							event.stopPropagation();
							return true;
						},
					}),
					markdown({ base: markdownLanguage }),
					EditorView.lineWrapping,
					liveMarkdown,
					extensions,
					prompt.current.of(placeholderText(placeholder)),
					aria.current.of(EditorView.contentAttributes.of(ariaAttributes(label, combobox))),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !update.transactions.every((tr) => tr.annotation(external))) handlers.current.onChange(update.state.doc.toString());
					}),
				],
			}),
		});
		scroller.current = created.scrollDOM;
		if (editorRef) editorRef.current = created;
		setView(created);
		return () => {
			scroller.current = null;
			if (editorRef) editorRef.current = null;
			created.destroy();
		};
		// 只在挂上时建一次；之后的值经下面的 effect 同步。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, []);

	/*
	 * 外面改了值：只换变了的那一段，光标跟着原地映射——标记改名、落下新标记时，人正在打的字和光标都不动。
	 * 整段都换了的（发送后清空、填入一段建议）光标放到末尾。打字引起的改动这里比对相等，不会再写回去。
	 */
	useEffect(() => {
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		let from = 0;
		while (from < current.length && from < value.length && current[from] === value[from]) from++;
		let tail = 0;
		while (tail < current.length - from && tail < value.length - from && current[current.length - 1 - tail] === value[value.length - 1 - tail]) tail++;
		const whole = from === 0 && tail === 0;
		view.dispatch({
			changes: { from, to: current.length - tail, insert: value.slice(from, value.length - tail) },
			...(whole ? { selection: { anchor: value.length } } : {}),
			annotations: external.of(true),
		});
	}, [view, value]);

	useEffect(() => {
		view?.dispatch({ effects: prompt.current.reconfigure(placeholderText(placeholder)) });
	}, [view, placeholder]);
	const comboboxId = combobox?.id;
	const comboboxActive = combobox?.active;
	const comboboxOpen = combobox?.open;
	useEffect(() => {
		const state = comboboxId === undefined ? undefined : { id: comboboxId, active: comboboxActive ?? 0, open: comboboxOpen === true };
		view?.dispatch({ effects: aria.current.reconfigure(EditorView.contentAttributes.of(ariaAttributes(label, state))) });
	}, [view, label, comboboxId, comboboxActive, comboboxOpen]);

	return (
		<div className="plume-scroll-host relative">
			<div ref={host} className="plume-composer-field" />
			{view && <OverlayScrollbar viewport={scroller} orientation="vertical" />}
		</div>
	);
}
