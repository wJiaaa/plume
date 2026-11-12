/**
 * Windows 上起命令、停命令的那几处选项，在任何机器上验。
 *
 * 不起真进程：截下 `spawn`、`execFile`，假装平台是 win32，看它们拿到了什么。这几处的问题全在选项里：漏了 `windowsHide`
 * 每条命令闪一个黑窗口；进程组的负 pid 在 Windows 上停不了任何东西；没有 /F 的 taskkill 停不了控制台程序；不看退出状态的 taskkill
 * 可能停到复用了这个 pid 的别的进程。
 */

import { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { file: string; args: readonly string[]; options: Record<string, unknown> };
const spawned: Call[] = [];
const killed: { file: string; args: readonly string[] }[] = [];
let killFailure: Error | undefined;
let child: ChildProcess;

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => {
		spawned.push({ file, args, options });
		return child;
	},
	execFile: (file: string, args: readonly string[], _options: unknown, callback: (error: Error | null) => void) => {
		killed.push({ file, args });
		// 不带 /F 时 Windows 控制台子进程拒绝 taskkill 的关窗请求。
		callback(killFailure ?? (args.includes("/F") ? null : new Error("This process can only be terminated forcefully (with /F option).")));
		return new ChildProcess();
	},
}));

const { runCommand } = await import("../src/local.ts");
const { resetProbeCache } = await import("../src/backend.ts");
const { commandEnv, primeCommandPath } = await import("../src/login-path.ts");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
/** 指定 shell：选 shell 不是这里要验的，Windows 上的 PowerShell 还会往临时目录写脚本文件。 */
const shell = { file: "bash.exe", kind: "posix" as const, label: "Git Bash", args: (command: string) => ["-c", command] };

beforeEach(() => {
	spawned.length = 0;
	killed.length = 0;
	killFailure = undefined;
	child = Object.assign(new ChildProcess(), { pid: 43210, stdout: new PassThrough(), stderr: new PassThrough() });
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	resetProbeCache();
});

afterEach(() => {
	Object.defineProperty(process, "platform", platform);
});

describe("起命令", () => {
	it("不开控制台窗口，也不 detached（那会给它一个新控制台）", () => {
		runCommand("node server.cjs", { cwd: process.cwd(), shell });
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.options.windowsHide).toBe(true);
		expect(spawned[0]?.options.detached).toBe(false);
	});

	it("shell 按会话宣布的模式选：提权成完全访问的 PowerShell 命令仍在 PowerShell 里跑", () => {
		// 让这台机器看上去装了 Git Bash：不受约束的命令本该跑在它里面。
		const dir = mkdtempSync(join(tmpdir(), "plume-win-shell-"));
		const bash = join(dir, "bash.exe");
		writeFileSync(bash, "");
		vi.stubEnv("PLUME_SHELL", bash);
		try {
			runCommand("Get-ChildItem", { cwd: process.cwd(), mode: "danger-full-access", shellMode: "workspace-write" });
			runCommand("ls", { cwd: process.cwd(), mode: "danger-full-access" });
		} finally {
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		}
		expect(spawned[0]?.file).not.toBe(bash);
		expect(spawned[0]?.args).toContain("-File");
		expect(spawned[1]?.file).toBe(bash);
	});
});

describe("停命令", () => {
	const errors: Error[] = [];
	const start = () => {
		errors.length = 0;
		const sandbox = runCommand("node server.cjs", { cwd: process.cwd(), shell });
		sandbox.onError((error) => errors.push(error));
		return sandbox;
	};

	it("平常的停和强制的停都是停自己那棵进程树：taskkill /T /F", () => {
		start().kill("SIGTERM");
		start().kill("SIGKILL");
		expect(errors).toEqual([]);
		expect(killed).toEqual([
			{ file: "taskkill", args: ["/PID", "43210", "/T", "/F"] },
			{ file: "taskkill", args: ["/PID", "43210", "/T", "/F"] },
		]);
	});

	it("已经结束的进程不再 taskkill：pid 可能已经给了别的进程", () => {
		const sandbox = start();
		Object.defineProperty(child, "exitCode", { value: 0 });
		sandbox.kill("SIGTERM");
		sandbox.kill("SIGKILL");
		expect(killed).toEqual([]);
	});

	it("进程还活着而没停掉时，报出来", () => {
		killFailure = new Error("Access is denied.");
		start().kill("SIGTERM");
		expect(errors).toEqual([killFailure]);
	});
});

describe("登录 shell 的环境", () => {
	it("Windows 上不问登录 shell，环境原样（`Path` 不会多出一个 `PATH`）", async () => {
		await primeCommandPath({ always: true });
		expect(spawned).toEqual([]);
		const inherited = { Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd", TERM: undefined };
		const env = commandEnv(inherited);
		expect(env).toEqual(inherited);
		expect("PATH" in env).toBe(false);
	});
});
