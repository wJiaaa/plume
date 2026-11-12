import { expect, it } from "vitest";
import type { AssistantMessage } from "@plume/contract";
import { diagnoseCache, estimateParts } from "../src/usage-record.ts";

it("提示词按插件标的类别分到系统、说明与记忆、技能与智能体；没标类别的记忆、技能段算系统；消息按谁说的分，界面替人说的算注入", () => {
	const sections = [
		{ id: "identity", text: "a".repeat(40) },
		{ id: "agents-md", text: "b".repeat(80), category: "conventions" as const },
		{ id: "settings", text: "h".repeat(12), category: "instructions" as const },
		// 段名和 plume.prompt 的指令同名、没标类别：算系统提示词。
		{ id: "userInstructions", text: "u".repeat(4) },
		{ id: "learned", text: "记".repeat(5), category: "memory" as const },
		// 不认段名：没标类别的算系统提示词。
		{ id: "notes", text: "f".repeat(16) },
		{ id: "catalogue", text: "c".repeat(120), category: "skills" as const },
		{ id: "agents", text: "d".repeat(40), category: "catalog" as const },
		// 段名叫 skills、没标类别的也算系统提示词。
		{ id: "skills", text: "g".repeat(8) },
	];
	const parts = estimateParts({
		// 段与段之间的两个换行算系统提示词。
		systemPrompt: sections.map((section) => section.text).join("\n\n"),
		sections,
		tools: [],
		messages: [
			{ role: "user", content: [{ type: "text", text: "问".repeat(3) }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "e".repeat(8) }], timestamp: 1, synthetic: true },
		],
	});
	// 按字数估（和上下文用量圆环、压缩同一份），这里按字数写：段与段之间八处空行算系统提示词。
	const chars = {
		system: 40 + 4 + 16 + 8 + 2 * 8,
		instructions: 80 + 12 + 5,
		skills: 120 + 40,
		toolDefs: 0,
		user: 3,
		injected: 8,
		assistant: 0,
		toolResults: 0,
	};
	expect(Object.keys(parts).sort()).toEqual(Object.keys(chars).sort());
	for (const [part, count] of Object.entries(chars)) expect(parts[part as keyof typeof parts], part).toBeCloseTo(count / 3.5);
});

it("缓存诊断：没量到前缀分不清，前缀没变是服务商，参数变了不归到服务商头上，没报过缓存的不计", () => {
	const reply = (prefix?: AssistantMessage["prefix"], cacheWrite = 0): AssistantMessage => ({
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: { input: 5_000, output: 1, cacheRead: 0, cacheWrite, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
		...(prefix ? { prefix } : {}),
	});
	const previous = { prompt: 4_000, provider: "p", model: "m" };
	expect(diagnoseCache(reply(), undefined, true, undefined)).toEqual({ prompt: 5_000, missed: 0, extraCost: 0 });
	expect(diagnoseCache(reply(), previous, true, undefined)).toMatchObject({ missed: 4_000, cause: "unknown", extraCost: null });
	expect(diagnoseCache(reply({ segments: 3 }), previous, true, undefined)).toMatchObject({ cause: "provider" });
	expect(diagnoseCache(reply({ segments: 3, change: { segment: "params", before: 1, after: 2 } }), previous, true, undefined)).toMatchObject({
		cause: "unknown",
	});
	expect(diagnoseCache(reply({ segments: 3, change: { segment: "system", before: 1, after: 2 } }), previous, true, undefined)).toMatchObject({
		cause: "prompt",
	});
	expect(diagnoseCache(reply({ segments: 3 }), previous, false, undefined)).toMatchObject({ missed: 0 });
	// 写了缓存就是报过：读不到算未命中。
	expect(diagnoseCache(reply({ segments: 3 }, 1_000), previous, false, undefined)).toMatchObject({ missed: 4_000, cause: "provider" });
	expect(diagnoseCache(reply(), { ...previous, model: "n" }, false, undefined)).toMatchObject({ cause: "model" });
});
