/**
 * 交给系统打开的路径会不会变成运行一个程序。纯字符串判断，不引用 electron，测试才能直接加载它；
 * 打开的动作在 files.ts。
 */

import { posix, win32 } from "node:path";

/**
 * 交给系统打开会被运行的扩展名。分平台：同一个 `.js` 在 Windows 上是脚本，在 macOS 上是文本。
 */
const RUNS_EVERYWHERE = new Set(["sh", "bash", "zsh", "csh", "tcsh", "ksh", "fish", "command", "py", "pyw", "pyz", "jar", "jnlp"]);
const RUNS_ON: Record<string, ReadonlySet<string>> = {
	win32: new Set([
		"exe",
		"com",
		"scr",
		"pif",
		"bat",
		"cmd",
		"ps1",
		"psm1",
		"vbs",
		"vbe",
		"js",
		"jse",
		"wsf",
		"wsh",
		"ws",
		"wsc",
		"hta",
		"msc",
		"msi",
		"msp",
		"mst",
		"msix",
		"msixbundle",
		"appx",
		"appxbundle",
		"appinstaller",
		"application",
		"appref-ms",
		"lnk",
		"url",
		"cpl",
		"reg",
		"inf",
		"scf",
		"sct",
		"chm",
		"gadget",
		"diagcab",
		"xbap",
		"xll",
		"pl",
		"settingcontent-ms",
		"library-ms",
		"search-ms",
		"searchconnector-ms",
	]),
	darwin: new Set([
		"app",
		"tool",
		"scpt",
		"scptd",
		"applescript",
		"workflow",
		"action",
		"pkg",
		"mpkg",
		"terminal",
		"fileloc",
		"inetloc",
		"webloc",
		"prefpane",
		"saver",
		"qlgenerator",
		"osax",
		"mobileconfig",
		"definition",
	]),
	linux: new Set(["desktop", "appimage", "run"]),
};

/**
 * 把这个路径交给系统打开，是不是会运行一个程序而不是显示它。
 *
 * 在主进程判断，不信渲染进程：转录里的路径可能被改过。Windows 会忽略结尾的点和空格（`a.exe.` 运行 `a.exe`），
 * 并把 `name:stream` 当成备用数据流；目录只有程序包（`Foo.app`）会运行；macOS、Linux 上没有扩展名的可执行文件
 * 会被拿去终端里跑。
 */
export function opensAsProgram(path: string, facts: { isDirectory: boolean; executable: boolean }, platform: string): boolean {
	const windows = platform === "win32";
	let name = (windows ? win32 : posix).basename(path);
	if (windows) {
		name = name.replace(/[. ]+$/, "");
		if (name.includes(":")) return true;
	}
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (!ext) return !windows && !facts.isDirectory && facts.executable;
	if (facts.isDirectory) return platform === "darwin" && RUNS_ON.darwin!.has(ext);
	return RUNS_EVERYWHERE.has(ext) || (RUNS_ON[platform]?.has(ext) ?? false);
}

/** 网络共享和设备路径：`\\server\…`、`//server/…`。 */
export function isRemoteOrDevicePath(path: string): boolean {
	return /^[\\/]{2}/.test(path);
}
