/**
 * 一条已发出的消息带了哪些附件：从消息里存的东西配回成一排，交给气泡外那一排和句子里的标记。纯整理，不碰界面。
 */

import type { ImageContent, UserContent, UserMessage } from "@plume/contract";
import { displayName } from "../composer/attachments/display.ts";
import { sentKind, type FileKind } from "../composer/attachments/file-kind.ts";
import { isAttachmentBody } from "../composer/attachments/placeholders.ts";

/** 气泡要画的一份附件。 */
export interface SentFile {
	key: string;
	name: string;
	label: string;
	kind: FileKind;
	/** 图片的地址：挪进 session-media 的是 `plume-media://`，留在消息里的小图是 `data:`。 */
	src?: string;
	path?: string;
	/** 悬停时那一行：文件名加门类。 */
	tip: string;
	/** 像素和内容都没进提示词，模型只拿到一个名字。 */
	bodiless: boolean;
}

function imageSrc(block: ImageContent | undefined): string | undefined {
	if (!block) return undefined;
	if (block.media) return `plume-media://m/${encodeURIComponent(block.media)}`;
	if (block.data) return `data:${block.mimeType};base64,${block.data}`;
	return undefined;
}

/**
 * 这份附件进提示词的是不是只有名字：看消息里实际装了什么，不按门类猜——一份抽得出字的 PDF 整篇进了提示词，
 * 扫描件和压缩包才只剩一行 `[… — contents not included]`。
 */
function onlyNameSent(content: UserContent[], name: string): boolean {
	return content.some(
		(block) =>
			block.type === "text" && isAttachmentBody(block.text) && block.text.includes(`: ${name}`) && block.text.trimEnd().endsWith("contents not included]"),
	);
}

/**
 * 带了哪几个文件，认回成一排。
 *
 * 图片的像素在 `content` 的图片块里，名字和门类在 `attachments` 里，按次序配回去：第 n 个门类是图片的附件，配
 * 第 n 个图片块。配不齐也不能把图弄丢：剩下的图片块一律补在后面。
 */
export function sentAttachments(message: UserMessage, label: (kind: FileKind) => string, regionShot: string): SentFile[] {
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	const files: SentFile[] = [];
	let at = 0;
	// 「图片 2」里的 2 数的是同门类里的第几个，和输入框那边、和提示词里是同一个数。
	const seen = new Map<FileKind, number>();
	for (const [index, file] of (message.attachments ?? []).entries()) {
		// 转录里是一段没人再校验过的数据，缺了一项的整条跳过。
		if (!file || typeof file !== "object") continue;
		// 记下的门类要复核：一份被记成图片的文档会去配一个不属于它的图片块，把后面每一张图都错开一位。
		const kind = sentKind(file);
		const kindIndex = (seen.get(kind) ?? 0) + 1;
		seen.set(kind, kindIndex);
		const block = kind === "image" ? images[at] : undefined;
		if (block) at++;
		const src = imageSrc(block);
		files.push({
			key: `${index}-${file.name}`,
			name: file.name,
			kind,
			// 存下来的优先，没存的按和输入框同一套规则现算：差一个字，气泡里那些标记就配不上任何一份附件。
			label: file.label ?? displayName({ name: file.name, kind, kindLabel: label(kind), kindIndex }, regionShot),
			tip: `${file.name}\n${label(kind)}`,
			...(src ? { src } : {}),
			...(file.path ? { path: file.path } : {}),
			bodiless: !src && onlyNameSent(message.content, file.name),
		});
	}
	for (; at < images.length; at++) {
		const src = imageSrc(images[at]);
		const kindIndex = (seen.get("image") ?? 0) + 1;
		seen.set("image", kindIndex);
		files.push({
			key: `image-${at}`,
			name: "",
			kind: "image",
			label: `${label("image")} ${kindIndex}`,
			tip: label("image"),
			...(src ? { src } : {}),
			bodiless: false,
		});
	}
	return files;
}

/**
 * 一条用户消息里人打的那些字：发出时存下的 `displayText`；没有的话把文本块拼起来，但附件内容不拼——那是写给
 * 模型的，摊在气泡里是一整篇文件。
 */
export function spokenText(message: UserMessage): string {
	return message.displayText ?? message.content.flatMap((block) => (block.type === "text" && !isAttachmentBody(block.text) ? [block.text] : [])).join("\n");
}
