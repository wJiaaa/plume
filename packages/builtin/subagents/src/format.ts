import type { SessionView } from "@plume/contract";
import type { TaskRecord } from "./types.ts";
import { isActive } from "./types.ts";

export function ordered(tasks: TaskRecord[]): TaskRecord[] {
	return [...tasks].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.createdAt - b.createdAt);
}

export function elapsed(task: TaskRecord): string {
	const seconds = Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - (task.startedAt ?? task.createdAt)) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function callCount(child: SessionView | undefined): number {
	return (child?.messages ?? []).reduce(
		(sum, message) => sum + (message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall").length : 0),
		0,
	);
}
