/**
 * 附件要用的几件系统操作：问一个路径还在不在、用系统默认的应用打开、在文件管理器里指出它、把路径或图片放进剪贴板。
 *
 * 路径不限在项目里：附件多半来自项目外（`~/下载` 里的表格），而这些操作只是把它交给系统，不读它的内容。
 */

import { realpath, stat, access } from "node:fs/promises";
import { BrowserWindow, dialog, clipboard, ClipboardItem, ipcMain, nativeImage, net, shell } from "electron";
import { createDocumentImageLoader } from "./document-image.ts";
import { isRemoteOrDevicePath, opensAsProgram } from "./security-policy.ts";

/** 打开的结果：打开了、改成在文件夹里指出来了（直接打开会运行它）、没打开。 */
export type OpenPathOutcome = "opened" | "revealed" | "failed";

/**
 * 用默认应用打开，除非那会运行它——那时改成在文件夹里指出来，结果告诉页面，好说明为什么。
 *
 * 网络共享上的一律不打开：从别人的共享上运行东西就是运行陌生人的程序，而它是不是程序不值得隔着网络去问。
 */
export async function openPathSafely(path: string): Promise<OpenPathOutcome> {
	if (isRemoteOrDevicePath(path)) {
		shell.showItemInFolder(path);
		return "revealed";
	}
	// 两个名字都判断：系统打开时会跟着符号链接走，`notes.txt` → `/bin/sh` 就是运行一个 shell。
	const real = await realpath(path).catch(() => path);
	const info = await stat(real).catch(() => null);
	const facts = { isDirectory: info?.isDirectory() ?? false, executable: ((info?.mode ?? 0) & 0o111) !== 0 };
	if (opensAsProgram(path, facts, process.platform) || opensAsProgram(real, facts, process.platform)) {
		shell.showItemInFolder(path);
		return "revealed";
	}
	return (await shell.openPath(path)) === "" ? "opened" : "failed";
}

const isPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");

export function registerFilesIpc(): void {
	ipcMain.handle("plume:files:pick-reference", async (event, directory: unknown) => {
		if (typeof directory !== "boolean") return undefined;
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) return undefined;
		const result = await dialog.showOpenDialog(window, { properties: [directory ? "openDirectory" : "openFile"] });
		return result.canceled ? undefined : result.filePaths[0];
	});
	const remoteImage = createDocumentImageLoader((url, init) => net.fetch(url, init));
	ipcMain.handle("plume:files:remote-image", (_event, url: unknown) => remoteImage(url));
	ipcMain.handle("plume:files:exists", async (_event, path: unknown) =>
		isPath(path)
			? access(path).then(
					() => true,
					() => false,
				)
			: false,
	);
	ipcMain.handle("plume:files:open", async (_event, path: unknown): Promise<OpenPathOutcome> => (isPath(path) ? openPathSafely(path) : "failed"));
	ipcMain.handle("plume:files:reveal", (_event, path: unknown) => {
		if (isPath(path)) shell.showItemInFolder(path);
	});
	ipcMain.handle("plume:files:copy-text", async (_event, text: unknown) => {
		if (typeof text === "string") await clipboard.writeText(text);
	});
	// 输入框右键菜单的「粘贴」：读系统剪贴板不经网页的权限询问，和写走同一处。
	ipcMain.handle("plume:files:read-text", () => clipboard.readText());
	/*
	 * 图片按 PNG 进剪贴板：粘到聊天窗口里的是图，不是一行路径。传进来的字节不一定是 PNG，经 `nativeImage`
	 * 转一道，粘出去的格式是确定的。
	 */
	ipcMain.handle("plume:files:copy-image", async (_event, dataUrl: unknown) => {
		if (typeof dataUrl !== "string") return false;
		const image = nativeImage.createFromDataURL(dataUrl);
		if (image.isEmpty()) return false;
		await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
		return true;
	});
}
