/** 托管图片供文件面板和系统定位使用；文件名与真实位置一起校验，不授予整个数据目录的读取权限。 */
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FileContents } from "@plume/contract";
import { MEDIA_NAME } from "./media.ts";

/** 只认媒体目录里的图片绝对路径，不跟随图片本身的软链。 */
export async function managedMediaPath(dir: string, target: string): Promise<string | null> {
	if (typeof target !== "string" || !isAbsolute(target) || target.includes("\0")) return null;
	const name = basename(target);
	if (!MEDIA_NAME.test(name)) return null;
	const root = await realpath(dir).catch(() => null);
	if (!root) return null;
	const full = resolve(target);
	if (dirname(full) !== resolve(dir) && dirname(full) !== root) return null;
	const expected = join(root, name);
	const [actual, info] = await Promise.all([realpath(full).catch(() => null), lstat(expected).catch(() => null)]);
	return actual === expected && info?.isFile() ? expected : null;
}

/** 界面只交媒体名；路径由宿主拼，不能传绝对路径或目录片段。 */
export function mediaFilePath(dir: string, name: string): Promise<string | null> {
	return typeof name === "string" && MEDIA_NAME.test(name) ? managedMediaPath(dir, join(dir, name)) : Promise.resolve(null);
}

async function openManagedMedia(dir: string, target: string): Promise<FileHandle | null> {
	const path = await managedMediaPath(dir, target);
	if (!path) return null;
	// 校验后被换成软链或设备时也不能跟着读；只从这个打开的文件句柄读取。
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
	if (!handle) return null;
	if ((await handle.stat().catch(() => null))?.isFile()) return handle;
	await handle.close();
	return null;
}

/** 文件面板只需要图片的元数据，像素经媒体协议读取。 */
export async function readManagedMedia(dir: string, target: string): Promise<FileContents | null> {
	const handle = await openManagedMedia(dir, target);
	if (!handle) return null;
	try {
		const info = await handle.stat();
		return { text: "", truncated: false, binary: true, bytes: info.size, modifiedAt: info.mtimeMs };
	} finally {
		await handle.close();
	}
}

/** 按受限名字读像素，协议不能借合法图片名下的软链读到别的文件。 */
export async function readMediaBytes(dir: string, name: string): Promise<Buffer | null> {
	if (typeof name !== "string" || !MEDIA_NAME.test(name)) return null;
	const handle = await openManagedMedia(dir, join(dir, name));
	if (!handle) return null;
	try {
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}
