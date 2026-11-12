/**
 * 内置插件：todo 清单的逻辑入口。
 *
 * - 工具 todo_write（`category: "checklist"`）：每次传完整的清单，整表替换，同一时刻最多一项在做；清单放进结果的 details（宿主认的 `ChecklistDetails`），
 *   界面入口的卡片从这里读出最新的一份，宿主据此在收尾时提醒没做完的。转录里怎么说这次调用由界面入口登记（`ui.toolLine` 的 `checklist`）。
 *   怎么用写在工具描述里，不另往系统提示词里加段。
 * 清单跟着事走，循环里和清单有关的三句话（都只问不停）：
 * - 单独调一次 `todo_write`：在那条结果末尾说一句（`SOLO_TODO_NOTE`）。
 * - 清单没做完，却 `PROGRESS_EVERY` 次请求没更新：两步之间问一句进度（`stalePlanNote`，钩子 `step.end`）。
 * - 清单收尾（钩子 `step.end`）：正文写完了，清单却还说某一步「正在做」，替人问它一次（`openPlanNote`）。
 *   它只勾了清单（`todo_write` 带 `terminate`）或者一个字没写，这一轮就此结束，不再要一段新正文：回答在上面，人已经看过了。
 *   外层说还在等派出去的后台工作（`StepEnd.awaiting`）时不问。
 */

import type { ChecklistDetails, Plugin } from "@plume/contract";
import { isTodoList, latestTodos, type TodoItem } from "./types.ts";

// i18n-exempt：工具描述和结果是发给模型的，不随界面语言变。
const DESCRIPTION =
	"Record the task list for work of three or more steps. Send the complete list every time — it replaces the previous one; exactly one item may be `in_progress`. " +
	"Never let this be the only tool call in a reply: write the plan with your first real action, and mark steps done with the next one (or the one that finishes the work).";

const MARKS = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;

/** 接在单独一次 todo_write 的结果末尾。说的是代价，不只是规矩：三步的活里，近一半的工具轮是单独更新清单。 */
// i18n-exempt：发给模型的话。
export const SOLO_TODO_NOTE =
	"（这一轮只调了 todo_write，没有做任何实际工作。从下一轮起，把清单更新和真正的下一步——读文件、改代码、跑命令——放在同一次回复里；单独更新清单是浪费一次往返。）";

/**
 * 多少次请求没更新清单就问一句。按请求数数，说过就重新计数，所以两次之间也至少隔这么多次：
 * 大多数活在这么多次请求以内做完，从头到尾不会被问。
 */
export const PROGRESS_EVERY = 20;

/**
 * 有清单时，汇报就是对一遍清单：只认 `todo_write`，嘴上说了不算，卡片上那张清单不会因为它说了一句而往前走。
 * 措辞要的是「现在就对一遍、这次回复里带上」：「下一次有实际动作时顺手勾掉」是一句可以往后拖的话。
 */
// i18n-exempt：发给模型的话。
export function stalePlanNote(todos: TodoItem[]): string {
	return (
		`（自动提示）任务清单已经 ${PROGRESS_EVERY} 次请求没更新了，当前是：\n${todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join("\n")}\n` +
		"现在就对一遍：已经做完的勾成 completed，正在做的标 in_progress。这次回复里带上 todo_write，和你的下一步操作放在一起。"
	);
}

/** 收尾前问的那一句。发给模型的话，不随界面语言变。 */
// i18n-exempt：发给模型的话。
export function openPlanNote(open: TodoItem[]): string {
	return (
		`（自动提示）任务清单里还有 ${open.length} 项没勾：\n${open.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")}\n` +
		"已经做完的，用 todo_write 勾成 completed；要等用户回复的保持原样；真是漏做了，就接着做完。" +
		"只更新清单时不要写正文——上面的回答用户已经看到了。"
	);
}

/** 一轮里清单收尾的状态。每轮第一步收尾时重来。 */
interface Watch {
	/** `asked`：下一条回复是在回答 `openPlanNote`。一轮只问一次，回答到了就是 `spent`。 */
	check: "unasked" | "asked" | "spent";
	/**
	 * 这一轮跑过清单以外的工具。没跑过，清单不会因为这一轮落后于事实，收尾时不问：喊停后只回了一句「已暂停」，
	 * 清单里那项「正在做」是被打断的上一轮留下的，问了只换来一条空回复。
	 */
	worked: boolean;
}

export default {
	name: "plume.todo",
	apply(ctx) {
		const watches = new Map<string, Watch>();
		/** 会话最近一次请求里模型拿到了哪些工具：拿不到 todo_write 的（子 Agent、侧边聊天这类收窄了工具的会话）不问它清单。 */
		const offered = new Map<string, string[]>();
		const listing = (sessionId: string) => offered.get(sessionId)?.includes("todo_write") === true;
		ctx.sessions.onDeleted((sessionId) => {
			watches.delete(sessionId);
			offered.delete(sessionId);
		});

		ctx.tools.register({
			name: "todo_write",
			description: DESCRIPTION,
			// 别的插件要让模型「用它记下步骤」时按这一类找到它，不认工具名。
			category: "checklist",
			// i18n-exempt：导出会话成 Markdown 时的一行，导出是英文的。
			describe: () => "Update task list",
			parameters: {
				type: "object",
				properties: {
					todos: {
						type: "array",
						description: "The full task list, in order.",
						items: {
							type: "object",
							properties: {
								content: { type: "string", description: "Imperative description, e.g. 'Add the sync endpoint'." },
								status: { type: "string", enum: ["pending", "in_progress", "completed"] },
								activeForm: { type: "string", description: "Present continuous form, e.g. 'Adding the sync endpoint'." },
							},
							required: ["content", "status"],
							additionalProperties: false,
						},
					},
				},
				required: ["todos"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const todos = args.todos;
				// i18n-exempt：工具结果是发给模型的。
				if (!isTodoList(todos)) return { output: "`todos` must be an array of { content, status, activeForm? }.", isError: true };
				const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
				// i18n-exempt：工具结果是发给模型的。
				if (inProgress > 1) return { output: `Only one task may be in_progress; ${inProgress} were marked. Pick one.`, isError: true };
				const done = todos.filter((todo) => todo.status === "completed").length;
				const summary = todos.map((todo) => `${MARKS[todo.status]} ${todo.content}`).join("\n");
				// 回答收尾的追问时只动了清单：这一轮到此为止，不再要一段新正文。顺手干了别的活的照常接着做。
				const settled = watches.get(run.sessionId)?.check === "asked" && run.calls.every((call) => call.name === "todo_write");
				// 这一步只更新了清单，别的什么都没做：在结果末尾说一句，模型下一步读的就是这里。只有它一个工具时不说。
				const solo = !settled && run.calls.length === 1 && (offered.get(run.sessionId)?.length ?? 0) > 1;
				return {
					output: `Task list updated (${done}/${todos.length} done):\n${summary}${solo ? `\n\n${SOLO_TODO_NOTE}` : ""}`,
					details: { checklist: todos } satisfies ChecklistDetails,
					...(settled ? { terminate: "done" as const } : {}),
				};
			},
		});

		ctx.hook("model.context", async (input, next) => {
			const output = await next(input);
			offered.set(
				input.sessionId,
				output.tools.map((tool) => tool.name),
			);
			return output;
		});

		// 在 plume.hooks 的 Stop（默认 order 0）外面：Stop 钩子看到的是真正的回答，它不要求接着做了才轮到清单。
		ctx.hook(
			"step.end",
			async (input, next) => {
				if (input.step === 1) watches.delete(input.sessionId);
				const watch = watches.get(input.sessionId) ?? { check: "unasked", worked: false };
				watches.set(input.sessionId, watch);
				const calls = input.reply.content.filter((part) => part.type === "toolCall");
				const answering = watch.check === "asked";
				if (answering) watch.check = "spent";
				if (calls.some((call) => call.name !== "todo_write")) watch.worked = true;
				/*
				 * 回答追问时一个字也没写：那句话本来就说「要等用户回复的保持原样」「只更新清单时不要写正文」，这就是照做了。
				 * 当成空回复去催（本体最里层的自然结论），逼出来的是把上面的回答再说一遍。
				 */
				if (answering && calls.length === 0 && input.reply.content.every((part) => part.type !== "text" || !part.text.trim())) return { continue: false };

				if (calls.length > 0) {
					const todos = listing(input.sessionId) ? latestTodos(await ctx.sessions.messages(input.sessionId)) : [];
					const reported = calls.some((call) => call.name === "todo_write");
					// 有未完清单时只认更新清单；正文汇报和计数仍由本体处理，避免两边重复提醒。
					return next(
						todos.some((todo) => todo.status !== "completed") || reported ? { ...input, progress: { reported, reminder: stalePlanNote(todos) } } : input,
					);
				}
				const verdict = await next(input);
				if (verdict.continue || verdict.reason !== undefined) return verdict;
				/*
				 * 正文写完了，清单却还说某一步「正在做」：问它一次。不违背「有正文就交还给人」：它可以原样保留清单结束。
				 * 只看 in_progress：剩下的全是 pending，是它有意停在那一步前面（多半在等人确认），问了也只是原样再交一遍清单。
				 */
				/*
				 * 派出去的还没回来（`awaiting`）时不问：那一项没勾是因为在等它们，问了只会逼它把还没等到的结论提前写出来。
				 * 没问不算问过，回来以后那一轮收尾照样问。
				 */
				if (watch.check !== "unasked" || !watch.worked || input.stepsLeft <= 0 || input.awaiting || !listing(input.sessionId)) return verdict;
				const open = latestTodos(await ctx.sessions.messages(input.sessionId)).filter((todo) => todo.status !== "completed");
				if (!open.some((todo) => todo.status === "in_progress")) return verdict;
				watch.check = "asked";
				return { continue: true, say: openPlanNote(open) };
			},
			{ order: -10 },
		);
	},
} satisfies Plugin;
