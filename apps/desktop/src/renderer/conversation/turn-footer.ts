import type { Message } from "@plume/contract";
import { beforePlanTick } from "./turn-stop.ts";

/** 只有当前结束的回复拥有页脚；新一轮开始、停在工具结果上时不借用上一轮。 */
export function latestFooterTimestamp(transcript: readonly Message[], running: boolean): number | null {
	if (running) return null;
	const messages = beforePlanTick(transcript);
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at]!;
		if (message.role === "user" && message.synthetic) continue;
		return message.role === "assistant" && message.stopReason !== "pending" && message.stopReason !== "toolUse" ? message.timestamp : null;
	}
	return null;
}
