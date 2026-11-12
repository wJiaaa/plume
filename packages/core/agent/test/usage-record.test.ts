import { expect, it } from "vitest";
import type { AssistantMessage } from "@plume/contract";
import { diagnoseCache, estimateParts } from "../src/usage-record.ts";

it("提示词按段名和插件标的类别分到系统、说明与记忆、技能与智能体；没标类别的记忆段算系统；消息按谁说的分，界面替人说的算注入", () => {
	const sections = [
		{ id: "identity", text: "a".repeat(40) },
		{ id: "projectInstructions", text: "b".repeat(80) },
		{ id: "learned", text: "记".repeat(5), category: "memory" as const },
		// 不认段名：没标类别的算系统提示词。
		{ id: "notes", text: "f".repeat(16) },
		{ id: "skills", text: "c".repeat(120) },
		{ id: "subagents", text: "d".repeat(40) },
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
	expect(parts).toEqual({ system: 10 + 4 + 2.5, instructions: 20 + 5, skills: 30 + 10, toolDefs: 0, user: 3, injected: 2, assistant: 0, toolResults: 0 });
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
