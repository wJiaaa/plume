/**
 * 一份草稿里的字和文件，摊成发出去的那条消息：模型读的 `content`，和气泡外那排格子要的附件清单。
 */

import type { MessageAttachment, UserContent } from "@plume/contract";
import { attachmentBody, attachmentFolder, attachmentImageLabel, attachmentLabel, attachmentStub, placeAttachments } from "./placeholders.ts";

/** 附件在草稿里的样子，只取这一步用得上的几项。 */
export interface OutgoingAttachment {
	name: string;
	mimeType: string;
	kind?: string;
	data?: string;
	text?: string;
	isText?: boolean;
	path?: string;
	/** 界面上叫什么：正文里那枚标记写的是它，附件要按标记的位置排就靠它配对。 */
	label?: string;
	/** 标注副本是从哪张图来的，见 `DraftAttachment.from`。 */
	from?: string;
}

/**
 * 附件的名字、门类、位置——给气泡看的那一份，不含内容：内容已经在 `content` 里了，再存一份会让每份会话日志大一倍。
 * 路径留下：没有它，一条发出去的消息对着自己带的表格，能做的只有把名字显示出来。
 */
export function attachmentMeta(files: OutgoingAttachment[]): MessageAttachment[] {
	return files.map((file) => ({
		name: file.name,
		...(file.label ? { label: file.label } : {}),
		...(file.kind ? { kind: file.kind } : {}),
		...(file.mimeType ? { mimeType: file.mimeType } : {}),
		...(file.path ? { path: file.path } : {}),
	}));
}

/**
 * 正文和附件按标记的位置排成内容块。
 *
 * 每份附件自己占一个块，不和前后的字并在一起：并成一块就分不出哪段是人写的、哪段是文件（见 `isAttachmentBody`）。
 * 每份都带上它在这条消息里的位置，按实际写进提示词的先后数——模型看到的是这个先后。没有标记可站的附件整体
 * 走在正文前面：先给材料再提问。
 */
export function spellDraft(text: string, attachments: OutgoingAttachment[]): UserContent[] {
	const { segments, unplaced } = placeAttachments(text, attachments);
	const content: UserContent[] = [];
	let buffer = "";
	const flush = () => {
		if (buffer) content.push({ type: "text", text: buffer });
		buffer = "";
	};

	const total = attachments.length;
	const kindTotals = new Map<string, number>();
	for (const file of attachments) {
		const kind = file.kind ?? "file";
		kindTotals.set(kind, (kindTotals.get(kind) ?? 0) + 1);
	}
	const kindSeen = new Map<string, number>();
	let placed = 0;

	const labelFor = (file: OutgoingAttachment): string => {
		const kind = file.kind ?? "file";
		placed += 1;
		const kindIndex = (kindSeen.get(kind) ?? 0) + 1;
		kindSeen.set(kind, kindIndex);
		return attachmentLabel({ index: placed, total, kind: file.kind, kindIndex, kindTotal: kindTotals.get(kind) ?? 1 });
	};

	const spell = (file: OutgoingAttachment) => {
		const label = labelFor(file);
		flush();
		if (file.isText && file.text) {
			content.push({ type: "text", text: attachmentBody(file.name, file.text, label) });
			return;
		}
		if (!file.isText && file.data) {
			// 图片前面先写一行说它是谁、排第几：图片块里写不了字，三张截图之间唯一的区别就是这一行。
			content.push({ type: "text", text: attachmentImageLabel(file.name, label) });
			content.push({ type: "image", data: file.data, mimeType: file.mimeType, ...(file.from ? { from: file.from } : {}) });
			return;
		}
		if (file.kind === "folder" && file.path) {
			content.push({ type: "text", text: attachmentFolder(file.name, file.path, label) });
			return;
		}
		// 只带名字和类型的，说明没带内容，模型就不会装作读过。
		content.push({ type: "text", text: attachmentStub(file.name, file.mimeType, label) });
	};

	for (const file of unplaced) spell(file);
	for (const segment of segments) {
		if (segment.kind === "text") buffer += segment.text;
		else spell(segment.file);
	}
	flush();

	return content;
}
