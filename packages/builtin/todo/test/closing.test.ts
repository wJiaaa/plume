import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	AssistantMessage,
	HookLayer,
	Message,
	ModelContext,
	PluginContext,
	StepEnd,
	StepVerdict,
	ToolCall,
	ToolDefinition,
	ToolOutput,
} from "@plume/contract";
import plugin, { SOLO_TODO_NOTE, stalePlanNote } from "../src/index.ts";
import type { TodoItem } from "../src/types.ts";

/** 只有这个插件用到的那几样 ctx；会话里的消息由测试直接给。 */
function fakeContext() {
	const tools = new Map<string, ToolDefinition>();
	const layers = new Map<string, unknown>();
	let messages: Message[] = [];
	const ctx = {
		name: "plume.todo",
		tools: { register: (tool: ToolDefinition) => void tools.set(tool.name, tool) },
		hook: (name: string, layer: unknown) => void layers.set(name, layer),
		sessions: { messages: async () => messages, onDeleted: () => undefined },
	} as unknown as PluginContext;
	plugin.apply(ctx);

	const contextLayer = layers.get("model.context") as HookLayer<"model.context">;
	const stepLayer = layers.get("step.end") as HookLayer<"step.end">;
	/** 发一次请求：模型拿不拿得到 todo_write 由这里定。 */
	const request = (offered: string[]) =>
		contextLayer(
			{
				sessionId: "s",
				cwd: "/w",
				model: { id: "m", name: "m" },
				personalization: { customInstructions: "", tone: "professional" },
				systemPrompt: "",
				sections: [],
				messages: [],
				tools: offered.map((name) => ({ name, description: name, parameters: {} })),
			} as ModelContext,
			async (context) => context,
		);
	/** 跑 todo_write，`calls` 是同一步回复里的全部调用。 */
	const write = async (todos: TodoItem[], calls: ToolCall[]) => {
		const output = (await (tools.get("todo_write") as ToolDefinition).execute(
			{ todos },
			{
				sessionId: "s",
				cwd: "/w",
				signal: new AbortController().signal,
				progress: () => {},
				ask: async () => "once",
				permissionMode: async () => "ask",
				tools: () => [],
				calls,
			},
		)) as ToolOutput;
		messages = [
			...messages,
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "todo_write",
				content: [{ type: "text", text: output.output }],
				details: output.details,
				isError: false,
				timestamp: 0,
			} as Message,
		];
		return output;
	};
	/** 一步收尾：`natural` 是里层的结论（没调工具时是完成）。 */
	const end = (step: number, reply: AssistantMessage, natural: StepVerdict | ((input: StepEnd) => StepVerdict) = { continue: false }) =>
		stepLayer({ sessionId: "s", cwd: "/w", step, stepsLeft: 10, reply, toolResults: [], signal: new AbortController().signal } as StepEnd, async (input) =>
			typeof natural === "function" ? natural(input) : natural,
		);
	return { request, write, end };
}

const reply = (text: string, calls: string[] = []): AssistantMessage =>
	({
		role: "assistant",
		content: [...(text ? [{ type: "text", text }] : []), ...calls.map((name, index) => ({ type: "toolCall", id: `c${index}`, name, arguments: {} }))],
		stopReason: calls.length > 0 ? "toolUse" : "stop",
	}) as unknown as AssistantMessage;
const call = (name: string): ToolCall => ({ id: name, name, args: {} });
const open: TodoItem[] = [
	{ content: "读代码", status: "completed" },
	{ content: "改代码", status: "in_progress" },
];

test("干了活、回答完清单还有一项在做：问一次；只勾了清单就结束这一轮", async () => {
	const { request, write, end } = fakeContext();
	await request(["read", "edit", "todo_write"]);
	await write(open, [call("todo_write"), call("edit")]);
	await end(1, reply("先改", ["todo_write", "edit"]), { continue: true });
	const asked = await end(2, reply("改好了。"));
	assert.equal(asked.continue, true);
	assert.match(asked.continue ? (asked.say ?? "") : "", /任务清单里还有 1 项没勾[\s\S]*\[in_progress\] 改代码/);
	// 回答追问时只调了 todo_write：结果写完这一轮就结束，不再要正文。
	const ticked = await write(
		[
			{ content: "读代码", status: "completed" },
			{ content: "改代码", status: "completed" },
		],
		[call("todo_write")],
	);
	assert.equal(ticked.terminate, "done");
	// 一轮只问一次。
	assert.deepEqual(await end(3, reply("又说了一遍。")), { continue: false });
});

test("回答追问时顺手干了别的活，照常接着做；一个字没写就当照做了，不再催", async () => {
	const { request, write, end } = fakeContext();
	await request(["edit", "todo_write"]);
	await write(open, [call("todo_write"), call("edit")]);
	await end(1, reply("", ["todo_write", "edit"]), { continue: true });
	await end(2, reply("改好了。"));
	const output = await write(open, [call("todo_write"), call("edit")]);
	assert.equal(output.terminate, undefined);

	const silent = fakeContext();
	await silent.request(["edit", "todo_write"]);
	await silent.write(open, [call("todo_write"), call("edit")]);
	await silent.end(1, reply("", ["todo_write", "edit"]), { continue: true });
	await silent.end(2, reply("改好了。"));
	// 里层要催空回复，这一层直接以完成收场。
	assert.deepEqual(await silent.end(3, reply(""), { continue: true, say: "催一句" }), { continue: false });
});

test("不问的几种：这一轮只动了清单、剩下的都是待做、模型拿不到 todo_write、本来就不收尾", async () => {
	const onlyList = fakeContext();
	await onlyList.request(["todo_write"]);
	await onlyList.write(open, [call("todo_write")]);
	await onlyList.end(1, reply("", ["todo_write"]), { continue: true });
	assert.deepEqual(await onlyList.end(2, reply("好的。")), { continue: false });

	const pending = fakeContext();
	await pending.request(["edit", "todo_write"]);
	await pending.write([{ content: "改代码", status: "pending" }], [call("todo_write"), call("edit")]);
	await pending.end(1, reply("", ["todo_write", "edit"]), { continue: true });
	assert.deepEqual(await pending.end(2, reply("要不要改？")), { continue: false });

	const hidden = fakeContext();
	await hidden.request(["edit"]);
	await hidden.write(open, [call("todo_write"), call("edit")]);
	await hidden.end(1, reply("", ["todo_write", "edit"]), { continue: true });
	assert.deepEqual(await hidden.end(2, reply("改好了。")), { continue: false });

	const failing = fakeContext();
	await failing.request(["edit", "todo_write"]);
	await failing.write(open, [call("todo_write"), call("edit")]);
	await failing.end(1, reply("", ["todo_write", "edit"]), { continue: true });
	assert.deepEqual(await failing.end(2, reply("出错了"), { continue: false, reason: "error", error: "x" }), { continue: false, reason: "error", error: "x" });
});

test("todo_write 只收三种状态、最多一项在做", async () => {
	const { write } = fakeContext();
	assert.equal((await write([{ content: "a", status: "doing" as never }], [call("todo_write")])).isError, true);
	assert.equal(
		(
			await write(
				[
					{ content: "a", status: "in_progress" },
					{ content: "b", status: "in_progress" },
				],
				[call("todo_write")],
			)
		).isError,
		true,
	);
	const ok = await write(open, [call("todo_write")]);
	assert.equal(ok.output, "Task list updated (1/2 done):\n[x] 读代码\n[~] 改代码");
	assert.deepEqual(ok.details, { kind: "todo", todos: open });
});

test("单独调一次 todo_write：结果末尾说一句；和别的调用一起、只有它一个工具、回答追问时都不说", async () => {
	const { request, write, end } = fakeContext();
	await request(["edit", "todo_write"]);
	assert.ok((await write(open, [call("todo_write")])).output.endsWith(`\n\n${SOLO_TODO_NOTE}`));
	assert.ok(!(await write(open, [call("todo_write"), call("edit")])).output.includes(SOLO_TODO_NOTE));
	await end(1, reply("", ["todo_write", "edit"]), { continue: true });
	await end(2, reply("改好了。"));
	const ticked = await write(open, [call("todo_write")]);
	assert.equal(ticked.terminate, "done");
	assert.ok(!ticked.output.includes(SOLO_TODO_NOTE));

	const alone = fakeContext();
	await alone.request(["todo_write"]);
	assert.ok(!(await alone.write(open, [call("todo_write")])).output.includes(SOLO_TODO_NOTE));
});

test("有未完清单时向循环提供汇报规则；清单更新清零，没清单时保留正文汇报规则", async () => {
	const { request, write, end } = fakeContext();
	await request(["read", "todo_write"]);
	await write(open, [call("todo_write"), call("read")]);
	const progress: StepEnd["progress"][] = [];
	const natural = (input: StepEnd): StepVerdict => {
		progress.push(input.progress);
		return { continue: true, say: "别打转" };
	};
	assert.deepEqual(await end(1, reply("先做", ["todo_write", "read"]), natural), { continue: true, say: "别打转" });
	await end(2, reply("正在读", ["read"]), natural);
	assert.deepEqual(progress, [
		{ reported: true, reminder: stalePlanNote(open) },
		{ reported: false, reminder: stalePlanNote(open) },
	]);
	assert.match(stalePlanNote(open), /1\. \[completed\] 读代码\n2\. \[in_progress\] 改代码/);

	await write([{ content: "读代码", status: "completed" }], [call("todo_write")]);
	await end(3, reply("", ["todo_write"]), natural);
	assert.equal(progress.at(-1)?.reported, true);
	await end(4, reply("", ["read"]), natural);
	assert.equal(progress.at(-1), undefined);

	await write(open, [call("todo_write")]);
	await request(["read"]);
	await end(5, reply("", ["read"]), natural);
	assert.equal(progress.at(-1), undefined, "拿不到 todo_write 时不让旧清单影响本体的汇报规则");
});
