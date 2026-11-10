/**
 * 会话里的图片放在会话文件外面。
 *
 * 一张截图的 base64 就有几 MB。留在会话 JSON 里，每次打开会话、每条消息事件都要把它整个复制一遍过 MessagePort。
 * 所以写进会话时，大图按内容的 sha1 存成 `session-media/<sha1>.<扩展名>`，消息里只留文件名（`media`），`data` 置空；
 * 界面经 `plume-media://` 协议按名字取图，发给模型前再把 `data` 读回来。按内容寻址，同一张图发几次只存一份。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ImageContent, Message } from "@plume/contract";

/** 这么短的 base64（约 6KB 的图）留在消息里，挪出去反而多一次读文件。 */
const INLINE_IMAGE_CHARS = 8000;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };

/** 模型收的图就这四种。别的（read 读到的 BMP）存下、画给人看，发给模型时换成一句话。 */
const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** `plume-media://` 只认这种名字，路径不可能跳出目录。 */
export const MEDIA_NAME = /^[0-9a-f]{40}\.(png|jpg|webp|gif|bmp)$/;

const isImage = (block: unknown): block is ImageContent =>
	typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image" && typeof (block as { data?: unknown }).data === "string";

/** 消息里的图，加上工具结果里只给人看的图（`shownImages`，见 `ToolOutput.shownImages`）：一样大，一样挪出去。 */
function images(message: Message): ImageContent[] {
	if (message.role === "assistant") return [];
	const shown = message.role === "toolResult" ? (message.shownImages ?? []) : [];
	return [...message.content.filter(isImage), ...shown.filter(isImage)];
}

/** 存一张图进 dir，交回按内容起的名字；不是那几种图片时是 null。插件的 `ctx.media.save` 也走这里，名字和挪出消息的图对得上。 */
export async function saveImage(dir: string, data: string, mimeType: string): Promise<string | null> {
	const extension = EXTENSIONS[mimeType];
	if (!extension) return null;
	const bytes = Buffer.from(data, "base64");
	const name = `${createHash("sha1").update(bytes).digest("hex")}.${extension}`;
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, name), bytes);
	return name;
}

/** 按名字读回一张图；名字不对、文件不在时是 null。 */
export async function readImage(dir: string, name: string): Promise<{ data: string; mimeType: string } | null> {
	const match = MEDIA_NAME.exec(name);
	if (!match) return null;
	const mimeType = Object.entries(EXTENSIONS).find(([, extension]) => extension === match[1])?.[0];
	const bytes = await readFile(join(dir, name)).catch(() => null);
	return bytes && mimeType ? { data: bytes.toString("base64"), mimeType } : null;
}

/** 一个绝对路径要是 dir 里的图，交回名字。 */
export function imageNameOf(dir: string, path: string): string | null {
	const full = resolve(path);
	const name = basename(full);
	return dirname(full) === resolve(dir) && MEDIA_NAME.test(name) ? name : null;
}

/** 把消息里的大图挪进 dir，原地改成只留 `media`。 */
export async function parkImages(dir: string, message: Message): Promise<void> {
	for (const image of images(message)) {
		if (image.data.length <= INLINE_IMAGE_CHARS) continue;
		const name = await saveImage(dir, image.data, image.mimeType);
		if (!name) continue;
		image.media = name;
		image.data = "";
	}
}

/**
 * 给模型的那份：挪出去的图读回 `data`。改的是传进来的消息（调用方给的是副本）。读不到的图丢掉，不发一张空图。
 *
 * 模型不收的格式换成一句话，而不是原样发过去：那条结果一旦进了历史，之后每一轮都带着它，
 * 不认它的服务每一轮都回 400，换来的是一个再也说不了话的会话。
 */
export async function restoreImages(dir: string, messages: Message[]): Promise<void> {
	for (const message of messages) {
		if (message.role === "assistant") continue;
		const kept = [];
		for (const block of message.content) {
			if (block.type === "image" && !MODEL_IMAGE_TYPES.has(block.mimeType)) {
				kept.push({ type: "text" as const, text: `[unsupported image: ${block.mimeType}]` });
				continue;
			}
			if (block.type === "image" && !block.data && block.media) {
				if (!MEDIA_NAME.test(block.media)) continue;
				try {
					block.data = (await readFile(join(dir, block.media))).toString("base64");
				} catch {
					continue;
				}
			}
			kept.push(block);
		}
		message.content = kept as typeof message.content;
	}
}
