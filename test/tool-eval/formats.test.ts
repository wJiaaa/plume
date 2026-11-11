/**
 * 应用器决定一次编辑算不算通过，所以在跑任何模型之前先测它们。这里有 bug 的话，表现出来是某种格式「更差」——
 * 而那正是整个评测最不能误得的结论。
 *
 *   node --test --experimental-transform-types test/tool-eval/formats.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FORMATS } from "./formats.ts";

const FILE = "a\nb\nc\nd\ne\n";

const strReplace = FORMATS["str-replace"];
const production = FORMATS.production;

test("str-replace：唯一匹配时应用", async () => {
	assert.equal((await strReplace.apply({ path: "x", old_string: "b", new_string: "B" }, FILE)).content, "a\nB\nc\nd\ne\n");
});

test("str-replace：不加 replace_all 时多处匹配被拒", async () => {
	const dup = "x\nx\n";
	const r = await strReplace.apply({ path: "x", old_string: "x", new_string: "y" }, dup);
	assert.equal(r.ok, false);
	assert.match(r.error!, /not unique/);
	assert.equal((await strReplace.apply({ path: "x", old_string: "x", new_string: "y", replace_all: true }, dup)).content, "y\ny\n");
});

test("str-replace：找不到锚点被拒", async () => {
	assert.equal((await strReplace.apply({ path: "x", old_string: "nope", new_string: "y" }, FILE)).ok, false);
});

test("str-replace：新文字里的 $ 原样写入，不当成替换模式", async () => {
	assert.equal((await strReplace.apply({ path: "x", old_string: "b", new_string: "$&$1" }, FILE)).content, "a\n$&$1\nc\nd\ne\n");
});

test("production：说明和参数取自 plume.tools 的 edit", () => {
	assert.equal(production.spec.name, "edit");
	assert.deepEqual(Object.keys(production.spec.parameters.properties ?? {}).sort(), ["new_string", "old_string", "path", "replace_all"]);
});

test("production：唯一匹配时写进文件", async () => {
	const r = await production.apply({ path: "src/x.ts", old_string: "b", new_string: "B" }, FILE);
	assert.equal(r.ok, true);
	assert.equal(r.content, "a\nB\nc\nd\ne\n");
});

test("production：多处匹配时报工具自己的错", async () => {
	const r = await production.apply({ path: "src/x.ts", old_string: "x", new_string: "y" }, "x\nx\n");
	assert.equal(r.ok, false);
	assert.match(r.error!, /appears 2 times/);
});
