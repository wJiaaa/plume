import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSettings, TaskRecord } from "./types.ts";
import { isDispatch } from "./types.ts";

interface Data {
	tasks: TaskRecord[];
	choices: AgentSettings;
	/** 关掉的种类，按名字；内置的一样能关。 */
	disabled: string[];
}

/** 私有登记簿不复制对话；只保存身份、派发状态和最终交付。 */
export class Store {
	readonly tasks = new Map<string, TaskRecord>();
	readonly choices: AgentSettings;
	readonly disabled: Set<string>;
	private readonly path: string;

	constructor(directory: string) {
		this.path = join(directory, "subagents.json");
		const data: Data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { tasks: [], choices: {}, disabled: [] };
		if (
			!Array.isArray(data.tasks) ||
			!data.choices ||
			typeof data.choices !== "object" ||
			!Array.isArray(data.disabled) ||
			data.tasks.some(
				(task) =>
					!isDispatch(task) ||
					typeof task.description !== "string" ||
					typeof task.prompt !== "string" ||
					typeof task.identity?.prompt !== "string" ||
					!["queued", "running", "done", "failed", "stopped"].includes(task.state) ||
					!Number.isInteger(task.attempt),
			)
		) {
			throw new Error("Invalid sub-agent registry");
		}
		for (const task of data.tasks) this.tasks.set(task.id, task);
		this.choices = data.choices;
		this.disabled = new Set(data.disabled);
	}

	save(): void {
		const temporary = `${this.path}.tmp`;
		writeFileSync(temporary, JSON.stringify({ tasks: [...this.tasks.values()], choices: this.choices, disabled: [...this.disabled] } satisfies Data), {
			mode: 0o600,
		});
		renameSync(temporary, this.path);
	}
}
