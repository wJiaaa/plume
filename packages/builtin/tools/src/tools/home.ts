/**
 * Plume 自己的东西放在哪：数据目录（模型设置和 API key、会话、插件和插件开关、命令），缺省是 `~/.plume`。
 *
 * 文件工具不写这里，也不写 `~/.plume`（换了数据目录时它还在）：写得到设置的工具，一次看起来和别的调用没两样的调用
 * 就能改掉自己的权限。数据目录由 agent 启动时告诉这里（`setDataDir`），测试和冒烟各用自己的。
 */

import { homedir } from "node:os";
import { join } from "node:path";

let dataDir: string | undefined;

export function setDataDir(dir: string): void {
	dataDir = dir;
}

/** 工具不写的目录。 */
export function appHomes(): string[] {
	return [join(homedir(), ".plume"), ...(dataDir ? [dataDir] : [])];
}

/** 放工具自己的临时目录（git 视图）：不能放进系统临时目录，那里沙箱里的命令写得到。 */
export function appHome(): string {
	return dataDir ?? join(homedir(), ".plume");
}

/**
 * 各会话临时目录的上一级：宿主把每个会话的临时目录（`ToolRun.scratchDir`）放在 `<数据目录>/scratch/<会话 id>`。
 * 数据目录里只有这一块对文件工具开着：系统提示词让模型把不该进项目的文件放这里，拒了它，模型会去找别的路写。
 * 读整块都不问（`read-access.ts`）；写只限同一脉的会话的那几个（`ToolRun.scratchDirs`，见 `paths.ts`）。
 */
export function scratchHome(): string {
	return join(appHome(), "scratch");
}

export const home = (): string => homedir();
