/**
 * 折进头里的那段碰过哪些文件（`RetiredHistory.files`）和兜底摘要里的文件、关键动作：改过的只认本体记在结果上的 `ToolResultMessage.changes`。
 */

import type { Message, ToolResultMessage } from "@plume/contract";
import { expect, it } from "vitest";
import { RetiredHistory } from "../src/head.ts";
import { fallbackSummary } from "../src/summary.ts";
import { kindOf, reply, toolResult } from "./helpers.ts";

const call = (id: string, name: string, args: Record<string, unknown>): Message => reply([{ type: "toolCall", id, name, arguments: args }]);
const changed = (message: ToolResultMessage, paths: string[]): ToolResultMessage => ({ ...message, changes: { ids: [message.toolCallId], paths } });

const history: Message[] = [
	call("r", "read", { path: "src/read.ts" }),
	toolResult("r", "…", "read"),
	call("e", "edit", { path: "src/a.ts", old_string: "x", new_string: "y" }),
	changed(toolResult("e", "ok", "edit"), ["/repo/src/a.ts"]),
	// 参数里写着路径、却没改成：不算改过。
	call("f", "edit", { path: "src/missed.ts", old_string: "x", new_string: "y" }),
	toolResult("f", "not found", "edit"),
	// 命令改的文件在参数里看不出来，结果上记着。
	call("b", "bash", { command: "pnpm fmt" }),
	changed(toolResult("b", "done"), ["/repo/src/b.ts", "/elsewhere/c.ts"]),
];

it("改过的按结果上记下的列，工作目录里的写成相对路径；读过的按声明了 view 的工具的参数列", () => {
	const retired = new RetiredHistory(kindOf, "/repo");
	for (const message of history) retired.add(message);
	expect(retired.files()).toEqual({ read: ["src/read.ts"], changed: ["src/a.ts", "src/b.ts", "/elsewhere/c.ts"] });
});

it("兜底摘要：碰过的文件和关键动作里改了哪个文件也认结果上记下的", () => {
	const summary = fallbackSummary(history, kindOf, "/repo");
	expect(summary).toContain("- Touched files: src/read.ts, src/a.ts, src/b.ts, /elsewhere/c.ts");
	expect(summary).toContain("- edit src/a.ts\n- edit\n- bash: pnpm fmt");
	expect(summary).not.toContain("missed");
});
