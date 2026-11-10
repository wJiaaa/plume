/**
 * 摘要请求从主请求分叉：上一次请求原样再发一遍，末尾多一条指令（`ModelCompletion.fork`）。
 *
 * 压缩的那一下往往是整段对话里最贵的一次请求——上下文快满了，摘要请求要是对不上缓存，十几万 token 就按原价重读一遍。独立的摘要请求
 * （自己的系统提示词、不带工具、改写过的历史）从第一个 token 起就对不上；分叉请求的工具、系统提示词、思考档位、缓存键和消息都和上一次
 * 一样，只在末尾往后接，缓存照常命中，模型看到的也是没剪过的完整历史。
 *
 * 只在三件事都成立时走这条路，否则退回独立请求（`summary.ts` 的 `summarize`）：
 *
 * - 同一个模型。缓存按模型分，上一次请求之后换了模型，就没有可读的前缀。
 * - 缓存还热。凉了的话分叉读不到任何东西，还要按完整历史付原价——比剪短后的独立请求更贵。
 * - 放得下。完整历史加指令加摘要要在窗口以内；超长恢复那条路本来就放不下，宿主不给 `lineage`。
 *
 * 前缀由宿主在发出前核对（请求体切段后和上一次比），对不上就不发、抛错，这里退回独立请求。
 */

import type { ContextCompact, Message, ToolSpec } from "@plume/contract";
import { type BudgetModel, summaryReplyTokens } from "./budget.ts";
import type { Models, Observer } from "./models.ts";
import { forkInstruction, hasSummary } from "./prompts.ts";
import { measureTotal, textTokens, toolTokens } from "./tokens.ts";

/**
 * 离上一次请求开始多久以内算缓存还热，宿主不知道这家服务商的规则时的默认值。常见服务商里最短的有效期是 Anthropic 默认的 5 分钟，
 * 留一成余量。别家留得更久，超过这条线时它们的缓存多半还在——但那时退回的独立请求不会比不分叉更贵。
 */
export const FORK_HOT_MS = 270_000;

export type Lineage = NonNullable<ContextCompact["lineage"]>;

/** 分叉起点能不能用：同一个模型、缓存还热。放不放得下在 `forkSummary` 里按实际请求算。 */
export function forkable(lineage: Lineage | undefined, modelId: string, now = Date.now()): lineage is Lineage {
	if (!lineage || lineage.model !== modelId) return false;
	return now - lineage.at <= (lineage.cacheHotMs ?? FORK_HOT_MS);
}

/** 分叉出去的那份请求要接的历史和开销：下一次要发的那份（`ContextCompact.request`）。 */
export interface ForkBase {
	messages: Message[];
	systemPrompt: string;
	tools: readonly ToolSpec[];
}

/** 拿到一份摘要；没分叉成（放不下、前缀对不上、失败、调了工具、空回复）时交回 null，调用方退回独立请求。 */
export async function forkSummary(
	base: ForkBase,
	model: BudgetModel,
	models: Models,
	options: { instructions?: string; signal?: AbortSignal; observer?: Observer },
): Promise<string | null> {
	const prompt = forkInstruction(hasSummary(base.messages), options.instructions);
	/*
	 * 摘要要的位置和独立请求一样多（`summaryReplyTokens`）。不够就不发：发出去要么被拒、要么摘要写到一半被截断，两样都白付一整段
	 * 历史的钱。
	 */
	const total = measureTotal(base.messages);
	const input = total.tokens + textTokens(prompt) + (total.measured ? 0 : textTokens(base.systemPrompt) + toolTokens(base.tools));
	if (model.contextWindow - input < summaryReplyTokens(model)) return null;

	const { observer, signal } = options;
	try {
		const text = await models.fork({
			messages: base.messages,
			prompt,
			...(signal ? { signal } : {}),
			...(observer ? { onRetry: ({ delayMs }: { delayMs: number }) => observer.progress({ phase: "retrying", delayMs }) } : {}),
		});
		return text.trim() || null;
	} catch {
		return null;
	}
}
