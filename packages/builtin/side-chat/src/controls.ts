/**
 * 侧边聊天够得着主会话的两件工具：`dispatch_task` 把活交出去，`control_main` 停下、接着做、看状态。
 *
 * 都只在侧边聊天里的调用才有用：宿主只把父会话（`ToolRun.parent`）交给建这个子会话的插件注册的工具，
 * 作用对象就是它挂着的那个主会话，碰不到别的会话。
 */

import type { ParentStatus, ToolDefinition, ToolOutput } from "@plume/contract";

/**
 * 侧边聊天自己判断该交出去、人没指定去哪时，留给卡片的东西：人在卡片上选交给主会话、开新会话，还是就在这里做。
 * 写进工具结果的 `details`，存在侧边聊天的记录里，重开面板卡片还在。
 */
export interface DispatchSuggestionDetails {
	kind: "dispatch_suggestion";
	title: string;
	instruction: string;
}

export function isDispatchSuggestion(value: unknown): value is DispatchSuggestionDetails {
	const details = value as Partial<DispatchSuggestionDetails> | undefined;
	return details?.kind === "dispatch_suggestion" && typeof details.title === "string" && typeof details.instruction === "string";
}

/** 卡片标题按人数字的方式数（码点）。没给标题就用指令的第一行。 */
const TITLE_MAX = 60;

export function cardTitle(title: unknown, instruction: string): string {
	const given = typeof title === "string" ? title.trim() : "";
	const chars = [...(given || (instruction.split("\n")[0] ?? ""))];
	return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("")}…` : chars.join("");
}

// i18n-exempt：下面的工具说明、参数和结果都是发给模型的。

/** 不在侧边聊天里（宿主没给父会话）时的结果。 */
const NOT_HERE: ToolOutput = { output: "This tool only works in a side chat.", isError: true };

/**
 * 把活交给主会话，而不是在这里做。去哪是人的决定，不是模型的：只有人说了交给主会话（`user_asked`）才当场排进去。
 * 否则是一张卡片，让人选交给主会话、开新会话还是在这里做——排进主会话的活闲着时会马上开跑，不该凭猜。
 * 排进去的活和人自己打的话守同样的审批规则。
 */
// i18n-exempt：工具说明、参数和结果是发给模型的。
export const DISPATCH_TASK: ToolDefinition = {
	name: "dispatch_task",
	description:
		"把一件需要动手的事交出去（改文件、跑命令、查代码等）。" +
		"用户明确说了交给主会话（「让主会话做」「交给主会话」）时 user_asked 为 true：直接排进主会话的队列，它在完成当前工作后执行。" +
		"其余情况 user_asked 为 false：什么都不会开始，侧边聊天里出现一张卡片，由用户选择交给主会话、开一个新会话，还是就在这里做；调用后简短告诉用户卡片在等他选，然后结束这一轮。" +
		"instruction 必须是一条完整、可独立执行的指令——主会话和新会话都看不到侧边聊天的上下文。",
	parameters: {
		type: "object",
		properties: {
			instruction: { type: "string", description: "交出去的完整指令，写成可以直接执行的一句话或一段话。" },
			title: { type: "string", maxLength: TITLE_MAX, description: "卡片标题：以动词开头的短语，不超过 60 字；选开新会话时也是新会话的名字。" },
			user_asked: { type: "boolean", description: "用户是否明确要求交给主会话。只在他说过时为 true，你自己判断该交出去的一律 false。" },
		},
		required: ["instruction", "user_asked"],
	},
	async execute(args, run) {
		if (!run.parent) return NOT_HERE;
		const instruction = typeof args.instruction === "string" ? args.instruction.trim() : "";
		if (!instruction) return { output: "指令为空，没有派出任何任务。" };
		if (args.user_asked !== true) {
			const details: DispatchSuggestionDetails = { kind: "dispatch_suggestion", title: cardTitle(args.title, instruction), instruction };
			// 模型得听清楚什么都没开始：一张等人点的卡片，从它这边看和已经派出去一模一样。
			return { output: "什么都还没开始：侧边聊天里有一张卡片，等用户选交给主会话、开新会话，还是就在这里做。简短告诉用户这件事，然后结束这一轮。", details };
		}
		const { started } = await run.parent.enqueue(instruction);
		return { output: started ? "主会话当前空闲，已经开始执行。" : "已排入主会话的任务队列，它会在当前工作完成后执行。" };
	},
};

/** 「接着做」时替人说的那句，和转录底下的「继续」一样不画成人的气泡。 */
// i18n-exempt：替人说给主会话模型的话。
export const CARRY_ON = "继续，从中断的地方接着做。";

/**
 * 碰主会话的控制，而不是它的队列。`dispatch_task` 是活，排到队尾、闲了才做；「停一下」说的是正在跑的那一轮，
 * 排到它后面就成了等没什么可停了才停。这几样当场生效，改不了文件、跑不了命令：只有停下、接着做、看看在干什么。
 */
// i18n-exempt：工具说明、参数和结果是发给模型的。
export const CONTROL_MAIN: ToolDefinition = {
	name: "control_main",
	description:
		"立即控制主会话的执行状态，不排队、马上生效。" +
		"pause：让主会话停下手头正在跑的工作（和用户点暂停按钮一样）。" +
		"用户明确取消旧目标时，pause 配合 discardPlan: true 可同时废除旧清单；单纯暂停不要清除清单。" +
		"resume：让它从中断处接着做。" +
		"status：查主会话现在是在忙还是空着，以及队列里还剩什么。" +
		"需要它去『做』一件新的事，用 dispatch_task，不要用这个。",
	parameters: {
		type: "object",
		properties: {
			discardPlan: { type: "boolean", description: "Only with pause, when the user explicitly cancels or replaces the old task plan." },
			action: { type: "string", enum: ["pause", "resume", "status"], description: "pause 暂停，resume 继续，status 查看当前状态。" },
		},
		required: ["action"],
	},
	async execute(args, run) {
		const main = run.parent;
		if (!main) return NOT_HERE;
		const action = typeof args.action === "string" ? args.action.trim() : "";
		if (action === "pause") {
			if (args.discardPlan === true) {
				await main.stop({ discardPlan: true });
				return { output: "主会话已停止，旧任务清单已取消。历史记录保留，未完成事项没有被标记为完成。" };
			}
			// 看「真闲着」不看「在跑」：这一轮收了尾，派出去的子 Agent 照样在后台跑，停止键也停它们。
			// 挂着的监视、定时唤醒不挡「闲」（见 `ParentStatus`），闲着时停止键不碰它们，说清楚，免得人以为它不会再动。
			const before = await main.stop();
			if (before.state === "idle")
				return {
					output: "主会话现在闲着，不需要暂停。它挂着的监视、定时唤醒（如果有）不受影响，有输出或到点时还会叫醒它；要停掉它们，在主会话的环境卡片里操作。",
				};
			return {
				output:
					before.state === "running"
						? "已经让主会话停下了。它手头的工作已中止，派出的任务也一并中断——需要的话可以让我继续。"
						: "主会话这一轮已经收尾，但还在等后台的活回来——已经停下：派出的子 Agent 一并中断，后台命令的结果不再送回。需要的话可以让我继续。",
			};
		}
		if (action === "resume") {
			/*
			 * 不等：接着做的那一轮连同排在后面的可能要跑几十分钟，这次调用一直挂着，人对侧边聊天说的话只能排在后面。
			 * 控制是当场生效的，结果在主会话里看。
			 */
			const before = await main.carryOn(CARRY_ON);
			if (before.state === "running") return { output: "主会话正在执行，不用继续。" };
			// 派出去的还没回来：结果回来时它自己会开一轮。这时让它「接着做」，它多半会把那些活自己重做一遍。
			if (before.state === "background") return { output: "主会话派出去的活还在后台跑，结果回来后它会自己接着做，不用继续。" };
			return { output: "已经让主会话接着做了。" };
		}
		if (action === "status") return { output: statusText(main.status()) };
		return { output: `不认识的动作「${action}」。可用的是 pause、resume、status。`, isError: true };
	},
};

// i18n-exempt：工具结果是发给模型的。
function statusText(status: ParentStatus): string {
	const parts = [
		status.state === "running" ? "主会话正在执行" : status.state === "idle" ? "主会话当前空闲" : "主会话这一轮已经收尾，后台还有它派出去的活没回来",
	];
	if (status.queued > 0) parts.push(`队列里还有 ${status.queued} 个任务在等`);
	return `${parts.join("；")}。`;
}
