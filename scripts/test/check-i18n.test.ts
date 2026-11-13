import assert from "node:assert/strict";
import { test } from "node:test";
import { chineseFindings } from "../../packages/sdk/plugin-sdk/lib/lint/i18n.mjs";

const lines = (source: string) => chineseFindings(source).map(({ line }: { line: number }) => line);

test("正则字面量里的引号不让后面的中文注释被当成文案", () => {
	assert.deepEqual(lines(`const a = value.replace(/"/g, "'");\n/** 标签属性里的值。 */\nconst b = 1;\n`), []);
	assert.deepEqual(lines(`const re = /https?:\\/\\/[^\\s<>"']+/g;\n/* 写了一半的地址。 */\n`), []);
	assert.deepEqual(lines("const re = /[`]/;\n// 反引号。\n"), []);
	assert.deepEqual(lines(`function f(s) {\n\treturn /'/.test(s);\n}\n/** 说明。 */\n`), []);
	assert.deepEqual(lines(`const f = (s) => /"/.test(s);\n/** 说明。 */\n`), []);
});

test("正则后面的中文字符串照样报出来，字符类里的斜杠不提前收尾", () => {
	assert.deepEqual(lines(`const a = s.replace(/["/]/g, "、");\nconst b = "好";\n`), [1, 2]);
});

test("除号不当成正则的开头", () => {
	assert.deepEqual(lines(`const half = total / 2; const label = "一半"; const r = a / b;\n`), [1]);
	assert.deepEqual(lines(`const x = (a) / 2 + "个";\n`), [1]);
});

test("JSX 的结束标签和文本里的斜杠不当成正则", () => {
	assert.deepEqual(lines("const el = <p><b>你好</b> 和 <i>x</i></p>;\n"), [1]);
	assert.deepEqual(lines("const el = <p>/路径</p>;\n"), [1]);
});
