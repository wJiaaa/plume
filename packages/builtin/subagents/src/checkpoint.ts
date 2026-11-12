/**
 * 检查点：子智能体每跑一段（默认 60 步）停下来看一眼，不是上限。清单在往前推就接着跑；没写清单的给一次机会列出来；
 * 连着两段一项没勾、清单做完了还在忙、或者续了太多段，就停下讨一份交接，上下文留着等派它来的一方续跑。
 *
 * 判据只看清单打勾数有没有变多，不另猜「它是不是在瞎忙」：一个每步读不同文件、搜不同词的模型，按重复调用怎么量都不算打转，
 * 却能这样一直花下去；真在推进的长活会边做边勾。
 */

import type { Message } from "@plume/contract";

/** 每段几步。定义里写了 `maxTurns` 的按它：改的是多久汇报一次，不是最多干多少活。 */
const CHECKPOINT_TURNS = 60;

/** 宿主一轮最多跑几步（agent-extension.md）：一段比它长也跑不满，提示词和交回的说明都按它说。 */
const TURN_STEPS = 200;

/** 这个子智能体每段几步。 */
export function segmentRounds(maxTurns: number | undefined): number {
	return Math.min(maxTurns ?? CHECKPOINT_TURNS, TURN_STEPS);
}

/** 最多接着跑几段：防的是下面几条判据有漏洞，不是对活该有多大的判断。 */
const MAX_CONTINUATIONS = 10;

/** 连着几段一项没勾还接着跑。允许一段：一项活本来就可能比一段长，难活的头一段也常常全在读。 */
const STALLED_CONTINUATIONS = 1;

/** 讨交接给几步：字段填错时校验会退回来，留一次改正的机会。 */
export const SALVAGE_STEPS = 2;

/** 清单的一项；只看状态。 */
interface Todo {
	status: string;
}

/** 这一次运行的检查点状态，每次派发、续跑重来。 */
export interface Segment {
	/** 每段几步。 */
	rounds: number;
	/** 上一个检查点在第几步（一轮里从 1 数）。 */
	start: number;
	/** 上一个检查点时清单上打了勾的项数；起点取在开跑之前。 */
	done: number;
	/** 连着几段一项都没勾。 */
	stalled: number;
	/** 已经接着跑了几段。 */
	extra: number;
	/** 「没写清单」的那一次机会给过没有。 */
	graced: boolean;
	/** 讨交接已经用了几步；没在讨时没有。 */
	salvage?: number;
}

/** 清单上打了勾的有几项。 */
export const completed = (todos: readonly Todo[]) => todos.filter((todo) => todo.status === "completed").length;

export function openSegment(rounds: number): Segment {
	return { rounds, start: 0, done: 0, stalled: 0, extra: 0, graced: false };
}

/**
 * 会话里最新的那份清单：记清单的工具每次给的都是整张，结果的 `details` 带 `checklist`（`ChecklistDetails`），倒着找第一份认得出的。
 * 没装清单插件时一份也没有。
 */
export function latestTodos(messages: readonly Message[]): Todo[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "toolResult" || message.isError) continue;
		const checklist = (message.details as { checklist?: unknown } | undefined)?.checklist;
		if (!Array.isArray(checklist)) continue;
		return checklist.filter((todo): todo is Todo => typeof todo === "object" && todo !== null && typeof todo.status === "string");
	}
	return [];
}

/**
 * 到了检查点怎么走：`continue` 接着跑，`plan` 让它把剩下的列成清单再跑（只给一次），`stop` 停下讨交接。
 * `planless` 是有没有清单可写：没有 `todo_write` 时让它列清单是一句做不到的话。
 *
 * 清单是空的和清单做完了是两件事：做完了还撞上检查点，说明它在清单之外还在忙，该停；一份都没写，只说明它没记账。
 * 打勾数变少（重写了整张清单）按没推进算：推翻自己计划的那一段，正是最不该无条件再给它一段的。
 */
export function atCheckpoint(segment: Segment, todos: readonly Todo[], planless: boolean): "continue" | "plan" | "stop" {
	if (segment.extra >= MAX_CONTINUATIONS) return "stop";
	const unfinished = todos.length - completed(todos);
	if (unfinished === 0) {
		if (todos.length > 0 || !planless || segment.graced) return "stop";
		segment.graced = true;
		segment.extra++;
		return "plan";
	}
	const done = completed(todos);
	segment.stalled = done > segment.done ? 0 : segment.stalled + 1;
	segment.done = done;
	if (segment.stalled > STALLED_CONTINUATIONS) return "stop";
	segment.extra++;
	return "continue";
}

/**
 * 没写清单就撞上检查点时对它说的话。两条路都给：只给「列清单」，一个其实已经查够了的会为了有清单硬凑几项再跑一段；
 * 只给「收尾」，就退回到了一到点就停。
 */
// i18n-exempt：发给模型的话。
export function planDemand(rounds: number): string {
	return (
		`（自动追加）这一段的 ${rounds} 轮用完了。还没做完的话，先用 \`todo_write\` 把剩下的步骤列出来再接着做——` +
		"之后每到检查点，清单在往前推就会让你继续；手上的信息已经够了，就现在收尾交付。" +
		"接下来把互不依赖的读取和搜索放在同一条回复里一起发。"
	);
}
