/**
 * 终端里哪些键归 shell、哪些归应用。纯函数，不用终端就能测。
 */

import { composingKey, macKeyboard, shortcutLetter } from "@plume/ui";

/**
 * xterm 看到这个键之前怎么处理：
 *
 *   copy   选中的字放进剪贴板，什么都不送给 shell
 *   paste  不给 xterm，让浏览器自己的粘贴落进 xterm 的输入框，从那里送出（认括号粘贴模式）
 *   app    不给 xterm，留给应用的快捷键
 *   find   打开终端里的查找：Mac 上 ⌘F，别处 Ctrl+Shift+F——单按 Ctrl+F 是 readline 的前移一格
 *   shell  照常给 xterm
 */
export type TerminalKey = "copy" | "paste" | "app" | "find" | "shell";

/** 焦点在终端里也要能按的应用快捷键，记的是和 Ctrl+Alt 一起按的字母：侧边聊天、文件、子 Agent 面板。 */
const APP_WITH_CTRL_ALT = new Set(["s", "p", "u"]);

/**
 * Mac 上什么都不用变：应用的快捷键是 ⌘，xterm 不碰；复制粘贴走编辑菜单，经 xterm 已经处理的剪贴板事件。
 *
 * 别处 xterm 把每个 Ctrl+字母都变成控制字符吞掉，Chromium 那里也没有自己的复制可以退回去。所以：
 *
 *   - 有选中时 Ctrl+C 复制并清掉选中，没选中仍是 ^C：选中 dev server 的地址按 Ctrl+C，不该把它停掉。
 *     Ctrl+Shift+C 总是复制，和 Linux 的终端一样。
 *   - Ctrl+Shift+V 交给浏览器的粘贴。
 *   - Windows 上单按 Ctrl+V 也是粘贴，那边的控制台都这样；cmd、Git Bash、ssh 收到 ^V 只会打出 ^V。
 *     Linux 留着 ^V 给 shell（readline 的原样插入），粘贴用 Ctrl+Shift+V。
 *   - Ctrl+Alt+S/P/U 归应用：shell 用不着它们，xterm 却会把它们当 ESC 加控制字符发出去。主窗口里宿主的面板快捷键
 *     在捕获阶段先接走，xterm 本来就看不到；弹出的面板窗口里宿主不接，这里不交给 xterm，免得打进 shell。
 *     AltGr 在 Windows 上到达时就是 Ctrl+Alt，很多布局靠它打字（波兰语 AltGr+S 是 ś），组字的键仍归 shell。
 */
export function terminalKey(event: KeyboardEvent, hasSelection: boolean, platform = navigator.platform): TerminalKey {
	if (composingKey(event)) return "shell";
	if (macKeyboard(platform)) {
		const find = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && shortcutLetter(event) === "f";
		return find ? "find" : "shell";
	}
	if (event.metaKey || !event.ctrlKey) return "shell";
	const letter = shortcutLetter(event);
	if (event.altKey) return !event.shiftKey && letter !== null && APP_WITH_CTRL_ALT.has(letter) ? "app" : "shell";
	if (event.shiftKey && letter === "f") return "find";
	if (event.shiftKey && letter === "c") return "copy";
	if (event.shiftKey && letter === "v") return "paste";
	if (!event.shiftKey && letter === "c" && hasSelection) return "copy";
	if (!event.shiftKey && letter === "v" && windowsKeyboard(platform)) return "paste";
	return "shell";
}

/** Windows 键盘：控制台里 Ctrl+V 和别处一样是粘贴。 */
export function windowsKeyboard(platform = navigator.platform): boolean {
	return /^Win/i.test(platform);
}
