/**
 * 后台任务真的起进程：普通的停要连命令起的子孙进程一起停掉，别的会话起的服务不受影响。
 *
 * 各平台都跑，停整棵树的办法各不相同（别处是进程组，Windows 上是 `taskkill /T`），Windows 上最容易出事：命令跑在 Git Bash
 * 或 PowerShell 里，shell 起得慢，监听端口的是 shell 起的 node 的子进程。
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { systemShell } from "@plume/platform";
import { afterEach, expect, it } from "vitest";
import { backgroundJobs } from "../../src/tools/background-jobs.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { localExec } from "../sandbox.ts";
import { withFiles } from "../files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * 下面的等待到点时还在跑的：每个任务的 shell 和它底下的所有进程。
 *
 * 等不到服务说话的原因有好几种——shell 还在启动、node 没起来、管道没接上、进程早没了——光看任务表（状态 running、输出为空）
 * 分不出来，要看进程树。
 */
function processReport(pids: number[]): string {
	const alive = pids.map((pid) => {
		try {
			process.kill(pid, 0);
			return `${pid} alive`;
		} catch (error) {
			return `${pid} ${(error as NodeJS.ErrnoException).code}`;
		}
	});
	let rows: { pid: number; ppid: number; command: string }[];
	try {
		if (process.platform === "win32") {
			const listing = execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
				],
				{ encoding: "utf8", timeout: 20_000, windowsHide: true },
			);
			rows = (JSON.parse(listing) as { ProcessId: number; ParentProcessId: number; CommandLine: string | null }[]).map((row) => ({
				pid: row.ProcessId,
				ppid: row.ParentProcessId,
				command: row.CommandLine ?? "",
			}));
		} else {
			rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,command="], { encoding: "utf8", timeout: 10_000 })
				.split("\n")
				.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
				.filter((match) => match !== null)
				.map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }));
		}
	} catch (error) {
		return `${alive.join(", ")}; process listing failed: ${String(error)}`;
	}
	const tree = new Set(pids);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of rows)
			if (tree.has(row.ppid) && !tree.has(row.pid)) {
				tree.add(row.pid);
				grew = true;
			}
	}
	const lines = rows.filter((row) => tree.has(row.pid)).map((row) => `${row.pid} <- ${row.ppid}  ${row.command.slice(0, 240)}`);
	return `${alive.join(", ")}\n${lines.join("\n") || "(no process left under the job shells)"}`;
}

it("普通的停关掉命令起的子孙进程上的监听，别的会话的服务照跑", { timeout: 90_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-owned-services-"));
	const ownedState = new Map<string, unknown>();
	const siblingState = new Map<string, unknown>();
	const registries = [backgroundJobs(ownedState), backgroundJobs(siblingState)];
	const started = Date.now();
	// 等 25 秒：Windows 上冷启动的 shell 在忙着起别的进程的机器上会拖得很长。顺利时谁也等不满，宽一点只拖慢失败的那次。
	const until = async (condition: () => boolean, label: string) => {
		const deadline = Date.now() + 25_000;
		while (!condition() && Date.now() < deadline) await delay(25);
		if (condition()) return;
		const jobs = registries.map((registry) => registry.list());
		const pids = jobs.flat().flatMap((job) => (job.pid === undefined ? [] : [job.pid]));
		const shell = systemShell();
		expect.fail(`${label} after ${Date.now() - started}ms (shell: ${shell.label} ${shell.file})\njobs: ${JSON.stringify(jobs)}\n${processReport(pids)}`);
	};
	cleanups.push(async () => {
		for (const jobs of registries) for (const job of jobs.list()) jobs.stop(job.id, true);
		await until(() => registries.every((jobs) => jobs.list().every((job) => job.finishedAt !== undefined)), "fixture processes did not exit");
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(
		join(root, "server.cjs"),
		`const {createServer}=require('node:http');
const server=createServer((request,response)=>response.end(process.argv[2]));
server.listen(0,'127.0.0.1',()=>console.log('SERVICE_READY '+process.pid+' '+server.address().port));
`,
	);
	await writeFile(join(root, "launcher.cjs"), "require('node:child_process').spawn(process.execPath,['server.cjs','owned'],{stdio:'inherit'});\n");
	// 按要跑它的 shell 写：Windows 上装了 Git 的是 Git Bash，没装的是 PowerShell。
	const executable = systemShell().kind === "powershell" ? `& '${process.execPath.replaceAll("'", "''")}'` : `'${process.execPath.replaceAll("'", "'\\''")}'`;
	await bashTool.execute(
		{ command: `${executable} launcher.cjs`, run_in_background: true },
		withFiles({ cwd: root, state: ownedState, exec: localExec(root) }),
	);
	await bashTool.execute(
		{ command: `${executable} server.cjs sibling`, run_in_background: true },
		withFiles({ cwd: root, state: siblingState, exec: localExec(root) }),
	);
	const jobs = registries.map((registry) => registry.list()[0]!);
	await until(() => registries.every((registry) => /SERVICE_READY \d+ \d+/.test(registry.list()[0]?.output ?? "")), "services did not listen");
	const endpoints = registries.map((registry) => {
		const match = registry.list()[0]!.output.match(/SERVICE_READY (\d+) (\d+)/);
		expect(match).not.toBeNull();
		return { pid: Number(match![1]), port: Number(match![2]) };
	});
	expect(endpoints[0]!.pid, "监听的得是子孙进程，不是 shell 自己").not.toBe(jobs[0]!.pid);
	expect(await (await fetch(`http://127.0.0.1:${endpoints[0]!.port}`)).text()).toBe("owned");
	expect(registries[1]!.stop(jobs[0]!.id), "别的会话停不了这个进程句柄").toBe(false);
	expect(registries[0]!.stop(jobs[0]!.id)).toBe(true);
	await until(() => registries[0]!.get(jobs[0]!.id)?.finishedAt !== undefined, "ordinary stop did not close the process tree");
	await expect(
		new Promise<void>((resolve, reject) => {
			const socket = connect(endpoints[0]!.port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve();
			});
			socket.once("error", reject);
		}),
	).rejects.toMatchObject({ code: "ECONNREFUSED" });
	expect(await (await fetch(`http://127.0.0.1:${endpoints[1]!.port}`)).text()).toBe("sibling");
	expect(registries[1]!.get(jobs[1]!.id)?.finishedAt).toBeUndefined();
});
