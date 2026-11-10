/**
 * 应用里每个普通文字框的右键菜单：剪切、复制、粘贴、全选。
 *
 * Electron 不画默认的右键菜单，没有这一份时，在输入框、搜索框、改名框上右键什么都不发生。挂在根上、监听
 * document 一次，而不是每个框各挂一个：框分散在几十个文件里，靠每处记得挂迟早漏。
 *
 * 输入框是 CodeMirror（`.cm-content` 是 contenteditable），也归这里管：它没有自己的编辑菜单。有自己菜单的东西
 * （附件标记、终端）在自己的 `onContextMenu` 里先 `preventDefault`，这里认这个记号让给它们，否则两份菜单同时想弹，
 * 后到的这一份会盖住先到的。只读的代码视图不是 contenteditable，不会被认成文字框。
 *
 * 改动经 `execCommand`：它已废弃，但它是脚本改输入框、又让 React 和 CodeMirror 都听得到的唯一办法。直接赋
 * `.value` 不派发任何事件，受控的框下一次渲染会把旧文字画回去。
 */

import { ContextMenu, MenuItem, MenuSeparator, shortcutLabel, useI18n } from "@plume/ui";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "@plume/ui/icons";
import { useEffect, useState } from "react";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

/** 装着别人可能想复制出来的文字的那几种 `<input>`。 */
const TEXTUAL = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

interface Aimed {
	point: { x: number; y: number };
	field: Field;
	/** 菜单打开时选区在哪：点菜单会把光标挪走。 */
	range: [number, number] | null;
	selected: string;
	editable: boolean;
}

function aim(event: MouseEvent): Aimed | null {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return null;
	const field = target.closest<Field>("input, textarea, [contenteditable='true']");
	if (!field) return null;
	if (field instanceof HTMLInputElement && !TEXTUAL.has(field.type)) return null;

	const box = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
	const range: [number, number] | null = box && box.selectionStart !== null && box.selectionEnd !== null ? [box.selectionStart, box.selectionEnd] : null;

	return {
		point: { x: event.clientX, y: event.clientY },
		field,
		range,
		selected: box && range ? box.value.slice(range[0], range[1]) : (window.getSelection()?.toString() ?? ""),
		editable: box ? !box.readOnly && !box.disabled : field.isContentEditable,
	};
}

export function InputMenu() {
	const { t } = useI18n();
	const [aimed, setAimed] = useState<Aimed | null>(null);

	useEffect(() => {
		const onMenu = (event: MouseEvent) => {
			// 谁先接下这次右键就归谁：这一份是兜底。
			if (event.defaultPrevented) return;
			const next = aim(event);
			if (!next) return;
			event.preventDefault();
			setAimed(next);
		};
		document.addEventListener("contextmenu", onMenu);
		return () => document.removeEventListener("contextmenu", onMenu);
	}, []);

	if (!aimed) return null;

	/** 光标放回原处，`execCommand` 才作用在右键的那段上。contenteditable 的选区由编辑器自己在聚焦时放回。 */
	const restore = () => {
		aimed.field.focus();
		if (aimed.range && (aimed.field instanceof HTMLInputElement || aimed.field instanceof HTMLTextAreaElement)) {
			aimed.field.setSelectionRange(aimed.range[0], aimed.range[1]);
		}
	};

	const copy = async (remove: boolean) => {
		await window.plume.files.copyText(aimed.selected);
		restore();
		if (remove) document.execCommand("delete");
	};

	const paste = async () => {
		const text = await window.plume.files.readText();
		restore();
		// 盖在放回的选区上插入，就是「粘贴替换选中的字」。
		if (text) document.execCommand("insertText", false, text);
	};

	const selectAll = () => {
		restore();
		if (aimed.field instanceof HTMLInputElement || aimed.field instanceof HTMLTextAreaElement) aimed.field.select();
		else document.execCommand("selectAll");
	};

	const has = aimed.selected.length > 0;

	return (
		<ContextMenu anchor={aimed.point} onClose={() => setAimed(null)} width="compact">
			<MenuItem icon={<Scissors {...ICON} />} hint={shortcutLabel("⌘X")} disabled={!has || !aimed.editable} onClick={() => void copy(true)}>
				{t("common.cut")}
			</MenuItem>
			<MenuItem icon={<Copy {...ICON} />} hint={shortcutLabel("⌘C")} disabled={!has} onClick={() => void copy(false)}>
				{t("common.copy")}
			</MenuItem>
			<MenuItem icon={<ClipboardPaste {...ICON} />} hint={shortcutLabel("⌘V")} disabled={!aimed.editable} onClick={() => void paste()}>
				{t("common.paste")}
			</MenuItem>
			<MenuSeparator />
			<MenuItem icon={<TextSelect {...ICON} />} hint={shortcutLabel("⌘A")} onClick={selectAll}>
				{t("common.selectAll")}
			</MenuItem>
		</ContextMenu>
	);
}
