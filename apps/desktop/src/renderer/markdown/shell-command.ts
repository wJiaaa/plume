/**
 * 回复里哪些代码块是命令，以及交给终端的是哪几行。
 *
 * 回复里的一段 Python 是示意；一行 shell 是一条指示，读完到执行之间隔着切到另一个窗口再粘贴。只有这些语言
 * 有「在终端运行」：给一段 TypeScript 提供「运行」，就是提供一件做不到的事。
 */
const SHELL = new Set(["bash", "sh", "zsh", "shell", "console", "terminal"]);

export function isShellFence(label: string): boolean {
	return SHELL.has(label);
}

/** 注释行和提示符是给人读的，shell 不该收到它们。 */
export function commandFrom(code: string): string {
	return code
		.split("\n")
		.map((line) => line.replace(/^\s*[$>]\s+/, "").trimEnd())
		.filter((line) => line.trim() && !line.trim().startsWith("#"))
		.join("\n")
		.trim();
}
