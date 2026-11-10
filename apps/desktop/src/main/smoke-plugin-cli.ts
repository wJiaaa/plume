import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 冒烟里跑应用生成的 `plume-plugin` 启动脚本，测的就是插件作者手上的那一份。
 *
 * Windows 上它是 `plume-plugin.cmd`（见 `writePluginCli`）：批处理文件不是可执行文件，Node 的 `execFile` 不经 shell 起不了它
 * （报 EINVAL），交给 cmd.exe 跑。整行外面再包一层引号交给 `/s /c`，cmd 只剥掉最外面那一对，每个参数自己的引号留着，路径里
 * 有空格也拆不散；`windowsVerbatimArguments` 让 Node 不再按 C 运行库的规矩把这些引号转义一遍。别的平台上那份 sh 脚本直接起。
 */
export function runPluginCli(cli: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
	if (process.platform !== "win32") return run(cli, args);
	return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", pluginCliLine(cli, args)], { windowsVerbatimArguments: true });
}

/** 交给 `cmd /s /c` 的那一行：每个词加双引号，整行再包一层。Windows 的路径里不会有双引号。 */
export function pluginCliLine(cli: string, args: readonly string[]): string {
	return `"${[cli, ...args].map((word) => `"${word}"`).join(" ")}"`;
}
