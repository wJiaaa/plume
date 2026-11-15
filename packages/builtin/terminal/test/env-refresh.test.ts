/**
 * Windows 上什么时候重读注册表里的环境：插件启动时，和 Plume 的窗口拿到焦点时——装完 Node 从安装程序切回来就是这一下。
 * 面板连上不算：切到终端面板不说明环境变过。
 */

import type { PluginContext } from "@plume/contract";
import type { UiContext } from "@plume/contract/ui";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalApi } from "../src/api.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/windows-env.ts", async (original) => ({
	...(await original<typeof import("../src/windows-env.ts")>()),
	readRegistryEnv: async () => (reads.count++, null),
}));
vi.mock("../src/TerminalPane.tsx", () => ({ TerminalPane: () => null }));
vi.mock("@plume/ui/icons", () => ({ SquareTerminal: () => null }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({ default: "" }));
vi.mock("../src/terminal.css", () => ({ default: "" }));

const platform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	vi.useRealTimers();
	vi.unstubAllGlobals();
	reads.count = 0;
});

it("逻辑入口：启动时读一次，之后经 refreshEnv 再读；面板连上不读", async () => {
	Object.defineProperty(process, "platform", { value: "win32" });
	vi.useFakeTimers();
	const { default: plugin } = await import("../src/index.ts");
	let api: TerminalApi | undefined;
	const ctx = {
		log: { error: () => undefined },
		locale: () => "zh",
		effect: () => undefined,
		sessions: { onDeleted: () => undefined },
		serve: (served: TerminalApi) => (api = served),
	} as unknown as PluginContext;
	plugin.apply(ctx);
	await vi.advanceTimersByTimeAsync(0);
	expect(reads.count).toBe(1);

	// 过了十秒的节流，面板再连上也不读。
	vi.setSystemTime(Date.now() + 11_000);
	const abort = new AbortController();
	const tabs = api!.watch({ signal: abort.signal } as Parameters<TerminalApi["watch"]>[0]);
	await tabs.next();
	abort.abort();
	await vi.advanceTimersByTimeAsync(0);
	expect(reads.count).toBe(1);

	api!.refreshEnv();
	await vi.advanceTimersByTimeAsync(0);
	expect(reads.count).toBe(2);
	// 节流还在：十秒内来回切窗口不再起 PowerShell。
	api!.refreshEnv();
	expect(reads.count).toBe(2);
});

it("界面入口：窗口拿到焦点就让逻辑入口刷新，停用后不再听", async () => {
	const focusTarget = new EventTarget();
	vi.stubGlobal("window", focusTarget);
	vi.stubGlobal("document", {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" }),
		head: { append: () => undefined },
	});
	const refreshEnv = vi.fn(async () => undefined);
	const disposers: Array<() => void> = [];
	const ui = {
		remote: () => ({ refreshEnv }),
		terminalOpener: () => undefined,
		terminalRunner: () => undefined,
		panel: () => undefined,
		effect: (dispose: () => void) => disposers.push(dispose),
	} as unknown as UiContext;
	const { default: plugin } = await import("../src/ui.tsx");
	plugin.apply(ui);

	focusTarget.dispatchEvent(new Event("focus"));
	expect(refreshEnv).toHaveBeenCalledTimes(1);
	for (const dispose of disposers) dispose();
	focusTarget.dispatchEvent(new Event("focus"));
	expect(refreshEnv).toHaveBeenCalledTimes(1);
});
