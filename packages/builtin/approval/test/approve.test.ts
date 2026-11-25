/**
 * 钩子 tool.approve 上这一层把哪些请求交给规则判。
 */

import type { ApprovalDecision, ToolApproval } from "@plume/contract";
import { loadPlugin } from "@plumeai/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import approval from "../src/index.ts";

/** 这一层在钩子链里跑一次；next 代表里层（本体弹卡问人）。 */
async function layer() {
	const loaded = await loadPlugin(approval, { locale: "zh-CN" });
	return (input: ToolApproval, next: (input: ToolApproval) => Promise<ApprovalDecision>) => loaded.hook("tool.approve", input, next);
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
	const run = await layer();
	const next = vi.fn(async () => "reject" as const);

	// 本体替没写 `asks` 的工具问的那张：kind 和 subject 都是工具名。
	expect(await run(asking("command", { kind: "command", title: "command", detail: "{}", subject: "command" }), next)).toBe("reject");
	expect(next).toHaveBeenCalledTimes(1);

	// 跑命令的工具自己问的照常按规则判：看不出风险的放行，不到里层。
	expect(await run(asking("bash", { kind: "command", title: "Run", detail: "ls", subject: "ls" }), next)).toBe("once");
	expect(next).toHaveBeenCalledTimes(1);
});

it("帮我批准下读哪里都不问，只有密钥文件交给人", async () => {
	const run = await layer();
	const next = vi.fn(async () => "reject" as const);
	const read = (grant: string) => asking("read", { kind: "view", title: "Read", detail: grant, subject: `read:${grant}` });
	expect(await run(read("/Users/me/other-project"), next)).toBe("once");
	expect(await run(read("/Users/me/.plume"), next)).toBe("once");
	expect(next).not.toHaveBeenCalled();
	for (const secret of ["/Users/me/.plume/settings.json", "/Users/me/.plume/credentials.json", "/Users/me/.ssh/id_ed25519", "/Users/me/.aws/credentials"])
		expect(await run(read(secret), next), secret).toBe("reject");
	expect(next).toHaveBeenCalledTimes(4);
});

it("帮我批准下写项目外的普通目录不问，系统目录、钥匙目录照样问", async () => {
	const run = await layer();
	const next = vi.fn(async () => "reject" as const);
	const write = (path: string) => asking("write", { kind: "create", title: "Create", detail: "", subject: path });
	expect(await run(write("/Users/me/Desktop/notes.md"), next)).toBe("once");
	expect(next).not.toHaveBeenCalled();
	expect(await run(write("/etc/hosts"), next)).toBe("reject");
	expect(next).toHaveBeenCalledTimes(1);
});
