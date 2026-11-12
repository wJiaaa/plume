import { expect, it } from "vitest";
import type { AssistantMessage, CompactionMark, Message, SessionSummary, ToolResultMessage, UserMessage } from "@plume/contract";
import { conversationMarkdown } from "../src/conversation-markdown.ts";

const summary: SessionSummary = { id: "a", title: "修登录", cwd: "/work/app", createdAt: 1, updatedAt: 2, running: false, kind: "top" };
const exportedAt = new Date(2026, 10, 5, 14, 5);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, extra: Partial<UserMessage> = {}): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra });
const reply = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "fake",
	model: "one",
	usage,
	stopReason: "stop",
	timestamp: 2,
	...extra,
});
const result = (id: string, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 3,
	...extra,
});
const markdown = (messages: readonly Message[], locale = "zh-CN", compactions: readonly CompactionMark[] = []) =>
	conversationMarkdown({ summary, messages, compactions, exportedAt }, locale);

it("导出正文和工具摘要，不导出思考、普通工具输出和运行时提示，压缩和换模型重新标出说话人", () => {
	const messages: Message[] = [
		user("看一下"),
		reply([
			{ type: "thinking", thinking: "PRIVATE THINKING", signature: "PRIVATE SIGNATURE", encrypted: "PRIVATE PAYLOAD" },
			{ type: "text", text: "先查代码。" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a_b*c.ts" } },
			{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo `date` ```" } },
		]),
		result("c1", "PRIVATE FILE CONTENT"),
		result("c2", "PRIVATE TOOL ERROR", { toolName: "bash", isError: true }),
		reply([{ type: "toolCall", id: "c3", name: "task", arguments: { description: "查调用方", prompt: "PRIVATE PROMPT" } }]),
		result("c3", "已派出", { toolName: "task", details: { detached: true } }),
		user("RUNTIME NUDGE", { synthetic: true }),
		reply([{ type: "text", text: "最终答复" }], { model: "two" }),
	];
	const before = JSON.stringify(messages);
	const compactions = [{ keptFrom: 7, before: 12, after: 4 }];
	const md = markdown(messages, "zh-CN", compactions);
	expect(md).toMatch(/^# 修登录\n\n- 导出时间：2026-11-05 14:05\n- 项目：\/work\/app\n- 模型：fake\/one、fake\/two\n/);
	expect(md).toContain("## 用户\n\n看一下\n\n## 助手\n\n先查代码。");
	// 普通结果不截断调用列表，跨回复的工具摘要仍然相邻。
	expect(md).toContain("- `read` Read src/a\\_b\\*c.ts\n- `bash` echo \\`date\\` \\`\\`\\`（失败）\n- `task` 查调用方");
	expect(md).toContain("*— 上下文在这里压缩过，之前的内容由摘要代替 —*");
	expect(md).toContain("*— 模型已切换 fake/one → fake/two —*\n\n## 助手\n\n最终答复");
	for (const hidden of ["PRIVATE", "RUNTIME NUDGE", "已派出", "<details>", "工具结果"]) expect(md).not.toContain(hidden);
	expect(JSON.stringify(messages)).toBe(before);
	expect(compactions).toEqual([{ keptFrom: 7, before: 12, after: 4 }]);
});

it("附件只列名称和图片序号，不导出正文、路径、媒体地址或像素", () => {
	const message = user("给模型看的扩展提示", {
		displayText: "照着【图片 1】改，参考 report.pdf",
		content: [
			{ type: "text", text: "给模型看的扩展提示" },
			{ type: "image", data: "PRIVATE PIXELS", mimeType: "image/png", media: "parked-image.png" },
			{ type: "image", data: "INLINE PIXELS", mimeType: "image/png" },
			{ type: "text", text: "\n\n### Attached file: report.pdf\nSECRET BODY" },
		],
		attachments: [
			{ name: "machine-name.jpg", kind: "image" },
			{ name: "report.pdf", kind: "document", path: "/not-present/a (1)#?.pdf" },
		],
	});
	const md = markdown([message]);
	expect(md).toContain("照着【图片 1】改，参考 report.pdf\n\n附件：图片 1、report.pdf、图片 2");
	for (const hidden of ["SECRET BODY", "PIXELS", "给模型看的扩展提示", "machine-name", "parked-image", "/not-present", "plume-media:", "!["])
		expect(md).not.toContain(hidden);
	const fallback = markdown([
		user("", {
			content: [
				{ type: "text", text: "人打的字" },
				{ type: "text", text: "\n\n### Attachment 2 of 3, document: x.pdf\nPRIVATE BODY" },
				{ type: "text", text: "\n\n[Attached folder: source — folder at /secret]" },
				{ type: "image", data: "PIXELS", mimeType: "image/png" },
			],
		}),
	]);
	expect(fallback).toContain("人打的字\n\n附件：图片 1");
	expect(fallback).not.toMatch(/PRIVATE BODY|\/secret|PIXELS/);
	expect(
		markdown(
			[
				user("", {
					attachments: [
						{ name: "photo.jpg", mimeType: "image/jpeg" },
						{ name: "a_b*[c].txt", kind: "text" },
					],
				}),
			],
			"en",
		),
	).toContain("Attachments: Image 1, a\\_b\\*\\[c\\].txt");
});

it("普通工具结果的正文、图片和停放图片全部跳过，不凭结果创建助手段落", () => {
	const md = markdown([
		result("c", "PRIVATE OUTPUT", {
			content: [
				{ type: "text", text: "PRIVATE OUTPUT" },
				{ type: "image", data: "PIXELS", mimeType: "image/png", media: "tool.png" },
			],
			details: { private: "PRIVATE", images: [{ type: "image", data: "PARKED PIXELS", mimeType: "image/png", media: "parked.png" }] },
		}),
	]);
	expect(md).toContain("这个会话还没有消息。");
	expect(md).not.toMatch(/PRIVATE|PIXELS|tool\.png|parked\.png|## 助手|plume-media:/);
});

it("跳过 pending 草稿及其模型和工具、重复播报和所有推理，不输出推理占位文案", () => {
	const md = markdown([
		reply(
			[
				{ type: "text", text: "DRAFT" },
				{ type: "toolCall", id: "pending", name: "NEVER CALLED", arguments: {} },
			],
			{ stopReason: "pending", model: "DRAFT MODEL" },
		),
		reply([
			{ type: "thinking", thinking: "REDACTED", redacted: true, encrypted: "ENCRYPTED" },
			{ type: "text", text: "COMMENTARY", phase: "commentary" },
			{ type: "text", text: "答案", phase: "final_answer" },
		]),
	]);
	for (const hidden of ["DRAFT", "NEVER CALLED", "COMMENTARY", "REDACTED", "ENCRYPTED", "思考", "<details>"]) expect(md).not.toContain(hidden);
	expect(md).toContain("## 助手\n\n答案");
	expect(markdown([reply([{ type: "text", text: "唯一的播报", phase: "commentary" }])])).toContain("唯一的播报");
	expect(markdown([reply([{ type: "thinking", thinking: "PRIVATE THINKING" }])])).toContain("这个会话还没有消息。");
});

it("未闭合的正文和同步结论自动合上围栏，不吞掉后面的说话人，已闭合的围栏原样保留", () => {
	const md = markdown([
		user("未完成代码：\n~~~~\n```"),
		reply([{ type: "text", text: "答复\n````md\n```ts\nx" }]),
		result("c", "结论\n```ts\ny", { toolName: "task" }),
		user("结束"),
	]);
	expect(md).toContain("未完成代码：\n~~~~\n```\n~~~~\n\n## 助手");
	expect(md).toContain("答复\n````md\n```ts\nx\n````\n\n> 结论");
	expect(md).toContain("> 结论\n> ```ts\n> y\n> ```\n\n## 用户\n\n结束");
	const closed = "````md\n```ts\nconst x = `x`;\n```\n````";
	expect(markdown([reply([{ type: "text", text: closed }])])).toContain(closed);
	expect(markdown([reply([{ type: "toolCall", id: "c", name: "`tool``", arguments: {} }])])).toContain("- ``` `tool`` ```");
});

it("en 前缀用英文，其余语言用中文，模型显示名由回调给出，空会话仍可导出", () => {
	const md = conversationMarkdown(
		{
			summary: { ...summary, title: "", cwd: "" },
			messages: [reply([{ type: "text", text: "Done" }])],
			compactions: [],
			exportedAt,
			modelLabel: (provider, model) => `Named ${provider}/${model}`,
		},
		"en-GB",
	);
	expect(md).toBe("# Untitled conversation\n\n- Exported: 2026-11-05 14:05\n- Models: Named fake/one\n\n## Assistant\n\nDone\n");
	expect(markdown([], "fr")).toBe("# 修登录\n\n- 导出时间：2026-11-05 14:05\n- 项目：/work/app\n\n这个会话还没有消息。\n");
	expect(markdown([], "EN-us")).toContain("This conversation has no messages yet.");
});

it("技能只显示人发出的命令，标题路径和错误不注入 Markdown 结构", () => {
	const md = conversationMarkdown(
		{
			summary: { ...summary, title: "*title*\n# forged", cwd: "x_y\n## forged" },
			messages: [
				user("Use private skill instructions", { displayText: "", skillRef: { name: "review", pluginId: "tools" } }),
				reply([], { stopReason: "error", errorMessage: "bad_*\nnext" }),
			],
			compactions: [],
			exportedAt,
		},
		"en",
	);
	expect(md).toContain("# \\*title\\* \\# forged");
	expect(md).toContain("Project: x\\_y \\#\\# forged");
	expect(md).toContain("## You\n\n/tools:review\n\n## Assistant");
	expect(md).toContain("*This reply failed: bad\\_\\* next*");
	expect(md).not.toContain("private skill instructions");
});

it("压缩按原始消息下标排序，跳过 synthetic 不改变分隔位置，末尾的压缩也不丢", () => {
	const md = markdown([user("第一条"), user("隐藏", { synthetic: true }), user("第二条")], "en", [
		{ keptFrom: 3, before: 5, after: 2 },
		{ keptFrom: 2, before: 4, after: 2 },
	]);
	expect(md).toContain("第一条\n\n*— Context was compacted here; what came before was replaced by a summary —*\n\n## You\n\n第二条");
	expect(md.match(/Context was compacted/g)).toHaveLength(2);
	expect(md).not.toContain("隐藏");
});

it("同步 task 只引用成功结论，不导出失败结果、后台派发确认和空结论", () => {
	const md = markdown([
		reply([{ type: "toolCall", id: "task", name: "task", arguments: { description: "查调用方", prompt: "PRIVATE PROMPT" } }]),
		result("task", "结论一\n\n- a.ts", { toolName: "task" }),
		result("failed", "PRIVATE FAILURE", { toolName: "task", isError: true }),
		result("detached", "PRIVATE DISPATCH", { toolName: "task", details: { detached: true } }),
		result("empty", "  ", { toolName: "task" }),
	]);
	expect(md).toContain("- `task` 查调用方\n\n> 结论一\n>\n> - a.ts");
	expect(md).not.toMatch(/PRIVATE|工具结果|<details>/);
});

it("异步送达仍引用子智能体结论，运行时包装不当成人说的话", () => {
	const md = markdown([
		user("", {
			synthetic: true,
			delivery: [{ id: "s", agent: "explore", description: "查引用", status: "done" }],
			content: [
				{ type: "text", text: "RUNTIME WRAPPER" },
				{ type: "text", text: '<subagent_result id="s">\n结论二\n\n- b.ts\n</subagent_result>' },
			],
		}),
	]);
	expect(md).toContain("### 子智能体 explore 的结论：查引用\n\n> 结论二\n>\n> - b.ts");
	expect(md).not.toMatch(/RUNTIME WRAPPER|subagent_result|## 用户/);
});

it("插件工具的说法由注册它的插件给（describe），没给时写工具名；本体不认插件的工具名", () => {
	const messages = [
		reply([
			{ type: "toolCall", id: "c1", name: "paint_picture", arguments: { prompt: "a red fox\nin snow" } },
			{ type: "toolCall", id: "c2", name: "other_tool", arguments: {} },
			{ type: "toolCall", id: "c3", name: "read", arguments: { path: "a.ts" } },
		]),
	];
	const plain = markdown(messages, "en");
	expect(plain).toContain("- `paint_picture`\n- `other_tool`\n- `read` Read a.ts");
	const described = conversationMarkdown(
		{ summary, messages, compactions: [], exportedAt, describeTool: (name, args) => (name === "paint_picture" ? `Paint ${String(args.prompt)}` : undefined) },
		"en",
	);
	expect(described).toContain("- `paint_picture` Paint a red fox in snow\n- `other_tool`\n- `read` Read a.ts");
});
