/**
 * 测试里直接调 bash 时用的沙箱：就是内置插件 plume.sandbox 的实现，不经插件宿主。
 */

import type { SandboxService } from "@plume/contract";
import { looksDenied, selectRunner } from "../../sandbox/src/backend.ts";
import { runCommand } from "../../sandbox/src/local.ts";

export const localSandbox: SandboxService = {
	run: (command, options) => runCommand(command, options),
	looksDenied: (output) => looksDenied(output, selectRunner()),
};
