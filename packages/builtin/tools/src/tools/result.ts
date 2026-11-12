import { DECLINED } from "../escalation.ts";
import type { ToolResult } from "./types.ts";

/** 参数不对、文件不在这类问题作为错误结果交给模型，让它自己改正。 */
export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/** 人拒绝了：说清楚别换个办法再做一遍。 */
export function declinedResult(text: string): ToolResult {
	return errorResult(`${text} ${DECLINED}`);
}
