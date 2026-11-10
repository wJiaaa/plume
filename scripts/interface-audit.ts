/**
 * 回复里的界面块（插件 plume.native-ui 的 ```ui）与 `preview`（插件 plume.preview）在真实会话里是怎么被用的。
 *
 * 界面块的组件目录、提示词里那一段，都是照着设想写的，没有一个数字说过模型真的会写哪些、写错哪些。加组件、改说明之前先在这里量：
 *
 *   - 写了几条带界面块的回复、调了几次 `preview`，各是为了什么请求（第 1、2 节）
 *   - 每条回复用生产的 `problemsIn` 重查一遍：哪种错最多、想用却没有的组件是哪些（第 3 节）
 *   - 人点了几次界面里带值的按钮（第 4 节）
 *
 * 会话库不存当时的系统提示词，看不出哪些会话装着这两个插件；分母是「用过界面块或 `ui_help` 的会话」。数据目录认 `PLUME_HOME`。
 *
 * 用法：
 *   pnpm audit:interface
 *   pnpm audit:interface --json
 */

import type { Message } from "../packages/contract/src/index.ts";
import { pluginSource } from "./plugin-source.ts";
import { copiedCount } from "./audit-copies.ts";
import { openSessionsReadOnly, storedSessions } from "./session-records.ts";

const { problemsIn } = await pluginSource("native-ui/src/notes.ts");

const asJson = process.argv.includes("--json");
/** 有没有 ```ui 围栏。只用来分出「写了界面块的回复」，问题由 `problemsIn` 查。 */
const UI_FENCE = /^\s*(?:`{3,}|~{3,})ui\s*$/im;

const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
const short = (text: string, length = 60) => text.replace(/\s+/g, " ").trim().slice(0, length);

/** 一条问题去掉具体的值，同一种错才能数到一起。 */
const kindOf = (problem: string) => problem.replace(/"[^"]*"/g, '"…"');

function tally(values: string[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1]);
}

const { db, path } = openSessionsReadOnly();
const stored = storedSessions(db);
db.close();

const replies: { session: string; prompt: string; problems: string[] }[] = [];
const previews: { session: string; prompt: string; how: string }[] = [];
const helps = new Set<string>();
let sends = 0;

for (const { summary, messages: all } of stored) {
	let prompt = "";
	for (const message of all.slice(copiedCount(summary, all))) {
		if (message.role === "user") {
			if (message.synthetic) continue;
			const text = message.displayText ?? textOf(message);
			// 带值的按钮发出的话后面跟着这一段（`spoken`）；不带值的按钮发的就是按钮上那句，和人打的字分不出来。
			if (textOf(message).includes("<interface-values>")) sends++;
			prompt = short(text);
			continue;
		}
		if (message.role !== "assistant") continue;
		// 和插件一样逐块查（`withInterfaceNotes`）：一个围栏不会跨两个文字块。
		if (UI_FENCE.test(textOf(message)))
			replies.push({ session: summary.id, prompt, problems: message.content.flatMap((part) => (part.type === "text" ? problemsIn(part.text) : [])) });
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (part.name === "ui_help") helps.add(summary.id);
			if (part.name !== "preview") continue;
			const args = part.arguments;
			const how =
				args.id !== undefined
					? args.check
						? "按 id 检查下一截"
						: "按 id 发布"
					: `${args.check ? "检查" : "直接发布"}·${args.path !== undefined ? "path" : args.files !== undefined ? "files" : "html"}`;
			previews.push({ session: summary.id, prompt, how });
		}
	}
}

const problems = replies.flatMap((reply) => reply.problems);
const unknown = problems.map((problem) => /unknown component (\w+)/.exec(problem)?.[1]).filter((name): name is string => Boolean(name));
const using = new Set([...replies.map((reply) => reply.session), ...helps]);
const report = {
	sessions: { total: stored.length, withInterface: using.size },
	replies: {
		count: replies.length,
		withProblems: replies.filter((reply) => reply.problems.length).length,
		sessions: new Set(replies.map((reply) => reply.session)).size,
	},
	uiHelp: helps.size,
	previews: { count: previews.length, sessions: new Set(previews.map((call) => call.session)).size, how: tally(previews.map((call) => call.how)) },
	promptsForBlocks: tally(replies.map((reply) => reply.prompt)),
	promptsForPreviews: tally(previews.filter((call) => !call.how.startsWith("按 id")).map((call) => call.prompt)),
	problemKinds: tally(problems.map(kindOf)),
	unknownComponents: tally(unknown),
	sends,
};

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
const list = (entries: [string, number][], limit = 15) =>
	entries.length
		? entries
				.slice(0, limit)
				.map(([value, n]) => `   ${String(n).padStart(4)}  ${value}`)
				.join("\n")
		: "   （无）";
console.log(`界面块体检 · ${path}

0. 样本
   会话 ${report.sessions.total} 个，其中用过界面块或 ui_help 的 ${report.sessions.withInterface} 个
   ${report.sessions.withInterface < 20 ? "样本太少：下面的比例只能当线索，不能当结论。" : ""}

1. 用了多少
   带界面块的回复 ${report.replies.count} 条，出现在 ${report.replies.sessions} 个会话；调过 ui_help 的会话 ${report.uiHelp} 个
   preview 调用 ${report.previews.count} 次，出现在 ${report.previews.sessions} 个会话
${list(report.previews.how)}

2. 为了什么请求（那一轮人说的话）
   写了界面块：
${list(report.promptsForBlocks)}
   调了 preview（不含按 id 的）：
${list(report.promptsForPreviews)}

3. 写错了什么（${report.replies.withProblems}/${report.replies.count} 条回复有问题）
${list(report.problemKinds)}
   想用但目录里没有的组件：
${list(report.unknownComponents)}

4. 人点了界面里带值的按钮 ${report.sends} 次（不带值的按钮发的话和人打的字分不出来，不在里面）`);
