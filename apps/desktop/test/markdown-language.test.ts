import { describe, expect, it } from "vitest";
import { loadedFenceLanguage, loadFenceLanguage } from "../src/renderer/markdown/highlight.ts";

describe("围栏语法缓存", () => {
	it("并发和别名共用语法，加载后首帧可同步读取", async () => {
		expect(loadedFenceLanguage("typescript")).toBeUndefined();
		const [short, long] = await Promise.all([loadFenceLanguage("ts"), loadFenceLanguage("TypeScript:示例")]);
		expect(short).not.toBeNull();
		expect(long).toBe(short);
		expect(loadedFenceLanguage("typescript")).toBe(short);
		expect(await loadFenceLanguage("ts")).toBe(short);
	});

	it("切换语言不会借用上一种语法", async () => {
		const ts = await loadFenceLanguage("ts");
		expect(loadedFenceLanguage("python")).toBeUndefined();
		const py = await loadFenceLanguage("py");
		expect(py).not.toBeNull();
		expect(py).not.toBe(ts);
		expect(loadedFenceLanguage("python")).toBe(py);
	});

	it("空语言、未知名称及原型属性都按纯文本，不建立无限名称缓存", async () => {
		for (const info of ["", "unknown-language", "constructor", "__proto__"]) {
			expect(loadedFenceLanguage(info)).toBeNull();
			expect(await loadFenceLanguage(info)).toBeNull();
		}
	});
});
