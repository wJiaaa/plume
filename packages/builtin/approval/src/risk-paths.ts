/**
 * 能写到哪里。
 *
 * 问的是地方而不是命令：项目和草稿目录是干活的地方，别处都值得人看一眼。
 */

import { withinOrIs } from "@plume/platform";
import { SAFE, risky, underScratchRoot, type RiskVerdict } from "./risk-shared.ts";
import { PROTECTED_PATH } from "./risk-tables.ts";

/**
 * 写这个路径要不要人来定。
 *
 * 项目里面，写就是工作，不值得打断。项目外面（系统目录、某人的 SSH 密钥）是另一回事，不管是谁要写。
 */
export function assessWrite(path: string, cwd: string): RiskVerdict {
	const normalised = path.replace(/\/+$/, "");
	/*
	 * 先问这个：macOS 的系统临时目录在 `/var` 下面，而受保护路径的表理所当然地包括 `/var`。整个用途就是草稿的目录里的文件
	 * 不是那张表要管的，反过来的顺序会让每个临时文件都像是在动系统。
	 */
	if (underScratchRoot(normalised, cwd)) return SAFE;
	if (PROTECTED_PATH.test(` ${normalised}`)) return risky("write-sensitive-path");
	if (/(^|[\\/])\.(zshrc|bashrc|profile|zprofile)$/.test(normalised)) return risky("shell-startup");
	if (!withinOrIs(cwd, normalised)) return risky("write-outside-project");
	return SAFE;
}
