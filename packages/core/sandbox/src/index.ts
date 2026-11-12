/**
 * 沙箱：在这台机器能给的约束里跑 shell 命令（macOS 用 seatbelt，Windows 用受限令牌；Linux 没有后端）。
 *
 * 本体的一部分，插件换不掉：权限模式对应哪一档、提权怎么问人由 `@plume/agent` 定（`commands.ts`），插件经 `ToolRun.exec` 用它。
 * 这里只认「命令、目录、档位」，不认会话、不认插件。
 *
 * Windows 的受限令牌由我们自己的 runner 进程造，runner 是单独的脚本（`runner-entry.ts`，包导出 `./runner`），应用启动时经
 * `useSandboxRunner` 告诉这里它打在哪。
 */

export { looksDenied, selectRunner, useSandboxRunner } from "./backend.ts";
export { runCommand } from "./local.ts";
export { primeCommandPath } from "./login-path.ts";
