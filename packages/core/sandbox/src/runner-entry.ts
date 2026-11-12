/**
 * 约束由我们自己的进程来做时，受限命令经过的那个程序。
 *
 * macOS 是在命令前面放别人的程序（`sandbox-exec`）。Windows（受限令牌）没有这样的程序，所以就是这个：
 * 后端用应用自己的运行时（`process.execPath` 加 `ELECTRON_RUN_AS_NODE=1`，不必另带一份 Node）带着旗标起它，
 * 它做平台的活，然后以命令的退出状态退出。
 *
 * Node 模式下，脚本之前的参数都会被当成 Node 自己的选项（`bad option: --plume-sandbox-runner`，退出码 9，探测失败，
 * 默认权限档一条命令都跑不了），所以 argv 是先脚本、后旗标。
 *
 * 这个模块只当脚本跑，不被别的代码导入：一加载就做事、退出。从源码跑（测试）时后端起的就是这个 `.ts` 文件；
 * 桌面应用把它单独打成一个入口（`apps/desktop/src/main/sandbox-runner.ts`），再经 `useSandboxRunner` 告诉后端在哪。
 * 不能借 agent 进程的入口：那个入口一加载就要 Electron 的模块，`ELECTRON_RUN_AS_NODE` 下拿不到。
 */

import { SANDBOX_RUNNER_FLAG } from "./runner-flag.ts";
import { main as windows } from "./windows/runner.ts";

const at = process.argv.indexOf(SANDBOX_RUNNER_FLAG);
if (at === -1) {
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	process.stderr.write(`sandbox-runner: 缺少 ${SANDBOX_RUNNER_FLAG}，不是被沙箱后端启动的\n`);
	process.exit(127);
}
if (process.platform === "win32") process.exit(windows(process.argv.slice(at + 1)));
process.stderr.write(`sandbox-runner: 平台 ${process.platform} 不用这个 runner\n`);
process.exit(127);
