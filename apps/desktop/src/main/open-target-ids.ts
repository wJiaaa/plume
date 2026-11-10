/**
 * 每个平台列哪些打开目标、怎么起它们。从 open-targets.ts 分出来：这里只有表和纯计算，不引用 electron，测试才能直接加载它；
 * 去问操作系统的那一半在 open-targets.ts。
 */

import { cmdInvocation, needsCmdShell } from "./windows-command.ts";

export interface Candidate {
	id: string;
	label: string;
	kind: "app" | "terminal";
	/** macOS：包的显示名，`open -a` 按它找。 */
	appName?: string;
	/** Windows：先试的几个固定位置，相对于下面这几个环境变量。 */
	windows?: { dir: "localAppData" | "programFiles" | "programFilesX86" | "windir"; path: string }[];
	/** Windows：固定位置都没有时去 PATH 里找的命令。 */
	command?: string;
	/**
	 * 只有终端有：让它在 `dir` 里打开的参数。终端各有各的写法，没有一个把裸目录参数当目录：Windows 终端会把它当命令跑。
	 * 进程也以 `cwd: dir` 起，给那些看自己工作目录的终端。
	 */
	dirArgs?: (dir: string) => string[];
}

/**
 * 每个平台值得列出来的应用。是一份短名单而不是全部已装的：这回答的是「点击文件路径时用哪个应用打开」，
 * 列出机器上每个应用就成了文件对话框。不在单子上的，认不出的 id 照样落到系统默认的应用。
 *
 * 名字是应用自己的名字；系统自带、名字随界面语言变的（终端、Windows 终端、记事本）由界面按 id 翻译。
 */
export const CANDIDATES: Record<string, Candidate[]> = {
	darwin: [
		{ id: "vscode", label: "Visual Studio Code", kind: "app", appName: "Visual Studio Code" },
		{ id: "cursor", label: "Cursor", kind: "app", appName: "Cursor" },
		{ id: "zed", label: "Zed", kind: "app", appName: "Zed" },
		{ id: "sublime", label: "Sublime Text", kind: "app", appName: "Sublime Text" },
		{ id: "xcode", label: "Xcode", kind: "app", appName: "Xcode" },
		{ id: "terminal", label: "Terminal", kind: "terminal", appName: "Terminal" },
		{ id: "iterm", label: "iTerm", kind: "terminal", appName: "iTerm" },
		{ id: "ghostty", label: "Ghostty", kind: "terminal", appName: "Ghostty" },
	],
	win32: [
		{
			id: "vscode",
			label: "Visual Studio Code",
			kind: "app",
			windows: [
				{ dir: "localAppData", path: "Programs\\Microsoft VS Code\\Code.exe" },
				{ dir: "programFiles", path: "Microsoft VS Code\\Code.exe" },
				{ dir: "programFilesX86", path: "Microsoft VS Code\\Code.exe" },
			],
			command: "code.cmd",
		},
		{
			id: "cursor",
			label: "Cursor",
			kind: "app",
			windows: [
				{ dir: "localAppData", path: "Programs\\cursor\\Cursor.exe" },
				{ dir: "programFiles", path: "cursor\\Cursor.exe" },
			],
			command: "cursor.cmd",
		},
		{ id: "zed", label: "Zed", kind: "app", windows: [{ dir: "localAppData", path: "Programs\\Zed\\Zed.exe" }], command: "zed.exe" },
		{ id: "sublime", label: "Sublime Text", kind: "app", windows: [{ dir: "programFiles", path: "Sublime Text\\sublime_text.exe" }], command: "subl.exe" },
		{
			id: "notepadpp",
			label: "Notepad++",
			kind: "app",
			windows: [
				{ dir: "programFiles", path: "Notepad++\\notepad++.exe" },
				{ dir: "programFilesX86", path: "Notepad++\\notepad++.exe" },
			],
		},
		{
			id: "windows-terminal",
			label: "Windows Terminal",
			kind: "terminal",
			command: "wt.exe",
			// 要 `-d`，否则 wt 把文件夹当命令跑。裸的 `;` 是 wt 自己的子命令分隔符，路径里的要转义才留在路径里。
			dirArgs: (dir) => ["-d", dir.replaceAll(";", "\\;")],
		},
		{ id: "notepad", label: "Notepad", kind: "app", windows: [{ dir: "windir", path: "notepad.exe" }] },
	],
};

export function candidatesFor(platform: string): Candidate[] {
	return CANDIDATES[platform] ?? [];
}

export interface LaunchPlan {
	file: string;
	args: string[];
	/** 只有终端有：进程从哪个目录起，给看自己工作目录的终端。 */
	cwd?: string;
	/** 这一行已经按 cmd.exe 的规矩加好引号，要原样交过去。 */
	windowsVerbatimArguments?: true;
}

/**
 * 怎么用找到的程序打开 `target`：编辑器给文件，终端给目录。
 *
 * Windows 上的 `.cmd`（VS Code、Cursor 的命令行启动器）不经 shell 起不来，Node 直接抛 EINVAL；这些经 cmd.exe，
 * 那一行按 cmd 的规矩转义（见 windows-command.ts）。
 */
export function launchPlan(candidate: Candidate, located: string, target: string, platform: string, env: NodeJS.ProcessEnv): LaunchPlan {
	const terminal = candidate.kind === "terminal";
	const args = terminal ? (candidate.dirArgs?.(target) ?? []) : [target];
	const where = terminal ? { cwd: target } : {};
	if (platform === "win32" && needsCmdShell(located)) {
		const shim = cmdInvocation(located, args, env);
		return { file: shim.file, args: shim.args, ...where, windowsVerbatimArguments: true };
	}
	return { file: located, args, ...where };
}
