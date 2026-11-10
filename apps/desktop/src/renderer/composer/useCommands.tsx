import type { CommandContext, CommandEntry } from "@plume/contract";
import { useI18n } from "@plume/ui";
import type { EditorView } from "@codemirror/view";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMarketStore } from "../market/store.ts";
import { type CommandHandlers, commandMarks, setCommandEntries } from "./command-marks.ts";
import { CommandMenu } from "./CommandMenu.tsx";
import type { ComboboxState } from "./CompletionPopup.tsx";
import { type CommandCompletion, commandCompletion, type MenuCommand, menuCommands, productCommands, rankCommands, resolveCommand } from "./commands.ts";

/**
 * 主输入框的 `/` 命令：列命令、算光标处在不在补全、菜单的高亮和键盘、选中后把那一段换成命令名。
 *
 * 名单每次打开、收起菜单，和插件有变动时都重新问一遍 agent（命令文件改了不用重开）；问不到时只弹一句，菜单里照样有产品自己的命令。
 * 发送时用 `fresh()` 再问一遍，展开用的是那一刻磁盘上的命令。
 */
export function useCommands({
	editor,
	cwd,
	sessionId,
	list,
	onSubmit,
	onError,
}: {
	editor: { current: EditorView | null };
	cwd?: string;
	sessionId?: string;
	list: (context: CommandContext) => Promise<CommandEntry[]>;
	/** 回车选中的正好是已经打全的那条：直接发出去。 */
	onSubmit: () => void;
	onError: (message: string) => void;
}): { extension: ReturnType<typeof commandMarks>; menu: ReactNode; combobox: ComboboxState; fresh: () => Promise<MenuCommand[]> } {
	const { t } = useI18n();
	const id = useId();
	const context = useMemo<CommandContext>(() => ({ ...(cwd ? { cwd } : {}), ...(sessionId ? { sessionId } : {}) }), [cwd, sessionId]);
	const key = `${cwd ?? ""}\n${sessionId ?? ""}`;
	const builtins = useMemo(() => productCommands(t), [t]);
	const [catalog, setCatalog] = useState<{ key: string; entries: CommandEntry[] } | null>(null);
	const [completion, setCompletion] = useState<CommandCompletion | null>(null);
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [active, setActive] = useState(0);
	const [keyboardSelection, setKeyboardSelection] = useState(true);
	const commandMode = completion !== null;
	const entries = useMemo(() => menuCommands(builtins, catalog?.key === key ? catalog.entries : []), [builtins, catalog, key]);

	const ask = useRef({ list, onError });
	ask.current = { list, onError };
	// 插件装上、停用、卸下都可能带来或拿走命令：开着的输入框跟着重问，不等下次打开菜单。
	const { plugins } = useMarketStore();
	useEffect(() => {
		let alive = true;
		ask.current
			.list(context)
			.then((found) => {
				if (alive) setCatalog({ key, entries: found });
			})
			.catch((cause: unknown) => {
				if (alive) ask.current.onError(t("commands.readFailed", { reason: cause instanceof Error ? cause.message : String(cause) }));
			});
		return () => {
			alive = false;
		};
	}, [context, key, commandMode, plugins, t]);

	// 编辑器靠它认出哪些行首的 `/xxx` 是命令。
	useEffect(() => {
		editor.current?.dispatch({ effects: setCommandEntries.of(entries) });
	}, [editor, entries]);

	const term = completion?.term ?? null;
	useEffect(() => {
		setActive(0);
		setKeyboardSelection(true);
	}, [term, key]);
	const listening = term !== null && !dismissed && focused;
	const matches = useMemo(() => (listening && term !== null ? rankCommands(entries, term) : []), [entries, term, listening]);
	const current = Math.min(active, Math.max(0, matches.length - 1));

	/** 把正在补全的那一段换成命令名，后面不是空白就补一个空格；撤销一下能回到换之前。 */
	const pick = (command: MenuCommand) => {
		const view = editor.current;
		if (!view || !completion) return;
		const next = view.state.doc.sliceString(completion.end, completion.end + 1);
		const insert = `/${command.name}${next && /\s/.test(next) ? "" : " "}`;
		view.dispatch({
			changes: { from: completion.start, to: completion.end, insert },
			selection: { anchor: completion.start + insert.length },
			userEvent: "input.complete",
		});
		view.focus();
		setDismissed(true);
	};

	const handlers = useRef<CommandHandlers>({ key: () => false, update: () => undefined });
	handlers.current = {
		update(view, edited) {
			const selection = view.state.selection.main;
			setCompletion(commandCompletion(view.state.doc.toString(), selection.from, selection.to));
			setFocused(view.hasFocus);
			if (edited) setDismissed(false);
		},
		key(pressed) {
			const count = matches.length;
			if (!count) return false;
			if (pressed === "ArrowDown" || pressed === "ArrowUp") {
				setKeyboardSelection(true);
				setActive((current + (pressed === "ArrowDown" ? 1 : count - 1)) % count);
				return true;
			}
			if (pressed === "Escape") {
				setDismissed(true);
				return true;
			}
			const chosen = matches[current];
			if (!chosen) return false;
			if (pressed === "Enter" && resolveCommand(entries, term ?? "")?.name === chosen.name) {
				setDismissed(true);
				onSubmit();
			} else pick(chosen);
			return true;
		},
	};
	const extension = useMemo(() => commandMarks(handlers), []);

	const menu = (
		<CommandMenu
			id={id}
			commands={matches}
			term={term ?? ""}
			active={current}
			keyboardSelection={keyboardSelection}
			onPick={pick}
			onHover={(index) => {
				setKeyboardSelection(false);
				setActive(index);
			}}
		/>
	);

	return { extension, menu, combobox: { id, active: current, open: matches.length > 0 }, fresh: async () => menuCommands(builtins, await list(context)) };
}
