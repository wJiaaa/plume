/**
 * 写插件用的命令 `plume-plugin`：SDK 随应用发（资源目录里的 plugin-sdk/），启动时在 `~/.plume/bin/` 生成启动脚本，
 * 用应用自己的二进制当 Node 跑它（ELECTRON_RUN_AS_NODE），插件作者的机器上不用装 Node 和 npm。
 *
 * 每次启动都按当前应用的位置重写：应用挪了地方、升级了，脚本跟着指过去。只在打包好的应用（和冒烟）里写：
 * 开发时的二进制是仓库里的 Electron，指过去会盖掉装好的那份，仓库里用根目录的 `pnpm plugin`。
 *
 * 总是写一份 sh 脚本；Windows 上再写一份 `plume-plugin.cmd`：cmd 和 PowerShell 认它，Git Bash 认那份 sh
 * （MSYS 按 `#!` 认可执行文件，也认 `C:\…` 写法的路径）。
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 单引号包住，里面的单引号断开转义：路径里有空格、$ 都不会被 shell 解释。 */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * cmd 的批处理文件里的一个路径：双引号包住（Windows 的路径里不会有双引号），`%` 写成 `%%`，免得被当成变量展开。
 *
 * 批处理文件按系统的 OEM 代码页读（中文系统是 936），写进去的 UTF-8 中文会被读成乱码；用户名是中文时安装目录就在
 * `C:\Users\张三\AppData\Local\…` 下。所以开头是 `LOCALAPPDATA` 或 `USERPROFILE` 的，那一段写成变量，交给 cmd 自己展开，
 * 剩下的部分（`Programs\Plume\…`）是安装包定的 ASCII。装到别的带非 ASCII 字符的目录时仍会乱码，那是这个办法的边界。
 */
export function cmdPath(value: string, env: NodeJS.ProcessEnv): string {
	let path = value.replaceAll("%", "%%");
	for (const name of ["LOCALAPPDATA", "USERPROFILE"]) {
		const prefix = env[name]?.replace(/[\\/]+$/, "");
		if (prefix && value.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`)) {
			path = `%${name}%${value.slice(prefix.length).replaceAll("%", "%%")}`;
			break;
		}
	}
	return `"${path}"`;
}

/** 两份脚本的内容，`entry` 是 SDK 的 bin/plume-plugin.mjs。cmd 用 `setlocal` 把变量留在脚本里，不改调用它的那个控制台；行尾是 CRLF。 */
export function pluginCliScripts(execPath: string, entry: string, env: NodeJS.ProcessEnv): { sh: string; cmd: string } {
	return {
		sh: ["#!/bin/sh", `ELECTRON_RUN_AS_NODE=1 exec ${quote(execPath)} ${quote(entry)} "$@"`, ""].join("\n"),
		cmd: ["@echo off", "setlocal", 'set "ELECTRON_RUN_AS_NODE=1"', `${cmdPath(execPath, env)} ${cmdPath(entry, env)} %*`, ""].join("\r\n"),
	};
}

/**
 * @param binDir 启动脚本放哪（~/.plume/bin，冒烟时在冒烟目录里）
 * @param sdkDir SDK 的目录
 * @returns 这个平台上直接起得来的那份启动脚本的路径
 */
export async function writePluginCli(binDir: string, sdkDir: string): Promise<string> {
	const scripts = pluginCliScripts(process.execPath, join(sdkDir, "bin", "plume-plugin.mjs"), process.env);
	const sh = join(binDir, "plume-plugin");
	await mkdir(binDir, { recursive: true });
	await writeIfChanged(sh, scripts.sh);
	await chmod(sh, 0o755);
	if (process.platform !== "win32") return sh;
	const cmd = join(binDir, "plume-plugin.cmd");
	await writeIfChanged(cmd, scripts.cmd);
	return cmd;
}

async function writeIfChanged(file: string, content: string): Promise<void> {
	if ((await readFile(file, "utf8").catch(() => null)) !== content) await writeFile(file, content);
}
