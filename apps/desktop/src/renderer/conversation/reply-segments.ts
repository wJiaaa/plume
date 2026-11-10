/**
 * 一条回复按段画：连着的调用一段，连着的推理一段，其余每块一段。
 */

import type { AssistantMessage } from "@plume/contract";
import type { ToolCallBlock } from "./grouping.ts";

type Block = AssistantMessage["content"][number];
type ThinkingBlock = Extract<Block, { type: "thinking" }>;

export type Segment =
	/** `last`：这一段在 `content` 里的最后一块。推理并了几块时它不是 `index`，「还在写」要问它。 */
	{ kind: "block"; block: Exclude<Block, ToolCallBlock>; index: number; last: number } | { kind: "tools"; blocks: ToolCallBlock[] };

/**
 * 回复切成调用的段和其余的。两次调用中间的话是段落的分界：模型停下来解释，正是读者用的那条边界。
 *
 * 挨着的推理并成一块：有的接口一次响应里能连出十几块推理，一块一行就是一串「思考了 3 秒」。
 */
export function segments(content: readonly Block[]): Segment[] {
	const out: Segment[] = [];
	for (const [index, block] of content.entries()) {
		const last = out[out.length - 1];
		if (block.type === "toolCall") {
			if (last?.kind === "tools") last.blocks.push(block);
			else out.push({ kind: "tools", blocks: [block] });
		} else if (block.type === "thinking" && last?.kind === "block" && last.block.type === "thinking" && last.last === index - 1) {
			last.block = joinThoughts(last.block, block);
			last.last = index;
		} else out.push({ kind: "block", block, index, last: index });
	}
	return out;
}

/** 两段推理并成一段：字按顺序接，时长相加，从第一段开始算起。并出来的是新对象，消息里的块不动。 */
function joinThoughts(a: ThinkingBlock, b: ThinkingBlock): ThinkingBlock {
	const thinking = [a.thinking, b.thinking].filter(Boolean).join("\n\n");
	const startedAt = a.startedAt ?? b.startedAt;
	return {
		type: "thinking",
		thinking,
		redacted: !thinking && (a.redacted === true || b.redacted === true),
		...(startedAt === undefined ? {} : { startedAt }),
		...(a.durationMs === undefined && b.durationMs === undefined ? {} : { durationMs: (a.durationMs ?? 0) + (b.durationMs ?? 0) }),
	};
}

/**
 * 这一块是不是被同一条回复里的最终答复重说过了。
 *
 * Responses 的模型在一次回复里先发几段 `commentary`（「已收到…」「我会等…」），收尾再发一段 `final_answer`，而最终答复按设计
 * 要能单独读懂，会把前面播报的原样再写一遍：两段都画，界面上就是整段话说两遍。只在同一条消息里有写了字的 `final_answer` 时才算：
 * 调工具前的那句播报后面跟的是工作不是答复，它就是这一步唯一的一句话；答复刚开头、还一个字没有时也先留着播报，不让正文空一下。
 * 没有 `phase` 的块一律不算。
 */
export function restated(block: Block, content: readonly Block[]): boolean {
	if (block.type !== "text" || block.phase !== "commentary") return false;
	return content.some((other) => other.type === "text" && other.phase === "final_answer" && other.text.trim() !== "");
}
