import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { AgentAvatar, type Avatar } from "@plume/ui";
import { createRoot, type Root } from "react-dom/client";
import { completionKeys, type CommandHandlers } from "./command-marks.ts";
import { findMentionRanges } from "./mentions.ts";

export const setMentionAvatars = StateEffect.define<Map<string, Avatar>>();
/**
 * 头像的 React 根按 DOM 记，不记在挂件上：`eq` 为真时 CodeMirror 沿用旧 DOM、换上新的挂件实例，销毁时调的是新实例，
 * 记在实例上的根就找不到了、永远卸不掉。
 */
const roots = new WeakMap<HTMLElement, Root>();
class Face extends WidgetType {
	constructor(
		readonly name: string,
		readonly avatar: Avatar,
	) {
		super();
	}
	eq(other: Face): boolean {
		return this.name === other.name && this.avatar.shape === other.avatar.shape && this.avatar.color === other.avatar.color;
	}
	toDOM(): HTMLElement {
		const element = document.createElement("span");
		element.className = "plume-mention-face";
		element.setAttribute("aria-hidden", "true");
		const root = createRoot(element);
		roots.set(element, root);
		root.render(<AgentAvatar avatar={this.avatar} seed={this.name} size={14} interactive={false} />);
		return element;
	}
	destroy(dom: HTMLElement): void {
		const root = roots.get(dom);
		roots.delete(dom);
		// 编辑器可能在 React 提交阶段销毁，等该阶段结束再卸载头像。
		queueMicrotask(() => root?.unmount());
	}
}
export function mentionMarks(handlers: { current: CommandHandlers }): Extension {
	const build = (text: string, avatars: Map<string, Avatar>) =>
		Decoration.set(
			findMentionRanges(text).flatMap((range) => {
				const face = avatars.get(range.inner);
				return [
					Decoration.mark({ class: "plume-command-token" }).range(range.start, range.end),
					...(face ? [Decoration.replace({ widget: new Face(range.inner, face) }).range(range.start, range.start + 1)] : []),
				];
			}),
			true,
		);
	const field = StateField.define({
		create: (state) => {
			const avatars = new Map<string, Avatar>();
			return { avatars, decorations: build(state.doc.toString(), avatars) };
		},
		update(value, tr) {
			let avatars = value.avatars;
			for (const effect of tr.effects) if (effect.is(setMentionAvatars)) avatars = effect.value;
			return !tr.docChanged && avatars === value.avatars ? value : { avatars, decorations: build(tr.state.doc.toString(), avatars) };
		},
		provide: (self) => EditorView.decorations.from(self, (value) => value.decorations),
	});
	return [field, completionKeys(handlers)];
}
