/**
 * 一条工具结果按总量量，剪完也要落在总量以内。MCP 工具一次回好几块文字：每块单独对着整条线量，十块八千字的（八万字）一字不动就过去了。
 */

import { expect, it } from "vitest";
import type { Message, ToolResultMessage } from "@plume/contract";
import { freshView, PRUNE_THRESHOLD_CHARS, pruneToolResults } from "../src/prune.ts";

function result(...texts: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "mcp",
		content: texts.map((text) => ({ type: "text" as const, text })),
		isError: false,
		timestamp: 0,
	};
}

const size = (message: Message) => message.content.reduce((sum, block) => sum + (block.type === "text" ? [...block.text].length : 0), 0);
const textAt = (message: Message | undefined, index: number) => (message!.content[index] as { text: string }).text;

it("十块各自不到线的文字，合在一起照样剪到线以内", () => {
	const message = result(...Array.from({ length: 10 }, (_, i) => String(i).repeat(8000)));
	const [cut] = pruneToolResults([message]);
	expect(cut).not.toBe(message);
	expect(size(cut!)).toBeLessThanOrEqual(PRUNE_THRESHOLD_CHARS);
	expect(cut!.content).toHaveLength(10);
	for (let i = 0; i < 10; i++) {
		const text = textAt(cut, i);
		expect(text.startsWith(String(i)) && text.endsWith(String(i))).toBe(true);
	}
	expect(pruneToolResults([cut!])[0]).toBe(cut);
});

it("挨着大块的小块原样留着", () => {
	const small = "s".repeat(600);
	const huge = "h".repeat(60_000);
	const [cut] = pruneToolResults([result(small, huge)]);
	expect(textAt(cut, 0)).toBe(small);
	const [alone] = pruneToolResults([result(huge)]);
	expect(textAt(cut, 1)).toBe(textAt(alone, 0));
	expect(size(cut!)).toBeLessThanOrEqual(PRUNE_THRESHOLD_CHARS);
});

it("只存被剪的块，存的是原文", () => {
	const kept: string[] = [];
	const sink = { keep: (_tool: string, content: string) => (kept.push(content), `artifact://a${kept.length}`) };
	const big = ["a".repeat(20_000), "b".repeat(20_000)];
	const [cut] = pruneToolResults([result("s".repeat(300), ...big)], undefined, sink);
	expect(kept).toEqual(big);
	expect(textAt(cut, 1)).toMatch(/artifact:\/\/a1/);
	expect(textAt(cut, 2)).toMatch(/artifact:\/\/a2/);
	expect(size(cut!)).toBeLessThanOrEqual(PRUNE_THRESHOLD_CHARS);
});

it("块多到每块带不起一个标记时合成一块剪", () => {
	const kept: string[] = [];
	const sink = { keep: (_tool: string, content: string) => (kept.push(content), `artifact://a${kept.length}`) };
	const [cut] = pruneToolResults([result(...Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(8000)}`))], undefined, sink);
	expect(size(cut!)).toBeLessThanOrEqual(PRUNE_THRESHOLD_CHARS);
	expect(kept).toHaveLength(1);
	expect(kept[0]!.startsWith("0:") && kept[0]!.includes("99:")).toBe(true);
	expect(pruneToolResults([cut!])[0]).toBe(cut);
});

it("发送路径上的剪法只看结果本身：同一条每次剪出同一份，技能正文不剪", () => {
	const sink = { keep: (_tool: string, content: string) => `artifact://${content.length}` };
	const huge = result("z".repeat(50_000));
	const [first] = freshView([huge], sink);
	const [again] = freshView([structuredClone(huge)], sink);
	expect(first).not.toBe(huge);
	expect(again).toEqual(first);
	expect(freshView([first!], sink)[0]).toBe(first);
	const skill: Message = { ...huge, toolName: "skill" };
	expect(freshView([skill], sink)[0]).toBe(skill);
	// 没到线的整条照发。
	const normal = result("n".repeat(30_000));
	expect(freshView([normal], sink)[0]).toBe(normal);
});
