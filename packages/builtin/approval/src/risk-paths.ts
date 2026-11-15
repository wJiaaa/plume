/**
 * 能写到哪里。
 *
 * 问的是地方而不是命令：项目和草稿目录是干活的地方，别处都值得人看一眼。
 */

import { homedir } from "node:os";
import { relative } from "node:path";
import { within, withinOrIs } from "@plume/platform";
import { SAFE, risky, underScratchRoot, type RiskVerdict } from "./risk-shared.ts";
import { PROTECTED_PATH } from "./risk-tables.ts";

const SHELL_STARTUP = /(^|[\\/])\.(zshrc|bashrc|profile|zprofile)$/;

/**
 * 用户主目录（`~`）下的路径写成 `~/…`：`PROTECTED_PATH` 认的钥匙目录是 `~/.ssh` 这种写法，而写文件的工具交来的是解析过的绝对路径。
 * 不在用户主目录下时为 null。
 */
function homeForm(path: string): string | null {
	const home = homedir().replace(/[\\/]+$/, "");
	if (!home || !within(home, path)) return null;
	return `~/${relative(home, path).replaceAll("\\", "/")}`;
}

/**
 * 写这个路径要不要人来定。
 *
 * 项目里面，写就是工作，不值得打断。项目外面（系统目录、某人的 SSH 密钥）是另一回事，不管是谁要写。
 * 用户主目录（`~`）里的钥匙目录和 `~` 下的 shell 启动文件在项目里也问：直接把 `~` 当项目打开时，它们都在「项目里」。
 */
export function assessWrite(path: string, cwd: string): RiskVerdict {
	const normalised = path.replace(/\/+$/, "");
	/*
	 * 先问这个：macOS 的系统临时目录在 `/var` 下面，而受保护路径的表理所当然地包括 `/var`。整个用途就是草稿的目录里的文件
	 * 不是那张表要管的，反过来的顺序会让每个临时文件都像是在动系统。这里不带 `cwd`：项目不是草稿目录，项目里的钥匙下面照样问。
	 */
	if (underScratchRoot(normalised)) return SAFE;
	const fromHome = homeForm(normalised);
	if (fromHome !== null && PROTECTED_PATH.test(` ${fromHome}`)) return risky("write-sensitive-path");
	// 启动文件只认 `~` 这一层的：项目里别处的 `.bashrc`（dotfiles 仓库、镜像的构建上下文）不是这台机器正在用的那份。
	if (fromHome !== null && SHELL_STARTUP.test(fromHome) && !fromHome.slice(2).includes("/")) return risky("shell-startup");
	// 项目在 `/var/www` 这类系统目录下时，项目里的文件照常是干活。
	if (withinOrIs(cwd, normalised)) return SAFE;
	if (PROTECTED_PATH.test(` ${normalised}`)) return risky("write-sensitive-path");
	if (SHELL_STARTUP.test(normalised)) return risky("shell-startup");
	return risky("write-outside-project");
}
