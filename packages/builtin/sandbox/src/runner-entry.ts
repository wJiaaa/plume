/**
 * 约束由我们自己的进程来做时，受限命令经过的那个程序。
 *
 * macOS 是在命令前面放别人的程序（`sandbox-exec`）。Windows（受限令牌）没有这样的程序，所以就是这个：
 * 后端用应用自己的运行时（`process.execPath` 加 `ELECTRON_RUN_AS_NODE=1`，不必另带一份 Node）带着旗标起这个文件，
 * 它做平台的活，然后以命令的退出状态退出。
 *
 * Node 模式下，脚本之前的参数都会被当成 Node 自己的选项（`bad option: --plume-sandbox-runner`，退出码 9，探测失败，
 * 默认权限档一条命令都跑不了），所以 argv 是先脚本、后旗标。
 *
 * 插件只发一个逻辑入口（`dist/index.mjs`），它导入这个模块，所以发出去的 runner 就是插件入口本身：被当成脚本、带着旗标起时
 * 在这里做完并退出，被宿主当插件导入时什么都不做。从源码跑（测试）时，后端起的是这个 `.ts` 文件。
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_RUNNER_FLAG } from "./runner-flag.ts";
import { main as windows } from "./windows/runner.ts";

/** Windows 的路径不分大小写，盘符可能一大一小。 */
const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

const script = process.argv[1];
if (script !== undefined && samePath(resolve(script), fileURLToPath(import.meta.url))) {
	const at = process.argv.indexOf(SANDBOX_RUNNER_FLAG);
	if (at === -1) {
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
		process.stderr.write(`sandbox-runner: 缺少 ${SANDBOX_RUNNER_FLAG}，不是被沙箱后端启动的\n`);
		process.exit(127);
	}
	if (process.platform === "win32") process.exit(windows(process.argv.slice(at + 1)));
	process.stderr.write(`sandbox-runner: 平台 ${process.platform} 不用这个 runner\n`);
	process.exit(127);
}
