/**
 * Windows 的受限令牌后端。
 *
 * 前半在任何机器上都能跑：选后端、包装的 argv、能力 SID 和命令行引号这些纯字符串活、runner 的参数约定、手工拼的结构体布局、
 * 从输出认出拒绝。Win32 调用本身只有真的 Windows 才能跑，后半那几条只在 Windows 上跑，不注入探测：像应用那样起 runner，
 * 经 PowerShell（受约束的命令在那里跑的 shell）看项目能写、磁盘其余部分写不了、shell 要的东西都还在。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import type { SandboxMode } from "@plume/contract";
import { commandShell, resetSystemShell, systemShell } from "@plume/platform";
import { confine, looksDenied, resetProbeCache, SandboxUnavailableError, selectRunner } from "../src/backend.ts";
import { runCommand } from "../src/local.ts";
import { SANDBOX_RUNNER_FLAG } from "../src/runner-flag.ts";
import * as abi from "../src/windows/abi.ts";
import { buildCommandLine, quoteArg, restrictingSidNames, tempWriteSid, workspaceWriteSid } from "../src/windows/identity.ts";
import { explicitAccess } from "../src/windows/restrict.ts";
import { parseArgs, RUNNER_FAILURE_EXIT, RUNNER_FAILURE_PREFIX } from "../src/windows/runner.ts";

const win = { platform: "win32" as const, probe: () => true };
const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("选后端与包装", () => {
	beforeEach(() => resetProbeCache());

	it("探测通过时 Windows 用受限令牌，而且如实报只管住一部分", () => {
		// 受限列表里必须有 Everyone，给 Everyone 写权限的对象都还能写；硬链接能把授权树里的文件别名到树外。要绝对边界的调用方得分得出来。
		expect(selectRunner(win)).toBe("windows-acl");
		const wrap = confine({ mode: "workspace-write", workspaceRoot: "C:\\work" }, win);
		expect(wrap).toMatchObject({ runner: "windows-acl", enforcement: "partial" });
	});

	it("探测失败的 Windows 照样 fail-closed", () => {
		// 探测跑的是整条链：令牌、默认 DACL、CreateProcessAsUserW。哪一环不行，这台机器就管不住，不提供。
		expect(selectRunner({ platform: "win32", probe: () => false })).toBe("none");
		resetProbeCache();
		expect(() => confine({ mode: "workspace-write", workspaceRoot: "C:\\w" }, { platform: "win32", probe: () => false })).toThrow(SandboxUnavailableError);
	});

	it("包装用本进程的运行时当 Node 起 runner", () => {
		// Electron 下没有单独的 node 可用，另带一份是要跟着升级的第二个运行时。
		const wrap = confine({ mode: "workspace-write", workspaceRoot: "C:\\work" }, win);
		expect(wrap?.command).toBe(process.execPath);
		expect(wrap?.env?.ELECTRON_RUN_AS_NODE, "不设的话 runner 会起第二个应用").toBe("1");
		expect(wrap?.args).toContain(SANDBOX_RUNNER_FLAG);
		expect(wrap?.args.at(-1), "被包装的命令跟在分隔符后面").toBe("--");
	});

	it("runner 的 argv 先是脚本，再是旗标，真起得来", () => {
		/*
		 * 旗标一直在参数里，要紧的是位置：Node 模式下第一个不是 Node 自己选项的参数必须是脚本，旗标放在那里是 `bad option`，
		 * 退出码 9。所以真起一次：这个平台上 runner 会说它不管，能说出来就说明它起来了。
		 */
		const wrap = confine({ mode: "workspace-write", workspaceRoot: "C:\\work" }, win);
		if (!wrap) throw new Error("受限模式必须有包装");
		const script = wrap.args.findIndex((arg) => /runner-entry\.ts$|index\.mjs$/.test(arg));
		expect(script, wrap.args.join(" ")).toBeGreaterThanOrEqual(0);
		expect(script, "脚本得在旗标前面").toBeLessThan(wrap.args.indexOf(SANDBOX_RUNNER_FLAG));
		if (process.platform !== "win32") {
			const started = spawnSync(wrap.command, [...wrap.args, "true"], { encoding: "utf8", env: { ...process.env, ...wrap.env } });
			expect(started.stderr).not.toMatch(/bad option/);
			expect(started.stderr).toMatch(/不用这个 runner/);
			expect(started.status).toBe(127);
		}
	});

	it("workspace-write 点名从工作区推出的能力，再带一个自有身份的私有临时目录", () => {
		// Seatbelt 和 bwrap 授权临时目录；这里没有的话 Git Bash 里每个 heredoc 都失败。
		const wrap = confine({ mode: "workspace-write", workspaceRoot: "C:\\work" }, win);
		if (!wrap) throw new Error("受限模式必须有包装");
		expect(flagValue(wrap.args, "--write-sid")).toMatch(/^S-1-4-\d+-\d+$/);
		expect(flagValue(wrap.args, "--temp")).toMatch(/plume-sandbox/);
		expect(flagValue(wrap.args, "--temp-sid"), "临时目录的身份，不是工作区的").toMatch(/^S-1-4-\d+-\d+-1$/);
		expect(flagValue(wrap.args, "--temp-sid")).not.toBe(flagValue(wrap.args, "--write-sid"));
	});

	it("read-only 也带同一个私有临时目录，但不带工作区的写能力", () => {
		/*
		 * 受约束的命令在这里跑 PowerShell，写不了 `%TEMP%` 时它以 ConstrainedLanguage 运行：自己的 UTF-8 设置在每条只读命令上失败，
		 * 模型写的东西也坏一半。项目照样写不了：没有 `--write-sid`，之前留下的授权也就是死的。
		 */
		const writable = confine({ mode: "workspace-write", workspaceRoot: "C:\\work" }, win);
		const readOnly = confine({ mode: "read-only", workspaceRoot: "C:\\work" }, win);
		if (!writable || !readOnly) throw new Error("受限模式必须有包装");
		expect(flagValue(readOnly.args, "--temp")).toBe(flagValue(writable.args, "--temp"));
		expect(readOnly.args).not.toContain("--write-sid");
	});
});

describe("能力 SID", () => {
	it("形状对，落在非唯一授权机构段", () => {
		expect(workspaceWriteSid("C:\\Users\\me\\project")).toMatch(/^S-1-4-\d+-\d+$/);
	});

	it("同一个工作区总推出同一个，不同的推出不同的", () => {
		// 稳定，目录上的 ACE 才只写一次，而不是每个会话一次。
		expect(workspaceWriteSid("C:\\work\\app")).toBe(workspaceWriteSid("C:\\work\\app"));
		expect(workspaceWriteSid("C:\\work\\a")).not.toBe(workspaceWriteSid("C:\\work\\b"));
		// 只差结尾的也不同：截断的哈希会在这里撞。
		expect(workspaceWriteSid("C:\\work\\project1")).not.toBe(workspaceWriteSid("C:\\work\\project2"));
	});

	it("子授权不为零，且在 30 位以内", () => {
		for (const path of ["C:\\a", "C:\\b", "D:\\very\\deep\\path\\here", "\\\\server\\share", "C:\\long\\path\\with\\many\\segments"]) {
			for (const part of workspaceWriteSid(path).split("-").slice(3)) {
				expect(Number(part), `${path} → ${part}`).toBeGreaterThan(0);
				expect(Number(part), `${path} → ${part}`).toBeLessThan(2 ** 30);
			}
		}
	});

	it("临时目录的身份不会被当成工作区的，推法也是分开的", () => {
		// 共用一个身份，每个会话都能写别的会话的临时目录。
		const path = "C:\\Temp\\same";
		expect(tempWriteSid(path)).toMatch(/^S-1-4-\d+-\d+-1$/);
		expect(tempWriteSid(path)).not.toBe(workspaceWriteSid(path));
		// 前两段也得不同，否则域分隔没起作用。
		expect(tempWriteSid(path).split("-").slice(3, 5)).not.toEqual(workspaceWriteSid(path).split("-").slice(3, 5));
	});
});

describe("命令行引号", () => {
	it("没什么特别的参数原样", () => {
		expect(quoteArg("hello")).toBe("hello");
		expect(quoteArg("C:\\dir\\file.txt")).toBe("C:\\dir\\file.txt");
	});

	it("空参数也得是个参数，否则后面的参数整体错一位", () => {
		expect(quoteArg("")).toBe('""');
	});

	it("有空格加引号；收尾引号前的反斜杠加倍；字面引号前的加倍再加一；别处的不动", () => {
		expect(quoteArg("C:\\Program Files\\app.exe")).toBe('"C:\\Program Files\\app.exe"');
		// `"C:\dir\"` 会把自己的收尾引号转义掉，吞下整行剩下的部分。
		expect(quoteArg("C:\\my dir\\")).toBe('"C:\\my dir\\\\"');
		expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteArg('a\\"b c')).toBe('"a\\\\\\"b c"');
		expect(quoteArg("C:\\a\\b c")).toBe('"C:\\a\\b c"');
	});

	it("按 CRT 自己的拆法拆回去，参数原样", () => {
		// 引号对不对要看拆的那一边：这是程序拆命令行的那套规则，经得住它的就能原样到达程序。
		const split = (line: string): string[] => {
			const out: string[] = [];
			let current = "";
			let inQuotes = false;
			let started = false;
			for (let i = 0; i < line.length; i++) {
				const char = line[i]!;
				if (char === "\\") {
					let slashes = 0;
					while (i < line.length && line[i] === "\\") {
						slashes++;
						i++;
					}
					if (i < line.length && line[i] === '"') {
						current += "\\".repeat(Math.floor(slashes / 2));
						if (slashes % 2 === 1) current += '"';
						else inQuotes = !inQuotes;
						started = true;
					} else {
						current += "\\".repeat(slashes);
						if (slashes > 0) started = true;
						i--;
					}
					continue;
				}
				if (char === '"') {
					inQuotes = !inQuotes;
					started = true;
					continue;
				}
				if (!inQuotes && /\s/.test(char)) {
					if (started) out.push(current);
					current = "";
					started = false;
					continue;
				}
				current += char;
				started = true;
			}
			if (started) out.push(current);
			return out;
		};
		const cases = [
			["simple"],
			["with space", "another"],
			["C:\\Program Files\\node.exe", "-e", 'console.log("hi")'],
			["trailing\\", "next"],
			["", "after empty"],
			['quote"inside', "a\\\\b"],
			["C:\\dir\\", "-flag", "value with spaces"],
		];
		for (const argv of cases) expect(split(buildCommandLine(argv[0]!, argv.slice(1))), JSON.stringify(argv)).toEqual(argv);
	});
});

describe("受限列表", () => {
	it("read-only 一个写能力都不带，workspace-write 带给它的、去重", () => {
		expect(restrictingSidNames("read-only", ["S-1-4-1-2"]).write).toEqual([]);
		expect(restrictingSidNames("workspace-write", ["S-1-4-1-2", "S-1-4-3-4-1"]).write).toEqual(["S-1-4-1-2", "S-1-4-3-4-1"]);
		expect(restrictingSidNames("workspace-write", ["S-1-4-1-2", "S-1-4-1-2"]).write).toEqual(["S-1-4-1-2"]);
	});

	it("workspace-write 没有能力时拒绝，而不是悄悄变成只读", () => {
		expect(() => restrictingSidNames("workspace-write", [])).toThrow(/至少需要一个/);
	});

	it("保命的两个身份总在", () => {
		// 缺了它们进程在加载器初始化时就死，这也是这里报 partial 的原因。
		for (const mode of ["read-only", "workspace-write"] as const) expect(restrictingSidNames(mode, ["S-1-4-9-9"])).toMatchObject({ logon: true, world: true });
	});
});

describe("runner 的参数约定", () => {
	it("拆成各个部分，`--` 之后全是命令（旗标也算）", () => {
		expect(parseArgs(["--workspace", "C:\\work\\app", "--mode", "read-only", "--", "cmd.exe", "/c", "echo hi"])).toEqual({
			workspace: "C:\\work\\app",
			mode: "read-only",
			command: ["cmd.exe", "/c", "echo hi"],
		});
		const args = parseArgs(["--workspace", "C:\\w", "--mode", "read-only", "--", "node", "--mode", "weird", "--"]);
		expect(args.command).toEqual(["node", "--mode", "weird", "--"]);
		expect(args.mode).toBe("read-only");
	});

	it("workspace-write 带能力 SID；两段、三段的都认；read-only 只带临时目录", () => {
		expect(parseArgs(["--workspace", "C:\\w", "--mode", "workspace-write", "--write-sid", "S-1-4-123-456", "--", "x"]).writeSid).toBe("S-1-4-123-456");
		expect(parseArgs(["--workspace", "C:\\w", "--mode", "workspace-write", "--write-sid", "S-1-4-1-2-1", "--", "x"]).writeSid).toBe("S-1-4-1-2-1");
		const readOnly = parseArgs(["--workspace", "C:\\w", "--mode", "read-only", "--temp", "C:\\t", "--temp-sid", "S-1-4-1-2-1", "--", "x"]);
		expect(readOnly.temp).toBe("C:\\t");
		expect(readOnly.writeSid).toBeUndefined();
	});

	it("该拒的各有各的理由", () => {
		expect(() => parseArgs(["--workspace", "C:\\w", "--mode", "workspace-write", "--", "x"])).toThrow(/必须带 --write-sid/);
		// 这个值点名一个身份：不是推出来的形状，要么不存在（授权是死的），要么是别人的。
		for (const bad of ["S-1-5-32-544", "S-1-4-abc-def", "S-1-4-1", "not-a-sid", "S-1-4-1-2-3-4", ""]) {
			expect(() => parseArgs(["--workspace", "C:\\w", "--mode", "workspace-write", "--write-sid", bad, "--", "x"]), bad).toThrow(/格式不对|必须带/);
		}
		// 不按默认值猜：往宽的方向猜错，正是这套设计要避免的那类错。
		expect(() => parseArgs(["--workspace", "C:\\w", "--mode", "danger-full-access", "--", "x"])).toThrow(/--mode 只能是/);
		expect(() => parseArgs(["--mode", "read-only", "--", "x"])).toThrow(/缺少 --workspace/);
		expect(() => parseArgs(["--workspace", "C:\\w", "--mode", "read-only"])).toThrow(/缺少 `--`/);
		expect(() => parseArgs(["--workspace", "C:\\w", "--mode", "read-only", "--"])).toThrow(/没有命令/);
		expect(() => parseArgs(["--workspace", "--mode", "read-only", "--", "x"])).toThrow(/缺少值/);
		expect(() => parseArgs(["workspace", "C:\\w", "--", "x"])).toThrow(/认不出的参数/);
		expect(() => parseArgs(["--workspace", "C:\\w", "--mode", "read-only", "--temp", "C:\\t", "--", "x"])).toThrow(/一起给/);
	});

	it("失败的约定是认得出的前缀和命令不会用的退出码", () => {
		// 后端靠它们分「没能约束」和「命令失败了」；把前者当后者，就是不受限地跑了还说是命令坏了。
		expect(RUNNER_FAILURE_PREFIX).toBe("windows-acl-run:");
		expect(RUNNER_FAILURE_EXIT).toBe(127);
	});
});

describe("EXPLICIT_ACCESS_W 的布局", () => {
	it("SID 指针落在受托者的 ptstrName 上，别处都不碰", () => {
		// 地址曾按受托者内的偏移从条目开头算，盖了 TrusteeForm、ptstrName 留空，Windows 只说「参数错误」，一条受限命令都起不来。
		const sid = 0x0000_7ff6_1234_5678n;
		const entry = explicitAccess(sid, abi.GRANT_ACCESS, abi.GRANT_MASK, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
		expect(entry.length, "x64 上的 sizeof(EXPLICIT_ACCESS_W)").toBe(48);
		expect(entry.readUInt32LE(0)).toBe(abi.GRANT_MASK);
		expect(entry.readUInt32LE(4)).toBe(abi.GRANT_ACCESS);
		expect(entry.readUInt32LE(8)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
		// TRUSTEE_W 从 16 开始：pMultipleTrustee (8)、MultipleTrusteeOperation (4)、TrusteeForm (4)、TrusteeType (4)、填充 (4)、ptstrName (8)。
		expect(entry.readBigUInt64LE(16)).toBe(0n);
		expect(entry.readUInt32LE(24)).toBe(abi.NO_MULTIPLE_TRUSTEE);
		expect(entry.readUInt32LE(28)).toBe(abi.TRUSTEE_IS_SID);
		expect(entry.readUInt32LE(32)).toBe(abi.TRUSTEE_IS_UNKNOWN);
		expect(entry.readBigUInt64LE(40)).toBe(sid);
	});

	it("默认 DACL 的条目不可继承，目录授权可继承", () => {
		expect(explicitAccess(1n, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS, abi.NO_INHERITANCE).readUInt32LE(8)).toBe(0);
		expect(explicitAccess(1n, abi.GRANT_ACCESS, abi.GRANT_MASK, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT).readUInt32LE(8)).toBe(3);
	});
});

describe("从输出认出 Windows 的拒绝", () => {
	it("受限令牌的拒绝用常见的词，只在它下面算；ssh 的两句从不算", () => {
		expect(looksDenied("Access is denied.", "windows-acl")).toBe(true);
		expect(looksDenied("/bin/bash: line 1: /home/u/x: Permission denied", "windows-acl")).toBe(true);
		expect(looksDenied("Access is denied.", "seatbelt")).toBe(false);
		expect(looksDenied("Permission denied, please try again.", "windows-acl")).toBe(false);
		expect(looksDenied("git@github.com: Permission denied (publickey).", "windows-acl")).toBe(false);
	});

	it("PowerShell 的拒绝、MSYS 程序在令牌下起不来，都算", () => {
		// 受限 PowerShell 写授权外的文件时的原样输出。
		const powershell =
			"Set-Content : Access to the path 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\plume-win-KHRkQe\\ps.txt' is denied.\n" +
			"    + CategoryInfo          : PermissionDenied: (C:\\Users\\runner...n-KHRkQe\\ps.txt:String) [Set-Content], UnauthorizedAccessException";
		expect(looksDenied(powershell, "windows-acl")).toBe(true);
		expect(looksDenied(powershell, "seatbelt"), "同样的话只在我们的 runner 下才算").toBe(false);
		// 受限 PowerShell 里 `git commit` 用 Git 的 `sh` 跑钩子，它一启动就死。
		const hook = "      0 [main] sh (1396) C:\\Program Files\\Git\\usr\\bin\\sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5";
		expect(looksDenied(hook, "windows-acl")).toBe(true);
		expect(
			looksDenied("0 [main] bash (2104) bash.exe: *** fatal error - CreateFileMapping S-1-5-21-1-2-3-500.1, Win32 error 5.  Terminating.", "windows-acl"),
		).toBe(true);
		expect(looksDenied(hook, "bwrap"), "Cygwin 的说法只代表 Windows 令牌").toBe(false);
		// 同一个运行时的别的 Win32 错误不是沙箱。
		expect(looksDenied("0 [main] bash (1) bash.exe: *** fatal error - couldn't allocate heap, Win32 error 487", "windows-acl")).toBe(false);
	});

	it("系统语言的拒绝也认得出，不是拒绝的翻译不算", () => {
		// 中文 Windows 上的 Windows PowerShell 5.1：消息翻译了，标识没翻译。
		const zhPowerShell =
			"Set-Content : 对路径“C:\\Users\\me\\x.txt”的访问被拒绝。\n" +
			"所在位置 行:1 字符: 1\n" +
			"    + CategoryInfo          : PermissionDenied: (C:\\Users\\me\\x.txt:String) [Set-Content], UnauthorizedAccessException";
		expect(looksDenied(zhPowerShell, "windows-acl")).toBe(true);
		// 只有翻译后的那句也够：PowerShell 7 的简洁视图只打印这个。
		expect(looksDenied("Set-Content: 对路径“C:\\Users\\me\\x.txt”的访问被拒绝。", "windows-acl")).toBe(true);
		// cmd 的内建命令打印系统对错误 5 的那句话。
		for (const message of [
			"拒绝访问。",
			"存取被拒。",
			"アクセスが拒否されました。",
			"액세스가 거부되었습니다.",
			"Zugriff verweigert",
			"Accès refusé.",
			"Acceso denegado.",
			"Отказано в доступе.",
			"Acesso negado.",
		]) {
			expect(looksDenied(message, "windows-acl"), message).toBe(true);
			expect(looksDenied(message, "seatbelt"), message).toBe(false);
		}
		expect(looksDenied("系统找不到指定的文件。", "windows-acl")).toBe(false);
		expect(
			looksDenied(
				"Get-Content : 找不到路径“C:\\x”，因为该路径不存在。\n    + CategoryInfo          : ObjectNotFound: (C:\\x:String) [Get-Content], ItemNotFoundException",
				"windows-acl",
			),
		).toBe(false);
	});
});

describe("真实的 Windows runner", () => {
	const onWindows = process.platform === "win32";
	const cleanup: string[] = [];
	afterEach(async () => {
		for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
	});
	const tempDir = async (prefix: string) => {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		cleanup.push(dir);
		return dir;
	};
	/** PowerShell 读的路径：单引号，引号写两遍。 */
	const ps = (path: string) => `'${path.replaceAll("'", "''")}'`;
	const run = (command: string, cwd: string, mode: SandboxMode, shell?: ReturnType<typeof commandShell>) =>
		new Promise<{ code: number | null; out: string }>((resolve) => {
			const child = runCommand(command, { cwd, mode, ...(shell ? { shell } : {}) });
			let out = "";
			child.onOutput((chunk) => {
				out += chunk;
			});
			child.onExit((code) => resolve({ code, out }));
			child.onError((error) => resolve({ code: -1, out: `spawn failed: ${error.message}` }));
		});

	test.skipIf(!onWindows)("直接起的 runner 能约束一条命令，不能时说出原因", { timeout: 60_000 }, () => {
		resetProbeCache();
		const wrap = confine({ mode: "read-only", workspaceRoot: process.cwd() }, win);
		if (!wrap) throw new Error("受限模式必须有包装");
		const started = spawnSync(wrap.command, [...wrap.args, "cmd.exe", "/c", "echo confined"], {
			encoding: "utf8",
			env: { ...process.env, ...wrap.env },
			windowsHide: true,
			timeout: 30_000,
		});
		expect(started.status, `stderr: ${started.stderr}\nargv: ${JSON.stringify([wrap.command, ...wrap.args])}`).toBe(0);
		expect(started.stdout).toMatch(/confined/);
	});

	test.skipIf(!onWindows)("runner 真起得来：探测通过，选中受限令牌", () => {
		resetProbeCache();
		let reason = "";
		try {
			confine({ mode: "read-only", workspaceRoot: process.cwd() });
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
		}
		expect(selectRunner(), reason).toBe("windows-acl");
	});

	test.skipIf(!onWindows)("装了 Git 的 Windows 上，不受约束的跑 Git Bash，受约束的跑 PowerShell", () => {
		resetSystemShell();
		expect(systemShell().label).toBe("Git Bash");
		expect(commandShell("danger-full-access").label).toBe("Git Bash");
		for (const mode of ["read-only", "workspace-write"] as const) expect(commandShell(mode).kind, mode).toBe("powershell");
	});

	test.skipIf(!onWindows)("workspace-write：项目和它的临时目录能写，磁盘其余部分不能", { timeout: 120_000 }, async () => {
		const ws = await tempDir("plume-win-ws-");
		const outside = join(homedir(), `plume-win-outside-${process.pid}.txt`);
		cleanup.push(outside);

		let r = await run("Set-Content -Path inside.txt -Value hi; Get-Content -Path inside.txt", ws, "workspace-write");
		expect(r.out.trim(), r.out).toBe("hi");

		r = await run(`Set-Content -LiteralPath ${ps(outside)} -Value x`, ws, "workspace-write");
		expect(r.code, r.out).not.toBe(0);
		expect(existsSync(outside), "这个文件不能存在，这就是全部的意义").toBe(false);
		expect(looksDenied(r.out, "windows-acl"), r.out).toBe(true);

		// 私有临时目录在这里是 `TEMP`：没有它一个临时文件都建不了。
		r = await run(
			"$f = New-TemporaryFile; Set-Content -LiteralPath $f -Value t; Get-Content -LiteralPath $f; Remove-Item -LiteralPath $f",
			ws,
			"workspace-write",
		);
		expect(r.out.trim(), r.out).toBe("t");

		r = await run("cmd /d /c echo native", ws, "workspace-write");
		expect(r.out).toMatch(/native/);
		r = await run("Write-Output 中文输出", ws, "workspace-write");
		expect(r.out).toMatch(/中文输出/);
		// runner 是怎么起的，命令不继承。
		r = await run("[string]$env:ELECTRON_RUN_AS_NODE", ws, "workspace-write");
		expect(r.out.trim()).toBe("");
		expect((await run("exit 3", ws, "workspace-write")).code).toBe(3);

		// 比命令行装得下的还长：从脚本文件跑，照样受约束。
		r = await run(`$s = '${"x".repeat(12_000)}'; Write-Output "long-$($s.Length)"`, ws, "workspace-write");
		expect(r.out).toMatch(/long-12000/);
		r = await run(`$s = '${"x".repeat(12_000)}'; Set-Content -LiteralPath ${ps(outside)} -Value $s`, ws, "workspace-write");
		expect(existsSync(outside), "脚本文件绕不过令牌").toBe(false);
		expect(r.code, "失败照样报成失败").not.toBe(0);
	});

	test.skipIf(!onWindows)("受约束的命令起的 MSYS 程序报成沙箱拒了它", { timeout: 60_000 }, async () => {
		const ws = await tempDir("plume-win-msys-");
		const gitSh = join(systemShell().file, "..", "..", "usr", "bin", "sh.exe");
		expect(existsSync(gitSh), gitSh).toBe(true);
		const r = await run(`& ${ps(gitSh)} -c 'echo from-sh'`, ws, "workspace-write");
		expect(r.out, "sh 受约束也跑起来了，那 Git Bash 就能当受约束的 shell").not.toContain("from-sh");
		expect(looksDenied(r.out, "windows-acl"), r.out).toBe(true);
	});

	test.skipIf(!onWindows)("read-only：项目里什么都写不了，读照常", { timeout: 60_000 }, async () => {
		const ws = await tempDir("plume-win-ro-");
		let r = await run("Set-Content -Path ro.txt -Value x", ws, "read-only");
		expect(r.code, r.out).not.toBe(0);
		expect(existsSync(join(ws, "ro.txt"))).toBe(false);
		r = await run(`Get-Content -LiteralPath ${ps(process.execPath)} -TotalCount 1 > $null; if ($?) { 'read-ok' }`, ws, "read-only");
		expect(r.out).toMatch(/read-ok/);
	});

	test.skipIf(!onWindows)("受约束的 PowerShell 是完整语言、说 UTF-8、错误是文字", { timeout: 120_000 }, async () => {
		/*
		 * 三样各自弄坏过受约束的命令，却没让任何一条写入测试失败：`%TEMP%` 写不了（read-only）时的 ConstrainedLanguage，连带它的 UTF-8 设置；
		 * 序列化成 CLIXML 的错误。两种 PowerShell 都测：5.1 是每台 Windows 都有的、也是出 CLIXML 的那个。
		 */
		const ws = await tempDir("plume-win-lang-");
		const seven = commandShell("workspace-write");
		const legacy = { ...seven, file: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") };
		for (const shell of [seven, legacy]) {
			for (const mode of ["read-only", "workspace-write"] as const) {
				const r = await run(
					"Write-Output $ExecutionContext.SessionState.LanguageMode; Write-Output 中文输出; Write-Error boom; Write-Output after",
					ws,
					mode,
					shell,
				);
				const where = `${shell.file} ${mode}: ${r.out}`;
				expect(r.out, where).toMatch(/FullLanguage/);
				expect(r.out, where).toMatch(/中文输出/);
				expect(r.out, where).toMatch(/boom/);
				expect(r.out, where).not.toContain("CLIXML");
				expect(r.out, where).not.toContain("OutputEncoding");
				expect(r.out, where).toMatch(/after/);
			}
		}
	});

	test.skipIf(!onWindows)("完全访问跑 Git Bash，不受约束", { timeout: 60_000 }, async () => {
		const ws = await tempDir("plume-win-full-");
		const r = await run("echo hi > full.txt && cat full.txt && uname -o", ws, "danger-full-access");
		expect(r.out).toMatch(/hi/);
		expect(r.out).toMatch(/Msys/i);
	});
});
