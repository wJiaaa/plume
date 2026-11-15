/**
 * 新终端起哪个 shell、带什么环境。平台和环境都是参数：Windows 的情况在跑测试的任何机器上都能查。
 */

import { describe, expect, it } from "vitest";
import { createTerminalRegistry, type SpawnPty } from "../src/registry.ts";
import { findExecutable, pickShell, shellArgs, shellEnv, windowsPtyFor } from "../src/shell.ts";
import { createRegistryEnv, withRegistryEnv } from "../src/windows-env.ts";

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function finder(present: string[]) {
	return (command: string) => present.find((path) => path.toLowerCase().endsWith(`\\${command.toLowerCase()}`) || path === command) ?? null;
}

/** 记下每次起 shell 时拿到的程序、参数和环境。 */
function recorder() {
	const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
	const spawn: SpawnPty = (file, args, options) => {
		spawned.push({ file, args, env: options.env });
		const nothing = { dispose() {} };
		return { pid: 1, process: "", onData: () => nothing, onExit: () => nothing, write() {}, resize() {}, kill() {} };
	};
	return { spawn, spawned };
}

describe("选哪个 shell", () => {
	it("Windows 上 POSIX 写法的 SHELL 不算，有 PowerShell 7 就用它", () => {
		const env = { SHELL: "/usr/bin/bash", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
		expect(pickShell("win32", env, finder([PWSH, POWERSHELL]))).toBe(PWSH);
	});

	it("没有 PowerShell 7 是 Windows PowerShell，两个都没有是 ComSpec", () => {
		const env = { SHELL: "/usr/bin/bash", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
		expect(pickShell("win32", env, finder([POWERSHELL]))).toBe(POWERSHELL);
		expect(pickShell("win32", env, finder([]))).toBe("C:\\Windows\\system32\\cmd.exe");
		// ComSpec 不管环境里拼成什么大小写，再不行按名字找 cmd.exe。
		expect(pickShell("win32", { COMSPEC: "D:\\cmd.exe" }, finder([]))).toBe("D:\\cmd.exe");
		expect(pickShell("win32", {}, finder([]))).toBe("cmd.exe");
	});

	it("PATH 里没列，也在 System32 里找到 Windows PowerShell", () => {
		const onlyByPath = (command: string) => (command === POWERSHELL ? POWERSHELL : null);
		expect(pickShell("win32", { SystemRoot: "C:\\Windows" }, onlyByPath)).toBe(POWERSHELL);
	});

	it("SHELL 是存在的 Windows 路径时照旧用它", () => {
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		expect(pickShell("win32", { SHELL: gitBash }, finder([gitBash, PWSH]))).toBe(gitBash);
		expect(pickShell("win32", { SHELL: gitBash }, finder([PWSH]))).toBe(PWSH);
	});

	it("别处 SHELL 就是答案", () => {
		expect(pickShell("linux", { SHELL: "/usr/bin/fish" }, finder([]))).toBe("/usr/bin/fish");
		expect(pickShell("darwin", {}, finder([]))).toBe("/bin/bash");
	});

	it("macOS 和 Windows 的 Git Bash 起登录 shell；PowerShell、cmd 什么都不加", () => {
		expect(shellArgs("darwin")).toEqual(["-l"]);
		expect(shellArgs("linux")).toEqual([]);
		expect(shellArgs("win32", "C:\\Program Files\\Git\\bin\\bash.exe")).toEqual(["--login"]);
		expect(shellArgs("win32", "C:\\Program Files\\Git\\bin\\BASH.EXE")).toEqual(["--login"]);
		expect(shellArgs("win32", PWSH)).toEqual([]);
		expect(shellArgs("win32", "C:\\Windows\\system32\\cmd.exe")).toEqual([]);
	});

	it("Windows 上按 PATHEXT 补扩展名，`Path` 和 `PATH` 一样认，PATH 里带引号的目录去掉引号", () => {
		// 这台机器上没有这些文件：只看它不去找 POSIX 写法的、也不会因为大小写找不到 PATH。
		expect(findExecutable("pwsh", "win32", { Path: '"C:\\nowhere"', PATHEXT: ".EXE" })).toBeNull();
		expect(findExecutable("/bin/sh", "darwin", {})).toBe("/bin/sh");
	});
});

describe("shell 的环境", () => {
	it("告诉 shell 它跑在 xterm 里；macOS 没有区域设置时只补 LC_CTYPE", () => {
		const env = shellEnv("darwin", { TERM: "dumb", COLORTERM: "" });
		expect(env.TERM).toBe("xterm-256color");
		expect(env.COLORTERM).toBe("truecolor");
		expect(env.LC_CTYPE).toBe("en_US.UTF-8");
		expect(shellEnv("darwin", { LANG: "zh_CN.UTF-8" }).LC_CTYPE).toBeUndefined();
		expect(shellEnv("win32", {}).LC_CTYPE).toBeUndefined();
	});

	it("注册表的值盖住继承来的，用户的盖住机器的，不管大小写", () => {
		const env = withRegistryEnv(
			{ JAVA_HOME: "C:\\old-jdk", Path: "C:\\Windows", USERNAME: "me" },
			{ JAVA_HOME: "C:\\machine-jdk", NVM_HOME: "C:\\nvm", USERNAME: "SYSTEM" },
			{ java_home: "C:\\user-jdk" },
		);
		expect(env.JAVA_HOME).toBe("C:\\user-jdk");
		expect(env.java_home).toBeUndefined();
		expect(env.NVM_HOME).toBe("C:\\nvm");
		// 机器那一份的 USERNAME 是服务账号，不是人。
		expect(env.USERNAME).toBe("me");
	});

	it("PATH 是机器的、用户的，再接上启动 Plume 的程序加的，每个目录一次", () => {
		const env = withRegistryEnv(
			{ PATH: "C:\\Windows;C:\\from-launcher\\" },
			{ Path: "C:\\Windows;C:\\Program Files\\nodejs\\" },
			{ Path: "C:\\Users\\me\\AppData\\Roaming\\npm;c:\\windows" },
		);
		expect(env.Path).toBeUndefined();
		expect(env.PATH).toBe("C:\\Windows;C:\\Program Files\\nodejs\\;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\from-launcher\\");
	});

	it("新标签等正在读的那一次；读失败时留着上一次读到的", async () => {
		let answer: ((value: { machine: Record<string, string>; user: Record<string, string> } | null) => void) | undefined;
		const fresh = createRegistryEnv(() => new Promise((done) => (answer = done)), 1_500, 0);
		const inherited = { Path: "C:\\Windows" };
		expect(fresh.current(inherited)).toBe(inherited);
		fresh.refresh();
		const waiting = fresh.settled();
		answer?.({ machine: { Path: "C:\\Program Files\\nodejs" }, user: {} });
		await waiting;
		expect(fresh.current(inherited).Path).toBe("C:\\Program Files\\nodejs;C:\\Windows");

		fresh.refresh();
		answer?.(null);
		await fresh.settled();
		expect(fresh.current(inherited).Path).toBe("C:\\Program Files\\nodejs;C:\\Windows");
	});

	it("窗口来回拿到焦点不会每次都读一遍", async () => {
		let reads = 0;
		const fresh = createRegistryEnv(async () => (reads++, null));
		fresh.refresh();
		await fresh.settled();
		fresh.refresh();
		expect(reads).toBe(1);
	});

	it("读得慢也不让新标签等过 wait", async () => {
		const fresh = createRegistryEnv(() => new Promise(() => {}), 20);
		fresh.refresh();
		const started = Date.now();
		await fresh.settled();
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("每个 shell 用开它那一刻的环境", () => {
		const { spawn, spawned } = recorder();
		let now: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
		const registry = createTerminalRegistry({
			spawnPty: spawn,
			platform: "win32",
			env: { Path: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
			currentEnv: () => now,
			home: "C:\\Users\\me",
			isDirectory: () => true,
		});
		registry.open("C:\\proj", 80, 24);
		expect(spawned[0]?.env.Path).toBe("C:\\Windows");
		now = { Path: "C:\\Program Files\\nodejs;C:\\Windows" };
		registry.open("C:\\proj", 80, 24);
		expect(spawned[1]?.env.Path).toBe("C:\\Program Files\\nodejs;C:\\Windows");
	});
});

it("Windows 的 pty 如实告诉 xterm：后端和版本号", () => {
	expect(windowsPtyFor("win32", "10.0.22631")).toEqual({ backend: "conpty", buildNumber: 22631 });
	// 18309 以前 node-pty 用 winpty，xterm 也要听到一样的。
	expect(windowsPtyFor("win32", "10.0.17763")).toEqual({ backend: "winpty", buildNumber: 17763 });
	// 读不出版本号：仍按 ConPTY 处理回滚，没有版本号证明安全就不开重排。
	expect(windowsPtyFor("win32", undefined)).toEqual({ backend: "conpty" });
	expect(windowsPtyFor("darwin", "26.0.0")).toBeUndefined();
	expect(windowsPtyFor("linux", "6.8.0")).toBeUndefined();
});
