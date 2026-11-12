/**
 * 测试里直接调 bash 时跑命令的入口（代替 `ToolRun.exec`）：就是本体 `@plume/sandbox` 起命令的实现，不进沙箱、不经插件宿主。
 * 沙箱档、提权由本体定，在 `packages/core/agent/test/commands.test.ts` 里测。
 */

import type { ToolRun } from "@plume/contract";
import { runCommand } from "../../../core/sandbox/src/local.ts";

export function localExec(cwd: string): ToolRun["exec"] {
	return async (command, options = {}) =>
		Object.assign(runCommand(command, { cwd: options.cwd ?? cwd, ...(options.env ? { env: options.env } : {}) }), {
			mode: "danger-full-access" as const,
			denied: () => false,
		});
}
