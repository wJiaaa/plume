/**
 * agent 循环：一轮从用户消息开始，一步一次模型请求加它要的工具，直到模型不再调用工具。
 *
 * 循环守会让会话坏掉的几条线：每个工具调用都要有结果、步数有上限、停下就停下、历史放得进窗口
 * （太满了先压缩；服务商嫌超长就压一次再发，拒收就把过大的工具结果剪成一行再发，各只一次）。
 * 每一步收尾时的自然结论也在本体：截断了接着写、空回复催一句（`recovery.ts`），原地打转时提醒换个思路
 * （`repetition.ts`）。插件经 `step.end` 包在它外面，可以改写或整个换掉它，但只能让循环多跑几步、
 * 给结束换个原因，拦不下本来要跑的那一步，出错和用户停止也轮不到它说话。
 */

import type { Log, ModelContext, NoticeLevel, StepEnd, StepVerdict, TurnStop } from "@plume/contract";
import { isContextOverflow } from "@plume/llm/failure";
import type { AssistantMessage, Message, ToolCallContent, ToolResultMessage } from "@plume/llm/types";
import { errorText, type PluginHost } from "./host.ts";
import { text } from "./i18n.ts";
import { Recovery } from "./recovery.ts";
import type { RepetitionWatch } from "./repetition.ts";
import { CUT_WHILE_ARRIVING, failCalls, isArgumentsLost, runTools, STOPPED_BEFORE_RUN, type ToolScope, TRUNCATED_CALL } from "./tool-run.ts";

/** 一轮里最多调几次模型，防止模型陷在工具调用里停不下来。 */
const MAX_STEPS = 200;
/** 连着这么多步都在工具参数写到一半时撞上输出上限，再让它拆小也没用了。 */
const MAX_TRUNCATED_STEPS = 3;
const MAX_LOST_ROUNDS = 3;

export interface TurnScope {
	sessionId: string;
	session: ToolScope["session"];
	cwd: string;
	projectRoots?: readonly string[];
	allowedPaths?: ToolScope["allowedPaths"];
	scratchDir: ToolScope["scratchDir"];
	scratchDirs?: ToolScope["scratchDirs"];
	signal: AbortSignal;
	host: PluginHost;
	log: Log;
	repetition: RepetitionWatch;
	/** 组这一次请求的上下文（经 model.context）。 */
	context(): Promise<ModelContext>;
	/** 完整工具结果之后、下一请求之前消费插话和后台结果，返回是否写入了消息。 */
	boundary(): Promise<boolean>;
	/** 发一次请求，等它落定；还什么都没说时人换了模型，放手返回 `"switched"`。 */
	request(context: ModelContext): Promise<AssistantMessage | "switched">;
	/** 一条消息写进会话。 */
	commit(message: Message): Promise<void>;
	/** 在界面上说一句：不给 level 的写在输入框上面（钩子出错之类），给了的进提示条。 */
	notice(text: string, level?: NoticeLevel): void;
	/** 太满了就压缩一次；`force` 是超长恢复，不管多满都压。压了返回 true。 */
	compact(context: ModelContext, force: boolean): Promise<boolean>;
	/** 拒收恢复：把过大的工具结果剪成一行。剪了返回 true。 */
	withhold(): Promise<boolean>;
	permission: ToolScope["permission"];
	ask: ToolScope["ask"];
	requestHuman: ToolScope["requestHuman"];
	started: ToolScope["started"];
	progress: ToolScope["progress"];
	background?: ToolScope["background"];
	letter?: ToolScope["letter"];
	archiveAfterTurn?: ToolScope["archiveAfterTurn"];
	parent?: ToolScope["parent"];
}

/** 跑完一轮，返回它为什么结束。抛错（钩子出错、没配模型）由调用方当作出错收场。 */
export async function runSteps(scope: TurnScope): Promise<TurnStop> {
	const tools: ToolScope = scope;
	const recovery = new Recovery();
	let lostRounds = 0;
	for (let step = 1; step <= MAX_STEPS; step++) {
		if (scope.signal.aborted) return { reason: "aborted" };
		await scope.boundary();
		if (scope.signal.aborted) return { reason: "aborted" };
		const reply = await requestReply(scope);
		await scope.commit(reply);
		const calls = reply.content.filter((block): block is ToolCallContent => block.type === "toolCall");

		if (reply.stopReason === "aborted" || reply.stopReason === "error") {
			// 断开时开了头的调用必须有回答，否则之后每个请求都撞同一个 400；参数写到一半的不执行。
			const stopped = reply.stopReason === "aborted";
			await commitAll(scope.commit, failCalls(calls, stopped ? STOPPED_BEFORE_RUN : CUT_WHILE_ARRIVING, stopped));
			return stopped ? { reason: "aborted" } : { reason: "error", ...(reply.errorMessage ? { error: reply.errorMessage } : {}) };
		}
		const truncated = recovery.observe(reply);
		const results: ToolResultMessage[] = [];
		const keep = async (message: Message) => {
			if (message.role === "toolResult") results.push(message);
			await scope.commit(message);
		};
		if (calls.length > 0 && reply.stopReason === "length") {
			// 撞上输出上限时参数可能能解析但缺字段：判失败让它拆小重发，连续几次还撞就停下说出来。
			await commitAll(keep, failCalls(calls, TRUNCATED_CALL));
			if (truncated > MAX_TRUNCATED_STEPS) return { reason: "error", error: text("loop.truncatedCalls") };
		} else if (calls.length > 0) {
			const terminate = await runTools(calls, tools, keep);
			if (scope.signal.aborted) return { reason: "aborted" };
			// 工具说到此为止（原地打转了之类）：结果都写进会话了，不再交给模型。
			if (terminate) return { reason: terminate };
		}
		if (scope.signal.aborted) return { reason: "aborted" };
		if (results.length > 0) {
			const lost = results.some(isArgumentsLost);
			lostRounds = lost ? lostRounds + 1 : 0;
			if (lostRounds >= MAX_LOST_ROUNDS) return { reason: "error", error: text("loop.argumentsLost") };
			if (!lost) {
				scope.repetition.observe(calls, results);
				if (scope.repetition.exhausted()) {
					scope.notice(text("loop.stalled"), "warn");
					return { reason: "stalled" };
				}
			}
		}

		// 先取走：插件换掉自然结论时，这句也不该留到下一步。
		const hint = scope.repetition.takeHint();
		// 只算一次：外层调过 `next` 又出错时退回的是同一个结论，催促的次数不多数一回。
		let decided: StepVerdict | undefined;
		const natural = (input: StepEnd): StepVerdict =>
			(decided ??=
				results.length > 0
					? withHint(withHint({ continue: true }, hint), recovery.progress(reply, input.progress))
					: recovery.verdict(reply, scope.notice, awaitingNudge(input)));
		const verdict = await stepEnd(scope, { step, stepsLeft: MAX_STEPS - step, reply, toolResults: results }, natural);
		if (results.length > 0) {
			// 还有工具结果没交给模型：插件说停也不停，结果总得有人读。
			if (verdict.continue && verdict.say) await scope.commit(said(verdict.say));
			continue;
		}
		// 最后一步也要看收件箱：等钩子时刚送到的消息不能跟着自然完成一起丢掉。
		const received = await scope.boundary();
		if (scope.signal.aborted) return { reason: "aborted" };
		if (received) continue;
		if (!verdict.continue) return { reason: verdict.reason ?? "done", ...(verdict.error ? { error: verdict.error } : {}) };
		// 本来要结束了还要接着做，得有一句话：以模型自己的回复结尾的请求，带思考的模型不接受。
		if (!verdict.say) {
			scope.log("agent", "warn", `会话 ${scope.sessionId} 的 step.end 要接着做却没给 say，按结束处理`);
			return { reason: "done" };
		}
		await scope.commit(said(verdict.say));
	}
	return { reason: scope.signal.aborted ? "aborted" : "max_turns" };
}

/**
 * 一次请求，服务商不收时各恢复一次：拒收（超长也算）先剪掉过大的工具结果再发，这最便宜；还是超长就压缩一次再发。重发的不再回到这里，
 * 恢复不了的照原样交回（写进会话，这一轮以出错结束）。失败的那条在恢复成功时不写进会话。
 */
async function requestReply(scope: TurnScope): Promise<AssistantMessage> {
	// 换了模型放手的那次什么都没做，不算一步：从组上下文、看要不要压缩起整个重来，新模型的窗口可能小一些。
	while (true) {
		const reply = await attempt(scope);
		if (reply !== "switched") return reply;
	}
}

async function attempt(scope: TurnScope): Promise<AssistantMessage | "switched"> {
	let context = await scope.context();
	if (await scope.compact(context, false)) context = await scope.context();
	let reply = await scope.request(context);
	if (reply === "switched") return reply;
	if (rejected(reply) && !scope.signal.aborted && (await scope.withhold())) {
		scope.notice(text("loop.requestRejected"), "warn");
		reply = await scope.request(await scope.context());
		if (reply === "switched") return reply;
	}
	if (reply.stopReason === "error" && isContextOverflow(reply.failure) && !scope.signal.aborted) {
		scope.notice(text("loop.contextOverflow"), "warn");
		if (await scope.compact(await scope.context(), true)) reply = await scope.request(await scope.context());
	}
	return reply;
}

/** 服务商不接受这样发的请求：401、404、429 不会因为历史变小就好，只认分类里「请求本身」那一类。 */
function rejected(reply: AssistantMessage): boolean {
	return reply.stopReason === "error" && !reply.errorRetryable && reply.failure?.hint === "check-request";
}

/**
 * 问插件这一步之后怎么走。最里层是自然结论：有工具结果就接着做，没有的看要不要续写、催一句，再带上重复提醒。
 * 钩子出错时按自然结论走：它只能让循环多做，退回默认不会放过什么。
 */
async function stepEnd(
	scope: TurnScope,
	step: Pick<StepEnd, "step" | "stepsLeft" | "reply" | "toolResults">,
	natural: (input: StepEnd) => StepVerdict,
): Promise<StepVerdict> {
	// 给副本：写进会话的那几条不该被插件改掉。
	const input: StepEnd = {
		sessionId: scope.sessionId,
		session: structuredClone(scope.session),
		cwd: scope.cwd,
		...structuredClone(step),
		signal: scope.signal,
	};
	try {
		const verdict = verdictOf(await scope.host.run("step.end", input, async (current) => natural(current)));
		// 层调了 `next` 却忘了把结论交回（返回 undefined）、给了不认得的原因：和抛错一样按自然结论走，不让整轮以出错收场。
		if (!verdict) throw new Error(text("loop.badStepVerdict"));
		return verdict;
	} catch (error) {
		scope.log("agent", "error", `会话 ${scope.sessionId} 的 step.end 出错：${errorText(error)}`);
		scope.notice(errorText(error));
		return natural(input);
	}
}

/** 认得的结论才放行：`say` 只能是一句话，结束的原因只有出错和卡住两种。认不得返回 undefined。 */
function verdictOf(value: unknown): StepVerdict | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { continue: going, say, reason, error } = value as Record<string, unknown>;
	if (going === true) {
		if (say === undefined) return { continue: true };
		return typeof say === "string" && say.trim() ? { continue: true, say } : undefined;
	}
	if (going !== false || (reason !== undefined && reason !== "error" && reason !== "stalled") || (error !== undefined && typeof error !== "string"))
		return undefined;
	return { continue: false, ...(reason === undefined ? {} : { reason }), ...(error ? { error } : {}) };
}

/** 插件给的「还在等后台」时的催促；不是一句话就当没给。 */
function awaitingNudge(input: StepEnd): string | undefined {
	const nudge: unknown = input.awaiting?.nudge;
	return typeof nudge === "string" && nudge.trim() ? nudge : undefined;
}

function withHint(verdict: StepVerdict, hint: string | undefined): StepVerdict {
	if (!hint || !verdict.continue) return verdict;
	return { continue: true, say: verdict.say ? `${verdict.say}\n\n${hint}` : hint };
}

/** 收尾时要对模型说的话（续写、催促、插件给的）：以用户的身份说，界面不当成人打的字。 */
function said(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), synthetic: true };
}

async function commitAll(commit: (message: Message) => Promise<void>, results: ToolResultMessage[]): Promise<void> {
	for (const result of results) await commit(result);
}
