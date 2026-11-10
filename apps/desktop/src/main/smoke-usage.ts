import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { runPluginCli } from "./smoke-plugin-cli.ts";

/**
 * 使用统计的环图和缓存未命中：经界面发一轮带工具调用的对话（两次主请求），装上使用统计，看 Token 构成、耗时构成画出环图，
 * 图例按来源列出系统提示词、工具定义、工具结果，缓存未命中卡片在。
 */
export async function checkUsage(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; pluginsDir: string; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`使用统计验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
	await runPluginCli(plugin.cli, ["install", join(plugin.pluginsDir, "usage"), "--to", plugin.installDir]);
	await wait(async () => (await agent.plugins()).some((status) => status.key === "usage" && status.state === "active"), "装上 usage 插件");

	// 第一次请求读一个文件，第二次收尾：工具结果进第二次请求，耗时里有工具执行。
	setModel((request) =>
		JSON.stringify(request.messages).includes("tool_result")
			? { text: "用量统计读完了。" }
			: { text: "我读一下。", toolCalls: [{ id: "toolu_smoke_usage", name: "ls", args: { path: "." } }] },
	);
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("用量统计：看看目录");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		await until(
			`document.querySelector('[data-screen=chat]')?.textContent.includes('用量统计读完了。') === true || document.querySelector('[data-approval-card]') !== null`,
			"这一轮答完或弹出审批卡",
		);
		await page(`[...document.querySelectorAll('[data-approval-card] button')].find((button) => button.textContent.includes('允许一次'))?.click()`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('用量统计读完了。') === true`, "这一轮答完");
	} finally {
		setModel(undefined);
	}

	window.webContents.send("plume:command", "settings");
	await until(`document.querySelector('[aria-label=设置章节]') !== null`, "设置打开");
	await page(`[...document.querySelectorAll('[aria-label=设置章节] button')].find((button) => button.textContent.trim() === '使用统计').click()`);
	await until(`document.querySelector('[data-usage-token-breakdown] [data-donut-segment="system"]') !== null`, "Token 构成画出环图");
	for (const part of ["system", "toolDefs", "user", "toolResults", "outputReply"])
		await until(`document.querySelector('[data-usage-token-breakdown] [data-usage-legend="${part}"]')?.textContent.includes('≈') === true`, `图例里有 ${part}`);
	// 列个目录只要几毫秒，在环上可能窄到不画：看图例里记下的那一次。
	await until(`document.querySelector('[data-usage-time-breakdown] [data-donut-segment="wait"]') !== null`, "耗时构成画出环图");
	await until(
		`document.querySelector('[data-usage-time-breakdown] [data-usage-legend="tool"]')?.textContent.includes('1 次') === true`,
		"耗时构成里有一次工具执行",
	);
	await until(`/1\\D+1\\D+1/.test(document.querySelector('[data-usage-activity-counts]')?.textContent ?? '')`, "一个会话、一轮、一次工具调用");
	await until(`document.querySelector('[data-usage-cache-miss]') !== null`, "缓存未命中卡片");
	await page(`document.querySelector('[data-usage-breakdown]').scrollIntoView({ block: 'start' })`);
	await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
	await writeFile(join(outDir, "smoke-usage-breakdown.png"), (await window.webContents.capturePage()).toPNG());
}
