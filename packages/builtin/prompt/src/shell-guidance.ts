/**
 * 模型要写出能在这个 shell 里跑的命令，得知道的那几句。
 *
 * macOS、Linux 上什么都不用说：工具叫 `bash`，跑的就是 bash 或 zsh。Windows 上这决定命令能不能跑：贴进 bash 的 Windows 路径
 * 会丢掉反斜杠，Windows PowerShell 5.1 里 `&&` 是语法错误。
 *
 * 写成 shell 的函数而不是 `bash` 工具的一条规矩，因为是哪个 shell 取决于会话：Windows 上受约束的命令跑在 PowerShell 里，
 * 不受约束的跑在 Git Bash 里（本体给的 `ModelContext.shell`）。环境一段点名的和这里说的是同一个 shell，两边不会对不上。
 */

import type { ShellInfo } from "@plume/contract";

export function shellGuidance(shell: Pick<ShellInfo, "kind" | "label">): string[] {
	if (shell.kind === "powershell") {
		return [
			`Commands run in ${shell.label}, not bash: write PowerShell.` +
				(shell.label.includes("5.1") ? " `&&` and `||` do not exist in this version: separate commands with `;` and test `$?` or `$LASTEXITCODE`." : "") +
				" Environment variables are `$env:NAME`, `/dev/null` is `$null`, and `Select-String` / `Select-Object -First N` stand in for grep / head.",
		];
	}
	if (shell.label === "Git Bash") {
		return [
			"Commands run in Git Bash on Windows: write bash, and write paths with forward slashes (`C:/Users/me/app` or `/c/Users/me/app`) — a backslash is an escape character here. Windows programs run directly; reach cmd's built-ins with `cmd //c <command>`.",
		];
	}
	return [];
}
