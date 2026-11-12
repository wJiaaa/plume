/**
 * 撤回、分叉放回输入框的草稿，和编辑重发要带上的内容块。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserMessage } from "@plume/contract";
import { attachmentBody, attachmentImageLabel } from "../src/renderer/composer/attachments/placeholders.ts";
import { draftFromMessage, editedContent, lastUserIndex } from "../src/renderer/conversation/revert-draft.ts";

const sent: UserMessage = {
	role: "user",
	content: [
		{ type: "text", text: attachmentImageLabel("shot.png", "Attachment 1 of 2, image") },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		{ type: "text", text: "看看【图片 1】和【notes.md】" },
		{ type: "text", text: attachmentBody("notes.md", "第一行\n```\n里面的围栏\n```", "Attachment 2 of 2, text", "/tmp/notes.md") },
	],
	displayText: "看看【图片 1】和【notes.md】",
	attachments: [
		{ name: "shot.png", kind: "image", mimeType: "image/png", label: "图片 1" },
		{ name: "notes.md", kind: "text", mimeType: "text/markdown", label: "notes.md", path: "/tmp/notes.md" },
	],
	timestamp: 1,
};

test("放回输入框的是人打的字和附件：图配图片块，文本按名字配正文（正文里的围栏不截断），标签照发出时的", async () => {
	const draft = await draftFromMessage(sent);
	assert.equal(draft.text, "看看【图片 1】和【notes.md】");
	assert.deepEqual(
		draft.attachments.map(({ name, kind, isText, data, text, label, path }) => ({ name, kind, isText, data, text, label, path })),
		[
			{ name: "shot.png", kind: "image", isText: false, data: "AAAA", text: undefined, label: "图片 1", path: undefined },
			{ name: "notes.md", kind: "text", isText: true, data: undefined, text: "第一行\n```\n里面的围栏\n```", label: "notes.md", path: "/tmp/notes.md" },
		],
	);
});

test("编辑重发留着图片和附件的块，人打的那句换成新的；最后一条人话不算界面替人说的", () => {
	const content = editedContent(sent, "改过的话【图片 1】");
	assert.deepEqual(
		content.map((block) => block.type),
		["text", "image", "text", "text"],
	);
	assert.deepEqual(content.at(-1), { type: "text", text: "改过的话【图片 1】" });
	assert.ok(!JSON.stringify(content).includes("看看"));
	assert.equal(lastUserIndex([sent, { role: "user", content: [{ type: "text", text: "继续" }], synthetic: true, timestamp: 2 }]), 0);
	assert.equal(lastUserIndex([]), -1);
});
