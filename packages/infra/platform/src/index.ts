/**
 * 各平台不一样的那几处：agent 的命令跑在哪个 shell 里、按哪种语法读一行命令、一个路径在不在另一个底下。
 *
 * 写在调用处的时候，每一处都只照着开发用的 Unix 写，换到 Windows 上才一起坏。所以答案取决于 `process.platform`、
 * 分隔符或环境变量拼法的，都放这里，理由写在旁边。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath, { basename, isAbsolute, join, resolve, win32 } from "node:path";

export * from "./line-diff.ts";
export * from "./shell-split.ts";

export interface CommandShell {
	/** 启动哪个程序。 */
	file: string;
	/** 命令行按什么语法写。Git Bash 是 `posix`：它就是 bash。 */
	kind: "posix" | "powershell";
	/** 告诉模型、告诉人这是哪个 shell 时用的名字。 */
	label: string;
	/** 让 `file` 跑一行命令就退出的参数。 */
	args(command: string): string[];
}

/**
 * 命令跑在哪个 shell 里。
 *
 * **Unix。** 用户自己的 shell 是 bash 或 zsh 时用它：人的工具是照着它配的。否则用 bash：命令是模型写的，模型写的是
 * bash，`$SHELL` 是 fish、nushell 时，每个 `export A=1`、`$(…)`、`for … do … done` 都是语法错误。精简的 Linux 上
 * 可能连 `/bin/bash` 都没有，最后退到 `/bin/sh`。
 *
 * zsh 关掉 `NOMATCH`：没匹配上的通配符在 zsh 里是错误、在 bash 里原样传下去，`ls *.log 2>/dev/null`、
 * `pip install foo[dev]`、`curl https://x/?a=b` 都会在命令开始之前死在 `no matches found` 上。关掉以后 zsh 和 bash 一样。
 *
 * **Windows。** 先 Git Bash，再 PowerShell 7，最后 Windows PowerShell。每台 Windows 都有的是 5.1，它不认 `&&`，
 * 模型最常写的 `cd x && npm i` 直接是语法错误；而装了 git 的 Windows 几乎都带着 Git Bash。都没有时告诉模型手上是哪个
 * PowerShell，让它照着写。
 *
 * `PLUME_SHELL` 指定一个 shell 时优先用它（装在别处的 bash、zsh、PowerShell，测试、排查）。
 *
 * 这是不受约束的命令用的 shell；Windows 上受约束的命令改在 PowerShell 里跑，见 `commandShell`。
 */
export function systemShell(): CommandShell {
	if (cachedShell && cachedFor === shellKey()) return cachedShell;
	cachedFor = shellKey();
	cachedShell = pickShell();
	return cachedShell;
}

let cachedShell: CommandShell | undefined;
let cachedFor: string | undefined;
/** 答案取决于这几样；环境变了（测试、改了设置）就重新选。 */
const shellKey = () => `${process.platform}\0${process.env.PLUME_SHELL ?? ""}\0${process.env.SHELL ?? ""}`;

function pickShell(): CommandShell {
	const override = process.env.PLUME_SHELL?.trim();
	if (override && existsSync(override)) {
		const shell = shellAt(override);
		if (shell) return shell;
	}
	if (process.platform === "win32") return windowsShell();
	const login = process.env.SHELL;
	if (login && existsSync(login)) {
		const shell = shellAt(login);
		if (shell) return shell;
	}
	for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash", "/run/current-system/sw/bin/bash"]) {
		if (existsSync(candidate)) return posix(candidate, "bash");
	}
	return posix("/bin/sh", "sh");
}

/** 这个路径上的 shell，只认会驱动的那几种。 */
function shellAt(file: string): CommandShell | undefined {
	const name = basename(file)
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (name === "bash") return posix(file, process.platform === "win32" ? "Git Bash" : "bash");
	if (name === "zsh") return { file, kind: "posix", label: "zsh", args: (command) => ["+o", "nomatch", "-c", command] };
	if (name === "sh" || name === "dash" || name === "ksh") return posix(file, name);
	if (name === "pwsh") return powershell(file, "PowerShell 7");
	if (name === "powershell") return powershell(file, "Windows PowerShell 5.1");
	return undefined;
}

function posix(file: string, label: string): CommandShell {
	return { file, kind: "posix", label, args: (command) => ["-c", command] };
}

/**
 * 经 PowerShell 跑：命令写进脚本文件用 `-File` 跑，输出强制 UTF-8。
 *
 * 不用 `-Command`、`-EncodedCommand`，它们各坏一样：
 *
 * - `-Command` 让命令经过 `CreateProcess`。Windows 没有 argv，只有一整串由每个程序自己拆，Windows PowerShell 5.1
 *   拆的时候会丢掉里面的引号。
 * - `-EncodedCommand` 不丢引号，但 5.1 会把这种命令的每个错误写成序列化的 CLIXML（`#< CLIXML <Objs …>`），不管
 *   `-OutputFormat` 怎么说，模型读到的是 XML 而不是一行错误；UTF-16 的 base64 让每个字符占掉命令行 32767 个字符里的
 *   约 2.7 个，一万二千字以上的命令根本起不来（`spawn ENAMETOOLONG`）。
 *
 * 前导：PowerShell 按控制台代码页（中文 Windows 是 936）往管道里写，到这里是乱码；非交互会话里的进度条会作为 CLIXML
 * 噪音写到 stderr。`-NoProfile` 是因为 profile 是人自己的交互设置，加载慢还可能打印东西；`Bypass` 是因为默认策略下
 * 脚本（包括这一个）会被拒绝。
 */
function powershell(file: string, label: string): CommandShell {
	return {
		file,
		kind: "powershell",
		label,
		args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-File", scriptFile(command)],
	};
}

const PRELUDE = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8";

/**
 * 把命令写成 PowerShell 能用 `-File` 跑的脚本。
 *
 * 带 BOM：Windows PowerShell 5.1 有它才按 UTF-8 读，否则按控制台代码页。最后一行保住命令该有的退出码：`-File` 在
 * 最后一条命令失败后仍报 0，所以失败时有原生退出码就报它，否则报 1。前导占第一行、命令从第二行开始，错误里的行号比命令
 * 自己的多一。
 *
 * 按内容命名，同一条命令再跑复用同一个文件；放在临时目录下自己的目录里（每种沙箱模式都能读），进程第一次往里写时清掉
 * 一周前的文件。
 */
function scriptFile(command: string): string {
	const body = `${PRELUDE}\n${command}\nif (-not $?) { exit $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }) }\n`;
	const dir = join(tmpdir(), "plume-commands");
	mkdirSync(dir, { recursive: true });
	if (!sweptScripts) {
		sweptScripts = true;
		const stale = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for (const name of readdirSync(dir)) {
			try {
				const path = join(dir, name);
				if (statSync(path).mtimeMs < stale) rmSync(path, { force: true });
			} catch {
				// 别的进程的文件，或者已经没了：都不值得让命令失败。
			}
		}
	}
	const file = join(dir, `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.ps1`);
	writeFileSync(file, `\uFEFF${body}`, "utf8");
	return file;
}

let sweptScripts = false;

function windowsShell(): CommandShell {
	const bash = gitBash();
	if (bash) return posix(bash, "Git Bash");
	return windowsPowerShell();
}

/** 装了 PowerShell 7 就用它，否则用每台 Windows 都有的 Windows PowerShell 5.1。 */
function windowsPowerShell(): CommandShell {
	const pwsh = onPath("pwsh.exe") ?? [join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")].find(existsSync);
	if (pwsh) return powershell(pwsh, "PowerShell 7");
	const root = process.env.SystemRoot ?? "C:\\Windows";
	const legacy = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return powershell(existsSync(legacy) ? legacy : "powershell.exe", "Windows PowerShell 5.1");
}

/** 命令受多大约束：沙箱策略的那套说法，在这里写一遍，让这个包不依赖别的包。 */
type Confinement = "read-only" | "workspace-write" | "danger-full-access";

/**
 * 按约束程度，命令跑在哪个 shell 里。
 *
 * 只有一处和 `systemShell` 不同：Windows 上受约束的命令跑在 PowerShell 里。Git Bash 在约束它的受限令牌下起不来：
 * 每个 MSYS2 程序（bash，git 跑钩子用的 `sh`）启动时都给自己建一条私有的信号管道，DACL 只列用户、Administrators 和
 * SYSTEM，再以写方式打开。写受限的令牌只让经过受限 SID 的写入通过，而用户自己的 SID 不能当受限 SID，否则等于把整个
 * 用户目录放回去：bash 在第一行就死在 `couldn't create signal pipe, Win32 error 5`。这条管道是 bash 在权限已经收走
 * 之后自己建的，没法提前授权。PowerShell 是普通的 Win32 进程，受约束时表现正常：工作区内能写，工作区外被拒。
 *
 * 按会话*宣布*的模式选（系统提示词里告诉模型的那个 shell），不按这一次调用提权到哪一档：提权的命令仍是模型照着被告知的
 * 语法写的那一行。
 *
 * `PLUME_SHELL` 在这里只在它指向 PowerShell 时才认；指向 Git Bash 的话每条命令都会失败。
 */
export function commandShell(mode?: Confinement): CommandShell {
	if (process.platform !== "win32" || mode === undefined || mode === "danger-full-access") return systemShell();
	if (confinedShell && confinedFor === shellKey()) return confinedShell;
	confinedFor = shellKey();
	const override = process.env.PLUME_SHELL?.trim();
	const chosen = override && existsSync(override) ? shellAt(override) : undefined;
	confinedShell = chosen?.kind === "powershell" ? chosen : windowsPowerShell();
	return confinedShell;
}

let confinedShell: CommandShell | undefined;
let confinedFor: string | undefined;

/**
 * Git for Windows 的 `bin\bash.exe`，按人会找的方式找。
 *
 * 先从 `PATH` 上的 `git.exe` 推，那是这台机器真在用的那一份；再找各安装器的默认位置。用 `bin\bash.exe` 而不是
 * `usr\bin\bash.exe`：前者是启动器，会先把 Git 自己的工具放上 `PATH` 再起 bash。
 *
 * 不认 `System32\bash.exe` 和 `WindowsApps` 里的别名：那是 WSL，一台有自己文件系统的 Linux，工作区路径在那边没有意义，
 * 每条命令都会跑到别处去。
 */
function gitBash(): string | undefined {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const dir of pathDirs()) {
		if (!existsSync(win32.join(dir, "git.exe"))) continue;
		const lower = dir.toLowerCase().replace(/[\\/]+$/, "");
		let root = dir;
		if (/[\\/](mingw64|mingw32|clangarm64)[\\/]bin$/.test(lower)) root = win32.dirname(win32.dirname(dir));
		else if (/[\\/](cmd|bin)$/.test(lower)) root = win32.dirname(dir);
		candidates.push(win32.join(root, "bin", "bash.exe"));
	}
	const programFiles = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
	for (const base of programFiles) candidates.push(win32.join(base, "Git", "bin", "bash.exe"));
	if (process.env.LOCALAPPDATA) candidates.push(win32.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
	candidates.push(win32.join(homedir(), "scoop", "apps", "git", "current", "bin", "bash.exe"));
	for (const candidate of candidates) {
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (isWslLauncher(candidate)) continue;
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function isWslLauncher(file: string): boolean {
	const lower = file.toLowerCase();
	const root = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
	return lower.startsWith(`${root}\\`) || lower.includes("\\windowsapps\\");
}

/** `PATH` 上的目录，不管这个平台把变量名拼成什么样。 */
function pathDirs(): string[] {
	const raw = process.env.PATH ?? process.env.Path ?? "";
	return raw.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

function onPath(file: string): string | undefined {
	for (const dir of pathDirs()) {
		const candidate = process.platform === "win32" ? win32.join(dir, file) : join(dir, file);
		if (!isWslLauncher(candidate) && existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * 用户的登录 shell：问它要环境变量（见 `sandbox/login-path.ts`），不一定是跑命令的那个。fish 用户的环境写在 fish 的
 * 启动文件里，即使命令跑在 bash 里，问 bash 也找不到。
 */
export function loginShell(): string {
	const shell = process.env.SHELL;
	if (shell && existsSync(shell)) return shell;
	return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * 判断一行命令时按哪几种语法读。
 *
 * shell 可能是 PowerShell 的地方两种都读：判风险、判读了什么的规则是照 bash 写的，一行在 bash 和 PowerShell 里意思
 * 不同时，按读出更多的那种判。每台 Windows 都是这样：受约束的模式跑 PowerShell，完全访问跑 Git Bash（`commandShell`），
 * 对一条命令的判断不能取决于碰巧由哪个跑；`PLUME_SHELL` 选了 PowerShell 的地方也是。其余地方只按 bash 读。
 */
export function commandDialects(): ("posix" | "powershell")[] {
	return process.platform === "win32" ? ["posix", "powershell"] : dialectsOf(systemShell());
}

/** 已知由哪个 shell 跑时按哪几种语法读：总有 bash 的（规则照它写），是 PowerShell 时再加上它的。 */
export function dialectsOf(shell: Pick<CommandShell, "kind">): ("posix" | "powershell")[] {
	return shell.kind === "powershell" ? ["posix", "powershell"] : ["posix"];
}

/** 忘掉选过的 shell：给改了环境的测试用。 */
export function resetSystemShell(): void {
	cachedShell = undefined;
	cachedFor = undefined;
	confinedShell = undefined;
	confinedFor = undefined;
}

/**
 * 从 `root` 往下到 `target` 的那段路，`target` 不在它底下时是 null；`""` 是 `root` 本身。
 *
 * 交给 `path` 去算，不手拼。顺手写的 `` target.startsWith(`${root}/`) `` 在 Unix 上对，在 Windows 上对每个输入都悄悄
 * 是 false，因为分隔符是反斜杠。总答「不在」的包含判断看起来不像坏了，像是被问的东西本来就不在那儿。
 *
 * 出界只算 `..` 本身或 `..` 加分隔符，不算这个前缀：`..cache` 是根下一个名字恰好以两个点开头的目录。算出绝对路径是
 * 换了盘符。相对路径不在任何东西底下：这个问题只在两个都钉死的位置之间有意义。
 *
 * `flavour` 让 Windows 的规则在任何机器上都能测；调用方不传。
 */
export function relativeInside(root: string, target: string, flavour: PathFlavour = nodePath): string | null {
	if (!flavour.isAbsolute(root) || !flavour.isAbsolute(target)) return null;
	const step = flavour.relative(root, target);
	if (step === ".." || step.startsWith(`..${flavour.sep}`) || flavour.isAbsolute(step)) return null;
	return step;
}

type PathFlavour = Pick<typeof nodePath, "isAbsolute" | "relative" | "sep">;

/** `target` 在不在 `root` 底下：目录本身不算在自己底下。 */
export const within = (root: string, target: string): boolean => Boolean(relativeInside(root, target));

/** 同 `within`，但根本身也算：用于「这里能不能写」，而不是「在不在底下」。 */
export const withinOrIs = (root: string, target: string): boolean => relativeInside(root, target) !== null;

/** 把 `child` 解析到 `root` 底下；它是绝对路径或爬出去时是 null。给从清单、网址里读来的名字用。 */
export function resolveInside(root: string, child: string): string | null {
	if (isAbsolute(child)) return null;
	const resolved = resolve(root, child);
	return withinOrIs(resolve(root), resolved) ? resolved : null;
}
