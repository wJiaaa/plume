/**
 * 一个编辑任务，用一个模型、一种格式跑一次。
 *
 * 流程照 agent 实际的做法：模型调 `edit`，应用器要么落下它，要么把错误交回去，模型再来一次。最多三次——大约到这里，
 * 真实会话就不再有用，人会接手。
 *
 * 头条数字是**第一次**就成功。三次之内的任何指标都会抬高「失败得可恢复」的格式，而可恢复的失败照样每次让用户多等一个来回。
 *
 * 结果分类而不是只分对错，因为各类意味着不同的事：`wrong-result` 是文件被悄悄改坏，比 `apply-failed` 糟得多——
 * 后者至少模型自己知道。
 */

import { streamAssistant } from "../../packages/core/llm/src/ai/index.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../../packages/core/llm/src/types.ts";
import type { EditCase } from "./cases.ts";
import type { EditFormat } from "./formats.ts";

type Outcome =
	| "pass"
	/** 模型一个工具调用都没有。 */
	| "no-call"
	/** 参数解析不了，或结构不对。 */
	| "bad-args"
	/** 应用器拒了：锚点找不到、不唯一。 */
	| "apply-failed"
	/** 应用得很顺，结果却不对。最危险的那种。 */
	| "wrong-result"
	/** 服务商或评测自己出错。 */
	| "error";

interface AttemptRecord {
	outcome: Outcome;
	detail?: string;
	outputTokens: number;
	elapsedMs: number;
	/**
	 * 模型实际写出的参数。
	 *
	 * 记下来是因为「格式失败了」不是结论——结论是模型写了什么。不记的话，严格的解析器和糊涂的模型在数字上一模一样。
	 */
	args?: Record<string, unknown>;
}

export interface CaseResult {
	caseId: string;
	scenario: EditCase["scenario"];
	formatId: string;
	modelId: string;
	/** 第一次调用就得到了一字不差的文件？ */
	firstAttemptPass: boolean;
	/** 几次里有没有一次得到了？ */
	eventualPass: boolean;
	attempts: AttemptRecord[];
	totalOutputTokens: number;
	totalElapsedMs: number;
	/** 第一次的结果，失败分布按它统计。 */
	firstOutcome: Outcome;
}

const SYSTEM_PROMPT = `You are a code editing assistant. You are shown one file and asked to make one change.

- Make exactly the change requested. Change nothing else — not whitespace, not surrounding lines.
- Call the \`edit\` tool once. Do not explain, do not ask questions.
- Preserve the file's existing indentation style (this file uses tabs where you see them).`;

const MAX_ATTEMPTS = 3;

function toolCallsOf(message: AssistantMessage | undefined): { id: string; name: string; arguments: Record<string, unknown> }[] {
	const out: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
	for (const block of message?.content ?? []) {
		if (block.type !== "toolCall") continue;
		out.push({ id: block.id, name: block.name, arguments: (block.arguments ?? {}) as Record<string, unknown> });
	}
	return out;
}

async function callModel(
	provider: ProviderConfig,
	model: ModelConfig,
	messages: Message[],
	format: EditFormat,
): Promise<{ message: AssistantMessage; elapsedMs: number }> {
	const started = Date.now();
	const stream = streamAssistant(
		provider,
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages, tools: [format.spec] },
		{ maxTokens: 4096, retryAttempts: 3, temperature: 0 },
	);
	while (true) {
		const next = await stream.next();
		if (next.done) return { message: next.value, elapsedMs: Date.now() - started };
	}
}

export async function runCase(testCase: EditCase, format: EditFormat, provider: ProviderConfig, model: ModelConfig): Promise<CaseResult> {
	const rendered = format.renderFile(testCase.path, testCase.before);

	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: `${rendered}\n\n${testCase.instruction}` }],
			timestamp: Date.now(),
		},
	];

	const attempts: AttemptRecord[] = [];
	let eventualPass = false;

	for (let attempt = 0; attempt < MAX_ATTEMPTS && !eventualPass; attempt++) {
		let outcome: Outcome = "error";
		let detail: string | undefined;
		let outputTokens = 0;
		let elapsedMs = 0;
		let feedback: string | null = null;
		let seenArgs: Record<string, unknown> | undefined;

		try {
			const { message, elapsedMs: took } = await callModel(provider, model, messages, format);
			elapsedMs = took;
			outputTokens = message.usage?.output ?? 0;
			messages.push(message);
			if (message.stopReason === "error") throw new Error(message.errorMessage ?? "request failed");

			const calls = toolCallsOf(message).filter((c) => c.name === "edit");
			if (calls.length === 0) {
				outcome = "no-call";
				const said = message.content.find((c) => c.type === "text");
				detail = said?.type === "text" ? said.text.slice(0, 160) : "(no text)";
			} else {
				const call = calls[0]!;
				seenArgs = call.arguments;
				const result = await format.apply(call.arguments, testCase.before);
				if (!result.ok) {
					// 分开「参数连形状都不对」和「编辑形状没错、只是对不上文件」：两者要的修法不同。
					const structural =
						/must be a string|must both be strings|is required|non-empty array|unknown op|needs numeric|no operations|unrecognised line|no preceding operation/.test(
							result.error ?? "",
						);
					outcome = structural ? "bad-args" : "apply-failed";
					detail = result.error;
					feedback = `The edit failed: ${result.error}\nTry again.`;
				} else if (result.content === testCase.after) {
					outcome = "pass";
					eventualPass = true;
				} else {
					outcome = "wrong-result";
					detail = firstDifference(result.content ?? "", testCase.after);
					feedback = `The edit applied but produced the wrong result. ${detail}\nTry again.`;
				}

				// 同一条回复里的每个调用都要有结果，否则下一次请求会被服务商拒掉；只判第一个，其余的照实说没执行。
				for (const [index, each] of calls.entries()) {
					messages.push({
						role: "toolResult",
						toolCallId: each.id,
						toolName: "edit",
						content: [{ type: "text", text: index === 0 ? (feedback ?? "Applied.") : "Not applied: only the first edit call is used." }],
						isError: index === 0 ? feedback !== null : true,
						timestamp: Date.now(),
					});
				}
			}

			if (outcome === "no-call") {
				messages.push({ role: "user", content: [{ type: "text", text: "You did not call the edit tool. Call it now." }], timestamp: Date.now() });
			}
		} catch (error) {
			outcome = "error";
			detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
		}

		attempts.push({ outcome, detail, outputTokens, elapsedMs, args: seenArgs });
		// 请求本身失败时上下文已不完整（回复里可能有没答的调用），再试只会撞同一堵墙。
		if (outcome === "error") break;
	}

	return {
		caseId: testCase.id,
		scenario: testCase.scenario,
		formatId: format.id,
		modelId: model.id,
		firstAttemptPass: attempts[0]?.outcome === "pass",
		eventualPass,
		attempts,
		totalOutputTokens: attempts.reduce((sum, a) => sum + a.outputTokens, 0),
		totalElapsedMs: attempts.reduce((sum, a) => sum + a.elapsedMs, 0),
		firstOutcome: attempts[0]?.outcome ?? "error",
	};
}

/** 产出的文件从哪里开始和预期不同，用模型能照着改的话说。 */
function firstDifference(got: string, want: string): string {
	const g = got.split("\n");
	const w = want.split("\n");
	for (let i = 0; i < Math.max(g.length, w.length); i++) {
		if (g[i] !== w[i]) {
			return `Line ${i + 1} is ${JSON.stringify(g[i] ?? "(missing)")} but should be ${JSON.stringify(w[i] ?? "(should not exist)")}.`;
		}
	}
	return "Files differ only in trailing whitespace.";
}
