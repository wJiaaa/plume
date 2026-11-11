/**
 * 这台机器实际能提供哪种约束，靠试出来决定。
 *
 * 先按平台选：macOS 用 Seatbelt，Windows 用受限令牌；别的平台（Linux）没有后端。选中的候选再真的*探测*一次：用真实 profile 包一条什么都不做的命令跑起来。
 * 要问的不是「程序在不在」，而是「内核接不接受我们要它做的事」：`sandbox-exec` 每台 macOS 都有，仍可能拒绝 profile。
 *
 * 答案是不行就是不行（fail-closed）：管不住的后端如实说管不住，调用方要么*明知*地不受限运行，要么不运行。
 * 绝不能悄悄回退：一个本该包装 argv 的函数把原 argv 原样还回去，命令就会在显示「已沙箱」的界面下拿着完全权限跑。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, seatbeltArgs, type SandboxEnforcement, type SandboxPolicy } from "./policy.ts";
import { SANDBOX_RUNNER_FLAG } from "./runner-flag.ts";
import { tempWriteSid, workspaceWriteSid } from "./windows/identity.ts";

/** 平台的约束从哪来；没有能用的就是 `none`。 */
export type Runner = "seatbelt" | "windows-acl" | "none";

export interface Confinement {
	/** 代替原命令去启动的程序。 */
	command: string;
	/** 放在被包装命令前面的参数。 */
	args: string[];
	runner: Exclude<Runner, "none">;
	enforcement: SandboxEnforcement;
	/** 包装要的额外环境。只有我们自己的 runner 有。 */
	env?: Record<string, string>;
}

/**
 * 一次探测最多等多久，超过算失败。
 *
 * 探测在沙箱里跑 `true`，能用时是毫秒级（我们自己的 runner 要先起应用的运行时，几百毫秒）；这个上限是给不能用的情况的：卡住的后端不能卡住应用的第一条命令。
 * `spawnSync` 把 `timeout: 0` 当成*不限时*，所以写成常量，而不是可能传进 0 的参数。
 */
const PROBE_TIMEOUT_MS = 8_000;

/** 给测试的接缝：测试要能拿到本机没有的平台和探测结论。 */
export interface BackendHooks {
	platform?: NodeJS.Platform;
	probe?: (runner: Exclude<Runner, "none">) => boolean;
	/** 要调用的 `sandbox-exec`，测试可以指向一个会拒绝的脚本。 */
	seatbeltExec?: string;
}

/** 每个平台的后端。 */
const PLATFORM_RUNNER: Partial<Record<NodeJS.Platform, Exclude<Runner, "none">>> = { darwin: "seatbelt", win32: "windows-acl" };

/**
 * 选中一个后端时它承诺多少。
 *
 * Seatbelt 管住了模式承诺的全部文件效果，是 `full`。受限令牌是 `partial`，原因是机制本身而不是没做完：
 * `WRITE_RESTRICTED` 的受限列表里必须有 Everyone，否则进程死在加载器初始化里，所以 DACL 给 Everyone 写权限的对象都还能写；
 * NTFS 硬链接能把授权树里的文件别名到树外。两样都是这个机制写在文档里的边界，换个更好的实现也堵不上。
 */
function enforcementOf(runner: Exclude<Runner, "none">): SandboxEnforcement {
	return runner === "windows-acl" ? "partial" : "full";
}

// ---------------------------------------------------------------------------------------------
// 我们自己的 runner 进程
// ---------------------------------------------------------------------------------------------

/**
 * 起 runner 的脚本，见 `runner-entry.ts`。
 *
 * 发出去的插件只有一个打包好的逻辑入口，runner 就是它本身（`import.meta.url` 指向它）；从源码跑（测试）时是旁边的 `runner-entry.ts`。
 * 由这个文件自己的位置算出来，而不是写成 `new URL(…, import.meta.url)` 字面量：打包器会把那当成资源复制，却不带它导入的模块。
 */
function sandboxRunnerEntry(): string {
	const self = fileURLToPath(import.meta.url);
	return self.endsWith(".ts") ? join(dirname(self), "runner-entry.ts") : self;
}

/**
 * 本进程的运行时当 Node 用，跑 runner。
 *
 * `process.execPath` 加 `ELECTRON_RUN_AS_NODE` 是从 Electron 应用里拿到一个 Node 进程的正规办法，不必另带一份运行时；
 * 在纯 Node 下这个变量什么都不做。脚本在前、旗标在后：Node 模式下脚本前面的东西都会被当成 Node 自己的选项。
 */
function runnerArgv(policy: SandboxPolicy): { command: string; args: string[]; env: Record<string, string> } {
	const entry = sandboxRunnerEntry();
	const args = [...(entry.endsWith(".ts") ? ["--experimental-strip-types", "--no-warnings"] : []), entry, SANDBOX_RUNNER_FLAG];
	const workspace = canonicalPath(policy.workspaceRoot);
	args.push("--workspace", workspace, "--mode", policy.mode);
	if (policy.mode === "workspace-write") args.push("--write-sid", workspaceWriteSid(workspace));
	/*
	 * read-only 也给一个私有临时目录，只在这个平台。
	 *
	 * 受限命令在这里跑在 PowerShell 里，而 PowerShell 决定语言模式的办法是往 `%TEMP%` 写一个探测脚本、问 AppLocker。写不了的临时目录
	 * 读起来像一台锁死的机器，它就以 ConstrainedLanguage 运行：除了少数核心类型，任何东西都不能设属性、调方法，它自己的 UTF-8 设置也在其中，
	 * 于是每条只读命令开头都报错，模型写的东西一半失败。这个目录是这个工作区自己的草稿区；项目和磁盘其余部分照只读承诺的那样写不了。
	 */
	const temp = privateTemp(workspace);
	args.push("--temp", temp, "--temp-sid", tempWriteSid(temp));
	args.push("--");
	return { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * Windows runner 用的、这个工作区自己的临时目录，见 runner 的 `runConfined`。
 *
 * 按工作区分，授权才和工作区的一样窄：一个项目的命令写不了另一个项目的临时文件。
 */
function privateTemp(workspace: string): string {
	const key = createHash("sha256").update(workspace.toLowerCase(), "utf8").digest("hex").slice(0, 16);
	return join(canonicalPath(tmpdir()), "plume-sandbox", key);
}

// ---------------------------------------------------------------------------------------------
// 探测和选择
// ---------------------------------------------------------------------------------------------

/**
 * 用真实 profile 真的跑一条无害的命令。
 *
 * `read-only` 是后端会拿到的最严的 profile，它接受这个就接受其余的。命令用 `true`：到处都有、什么都不写、退出码没有歧义；
 * Windows 上写成 `cmd.exe /c exit 0`。
 */
function probeRunner(runner: Exclude<Runner, "none">, seatbeltExec: string): { ok: boolean; why?: string } {
	const policy: SandboxPolicy = { mode: "read-only", workspaceRoot: runner === "windows-acl" ? process.cwd() : "/" };
	try {
		let probe: ReturnType<typeof spawnSync>;
		if (runner === "windows-acl") {
			const wrap = runnerArgv(policy);
			probe = spawnSync(wrap.command, [...wrap.args, "cmd.exe", "/c", "exit 0"], {
				timeout: PROBE_TIMEOUT_MS,
				stdio: ["ignore", "ignore", "pipe"],
				encoding: "utf8",
				windowsHide: true,
				env: { ...process.env, ...wrap.env },
			});
		} else {
			probe = spawnSync(seatbeltExec, [...seatbeltArgs(policy), "--", "true"], {
				timeout: PROBE_TIMEOUT_MS,
				stdio: ["ignore", "ignore", "pipe"],
				encoding: "utf8",
			});
		}
		/*
		 * 不是干净的 0 就说明这台机器不能保证执行约束，不提供这个后端（我们的 runner 管不住时带自己的前缀以 127 退出）。后端说了什么留下来：
		 * 只说「没有沙箱后端」不给原因，出了问题没人知道为什么。
		 */
		if (probe.status === 0) return { ok: true };
		const said = String(probe.stderr ?? "")
			.trim()
			.split("\n")
			.slice(-3)
			.join(" ")
			.slice(0, 400);
		return { ok: false, why: said || (probe.error ? probe.error.message : `exit ${probe.status ?? probe.signal}`) };
	} catch (error) {
		// 后端程序本身起不来：不存在，或者不可执行。
		return { ok: false, why: error instanceof Error ? error.message : String(error) };
	}
}

/** 每个试过的后端为什么在这里用不了，给报错用。 */
const probeFailures = new Map<string, string>();

/**
 * 本进程的探测结果。
 *
 * 缓存是因为探测要起进程，而结果在应用运行期间不会变：`sandbox-exec` 不会在会话中途冒出来。
 * 按平台和后端分开存，测试注入的一个平台不会污染另一个的结果。
 */
const probed = new Map<string, boolean>();

/** 清掉探测缓存。给测试用，它们要换一组接缝重新探测。 */
export function resetProbeCache(): void {
	probed.clear();
	probeFailures.clear();
}

/**
 * 这台机器能用的后端，或者 `none`。
 *
 * `none` 是正当的答案：不支持的平台（Linux）、`sandbox-exec` 坏掉的 macOS。拿它怎么办由调用方决定，这个函数不能假装有。
 */
export function selectRunner(hooks: BackendHooks = {}): Runner {
	const platform = hooks.platform ?? process.platform;
	const seatbeltExec = hooks.seatbeltExec ?? "/usr/bin/sandbox-exec";
	const runner = PLATFORM_RUNNER[platform];
	if (runner) {
		const key = `${platform}:${runner}:${seatbeltExec}`;
		let ok = probed.get(key);
		if (ok === undefined) {
			if (hooks.probe) ok = hooks.probe(runner);
			else {
				const verdict = probeRunner(runner, seatbeltExec);
				ok = verdict.ok;
				if (verdict.why) probeFailures.set(`${platform}:${runner}`, verdict.why);
			}
			probed.set(key, ok);
		}
		if (ok) return runner;
	}
	return "none";
}

/**
 * 在一个策略下怎么启动一条命令；策略不要约束时返回 `null`。
 *
 * 要约束而给不了就抛错，这是 fail-closed 的方向，也是整件事的要点：调用方想照跑可以接住它自己决定，
 * 那样不受限运行是有人做的决定，而不是悄悄发生的事。
 */
export function confine(policy: SandboxPolicy, hooks: BackendHooks = {}): Confinement | null {
	if (policy.mode === "danger-full-access") return null;

	const runner = selectRunner(hooks);
	if (runner === "none") {
		const platform = hooks.platform ?? process.platform;
		// i18n-exempt：发给模型的，不随界面语言变。
		const reasons = [...probeFailures].filter(([key]) => key.startsWith(`${platform}:`)).map(([key, why]) => `${key.split(":")[1]}：${why}`);
		throw new SandboxUnavailableError(
			`这台机器上没有可用的沙箱后端（平台 ${platform}），无法以「${policy.mode}」模式运行。` + (reasons.length ? `原因：${reasons.join("；")}` : ""),
		);
	}

	if (runner === "seatbelt") {
		return { command: hooks.seatbeltExec ?? "/usr/bin/sandbox-exec", args: [...seatbeltArgs(policy), "--"], runner, enforcement: enforcementOf(runner) };
	}
	const wrap = runnerArgv(policy);
	return { command: wrap.command, args: wrap.args, runner, enforcement: enforcementOf(runner), env: wrap.env };
}

/** 要求约束而这台机器给不了。单独一个类，调用方才能专门接住它。 */
export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

/**
 * 从命令的输出里读出它是不是被沙箱拦下的。
 *
 * 退出码回答不了：被拒写入的命令和磁盘满、路径错时一样，只给一个非零数，分不出是策略决定还是命令自己的毛病。
 * 后端会在 stderr 上说出来，那一行是唯一的信号。
 *
 * 两个方向的代价不对等：漏认只是读成普通失败（模型重试、没进展、如实说出来）；误认会为沙箱根本没拦的事弹提权申请。
 * 所以只认后端真正会打印的句子，不撒一张「denied」「permission」的大网。
 */
export function looksDenied(output: string, runner?: Runner): boolean {
	if (DENIAL_PATTERNS.some((pattern) => pattern.test(output))) return true;
	if (runner === "seatbelt") return SEATBELT_SERVICE_DENIAL.test(output);
	if (runner !== "windows-acl") return false;
	if (MSYS_UNDER_TOKEN.test(output) || WINDOWS_DENIAL.test(output)) return true;
	return output.split("\n").some((line) => GENERIC_DENIAL.test(line) && !NOT_A_DENIAL.test(line));
}

/**
 * MSYS2 程序在受限令牌下一启动就死。
 *
 * Windows 上受限命令跑在 PowerShell 里，因为 Git Bash 在那里起不来（见 `@plume/platform` 的 `commandShell`），但受限命令仍可能起一个：
 * `git commit` 用 Git 自带的 `sh` 跑钩子。那个 `sh` 读第一行之前就失败（`fatal error - couldn't create signal pipe, Win32 error 5`），
 * 这是沙箱拒了它，和钩子本身无关。认作拒绝，模型就知道可以申请提权，不受限时钩子能跑。
 */
const MSYS_UNDER_TOKEN = /\bfatal error - .*\bWin32 error 5\b/i;

/**
 * Windows 说的拒绝，不管它说的是哪种语言。
 *
 * `Access is denied` 是英文。中文 Windows 上 cmd 说 `拒绝访问。`，Windows PowerShell 5.1（跑在 .NET Framework 上，消息跟系统语言走）
 * 说 `对路径“…”的访问被拒绝。`，沙箱拒掉的写入就读成了普通失败，模型不知道可以申请。两种认法：Windows PowerShell 在消息旁打印的、
 * 从不翻译的标识（`CategoryInfo` 行里的 `UnauthorizedAccessException`），和系统在最常用的几种语言里对错误 5 的那句话。
 * PowerShell 7 只打印消息，但它的消息来自 .NET，到哪都是英文。
 */
// i18n-exempt：Windows 各语言的原话，是认输出用的模式，不是给人看的字。
const WINDOWS_DENIAL =
	/UnauthorizedAccessException|拒绝访问|访问被拒绝|拒絕存取|存取被拒|アクセスが拒否されました|액세스가 거부되었습니다|Zugriff verweigert|Zugriff auf den Pfad .* verweigert|accès refusé|L\x27accès au chemin .* est refusé|Acceso denegado|Отказано в доступе|Acesso negado/i;

/**
 * 我们自己的 runner 的拒绝用的是常见的词，没有自己的前缀：受限令牌下原生程序说 `Access is denied`（移植来的说 `Permission denied`），
 * PowerShell 和别的基于 .NET 的程序（受限命令在那里就跑在它里面）说 `Access to the path '…' is denied`。
 * 这些词太常见，所以只在产生它们的 runner 下才算，而且 ssh 拒绝密钥、密码的两句话从不算：
 * `git push` 在哪种沙箱下都可能打印它们。
 */
const GENERIC_DENIAL = /\b(?:permission denied|access is denied)\b|\baccess to the path\b.*\bis denied\b/i;
const NOT_A_DENIAL = /permission denied \(publickey|permission denied, please try again/i;

/**
 * `open`、`defaults write` 因为 profile 拒了它们要找的守护进程而失败（见 `policy.ts` 的 `HANDS_OFF`）。两者都不说「not permitted」：
 * LaunchServices 报可执行文件缺失或不兼容，`defaults` 报写不了这个域。只在 Seatbelt 下算拒绝，别处这些话就是字面意思。
 */
const SEATBELT_SERVICE_DENIAL = /_LSOpenStuffCallLocal|kLSExecutableIncorrectFormat|\bCould not write domain\b/;

/**
 * 不区分大小写，因为这一行是 shell 写的，而各家 shell 写法不同。
 *
 * `bash` 把 EPERM 报成 `Operation not permitted`；macOS 默认的 `zsh`（这些命令多半在它下面跑）写的是小写的
 * `operation not permitted`，整行形状也不一样。只按 bash 的写法匹配，单元测试全过，真实环境里的拒绝却一条都认不出。
 */
const DENIAL_PATTERNS = [/\boperation not permitted\b/i, /\bsandbox-exec:/i, /\bdeny file-write\b/i, /\bread-only file system\b/i];
