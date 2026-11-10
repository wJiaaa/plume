/**
 * 压缩怎么够到模型：独立的摘要请求、从主请求分叉的请求，和报进度的那个口子。逻辑入口把它们接到 `ctx.model.complete` 和
 * `ContextCompact.progress` 上；测试换成假的，不用起模型就能看压缩切在哪、发了什么。
 */

import type { CompactionProgress, Message } from "@plume/contract";

/** 独立的摘要请求：自己的系统提示词，不带工具、不思考。`prompt` 是接在 `messages` 后面的那条指令。 */
export interface SummaryRequest {
	systemPrompt: string;
	messages: Message[];
	prompt: string;
	maxTokens: number;
	signal?: AbortSignal;
	onRetry?(info: { delayMs: number }): void;
}

/** 从主请求分叉的请求：系统提示词、工具、思考档位都照上一次主请求，`messages` 是下一次要发的历史，末尾接 `prompt`。 */
interface ForkRequest {
	messages: Message[];
	prompt: string;
	signal?: AbortSignal;
	onRetry?(info: { delayMs: number }): void;
}

/** 两种请求失败都抛错。 */
export interface Models {
	complete(request: SummaryRequest): Promise<string>;
	fork(request: ForkRequest): Promise<string>;
}

export interface Observer {
	signal?: AbortSignal;
	progress(event: CompactionProgress): void;
}

/** 手动压缩（`/compact`）报给人的那几句话，按界面语言。 */
export interface ManualWords {
	tooBig: string;
	cancelled: string;
	empty: string;
}
