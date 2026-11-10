import { type EditorState, type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { scanPlaceholders } from "./attachments/placeholders.ts";
import type { FileKind } from "./attachments/file-kind.ts";
import { MarkGlyph } from "./attachments/FileKindIcon.tsx";
import { pickedFrom, type PickedFile } from "./attachments/picked.ts";

/*
 * 输入框里的附件标记：正文里的 `【图片 1】` 画成一枚标签。
 *
 * 字仍是原文，标签是一个整体：`Decoration.replace` 整段换成一个部件，`atomicRanges` 让光标跳过它、退格和 Delete
 * 一下吃掉整枚——一格一格地退，它会先变成 `【图片 1`，配不上任何附件，附件也不会跟着卸下来。优先级高于
 * Markdown 的就地渲染，标签里面的字不会被当成 Markdown 藏掉标记。
 *
 * 哪些 `【…】` 是标记由附件清单决定（经 `setMarkFiles` 送进来），认不出的原样留着：中文里方括号是普通标点。
 * 附件跟着标记卸下、重新编号这些在 `useComposerAttachments` 里，这里只管画和收事件。
 */

/** 一枚标记认得的那份附件。 */
export interface MarkFile {
	name: string;
	/** 标记里写的名字：「图片 1」或者文件名。 */
	label: string;
	kind: FileKind;
	/** 内容和像素都没进提示词，模型只拿到一个名字：图标淡一档。文件夹送过去的是路径，不算。 */
	bodiless: boolean;
}

export interface MarkHandlers {
	/** 贴进来的文件。 */
	onFiles: (picked: PickedFile[]) => void;
	/** 点中第 n 枚标记。 */
	onOpen: (index: number, rect: DOMRect) => void;
	/** 右键第 n 枚标记。 */
	onMenu: (index: number, point: { x: number; y: number }) => void;
}

export const setMarkFiles = StateEffect.define<readonly MarkFile[]>();

/** 第几枚：按它在正文里的位置配回扫描结果。部件上不记序号，前面删掉一枚它就过期了。 */
function indexAt(view: EditorView, dom: HTMLElement, files: readonly MarkFile[]): number {
	const pos = view.posAtDOM(dom);
	return scanPlaceholders(view.state.doc.toString(), [...files]).findIndex((hit) => pos >= hit.start && pos < hit.end);
}

export function attachmentMarks(handlers: { current: MarkHandlers }): Extension {
	class Mark extends WidgetType {
		constructor(
			readonly file: MarkFile,
			readonly text: string,
		) {
			super();
		}

		eq(other: Mark): boolean {
			return other.text === this.text && other.file.kind === this.file.kind && other.file.bodiless === this.file.bodiless && other.file.name === this.file.name;
		}

		/*
		 * 方括号留在标签里、画成透明：头一个那一格给图标住，收尾那个让出大半格当标签后面的空。图标、留白怎么分见
		 * composer.css 的 `.plume-token-body`；输入框和气泡里的标签是同一个样子。
		 */
		toDOM(view: EditorView): HTMLElement {
			const token = document.createElement("span");
			token.className = "plume-attachment-token";
			token.dataset.kind = this.file.kind;
			token.dataset.glyph = "";
			if (this.file.bodiless) token.dataset.bodiless = "";
			const body = token.appendChild(document.createElement("span"));
			body.className = "plume-token-body";
			const paint = body.appendChild(document.createElement("span"));
			paint.className = "plume-token-paint";
			const open = paint.appendChild(document.createElement("span"));
			open.className = "plume-token-bracket";
			open.textContent = this.text.slice(0, 1);
			open.insertAdjacentHTML("beforeend", renderToStaticMarkup(createElement(MarkGlyph, { name: this.file.name, kind: this.file.kind })));
			const name = paint.appendChild(document.createElement("span"));
			name.className = "plume-token-name";
			name.textContent = this.text.slice(1, -1);
			const close = body.appendChild(document.createElement("span"));
			close.className = "plume-token-bracket";
			close.textContent = this.text.slice(-1);

			// 按下不挪光标：点标签是要打开它，不是要把光标放进一个整体里。
			token.addEventListener("mousedown", (event) => event.preventDefault());
			token.addEventListener("click", (event) => {
				const index = indexAt(view, token, view.state.field(marks).files);
				if (index < 0) return;
				event.preventDefault();
				handlers.current.onOpen(index, token.getBoundingClientRect());
			});
			token.addEventListener("contextmenu", (event) => {
				const index = indexAt(view, token, view.state.field(marks).files);
				if (index < 0) return;
				event.preventDefault();
				handlers.current.onMenu(index, { x: event.clientX, y: event.clientY });
			});
			return token;
		}
	}

	const build = (state: EditorState, files: readonly MarkFile[]): DecorationSet =>
		Decoration.set(
			scanPlaceholders(state.doc.toString(), [...files]).map(({ start, end, file }) =>
				Decoration.replace({ widget: new Mark(file, state.doc.sliceString(start, end)) }).range(start, end),
			),
		);

	const marks = StateField.define<{ files: readonly MarkFile[]; decorations: DecorationSet }>({
		create: (state) => ({ files: [], decorations: build(state, []) }),
		update(value, tr) {
			let files = value.files;
			for (const effect of tr.effects) if (effect.is(setMarkFiles)) files = effect.value;
			if (files === value.files && !tr.docChanged) return value;
			return { files, decorations: build(tr.state, files) };
		},
	});

	return [
		marks,
		Prec.high(EditorView.decorations.from(marks, (value) => value.decorations)),
		EditorView.atomicRanges.of((view) => view.state.field(marks).decorations),
		EditorView.domEventHandlers({
			/*
			 * 贴进来的是文件就只是文件。macOS 复制截图时剪贴板里除了图还有一个指向它的 `file://` 地址，照常粘贴会把
			 * 那串路径也打进消息里。没有文件的粘贴是普通文字，照常走。
			 */
			paste: (event) => {
				const files = event.clipboardData?.files;
				if (!files || files.length === 0) return false;
				event.preventDefault();
				handlers.current.onFiles(pickedFrom(files));
				return true;
			},
			// 拖进来的文件归输入框外面收（`ComposerShell`），编辑器自己会把文件当文本读进来，这里拦下它，事件照常冒上去。
			drop: (event) => Boolean(event.dataTransfer?.types.includes("Files")),
		}),
	];
}
