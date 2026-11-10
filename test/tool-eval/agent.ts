/**
 * 评测里跑一轮 agent：起一个真的 agent（`createAgent`），装上内置插件和评测要的插件，用 `model.ts` 解析出的模型。
 *
 * 走产品的那条路，而不是把循环、系统提示词、工具一样样拼起来：Plume 的系统提示词、工具表、改道、剪枝都在插件里，
 * 自己拼一份测到的是一个用户永远用不到的 agent。评测要换的东西用插件换：同名工具后登记的生效（记录器就这样替掉真工具），
 * 只列给模型几个工具用 `tools`（最外层的 `model.context`，见 `onlyTools`）。
 *
 * 数据目录是一个临时目录，跑完删掉：会话、插件数据、这次用到的 key（存进临时目录里的 vault，和应用的存法一样）都不落进 `PLUME_HOME`。
 * 权限模式是完全访问，评测里没有人答审批卡。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Plugin, PluginEntry } from "../../packages/contract/src/index.ts";
import type { AssistantMessage, Message, ToolResultMessage } from "../../packages/core/llm/src/types.ts";
import { type Agent, type AgentOptions, createAgent } from "../../packages/core/agent/src/index.ts";
import { BUILTINS } from "../../packages/core/agent/test/builtins.ts";
import type { EvalModel } from "./model.ts";

export interface EvalAgentOptions {
	model: EvalModel;
	/** 内置插件之后装的；同名工具后登记的生效。 */
	plugins?: Plugin[];
	/** 换掉默认的那组内置插件（`packages/core/agent/test/builtins.ts`：循环离不开的那几样）。 */
	builtins?: PluginEntry[];
	/** 只把这几个工具列给模型；不给就是装上的全部。 */
	tools?: readonly string[];
	/** 插件的 `ctx.pages`（桌面应用里由主进程做）。 */
	pages?: AgentOptions["pages"];
}

interface EvalCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** 还没有结果（被停下）时是 undefined。 */
	isError?: boolean;
	output: string;
}

export interface EvalTurn {
	sessionId: string;
	/** 这一轮新写进会话的消息（含发出去的那句）。 */
	messages: Message[];
	/** 按调用的先后，配上各自的结果。 */
	calls: EvalCall[];
	/** 这一轮助手说的话，按条用换行连起来。 */
	text: string;
	/** 这一轮出的错：没配好模型、钩子出错、请求失败。 */
	errors: string[];
	/** 超出步数或超时被停下。 */
	stopped: boolean;
}

interface SendOptions {
	/** 模型最多回几次，超出就按停；不给不限（循环自己有上限）。 */
	maxSteps?: number;
	/** 等这一轮收尾最多多久，默认 10 分钟。 */
	timeoutMs?: number;
}

export interface EvalAgent {
	agent: Agent;
	dataDir: string;
	/** 插件 `name` 的数据目录（`ctx.dataDir`）。 */
	pluginDataDir(name: string): string;
	/** 在 `cwd` 新建一个会话。 */
	session(cwd: string): Promise<string>;
	/** 在会话里发一句，等这一轮及其后台工作都收尾。 */
	send(sessionId: string, text: string, options?: SendOptions): Promise<EvalTurn>;
	/** 新建会话、发一句。 */
	run(cwd: string, text: string, options?: SendOptions): Promise<EvalTurn>;
	/** 收到的每个事件。 */
	onEvent(listener: (event: AgentEvent) => void): () => void;
	close(): Promise<void>;
}

/** 只把这几个工具列给模型。挂在 plume.prompt（order -1000）外面：系统提示词里的工具说明按筛过的那份写。 */
function onlyTools(names: readonly string[]): Plugin {
	const keep = new Set(names);
	return {
		name: "eval.only-tools",
		apply(ctx) {
			ctx.hook("model.context", async (input, next) => next({ ...input, tools: input.tools.filter((tool) => keep.has(tool.name)) }), { order: -2000 });
		},
	};
}

export async function evalAgent(options: EvalAgentOptions): Promise<EvalAgent> {
	const dataDir = await mkdtemp(join(tmpdir(), "plume-eval-"));
	const extra = [...(options.tools ? [onlyTools(options.tools)] : []), ...(options.plugins ?? [])];
	const agent = await createAgent({
		dataDir,
		settingsFile: join(dataDir, "settings.json"),
		plugins: [...(options.builtins ?? BUILTINS), ...extra.map((plugin): PluginEntry => ({ key: plugin.name, load: async () => plugin }))],
		log: (source, level, message) => {
			if (level !== "info") process.stderr.write(`[${source}] ${level}: ${message}\n`);
		},
		...(options.pages ? { pages: options.pages } : {}),
	});
	const { service } = agent;
	const { provider, model, settings } = options.model;
	const { id: _id, providerId: _providerId, ...entry } = model;
	const providerId = await service.saveProvider({
		id: "",
		name: provider.name,
		api: provider.api,
		baseUrl: provider.baseUrl,
		enabled: true,
		models: [entry],
		apiKey: provider.apiKey,
	});
	await service.setDefaultModel(`${providerId}/${model.modelId}`);
	await service.setPermissionMode("full");
	// 照应用发：思考档位和重试策略用设置里的，不另加 temperature（有的模型直接拒收）。
	if (settings.thinking) await service.setDefaultThinking(settings.thinking);
	if (settings.retryPolicy) await service.setRetryPolicy(settings.retryPolicy);

	const listeners = new Set<(event: AgentEvent) => void>();
	const watching = new AbortController();
	void (async () => {
		for await (const event of service.watch({ signal: watching.signal })) for (const listener of listeners) listener(event);
	})();
	const onEvent = (listener: (event: AgentEvent) => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};

	const session = async (cwd: string) => (await service.createSession({ cwd })).id;

	async function send(sessionId: string, text: string, { maxSteps, timeoutMs = 10 * 60_000 }: SendOptions = {}): Promise<EvalTurn> {
		const before = (await service.getSession(sessionId)).messages.length;
		const errors: string[] = [];
		let steps = 0;
		let stopped = false;
		const stop = () => {
			stopped = true;
			service.stop(sessionId);
		};
		let off = () => false;
		const idle = new Promise<void>((resolve) => {
			off = onEvent((event) => {
				if (!("sessionId" in event) || event.sessionId !== sessionId) return;
				if (event.type === "idle") resolve();
				else if (event.type === "notice" && !event.level) errors.push(event.text);
				else if (event.type === "message" && event.message.role === "assistant" && maxSteps !== undefined && ++steps >= maxSteps && !stopped) stop();
			});
		});
		const timer = setTimeout(stop, timeoutMs);
		try {
			service.send(sessionId, { content: [{ type: "text", text }] });
			await idle;
		} finally {
			clearTimeout(timer);
			off();
		}
		const messages = (await service.getSession(sessionId)).messages.slice(before);
		return { sessionId, messages, calls: callsOf(messages), text: textOf(messages), errors: [...errors, ...requestErrors(messages)], stopped };
	}

	return {
		agent,
		dataDir,
		pluginDataDir: (name) => join(dataDir, "plugin-data", name),
		session,
		send,
		run: async (cwd, text, options) => send(await session(cwd), text, options),
		onEvent,
		async close() {
			watching.abort();
			await agent.shutdown();
			await rm(dataDir, { recursive: true, force: true });
		},
	};
}

function callsOf(messages: readonly Message[]): EvalCall[] {
	const results = new Map<string, ToolResultMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	return messages.flatMap((message) =>
		message.role !== "assistant"
			? []
			: message.content.flatMap((block) => {
					if (block.type !== "toolCall") return [];
					const result = results.get(block.id);
					return [
						{
							id: block.id,
							name: block.name,
							args: (block.arguments ?? {}) as Record<string, unknown>,
							...(result ? { isError: result.isError === true } : {}),
							output: result ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "",
						},
					];
				}),
	);
}

function textOf(messages: readonly Message[]): string {
	return messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap((message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])))
		.join("\n");
}

function requestErrors(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => (message.role === "assistant" && message.stopReason === "error" ? [message.errorMessage ?? "请求失败"] : []));
}
