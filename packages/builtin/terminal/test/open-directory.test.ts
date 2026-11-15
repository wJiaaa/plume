import { expect, it } from "vitest";
import type { CallContext, PluginContext } from "@plume/contract";
import type { TerminalApi } from "../src/api.ts";
import plugin from "../src/index.ts";
import { createDirectoryRequests } from "../src/open-directory.ts";
import { cdCommand } from "../src/shell.ts";

const zsh = (directory: string) => cdCommand("darwin", "/bin/zsh", directory);

it("目录按会话等待，最新一次点击替换旧目录，两个窗口也只能领取一次", () => {
	const requests = createDirectoryRequests(zsh);
	requests.open("a", "/first");
	const old = requests.get("a")!;
	requests.open("a", "/second");
	requests.open("b", "/other");
	const current = requests.get("a")!;
	expect(requests.take("b", current.id)).toBe(false);
	expect(requests.take("a", old.id)).toBe(false);
	expect(requests.take("a", current.id)).toBe(true);
	expect(requests.take("a", current.id)).toBe(false);
	expect(requests.get("a")).toBeNull();
	expect(requests.get("b")?.command).toBe("cd '/other'\r");
});

it("路径里的空格、单引号和 shell 字符都留在单引号字面量内", () => {
	const requests = createDirectoryRequests(zsh);
	requests.open("a", "/work/it's $(echo no); [folder]");
	expect(requests.get("a")?.command).toBe("cd '/work/it'\\''s $(echo no); [folder]'\r");
});

it("Windows 上按新终端的 shell 写切目录：PowerShell 用字面路径，cmd 带 /d，Git Bash 仍是 POSIX 写法", () => {
	const dir = "C:\\work\\it's ‘[x]’ $env:HOME";
	expect(cdCommand("win32", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", dir)).toBe("Set-Location -LiteralPath 'C:\\work\\it''s ‘‘[x]’’ $env:HOME'");
	expect(cdCommand("win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "D:\\a")).toBe("Set-Location -LiteralPath 'D:\\a'");
	expect(cdCommand("win32", "C:\\Windows\\system32\\cmd.exe", "D:\\a b")).toBe('cd /d "D:\\a b"');
	expect(cdCommand("win32", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\it's")).toBe("cd 'C:\\it'\\''s'");
});

it("终端逻辑入口跨窗口推送目录请求，领取和删会话后推送清空", async () => {
	let api!: TerminalApi;
	let deleted!: (sessionId: string) => void;
	const effects: Array<() => void> = [];
	plugin.apply({
		serve: (value: TerminalApi) => {
			api = value;
		},
		effect: (dispose: () => void) => effects.push(dispose),
		sessions: {
			onDeleted: (listener: (sessionId: string) => void) => {
				deleted = listener;
			},
		},
	} as unknown as PluginContext);
	const controller = new AbortController();
	const stream = api.watchDirectory("a", { signal: controller.signal } as CallContext);
	try {
		expect((await stream.next()).value).toBeNull();
		api.openDirectory("a", "/work");
		const request = (await stream.next()).value!;
		expect(request.command).toBe("cd '/work'\r");
		expect(api.takeDirectory("a", request.id)).toBe(true);
		expect(api.takeDirectory("a", request.id)).toBe(false);
		expect((await stream.next()).value).toBeNull();
		api.openDirectory("a", "/after");
		await stream.next();
		deleted("a");
		expect((await stream.next()).value).toBeNull();
	} finally {
		controller.abort();
		await stream.return();
		for (const dispose of effects) dispose();
	}
});

it("代码块的命令和目录请求排在同一处：带回车，后点的替换先点的，只领取一次", () => {
	const requests = createDirectoryRequests(zsh);
	requests.open("a", "/work");
	requests.run("a", "pnpm install\npnpm dev");
	const request = requests.get("a")!;
	expect(request.command).toBe("pnpm install\npnpm dev\r");
	expect(requests.take("a", request.id)).toBe(true);
	expect(requests.take("a", request.id)).toBe(false);
});
