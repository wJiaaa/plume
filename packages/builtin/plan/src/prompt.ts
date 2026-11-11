/**
 * 发给模型的话：计划模式那一段提示词、拒绝写文件时的结果、`submit_plan` 的描述和结果、漏交计划时的提醒。
 * 都不随界面语言变。
 *
 * 规矩在提示词里，拦截在执行期（`tool.execute`）：提示词让它少撞墙，墙本身不靠提示词——「别改」说一次，
 * 三十轮后模型顺手改一个错字是常事。
 */

import { SUBMIT_PLAN } from "./plan.ts";

/** 问人的工具（内置插件 plume.ask-user）。 */
export const ASK_USER = "ask_user";

/**
 * 计划模式开着时系统提示词末尾多的一段。提问那一段必须明说通用准则（「有合理理解就照做」）在这里不适用：
 * 不说的话两条一起读，模型把拿不准的地方当成假设直接交，计划模式从来不问。问人用内置插件 plume.ask-user 的 `ask_user`。
 */
// i18n-exempt：发给模型的提示词。
export function planSection(hasTodo: boolean): string {
	return (
		"Plan mode is on. You are planning a change, not making it: files stay unchanged until the user approves a plan. " +
		"Tools that edit files refuse, and shell commands run in a read-only sandbox where any write fails; everything else, " +
		"including the network, works as usual. A request to do the work while plan mode is on is a request to plan it. " +
		`A plan is not a task list${hasTodo ? "; `todo_write` is for tracking the work once the plan is approved" : ""}.\n\n` +
		"Explore before you ask. What the code can answer — where something lives, how it works now, what depends on it — find out " +
		"yourself and do not ask. Planning is when asking is cheapest, so the general rule to take a reasonable reading and state the " +
		"assumption does not apply here: for every choice about intent, scope or a trade-off that would change the plan and that the " +
		`code cannot settle, ask with \`${ASK_USER}\` before you submit, giving the real options and the one you recommend. If the user ` +
		"skips a question, go with your recommendation and record it as an assumption.\n\n" +
		`Submit only when the plan is decision complete: whoever carries it out has nothing left to decide. Call \`${SUBMIT_PLAN}\` with ` +
		"the plan as Markdown — a title, a brief summary, the key changes, the test plan, and the assumptions and defaults you chose; " +
		"usually three to five short sections. Group changes by behaviour or subsystem rather than file by file, and name a path only " +
		"where it prevents a mistake. Give the least detail that keeps the implementation safe and leave out what is unaffected. If " +
		"the user sends it back, submit a complete replacement. Once it is approved every tool is available again."
	);
}

/**
 * 计划模式下拒绝这次调用的原因；不拒绝时是 undefined。只拦写文件这一件事：联网、调别的插件的工具都放行，
 * 命令不按文本猜，交给只读沙箱（`readOnly`）；只拒命令申请离开沙箱。
 */
// i18n-exempt：发给模型的工具结果。
export function editsFiles(name: string, args: Record<string, unknown>): string | undefined {
	if (name === "write" || name === "edit") return "it edits files";
	if (name === "bash" && args.escalate !== undefined) return "commands run in a read-only sandbox and may not leave it";
	return undefined;
}

/** `child`：被拦的是计划模式会话底下的子会话（子 Agent、侧边聊天），它交不了计划。 */
// i18n-exempt：发给模型的工具结果。
export function refusal(tool: string, why: string, child: boolean): string {
	return child
		? `The conversation that started you is in plan mode: ${why}, so "${tool}" did not run. Files stay unchanged until the user ` +
				"approves its plan; investigate and report instead."
		: `Plan mode: ${why}, so "${tool}" did not run. Files stay unchanged until the user approves a plan; every other tool works, ` +
				`and shell commands run in a read-only sandbox. Call \`${SUBMIT_PLAN}\` when the plan is ready.`;
}

// i18n-exempt：发给模型的工具描述和结果。
export const SUBMIT_PLAN_DESCRIPTION =
	"Submit the plan for the user to approve. Available in plan mode only. Submit it only when it is decision complete: whoever " +
	"carries it out has nothing left to decide. It is not a task list. Approval turns plan mode off. If the user asks for changes, " +
	"submit a complete replacement.";

// i18n-exempt：发给模型的工具结果。
export const SUBMIT_PLAN_RESULTS = {
	missing: "Put the whole plan, as Markdown, in `plan`.",
	off: "Plan mode is off; there is nothing to approve. Do the work.",
	child: "Only the main conversation can submit a plan; report your findings instead.",
	declined: "The plan was not approved and no feedback was given. Plan mode stays on; wait for the user.",
	revise: (feedback: string) =>
		`The user did not approve the plan. Feedback: ${feedback}\n\nPlan mode stays on. Revise the plan and call \`${SUBMIT_PLAN}\` again.`,
	approved: (plan: string, notes: boolean, hasTodo: boolean, file?: string) =>
		`The user approved the plan${notes ? " with notes" : ""}. Plan mode is off; every tool is available again.${file ? ` The plan is saved at ${file}.` : ""}\n\n${plan}\n\nCarry it out now.` +
		(hasTodo ? " If it takes three or more steps, break it into a task list with `todo_write` alongside your first action." : "") +
		(notes ? " The notes are the user's comments on this plan: follow them as you carry it out." : ""),
	handedOff: (file: string) =>
		`The user approved the plan and handed it to a new session, which carries it out from ${file}. Do not carry it out here. That session may message you about intent or trade-offs the plan leaves open; answer from this conversation.`,
	handoffFailed: (file: string, reason: string) =>
		`The user approved the plan and asked for it to run in a new session, but that session could not be started: ${reason}. The plan is saved at ${file}. Do not carry it out here; wait for the user.`,
};

/** 压缩把批准计划的那次结果换成摘要时，接在摘要后面的那一段：执行所依据的计划不能跟着被概括掉。 */
// i18n-exempt：发给模型的摘要。
export function approvedPlanNote(plan: string): string {
	return `User-approved plan (execute it; re-plan only if the user says so):\n\n${plan}`;
}

/**
 * 计划模式的一轮查过东西、以正文收尾、却没交计划时，说一次的那句：方案写在正文里人批不了，审批卡不会出现。
 * 还缺人的决定的，让它用 `ask_user` 问；只是答问题的，让它直接收住，不再要一段正文。
 */
// i18n-exempt：发给模型的话。
export const UNSUBMITTED_PLAN_NOTE =
	`（自动提示）现在是计划模式：计划只有通过 \`${SUBMIT_PLAN}\` 提交，用户才看得到审批卡、才能批准，写在回复正文里的方案批不了。` +
	`如果上面的回复就是方案，现在把它完整地用 \`${SUBMIT_PLAN}\` 交上来，不要再把正文写一遍；还缺用户的决定，就用 \`${ASK_USER}\` 问。` +
	"如果这一轮只是回答问题、用户并没有要改东西，就直接结束，不要写任何正文——上面的回答用户已经看到了。";
