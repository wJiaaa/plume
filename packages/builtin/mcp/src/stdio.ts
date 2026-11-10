/**
 * 起一台 stdio MCP 服务器在 Windows 上要多管的两件事：环境变量名不分大小写，关的时候要收整棵进程树。
 */

import { execFile } from "node:child_process";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * SDK 的 stdio 传输，关的时候在 Windows 上收得到服务器本身。
 *
 * Windows 上 SDK 起不是 `.exe` 的东西（`npx`、`.cmd` 垫片）都经 `cmd.exe /d /s /c`，关的时候结束 stdin、等一会儿、再
 * `kill()`：结束的是 `cmd.exe`，底下的服务器没人管，会话剩下的时间里一直跑、一直占着文件，更新、卸载带来它的插件时
 * 半路报 EPERM。
 *
 * 整棵树要趁 `cmd.exe` 还在、能当树根时收（它没了 `/T` 就无从找起），所以在 SDK 的 close 之前做。这样 Windows 上
 * 服务器看不到 stdin 先关的那段宽限期；比起一个占着插件文件的孤儿进程，这是轻的那头。
 */
export class TreeKillingStdioTransport extends StdioClientTransport {
	override async close(): Promise<void> {
		const pid = this.pid;
		// 进程退出后 `pid` 是 null，不会点到系统已经重用的那个号。
		if (process.platform === "win32" && pid !== null) await killTree(pid);
		await super.close();
	}
}

function killTree(pid: number): Promise<void> {
	return new Promise((resolve) => {
		// agent 进程没有控制台：不带 windowsHide，每停一台服务器就闪一个黑窗口。
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
	});
}

/**
 * 起服务器用的环境：`base`（和智能体自己的命令同一份），服务器配置里的 `env` 盖在上面。
 *
 * Windows 上 SDK 会在我们给的底下再垫一份它自己的几个变量，名字全大写（`DEFAULT_INHERITED_ENV_VARS`）；`{ ...process.env }`
 * 却保留系统的拼法（`Path`、`SystemRoot`）。不管的话子进程同时拿到 `PATH` 和 `Path`，读哪个取决于 Node 怎么排键，不由我们：
 * 人在服务器 `env` 里设的 `Path` 会输给 SDK 垫的 `PATH`。所以名字不分大小写地合并，后写的赢；那几个按 SDK 的拼法写，
 * 盖掉它垫的那份而不是并排放着。
 */
export function stdioEnv(base: Record<string, string>, overrides: Record<string, string> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	const windows = process.platform === "win32";
	const spelled = new Map<string, string>();
	const put = (key: string, value: string) => {
		if (!windows) {
			env[key] = value;
			return;
		}
		const folded = key.toUpperCase();
		const previous = spelled.get(folded);
		if (previous !== undefined) delete env[previous];
		const name = DEFAULT_INHERITED_ENV_VARS.includes(folded) ? folded : key;
		spelled.set(folded, name);
		env[name] = value;
	};
	for (const [key, value] of Object.entries(base)) put(key, value);
	for (const [key, value] of Object.entries(overrides ?? {})) put(key, value);
	return env;
}
