import type { Message } from "@plume/contract";

/** 清单的一项。`activeForm` 是正在做这一项时的说法（「正在接上路由」），只在真有东西在动时拿来说。 */
export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
}

/** 工具结果 details 的形状。本体的转录（「更新清单 3/5」那一行）和清单卡片都认它。 */
export interface TodoDetails {
	kind: "todo";
	todos: TodoItem[];
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function isTodoList(value: unknown): value is TodoItem[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				typeof item.content === "string" &&
				STATUSES.has(item.status) &&
				(item.activeForm === undefined || typeof item.activeForm === "string"),
		)
	);
}

/**
 * 会话里最新的那份清单。`todo_write` 每次发的都是整张清单，最新那份是唯一算数的，所以倒着找第一条成功、认得出的结果。
 */
export function latestTodos(messages: readonly Message[]): TodoItem[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;
		const details = message.details as Partial<TodoDetails> | undefined;
		if (details?.kind === "todo" && isTodoList(details.todos)) return details.todos;
	}
	return [];
}
