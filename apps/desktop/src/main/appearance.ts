/**
 * 外观设置的存取，和会话背景图的选、读、删。外观存在数据目录（见 home.ts）的 appearance.json，背景图复制进 backgrounds/。
 *
 * 主题在主进程设（nativeTheme.themeSource）：页面里的 prefers-color-scheme、窗口底色、毛玻璃材质的深浅都跟着它，
 * 开窗之前就要设好，否则选了深色的人每次启动先看到一帧浅色。
 *
 * 背景图只清理未被外观引用的旧文件；导入成功后先保留 pending 文件，等外观引用成功写盘再清理，避免换图时删掉仍在用的原图。
 */

import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions, type WebContents } from "electron";
import {
	type Appearance,
	type AppearancePatch,
	CHAT_BACKGROUND_NAME,
	MAX_BACKGROUND_BYTES,
	cleanAppearance,
	editableAppearancePatch,
	effectiveAppearance,
	patchAppearance,
} from "../shared/appearance.ts";
import { plumeHome } from "./home.ts";
import { BackgroundImageStore, imageExtension, type BackgroundImportResult } from "./background-image.ts";
import { renameWithRetry } from "./rename-retry.ts";
import { ThemeOverrides } from "./theme-overrides.ts";

const EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
let backgroundStore: BackgroundImageStore | undefined;
const store = () => (backgroundStore ??= new BackgroundImageStore(join(plumeHome(), "backgrounds")));

const file = () => join(plumeHome(), "appearance.json");
let current: Appearance = {};
const overrides = new ThemeOverrides();
/** 存盘排队：拖滑块时一格一次，后发的不能被先发的盖掉。 */
let saving: Promise<void> = Promise.resolve();

/** 开窗之前调一次：读盘、设好主题。 */
export function loadAppearance(): Appearance {
	try {
		current = cleanAppearance(JSON.parse(readFileSync(file(), "utf8")));
	} catch {
		current = {};
	}
	nativeTheme.themeSource = current.theme ?? "system";
	return current;
}

const clearBackgrounds = (keep?: string): Promise<void> => store().cleanup(keep);

function bytesOf(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

async function importBackground(bytes: Uint8Array, sourceName: string, sender: WebContents): Promise<BackgroundImportResult> {
	if (bytes.byteLength > MAX_BACKGROUND_BYTES) return { error: "too-large" };
	const extension = imageExtension(sourceName, bytes);
	if (!extension) return { error: "invalid" };
	// nativeImage 不支持 GIF；用实际显示背景的浏览器解码器验证，字节只作为 data URL，不拼可执行内容。
	const url = `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${Buffer.from(bytes).toString("base64")}`;
	const valid = await sender.executeJavaScript(`(async () => {
		const image = new Image(); image.src = ${JSON.stringify(url)};
		try { await image.decode(); return image.naturalWidth > 0 && image.naturalHeight > 0; }
		catch { return false; }
	})()`);
	if (!valid) return { error: "invalid" };
	return store().import(bytes, extension);
}

/**
 * @param onChange 外观变了以后调，主进程据此更新窗口底色。
 * @param smokeImage 冒烟验证没有人点对话框，选图时直接给这张。
 */
export function registerAppearanceIpc(onChange: (appearance: Appearance) => void, smokeImage?: string): void {
	// 预加载脚本同步取一次：页面第一帧之前就要知道配色，异步取会先按默认色画一帧。
	ipcMain.on("plume:appearance", (event) => {
		event.returnValue = current;
	});

	const applyTheme = () => {
		nativeTheme.themeSource = overrides.mode ?? current.theme ?? "system";
		onChange(effectiveAppearance(current, overrides.mode !== undefined));
	};
	const watched = new Set<number>();
	ipcMain.handle("plume:appearance:theme-override", (event, mode: unknown) => {
		if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender)) return;
		if (mode !== null && mode !== "system" && mode !== "light" && mode !== "dark") return;
		const owner = event.sender.id;
		if (!watched.has(owner)) {
			watched.add(owner);
			const release = () => {
				overrides.set(owner, null);
				applyTheme();
			};
			event.sender.once("destroyed", () => {
				watched.delete(owner);
				release();
			});
			event.sender.on("render-process-gone", release);
			event.sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
				if (isMainFrame && !isInPlace) release();
			});
		}
		overrides.set(owner, mode);
		applyTheme();
	});

	ipcMain.handle("plume:appearance:save", (_event, patch: AppearancePatch) => {
		current = patchAppearance(current, editableAppearancePatch(typeof patch === "object" && patch !== null ? patch : {}, overrides.mode !== undefined));
		applyTheme();
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.webContents.isDestroyed()) window.webContents.send("plume:appearance:changed", current);
		}
		const snapshot = JSON.stringify(current, null, "\t");
		const saved = current;
		saving = saving
			.then(async () => {
				await writeFile(`${file()}.tmp`, snapshot);
				// Windows 上杀毒软件、索引刚打开过这个文件时改名会被拒一会儿，等过去（见 rename-retry.ts）。
				await renameWithRetry(`${file()}.tmp`, file());
				await store().commit(saved.chatBackground);
			})
			.catch((error: unknown) => console.error("外观设置写不进去：", error));
		return current;
	});

	ipcMain.handle("plume:chat-background:pick", async (event, title: unknown) => {
		const options: OpenDialogOptions = {
			title: typeof title === "string" ? title : undefined,
			properties: ["openFile"],
			filters: [{ name: "Images", extensions: EXTENSIONS }],
		};
		const window = BrowserWindow.fromWebContents(event.sender);
		const result = smokeImage
			? { canceled: false, filePaths: [smokeImage] }
			: window
				? await dialog.showOpenDialog(window, options)
				: await dialog.showOpenDialog(options);
		const source = result.filePaths[0];
		if (result.canceled || !source) return null;
		try {
			const info = await stat(source);
			if (!info.isFile()) return { error: "invalid" as const };
			if (info.size > MAX_BACKGROUND_BYTES) return { error: "too-large" as const };
			const bytes = await readFile(source);
			return await importBackground(bytes, source, event.sender);
		} catch {
			return { error: "failed" as const };
		}
	});

	ipcMain.handle("plume:chat-background:import", async (event, value: unknown, name: unknown): Promise<BackgroundImportResult> => {
		const bytes = bytesOf(value);
		if (!bytes || typeof name !== "string") return { error: "invalid" };
		try {
			return await importBackground(bytes, name, event.sender);
		} catch {
			return { error: "failed" };
		}
	});

	ipcMain.handle("plume:chat-background:read", async (_event, name: unknown): Promise<Uint8Array | null> => {
		if (typeof name !== "string" || !CHAT_BACKGROUND_NAME.test(name)) return null;
		return store().read(name);
	});

	ipcMain.handle("plume:chat-background:remove", () => clearBackgrounds(current.chatBackground));
}
