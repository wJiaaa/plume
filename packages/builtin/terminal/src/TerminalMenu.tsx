/**
 * 终端里右键的复制、粘贴。
 *
 * xterm 画在 canvas 上，唯一的输入框藏在一边，右键时什么菜单都没有；Windows 和 Linux 上又没有编辑菜单
 * 可以退回去，鼠标就没法在这里复制粘贴。提示写的是总能用的那组键：Mac 上 ⌘，别处 Ctrl+Shift（单按
 * Ctrl+C 只在有选中时复制），Windows 的粘贴是 Ctrl+V。
 */

import { ContextMenu, macKeyboard, MenuItem, useI18n } from "@plume/ui";
import { ClipboardPaste, Copy } from "@plume/ui/icons";
import { windowsKeyboard } from "./keys.ts";
import { MESSAGES } from "./messages.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

export function TerminalMenu({
	at,
	canCopy,
	onCopy,
	onPaste,
	onClose,
}: {
	at: { x: number; y: number };
	/** 菜单打开那一刻有没有选中的字。 */
	canCopy: boolean;
	onCopy(): void;
	onPaste(): void;
	onClose(): void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const mac = macKeyboard();
	return (
		<ContextMenu anchor={at} onClose={onClose} width="compact">
			<MenuItem icon={<Copy {...ICON} />} hint={mac ? "⌘C" : "Ctrl+Shift+C"} disabled={!canCopy} onClick={onCopy}>
				{text.copy}
			</MenuItem>
			<MenuItem icon={<ClipboardPaste {...ICON} />} hint={mac ? "⌘V" : windowsKeyboard() ? "Ctrl+V" : "Ctrl+Shift+V"} onClick={onPaste}>
				{text.paste}
			</MenuItem>
		</ContextMenu>
	);
}
