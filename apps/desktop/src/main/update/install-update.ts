/**
 * macOS 上把下好的更新换上去，再从新版本起来。
 *
 * 跑着的应用不能覆盖自己，所以替换由一个比这个进程活得长的小脚本做：等这个进程退出，把新的挪到位，再启动它。
 * 旧的先挪到一边，新的放好了才删，半路失败还留着一个能启动的。
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = ".app";

/**
 * 这个应用装在哪，一个能整体换掉的目录。开发时不算安装：`pnpm dev` 跑的是 node_modules 里 Electron 自带的那个包，
 * 换掉它就换掉了开发用的运行时，窗口一片白、开发环境得重装。
 */
export function installedAppBundle(execPath: string): string | null {
	if (execPath.includes("/node_modules/")) return null;
	// …/Plume.app/Contents/MacOS/Plume → …/Plume.app
	const at = execPath.indexOf(`${BUNDLE}/Contents/MacOS/`);
	return at === -1 ? null : execPath.slice(0, at + BUNDLE.length);
}

/**
 * 这个进程走了以后做替换的脚本。写成文件、脱离出去起，因为它要活过起它的那个进程；按 pid 等而不是睡固定时长：
 * 固定的不是太短（包还映射着、挪不动）就是白等。装用 `ditto` 不用 `mv`：它是 macOS 处理应用包用的，保留应用包依赖的
 * 扩展属性和软链，跨文件系统的 mv 可能悄悄得到一个起不来的包。
 *
 * 等的是旧应用真的走了，不只是被叫走；ditto 失败就把旧的放回去，一个应用都没有比没更新成糟得多；最后清掉下载留下的隔离标记，
 * 不然第一次启动弹一个吓人的对话框。
 */
export function swapScript(options: { pid: number; staged: string; target: string; backup: string }): string {
	const { pid, staged, target, backup } = options;
	return `#!/bin/bash
set -e

for _ in $(seq 1 100); do
  kill -0 ${pid} 2>/dev/null || break
  sleep 0.1
done

rm -rf ${JSON.stringify(backup)}
mv ${JSON.stringify(target)} ${JSON.stringify(backup)}

if ditto ${JSON.stringify(staged)} ${JSON.stringify(target)}; then
  rm -rf ${JSON.stringify(backup)}
else
  rm -rf ${JSON.stringify(target)}
  mv ${JSON.stringify(backup)} ${JSON.stringify(target)}
fi

xattr -dr com.apple.quarantine ${JSON.stringify(target)} 2>/dev/null || true
open ${JSON.stringify(target)}
`;
}

/** 安排好替换就返回，调用方接着退出。脱离出去、放掉输入输出：父进程退出正是它在等的，不能把它一起带走。 */
export async function scheduleSwap(options: { staged: string; target: string }): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "plume-swap-"));
	const script = join(dir, "swap.sh");
	await writeFile(script, swapScript({ pid: process.pid, staged: options.staged, target: options.target, backup: `${options.target}.old` }), { mode: 0o755 });
	const child = spawn("/bin/bash", [script], { detached: true, stdio: "ignore" });
	child.unref();
}
