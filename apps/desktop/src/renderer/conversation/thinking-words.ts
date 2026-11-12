/**
 * 运行行上那句话：等的是哪一种等。
 *
 * 读文件、跑测试、满仓库地找，坐着等的感觉不一样，把这个不同说出来，长的一轮就好熬得多。按 agent 刚做过的事挑，
 * 窗口本来就知道；不问模型要：每一句都要多一次请求，到的时候它早就在做下一件事了。
 *
 * 口吻故意随意，而且是英文：它挨着 `42s · 63.6k tokens`，一句中文夹在那一行里读着像另一个声音插进一段技术读数。
 * 这是程序在屏幕角落自言自语，不是给谁的进度汇报。
 */

import type { ToolKind } from "@plume/contract";
import { checklistTool, toolKind } from "./tool-lines.ts";

/**
 * 值得区分的几种等待：
 *
 * - `breathing`  模型在想，什么都没在跑
 * - `listening`  在读
 * - `searching`  搜内容、找文件、列目录
 * - `working`    命令在跑
 * - `solving`    一轮测试，要么过要么不过
 * - `connecting` 连接断了在等重连
 * - `weaving`    排计划
 * - `composing`  写新东西，或者往外写回答
 * - `shaping`    改已有的东西
 */
export type Mood = "breathing" | "listening" | "searching" | "working" | "solving" | "connecting" | "weaving" | "composing" | "shaping";

// i18n-exempt：运行行上故意用英文的自言自语，理由见文件头。
const WORDS: Record<Mood, string[]> = {
	listening: ["Reading up", "Skimming", "Digging in", "Getting the lay of it", "Poking around the source"],
	composing: ["Writing", "Drafting", "Putting it down", "Getting it on paper", "Laying down code"],
	shaping: ["Reworking", "Editing", "Reshaping it", "Moving things around", "Knocking it into shape"],
	working: ["Running it", "Kicking it off", "Letting it rip", "Waiting on the shell", "Turning the crank"],
	searching: ["Hunting", "Rummaging", "Casting about", "Following the thread", "Combing through"],
	solving: ["Proving it", "Running the gauntlet", "Making sure", "Putting it through its paces"],
	connecting: ["Having a look", "Reaching out"],
	weaving: ["Plotting", "Lining it up", "Sketching the order", "Working out the steps"],
	breathing: ["Thinking", "Mulling", "Turning it over", "Chewing on it", "Working it out", "Pondering"],
};

/** 一步耗到这么久，措辞就承认它在磨。 */
const PATIENCE_MS = 45_000;
const LONG_WORDS = ["Still at it", "This one's stubborn", "Taking its time", "Nearly there", "Wrestling with it"];

/** 每种活（`ToolDefinition.kind`）在等的是哪一种。查后台任务的输出不算一件活，当成在想。 */
const BY_KIND: Record<ToolKind, Mood> = {
	view: "listening",
	create: "composing",
	modify: "shaping",
	command: "working",
	watch: "working",
	job: "breathing",
	find: "searching",
	search: "searching",
	list: "searching",
};

/** 不管从哪个工具进来，其实是一轮测试的命令。 */
const TEST_HINT = /\b(test|jest|vitest|pytest|spec|coverage)\b/i;

/**
 * 它此刻在干什么，按这个顺序问。`retrying` 压过一切：等重连的一轮什么都没在做。`writing` 把沉默分成两半：没有工具在跑时，
 * 模型要么在推理，要么在往外写回答。工具仍然优先：文字在流、工具也在跑时，工具是更具体的事实。
 */
export function moodFor(toolName: string | undefined, summary: string | undefined, retrying = false, writing = false): Mood {
	if (retrying) return "connecting";
	if (summary && TEST_HINT.test(summary)) return "solving";
	if (toolName) {
		// 按工具声明的种类说；记清单的在排步骤；什么都没说的当成在想。
		if (checklistTool(toolName)) return "weaving";
		const kind = toolKind(toolName);
		return kind ? BY_KIND[kind] : "breathing";
	}
	return writing ? "composing" : "breathing";
}

/** 选一句，不用随机数：按 mood 和一个慢慢走的 tick 取，重绘不会自己换词——只有时间会。 */
export function phraseFor(mood: Mood, tick: number, elapsedMs: number): string {
	if (elapsedMs > PATIENCE_MS) return LONG_WORDS[tick % LONG_WORDS.length]!;
	const pool = WORDS[mood];
	return pool[tick % pool.length]!;
}
