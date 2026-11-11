import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { type BrowserWindow, nativeTheme } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";

/**
 * 钩子插件的界面：工作区里放一条没信任的项目钩子（PreToolUse 拦下 bash），装上插件、开一个会话，看输入框上方说「待审核」，
 * 「去审核」落到设置页的这个项目、点「信任」；再让假模型调一次 bash，被这条钩子拦下，回复底下出「钩子」按钮，点开是运行记录。
 * 命令页同样切到这个项目，列出项目里的命令。设置页、命令页和运行记录浅色、深色各截一张。
 */
export async function checkHooks(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	workspace: string;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	capture(window: BrowserWindow, path: string): Promise<void>;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, workspace, outDir, page, until, click, capture, setModel } = options;
	const directory = join(workspace, ".plume");
	const file = join(directory, "config.json");
	const commandsDir = join(directory, "commands");
	const previous = await readFile(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	const blockedBy = "smoke hook: bash is blocked";
	const hover = async (selector: string) => {
		const point = (await page(
			`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`,
		)) as { x: number; y: number };
		window.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 300, y: point.y });
		window.webContents.sendInputEvent({ type: "mouseMove", ...point });
	};
	const themes = async (name: string, before?: () => Promise<void>) => {
		const theme = nativeTheme.themeSource;
		try {
			for (const mode of ["light", "dark"] as const) {
				nativeTheme.themeSource = mode;
				await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${mode === "dark"}`, `切到${mode}`);
				await before?.();
				await capture(window, join(outDir, `smoke-hooks-${name}-${mode}.png`));
			}
		} finally {
			nativeTheme.themeSource = theme;
		}
	};

	/*
	 * 钩子跑在系统 shell 里：Windows 上没装 Git 时是 PowerShell，它不认 `>&2`。那边改用 node 写 stderr、退出码 2，
	 * bash 和 PowerShell 读这一行都一样（跑冒烟的机器上一定有 node）。
	 */
	const blockCommand = process.platform === "win32" ? `node -e "process.stderr.write('${blockedBy}'); process.exit(2)"` : `echo '${blockedBy}' >&2; exit 2`;
	await mkdir(directory, { recursive: true });
	await writeFile(file, JSON.stringify({ hooks: { events: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: blockCommand }] }] } } }));
	try {
		if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
		await plugin.install("hooks");
		const deadline = Date.now() + 15_000;
		while (!(await agent.plugins()).some((status) => status.key === "hooks" && status.state === "active")) {
			if (Date.now() > deadline) throw new Error("等待超时：装上 hooks 插件");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		setModel(() => ({ text: "钩子准备好了。" }));
		await click('[data-plume-section-action] button[aria-label="新建项目"]');
		await click("[data-plume-add-folder]");
		await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好钩子测试目录");
		await click("button", "创建项目");
		await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace')`, "钩子测试项目");
		await click("[data-model-trigger]");
		await click("button", "fake-model");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("钩子准备");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('钩子准备好了。')`, "钩子测试会话准备好");

		// 没信任的项目钩子：输入框上方说一声。
		await until(`document.querySelector('[data-hook-trust-banner]')?.textContent.includes('1 个项目钩子待审核') === true`, "输入框上方提示待审核");
		await capture(window, join(outDir, "smoke-hooks-banner.png"));
		await click("[data-hook-review]");
		await until(`document.querySelector('[data-screen=settings] [data-hooks-settings]') !== null`, "「去审核」打开钩子设置");
		await until(`document.querySelector('[data-hooks-settings] [data-project-scope]')?.textContent.includes('workspace') === true`, "设置页切到这个项目");
		await until(`document.querySelector('[data-hook-trust-notice]') !== null && document.querySelector('[data-hook-trust]') !== null`, "信任提示和按钮");
		await themes("settings");
		await click("[data-hook-trust]");
		await until(
			`document.querySelector('[data-hook-trust]') === null && document.querySelector('[data-hook-trust-notice]') === null`,
			"信任以后提示和按钮撤下",
		);

		// 命令页底下列出内置命令；也能切到这个项目：项目里的命令只在看着项目时列出，「打开命令目录」跟着换成项目的。
		await mkdir(commandsDir, { recursive: true });
		await writeFile(join(commandsDir, "smoke-project-command.md"), "---\ndescription: 冒烟用的项目命令\n---\n\n看一眼这个项目。\n");
		await click("[aria-label=设置章节] button", "命令");
		await until(`document.querySelector('[data-commands-settings] [data-project-scope]') !== null`, "打开命令设置");
		await until(
			`['clear', 'compact', 'commands'].every((name) => document.querySelector('[data-builtin-command="' + name + '"]') !== null)`,
			"内置那一段列出产品和插件自己带的命令",
		);
		if (await page(`document.querySelector('[data-command-row="smoke-project-command"]') !== null`)) throw new Error("看个人命令时不该列出项目命令");
		await click("[data-commands-settings] [data-project-scope]");
		await click("[role=menuitem]", "workspace");
		await until(`document.querySelector('[data-command-row="smoke-project-command"]')?.textContent.includes('项目') === true`, "切到项目后列出项目命令");
		await until(`document.querySelector('[data-commands-settings] button[aria-label="打开项目命令目录"]') !== null`, "打开目录按钮换成项目的");
		await themes("commands");

		await click("button", "返回工作区");
		await until(`document.querySelector('[data-screen=chat]') !== null`, "回到会话");
		await until(`document.querySelector('[data-hook-trust-banner]') === null`, "信任以后输入框上方不再提示");

		// 信任过的这条钩子拦下 bash：回复底下出「钩子」按钮。
		setModel((request) =>
			JSON.stringify(request.messages).includes("tool_result")
				? { text: "钩子拦下了命令。" }
				: { text: "我跑个命令。", toolCalls: [{ id: "toolu_smoke_hooks", name: "bash", args: { command: "echo hi" } }] },
		);
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("跑个命令");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('钩子拦下了命令。') === true`, "这一轮答完");
		if (await page(`document.querySelector('[data-approval-card]') !== null`)) throw new Error("被 PreToolUse 拦下的调用不该再弹审批卡");
		await until(`document.querySelectorAll('[data-hook-runs]').length === 1`, "只有出岔子的那一轮有「钩子」按钮");
		await click("[data-hook-runs]");
		await until(
			`document.querySelector('[data-hook-run="blocked"]')?.textContent.includes(${JSON.stringify(blockedBy)}) === true`,
			"运行记录里是被拦下的 PreToolUse 和原因",
		);
		if (!(await page(`document.querySelector('[data-hook-run="blocked"]').textContent.includes('PreToolUse')`))) throw new Error("运行记录要说出是哪个事件");
		await themes("runs", () => hover("[data-hook-runs]"));
		console.log("PLUME_HOOKS_SMOKE", JSON.stringify({ banner: true, review: true, trust: true, commands: true, runs: true, themes: ["light", "dark"] }));
	} finally {
		setModel(undefined);
		await rm(join(commandsDir, "smoke-project-command.md"), { force: true });
		if (previous === null) await rm(file, { force: true });
		else await writeFile(file, previous);
	}
}
