/**
 * plume.plan 的逻辑入口：计划模式。先看清楚、交一份计划，人批准之前不改任何文件。
 *
 * - 开关按会话记（`store.ts`），输入框上的开关和 `/plan` 拨它；新对话的开关在第一句话（`prompt.submit`）时交给建出来的会话。
 * - 不改文件靠执行期拒绝（`tool.execute`），工具表一字不改：工具定义排在请求最前面，批准后要把写工具还给模型，
 *   表一变整段前缀缓存就作废。`write`、`edit` 直接拒绝；别的调用都带上 `readOnly`，命令压进只读沙箱，申请离开沙箱的拒绝。
 *   计划模式会话底下的子会话（子 Agent、侧边聊天）受同一道线。
 * - `submit_plan` 交计划：经 `run.request` 等人拍板，不是权限，完全访问也不替人批——计划模式的全部意义是「动手之前人看一眼」。
 *   卡片是界面入口画的计划卡，回答连同附言一起交回来：接受带评论时评论是执行时的注意事项，计划照批；
 *   拒绝带修改意见时意见回给模型、开关不动，它改完再交；什么都没说的拒绝（和到时没人答、停下）让这一轮停下，人说下一步。
 *   批准那一刻开关就地关掉，同一轮里接着做。它常驻在工具表里，不在计划模式时调用返回一句错误。
 *   批准的计划存成会话临时目录里的一个文件；人选了「在新会话里执行」时，经 `ctx.sessions.launch` 在同一个项目里开一个
 *   只带着这份计划的会话（`handoff.ts` 写它的第一句话），这个会话就此停下，留着回答那边的提问。
 * - 开着时系统提示词多一段（`model.context`）；一轮查过东西、以正文收尾却没交计划时提醒一次（`step.end`）。
 * - 压缩把批准计划的那次结果折进摘要头时，计划原样接在头里（`context.compact`），执行所依据的计划不被概括掉。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, ToolDefinition } from "@plume/contract";
import type { PlanApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { handoffPrompt } from "./handoff.ts";
import { approvedPlans, planTitle, readPlanReply, renderPlan, SUBMIT_PLAN, type PlanDetails } from "./plan.ts";
import { approvedPlanNote, editsFiles, planSection, refusal, SUBMIT_PLAN_DESCRIPTION, SUBMIT_PLAN_RESULTS, unsubmittedPlanNote } from "./prompt.ts";
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

		/**
		 * 工具表里声明了这一类（`ToolDefinition.category`）的那件工具叫什么：提示词按它点名记清单、问人的工具，不认别的插件的工具名。
		 * `offered` 给了就只在这一轮真交给模型的那些里找；没有就是 undefined，提示词不点名。
		 */
		function toolOf(category: ToolDefinition["category"], offered?: readonly { name: string }[]): string | undefined {
			return ctx.tools.list().find((tool) => tool.category === category && (!offered || offered.some((given) => given.name === tool.name)))?.name;
		}

		async function parentOf(sessionId: string): Promise<string | null> {
			const known = parents.get(sessionId);
			if (known !== undefined) return known;
			const summary = await ctx.sessions.get(sessionId);
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
			const tools = { checklist: toolOf("checklist", input.tools), question: toolOf("question", input.tools) };
			return next({ ...input, sections: [...input.sections, { id: "plan", text: planSection(tools) }] });
		});

		ctx.hook("step.end", async (input, next) => {
			const verdict = await next(input);
			if (input.step === 1) turns.delete(input.sessionId);
			if (!store.has(input.sessionId)) return verdict;
			const turn = turns.get(input.sessionId) ?? { worked: false, submitted: false, reminded: false };
			turns.set(input.sessionId, turn);
			const tools = ctx.tools.list();
			for (const result of input.toolResults) {
				turn.worked = true;
				// 问过人的（`category: "question"` 的工具）也不提醒：它在等人回答，或者已经照人的回答收住了。
				if (result.toolName === SUBMIT_PLAN || tools.some((tool) => tool.category === "question" && tool.name === result.toolName)) turn.submitted = true;
			}
			/*
			 * 只在这一轮自然收尾时说：查过东西（一个工具都没调的「你好」「现在是计划模式吗」不问）、没交过计划、没提醒过。
			 * 说过还不交，就是它认定这里不需要计划，停下交给人。
			 */
			if (verdict.continue || verdict.reason !== undefined || !turn.worked || turn.submitted || turn.reminded) return verdict;
			turn.reminded = true;
			return { continue: true, say: unsubmittedPlanNote(toolOf("question")) };
		});

		/*
		 * 在里层的压缩（order 1000）外面：它定了压哪一段、写好了头，这里只往头的第一条（用户消息）后面接上批准的计划，执行所依据的计划
		 * 不被概括掉。批准那次的结果还留在压缩边界之后时不接，模型看得到原文。每次压缩都从会话的完整记录里重新找，不靠上一次的头带下来。
		 */
		ctx.hook("context.compact", async (input, next) => {
			const result = await next(input);
			if (!result || "pruneOnly" in result) return result;
			const latest = approvedPlans(await ctx.sessions.messages(input.sessionId)).at(-1);
			if (!latest || input.history.slice(result.keep).some((message) => message.role === "toolResult" && message.toolCallId === latest.toolCallId))
				return result;
			const [first, ...rest] = result.head;
			if (first?.role !== "user") return result;
			const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
			return { ...result, head: [{ ...first, content: [...content, { type: "text", text: approvedPlanNote(latest) }] }, ...rest] };
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
				const text = MESSAGES[ctx.locale()];
				const answer = await run.request({ kind: SUBMIT_PLAN, title: text.approvalTitle, payload: plan, waiting: text.approvalWaiting });
				const reply = answer.answered ? readPlanReply(answer.value) : undefined;
				if (reply?.accept === false) {
					return {
						output: SUBMIT_PLAN_RESULTS.revise(reply.feedback),
						details: { kind: "plan", plan, approved: false, feedback: reply.feedback } satisfies PlanDetails,
					};
				}
				// 没有反馈就没有可改的方向：这一轮停在这里，人说要改什么，开关不动。
				if (!reply) return { output: SUBMIT_PLAN_RESULTS.declined, details: { kind: "plan", plan, approved: false } satisfies PlanDetails, terminate: "done" };
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
						const origin = await ctx.sessions.get(run.sessionId);
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
				const checklist = run.tools().find((tool) => tool.category === "checklist")?.name;
				return { output: SUBMIT_PLAN_RESULTS.approved(renderPlan(plan, notes), Boolean(notes), checklist, file), details };
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
			models: async () => (await ctx.sessions.models()).map(({ id, name }) => ({ id, name })),
			watch: (call) => store.watch(call),
		} satisfies PlanApi);
	},
} satisfies Plugin;
