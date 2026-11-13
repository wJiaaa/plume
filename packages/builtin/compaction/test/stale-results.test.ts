/**
 * 被后来的观察顶替掉的结果：同一个文件换一种写法再读，也要认得出是同一个；读了哪一块只认结果里的 `FileViewDetails`，
 * 改了哪些文件只认本体记在结果上的 `ToolResultMessage.changes`。
 */

import type { FileViewDetails, Message, ToolResultMessage } from "@plume/contract";
import { expect, it } from "vitest";
import { dropStaleResults } from "../src/stale-results.ts";
import { reply, textOf, toolResult } from "./helpers.ts";

const call = (id: string, name: string, args: Record<string, unknown>): Message => reply([{ type: "toolCall", id, name, arguments: args }]);
const read = (id: string, path: string): Message => call(id, "read", { path });

const viewed = (message: ToolResultMessage, view: FileViewDetails["fileView"]): ToolResultMessage => ({
	...message,
	details: { fileView: view } satisfies FileViewDetails,
});

it("绝对路径和相对路径照样认得出是同一个文件", () => {
	const messages = [
		read("a", "/repo/src/a.ts"),
		viewed(toolResult("a", "abs ".repeat(80), "read"), { path: "/repo/src/a.ts", verbatim: true }),
		read("b", "src/a.ts"),
		viewed(toolResult("b", "rel", "read"), { path: "/repo/src/a.ts", verbatim: true }),
	];
	expect(textOf(dropStaleResults(messages, "/repo")[1]!)).toBe(
		"[Earlier read of `src/a.ts` superseded by a later observation. The latest read, or the edit that replaced it, is below. Full text stays in the session — recall or read again if you need that snapshot.]",
	);
});

it("只盖住一部分、或者后来那次不是原文（大纲）时，早的那次读留着", () => {
	const early = (view: FileViewDetails["fileView"]) => [read("a", "a.ts"), viewed(toolResult("a", "old ".repeat(80), "read"), view)];
	// 参数和早的那次不同：同样的调用另按重复清，这里只看「盖没盖住」。
	const late = (view: FileViewDetails["fileView"]) => [call("b", "read", { path: "a.ts", offset: 2 }), viewed(toolResult("b", "new", "read"), view)];
	const path = "/repo/a.ts";
	const keeps = (before: FileViewDetails["fileView"], after: FileViewDetails["fileView"]) =>
		textOf(dropStaleResults([...early(before), ...late(after)], "/repo")[1]!) === "old ".repeat(80);

	expect(keeps({ path, lines: { from: 1, to: 50 }, verbatim: true }, { path, lines: { from: 10, to: 50 }, verbatim: true })).toBe(true);
	expect(keeps({ path, verbatim: true }, { path, columns: { from: 1, to: 2000 }, verbatim: false })).toBe(true);
	expect(
		keeps({ path, lines: { from: 10, to: 20 }, columns: { from: 1, to: 2000 }, verbatim: true }, { path, columns: { from: 1, to: 2000 }, verbatim: true }),
	).toBe(false);
});

it("改过这个文件之后，更早的读清掉：认结果上记下的改动，命令改的也算，参数里写着路径却没改成的不算", () => {
	const earlier = [
		read("a", "src/a.ts"),
		viewed(toolResult("a", "old ".repeat(80), "read"), { path: "/repo/src/a.ts", lines: { from: 5, to: 9 }, verbatim: true }),
	];
	const changed = (message: ToolResultMessage, paths: string[]): ToolResultMessage => ({ ...message, changes: { ids: ["x"], paths } });
	const edited = [call("b", "edit", { path: "src/a.ts", old_string: "x", new_string: "y" }), changed(toolResult("b", "ok", "edit"), ["/repo/src/a.ts"])];
	expect(textOf(dropStaleResults([...earlier, ...edited], "/repo")[1]!)).toMatch(/superseded/);
	const formatted = [call("b", "bash", { command: "pnpm fmt" }), changed(toolResult("b", "done", "bash"), ["/repo/src/a.ts"])];
	expect(textOf(dropStaleResults([...earlier, ...formatted], "/repo")[1]!)).toMatch(/superseded/);
	const refused = [call("b", "edit", { path: "src/a.ts", old_string: "x", new_string: "y" }), toolResult("b", "not found", "edit")];
	expect(textOf(dropStaleResults([...earlier, ...refused], "/repo")[1]!)).toBe("old ".repeat(80));
});

it("不带声明的读文件结果不认：参数、`details` 换个样子的读文件工具不会被错读", () => {
	const look = (id: string, from: number): Message => call(id, "peek", { target: "/repo/a.ts", range: [from, from + 10] });
	const shaped = (id: string, text: string): ToolResultMessage => ({
		...toolResult(id, text, "peek"),
		details: { kind: "text", path: "a.ts", totalLines: 40, shownFrom: 1, shownTo: 40 },
	});
	const body = "old ".repeat(80);
	const messages = [
		look("a", 1),
		shaped("a", body),
		look("b", 2),
		shaped("b", "new"),
		call("c", "edit", { path: "/repo/a.ts" }),
		toolResult("c", "ok", "edit"),
	];
	const out = dropStaleResults(messages, "/repo");
	expect(textOf(out[1]!)).toBe(body);
	expect(textOf(out[3]!)).toBe("new");
});

it("同样的调用又跑了一次时早的那份清掉，标了要照着做的说明（`instructions`）的不清", () => {
	const load = (id: string): Message => call(id, "skill", { name: "review" });
	const body = "Follow these steps. ".repeat(40);
	const twice = (instructions: boolean) =>
		dropStaleResults([load("a"), { ...toolResult("a", body, "skill"), instructions }, load("b"), { ...toolResult("b", body, "skill"), instructions }], "/repo");
	expect(textOf(twice(false)[1]!)).not.toBe(body);
	expect(textOf(twice(true)[1]!)).toBe(body);
});
