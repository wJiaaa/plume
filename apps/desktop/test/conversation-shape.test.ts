/**
 * 转录的形状：消息怎么切成行、行怎么按回合分块、一段段活怎么合、跑完收起哪几行。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Hiccup, Message } from "@plume/contract";
import { runKey, runs } from "../src/renderer/conversation/grouping.ts";
import { isShellRead } from "../src/renderer/conversation/shell-reads.ts";
import { foldPolls, pollOutput, turnBlocks, withoutThinking } from "../src/renderer/conversation/turn-blocks.ts";
import { moodFor } from "../src/renderer/conversation/thinking-words.ts";
import { addToolLine, removeToolLines } from "../src/renderer/conversation/tool-lines.ts";
import { restated } from "../src/renderer/conversation/reply-segments.ts";
import { CARRY_ON_PROMPTS, carryOnPrompt, howItStopped, isPlanTick, unfinishedTodos } from "../src/renderer/conversation/turn-stop.ts";
import { liveTurnMeter, resumesTurn } from "../src/renderer/conversation/turns.ts";

const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}): Message =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra }) as Message;

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse", timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		timestamp,
		api: "openai-completions",
		provider: "p",
		model: "m",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as AssistantMessage;
}

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall" as const, id, name, arguments: args });
const result = (id: string, name: string): Message =>
	({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 }) as Message;
const thinking = (text: string) => ({ type: "thinking" as const, thinking: text });

/**
 * 假装装了记清单、连 MCP 服务的插件：本体不认它们的工具名，只认它们在界面入口登记的说法（`ui.toolLine`）。
 * 跑完撤下，别的测试看到的是没装它们的样子。
 */
function withPluginLines(body: () => void): void {
	addToolLine("example.todo", "todo_write", { verb: "更新清单", checklist: true });
	addToolLine("example.mcp", "mcp__", { group: "mcp", apart: true }, "prefix");
	try {
		body();
	} finally {
		removeToolLines("example.todo");
		removeToolLines("example.mcp");
	}
}
const text = (value: string) => ({ type: "text" as const, text: value });

test("先后几条回复里同类的调用合成一段活，推理落在它后面那段里，回答单独一行", () => {
	const messages: Message[] = [
		user("改一下"),
		reply([thinking("先看看"), call("a", "read", { path: "a.ts" })]),
		result("a", "read"),
		reply([call("b", "bash", { command: "rg foo src" })]),
		result("b", "bash"),
		reply([thinking("改它"), call("c", "edit", { path: "a.ts" })]),
		result("c", "edit"),
		reply([text("改好了")], "stop"),
	];
	const blocks = turnBlocks(runs(messages));
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["plain", "work"],
	);
	const items = blocks[1]!.items;
	assert.deepEqual(
		items.map((item) => item.kind),
		["step", "run"],
	);
	const step = items[0]!.kind === "step" ? items[0]!.step : undefined;
	assert.deepEqual(
		step?.calls.map((one) => one.block.id),
		["a", "b", "c"],
	);
	assert.deepEqual(
		step?.members.map((member) => member.kind),
		["thinking", "call", "call", "thinking", "call"],
	);
});

test("话把两段活分开；终端以外的工具只和同一种合", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "read")]),
		result("a", "read"),
		reply([text("读完了，接着搜"), call("b", "grep")]),
		result("b", "grep"),
		reply([call("c", "plugin_tool")]),
		result("c", "plugin_tool"),
		reply([text("好了")], "stop"),
	];
	const items = turnBlocks(runs(messages))[1]!.items;
	assert.deepEqual(
		items.map((item) => (item.kind === "step" ? `step:${item.step.calls.map((one) => one.block.id).join("")}` : item.run.kind)),
		["step:a", "message", "step:b", "step:c", "message"],
	);
});

test("插件自己画卡的调用单独一行，不并进前后的活", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("t", "todo_write"), call("a", "read"), call("b", "read")]),
		result("t", "todo_write"),
		result("a", "read"),
		result("b", "read"),
		reply([text("done")], "stop"),
	];
	const list = runs(messages, { ownCard: (block) => block.name === "todo_write" });
	assert.deepEqual(
		list.map((run) => (run.kind === "tools" ? `tools${run.own ? "!" : ""}:${run.calls.length}` : run.kind)),
		["message", "tools!:1", "tools:2", "message"],
	);
	const items = turnBlocks(list)[1]!.items;
	assert.deepEqual(
		items.map((item) => item.kind),
		["run", "step", "run"],
	);
});

test("同一个工具的调用逐次判断单独一行：只画一行的那几次照常并进一段活", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "edit"), call("b", "preview", { check: true }), call("c", "preview", { check: true }), call("d", "preview")]),
		reply([text("done")], "stop"),
	];
	const list = runs(messages, { ownCard: (block) => block.name === "preview" && block.arguments.check !== true });
	assert.deepEqual(
		list.map((run) => (run.kind === "tools" ? `tools${run.own ? "!" : ""}:${run.calls.map((one) => one.block.id).join("")}` : run.kind)),
		["message", "tools:abc", "tools!:d", "message"],
	);
});

test("界面替人说的「继续」不开新的一轮，也不切开两边的活", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "read")], "aborted"),
		user("继续", { synthetic: true }),
		reply([call("b", "read")]),
		result("b", "read"),
		reply([text("done")], "stop"),
	];
	const blocks = turnBlocks(runs(messages));
	assert.equal(blocks.length, 2);
	const items = blocks[1]!.items;
	assert.equal(items[0]?.kind === "step" ? items[0].step.calls.length : 0, 2);
});

test("刚发出、还什么都没回的一轮先占住 work 的位置", () => {
	const blocks = turnBlocks(runs([user("hi")]), true);
	assert.deepEqual(
		blocks.map((block) => block.kind),
		["plain", "work"],
	);
	assert.equal(blocks[1]!.items.length, 0);
});

test("命令还在生成的 bash 先不画；推理不显示时只想不做的一轮就是一句回答", () => {
	const pending = runs([user("go"), reply([call("a", "bash")], "pending")]);
	assert.equal(turnBlocks(pending, true)[1]!.items.length, 0);

	const thought: Message[] = [user("go"), reply([thinking("hmm"), text("答案")], "stop")];
	const hidden = withoutThinking(runs(thought));
	assert.deepEqual(
		hidden.map((run) => run.kind),
		["message", "message"],
	);
});

test("连接岔子按发生时的消息条数插进去，数到末尾的排在写着的回复后面", () => {
	const hiccup = (id: string, at: number): Hiccup => ({
		id,
		at,
		attempts: 1,
		until: 0,
		summary: "",
		kind: "network",
		fingerprint: "",
		repeated: 1,
		outcome: "recovered",
	});
	const messages: Message[] = [user("go"), reply([text("a")], "stop"), reply([text("b")], "pending", 9)];
	const list = runs(messages, { settledCount: 2, hiccups: [hiccup("h1", 1), hiccup("h2", 2)] });
	assert.deepEqual(list.map(runKey), ["user-1-0", "hiccup-h1", "assistant-2-1", "assistant-9-2", "hiccup-h2"]);
});

test("插件登记了像 read 的工具并进探索那一段；撤下后回到自成一类", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "read"), call("b", "symbol", { name: "runAgent" }), call("c", "grep")]),
		result("a", "read"),
		result("b", "symbol"),
		result("c", "grep"),
		reply([text("好了")], "stop"),
	];
	const steps = () =>
		turnBlocks(runs(messages))[1]!.items.map((item) => (item.kind === "step" ? item.step.calls.map((one) => one.block.id).join("") : item.run.kind));
	addToolLine("example.index", "symbol", { verb: "查找符号", like: "read" });
	try {
		assert.deepEqual(steps(), ["abc", "message"]);
		assert.equal(moodFor("symbol", undefined), "listening");
	} finally {
		removeToolLines("example.index");
	}
	assert.deepEqual(steps(), ["a", "b", "c", "message"]);
	assert.equal(moodFor("symbol", undefined), "breathing");
});

test("插件起名的一类活自己合成一段，也和读、改文件接成一段；撤下后各自成一类", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "read", { path: "a.html" })]),
		result("a", "read"),
		reply([thinking("看看页面"), call("b", "browser_viewport")]),
		result("b", "browser_viewport"),
		reply([thinking("点一下"), call("c", "browser_act")]),
		result("c", "browser_act"),
		reply([call("d", "browser_screenshot")]),
		result("d", "browser_screenshot"),
		reply([call("e", "edit", { path: "a.html" })]),
		result("e", "edit"),
		reply([text("好了")], "stop"),
	];
	const steps = () =>
		turnBlocks(runs(messages))[1]!.items.map((item) => (item.kind === "step" ? item.step.calls.map((one) => one.block.id).join("") : item.run.kind));
	for (const tool of ["browser_viewport", "browser_act", "browser_screenshot"]) addToolLine("example.browser", tool, { verb: tool, group: "browser" });
	try {
		assert.deepEqual(steps(), ["abcde", "message"]);
	} finally {
		removeToolLines("example.browser");
	}
	assert.deepEqual(steps(), ["a", "b", "c", "d", "e", "message"]);
});

test("只读的 shell 命令归探索，串起来的每一段都要是读", () => {
	assert.equal(isShellRead("cd src && rg 'a|b' . | head -20"), true);
	assert.equal(isShellRead("sed -n 1,80p a.ts"), true);
	assert.equal(isShellRead("sed -i s/a/b/ a.ts"), false);
	assert.equal(isShellRead("pnpm test | tail"), false);
	assert.equal(isShellRead("cat a > b"), false);
	assert.equal(isShellRead("git log --oneline 2>&1"), true);
});

test("这一轮的表从人开口算起，停下等人的那段不算", () => {
	const messages: Message[] = [
		user("go", { timestamp: 1000 } as never),
		{ ...reply([text("x")], "aborted", 1000), durationMs: 2000 } as Message,
		user("继续", { synthetic: true, timestamp: 60_000 } as never),
		{ ...reply([text("y")], "pending", 60_000) } as Message,
	];
	const meter = liveTurnMeter(messages);
	// 第一段 1000→3000 记 2 秒，第二段从 60_000 起：起点等于 60_000 - 2000。
	assert.equal(meter?.startedAt, 58_000);
	assert.equal(meter?.tokens, 15);
});

type MessageRun = Extract<ReturnType<typeof runs>[number], { kind: "message" }>;
const messageRuns = (list: ReturnType<typeof runs>) => list.filter((run): run is MessageRun => run.kind === "message");

test("页脚只落在一轮最后一条落定的回复上，账是整轮的；还在跑的那一轮先标 newest", () => {
	const messages: Message[] = [
		user("go", { timestamp: 1000 } as never),
		{ ...reply([text("先读"), call("a", "read")], "toolUse", 1000), durationMs: 500 } as Message,
		{ ...result("a", "read"), timestamp: 4000 } as Message,
		{ ...reply([text("读完了")], "stop", 4000), durationMs: 1000, sseDurationMs: 800 } as Message,
		user("再来", { timestamp: 10_000 } as never),
		reply([text("好")], "stop", 10_000),
	];
	const rows = messageRuns(runs(messages));
	const closes = rows.filter((run) => run.closes).map((run) => run.index);
	assert.deepEqual(closes, [3, 5]);
	assert.equal(rows.find((run) => run.index === 5)?.newest, true);
	const stats = rows.find((run) => run.index === 3)?.turnStats;
	// 墙钟：从人开口（1000）到收尾那条写完（4000 + 1000）；请求只算两条回复。
	assert.equal(stats?.durationMs, 4000);
	assert.equal(stats?.requestMs, 1500);
	assert.equal(stats?.requestCount, 2);
	assert.equal(stats?.outputTokens, 10);
});

test("收尾那句后面还跟着这一轮的调用时，页脚单独成一行接在最后", () => {
	const messages: Message[] = [user("go"), reply([text("我先停在这"), call("a", "read")], "aborted")];
	const list = runs(messages);
	assert.deepEqual(
		list.map((run) => run.kind),
		["message", "message", "tools", "message"],
	);
	const trailer = list[3] as MessageRun;
	assert.equal(trailer.trailer, true);
	assert.equal(trailer.closes, true);
	assert.equal((list[1] as MessageRun).closes, undefined);
});

test("一轮中间说完的一句后面插进送达时标 pauses，有自己的页脚；后面跟着调用、页脚另起一行时不留", () => {
	const delivery = (id: string) => user("", { synthetic: true, delivery: [{ id, plugin: "plume.subagents", title: "看看", status: "done" }] } as never);
	const messages: Message[] = [
		user("go"),
		reply([text("派出去了"), call("a", "task")]),
		result("a", "task"),
		reply([text("等它回来")], "stop"),
		delivery("t1"),
		reply([text("回来了")], "stop"),
	];
	const rows = messageRuns(runs(messages));
	assert.deepEqual(
		rows.filter((run) => run.pauses).map((run) => run.index),
		[3],
	);
	assert.deepEqual(
		rows.filter((run) => run.closes).map((run) => run.index),
		[5],
	);
	// 送达前一行是调用、不是话：没有说完的那一句。
	const afterCall = messageRuns(runs([user("go"), reply([text("派出去了"), call("a", "task")]), result("a", "task"), delivery("t2")]));
	assert.equal(
		afterCall.some((run) => run.pauses),
		false,
	);
	// 那句话后面还跟着这一轮的调用、页脚搬到最后时，话底下不再留一份。
	const moved = runs([user("go"), reply([text("等它回来")], "stop"), delivery("t3"), reply([call("b", "read")], "aborted")]);
	assert.equal(
		messageRuns(moved).some((run) => run.pauses),
		false,
	);
	assert.equal((moved.at(-1) as MessageRun).trailer, true);
});

test("换了模型落一条分隔：两轮之间的在开口那句上面，一轮当中的在第一条新回复上面", () => {
	const other = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") =>
		({ ...reply(content, stopReason), model: "n" }) as AssistantMessage;
	const between = runs([user("a"), reply([text("1")], "stop"), user("b"), other([text("2")])]);
	assert.deepEqual(
		between.map((run) => run.kind),
		["message", "message", "model", "message", "message"],
	);
	const within = runs([user("a"), reply([call("x", "read")]), result("x", "read"), other([text("2")])]);
	assert.deepEqual(
		within.map((run) => run.kind),
		["message", "tools", "model", "message"],
	);
	assert.deepEqual(
		runs([user("a"), reply([text("1")], "stop"), user("b"), reply([text("2")], "stop")]).map((run) => run.kind),
		["message", "message", "message", "message"],
	);
});

test("人自己打的「继续」接在停下的那一轮上；上一轮正常答完了再打就是新的一轮", () => {
	const again = user(CARRY_ON_PROMPTS[0]);
	assert.equal(resumesTurn([user("go"), reply([text("x")], "aborted"), again], 2), true);
	assert.equal(resumesTurn([user("go"), reply([text("x")], "stop"), again], 2), false);
	const rows = messageRuns(runs([user("go"), reply([text("x")], "aborted"), again, reply([text("y")], "stop")]));
	assert.equal(rows.find((run) => run.index === 3)?.turnStats?.startIndex, 0);
});

test("最终答复重说过的播报不再画；没有最终答复时播报留着", () => {
	const commentary = { type: "text" as const, text: "我先看看", phase: "commentary" as const };
	const answer = { type: "text" as const, text: "我先看看。结论是……", phase: "final_answer" as const };
	assert.equal(restated(commentary, [commentary, answer]), true);
	assert.equal(restated(commentary, [commentary, { ...answer, text: "" }]), false);
	assert.equal(restated(answer, [commentary, answer]), false);
});

test("回答之后补勾清单的那一次不画，停在它上面也不算被打断；补勾后接着干活的照常画", () => {
	withPluginLines(planTick);
});

function planTick() {
	const messages: Message[] = [
		user("改一下"),
		reply([call("t1", "todo_write"), call("e", "edit", { path: "a.ts" })]),
		result("t1", "todo_write"),
		result("e", "edit"),
		reply([text("改好了")], "stop"),
		user("（自动提示）任务清单里还有 1 项没勾", { synthetic: true }),
		reply([call("t2", "todo_write")]),
		result("t2", "todo_write"),
	];
	assert.equal(isPlanTick(messages, 6), true);
	const rows = runs(messages);
	assert.equal(
		rows.some((row) => row.kind === "tools" && row.calls.some((one) => one.block.id === "t2")),
		false,
	);
	// 没有停止记录时只能看转录：最后是工具结果，可回答在前面已经说完了。
	assert.equal(howItStopped({ id: "s", title: "", cwd: "/", createdAt: 0, updatedAt: 0, running: false }, messages), null);

	// 补勾之后接着干了活：那次 todo_write 是新一段工作的开头。
	const more = [...messages, reply([call("e2", "edit", { path: "b.ts" })]), result("e2", "edit")];
	assert.equal(isPlanTick(more, 6), false);
	// 前面没有那句替人说的话：真是勾完清单正要回答时断了。
	const cut = [messages[0]!, reply([call("t3", "todo_write")]), result("t3", "todo_write")];
	assert.equal(howItStopped({ id: "s", title: "", cwd: "/", createdAt: 0, updatedAt: 0, running: false }, cut), "interrupt");
}

test("没有插件说它记清单的工具，叫 todo_write 也只是一次普通调用", () => {
	const messages: Message[] = [
		user("改一下"),
		reply([text("改好了")], "stop"),
		user("（自动提示）", { synthetic: true }),
		reply([call("t", "todo_write")]),
		result("t", "todo_write"),
	];
	assert.equal(isPlanTick(messages, 3), false);
});

test("一轮正常收尾、最新那份清单（结果里声明的 checklist）还有没勾的：「继续」说把清单做完；停在半路时照旧按怎么停的说", () => {
	const todos = (id: string, statuses: string[], isError = false): Message =>
		({
			role: "toolResult",
			toolCallId: id,
			toolName: "todo_write",
			content: [{ type: "text", text: "ok" }],
			details: { checklist: statuses.map((status, index) => ({ content: `第 ${index + 1} 项`, status })) },
			isError,
			timestamp: 3,
		}) as Message;
	assert.equal(unfinishedTodos([user("改一下"), reply([text("好")], "stop")]), 0);
	// 只算最新一条成功的：后来那次写失败了，前一份清单仍然作数。
	const messages = [user("改一下"), todos("t1", ["completed", "in_progress", "pending"]), todos("t2", ["completed", "completed", "completed"], true)];
	assert.equal(unfinishedTodos(messages), 2);
	assert.equal(unfinishedTodos([...messages, todos("t3", ["completed", "completed", "completed"])]), 0);

	assert.equal(carryOnPrompt(null, 2), CARRY_ON_PROMPTS[2]);
	assert.equal(carryOnPrompt(null, 0), null);
	assert.equal(carryOnPrompt("user", 2), CARRY_ON_PROMPTS[0]);
	assert.equal(carryOnPrompt("interrupt", 2), CARRY_ON_PROMPTS[1]);
});

test("插件说自成一类的工具（MCP 的不分服务器）合成一段，不和别的接；mcp_call 只和自己接", () => {
	withPluginLines(mcpSteps);
});

function mcpSteps() {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "mcp__github__search"), call("b", "mcp__linear__list_issues")]),
		result("a", "mcp__github__search"),
		result("b", "mcp__linear__list_issues"),
		reply([call("c", "mcp__github__get")]),
		result("c", "mcp__github__get"),
		reply([call("d", "mcp_call")]),
		result("d", "mcp_call"),
		reply([call("e", "read")]),
		result("e", "read"),
		reply([call("f", "mcp__github__get")]),
		result("f", "mcp__github__get"),
		reply([text("好了")], "stop"),
	];
	const items = turnBlocks(runs(messages))[1]!.items;
	assert.deepEqual(
		items.map((item) => (item.kind === "step" ? `step:${item.step.calls.map((one) => one.block.id).join("")}` : item.run.kind)),
		["step:abc", "step:d", "step:e", "step:f", "message"],
	);
}

const jobDelivery = (id: string, status: "done" | "failed" = "done") =>
	user("", { synthetic: true, delivery: [{ id, plugin: "plume.tools", title: id, status, inline: true }] } as never);
const describe = (items: ReturnType<typeof turnBlocks>[number]["items"]) =>
	items.map((item) =>
		item.kind === "step"
			? `step:${item.step.members.map((member) => (member.kind === "call" ? member.call.block.id : member.kind)).join(",")}`
			: item.run.kind === "message" && item.run.message.role === "user"
				? `jobs:${(item.run.message.delivery ?? []).map((report) => report.id).join(",")}`
				: item.run.kind,
	);

test("一段读、跑、改的活中间回来的后台命令结果挂在这一段上，不另起一行", () => {
	const messages: Message[] = [
		user("go"),
		reply([call("a", "bash", { command: "npm test", run_in_background: true })]),
		result("a", "bash"),
		reply([call("b", "read", { path: "a.ts" })]),
		result("b", "read"),
		jobDelivery("j1", "failed"),
		reply([call("c", "edit", { path: "a.ts" })]),
		result("c", "edit"),
		reply([text("改好了")], "stop"),
	];
	assert.deepEqual(describe(turnBlocks(runs(messages))[1]!.items), ["step:a,b,delivery,c", "message"]);
});

test("说完话、清单后面、这一轮已经停了时回来的结果自己一行，挨着的几份并成一行", () => {
	// 回答之后才回来：两份挨着，并成一行，key 跟第一份。
	const answered = turnBlocks(
		runs([user("go"), reply([call("a", "bash")]), result("a", "bash"), reply([text("放到后台了")], "stop"), jobDelivery("j1"), jobDelivery("j2")]),
	);
	assert.deepEqual(describe(answered[1]!.items), ["step:a", "message", "jobs:j1,j2"]);
	// 清单那一段不挂：挂上去是不相干的两件事。
	withPluginLines(() => {
		const todo = turnBlocks(runs([user("go"), reply([call("t", "todo_write")]), result("t", "todo_write"), jobDelivery("j3")]));
		assert.deepEqual(describe(todo[1]!.items), ["step:t", "jobs:j3"]);
	});
	// 最后那条回复已经停了（被按停）：结果是把会话叫醒了，不是插在这段活中间。
	const stopped = turnBlocks(runs([user("go"), reply([call("a", "read")], "aborted"), result("a", "read"), jobDelivery("j4")]));
	assert.deepEqual(describe(stopped[1]!.items), ["step:a", "jobs:j4"]);
	// 不标 `inline` 的（子会话交回的结果）不挂：接下来那段话是就着它说的。
	const agent = user("", { synthetic: true, delivery: [{ id: "s1", plugin: "plume.subagents", title: "看看", status: "done" }] } as never);
	const returned = turnBlocks(runs([user("go"), reply([call("a", "read")]), result("a", "read"), agent]));
	assert.deepEqual(describe(returned[1]!.items), ["step:a", "jobs:s1"]);
});

test("连着查同一个后台任务的几次合成一行，隔了别的就不合；停掉的那一次不算查看", () => {
	const poll = (id: string, job: string, extra: Record<string, unknown> = {}) => ({
		kind: "call" as const,
		call: { block: call(id, "bash_output", { id: job, ...extra }), stopReason: "toolUse" as const },
	});
	const lines = foldPolls([poll("a", "j1"), poll("b", "j1"), poll("c", "j1"), poll("d", "j2"), poll("e", "j1"), poll("f", "j1", { kill: true })]);
	assert.deepEqual(
		lines.map((line) => (line.kind === "polls" ? line.calls.map((one) => one.block.id).join("") : line.kind === "call" ? line.call.block.id : line.kind)),
		["abc", "d", "e", "f"],
	);
	assert.equal(pollOutput(["[job j1 running]\nline 1\n", "[job j1 running]\n(no new output)", "[job j1 exited with code 0]\nline 2\n"]), "line 1\nline 2\n");
});
