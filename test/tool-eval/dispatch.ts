/**
 * 派一个子智能体出去、拿回它交的东西：子智能体评测（orchestration、verify）共用。
 *
 * Plume 的 `task` 在后台派发，结果之后作为一条送达写进父会话，所以要量「父会话拿到了什么」，就得真的走一遍派发：
 * 经 plume.subagents 建子会话、按定义的身份和输出结构跑、`yield` 校验、送达。评测只换掉父会话的那个模型——它换成
 * 本机一个照脚本走的假服务（`fakeAnthropic`），第一次请求就调 `task`，之后只回一句话。这样派什么、怎么写 `prompt`
 * 完全确定，两组对照之间唯一的差别是子智能体的定义；真模型只花在子智能体身上，它用的是 `model.ts` 解析出的那个
 * （经插件开给设置页的 `setModel` 指定，和人在设置 › 智能体里给这一种选模型是同一条路）。
 *
 * 交回来的东西从插件的登记簿取（`list`，面板读的也是它）：`output` 是 `yield` 校验过的对象，`answer` 是交给父会话的正文；
 * 父会话最后真正读到的那一条送达（`<subagent_result …>`）另外从父会话的消息里取出来。
 */

import type { Message } from "../../packages/core/llm/src/types.ts";
import { fakeAnthropic } from "../../packages/core/agent/src/testing.ts";
import type { EvalAgent, EvalTurn } from "./agent.ts";

/** 子智能体插件 `list` 给的一条任务（`packages/builtin/subagents/src/types.ts` 的 TaskRecord），这里只用到这几样。 */
type TaskRecord = { answer?: string; output?: unknown; warnings?: string[] };

const SUBAGENTS = "plume.subagents";

export interface DispatchRequest {
	subagent_type: string;
	description: string;
	prompt: string;
}

export interface Dispatched {
	/** 插件登记簿里这一次派发的记录；派发失败时没有。 */
	task?: TaskRecord;
	/** 父会话收到的那条送达的全文；没送到时是空串。 */
	delivered: string;
	parent: EvalTurn;
}

/**
 * 在 `agent` 里新开一个会话，确定地派出 `request` 这一个子智能体，等父会话连同后台工作都收尾。
 * `agent` 需要装了 plume.subagents；子智能体用 `agent` 的默认模型。
 */
export async function dispatchOnce(agent: EvalAgent, cwd: string, request: DispatchRequest, timeoutMs = 15 * 60_000): Promise<Dispatched> {
	const { service, host } = agent.agent;
	const subagentModel = (await service.getSettings()).defaultModel;
	if (!subagentModel) throw new Error("没有默认模型，子智能体没有模型可用");
	// 父会话：第一次请求调 `task`，之后（派发的结果、送达）一律回一句话收尾。
	const dispatcher = await fakeAnthropic((body) => {
		const messages = (body.messages ?? []) as { role: string; content: unknown }[];
		const answered = messages.some(
			(message) => Array.isArray(message.content) && message.content.some((block: { type?: string }) => block.type === "tool_result"),
		);
		return answered ? { text: "收到。" } : { toolCalls: [{ id: "dispatch-1", name: "task", args: { ...request } }] };
	});
	try {
		const providerId = await service.saveProvider({
			id: "",
			name: "派发脚本",
			api: "anthropic-messages",
			baseUrl: dispatcher.url,
			enabled: true,
			models: [
				{
					modelId: "dispatcher",
					name: "派发脚本",
					contextWindow: 200_000,
					maxOutputTokens: 4096,
					supportsThinking: false,
					supportsImages: false,
					supportsTools: true,
				},
			],
			apiKey: "local",
		});
		const signal = new AbortController().signal;
		await host.call(SUBAGENTS, "setModel", [request.subagent_type, { model: subagentModel }], { signal });
		const sessionId = await agent.session(cwd);
		await service.setSessionModel(sessionId, `${providerId}/dispatcher`);
		const parent = await agent.send(sessionId, `派一个 ${request.subagent_type} 子智能体：${request.description}`, { timeoutMs });
		const tasks = (await host.call(SUBAGENTS, "list", [sessionId], { signal })) as TaskRecord[];
		return { task: tasks[0], delivered: deliveredText(parent.messages), parent };
	} finally {
		await dispatcher.close();
	}
}

/** 父会话里那条送达：宿主把它作为一条用户位置的消息写进来，正文里带着插件写的 `<subagent_result …>`。 */
function deliveredText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role === "assistant") continue;
		const text = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		if (text.includes("<subagent_result")) return text;
	}
	return "";
}
