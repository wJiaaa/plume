/**
 * 一步里的工具怎么跑：每个调用经钩子 tool.execute（最里层先审批，再执行工具表里的工具），每个调用都要有一条结果。
 * 工具都是插件注册的（read、write、bash 这些是内置插件 plume.tools 的）；本体没有工具，循环照样走完各个钩子。
 *
 * 「每个调用都要有结果」是协议的要求：Anthropic 拒收任何后面没有 tool_result 的 tool_use，一个孤儿封死的不是这一步，
 * 是之后的每一个请求。所以停下以后没跑的、被截断的、断流时开了头的调用，都在这里补一条不执行的结果。
 */

import type {
	ApprovalContent,
	ApprovalDecision,
	ApprovalRequest,
	BackgroundChannel,
	BackgroundJobInput,
	CancelledDetails,
	HumanAnswer,
	HumanRequest,
	HumanRequestInput,
	LetterInput,
	LetterReceipt,
	Log,
	ParentSession,
	PermissionMode,
	SessionScope,
	SessionWakeup,
	ToolDefinition,
	ToolExecution,
	ToolOutput,
	ToolRun,
	TrackedJob,
	WakeupInput,
} from "@plume/contract";
import type { AssistantMessage, ToolCallContent, ToolResultMessage } from "@plume/llm/types";
import { errorText, type PluginHost } from "./host.ts";
import { DECLINED } from "./declined.ts";
import type { CallFiles } from "./run-files.ts";
import { text } from "./i18n.ts";

/** 工具执行进度最快多久推一次；界面上也只留最后这么多字符，完整输出在结果里。 */
const PROGRESS_INTERVAL_MS = 100;
const PROGRESS_LIMIT = 20_000;

// i18n-exempt：下面这些都是交给模型的工具结果，不随界面语言变。
export const STOPPED_BEFORE_RUN = "the turn was stopped before it could run";
export const CUT_WHILE_ARRIVING = "the connection dropped while the call was still arriving, so its arguments are incomplete";
export const TRUNCATED_CALL =
	"the response hit the output token limit before this call's arguments were complete. Re-issue it with less in one call: " +
	"write a large file in parts (create it with the first part, then add the rest with edit), and send fewer calls per reply";
const CANCELLED_RUNNING = "Tool execution was cancelled. Anything it had already done may have taken effect.";
// 等审批时被停的那个根本没开始，说「可能已经生效」会让模型去查一个不可能存在的结果。
const CANCELLED_WAITING = "Tool call was stopped while it waited for approval, so it never ran.";
const ARGUMENTS_LOST_REASON =
	"every call in this reply arrived with empty arguments. That is the provider dropping the arguments of parallel tool calls, not something you left out. Make one tool call per reply from now on";

export interface ToolScope {
	sessionId: string;
	/** 调用所在的会话（`ToolRun.session`、各钩子输入的 `session`），这一轮里不变。 */
	session: SessionScope;
	cwd: string;
	projectRoots?: readonly string[];
	/** 人拖进来的文件（`ToolRun.allowedPaths`），每个调用执行前读一次：这一轮中途排进来的话带着的附件也算。 */
	allowedPaths?(): Promise<readonly string[]>;
	/** 这个会话的临时目录，交给工具（`ToolRun.scratchDir`）。 */
	scratchDir: string;
	/** 同一脉的会话的临时目录（`ToolRun.scratchDirs`），每个调用执行前现算：这一轮中途开出去的子智能体、新会话也算。 */
	scratchDirs?(): readonly string[];
	signal: AbortSignal;
	host: PluginHost;
	log: Log;
	/** 现在的权限模式和人答过「以后不再问」的东西，每个调用执行前读一次：中途改了，下一个调用就照新的来。 */
	permission(): Promise<{ mode: PermissionMode; alwaysAllow: readonly string[] }>;
	ask(request: ApprovalRequest): Promise<ApprovalDecision>;
	/** 等人给一份数据（`ToolRun.request`），和 `ask` 同一队。 */
	requestHuman(request: HumanRequest): Promise<HumanAnswer>;
	/**
	 * 这次调用弹的卡里有没有是代管插件替人答的（`SessionAccess.respond`、`answer`）：有就交回那个插件，并且忘掉这一笔。
	 * 调用收场时问一次，记进结果的 `answeredBy`。
	 */
	answeredBy?(toolCallId: string): string | undefined;
	/** 调用开始执行了（审批也算在执行里）：界面从这一刻给它计时。 */
	started(toolCallId: string): void;
	/** 执行中的输出：记下最新的一份，按节奏推给界面；`undefined` 表示这个调用跑完了。 */
	progress(toolCallId: string, output: string | undefined, push: boolean): void;
	/** `plugin` 的工具在 `toolCallId` 那次调用把后台结果送回这个会话的渠道（`ToolRun.background`）；子会话没有。 */
	background?(plugin: string, toolCallId: string): BackgroundChannel;
	/** `plugin` 的工具在 `toolCallId` 那次调用登记一项后台任务（`ToolRun.track`，`jobs.ts`）。 */
	track(plugin: string, toolCallId: string, job: BackgroundJobInput): TrackedJob;
	/** `plugin` 的工具在 `toolCallId` 那次调用约一次唤醒（`ToolRun.schedule`，`wakeups.ts`）；子会话没有。 */
	schedule?(plugin: string, toolCallId: string, wake: WakeupInput): SessionWakeup | undefined;
	/** 注册这个工具的插件给另一个顶层会话寄信（`ToolRun.letter`）；子会话没有。 */
	letter?(plugin: string, to: string, letter: LetterInput): LetterReceipt;
	/** 这一轮以完成收场后归档这个会话（`ToolRun.archiveAfterTurn`）；子会话没有。 */
	archiveAfterTurn?(): void;
	/** 注册这个工具的插件够得着的父会话（`ToolRun.parent`）：这个会话是它建的子会话时才有。 */
	parent?(plugin: string): ParentSession | undefined;
	/** 这次调用跑命令用的 `ToolRun.shell`、`exec`、`escalate`（`commands.ts`）：沙箱档、提权都在那里，这里只把它们挂到 `run` 上。 */
	commands(call: CallCommands): Pick<ToolRun, "shell" | "exec" | "escalate">;
	/** 这次调用读工作区用的 `ToolRun.files`（`run-files.ts`）：读边界、问人都在那里，这里只把它挂到 `run` 上。 */
	files(call: CallFiles): ToolRun["files"];
}

/** 造一次调用的 `shell`、`exec`、`escalate` 要的东西，这里按这次调用给，`commands.ts` 用它造。 */
export interface CallCommands {
	/** 这次调用的工作目录（`exec` 不给 `cwd` 时用它）。 */
	cwd: string;
	/** 外层要求这次调用不改动工作区。 */
	readOnly: boolean;
	/** 现在的权限模式，这次调用里只读一次设置。 */
	permission(): Promise<PermissionMode>;
	/** 经过闸问一次（`ToolRun.ask` 那一条路）：带 `escalation` 的只认人答，见 `tool-run.ts` 的 `approve`。 */
	ask(content: ApprovalContent): Promise<ApprovalDecision>;
	/** 调用答完以后再用就抛错。 */
	alive(what: string): void;
}

/**
 * 卡是代管插件替人答的：结果上记着是哪个插件（界面写一行），交给模型的正文后面也写明，模型不会把它当成人在 Plume 里亲手点的。
 * 只陈述是谁答的，不评判这次放行或回答算不算数：权限照会话的设置，已经由本体定过了。
 */
function relayed(message: ToolResultMessage, plugin: string | undefined): ToolResultMessage {
	if (!plugin) return message;
	// i18n-exempt：交给模型的工具结果。
	const note = `[The approval or answer for this call was relayed by the plugin "${plugin}" that stewards this session, not given by the user in Plume's interface.]`;
	const [first, ...rest] = message.content;
	const content =
		first?.type === "text" ? [{ ...first, text: `${first.text}\n\n${note}` }, ...rest] : [{ type: "text" as const, text: note }, ...message.content];
	return { ...message, content, answeredBy: plugin };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

function validImage(image: unknown): boolean {
	const { data, mimeType } = (image ?? {}) as { data?: unknown; mimeType?: unknown };
	return typeof data === "string" && data.length > 0 && !data.startsWith("data:") && typeof mimeType === "string" && IMAGE_TYPES.has(mimeType);
}

/** `startedAt`：真跑了的调用开始的时刻，记下耗时给使用统计（`tailActivity` 的 `toolMs`）；没跑就被拦下的不带。 */
function toolResult(call: ToolCallContent, result: ToolOutput, startedAt?: number): ToolResultMessage {
	const now = Date.now();
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [
			{ type: "text", text: result.output },
			...(result.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
		],
		isError: result.isError === true,
		...(result.shownImages?.length
			? { shownImages: result.shownImages.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) }
			: {}),
		...(result.details === undefined ? {} : { details: result.details }),
		...(result.uneventful === true ? { uneventful: true } : {}),
		...(result.instructions === true ? { instructions: true } : {}),
		...(startedAt === undefined ? {} : { startedAt, durationMs: now - startedAt }),
		timestamp: now,
	};
}

/**
 * `details` 跟着结果存进会话库（JSON）、经端口发给界面，内存里留的就是落盘的那份。存不成 JSON 的（BigInt、循环引用）丢掉并记日志：
 * 工具已经跑过了，输出照样交给模型，不能因为给界面的附带数据让这条结果写不进会话。
 */
function storable(details: unknown, call: ToolCallContent, scope: ToolScope): unknown {
	try {
		const text = JSON.stringify(details);
		return text === undefined ? undefined : (JSON.parse(text) as unknown);
	} catch (error) {
		scope.log("agent", "error", `工具 ${call.name} 的结果 details 存不成 JSON，已丢掉：${errorText(error)}`);
		return undefined;
	}
}

/**
 * 回复里的调用参数换成规范名（`ToolDefinition.aliases`），在回复写进会话之前：之后每个按参数做判断的地方（tool.execute、tool.approve 的层，
 * 审批，转录，压缩）和工具自己读的是同一份。只在执行前换的话，层看到的和存下的就是模型写的那份，一条读 `path` 的守卫读不到 `file`，放过去，工具却照样读了。
 * 换过的调用丢掉流里收到的参数原文（`argumentsText`）：回放时发的、算 token 时数的都该是存下的这一份，模型往后在历史里看到的也是规范的写法。
 */
export function canonicalCalls(reply: AssistantMessage, host: PluginHost): AssistantMessage {
	let changed = false;
	const content = reply.content.map((block) => {
		if (block.type !== "toolCall") return block;
		const args = canonicalArgs(block.arguments, host.tool(block.name)?.definition.aliases);
		if (args === block.arguments) return block;
		changed = true;
		const { argumentsText, ...call } = block;
		return { ...call, arguments: args };
	});
	return changed ? { ...reply, content } : reply;
}

/**
 * tool.execute 每一层往里交时再换一次规范名：外层改写参数（钩子插件把脚本回的参数写回去）时可能又写成别名，里层的守卫和工具
 * 得照样看到规范名。`settle` 也会过一遍各层交回的结果，只动带 `call` 的交接（`ToolExecution`），结果原样放过。
 */
function canonicalHandoff(aliases: ToolDefinition["aliases"]): ((value: unknown) => unknown) | undefined {
	if (!aliases) return undefined;
	return (value) => {
		const input = value as Partial<ToolExecution> | undefined;
		if (!input?.call || typeof input.call !== "object") return value;
		const args = canonicalArgs(input.call.args, aliases);
		return args === input.call.args ? value : { ...input, call: { ...input.call, args } };
	};
}

/** 规范名没给（或是 null）时取第一个给了的别名；别名都删掉，规范名给了时也删，免得层读一个、工具读另一个。没有别名时原样返回。 */
function canonicalArgs(args: Record<string, unknown>, aliases: ToolDefinition["aliases"]): Record<string, unknown> {
	if (!aliases || !args || typeof args !== "object") return args;
	let result: Record<string, unknown> | undefined;
	for (const [name, names] of Object.entries(aliases)) {
		for (const alias of names) {
			if (!Object.hasOwn(args, alias)) continue;
			result ??= { ...args };
			if (result[name] == null && result[alias] != null) result[name] = result[alias];
			delete result[alias];
		}
	}
	return result ?? args;
}

/**
 * 判失败、不执行：写到一半就断了的参数不是参数，撞上输出上限的参数可能能解析但缺字段，执行它比判它失败更糟。
 * 因为人按了停才没跑的，标上 `cancelled`，界面画成「已停止」而不是出错。
 */
export function failCalls(calls: ToolCallContent[], reason: string, cancelled = false): ToolResultMessage[] {
	return calls.map((call) =>
		toolResult(call, {
			output: `"${call.name}" was not executed: ${reason}. Re-issue the call.`,
			isError: true,
			...(cancelled ? { details: { cancelled: true } satisfies CancelledDetails } : {}),
		}),
	);
}

/**
 * 相邻的、不改动工作区的调用（读文件、查东西）合成一批同时跑，会改动的单独一批；批与批之间按顺序，
 * 改动不会和读它的调用撞在一起。结果按调用的顺序写进会话，一出来（前面的都写完了）就交给 `commit`，
 * 崩溃时已跑完的不丢。停下以后剩下的补「没有执行」。
 * 返回结果要这一轮怎么结束（`ToolOutput.terminate`）：几个都要时，卡住比完成要紧。
 */
export async function runTools(
	calls: ToolCallContent[],
	scope: ToolScope,
	commit: (result: ToolResultMessage) => Promise<void>,
): Promise<ToolOutput["terminate"]> {
	// 多个已知工具都需要参数却全是空对象，说明整轮传输丢参；别执行，也别误判成精确重复。
	if (
		!scope.signal.aborted &&
		calls.length >= 2 &&
		calls.every((call) => {
			const required = scope.host.tool(call.name)?.definition.parameters.required;
			return Array.isArray(required) && required.length > 0 && Object.keys(call.arguments).length === 0;
		})
	) {
		for (const result of failCalls(calls, ARGUMENTS_LOST_REASON)) await commit({ ...result, details: { argumentsLost: true } });
		return undefined;
	}
	let terminate: ToolOutput["terminate"];
	let index = 0;
	while (index < calls.length) {
		if (scope.signal.aborted) {
			for (const result of failCalls(calls.slice(index), STOPPED_BEFORE_RUN, true)) await commit(result);
			break;
		}
		const batch = [calls[index] as ToolCallContent];
		if (!mutating(batch[0] as ToolCallContent, scope)) {
			while (index + batch.length < calls.length && !mutating(calls[index + batch.length] as ToolCallContent, scope))
				batch.push(calls[index + batch.length] as ToolCallContent);
		}
		index += batch.length;
		const running = batch.map((call) => runTool(call, scope, calls));
		for (const pending of running) {
			const [result, ending] = await pending;
			await commit(result);
			if (ending === "stalled" || (ending === "done" && terminate === undefined)) terminate = ending;
		}
	}
	return terminate;
}

/** 整轮要么全是丢参结果，要么全不是；连续停止由循环按轮数。 */
export function isArgumentsLost(result: ToolResultMessage): boolean {
	return (result.details as Record<string, unknown> | undefined)?.argumentsLost === true;
}

/**
 * 没注册的工具当作不改动：它只会立刻得到一条「没有这个工具」。工具能证明这一次什么都不改的（只读的 bash 命令，`readsOnly`），
 * 也和相邻的只读调用同时跑；它判断时出错就当会改动。
 */
function mutating(call: ToolCallContent, scope: ToolScope): boolean {
	const definition = scope.host.tool(call.name)?.definition;
	if (definition?.mutating !== true) return false;
	try {
		return definition.readsOnly?.(call.arguments) !== true;
	} catch {
		return true;
	}
}

/** `step` 是这一步回复里的全部调用，给工具看（`ToolRun.calls`）。 */
async function runTool(call: ToolCallContent, scope: ToolScope, step: readonly ToolCallContent[]): Promise<[ToolResultMessage, ToolOutput["terminate"]?]> {
	const { signal } = scope;
	const tool = scope.host.tool(call.name);
	// i18n-exempt：工具结果是发给模型的，不随界面语言变。
	if (!tool) return [toolResult(call, { output: `没有名为 ${call.name} 的工具。`, isError: true })];

	let shown = "";
	let pushedAt = 0;
	const progress = (chunk: string) => {
		if (typeof chunk !== "string" || chunk === "") return;
		shown = (shown + chunk).slice(-PROGRESS_LIMIT);
		const push = Date.now() - pushedAt >= PROGRESS_INTERVAL_MS;
		if (push) pushedAt = Date.now();
		scope.progress(call.id, shown, push);
	};
	// 停下的那一刻在不在等人（审批或 `request`）：在等的那个还没动手。
	let asking = false;
	const waitFor = async <T>(wait: () => Promise<T>): Promise<T> => {
		asking = true;
		try {
			return await wait();
		} finally {
			// 因为停下才拿到答复的，留着这个标记；正常答复了就清掉。
			if (!signal.aborted) asking = false;
		}
	};
	const askWith = (content: ApprovalContent): Promise<ApprovalDecision> => waitFor(() => scope.ask({ toolCallId: call.id, tool: call.name, ...content }));
	/** `ToolRun.request`：不经 tool.approve、不看权限模式，直接排进等人的那一队。 */
	const request = async <T>(input: HumanRequestInput): Promise<HumanAnswer<T>> => {
		const { kind, title, payload, waiting } = (input ?? {}) as Partial<HumanRequestInput>;
		// i18n-exempt：给插件作者的报错，作为工具结果交给模型。
		if (typeof kind !== "string" || !kind || typeof title !== "string") throw new Error("run.request 需要 kind 和 title");
		const asked: HumanRequest = {
			type: "request",
			toolCallId: call.id,
			tool: call.name,
			kind,
			title,
			// 先克隆：要跨进程送到界面，送不了的在这里就报给插件；之后插件再改它也不影响卡上的。
			...(payload !== undefined ? { payload: structuredClone(payload) } : {}),
			...(typeof waiting === "string" && waiting ? { waiting } : {}),
		};
		return (await waitFor(() => scope.requestHuman(asked))) as HumanAnswer<T>;
	};
	// 插件的层自己要问时，卡片上是这个调用的参数和它给的理由；没有 subject，只能答这一次。
	const generic = { kind: call.name, title: call.name, detail: JSON.stringify(call.arguments, null, 2) };
	// 用到才读设置：不改动工作区的调用不等它，同一批同时跑的照调用的顺序开始。
	let read: ReturnType<ToolScope["permission"]> | undefined;
	const permission = () => (read ??= scope.permission());
	/**
	 * 要不要放行。权限模式的含义由本体定，换掉哪个插件都不变：
	 * - 提权（`escalation`，放宽沙箱）只能由人答：完全访问不替人点头，层答放行不算数、照样弹卡，层的拒绝照算；
	 * - 完全访问直接放行；
	 * - tool.execute 外层设了 `approved`、`subject` 答过「以后不再问」的直接放行；层自己问的（`byLayer`）没有 `subject`，不归这两条；
	 * - 其余经钩子 tool.approve（插件替人答、帮我批准的风险规则在那里），最里层把审批卡弹给人。
	 * `from` 是这时的调用（外层可能改过参数、设了 approved）。
	 */
	const approve = async (from: ToolExecution, request: ApprovalContent, byLayer: boolean): Promise<ApprovalDecision> => {
		const { mode, alwaysAllow } = await permission();
		const humanOnly = request.escalation !== undefined;
		if (!humanOnly && mode === "full") return "once";
		if (!humanOnly && !byLayer && (from.approved || (request.subject !== undefined && alwaysAllow.includes(request.subject)))) return "once";
		let asked = false;
		const decision = await scope.host.run(
			"tool.approve",
			{
				sessionId: from.sessionId,
				session: structuredClone(scope.session),
				cwd: from.cwd,
				...(scope.scratchDirs ? { scratchDirs: scope.scratchDirs() } : {}),
				call: from.call,
				tool: from.tool,
				request,
				...(byLayer ? { byLayer: true } : {}),
				permissionMode: mode,
				signal: from.signal,
			},
			async (approval) => {
				asked = true;
				return await askWith(approval.request);
			},
		);
		// i18n-exempt：抛出去会作为工具结果交给模型。
		if (decision !== "once" && decision !== "always" && decision !== "reject") throw new Error(`tool.approve 给的结论不认得：${String(decision)}`);
		if (humanOnly && !asked && decision !== "reject") return await askWith(request);
		return decision;
	};
	const execution: ToolExecution = {
		sessionId: scope.sessionId,
		session: structuredClone(scope.session),
		cwd: scope.cwd,
		call: { id: call.id, name: call.name, args: call.arguments },
		tool: { name: tool.definition.name, mutating: tool.definition.mutating === true, plugin: tool.plugin },
		signal,
		ask: async (reason) => (await approve(execution, { ...generic, reason: String(reason) }, true)) !== "reject",
		progress,
	};
	/*
	 * 最里层：执行工具，动手前问。本体只定哪些要问：写了 `asks` 的工具在 execute 里校验完参数再经 `run.ask` 问
	 * （问什么它最清楚），其余会改动工作区的在执行前按参数问。问的都经 `approve`：权限模式的放行在本体，剩下的经钩子
	 * tool.approve（内置插件 plume.approval 在帮我批准下按风险规则放行），最里层把审批卡弹给人。
	 * 工具抛错转成错误结果，这样外层（比如脱敏）照样能处理它。
	 */
	const execute = async (input: ToolExecution): Promise<ToolOutput> => {
		// 父会话和寄信只在这次调用里给：调用答完以后插件留着的句柄一用就抛错，免得之后随时往别的会话里排活、寄信。
		let open = true;
		const alive = (what: string) => {
			if (!open) throw new Error(text("session.callEnded", { what }));
		};
		try {
			const ask = (content: ApprovalContent) => approve(input, content, false);
			const parent = boundParent(scope.parent?.(tool.plugin), alive);
			const allowedPaths = (await scope.allowedPaths?.()) ?? [];
			const commands = scope.commands({ cwd: input.cwd, readOnly: Boolean(input.readOnly), permission: async () => (await permission()).mode, ask, alive });
			const run: ToolRun = {
				sessionId: input.sessionId,
				session: structuredClone(scope.session),
				toolCallId: call.id,
				cwd: input.cwd,
				scratchDir: scope.scratchDir,
				...(scope.scratchDirs ? { scratchDirs: scope.scratchDirs() } : {}),
				projectRoots: scope.projectRoots,
				...(allowedPaths.length > 0 ? { allowedPaths } : {}),
				signal: input.signal,
				progress: input.progress,
				ask,
				request,
				permissionMode: async () => (await permission()).mode,
				...commands,
				files: scope.files({
					sessionId: input.sessionId,
					cwd: input.cwd,
					scratchDir: scope.scratchDir,
					...(scope.projectRoots ? { projectRoots: scope.projectRoots } : {}),
					...(allowedPaths.length > 0 ? { allowedPaths } : {}),
					signal: input.signal,
					shell: commands.shell,
					ask,
					alive,
				}),
				tools: () => scope.host.toolOwners(),
				calls: step.map((sibling) => ({ id: sibling.id, name: sibling.name, args: sibling.arguments })),
				...(input.readOnly ? { readOnly: true } : {}),
				...(scope.background ? { background: () => scope.background!(tool.plugin, call.id) } : {}),
				track: (job: BackgroundJobInput) => {
					alive("ToolRun.track");
					return scope.track(tool.plugin, call.id, job);
				},
				...(scope.schedule
					? {
							schedule: (wake: WakeupInput) => {
								alive("ToolRun.schedule");
								return scope.schedule!(tool.plugin, call.id, wake);
							},
						}
					: {}),
				...(scope.letter
					? {
							letter: (to: string, letter: LetterInput) => {
								alive("ToolRun.letter");
								return scope.letter!(tool.plugin, to, letter);
							},
						}
					: {}),
				...(scope.archiveAfterTurn ? { archiveAfterTurn: () => scope.archiveAfterTurn!() } : {}),
				...(parent ? { parent } : {}),
			};
			// i18n-exempt：工具结果是发给模型的，不随界面语言变。
			if (tool.definition.mutating && !tool.definition.asks && (await ask({ ...generic, subject: call.name })) === "reject")
				return { output: `The user rejected this call. ${DECLINED}`, isError: true };
			return await tool.definition.execute(input.call.args, run);
		} catch (error) {
			// i18n-exempt：工具结果是发给模型的，不随界面语言变。
			return {
				output: signal.aborted ? `${CANCELLED_RUNNING}${shown ? `\nOutput so far:\n${shown}` : ""}` : `工具执行失败：${errorText(error)}`,
				isError: true,
			};
		} finally {
			open = false;
		}
	};

	/*
	 * 外层要求只读（`ToolExecution.readOnly`）以后，写、改文件的工具到此为止：不再往里交（里层的钩子也不会为一次注定不跑的调用去问人），
	 * 结果就是设它的那一层给的说明。按工具声明的种类认，不认工具名。别的调用照常往里交，命令由 `run.exec` 压进只读沙箱。
	 */
	const readOnlyStop = (input: ToolExecution): ToolOutput | undefined => {
		if (!input?.readOnly) return undefined;
		const kind = scope.host.tool(input.call.name)?.definition.kind;
		return kind === "create" || kind === "modify" ? { output: String(input.readOnly.refusal), isError: true } : undefined;
	};

	// i18n-exempt：工具结果是发给模型的，不随界面语言变。
	const startedAt = Date.now();
	try {
		scope.started(call.id);
		let result = await scope.host.run("tool.execute", execution, execute, canonicalHandoff(tool.definition.aliases), readOnlyStop);
		if (typeof result?.output !== "string") throw new Error("tool.execute 返回的结果没有 output");
		if (result.images !== undefined && !(Array.isArray(result.images) && result.images.every(validImage)))
			throw new Error("tool.execute 返回的 images 不是 { data, mimeType } 的数组");
		if (result.shownImages !== undefined && !(Array.isArray(result.shownImages) && result.shownImages.every(validImage)))
			throw new Error("tool.execute 返回的 shownImages 不是 { data, mimeType } 的数组");
		if (result.details !== undefined) result = { ...result, details: storable(result.details, call, scope) };
		// 人按了停才失败的，照实说是停下的；审批层在停下时只会说「拒绝」，那不是人的意思。
		if (signal.aborted && result.isError === true) {
			return [
				relayed(
					toolResult(
						call,
						asking
							? { output: CANCELLED_WAITING, isError: true, details: { cancelled: true } satisfies CancelledDetails }
							: { ...result, details: result.details ?? ({ cancelled: true } satisfies CancelledDetails) },
						startedAt,
					),
					scope.answeredBy?.(call.id),
				),
			];
		}
		return [
			relayed(toolResult(call, result, startedAt), scope.answeredBy?.(call.id)),
			result.terminate === "done" || result.terminate === "stalled" ? result.terminate : undefined,
		];
	} catch (error) {
		scope.log("agent", "error", errorText(error));
		return [relayed(toolResult(call, { output: `没有执行：${errorText(error)}`, isError: true }, startedAt), scope.answeredBy?.(call.id))];
	} finally {
		scope.progress(call.id, undefined, false);
	}
}

/** 父会话的句柄，每次用之前先看这次调用还在不在。 */
function boundParent(parent: ParentSession | undefined, alive: (what: string) => void): ParentSession | undefined {
	if (!parent) return undefined;
	const what = "ToolRun.parent";
	return {
		id: parent.id,
		enqueue: async (instruction) => {
			alive(what);
			return parent.enqueue(instruction);
		},
		stop: async (options) => {
			alive(what);
			return parent.stop(options);
		},
		carryOn: async (words) => {
			alive(what);
			return parent.carryOn(words);
		},
		status: () => {
			alive(what);
			return parent.status();
		},
	};
}
