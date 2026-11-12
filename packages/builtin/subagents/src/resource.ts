/**
 * `agent://<id>` 是子代理交回的结构化结果；`agent://<id>/<字段路径>` 是其中一个字段。经 `ctx.resources` 登记。
 *
 * 要字段路径这一半，是因为一次派出八个子代理时，父会话想要其中一个值，就得把整份回复重读一遍，而且读八遍；
 * `agent://<id>/files.0.path` 就是那个值。路径只认 `a.b.0.c`：JSONPath 是第二门语言，模型学它的代价比多读一个字段大。
 *
 * 只认这个会话自己派出的子代理（登记簿按父会话查），id 写后半截也认：转录里和人嘴里说的常是那一截。
 */

import type { Resource, ResourceHandler } from "@plume/contract";
import type { TaskRecord } from "./types.ts";

/** 这个会话派出的子代理。 */
export type TasksOf = (sessionId: string) => TaskRecord[];

// i18n-exempt：这个函数里的字都是交给模型的（系统提示词的地址说明、read 的结果和报错）。
export function agentResource(tasksOf: TasksOf): ResourceHandler {
	return {
		scheme: "agent",
		describe: "`agent://<id>` 子代理交回的结构化结果；`agent://<id>/<字段路径>` 取其中一个字段（如 `files.0.path`）",
		async resolve(url, scope): Promise<Resource> {
			const tasks = tasksOf(scope.sessionId);
			const [id = "", ...rest] = url.segments;
			const record = tasks.find((task) => task.id === id) ?? (id ? tasks.find((task) => task.id.endsWith(id)) : undefined);
			if (!record) throw new Error(`没有 id 是“${id}”的子代理。现有的是：${tasks.map((task) => task.id).join("、") || "（一个都没有）"}`);
			const meta = { id: record.id, agent: record.agent, status: record.state };
			if (!record.output) {
				// 没声明输出结构的子代理交回的是文字，这不是失败：把文字交出去，而不是说「它没有结构化结果」，否则父会话会去找一条不存在的路拿它。
				return {
					url: url.raw,
					content: record.answer ?? "（这个子代理还没有结果）",
					contentType: "text/plain",
					label: `子代理 ${record.agent} 的回复（这个 agent 没有声明结构化输出，所以是文本）`,
					meta,
				};
			}
			if (rest.length === 0) {
				return {
					url: url.raw,
					content: JSON.stringify(record.output, null, 2),
					contentType: "application/json",
					label: `子代理 ${record.agent} 的完整结果`,
					meta: { ...meta, warnings: record.warnings ?? [] },
				};
			}
			const path = rest.join("/");
			const picked = pickPath(record.output, path.split("."));
			if (picked === undefined) throw new Error(`子代理 ${record.id} 的结果里没有 \`${path}\`。可用的顶层字段：${Object.keys(record.output).join("、")}`);
			return {
				url: url.raw,
				content: typeof picked === "string" ? picked : JSON.stringify(picked, null, 2),
				contentType: typeof picked === "string" ? "text/plain" : "application/json",
				label: `子代理 ${record.agent} 结果里的 ${path}`,
				meta: { id: record.id, agent: record.agent },
			};
		},

		async list(scope) {
			return tasksOf(scope.sessionId).map((task) => ({ value: `agent://${task.id}`, description: `${task.agent} · ${task.description} · ${task.state}` }));
		},
	};
}

function pickPath(root: unknown, segments: string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			current = current.at(index);
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}
