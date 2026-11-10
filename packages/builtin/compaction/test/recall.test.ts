/**
 * 把压缩移出窗口的东西读回来。整个压缩设计靠的就是这一点：历史离开窗口，不离开会话。
 */

import { expect, it } from "vitest";
import type { AssistantMessage, Message, ToolOutput, ToolRun } from "@plume/contract";
import { recallTool } from "../src/recall.ts";
import { reply, say, user } from "./helpers.ts";

const run = (sessionId = "s"): ToolRun =>
	({
		sessionId,
		cwd: "/repo",
		scratchDir: "/tmp/scratch",
		signal: new AbortController().signal,
		progress: () => undefined,
		ask: async () => "allow",
		permissionMode: async () => "ask",
		tools: () => [],
		calls: [],
	}) as unknown as ToolRun;

/** 一份转录：人说的话依次是 `texts`，每句后面一句「好」。 */
const transcript = (...texts: string[]): Message[] => texts.flatMap((text) => [user(text), say("好")]);

async function recall(messages: Message[] | null, args: Record<string, unknown>): Promise<ToolOutput> {
	const tool = recallTool(async () => {
		if (!messages) throw new Error("没有这个会话");
		return messages;
	});
	return tool.execute(args, run());
}

const quotedBody = (answer: string) => answer.split(/^--- message .*---\n/m)[1]!.split(/\n\n\[/)[0]!;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

it("压缩移出窗口的东西在会话里照样找得到", async () => {
	const messages = [user("口令是蓝色鲸鱼，最后要用到"), ...transcript(...Array.from({ length: 40 }, (_, i) => `第 ${i} 步 ${"x".repeat(500)}`))];
	const { output } = await recall(messages, { query: "蓝色鲸鱼" });
	expect(output).toMatch(/^1 match /);
	expect(output).toContain("口令是蓝色鲸鱼");
	expect(output).toMatch(/--- message 0 · user · /);
});

it("每个词都要出现：多一个词是收窄，不是放宽", async () => {
	const messages = transcript("先看 alpha 的实现", "再看 alpha 和 beta 一起用的地方");
	expect((await recall(messages, { query: "alpha" })).output).toMatch(/^2 matches/);
	const narrow = (await recall(messages, { query: "alpha beta" })).output;
	expect(narrow).toMatch(/^1 match /);
	expect(narrow).toContain("一起用的地方");
});

it("什么都没搜到就说没搜到，不装成出错", async () => {
	const result = await recall(transcript("随便说点什么"), { query: "根本没提过的东西" });
	expect(result.isError).toBeFalsy();
	expect(result.output).toMatch(/No message in this session contains/);
});

it("长消息引头和尾，不整条引", async () => {
	const long = `开头标记 ${"填充".repeat(3000)} 结尾标记`;
	const { output } = await recall(transcript(long), { query: "开头标记" });
	expect(output).toContain("开头标记");
	expect(output).toContain("结尾标记");
	expect(output).toMatch(/characters omitted/);
	expect([...output].length).toBeLessThan([...long].length / 2);
});

it("长消息中段的匹配就在匹配的地方引出来", async () => {
	const rule = "审核标记：只有先备份才允许覆盖原文件。";
	const long = `开头说明这是一份长需求。${"前文".repeat(1000)}${rule}${"后文".repeat(1000)}结尾`;
	const { output } = await recall(transcript(long), { query: "审核标记" });
	expect(output).toMatch(/^1 match /);
	expect(output).toContain(rule);
	expect(output).toContain("开头说明这是一份长需求");
	expect(output).toMatch(/characters omitted/);
	expect([...quotedBody(output)].length).toBeLessThan(1400);
});

it("一条消息里隔得很远的几个词各自在原处引出来", async () => {
	const first = "甲约束：接口只读。";
	const second = "乙约束：日志保留七天。";
	const long = `${"填充".repeat(600)}${first}${"填充".repeat(800)}${second}${"填充".repeat(600)}`;
	const { output } = await recall(transcript(long), { query: "甲约束 乙约束" });
	expect(output).toContain(first);
	expect(output).toContain(second);
	expect(output.indexOf(first)).toBeLessThan(output.indexOf(second));
	expect([...quotedBody(output)].length).toBeLessThan(1400);
});

it("完整的头里看得见的匹配，另一个词要在中段开窗时也不丢", async () => {
	const rule = "备份约束：覆盖前先备份。";
	const long = `${"前".repeat(500)}${rule}${"中".repeat(1500)}中段标记${"后".repeat(1500)}`;
	expect((await recall(transcript(long), { query: "备份约束" })).output).toContain(rule);
	const { output } = await recall(transcript(long), { query: "备份约束 中段标记" });
	expect(output).toContain(rule);
	expect(output).toContain("中段标记");
	expect([...quotedBody(output)].length).toBeLessThan(1400);
});

it("匹配本来就在头尾里的，照旧只引头尾", async () => {
	const long = `开头标记 ${"填充".repeat(3000)} 结尾标记`;
	const points = [...long];
	const expected = `${points.slice(0, 900).join("")}\n… [${points.length - 1200} characters omitted] …\n${points.slice(-300).join("")}`;
	expect(quotedBody((await recall(transcript(long), { query: "开头标记" })).output)).toBe(expected);
	expect(quotedBody((await recall(transcript(long), { query: "结尾标记" })).output)).toBe(expected);
});

it("不分大小写的匹配从原文引，不切坏字", async () => {
	const rule = "Backup-Before-Overwrite: never replace a file you have not copied.";
	const long = `${"İ😀".repeat(1500)}${rule}${"😀".repeat(1500)}`;
	const { output } = await recall(transcript(long), { query: "backup-before-overwrite" });
	expect(output).toMatch(/^1 match /);
	expect(output).toContain(rule);
	expect(LONE_SURROGATE.test(output)).toBe(false);
});

it("会话还没存下什么就照实说，不抛错", async () => {
	for (const messages of [null, []]) {
		const result = await recall(messages, { query: "任何东西" });
		expect(result.isError).toBe(true);
		expect(result.output).toMatch(/no saved transcript/);
	}
	expect((await recall(transcript("x"), { query: "  " })).isError).toBe(true);
});

const callRecall = (id: string, query: string): AssistantMessage => reply([{ type: "toolCall", id, name: "recall", arguments: { query } }]);
const recallResult = (id: string, text: string): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "recall",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

it("搜不到自己的调用和结果：匹配数不会每调一次涨两条", async () => {
	const messages: Message[] = [user("记住这个口令：蜂鸟七号。")];
	const counts: number[] = [];
	for (let i = 0; i < 3; i++) {
		const { output } = await recall(messages, { query: "蜂鸟七号" });
		counts.push(Number(/^(\d+) match/.exec(output)?.[1]));
		messages.push(callRecall(`call-${i}`, "蜂鸟七号"), recallResult(`call-${i}`, output));
	}
	expect(counts).toEqual([1, 1, 1]);
	expect((await recall(messages, { query: "蜂鸟七号" })).output).not.toContain('"query"');
});

it("一边回忆一边干活的那条回复，自己说的话照样找得到", async () => {
	const messages: Message[] = [
		user("选哪个方案"),
		reply([
			{ type: "text", text: "我的结论是：走 B 方案。" },
			{ type: "toolCall", id: "mixed-1", name: "recall", arguments: { query: "无关" } },
		]),
		recallResult("mixed-1", "No message"),
	];
	const { output } = await recall(messages, { query: "B 方案" });
	expect(output).toMatch(/^1 match/);
	expect(output).toContain("走 B 方案");
});

it("offset 往回翻页，不再把最新那页答一遍", async () => {
	const messages = transcript(...[1, 2, 3, 4, 5].map((i) => `标记 第${i}条`));
	const first = (await recall(messages, { query: "标记", limit: 2 })).output;
	const second = (await recall(messages, { query: "标记", limit: 2, offset: 2 })).output;
	expect(first).toContain("第5条");
	expect(first).toContain("第4条");
	expect(second).toContain("第3条");
	expect(second).toContain("第2条");
	expect(second).not.toContain("第5条");
});

it("页脚给出下一页的 offset，到头了也说清楚", async () => {
	const messages = transcript(...[1, 2, 3, 4].map((i) => `路标 第${i}条`));
	expect((await recall(messages, { query: "路标", limit: 2 })).output).toMatch(/offset=2/);
	expect((await recall(messages, { query: "路标", limit: 2, offset: 2 })).output).toMatch(/nothing older to page to/);
});

it("翻过最早一条的 offset 照实说，不把同一页再答一遍", async () => {
	const { output } = await recall(transcript("界碑 只有这一条"), { query: "界碑", offset: 99 });
	expect(output).toMatch(/past the oldest/);
	expect(output).not.toContain("只有这一条");
});

it("带图的那条匹配说清图放不回来", async () => {
	const messages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "看这张图 标记图片" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			timestamp: 1,
		},
	];
	const { output } = await recall(messages, { query: "标记图片" });
	expect(output).toMatch(/carried 1 image/);
	expect(output).toMatch(/cannot be replayed/);
	expect(output).toMatch(/ask the user to resend/);
});
