/**
 * 把文件拖进终端，打出它们的路径，按 shell 的规矩加好引号：系统终端都这样，也是把一个文件交给命令最快的办法。
 * 访达里的文件和文件面板里的行都算，读路径由宿主做（`ui.droppedPaths`）。
 */

import type { ShellDialect } from "./api.ts";

/**
 * 一条路径作为 shell 的一个词，按这个标签里跑的 shell 的规矩（`TerminalTab.dialect`）。
 *
 * POSIX（含 Windows 上的 Git Bash）和 PowerShell：每个字都不是 shell 的特殊字时原样，否则加单引号——单引号里什么都不解释，
 * 文件名里的 `$HOME`、反引号仍是文件名；PowerShell 的单引号里 `'` 写两遍（弯引号它也当引号，同 `cdCommand`）。
 * cmd 只认双引号；双引号里它照样展开 `%X%`，这在 cmd 里没有办法转义，只有名字里带两个 `%` 的路径会受影响。
 */
export function shellWord(path: string, dialect: ShellDialect): string {
	if (dialect === "cmd") return /[\s&()^;,=!%]/.test(path) ? `"${path}"` : path;
	// 引号写成 \x27、\x60：原样写在正则里，文案检查会把它们当成字符串的开头。
	if (dialect === "powershell") return /^[\w.:\\/~+-]+$/.test(path) ? path : `\x27${path.replace(/[\u0027\u2018-\u201b]/g, "$&$&")}\x27`;
	return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/** 拖进来要打的字：几个词用空格隔开，末尾留一个空格好接着打。 */
export function dropText(paths: string[], dialect: ShellDialect): string {
	return paths.length === 0 ? "" : `${paths.map((path) => shellWord(path, dialect)).join(" ")} `;
}
