import assert from "node:assert/strict";
import { test } from "node:test";
import { copyReply } from "../src/renderer/markdown/copy-reply.ts";

test("复制扩展只处理闭合围栏并保留其他原文和空行", () => {
	const source = "\nIntro\n\n```ui\nform\n```\n\n```js\ncode\n```\n\nTail\n";
	assert.equal(
		copyReply(source, (language, code) => (language === "ui" ? `shown ${code}` : undefined)),
		source.replace("```ui\nform\n```", "shown form"),
	);
	assert.equal(
		copyReply(source, () => {
			throw new Error("plugin");
		}),
		source,
	);
	assert.equal(
		copyReply("~~~ui\nwriting", () => "wrong"),
		"~~~ui\nwriting",
	);
	assert.equal(
		copyReply("~~~UI\nform\n~~~", () => ""),
		"",
	);
});
