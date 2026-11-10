/**
 * 一张图离开应用的路：进剪贴板、存成文件。
 *
 * 看图器的按钮都从这里走，以后别处要复制、另存一张图也走这里，几条路不会各自漂开。每条路都从字节开始。
 *
 * 导出结果经 renderer 的 toast 报出。复制失败退回另存，至少人会看到存文件的对话框，带标注的副本不会悄悄丢掉。
 */

import { translate } from "@plume/ui";
import { notify } from "../toast/store.ts";

/** 任何一张能显示的图，转成 `data:` URL；读不出来（加载失败、跨源画布被污染）时是 null。 */
async function imageDataUrl(src: string): Promise<string | null> {
	if (src.startsWith("data:")) return src;
	try {
		const img = new Image();
		img.src = src;
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0);
		return canvas.toDataURL("image/png");
	} catch {
		return null;
	}
}

/**
 * 把图放进剪贴板，可以直接粘贴。
 *
 * 剪贴板不接的话退回存文件：对一张标注过的副本来说，标注因此丢掉是所有结果里最糟的一个。
 */
export async function copyImage(src: string): Promise<void> {
	try {
		const png = await asPng(src);
		await navigator.clipboard.write([new ClipboardItem({ "image/png": decode(png, "image/png") })]);
		notify(translate("viewer.copied"));
	} catch {
		if (await saveImage(src)) notify(translate("viewer.clipboardUnavailable"), "warn");
	}
}

/** 导出前读回图片失败时明确告知用户，避免点击后看起来像没有反应。 */
export function notifyExportFailed(): void {
	notify(translate("viewer.exportFailed"), "error");
}

/**
 * 存一份副本。
 *
 * 一律经 `data:` URL 给链接的 `download`：主进程没有接管下载，Electron 会弹出它自己的保存对话框。
 */
export async function saveImage(src: string): Promise<boolean> {
	const dataUrl = await imageDataUrl(src);
	if (!dataUrl) {
		notifyExportFailed();
		return false;
	}
	const subtype = /^data:image\/([\w.+-]+)/.exec(dataUrl)?.[1] ?? "png";
	const link = document.createElement("a");
	link.href = dataUrl;
	link.download = imageFileName(subtype === "jpeg" ? "jpg" : subtype);
	link.click();
	return true;
}

/** `plume-image-2026-10-13-11-58-03.png`，本地时间：存下来的图在下载文件夹里认得出是哪天的，毫秒时间戳认不出。 */
function imageFileName(extension: string, at = new Date()): string {
	const two = (value: number) => String(value).padStart(2, "0");
	const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`;
	return `plume-image-${stamp}.${extension}`;
}

/**
 * 转成 PNG 的 `data:` URL。
 *
 * 剪贴板的图片格式是 PNG，WebP、GIF 原样交过去写不进去。经一块画布重画，窗口能解码的格式都变成 PNG；
 * 标注过的副本本来就是 PNG，直接通过。
 */
async function asPng(src: string): Promise<string> {
	const dataUrl = await imageDataUrl(src);
	if (!dataUrl) throw new Error("image is gone");
	if (dataUrl.startsWith("data:image/png")) return dataUrl;
	const bitmap = await createImageBitmap(decode(dataUrl));
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvas.toDataURL("image/png");
}

/**
 * 手工把 `data:` URL 变成 `Blob`。
 *
 * `fetch(dataUrl)` 是整洁的写法，但渲染进程的内容策略可能拒绝把 `data:` 当作 fetch 目标；`atob` 没有这个
 * 顾虑。不给类型时留给 `createImageBitmap` 自己嗅。
 */
function decode(dataUrl: string, type?: string): Blob {
	const comma = dataUrl.indexOf(",");
	const binary = atob(dataUrl.slice(comma + 1));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], type ? { type } : undefined);
}
