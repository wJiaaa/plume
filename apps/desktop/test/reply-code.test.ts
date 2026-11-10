import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown, parseMarkdownChunks } from "../src/renderer/markdown/blocks.ts";
import { completeTail } from "../src/renderer/markdown/stream-tail.ts";

const markup = '<Card title="方案 🐦"><Button send="选择 A">选择</Button></Card>';

test("正文扩展保留围栏数据，闭合状态来自原始围栏而不是流式补尾", () => {
	const open = `\x60\x60\x60ui\n${markup}`;
	assert.deepEqual(parseMarkdown(completeTail(open)), [{ kind: "code", lang: "ui", code: markup, open: true }]);
	assert.deepEqual(parseMarkdown(`${open}\n\x60\x60\x60`), [{ kind: "code", lang: "ui", code: markup }]);
});

test("更短或不同字符的结束标记不能让半张表单变成完整块", () => {
	for (const marker of ["`", "~"]) {
		const prefix = `${marker.repeat(4)}ui\n${markup}\n${marker.repeat(3)}`;
		const parsed = parseMarkdown(prefix)[0];
		assert.equal(parsed?.kind, "code");
		if (parsed?.kind !== "code") return;
		assert.equal(parsed.open, true);
		assert.equal(parseMarkdown(`${prefix}\n${marker.repeat(4)}`)[0]?.kind, "code");
		assert.deepEqual(parseMarkdown(completeTail(prefix))[0], { kind: "code", lang: "ui", code: markup, open: true });
	}
	assert.equal((parseMarkdown(`\x60\x60\x60ui\n${markup}\n~~~`)[0] as { open?: boolean }).open, true);
});

test("同一回复的多个围栏保留顺序、原文及独立位置", () => {
	const source = `说明\n\n\x60\x60\x60ui\n${markup}\n\x60\x60\x60\n\n接着说\n\n~~~UI\n<Table rows={[[1,2]]}/>\n~~~`;
	const chunks = parseMarkdownChunks(source);
	const blocks = chunks.filter(({ block }) => block.kind === "code");
	assert.equal(blocks.length, 2);
	assert.ok(source.indexOf(blocks[0]!.raw) < source.indexOf(blocks[1]!.raw));
	assert.deepEqual(
		blocks.map(({ block }) => block.kind === "code" && block.lang),
		["ui", "UI"],
	);
});
