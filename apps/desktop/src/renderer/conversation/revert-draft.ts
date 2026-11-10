/**
 * 撤回、分叉之后放回输入框的那份草稿：人打的字，和带过的附件。纯整理，图片的像素按名字从 `plume-media://` 读回来。
 */

import type { ImageContent, Message, UserContent, UserMessage } from "@plume/contract";
import { sentKind } from "../composer/attachments/file-kind.ts";
import { isAttachmentBody } from "../composer/attachments/placeholders.ts";
import type { DraftAttachment } from "../composer/attachments/read.ts";
import { spokenText } from "./sent-attachments.ts";

type TextBlock = Extract<UserContent, { type: "text" }>;

/** 最后一条人说的话；界面替人说的「继续」不算，它不画成气泡。没有时是 -1。 */
export function lastUserIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user" && !message.synthetic) return index;
	}
	return -1;
}

/** 编辑重发要带上的那些块：图片和附件的内容原样留着，只换人打的那句。附件在前：先给材料再提问。 */
export function editedContent(message: UserMessage, text: string): UserContent[] {
	const kept = message.content.filter((block) => block.type === "image" || isAttachmentBody(block.text));
	return [...kept, { type: "text", text }];
}

/** 附件正文块里围起来的那段原文；按文件名认块（`### 标签: 名字` 那一行）。 */
function bodyOf(bodies: TextBlock[], name: string): string | undefined {
	for (const block of bodies) {
		const match = /^\n\n### [^\n]*: ([^\n]*)\n```\n([\s\S]*)\n```\n\n$/.exec(block.text);
		if (match?.[1] === name) return match[2];
	}
	return undefined;
}

/** 一张图的像素：挪进 session-media 的按名字读回来；读不到就是 undefined，这张图只剩名字。 */
async function pixelsOf(image: ImageContent): Promise<string | undefined> {
	if (image.data) return image.data;
	if (!image.media) return undefined;
	try {
		const response = await fetch(`plume-media://m/${encodeURIComponent(image.media)}`);
		if (!response.ok) return undefined;
		const blob = await response.blob();
		const url = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(blob);
		});
		return url.slice(url.indexOf(",") + 1);
	} catch {
		return undefined;
	}
}

/**
 * 这条消息放回输入框的样子。字取 `displayText`（附件的正文不进框）；附件按 `attachments` 的次序，图片配第 n 个图片块，
 * 文本配名字对得上的正文块，配不上的只留名字。标签沿用发出时存下的，句子里那些标记才认得回它们。
 */
export async function draftFromMessage(message: UserMessage): Promise<{ text: string; attachments: DraftAttachment[] }> {
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	const bodies = message.content.filter((block): block is TextBlock => block.type === "text" && isAttachmentBody(block.text));
	const attachments: DraftAttachment[] = [];
	let at = 0;
	for (const [index, file] of (message.attachments ?? []).entries()) {
		if (!file || typeof file.name !== "string") continue;
		const kind = sentKind(file);
		const image = kind === "image" ? images[at++] : undefined;
		const data = image ? await pixelsOf(image) : undefined;
		const text = kind === "image" ? undefined : bodyOf(bodies, file.name);
		attachments.push({
			id: `revert-${index}-${file.name}`,
			name: file.name,
			mimeType: file.mimeType ?? image?.mimeType ?? "application/octet-stream",
			kind,
			isText: text !== undefined,
			...(data ? { data } : {}),
			...(text !== undefined ? { text } : {}),
			...(file.path ? { path: file.path } : {}),
			...(file.label ? { label: file.label } : {}),
		});
	}
	// 没有附件清单的图（配不齐的）补在后面，不把图弄丢。
	for (; at < images.length; at++) {
		const image = images[at]!;
		const data = await pixelsOf(image);
		if (data) attachments.push({ id: `revert-image-${at}`, name: "", mimeType: image.mimeType, kind: "image", isText: false, data });
	}
	return { text: spokenText(message), attachments };
}
