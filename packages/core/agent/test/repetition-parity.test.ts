import { expect, it } from "vitest";
import type { ToolResultMessage } from "@plume/contract";
import { reply } from "../../../builtin/compaction/test/helpers.ts";
import { RepetitionWatch, replaceRepeats } from "../src/repetition.ts";

const result = (id: string, output = "一样", isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: output }],
	isError,
	timestamp: 0,
});
/** 假装注册了两个改文件的工具（`ToolDefinition.category` 是 `files`）：本体不认工具名，只认这个声明。 */
const editsFiles = (tool: string) => tool === "save_file" || tool === "patch_file";
const observe = (watch: RepetitionWatch, name: string, args: unknown, id: string, output = "一样", isError = false) => {
	watch.observe([{ name, arguments: args }], [result(id, output, isError)], editsFiles);
	return watch.takeHint();
};

it("翻页第十二次提醒一次，不换结果、不停止；键顺序和大小写不影响页码识别", () => {
	const watch = new RepetitionWatch();
	const hints = Array.from({ length: 36 }, (_, index) =>
		observe(watch, "read", { path: "big.ts", OFFSET: index * 100, limit: 100 }, `${index}`, `page ${index}`),
	);
	expect(hints.slice(0, 11).every((hint) => hint === undefined)).toBe(true);
	expect(hints[11]).toContain("不同的翻页参数");
	expect(hints.filter(Boolean)).toHaveLength(1);
	expect(watch.replaced.size).toBe(0);
	expect(watch.exhausted()).toBe(false);
});

it("精确重复优先，同时继续累计翻页；同工具同参数但新结果不能触发停止", () => {
	const watch = new RepetitionWatch();
	for (let index = 0; index < 2; index++) expect(observe(watch, "read", { path: "a", offset: 0 }, `${index}`)).toBeUndefined();
	expect(observe(watch, "read", { offset: 0, path: "a" }, "2")).toContain("同样的参数");
	for (let index = 3; index < 11; index++) expect(observe(watch, "read", { path: "a", offset: index }, `${index}`, `${index}`)).toBeUndefined();
	expect(observe(watch, "read", { path: "a", offset: 11 }, "11", "11")).toContain("不同的翻页参数");
	for (let index = 12; index < 25; index++) observe(watch, "read", { path: "a", offset: 11 }, `${index}`, "x".repeat(500) + index);
	expect(watch.exhausted()).toBe(false);
});

it("同参数同结果到上限停下，每次参数不同的不算", () => {
	const watch = new RepetitionWatch();
	for (let index = 0; index < 10; index++) observe(watch, "read", { path: "/tmp/band_0.png" }, `${index}`);
	expect(watch.exhausted()).toBe(true);
	watch.reset();
	for (let index = 0; index < 10; index++) expect(observe(watch, "bash", { command: `ffmpeg -i src.mov frame-${index}.png` }, `frame${index}`)).toBeUndefined();
	expect(watch.exhausted()).toBe(false);
});

it("整个工具步先按成功改动清零，失败写入不清零；重置保留已替换历史", () => {
	const watch = new RepetitionWatch();
	for (let index = 0; index < 9; index++) observe(watch, "read", { path: "a" }, `${index}`);
	observe(watch, "save_file", { path: "a" }, "failed", "拒绝", true);
	watch.observe(
		[
			{ name: "read", arguments: { path: "a" } },
			{ name: "patch_file", arguments: { path: "b" } },
		],
		[result("last"), result("changed")],
		editsFiles,
	);
	expect(watch.exhausted()).toBe(false);
	expect(watch.takeHint()).toBeUndefined();
	watch.reset();
	expect(observe(watch, "read", { path: "a" }, "after")).toBeUndefined();
	expect(watch.replaced.get("2")).toContain("第 3 次");
});

it("图片内容变化不算同一结果；原文不在上下文时不把唯一的结果替换成重复提示", () => {
	const watch = new RepetitionWatch();
	for (let index = 0; index < 10; index++) {
		watch.observe(
			[{ name: "read", arguments: { path: "image.png" } }],
			[{ ...result(`${index}`), content: [{ type: "image", data: `image${index}`, mimeType: "image/png" }] }],
			editsFiles,
		);
	}
	expect(watch.exhausted()).toBe(false);
	expect(watch.replaced.size).toBe(0);
	const only = result("repeat");
	expect(replaceRepeats([only], new Map([["repeat", "替换"]]))).toEqual([only]);
});

it("同图原文被裁掉后，不能拿同参数的另一张图片当作可见原文", () => {
	const calls = reply(["other", "repeat"].map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: "shot.png" } })));
	const original = {
		...result("other", "截图"),
		content: [
			{ type: "text" as const, text: "截图" },
			{ type: "image" as const, data: "new-image", mimeType: "image/png" },
		],
	};
	const repeated = {
		...result("repeat", "截图"),
		content: [
			{ type: "text" as const, text: "截图" },
			{ type: "image" as const, data: "old-image", mimeType: "image/png" },
		],
	};
	const replaced = new Map([["repeat", "前面已有同样结果"]]);
	expect(replaceRepeats([calls, original, repeated], replaced).at(-1)).toEqual(repeated);
	const sameImage = { ...original, content: structuredClone(repeated.content) };
	expect(replaceRepeats([calls, sameImage, repeated], replaced).at(-1)?.content).toEqual([{ type: "text", text: "前面已有同样结果" }]);
});
