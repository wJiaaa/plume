/**
 * 钩子 tool.approve 上这一层把哪些请求交给规则判。
 */

import type { ApprovalDecision, PluginContext, ToolApproval } from "@plume/contract";
import { expect, it, vi } from "vitest";
import approval from "../src/index.ts";

type Layer = (input: ToolApproval, next: (input: ToolApproval) => Promise<ApprovalDecision>) => Promise<ApprovalDecision>;

function layer(): Layer {
	let hooked: Layer | undefined;
	approval.apply({ hook: (_name: string, run: Layer) => void (hooked = run), locale: () => "zh-CN" } as unknown as PluginContext);
	return hooked!;
}

function asking(tool: string, request: ToolApproval["request"]): ToolApproval {
	return {
		sessionId: "s",
		session: {} as ToolApproval["session"],
		cwd: "/work/app",
		call: { id: "c", name: tool, args: {} },
		tool: { name: tool, mutating: true, plugin: "test.plugin" },
		request,
		permissionMode: "auto",
		signal: new AbortController().signal,
	};
}

it("工具名撞上种类名时不当成那类事判：叫 command 的工具照样问人", async () => {
	const run = layer();
	const next = vi.fn(async () => "reject" as const);

	// 本体替没写 `asks` 的工具问的那张：kind 和 subject 都是工具名。
	expect(await run(asking("command", { kind: "command", title: "command", detail: "{}", subject: "command" }), next)).toBe("reject");
	expect(next).toHaveBeenCalledTimes(1);

	// 跑命令的工具自己问的照常按规则判：看不出风险的放行，不到里层。
	expect(await run(asking("bash", { kind: "command", title: "Run", detail: "ls", subject: "ls" }), next)).toBe("once");
	expect(next).toHaveBeenCalledTimes(1);
});
