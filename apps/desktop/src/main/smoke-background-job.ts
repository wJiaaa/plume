import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { nativeTheme, type BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";

const PROMPT = "后台跑一条命令";
const STARTED = "放到后台了，跑完会送回来。";
const FINISHED = "后台命令跑完了，输出是 SMOKE_JOB_DONE。";

/**
 * 后台命令自己结束时送达：假模型起一条 `run_in_background` 的 bash 就收尾，命令三秒后结束，结果经 `ToolRun.background`
 * 叫醒空闲的会话再开一轮；转录里有一行「后台命令完成 · 说明」，送达的那条消息不画成人的气泡。
 */
export async function checkBackgroundJob(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`后台命令送达等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const settled = () => page(`new Promise(resolve => setTimeout(resolve, 500))`);
	const requests: string[] = [];
	setModel((request) => {
		const messages = JSON.stringify(request.messages);
		requests.push(messages);
		if (messages.includes("<background_job")) return { text: FINISHED };
		if (messages.includes("toolu_smoke_job")) return { text: STARTED };
		return {
			toolCalls: [
				{
					id: "toolu_smoke_job",
					name: "bash",
					args: { command: "sleep 3; echo SMOKE_JOB_DONE", description: "冒烟用的后台命令", run_in_background: true },
				},
			],
		};
	});
	try {
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(PROMPT);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		await wait(async () => (await agent.sessions()).some((item) => !previous.has(item.id)), "新会话已创建");
		const row = "[data-screen=chat] [data-delivery-row][data-delivery-kind=job]";
		// 跟在别的段后面跑时权限可能停在「请求批准」，命令先弹审批卡：答「允许一次」，单独跑时没有这张卡。
		await until(
			`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(STARTED)}) === true || document.querySelector('[data-approval-card]') !== null`,
			"命令放行或弹出审批卡",
		);
		await page(`[...document.querySelectorAll('[data-approval-card] button')].find((button) => button.textContent.includes('允许一次'))?.click()`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(STARTED)}) === true`, "放到后台后这一轮先收尾");
		await until(`document.querySelector('[data-environment-toggle]') !== null`, "环境开关已加载");
		await page(`document.querySelector('[data-environment-toggle]').click()`);
		await until(`document.querySelector('[data-environment-job]') !== null`, "环境卡显示后台任务");
		await settled();
		await writeFile(join(outDir, "smoke-environment.png"), (await window.webContents.capturePage()).toPNG());
		// 环境卡开没开记在 localStorage 里、对所有会话生效：看完就收起，后面各段的对话底部不多一张卡。
		// 它的阴影会漫进转录区，网页预览「复制整页」按片截图时每片底下都带一道。
		await page(`document.querySelector('[data-environment-toggle]').click()`);
		await until(`document.querySelector('[data-environment-job]') === null`, "收起环境卡");
		await until(`document.querySelector(${JSON.stringify(row)})?.textContent.includes('后台命令完成') === true`, "命令结束后对话里出现送达那一行");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(FINISHED)}) === true`, "送达叫醒会话开了一轮");
		if (!(await page<string>(`document.querySelector(${JSON.stringify(row)}).textContent`)).includes("冒烟用的后台命令"))
			throw new Error("送达那一行没写是哪条命令");
		if (await page<boolean>(`[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].some(e => e.textContent.includes('运行时送达'))`))
			throw new Error("送达画成了人的气泡");
		const delivered = requests.find((messages) => messages.includes("<background_job"));
		if (!delivered?.includes("SMOKE_JOB_DONE") || !delivered.includes("不是用户说的话")) throw new Error("送给模型的结果不对");
		if (requests.length !== 3) throw new Error(`应该请求模型三次，实际 ${requests.length} 次`);
		await page(`document.querySelector(${JSON.stringify(row)}).scrollIntoView({ block: 'center' })`);
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await settled();
		await writeFile(join(outDir, "smoke-background-job.png"), (await window.webContents.capturePage()).toPNG());
		await page(`document.querySelector(${JSON.stringify(row)}).querySelector('button').click()`);
		await until(`document.querySelector('[data-session-services]')?.textContent.includes('SMOKE_JOB_DONE') === true`, "送达行定位后台输出");
		await until(`document.querySelector('[data-task-record]') !== null`, "任务运行记录");
		await settled();
		await writeFile(join(outDir, "smoke-tasks.png"), (await window.webContents.capturePage()).toPNG());
		await page(`document.querySelector('[data-task-record] button').click()`);
		await until(`document.querySelector('button[aria-label="在轨迹中查看"]') !== null`, "运行详情跳转入口");
		await page(`document.querySelector('button[aria-label="在轨迹中查看"]').click()`);
		await until(`document.querySelector('[data-trajectory] [data-trace-inspector]')?.textContent.includes('SMOKE_JOB_DONE') === true`, "轨迹定位相同调用");
		await settled();
		await writeFile(join(outDir, "smoke-trajectory.png"), (await window.webContents.capturePage()).toPNG());
		const previousTheme = nativeTheme.themeSource;
		try {
			for (const theme of ["light", "dark"] as const) {
				nativeTheme.themeSource = theme;
				await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
				await settled();
				await writeFile(join(outDir, `smoke-trajectory-${theme}.png`), (await window.webContents.capturePage()).toPNG());
			}
		} finally {
			nativeTheme.themeSource = previousTheme;
		}
		await page(`document.querySelector('[data-trace-inspector] button[aria-label="返回"]').click()`);
		await page(
			`(() => { const input = document.querySelector('[data-trajectory] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'NO_SUCH_DIAGNOSTIC'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
		);
		await until(`document.querySelector('[data-trajectory]')?.textContent.includes('没有匹配的记录') === true`, "轨迹搜索空结果");
		await page(
			`(() => { const input = document.querySelector('[data-trajectory] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'SMOKE_JOB_DONE'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
		);
		await until(`document.querySelector('[data-trace-entry]') !== null`, "轨迹搜索匹配输出");
		const bounds = window.getBounds();
		try {
			const [width, height] = window.getMinimumSize();
			window.setSize(width!, height!);
			await settled();
			await writeFile(join(outDir, "smoke-diagnostics-narrow.png"), (await window.webContents.capturePage()).toPNG());
		} finally {
			window.setBounds(bounds);
		}
	} finally {
		setModel(undefined);
	}
}
