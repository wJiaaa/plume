/**
 * 结束一个子进程（冒烟起的 Electron），并等它真的没了。
 *
 * 只发个信号就走不够：冒烟超时后还要删快照目录、退出，Electron 还活着的话它开着的文件删不掉（Windows 上尤其如此），
 * 它的 stdio 管道也会让这个脚本的事件循环一直不结束。
 *
 * Windows 上 `child.kill()` 只结束 Electron 主进程，渲染、GPU 这些子进程是它自己起的，留下来照样占着文件，所以用
 * `taskkill /T /F` 连整棵进程树一起结束。别处先 SIGTERM，宽限期过了再 SIGKILL；子进程自成进程组时整组一起收。
 */

import { spawn } from "node:child_process";

/**
 * @param {import("node:child_process").ChildProcess | undefined} child
 * @param {number} [graceMs] SIGTERM 之后等多久再 SIGKILL（Windows 上直接 taskkill /F，不用它）
 */
export async function stopProcessTree(child, graceMs = 3_000) {
	if (!child?.pid) return;
	const pid = child.pid;
	const exited = new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
	});
	if (process.platform === "win32") {
		try {
			const result = await new Promise((resolve, reject) => {
				const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
				let output = "";
				const record = (chunk) => {
					output = (output + chunk.toString()).slice(-8_000);
				};
				killer.stdout.on("data", record);
				killer.stderr.on("data", record);
				killer.once("error", reject);
				killer.once("close", (code, signal) => resolve({ code, signal, output }));
			});
			// Windows 上每个进程的退出通知各自排队：taskkill 结束时，目标的退出事件可能还没到。
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
			if (result.code !== 0 && child.exitCode === null && child.signalCode === null) {
				throw new Error(`taskkill 没能结束进程 ${pid}（退出码 ${result.code}，信号 ${result.signal}）：${result.output}`);
			}
		} finally {
			// 结束不掉也要放开管道，这个脚本才退得出去。
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
		}
		return;
	}

	const signal = (name) => {
		try {
			process.kill(-pid, name);
		} catch {
			try {
				child.kill(name);
			} catch {
				// 已经没了。
			}
		}
	};
	signal("SIGTERM");
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
	signal("SIGKILL");
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
	child.stdout?.destroy();
	child.stderr?.destroy();
	child.unref();
}
