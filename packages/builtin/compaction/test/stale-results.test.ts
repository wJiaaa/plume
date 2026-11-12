/**
 * 被后来的观察顶替掉的结果：同一个文件换一种写法再读，也要认得出是同一个。
 */

import type { Message, ToolResultMessage } from "@plume/contract";
import { expect, it } from "vitest";
import { dropStaleResults } from "../src/stale-results.ts";
import { reply, textOf, toolResult } from "./helpers.ts";

const read = (id: string, path: string): Message => reply([{ type: "toolCall", id, name: "read", arguments: { path } }]);

const shown = (message: ToolResultMessage, totalLines: number): ToolResultMessage => ({
	...message,
	details: { kind: "text", path: "f.ts", totalLines, shownFrom: 1, shownTo: totalLines },
});

it("绝对路径和相对路径照样认得出是同一个文件", () => {
	const messages = [read("a", "/repo/src/a.ts"), toolResult("a", "abs ".repeat(80), "read"), read("b", "src/a.ts"), shown(toolResult("b", "rel", "read"), 40)];
	expect(textOf(dropStaleResults(messages, "/repo")[1]!)).toMatch(/superseded/);
});

it("同样的调用又跑了一次时早的那份清掉，标了要照着做的说明（`instructions`）的不清", () => {
	const load = (id: string): Message => reply([{ type: "toolCall", id, name: "skill", arguments: { name: "review" } }]);
	const body = "Follow these steps. ".repeat(40);
	const twice = (instructions: boolean) =>
		dropStaleResults([load("a"), { ...toolResult("a", body, "skill"), instructions }, load("b"), { ...toolResult("b", body, "skill"), instructions }], "/repo");
	expect(textOf(twice(false)[1]!)).not.toBe(body);
	expect(textOf(twice(true)[1]!)).toBe(body);
});
