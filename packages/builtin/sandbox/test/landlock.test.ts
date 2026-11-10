/**
 * Landlock 后端：规则是数据，在每个平台上按数据测；其余只有真的有内核施加过才算数——规则集建对了却从没生效，
 * 从别的角度看完全一样，所以下面那几条在没有 Landlock 的机器上跳过，而不是用探测接缝替它说「行」。
 *
 * 强制选 Landlock 而不是交给选择：有可用 `bwrap` 的机器会选它，这里就一次都跑不到。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxMode } from "@plume/contract";
import { afterEach, describe, expect, it } from "vitest";
import { confine, looksDenied, resetProbeCache } from "../src/backend.ts";
import { deviceRights, landlockAbi, landlockRules, parseLandlockArgs, writeRights } from "../src/linux/landlock.ts";

const abi = landlockAbi();
const usable = process.platform === "linux" && abi >= 2;

const cleanup: string[] = [];
afterEach(async () => {
	for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Landlock 规则", () => {
	it("处理的权限严格跟着内核的 ABI", () => {
		// 处理内核不认识的权限是 EINVAL，漏掉它认识的就是个洞。
		const v2 = writeRights(2);
		const v3 = writeRights(3);
		expect(v3 & ~v2).toBe(1n << 14n);
		expect(v2 & (1n << 13n)).not.toBe(0n);
		expect(writeRights(1) & (1n << 13n)).toBe(0n);
		// 设备上的规则只能带文件权限，而且只能是规则集处理的。
		for (const version of [2, 3, 4, 5]) expect(deviceRights(version) & ~writeRights(version)).toBe(0n);
	});

	it("read-only 只放回设备；workspace-write 加上项目和临时目录", () => {
		expect(landlockRules({ workspace: "/work/app", mode: "read-only" }, 4).map((rule) => rule.path)).toEqual(["/dev"]);
		const rw = landlockRules({ workspace: tmpdir(), mode: "workspace-write" }, 4);
		expect(rw.some((rule) => rule.path === "/dev")).toBe(true);
		expect(rw.some((rule) => rule.rights === writeRights(4) && rule.path !== "/dev")).toBe(true);
	});

	it("argv 约定对不上的一律拒绝", () => {
		expect(parseLandlockArgs(["--workspace", "/w", "--mode", "read-only", "--", "true"]).command).toEqual(["true"]);
		expect(() => parseLandlockArgs(["--workspace", "/w", "--mode", "full", "--", "true"])).toThrow(/--mode/);
		expect(() => parseLandlockArgs(["--workspace", "/w", "--mode", "danger-full-access", "--", "true"])).toThrow(/--mode/);
		expect(() => parseLandlockArgs(["--workspace", "--mode", "read-only", "--", "true"])).toThrow(/缺少值/);
		expect(() => parseLandlockArgs(["--workspace", "/w", "--mode", "read-only"])).toThrow(/--/);
	});

	it("不是 Linux 时没有 ABI，探测直接说用不了", () => {
		if (process.platform === "linux") return;
		expect(abi).toBe(0);
		resetProbeCache();
		expect(() => confine({ mode: "read-only", workspaceRoot: tmpdir() }, { runners: ["landlock"] })).toThrow(/Landlock ABI 0/);
		resetProbeCache();
	});

	it("Landlock 拒绝时的 Permission denied 认作拒绝，ssh 的那两句不算", () => {
		expect(looksDenied("bash: /home/me/x: Permission denied", "landlock")).toBe(true);
		expect(looksDenied("git@github.com: Permission denied (publickey).", "landlock")).toBe(false);
		expect(looksDenied("bash: /home/me/x: Permission denied", "bwrap")).toBe(false);
	});
});

/** 照 `LocalSandbox` 的样子经 Landlock runner 跑一条命令。 */
function run(command: string, cwd: string, mode: SandboxMode): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
	const wrap = confine({ mode, workspaceRoot: cwd }, { runners: ["landlock"] });
	expect(wrap?.runner).toBe("landlock");
	return new Promise((resolve) => {
		const child = spawn(wrap!.command, [...wrap!.args, "/bin/bash", "-c", command], {
			cwd,
			env: { ...process.env, ...wrap!.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (out += chunk));
		child.on("close", (code, signal) => resolve({ code, signal, out }));
	});
}

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

describe.skipIf(!usable)(`真实内核上的 Landlock（平台 ${process.platform}，ABI ${abi}）`, () => {
	it("workspace-write：项目和临时目录能写，别处不行", async () => {
		resetProbeCache();
		const ws = await tempDir("plume-ll-ws-");
		const outside = join(homedir(), `.plume-landlock-probe-${process.pid}`);
		cleanup.push(outside);

		let r = await run("echo hi > inside.txt && cat inside.txt", ws, "workspace-write");
		expect(r.out.trim()).toBe("hi");
		r = await run(`echo x > '${outside}'`, ws, "workspace-write");
		expect(r.code).not.toBe(0);
		expect(existsSync(outside)).toBe(false);
		r = await run('f=$(mktemp) && echo t > "$f" && cat "$f" && rm "$f"', ws, "workspace-write");
		expect(r.out.trim()).toBe("t");
		// ABI 2 的 REFER：授权范围里在目录之间移动文件。
		r = await run("mkdir -p a/b && echo m > a/b/f && mv a/b/f a/g && cat a/g", ws, "workspace-write");
		expect(r.out.trim()).toBe("m");
	});

	it("read-only：项目不能写，shell 要的设备能写", async () => {
		const ws = await tempDir("plume-ll-ro-");
		let r = await run("echo x > ro.txt", ws, "read-only");
		expect(r.code).not.toBe(0);
		expect(existsSync(join(ws, "ro.txt"))).toBe(false);
		r = await run("echo quiet > /dev/null && head -c 4 /bin/sh > /dev/null && echo ok", ws, "read-only");
		expect(r.out.trim()).toBe("ok");
	});

	it("命令的退出状态和死法就是 runner 的", async () => {
		const ws = await tempDir("plume-ll-st-");
		expect((await run("exit 3", ws, "workspace-write")).code).toBe(3);
		expect((await run("kill -TERM $$", ws, "workspace-write")).signal).toBe("SIGTERM");
		// runner 怎么起的，命令不继承。
		expect((await run('printf %s "$ELECTRON_RUN_AS_NODE"', ws, "workspace-write")).out).toBe("");
	});

	/*
	 * 从新进程里经 `syscall` 问内核——每条受限命令的 runner 都这样起——问很多次。x86_64 上曾经约十八分之一的进程 SIGSEGV
	 * （见 `libc.ts` 的 `syscallThrough`），一次跑过说明不了什么，连着八十次靠运气活下来不到百分之一。
	 */
	it("问 Landlock 版本从不把进程带走", async () => {
		const landlockModule = new URL("../src/linux/landlock.ts", import.meta.url).href;
		const script = `import(${JSON.stringify(landlockModule)}).then((m) => console.log(m.landlockAbi()))`;
		const endings: string[] = [];
		let started = 0;
		const lane = async () => {
			while (started < 80) {
				started++;
				endings.push(
					await new Promise<string>((resolve) => {
						const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", script], { stdio: "ignore" });
						child.on("close", (code, signal) => resolve(signal ?? `exit ${code}`));
					}),
				);
			}
		};
		await Promise.all(Array.from({ length: 8 }, lane));
		expect([...new Set(endings)]).toEqual(["exit 0"]);
	}, 120_000);
});
