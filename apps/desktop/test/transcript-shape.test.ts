/**
 * 每拍只重算最后一轮的那一版（`transcript-shape.ts`）和从头算的那一版，结果必须逐项相同。
 *
 * 对拍：随机生成一段会话的整个过程——流式回复、并行工具、插话、「继续」、界面替人说的话、插件自己画卡的工具、换模型、压缩、
 * 断线——每一步都同时交给两版，中途随机重读会话（前面的消息全换了对象）、换压缩和连接记录，每一步比一次。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionRun, Hiccup, Message } from "@plume/contract";
import { runs } from "../src/renderer/conversation/grouping.ts";
import { RunsCache, TurnBlocksCache } from "../src/renderer/conversation/transcript-shape.ts";
import { turnBlocks, withoutThinking } from "../src/renderer/conversation/turn-blocks.ts";
import { CARRY_ON_PROMPTS } from "../src/renderer/conversation/turn-stop.ts";

/** 可复现的随机数（mulberry32）。 */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Assistant = Extract<Message, { role: "assistant" }>;
type Block = Assistant["content"][number];

/** 插件自己画卡的工具：单独一行，不并进一段活。 */
const ownCard = (call: { name: string }) => call.name === "note";

interface Session {
	/** 落了盘的消息；`draft` 是还在写的那条回复。 */
	messages: Message[];
	draft: Assistant | undefined;
	hiccups: Hiccup[];
	compactionRuns: CompactionRun[];
	running: boolean;
}

/** 一段会话的整个过程，一步一个快照；每个快照都是新数组，没变的消息沿用原来的对象，和界面的状态一样。 */
function* timeline(seed: number, steps: number): Generator<Session> {
	const rand = random(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
	let clock = 1_700_000_000_000 + seed * 1000;
	const now = () => (clock += Math.floor(rand() * 40 * 60_000));
	let messages: Message[] = [];
	let draft: Assistant | undefined;
	let hiccups: Hiccup[] = [];
	let compactionRuns: CompactionRun[] = [];
	let running = false;
	let call = 0;
	let model = "m1";
	/** 发出去还没有结果的调用。 */
	let open: { id: string; name: string }[] = [];
	const snap = (): Session => ({ messages, draft, hiccups, compactionRuns, running });
	const push = (message: Message) => (messages = [...messages, message]);
	const user = (text: string, extra: Record<string, unknown> = {}): Message =>
		({ role: "user", content: [{ type: "text", text }], timestamp: now(), ...extra }) as Message;
	const toolCall = (): Block => {
		const name = pick(["read", "bash", "bash", "edit", "grep", "todo_write", "note"]);
		const id = `call-${seed}-${call++}`;
		const args: Record<string, unknown> =
			name === "bash"
				? { command: pick(["rg foo", "sed -n 1,5p a.ts", "pnpm test", "git status"]) }
				: name === "todo_write"
					? { todos: [] }
					: { path: `src/${call}.ts` };
		open.push({ id, name });
		return { type: "toolCall", id, name, arguments: args } as Block;
	};
	const reply = (content: Block[]): Assistant =>
		({ role: "assistant", content, stopReason: "pending", timestamp: now(), provider: "p", model, usage }) as Assistant;

	for (let step = 0; step < steps; step++) {
		const roll = rand();
		if (draft) {
			// 流式：长一截，或者收尾落盘。
			const content = draft.content.slice();
			const tail = content[content.length - 1];
			if (rand() < 0.6 && tail && (tail.type === "text" || tail.type === "thinking")) {
				content[content.length - 1] = tail.type === "text" ? { ...tail, text: `${tail.text} 字` } : { ...tail, thinking: `${tail.thinking} 想` };
				draft = { ...draft, content };
			} else if (rand() < 0.3) {
				content.push(rand() < 0.5 ? { type: "text", text: "接着说" } : toolCall());
				draft = { ...draft, content };
			} else {
				const calls = content.some((block) => block.type === "toolCall");
				const stopReason = calls ? "toolUse" : pick(["stop", "stop", "stop", "aborted", "error", "length"] as const);
				push({ ...draft, content, stopReason, durationMs: Math.floor(rand() * 5000) } as Assistant);
				draft = undefined;
				if (!calls) running = false;
			}
		} else if (open.length > 0 && roll < 0.7) {
			// 工具结果，顺序不定；偶尔先插一句话进来，结果后到。
			if (rand() < 0.1) push(user("插一句：顺便看看测试"));
			const done = open.splice(Math.floor(rand() * open.length), 1)[0]!;
			push({
				role: "toolResult",
				toolCallId: done.id,
				toolName: done.name,
				content: [{ type: "text", text: "ok" }],
				isError: rand() < 0.15,
				timestamp: now(),
			} as Message);
			if (open.length === 0) {
				running = true;
				draft = reply([]);
			}
		} else if (roll < 0.05 && messages.length > 2) {
			// 重新读了会话：内容一样，每条都是新对象。
			messages = messages.map((message) => ({ ...message }) as Message);
		} else if (roll < 0.1) {
			// 压缩那一行先是进行中，下一次再换成压完：换对象，和界面收到的事件一样。
			const running = compactionRuns.findIndex((run) => run.status === "running");
			compactionRuns =
				running >= 0
					? compactionRuns.map((run, at) => (at === running ? { ...run, status: "done", code: "done", before: messages.length, after: 2 } : run))
					: [...compactionRuns, { id: `c-${step}`, at: messages.length, startedAt: 0, status: "running", phase: "summarizing", retries: 0 }];
		} else if (roll < 0.15) {
			hiccups = [
				...hiccups,
				{ id: `h-${step}`, at: messages.length, attempts: 1, until: 0, summary: "断了", kind: "network", fingerprint: "x", repeated: 1, outcome: "recovered" },
			];
		} else if (roll < 0.18 && hiccups.length) {
			// 连接记录换了一份（又重试了一次）：换对象，和界面的状态一样。
			const at = Math.floor(rand() * hiccups.length);
			hiccups = hiccups.map((one, index) => (index === at ? { ...one, attempts: one.attempts + 1 } : one));
		} else {
			// 开一轮：人话、「继续」，或者界面替人说的话。
			if (rand() < 0.15) model = pick(["m1", "m2"]);
			const kind = rand();
			const previous = messages.findLast((message) => message.role === "assistant") as Assistant | undefined;
			if (kind < 0.15 && previous && (previous.stopReason === "aborted" || previous.stopReason === "error")) push(user(pick(CARRY_ON_PROMPTS)));
			else if (kind < 0.25) push(user("（自动提示）接着做", { synthetic: true }));
			else push(user(pick(["看看这个", "修一下", "为什么", ""])));
			open = [];
			running = true;
			const first: Block[] = rand() < 0.5 ? [{ type: "thinking", thinking: "想" } as Block] : [];
			draft = reply(first.length ? first : [rand() < 0.5 ? { type: "text", text: "好" } : toolCall()]);
		}
		yield snap();
	}
}

function compare(seed: number, steps: number) {
	const shape = { runs: new RunsCache(), blocks: new TurnBlocksCache() };
	const rand = random(seed ^ 0x5eed);
	let step = 0;
	let revision = 0;
	for (const session of timeline(seed, steps)) {
		step++;
		const { messages, draft, hiccups, compactionRuns, running } = session;
		const all = draft ? [...messages, draft] : messages;
		const options = { settledCount: messages.length, hiccups, compactionRuns, ownCard };
		// 推理画不画、插件的卡片中途都会变，同一份缓存都要对。
		const showThinking = rand() < 0.3;
		if (rand() < 0.03) revision++;
		const where = `seed ${seed} step ${step}`;
		const full = runs(all, options);
		const expectedRuns = showThinking ? full : withoutThinking(full);
		const cachedRuns = shape.runs.runs(all, options, showThinking, revision);
		assert.deepStrictEqual(cachedRuns, expectedRuns, `runs, ${where}`);
		assert.deepStrictEqual(shape.blocks.turnBlocks(cachedRuns, running), turnBlocks(expectedRuns, running), `turnBlocks, ${where}`);
	}
}

test("每拍只重算最后一轮的结果，和从头算逐步逐项相同", () => {
	for (let seed = 1; seed <= 160; seed++) compare(seed, 220);
});

test("回复在流的时候，前面那几轮的行和块原样沿用", () => {
	const shape = { runs: new RunsCache(), blocks: new TurnBlocksCache() };
	const at = (n: number) => 1_700_000_000_000 + n * 1000;
	const messages: Message[] = [];
	for (let turn = 0; turn < 30; turn++) {
		messages.push({ role: "user", content: [{ type: "text", text: `问 ${turn}` }], timestamp: at(messages.length) });
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `c${turn}`, name: "read", arguments: { path: "a.ts" } }],
			stopReason: "toolUse",
			timestamp: at(messages.length),
			provider: "p",
			model: "m",
			usage,
		} as Assistant);
		messages.push({
			role: "toolResult",
			toolCallId: `c${turn}`,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: at(messages.length),
		} as Message);
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `答 ${turn}` }],
			stopReason: "stop",
			timestamp: at(messages.length),
			provider: "p",
			model: "m",
			usage,
		} as Assistant);
	}
	const asked: Message = { role: "user", content: [{ type: "text", text: "再问" }], timestamp: at(500) };
	const streaming = (text: string): Message[] => [
		...messages,
		asked,
		{ role: "assistant", content: [{ type: "text", text }], stopReason: "pending", timestamp: at(501), provider: "p", model: "m", usage } as Assistant,
	];
	const options = (list: Message[]) => ({ settledCount: list.length - 1 });
	const one = streaming("一");
	const first = shape.runs.runs(one, options(one), false, 0);
	const firstBlocks = shape.blocks.turnBlocks(first, true);
	const two = streaming("一二");
	const second = shape.runs.runs(two, options(two), false, 0);
	const secondBlocks = shape.blocks.turnBlocks(second, true);
	const settled = first.length - 2;
	assert.ok(
		first.slice(0, settled).every((run, index) => second[index] === run),
		"前面那几轮的行是同一批对象",
	);
	assert.ok(
		firstBlocks.slice(0, -2).every((block, index) => secondBlocks[index] === block),
		"前面那几轮的块也是",
	);
	assert.notEqual(second[second.length - 1], first[first.length - 1]);
});
