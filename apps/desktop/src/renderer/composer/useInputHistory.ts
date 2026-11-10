/**
 * 方向键往回翻自己说过的话。
 *
 * 输入框空着、也没挂附件时按 ↑ 翻出最近说过的一句，连同它当初带的附件；再按 ↑ 往前翻，↓ 往回，翻过最近的一条
 * 回到空输入框；翻着的时候按 Esc 也直接回到空输入框。框里有字或挂着附件时，方向键只管光标，一个都不拦：
 * 打字时按方向键冲掉正在打的字，比少一个快捷键糟得多。翻出来的是多行时，光标还没到那一头，方向键先在行间走。
 */

import type { Message, UserMessage } from "@plume/contract";
import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import { draftFromMessage } from "../conversation/revert-draft.ts";
import type { DraftAttachment } from "./attachments/read.ts";

/** 人自己发过的消息，最近的在前。界面替人说的（「继续」、续写的催促）是 `synthetic`，人没说过，不翻出来。 */
function spokenByPerson(messages: readonly Message[]): UserMessage[] {
	return messages.filter((message): message is UserMessage => message.role === "user" && !message.synthetic).reverse();
}

export function useInputHistory({
	messages,
	attachments,
	onPick,
	editor,
	resetKey,
	value,
}: {
	messages: readonly Message[];
	/** 输入框里此刻挂着几个附件：挂着的时候 ↑ 不翻。 */
	attachments: number;
	/** 翻出来的那一条交回输入框：字和附件整份换上，不追加——连按两次 ↑ 不该攒出一袋没人发过的东西。 */
	onPick: (text: string, attachments: DraftAttachment[], references?: UserMessage["sessionRefs"]) => void;
	editor: { current: EditorView | null };
	/** 换了对话就从头开始。 */
	resetKey: string;
	value: string;
}): { extension: ReturnType<typeof keymap.of>; position: { current: number; total: number } | null } {
	const entries = useMemo(() => spokenByPerson(messages), [messages]);
	/** -1 是在空草稿上，0 是最近说过的那一句。 */
	const [index, setIndex] = useState(-1);
	/** 最后一次按到的是哪一条：附件的像素要读回来，读回来时已经翻走了就不再装进去。 */
	const latest = useRef(-1);
	/** 装进输入框的那段字；还在读附件时是 undefined。 */
	const picked = useRef<string | undefined>(undefined);

	useEffect(() => {
		setIndex(-1);
		latest.current = -1;
		picked.current = undefined;
	}, [resetKey]);

	/*
	 * 框里的字一旦不再是翻出来的那条，就不算在翻了。盯 `value` 而不是等人敲键：发送、换会话时恢复草稿、
	 * 插件填进来的字都不经过人的输入。比的是装进去的那段字，所以自己装字的那一次不会被当成「别处改的」。
	 */
	useEffect(() => {
		if (index !== -1 && picked.current !== undefined && value !== picked.current) {
			setIndex(-1);
			latest.current = -1;
			picked.current = undefined;
		}
	}, [value, index]);

	const apply = (next: number) => {
		setIndex(next);
		latest.current = next;
		picked.current = undefined;
		const message = entries[next];
		if (!message) {
			onPick("", []);
			return;
		}
		void draftFromMessage(message).then((draft) => {
			if (latest.current !== next) return;
			picked.current = draft.text;
			onPick(draft.text, draft.attachments, message.sessionRefs);
			// 翻出来的话十有八九要改两个字再发，光标落在最后。等这一帧把字写进编辑器再放。
			requestAnimationFrame(() => {
				const view = editor.current;
				if (view && latest.current === next) view.dispatch({ selection: { anchor: view.state.doc.length } });
			});
		});
	};

	const handlers = useRef({ entries, index, attachments, apply });
	handlers.current = { entries, index, attachments, apply };

	const extension = useMemo(() => {
		const arrow = (up: boolean) => (view: EditorView) => {
			const { entries, index, attachments, apply } = handlers.current;
			if (view.composing || entries.length === 0) return false;
			const selection = view.state.selection.main;
			// 手上正选着一段字，方向键是用来收放选区的。
			if (!selection.empty) return false;
			if (index === -1) {
				if (!up || view.state.doc.length > 0 || attachments > 0) return false;
				apply(0);
				return true;
			}
			const doc = view.state.doc;
			if (up ? doc.lineAt(selection.head).number > 1 : doc.lineAt(selection.head).number < doc.lines) return false;
			if (up) {
				// 已经是最早的一条：让键透过去。
				if (index + 1 >= entries.length) return false;
				apply(index + 1);
			} else apply(index - 1);
			return true;
		};
		// 排在 `/` 菜单之后：菜单开着时方向键归菜单。
		return Prec.high(
			keymap.of([
				{ key: "ArrowUp", run: arrow(true) },
				{ key: "ArrowDown", run: arrow(false) },
				{
					key: "Escape",
					run: (view) => {
						if (view.composing || handlers.current.index === -1) return false;
						handlers.current.apply(-1);
						return true;
					},
				},
			]),
		);
	}, []);

	return { extension, position: index >= 0 ? { current: index + 1, total: entries.length } : null };
}
