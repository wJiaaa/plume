import { describe, expect, it } from "vitest";
import type { TerminalPanelSignal } from "../src/api.ts";
import { composeReusedCommand, createTerminalExec, formatShellInput, stripAnsi, wrapPosixCommand, wrapWaitForExitCommand } from "../src/exec.ts";
import { createTerminalRegistry, type Pty, type SpawnPty } from "../src/registry.ts";

interface FakePty extends Pty {
	say(chunk: string): void;
	quit(code: number): void;
	killed: boolean;
	typed: string[];
	env: Record<string, string>;
	cwd: string;
}

function fakeSpawn() {
	const spawned: FakePty[] = [];
	const spawn: SpawnPty = (_file, _args, options) => {
		const data = new Set<(chunk: string) => void>();
		const exit = new Set<(event: { exitCode: number; signal?: number }) => void>();
		const pty: FakePty = {
			pid: spawned.length + 1,
			process: "zsh",
			killed: false,
			typed: [],
			env: options.env,
			cwd: options.cwd,
			onData: (listener) => (data.add(listener), { dispose: () => data.delete(listener) }),
			onExit: (listener) => (exit.add(listener), { dispose: () => exit.delete(listener) }),
			write: (chunk: string) => void pty.typed.push(chunk),
			resize: () => undefined,
			kill: () => {
				pty.killed = true;
			},
			say: (chunk) => data.forEach((listener) => listener(chunk)),
			quit: (code) => exit.forEach((listener) => listener({ exitCode: code })),
		};
		spawned.push(pty);
		return pty;
	};
	return { spawn, spawned };
}

describe("terminal.exec 工具函数", () => {
	it("stripAnsi 去除 ANSI 转义与控制字符", () => {
		expect(stripAnsi("\x1b[32m__PLUME_EXIT_abc__:0\x1b[0m\x07")).toBe("__PLUME_EXIT_abc__:0");
	});

	it("wrapWaitForExitCommand 在 POSIX 和 PowerShell 下命令行原文不含完整哨兵串，cmd 返回 null", () => {
		const token = "a1b2c3d4";
		const posix = wrapWaitForExitCommand("echo hi\nexit 7", "posix", "/bin/zsh", token)!;
		expect(posix).not.toContain(`__PLUME_EXIT_${token}__:`);
		expect(posix).toContain(`'${token}'`);

		const ps = wrapWaitForExitCommand("npm test", "powershell", "pwsh.exe", token)!;
		expect(ps).not.toContain(`__PLUME_EXIT_${token}__:`);
		expect(ps).toContain(`"${token}"`);

		const fish = wrapWaitForExitCommand("npm test", "posix", "/usr/bin/fish", token)!;
		expect(fish).not.toContain(`__PLUME_EXIT_${token}__:`);
		expect(fish).toContain(`'${token}'`);

		expect(wrapWaitForExitCommand("dir", "cmd", "cmd.exe", token)).toBeNull();
	});

	it("wrapPosixCommand 超过 1 KiB 时自动拆行并每行保留前导空格", () => {
		const longCmd = `echo ${"a".repeat(1200)}`;
		const wrapped = wrapPosixCommand(longCmd, "tok123");
		expect(wrapped).toContain("\r ");
		expect(wrapped).not.toContain("__PLUME_EXIT_tok123__:");
	});

	it("formatShellInput 带前导空格抑制历史，POSIX 多行按括号粘贴或安全编码发送", () => {
		expect(formatShellInput("pnpm dev", "posix", "/bin/zsh", true)).toBe(" pnpm dev\r");
		expect(formatShellInput("a=1\necho $a", "posix", "/bin/zsh", true)).toBe("\x1b[200~ a=1\recho $a\x1b[201~\r");
		const encoded = formatShellInput("a=1\necho $a", "posix", "/bin/zsh", false);
		expect(encoded.startsWith(" ")).toBe(true);
		expect(encoded).toContain("printf '%b_'");
	});

	it("composeReusedCommand 生成切目录与环境变量语句", () => {
		const posix = composeReusedCommand("darwin", "/bin/zsh", "posix", "/work/wt", "pnpm dev", {
			PLUME_PROJECT_ROOT: "/work/root",
			PLUME_WORKTREE_PATH: "/work/wt",
			"BAD-KEY": "ignored",
		});
		expect(posix).toContain("cd '/work/wt'");
		expect(posix).toContain("export PLUME_PROJECT_ROOT='/work/root'");
		expect(posix).toContain("export PLUME_WORKTREE_PATH='/work/wt'");
		expect(posix).not.toContain("BAD-KEY");

		const ps = composeReusedCommand("win32", "pwsh.exe", "powershell", "C:\\work", "pnpm dev", {
			PLUME_PROJECT_ROOT: "C:\\root",
		});
		expect(ps).toContain("Set-Location -LiteralPath 'C:\\work'");
		expect(ps).toContain("$env:PLUME_PROJECT_ROOT = 'C:\\root'");
	});
});

describe("createTerminalExec 与注册表扩展", () => {
	it("新开终端注入环境变量、自定义标题，等待括号粘贴就绪后再写入命令", async () => {
		const { spawn, spawned } = fakeSpawn();
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "darwin",
			env: { SHELL: "/bin/zsh" },
			home: "/home",
			isDirectory: () => true,
		});
		const signals: TerminalPanelSignal[] = [];
		const exec = createTerminalExec({
			registry,
			emitPanel: (signal) => void signals.push(signal),
			platform: "darwin",
			unsupportedMessage: () => "unsupported",
			quietMs: 50,
		});

		const result = await exec.run({
			sessionId: "s1",
			cwd: "/work/wt",
			command: "pnpm dev",
			env: { PLUME_PROJECT_ROOT: "/work/root", PLUME_WORKTREE_PATH: "/work/wt" },
			title: "Dev",
			tag: "script-stop-on-archive",
			reveal: false,
		});

		expect(signals).toEqual([{ type: "open", sessionId: "s1", tab: result.tab, reveal: false }]);
		expect(registry.list()[0]?.title).toBe("Dev");
		expect(spawned[0]!.env.PLUME_PROJECT_ROOT).toBe("/work/root");
		expect(spawned[0]!.env.PLUME_WORKTREE_PATH).toBe("/work/wt");
		// shell 还没就绪时暂不写入命令。
		expect(spawned[0]!.typed).toEqual([]);

		// 跨块到达括号粘贴开启序列。
		spawned[0]!.say("\x1b[?20");
		spawned[0]!.say("04h");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(spawned[0]!.typed).toEqual([" pnpm dev\r"]);
	});

	it("静默回退在没有括号粘贴序列且无前台子进程时放行写入", async () => {
		const { spawn, spawned } = fakeSpawn();
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "darwin",
			env: { SHELL: "/bin/sh" },
			home: "/home",
			isDirectory: () => true,
		});
		const exec = createTerminalExec({
			registry,
			emitPanel: () => undefined,
			platform: "darwin",
			unsupportedMessage: () => "unsupported",
			quietMs: 25,
		});

		await exec.run({ sessionId: "s1", cwd: "/work", command: "echo ok" });
		expect(spawned[0]!.typed).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 45));
		expect(spawned[0]!.typed).toEqual([" echo ok\r"]);
	});

	it("reuseIdle 优先复用同会话无标记的空闲终端，跳过带标记或非同会话的终端", async () => {
		const { spawn, spawned } = fakeSpawn();
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "darwin",
			env: { SHELL: "/bin/zsh" },
			home: "/home",
			isDirectory: () => true,
		});
		const signals: TerminalPanelSignal[] = [];
		const exec = createTerminalExec({
			registry,
			emitPanel: (signal) => void signals.push(signal),
			platform: "darwin",
			unsupportedMessage: () => "unsupported",
			quietMs: 20,
		});

		// 手动打开一个归属 s1 的终端标签。
		registry.openForTab("manual-tab", "/work/old", 80, 24, { sessionId: "s1" });
		const first = await exec.run({
			sessionId: "s1",
			cwd: "/work/new",
			command: "pnpm test",
			env: { PLUME_PROJECT_ROOT: "/work/new" },
			title: "Test",
			reuseIdle: true,
		});
		expect(first.tab).toBe("manual-tab");
		expect(spawned).toHaveLength(1);
		expect(registry.list()[0]?.title).toBe("Test");
		expect(spawned[0]!.typed[0]).toContain("cd '/work/new'");
		expect(spawned[0]!.typed[0]).toContain("PLUME_PROJECT_ROOT='/work/new'");
		expect(signals.at(-1)).toEqual({ type: "open", sessionId: "s1", tab: "manual-tab", reveal: true });
	});

	it("waitForExit 忽略回显、剥离 ANSI 后解析退出码，提前退出或中止返回 null", async () => {
		const { spawn, spawned } = fakeSpawn();
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "darwin",
			env: { SHELL: "/bin/zsh" },
			home: "/home",
			isDirectory: () => true,
		});
		const exec = createTerminalExec({
			registry,
			emitPanel: () => undefined,
			platform: "darwin",
			unsupportedMessage: () => "unsupported",
			quietMs: 20,
		});

		const run1 = await exec.run({
			sessionId: "s1",
			cwd: "/work",
			command: "pnpm install",
			waitForExit: true,
		});
		spawned[0]!.say("\x1b[?2004h");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const written = spawned[0]!.typed[0]!;
		const token = /'([0-9a-f]{24})'/.exec(written)?.[1];
		expect(token).toBeTruthy();

		// 模拟 PTY 回显命令行原文：不应误触发完成。
		spawned[0]!.say(`${written}\r\n`);
		let resolved = false;
		void run1.completion!.then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(resolved).toBe(false);

		// 带 ANSI 颜色的真实哨兵行。
		spawned[0]!.say(`\x1b[32m__PLUME_EXIT_${token}__:42\x1b[0m\r\n`);
		expect(await run1.completion).toEqual({ exitCode: 42 });

		// 提前退出 -> exitCode: null
		const run2 = await exec.run({ sessionId: "s1", cwd: "/work", command: "sleep 10", waitForExit: true });
		spawned[1]!.quit(1);
		expect(await run2.completion).toEqual({ exitCode: null });

		// signal 中止 -> exitCode: null
		const controller = new AbortController();
		const run3 = await exec.run({
			sessionId: "s1",
			cwd: "/work",
			command: "sleep 10",
			waitForExit: true,
			signal: controller.signal,
		});
		controller.abort();
		expect(await run3.completion).toEqual({ exitCode: null });
	});

	it("waitForExit 在 cmd.exe 上明确报错并清理新开标签", async () => {
		const { spawn, spawned } = fakeSpawn();
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "win32",
			env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
			home: "C:\\Users\\me",
			isDirectory: () => true,
		});
		const exec = createTerminalExec({
			registry,
			emitPanel: () => undefined,
			platform: "win32",
			unsupportedMessage: () => "cmd unsupported",
		});

		await expect(exec.run({ sessionId: "s1", cwd: "C:\\work", command: "dir", waitForExit: true })).rejects.toThrow("cmd unsupported");
		expect(spawned[0]!.killed).toBe(true);
		expect(registry.list()).toHaveLength(0);
	});

	it("closeByTag 只关闭对应会话与标记的终端并发出关闭信号，reveal 发出展示信号", async () => {
		const { spawn, spawned } = fakeSpawn();
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "darwin",
			env: { SHELL: "/bin/zsh" },
			home: "/home",
			isDirectory: () => true,
		});
		const signals: TerminalPanelSignal[] = [];
		const exec = createTerminalExec({
			registry,
			emitPanel: (signal) => void signals.push(signal),
			platform: "darwin",
			unsupportedMessage: () => "unsupported",
		});

		const dev = await exec.run({ sessionId: "s1", cwd: "/work", command: "pnpm dev", tag: "stop-tag" });
		const other = await exec.run({ sessionId: "s1", cwd: "/work", command: "pnpm test" });
		const otherSession = await exec.run({ sessionId: "s2", cwd: "/work", command: "pnpm dev", tag: "stop-tag" });

		await exec.reveal("s1", other.tab);
		expect(signals.at(-1)).toEqual({ type: "open", sessionId: "s1", tab: other.tab, reveal: true });

		await exec.closeByTag("s1", "stop-tag");
		expect(spawned[0]!.killed).toBe(true);
		expect(spawned[1]!.killed).toBe(false);
		expect(spawned[2]!.killed).toBe(false);
		expect(signals.at(-1)).toEqual({ type: "close", sessionId: "s1", tab: dev.tab });
		expect(registry.list()).toHaveLength(2);
		expect(otherSession.tab).toBeTruthy();
	});
});
