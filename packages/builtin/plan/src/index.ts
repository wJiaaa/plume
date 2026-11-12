/**
 * plume.plan 的逻辑入口：计划模式。先看清楚、交一份计划，人批准之前不改任何文件。
 *
 * - 开关按会话记（`store.ts`），输入框上的开关和 `/plan` 拨它；新对话的开关在第一句话（`prompt.submit`）时交给建出来的会话。
 * - 不改文件靠执行期拒绝（`tool.execute`），工具表一字不改：工具定义排在请求最前面，批准后要把写工具还给模型，
 *   表一变整段前缀缓存就作废。`write`、`edit` 直接拒绝；别的调用都带上 `readOnly`，命令压进只读沙箱，申请离开沙箱的拒绝。
 *   计划模式会话底下的子会话（子 Agent、侧边聊天）受同一道线。
 * - `submit_plan` 交计划：审批卡标着 `userOnly`，完全访问也不替人批——计划模式的全部意义是「动手之前人看一眼」。
 *   卡片是界面入口画的计划卡，回答之前把附言经 `reply` 交过来：接受带评论时评论是执行时的注意事项，计划照批；
 *   拒绝带修改意见时意见回给模型、开关不动，它改完再交；什么都没说的拒绝让这一轮停下，人说下一步。
 *   批准那一刻开关就地关掉，同一轮里接着做。它常驻在工具表里，不在计划模式时调用返回一句错误。
 *   批准的计划存成会话临时目录里的一个文件；人选了「在新会话里执行」时，经 `ctx.sessions.launch` 在同一个项目里开一个
 *   只带着这份计划的会话（`handoff.ts` 写它的第一句话），这个会话就此停下，留着回答那边的提问。
 * - 开着时系统提示词多一段（`model.context`）；一轮查过东西、以正文收尾却没交计划时提醒一次（`step.end`）。
 * - 压缩把批准计划的那次结果换成摘要时，计划原样接在摘要后面（`context.compact`），执行所依据的计划不被概括掉。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@plume/contract";
import type { PlanApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { handoffPrompt } from "./handoff.ts";
import { approvedPlans, planTitle, renderPlan, SUBMIT_PLAN, type PlanDetails, type PlanReply } from "./plan.ts";
import { ASK_USER, approvedPlanNote, editsFiles, planSection, refusal, SUBMIT_PLAN_DESCRIPTION, SUBMIT_PLAN_RESULTS, UNSUBMITTED_PLAN_NOTE } from "./prompt.ts";
import { PlanStore } from "./store.ts";

/** 一轮里漏交计划的提醒：这一轮调过工具没有、交过计划没有、提醒过没有。每轮第一步收尾时重来。 */
interface Turn {
	worked: boolean;
	submitted: boolean;
	reminded: boolean;
}

export default {
	name: "plume.plan",
	async apply(ctx) {
		const store = await PlanStore.open(ctx.dataDir, (message) => ctx.log.warn(message));
		/** 子会话 → 父会话；顶层会话记 null。父子关系建了就不变，查过就记下。 */
		const parents = new Map<string, string | null>();
		const turns = new Map<string, Turn>();
		/** 审批卡交来的附言，按会话：同一个会话的审批卡一次只弹一张，答完就被那次 `submit_plan` 取走。 */
		const replies = new Map<string, PlanReply>();

		async function parentOf(sessionId: string): Promise<string | null> {
			const known = parents.get(sessionId);
			if (known !== undefined) return known;
			const summary = (await ctx.sessions.list()).find((session) => session.id === sessionId);
			const parent = summary?.parentId ?? null;
			if (summary) parents.set(sessionId, parent);
			return parent;
		}

		/** 这个会话的调用受不受计划模式管：`own` 是它自己开着，`parent` 是它的父会话开着。 */
		async function planning(sessionId: string): Promise<"own" | "parent" | undefined> {
			if (store.has(sessionId)) return "own";
			if (!store.any) return undefined;
			const parent = await parentOf(sessionId);
			return parent !== null && store.has(parent) ? "parent" : undefined;
		}

		ctx.sessions.onDeleted((sessionId) => {
			store.forget(sessionId);
			parents.delete(sessionId);
			turns.delete(sessionId);
			replies.delete(sessionId);
		});

		ctx.hook("prompt.submit", async (input, next) => {
			const verdict = await next(input);
			if (!verdict.block && input.fresh && store.drafted && (await parentOf(input.sessionId)) === null) store.takeDraft(input.sessionId);
			return verdict;
		});

		ctx.hook("tool.execute", async (input, next) => {
			const mode = await planning(input.sessionId);
			if (!mode) return next(input);
			const why = editsFiles(input.call.name, input.call.args);
			if (why) return { output: refusal(input.call.name, why, mode === "parent"), isError: true };
			return next({ ...input, readOnly: true });
		});

		// 计划中命令都压进只读沙箱（见上面的 `tool.execute`）。在 plume.prompt（order -1000）外面先标上，它点名的 shell 才和
		// 实际跑命令的一致：Windows 上只读的命令跑 PowerShell，即使权限模式是完全访问（那时点名的是 Git Bash）。
		ctx.hook("model.context", async (input, next) => ((await planning(input.sessionId)) ? next({ ...input, readOnly: true }) : next(input)), { order: -1001 });

		ctx.hook("model.context", (input, next) => {
			if (!store.has(input.sessionId)) return next(input);
			const hasTodo = input.tools.some((tool) => tool.name === "todo_write");
			return next({ ...input, sections: [...input.sections, { id: "plan", text: planSection(hasTodo) }] });
		});

		ctx.hook("step.end", async (input, next) => {
			const verdict = await next(input);
			if (input.step === 1) turns.delete(input.sessionId);
			if (!store.has(input.sessionId)) return verdict;
			const turn = turns.get(input.sessionId) ?? { worked: false, submitted: false, reminded: false };
			turns.set(input.sessionId, turn);
			for (const result of input.toolResults) {
				turn.worked = true;
				// 调过 `ask_user` 的也不提醒：它在等人回答，或者已经照人的回答收住了。
				if (result.toolName === SUBMIT_PLAN || result.toolName === ASK_USER) turn.submitted = true;
			}
			/*
			 * 只在这一轮自然收尾时说：查过东西（一个工具都没调的「你好」「现在是计划模式吗」不问）、没交过计划、没提醒过。
			 * 说过还不交，就是它认定这里不需要计划，停下交给人。
			 */
			if (verdict.continue || verdict.reason !== undefined || !turn.worked || turn.submitted || turn.reminded) return verdict;
			turn.reminded = true;
			return { continue: true, say: UNSUBMITTED_PLAN_NOTE };
		});

		// 在 plume.compaction（order 1000）外面：它定了压哪一段、写好了摘要，这里只往摘要后面接上计划。
		// 只剪枝的没有摘要；里层自己写好了头（plume.compaction 的头里 <task-context> 已经带着批准的计划）就不再接。
		ctx.hook("context.compact", async (input, next) => {
			const result = await next(input);
			if (!result || "pruneOnly" in result || result.head) return result;
			const latest = approvedPlans(await ctx.sessions.messages(input.sessionId)).at(-1);
			if (!latest || input.history.slice(result.keep).some((message) => message.role === "toolResult" && message.toolCallId === latest.toolCallId))
				return result;
			return { ...result, summary: `${result.summary}\n\n${approvedPlanNote(renderPlan(latest.plan, latest.notes))}` };
		});

		ctx.tools.register({
			name: SUBMIT_PLAN,
			description: SUBMIT_PLAN_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					plan: {
						type: "string",
						description: "The whole plan as Markdown, in the user's language: a title, a brief summary, the key changes, the test plan, the assumptions.",
					},
				},
				required: ["plan"],
			},
			async execute(args, run) {
				if ((await parentOf(run.sessionId)) !== null) return { output: SUBMIT_PLAN_RESULTS.child, isError: true };
				if (!store.has(run.sessionId)) return { output: SUBMIT_PLAN_RESULTS.off, isError: true };
				const plan = typeof args.plan === "string" ? args.plan.trim() : "";
				if (!plan) return { output: SUBMIT_PLAN_RESULTS.missing, isError: true };
				// 上一张卡没答完就停下留下的附言不算这一次的。
				replies.delete(run.sessionId);
				const text = MESSAGES[ctx.locale()];
				const decision = await run.ask({ kind: SUBMIT_PLAN, title: text.approvalTitle, detail: plan, userOnly: true, waiting: text.approvalWaiting });
				const reply = replies.get(run.sessionId) ?? {};
				replies.delete(run.sessionId);
				if (decision === "reject") {
					if (reply.feedback) {
						return {
							output: SUBMIT_PLAN_RESULTS.revise(reply.feedback),
							details: { kind: "plan", plan, approved: false, feedback: reply.feedback } satisfies PlanDetails,
						};
					}
					// 没有反馈就没有可改的方向：这一轮停在这里，人说要改什么，开关不动。
					return { output: SUBMIT_PLAN_RESULTS.declined, details: { kind: "plan", plan, approved: false } satisfies PlanDetails, terminate: "done" };
				}
				const notes = reply.note;
				const approvedAt = Date.now();
				// 计划连同注意事项存成文件：交给新会话靠它；原地执行时压缩以后路径还在，随时能重读。
				const directory = join(run.scratchDir, "plans");
				await mkdir(directory, { recursive: true });
				const file = join(directory, `plan-${approvedAt}.md`);
				await writeFile(file, `${renderPlan(plan, notes)}\n`, "utf8");
				// 开关就地关掉：这一轮剩下的调用经过的是同一层，从此放行，不用等下一轮。
				store.set(run.sessionId, false);
				const details: PlanDetails = { kind: "plan", plan, approved: true, ...(notes ? { notes } : {}), approvedAt, file };
				if (reply.handoff) {
					/*
					 * 实施归新会话，这里就此停下：接着跑的话两个会话在同一份计划上各改各的。新会话开在这个会话的项目里，
					 * 记着从这次调用开出来（`spawnedFrom`），不回报——这个会话留着只为回答那边的提问。
					 */
					const model = reply.handoff.model;
					const handed = { ...details, handoff: true, ...(model ? { model } : {}) } satisfies PlanDetails;
					try {
						const origin = (await ctx.sessions.list()).find((session) => session.id === run.sessionId);
						if (!origin) throw new Error(MESSAGES[ctx.locale()].handoffGone);
						await ctx.sessions.launch({
							...(origin.project ? { project: origin.project } : { cwd: origin.cwd }),
							message: handoffPrompt(MESSAGES[ctx.locale()], { plan: renderPlan(plan, notes), file }),
							title: [...planTitle(plan)].slice(0, 60).join(""),
							...(model ? { model } : {}),
							spawnedFrom: { sessionId: run.sessionId, toolCallId: run.toolCallId },
						});
					} catch (error) {
						// 没开出来：这一轮照样按「交出去了」停下，不告诉人的话这份计划就悄悄没人做了。
						const reason = error instanceof Error ? error.message : String(error);
						ctx.notice(run.sessionId, MESSAGES[ctx.locale()].handoffFailed(reason, file), "error");
						return { output: SUBMIT_PLAN_RESULTS.handoffFailed(file, reason), details: handed, terminate: "done" };
					}
					return { output: SUBMIT_PLAN_RESULTS.handedOff(file), details: handed, terminate: "done" };
				}
				const hasTodo = run.tools().some((tool) => tool.name === "todo_write");
				return { output: SUBMIT_PLAN_RESULTS.approved(renderPlan(plan, notes), Boolean(notes), hasTodo, file), details };
			},
		});

		ctx.commands.provide({
			list: () => {
				const text = MESSAGES[ctx.locale()];
				return [{ name: "plan", description: text.command, argumentHint: text.commandHint }];
			},
			/*
			 * 不带话就是开关；带话就先进计划模式、再把这句话当普通消息发出去。发出去的只是后半句：开关已经拨过了，
			 * `/plan` 留在气泡里模型会当成一条它不认识的命令。
			 */
			expand(_name, rest, context) {
				const sessionId = context.sessionId ?? null;
				const on = sessionId === null ? store.drafted : store.has(sessionId);
				if (!rest) {
					store.set(sessionId, !on);
					return { handled: true };
				}
				store.set(sessionId, true);
				return { text: rest };
			},
		});

		ctx.serve({
			set: (sessionId: string | null, on: boolean) => store.set(sessionId === null ? null : String(sessionId), on === true),
			reply(sessionId: string, reply: PlanReply) {
				const note = typeof reply?.note === "string" ? reply.note.trim() : "";
				const feedback = typeof reply?.feedback === "string" ? reply.feedback.trim() : "";
				const handoff = reply?.handoff && typeof reply.handoff === "object" ? reply.handoff : undefined;
				const model = typeof handoff?.model === "string" && handoff.model ? handoff.model : undefined;
				replies.set(String(sessionId), {
					...(note ? { note } : {}),
					...(feedback ? { feedback } : {}),
					...(handoff ? { handoff: model ? { model } : {} } : {}),
				});
			},
			models: async () => (await ctx.sessions.models()).map(({ id, name }) => ({ id, name })),
			watch: (call) => store.watch(call),
		} satisfies PlanApi);
	},
} satisfies Plugin;
