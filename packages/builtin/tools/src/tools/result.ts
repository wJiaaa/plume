import type { ToolContext, ToolResult } from "./types.ts";

/** 参数不对、文件不在这类问题作为错误结果交给模型，让它自己改正。 */
export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** 人拒绝了：交回本体给的那句（说清楚别换个办法再做一遍），不自己另写。 */
export function declinedResult(ctx: Pick<ToolContext, "rejection">): ToolResult {
	return errorResult(ctx.rejection);
}
