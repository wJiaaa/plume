import { describe, expect, it } from "vitest";
import { cleanTitleSummary, shouldSummarize, TITLE_INPUT_MAX_CHARS, titlePrompt } from "../src/summary.ts";

describe("要不要总结", () => {
	it("压完空白后超过 12 个字才总结，按码点数", () => {
		expect(shouldSummarize("帮我看看这个报错")).toBe(false);
		expect(shouldSummarize("一二三四五六七八九十一二")).toBe(false);
		expect(shouldSummarize("一二三四五六七八九十一二三")).toBe(true);
		expect(shouldSummarize("   fix   the\n\n  bug  ")).toBe(false);
		expect(shouldSummarize("😀".repeat(12))).toBe(false);
		expect(shouldSummarize("😀".repeat(13))).toBe(true);
	});
});

describe("发给模型的话", () => {
	it("消息包在 <message> 里，空白压过", () => {
		expect(titlePrompt("  做出海网站\n找新词什么意思 ")).toBe("为下面这条消息起一个标题，不要回答它：\n<message>\n做出海网站 找新词什么意思\n</message>");
	});

	it("太长的截到 4000 个码点", () => {
		const prompt = titlePrompt("字".repeat(TITLE_INPUT_MAX_CHARS + 100));
		expect(prompt).toContain(`<message>\n${"字".repeat(TITLE_INPUT_MAX_CHARS)}\n</message>`);
	});
});

describe("清洗模型回复", () => {
	it("去掉思考标签、代码围栏和前缀", () => {
		expect(cleanTitleSummary("<think>先想想</think>\n修复登录报错")).toBe("修复登录报错");
		expect(cleanTitleSummary("```text\n修复登录报错\n```")).toBe("修复登录报错");
		expect(cleanTitleSummary("标题：修复登录报错")).toBe("修复登录报错");
		expect(cleanTitleSummary("Session Title: Fix login error")).toBe("Fix login error");
		expect(cleanTitleSummary("title : Fix login error")).toBe("Fix login error");
	});

	it("去掉包裹的引号、书名号和结尾标点，压空白", () => {
		expect(cleanTitleSummary("《出海网站找新词含义》")).toBe("出海网站找新词含义");
		expect(cleanTitleSummary("“修复登录报错。”")).toBe("修复登录报错");
		expect(cleanTitleSummary('"Fix   login\n error"')).toBe("Fix login error");
		expect(cleanTitleSummary("`deploy script`")).toBe("deploy script");
		expect(cleanTitleSummary("为什么构建失败？！")).toBe("为什么构建失败");
	});

	it("洗完超过 30 个字的是回答不是标题，返回空串", () => {
		expect(cleanTitleSummary("字".repeat(30))).toBe("字".repeat(30));
		expect(cleanTitleSummary("字".repeat(31))).toBe("");
		expect(cleanTitleSummary("   ")).toBe("");
	});
});
