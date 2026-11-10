/**
 * 「用什么打开」在这台机器上能是什么。
 *
 * 一个目标是三种之一，列表只列这台机器真有的：
 *
 *   reveal    在这个平台的文件管理器里指出它
 *   app       用某个应用打开文件
 *   terminal  在文件所在的目录开一个终端——从不对着文件本身，那会运行它
 *
 * id 稳定、和平台无关（`vscode` 而不是 `Visual Studio Code`）：在一台 Mac 上选的，到了 Windows 上还得有意思。
 * 列 macOS 和 Windows 的候选（表在 open-target-ids.ts），别的平台列表里只有 reveal，认不出的 id 交给系统默认的应用。
 */

import { execFile, spawn } from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { app, ipcMain, shell } from "electron";
import type { OpenTarget } from "../shared/open-targets.ts";
import { findExecutable } from "./find-executable.ts";
import { type OpenPathOutcome, openPathSafely } from "./files.ts";
import { type Candidate, candidatesFor, launchPlan } from "./open-target-ids.ts";

const execFileAsync = promisify(execFile);

/**
 * macOS 放应用的四个目录：第三方的、Catalina 以后 Apple 自带的、实用工具、访达所在的服务目录。
 * 别处装的用 Spotlight 兜底，按文件名找，因为显示名会本地化而我们的不会。
 */
const APP_DIRS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices"];

/**
 * 是真的应用包，而不只是名字像：Spotlight 按文件名匹配，`/usr/share/terminfo/69/iTerm.app` 是个文件。
 * 找到它会让 iTerm 像是装了、却没有图标。有 `Contents/MacOS` 目录的才算。
 */
async function isBundle(path: string): Promise<boolean> {
	const info = await stat(path).catch(() => null);
	if (!info?.isDirectory()) return false;
	return stat(`${path}/Contents/MacOS`)
		.then((entry) => entry.isDirectory())
		.catch(() => false);
}

async function findApp(name: string): Promise<string | null> {
	for (const dir of APP_DIRS) {
		const candidate = `${dir}/${name}.app`;
		if (await isBundle(candidate)) return candidate;
	}
	const { stdout } = await execFileAsync("mdfind", ["-name", `${name}.app`]).catch(() => ({ stdout: "" }));
	for (const line of stdout.split("\n")) {
		const path = line.trim();
		if (path.endsWith(`${name}.app`) && (await isBundle(path))) return path;
	}
	return null;
}

/** 包声明的图标文件，不一定按应用命名。 */
async function iconFileFor(bundle: string): Promise<string | null> {
	const { stdout } = await execFileAsync("defaults", ["read", `${bundle}/Contents/Info`, "CFBundleIconFile"]).catch(() => ({ stdout: "" }));
	const name = stdout.trim();
	if (!name) return null;
	const path = `${bundle}/Contents/Resources/${name.endsWith(".icns") ? name : `${name}.icns`}`;
	return (await stat(path)
		.then(() => true)
		.catch(() => false))
		? path
		: null;
}

/**
 * 应用自己的图标（data URL），比自己画别人的 logo 强：是用户在自己 Dock 里认得的那个、装的那一版。
 * `sips` 只写文件不写管道，所以经一个临时文件。
 */
async function appIcon(bundle: string, appName: string): Promise<string | undefined> {
	const icns = await iconFileFor(bundle);
	if (!icns) return undefined;
	const out = join(tmpdir(), `plume-icon-${Buffer.from(appName).toString("hex")}.png`);
	await execFileAsync("sips", ["-s", "format", "png", "--resampleWidth", "128", icns, "--out", out]);
	const png = await readFile(out).catch(() => null);
	await rm(out, { force: true }).catch(() => undefined);
	return png ? `data:image/png;base64,${png.toString("base64")}` : undefined;
}

/** Windows 上放应用的几个目录，候选里的固定位置相对于它们。 */
const WINDOWS_DIRS: Record<NonNullable<Candidate["windows"]>[number]["dir"], string | undefined> = {
	localAppData: process.env.LOCALAPPDATA,
	programFiles: process.env.ProgramFiles,
	programFilesX86: process.env["ProgramFiles(x86)"],
	windir: process.env.windir,
};

/**
 * 候选在这台机器上的位置，没装是 null。macOS 是应用包，Windows 先看固定位置、再去 PATH 里找命令：
 * `findExecutable` 按 PATHEXT 找，`code.cmd`、`wt.exe` 靠它才找得到。
 */
async function locate(candidate: Candidate): Promise<string | null> {
	if (process.platform === "darwin") return candidate.appName ? findApp(candidate.appName) : null;
	for (const fixed of candidate.windows ?? []) {
		const base = WINDOWS_DIRS[fixed.dir];
		if (!base) continue;
		const path = join(base, fixed.path);
		if (
			await access(path).then(
				() => true,
				() => false,
			)
		)
			return path;
	}
	return candidate.command ? findExecutable(candidate.command) : null;
}

/** 应用自己的图标：macOS 从包里读，Windows 问系统要可执行文件的图标，就是任务栏上画的那个。 */
async function iconFor(candidate: Candidate, located: string): Promise<string | undefined> {
	if (process.platform === "darwin") return candidate.appName ? appIcon(located, candidate.appName) : undefined;
	const image = await app.getFileIcon(located, { size: "normal" });
	return image.isEmpty() ? undefined : image.toDataURL();
}

/** 算一次：装应用的频率和重启应用差不多。 */
let cached: Promise<OpenTarget[]> | null = null;

async function build(): Promise<OpenTarget[]> {
	// reveal 的名字由界面按平台和语言写（「在访达中显示」），这里不给。
	const found: OpenTarget[] = [{ id: "reveal", label: "" }];
	for (const candidate of candidatesFor(process.platform)) {
		const located = await locate(candidate).catch(() => null);
		if (!located) continue;
		const icon = await iconFor(candidate, located).catch(() => undefined);
		found.push({ id: candidate.id, label: candidate.label, ...(icon ? { icon } : {}) });
	}
	return found;
}

async function containingDirectory(path: string): Promise<string> {
	const info = await stat(path).catch(() => null);
	return info?.isDirectory() ? path : dirname(path);
}

/**
 * 按目标打开。认不出的（别的平台的 id、新版本写的设置）交给系统默认的应用而不是报错：人要的是打开这个文件，
 * 哪个应用打开才是我们可能弄错的部分。兜底走 `openPathSafely` 而不是 `shell.openPath`：编辑器没装或起不来时，
 * 不能变成用默认程序运行一个 `.command`。
 */
async function openWith(id: string, path: string): Promise<OpenPathOutcome> {
	if (id === "reveal") {
		// 人选的就是在文件夹里指出它，不算「改成在文件夹里显示」，不另外说明。
		shell.showItemInFolder(path);
		return "opened";
	}
	const candidate = candidatesFor(process.platform).find((entry) => entry.id === id);
	if (!candidate) return openPathSafely(path);
	// 终端是在一个目录里开。交给它一个文件它会去运行，`open -a Terminal file.ts` 正是这样。
	const target = candidate.kind === "terminal" ? await containingDirectory(path) : path;
	try {
		if (process.platform === "darwin" && candidate.appName) {
			await execFileAsync("open", ["-a", candidate.appName, target]);
			return "opened";
		}
		const located = await locate(candidate);
		if (!located) return openPathSafely(target);
		/*
		 * 分离、放掉它的输入输出：编辑器作为这个进程的子进程起来，会一直握着我们的 stdio；Windows 上没 unref 的子进程
		 * 还会拖住应用退出。参数和启动方式见 launchPlan（终端要 `-d`，`.cmd` 经 cmd.exe）。
		 */
		const plan = launchPlan(candidate, located, target, process.platform, process.env);
		const child = spawn(plan.file, plan.args, {
			...(plan.cwd ? { cwd: plan.cwd } : {}),
			detached: true,
			stdio: "ignore",
			windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
		});
		child.on("error", () => void openPathSafely(target));
		child.unref();
		return "opened";
	} catch {
		return openPathSafely(target);
	}
}

export function registerOpenTargetsIpc(): void {
	ipcMain.handle("plume:open-targets", () => {
		cached ??= build();
		return cached;
	});
	ipcMain.handle("plume:files:open-in", async (_event, id: unknown, path: unknown): Promise<OpenPathOutcome> => {
		if (typeof id !== "string" || typeof path !== "string" || path === "" || path.includes("\0")) return "failed";
		return openWith(id.trim() || "reveal", path);
	});
}
