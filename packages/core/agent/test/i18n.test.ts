import { afterEach, describe, expect, it } from "vitest";
import { CATALOGS, setLocale, text } from "../src/i18n.ts";

const slots = (template: string) => [...new Set([...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]))].sort();

describe("agent 进程的文案", () => {
	afterEach(() => setLocale("zh-CN"));

	it("中英两份 key 一样、每句都有字、{变量} 和中文原文一致", () => {
		const source = CATALOGS["zh-CN"];
		for (const [locale, catalog] of Object.entries(CATALOGS)) {
			expect(Object.keys(catalog).sort(), locale).toEqual(Object.keys(source).sort());
			for (const [key, template] of Object.entries(catalog)) {
				expect(template.trim(), `${locale} ${key}`).not.toBe("");
				expect(slots(template), `${locale} ${key}`).toEqual(slots(source[key as keyof typeof source]));
			}
		}
	});

	it("按 setLocale 的语言填变量", () => {
		expect(text("session.notFound", { id: "a" })).toBe("没有会话 a");
		setLocale("en");
		expect(text("session.notFound", { id: "a" })).toBe("No session a");
		expect(text("export.empty", undefined, "zh-CN")).toBe("这个会话还没有消息。");
		expect(text("session.notFound", { id: "a" })).toBe("No session a");
	});
});
