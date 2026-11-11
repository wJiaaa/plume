/**
 * macOS 上把下好的更新换上去，再从新版本起来。
 *
 * 跑着的应用不能覆盖自己，所以替换由一个比这个进程活得长的小脚本做：等这个进程退出，把新的挪到位，再启动它。
 * 慢的那步（拷几千个文件）在退出前、应用还跑着时做完，拷到装着的那个旁边；退出后脚本只做两次同目录改名。
 * 原先是退出后才拷进 `/Applications/Plume.app`，拷的那一两秒里那里是个半成品，脚本半路没了（回滚和 `open` 也在它里面），
 * 留下的就是缺 `Electron Framework`、一点就闪退的包。
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
 * 固定的不是太短（包还映射着、挪不动）就是白等。
 *
 * `incoming` 已经拷好、和 `target` 在同一个目录，两次 `mv` 都是同卷改名，一瞬间的事。旧的先挪成 `backup`，新的放好了才删；
 * 新的放不上就把旧的放回去，一个应用都没有比没更新成糟得多。不用 `set -e`：回滚里哪一步出错都要接着走完，最后总要 `open`
 * 一个能起来的。最后清掉下载留下的隔离标记，不然第一次启动弹一个吓人的对话框。
 */
export function swapScript(options: { pid: number; incoming: string; target: string; backup: string }): string {
	const [incoming, target, backup] = [options.incoming, options.target, options.backup].map((path) => JSON.stringify(path));
	return `#!/bin/bash
for _ in $(seq 1 100); do
  kill -0 ${options.pid} 2>/dev/null || break
  sleep 0.1
done

rm -rf ${backup}
if mv ${target} ${backup}; then
  if mv ${incoming} ${target}; then
    rm -rf ${backup}
  else
    mv ${backup} ${target}
  fi
fi
rm -rf ${incoming}

xattr -dr com.apple.quarantine ${target} 2>/dev/null || true
open ${target}
`;
}

/**
 * 把新版拷到装着的那个旁边（`Plume.app.new`），再安排好替换，调用方接着退出。拷失败就抛出去：应用还跑着，「立即重启」
 * 报安装失败、留在旧版本上。拷用 `ditto`：它是 macOS 处理应用包用的，保留应用包依赖的扩展属性和软链。
 *
 * 脚本脱离出去、放掉输入输出：父进程退出正是它在等的，不能把它一起带走。
 */
export async function scheduleSwap(options: { staged: string; target: string }): Promise<void> {
	const incoming = `${options.target}.new`;
	await rm(incoming, { recursive: true, force: true });
	try {
		await execFileAsync("ditto", [options.staged, incoming]);
	} catch (error) {
		await rm(incoming, { recursive: true, force: true }).catch(() => {});
		throw error;
	}

	const dir = await mkdtemp(join(tmpdir(), "plume-swap-"));
	const script = join(dir, "swap.sh");
	await writeFile(script, swapScript({ pid: process.pid, incoming, target: options.target, backup: `${options.target}.old` }), { mode: 0o755 });
	const child = spawn("/bin/bash", [script], { detached: true, stdio: "ignore" });
	child.unref();
}
