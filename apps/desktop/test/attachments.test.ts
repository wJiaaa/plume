/**
 * 附件：门类判定、屏幕上的名字、正文里的标记，以及发给模型的那串内容块。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { displayName, isPlaceholderName, nameParts } from "../src/renderer/composer/attachments/display.ts";
import { fileKind, isReadableAsText, looksBinary, sentKind } from "../src/renderer/composer/attachments/file-kind.ts";
import { attachmentMeta, spellDraft } from "../src/renderer/composer/attachments/outgoing.ts";
import {
	attachmentLabel,
	isAttachmentBody,
	placeAttachments,
	renamePlaceholders,
	scanPlaceholders,
} from "../src/renderer/composer/attachments/placeholders.ts";

test("门类先看扩展名再看 MIME，认不出的当文本；csv 图标是表格但能当文本读", () => {
	assert.equal(fileKind("a.DOC"), "word");
	assert.equal(fileKind("blob", "image/png"), "image");
	assert.equal(fileKind("Dockerfile"), "text");
	assert.equal(fileKind("x", null as unknown as string), "text");
	assert.equal(fileKind("data.csv"), "excel");
	assert.equal(isReadableAsText("excel", "data.csv"), true);
	assert.equal(isReadableAsText("excel", "data.xlsx"), false);
});

test("看字节认二进制：NUL 或控制字符过多", () => {
	assert.equal(looksBinary(new TextEncoder().encode("hello\nworld\t")), false);
	assert.equal(looksBinary(new Uint8Array([104, 0, 105])), true);
	assert.equal(looksBinary(new Uint8Array(100).fill(1)), true);
	assert.equal(looksBinary(new Uint8Array()), false);
});

test("记成图片的附件要经得起名字和类型的复核", () => {
	assert.equal(sentKind({ name: "notes.md", kind: "image" }), "text");
	assert.equal(sentKind({ name: "clip", kind: "image" }), "image");
	assert.equal(sentKind({ name: "a.pdf", kind: "nonsense" }), "pdf");
});

test("图片和没名字的按门类加序号称呼，扩展名单独摘出来", () => {
	assert.equal(isPlaceholderName("image (2).png"), true);
	assert.equal(isPlaceholderName("页面区域.png", "页面区域.png"), true);
	assert.equal(isPlaceholderName("report.pdf"), false);
	assert.equal(displayName({ name: "DSC_0042.JPG", kind: "image", kindLabel: "图片", kindIndex: 2 }), "图片 2");
	assert.equal(displayName({ name: "report.pdf", kind: "pdf", kindLabel: "PDF", kindIndex: 1 }), "report.pdf");
	assert.deepEqual(nameParts("表.xlsx"), { stem: "表", ext: "xlsx" });
	assert.deepEqual(nameParts("会议纪要 2026.09.13 定稿"), { stem: "会议纪要 2026.09.13 定稿", ext: "" });
});

test("标记按名字加次序配对，认不出的方括号是普通标点", () => {
	const a = { name: "a.png", label: "图片 1" };
	const b = { name: "b.png", label: "图片 1" };
	const text = "看【重要】【图片 1】和【图片 1】";
	const hits = scanPlaceholders(text, [a, b]);
	assert.deepEqual(
		hits.map((hit) => [hit.file, text.slice(hit.start, hit.end)]),
		[
			[a, "【图片 1】"],
			[b, "【图片 1】"],
		],
	);
});

test("改名时句子里的标记跟着改，卸下的拿掉并收干净空白", () => {
	const one = { name: "x.png", label: "图片 1" };
	const two = { name: "y.png", label: "图片 2" };
	const next = renamePlaceholders("比 【图片 1】 和 【图片 2】", [one, two], (file) => (file === one ? null : "图片 1"));
	assert.equal(next, "比 和 【图片 1】");
});

test("发出去的内容：没标记的附件在前，图片前面一行标签，文件夹给路径，读不出的说明没带内容", () => {
	const image = { name: "shot.png", label: "图片 1", kind: "image", mimeType: "image/png", data: "AAAA", isText: false };
	const doc = { name: "notes.md", label: "notes.md", kind: "text", mimeType: "text/markdown", text: "# hi", isText: true };
	const folder = { name: "src", label: "src", kind: "folder", mimeType: "inode/directory", isText: false, path: "/w/src" };
	const zip = { name: "a.zip", label: "a.zip", kind: "archive", mimeType: "application/zip", isText: false };
	const content = spellDraft("对比【图片 1】和【notes.md】", [image, doc, folder, zip]);
	assert.deepEqual(content, [
		{ type: "text", text: '\n\n[Attachment 1 of 4, folder: src — folder at "/w/src"; contents not included, read it with your tools if needed]\n\n' },
		{ type: "text", text: "\n\n[Attachment 2 of 4, archive: a.zip (application/zip) — contents not included]\n\n" },
		{ type: "text", text: "对比" },
		{ type: "text", text: "\n\n### Attachment 3 of 4, image: shot.png\n\n" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		{ type: "text", text: "和" },
		{ type: "text", text: "\n\n### Attachment 4 of 4, text: notes.md\n```\n# hi\n```\n\n" },
	]);
	assert.equal(content.filter((block) => block.type === "text" && isAttachmentBody(block.text)).length, 4);
	assert.deepEqual(attachmentMeta([image, folder]), [
		{ name: "shot.png", label: "图片 1", kind: "image", mimeType: "image/png" },
		{ name: "src", label: "src", kind: "folder", mimeType: "inode/directory", path: "/w/src" },
	]);
});

test("只有一个附件时不写序号；同门类多个时写门类内的序号", () => {
	assert.equal(attachmentLabel({ index: 1, total: 1, kind: "text", kindIndex: 1, kindTotal: 1 }), "Attached file");
	assert.equal(attachmentLabel({ index: 1, total: 1, kind: "folder", kindIndex: 1, kindTotal: 1 }), "Attached folder");
	assert.equal(attachmentLabel({ index: 2, total: 3, kind: "image", kindIndex: 2, kindTotal: 2 }), "Attachment 2 of 3, image 2 of 2");
	const { segments, unplaced } = placeAttachments("无标记", [{ name: "a" }]);
	assert.deepEqual(segments, [{ kind: "text", text: "无标记" }]);
	assert.equal(unplaced.length, 1);
});
