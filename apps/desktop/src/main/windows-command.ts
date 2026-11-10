/**
 * 在 Windows 上起一个 `.cmd` / `.bat`：Node 自己不肯。
 *
 * CVE-2024-27980 修了以后，`spawn` / `execFile` 不给 shell 就拒绝批处理文件、抛 EINVAL。VS Code、Cursor 放进 PATH 的
 * 正是 `code.cmd` / `cursor.cmd`，不处理的话「用 VS Code 打开」每次都掉进兜底，悄悄改成用系统默认的应用打开。
 *
 * 也不能直接 `shell: true`：Node 会把参数用空格拼成一行交给 cmd.exe，名叫 `a&calc` 的文件夹就成了两条命令。
 * 所以这一行在这里拼好、按 cmd 的规矩转义，原样交过去（`windowsVerbatimArguments`）。
 *
 * 转义规则取自 cross-spawn（MIT，https://github.com/moxystudio/node-cross-spawn），npm 生态做同一件事靠的就是它：
 * 先按 MSVCRT 的规矩给每个参数加引号，再在 cmd 会解释的每个字符前加 `^`，引号也加，cmd 自己的引号匹配就插不上手。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import { envValue } from "./find-executable.ts";

/** cmd.exe 在命令行上会解释的字符。这个文件的正则里双引号、反引号写成 `\x22`、`\x60`：文案检查不认正则，字面的引号会让它把后面的注释当成字符串。 */
const CMD_META = /([()\][%!^\x22\x60<>&|;, *?])/g;

/** npm 的垫片经第二道 cmd 命令行（`%*`）转发参数，到了工具手里已经过了两次 cmd，要转义两次。cross-spawn 也这么做。 */
const NPM_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

export function needsCmdShell(file: string): boolean {
	return /\.(cmd|bat)$/i.test(file);
}

function escapeCommand(command: string): string {
	return command.replace(CMD_META, "^$1");
}

function escapeArgument(argument: string, twice: boolean): string {
	// cmd.exe 的参数里放不下换行：它在那里就把命令结束了，也没有转义的办法。路径里不会有，有的就不该交给 shell。
	if (/[\r\n]/.test(argument)) throw new Error("cmd.exe cannot pass an argument containing a line break");
	// 引号前的反斜杠加倍、引号转义；结尾的反斜杠加倍，免得它转义掉收尾的引号。写成不回溯的形式（见 cross-spawn #160）。
	let quoted = argument.replace(/(?=(\\+?)?)\1\x22/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
	quoted = `"${quoted}"`.replace(CMD_META, "^$1");
	return twice ? quoted.replace(CMD_META, "^$1") : quoted;
}

/**
 * 带这些参数起一个批处理文件：cmd.exe，和它该跑的那一行。
 *
 * `/d` 跳过 AutoRun，用户的 cmd 配置改不了跑什么；`/v:off` 关掉延迟展开（哪怕注册表里开了），`!name!` 留作字面；
 * `/s /c "…"` 只剥掉最外面那一对引号，跑剩下的。
 */
export function cmdInvocation(file: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; windowsVerbatimArguments: true } {
	const twice = NPM_SHIM.test(file);
	const line = [escapeCommand(file), ...args.map((argument) => escapeArgument(argument, twice))].join(" ");
	return {
		file: envValue(env, "ComSpec", "win32") || "cmd.exe",
		args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}
