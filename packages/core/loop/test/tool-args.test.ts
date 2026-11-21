import { describe, expect, it } from "vitest";
import { argumentProblems, coerceArgs } from "../src/tool-args.ts";

const parameters = {
	type: "object",
	properties: {
		path: { type: "string" },
		limit: { type: "integer" },
		ratio: { type: "number" },
		all: { type: "boolean" },
		files: { type: "array", items: { type: "string" } },
		mode: { type: "string", enum: ["fast", "full"] },
		either: { type: ["string", "number"] },
		loose: { anyOf: [{ type: "string" }, { type: "array" }] },
	},
	required: ["path"],
};

describe("工具参数按 parameters 整理和检查", () => {
	it("整理意思不含糊的写错：字符串写的数字、布尔、JSON 数组，类型里没有 null 的参数给了 null 当没给", () => {
		const args = { path: "a", limit: "10", ratio: " 0.5 ", all: "false", files: '["x","y"]', mode: null };
		expect(coerceArgs(args, parameters)).toEqual({ path: "a", limit: 10, ratio: 0.5, all: false, files: ["x", "y"] });
	});

	it("对得上的、没声明的、组合写法的原样放过，返回同一个对象", () => {
		const args = { path: "a", limit: 3, extra: { x: 1 }, loose: 5, either: 2 };
		expect(coerceArgs(args, parameters)).toBe(args);
		expect(argumentProblems(args, parameters)).toEqual([]);
	});

	it("数字、布尔给了字符串类型的参数：转成字符串", () => {
		expect(coerceArgs({ path: 12, either: true }, parameters)).toEqual({ path: "12", either: "true" });
	});

	it("整理不了的报出哪一项错了：类型不对、不在 enum 里、小数给了整数；缺了必填的不拦，由工具自己决定", () => {
		expect(argumentProblems(coerceArgs({ limit: "ten", mode: "slow", ratio: 1, all: 1, files: {} }, parameters), parameters)).toEqual([
			'"limit" must be integer, got string',
			'"all" must be boolean, got number',
			'"files" must be array, got object',
			'"mode" must be one of "fast", "full"',
		]);
		expect(coerceArgs({ path: null }, parameters)).toEqual({});
		expect(argumentProblems(coerceArgs({ path: "a", limit: "1.5" }, parameters), parameters)).toEqual(['"limit" must be integer, got string']);
	});

	it("没有 properties 的声明不查", () => {
		expect(argumentProblems({ anything: 1 }, { type: "object" })).toEqual([]);
	});
});
