import { type EditorState, type Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import { commandDecoration, type MenuCommand } from "./commands.ts";

/*
 * 输入框里的行首命令：`/name` 那一段画成命令的样子，还没写参数时后面跟一行灰字的参数提示。
 *
 * 菜单开着时方向键、回车、Tab、Esc 先给菜单（`handlers.key`，接下了返回 true），优先级高于发送和换行；
 * 光标、焦点一动就报给 `handlers.update`，由它算光标处在不在补全。哪些名字是命令由 `setCommandEntries` 送进来。
 */

export interface CommandHandlers {
	/** 菜单要不要接这个键；输入法组字时不会调。 */
	key: (key: "ArrowUp" | "ArrowDown" | "Enter" | "Tab" | "Escape") => boolean;
	/** `edited`：这次是字改了（不只是光标、焦点动了）。 */
	update: (view: EditorView, edited: boolean) => void;
}

export const setCommandEntries = StateEffect.define<readonly MenuCommand[]>();

/** 参数提示：绝对定位在命令后面，不占地方，提示再长也不会多出一行。 */
class Hint extends WidgetType {
	constructor(
		readonly text: string,
		readonly gap: boolean,
	) {
		super();
	}

	eq(other: Hint): boolean {
		return other.text === this.text && other.gap === this.gap;
	}

	toDOM(): HTMLElement {
		const hint = document.createElement("span");
		hint.className = "plume-command-hint";
		hint.setAttribute("aria-hidden", "true");
		hint.textContent = this.gap ? ` ${this.text}` : this.text;
		return hint;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function build(state: EditorState, entries: readonly MenuCommand[]): DecorationSet {
	const text = state.doc.toString();
	const found = commandDecoration(text, [...entries]);
	if (!found) return Decoration.none;
	const ranges = [Decoration.mark({ class: "plume-command-token" }).range(found.start, found.end)];
	if (found.hint) {
		// 提示接在命令后面那串空格之后：打了空格就紧跟着，没打就先空一格。
		let at = found.end;
		while (at < text.length && (text[at] === " " || text[at] === "\t")) at++;
		ranges.push(Decoration.widget({ widget: new Hint(found.hint, at === found.end), side: 1 }).range(at));
	}
	return Decoration.set(ranges);
}

export function commandMarks(handlers: { current: CommandHandlers }): Extension {
	const field = StateField.define<{ entries: readonly MenuCommand[]; decorations: DecorationSet }>({
		create: (state) => ({ entries: [], decorations: build(state, []) }),
		update(value, tr) {
			let entries = value.entries;
			for (const effect of tr.effects) if (effect.is(setCommandEntries)) entries = effect.value;
			if (entries === value.entries && !tr.docChanged) return value;
			return { entries, decorations: build(tr.state, entries) };
		},
		provide: (self) => EditorView.decorations.from(self, (value) => value.decorations),
	});
	return [field, completionKeys(handlers)];
}

export function completionKeys(handlers: { current: CommandHandlers }): Extension {
	const take = (key: Parameters<CommandHandlers["key"]>[0]) => (view: EditorView) => !view.composing && handlers.current.key(key);
	return [
		Prec.highest(
			keymap.of([
				{ key: "ArrowUp", run: take("ArrowUp") },
				{ key: "ArrowDown", run: take("ArrowDown") },
				{ key: "Enter", run: take("Enter") },
				{ key: "Tab", run: take("Tab") },
				{ key: "Escape", run: take("Escape") },
			]),
		),
		EditorView.updateListener.of((update) => {
			if (update.docChanged || update.selectionSet || update.focusChanged) handlers.current.update(update.view, update.docChanged);
		}),
	];
}
