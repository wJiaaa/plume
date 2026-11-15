/**
 * 把文件拖进终端，打出它们的路径，按 shell 的规矩加好引号：系统终端都这样，也是把一个文件交给命令最快的办法。
 * 访达里的文件和文件面板里的行都算，读路径由宿主做（`ui.droppedPaths`）。
 */

import { windowsKeyboard } from "./keys.ts";

/**
 * 一条路径作为 shell 的一个词。
 *
 * POSIX：每个字都不是 shell 的特殊字时原样，否则加单引号——单引号里什么都不解释，文件名里的 `$HOME`、反引号
 * 仍是文件名。Windows：双引号，cmd、PowerShell、Git Bash 都把它读成一个词；PowerShell 偏爱的单引号 cmd 不认。
 */
export function shellWord(path: string, platform = navigator.platform): string {
	// 引号写成 \x27、\x60：原样写在正则里，文案检查会把它们当成字符串的开头。
	if (windowsKeyboard(platform)) return /[\s&()^;,\x27\x60$%!@{}[\]]/.test(path) ? `"${path}"` : path;
	return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** 拖进来要打的字：几个词用空格隔开，末尾留一个空格好接着打。 */
export function dropText(paths: string[], platform = navigator.platform): string {
	return paths.length === 0 ? "" : `${paths.map((path) => shellWord(path, platform)).join(" ")} `;
}
