/**
 * Plume 自己存的东西都在一个目录里：模型设置、会话、插件和插件数据、外观、语言、窗口位置。缺省是 `~/.plume`，
 * 设了 `PLUME_HOME` 就整个换到那里（冒烟验证就是这样用一个一次性的目录）。
 *
 * 每次现取环境变量而不是启动时记一份：冒烟要在入口处先把它设好，读它的模块已经先导入了。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function plumeHome(): string {
	return process.env.PLUME_HOME || join(homedir(), ".plume");
}
