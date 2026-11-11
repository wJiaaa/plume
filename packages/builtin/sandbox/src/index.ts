/**
 * 沙箱：在这台机器能给的约束里跑 shell 命令（macOS 用 seatbelt，Windows 用受限令牌），作为服务 `sandbox` 给别的插件用。
 *
 * Windows 的受限令牌由我们自己的 runner 进程造，runner 就是这个逻辑入口本身（见 `runner-entry.ts`），所以要在最前面导入它。
 *
 * 要换一种沙箱（容器、远程机器）就装一个提供 `sandbox` 服务的插件：非内置的提供方优先，用它的 plume.tools 会按新的重新加载。
 */

import "./runner-entry.ts";
import type { Plugin } from "@plume/contract";
import { looksDenied, selectRunner } from "./backend.ts";
import { runCommand } from "./local.ts";
import { primeCommandPath } from "./login-path.ts";

export default {
	name: "plume.sandbox",
	apply(ctx) {
		// 从图标启动时向登录 shell 要一份环境（PATH、代理……），第一条命令就能找到用户装的工具，见 `login-path.ts`。
		void primeCommandPath({ always: true });
		ctx.provide("sandbox", {
			run: (command, options) => runCommand(command, options),
			looksDenied: (output) => looksDenied(output, selectRunner()),
		});
	},
} satisfies Plugin;
