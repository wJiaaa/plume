import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";

const ASK = "冒烟：顺手看到一处死代码";
const TITLE = "清理 utils.ts 里的死代码";
const PROMPT = "冒烟新会话：删掉 utils.ts 里没人用的三个函数";
const SUGGESTED = "建议好了，我接着做手上的事。";
const CLEANED = "清理完了：删了三个函数。";
const RECEIVED = "收到新会话交回的结果。";
const ARCHIVE_ASK = "冒烟：做完就把这个对话归档";
const ARCHIVING = "好，这就归档。";

/**
 * 建议新会话（内置插件 plume.spawn-session）：假模型在对话里调 `spawn_session`（要求交回），对话里画出建议卡片，收着的环境开关上
 * 挂圆点、说明里有「等你决定」；点「开始」，新会话开在同一处、记着来处，跑完第一轮后它的回复交回原对话：那边多一行「来自新会话」，
 * 被叫起一轮；卡片缩成一行「新会话 · 标题」，点了到那个会话；输入框上方钉着那个会话跑完了，点过去看过就收走。在那个会话里说「做完就归档」，假模型调 `archive_session`：
 * 这一轮停在这一下（之后不再问模型），收场后会话归档，界面离开它。
 *
 * 卡片上还有工作树开关（内置插件 plume.git 经服务 `session.worktree` 提供）：打开再开始，新会话第一轮就换进自己的工作树。
 * 开关只给项目会话，所以先把工作区登记成项目；工作区也先做成自己的仓库：它在 Plume 仓库里面，不先 init 的话工作树会开在 Plume 仓库上。
 */
export async function checkSpawnSession(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	outDir: string;
	workspace: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, outDir, workspace, setModel } = options;
	const gitIn = (...args: string[]) =>
		promisify(execFile)("git", ["-c", "user.name=Plume Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...args], {
			cwd: workspace,
		});
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`建议新会话等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => setTimeout(resolve, 500))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const chatHas = (text: string) => `document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(text)}) === true`;

	// 按整段对话认是哪一方、走到哪一步，越往后的状态越先认。
	let afterArchive = 0;
	setModel((request) => {
		const all = JSON.stringify(request.messages ?? []);
		if (all.includes("toolu_archive")) {
			afterArchive++;
			return { text: "归档以后不该再问到这里。" };
		}
		if (all.includes(ARCHIVE_ASK)) return { text: ARCHIVING, toolCalls: [{ id: "toolu_archive", name: "archive_session", args: { reason: "清理完了" } }] };
		if (all.includes("session_result")) return { text: RECEIVED };
		if (all.includes("toolu_spawn")) return { text: SUGGESTED };
		if (all.includes(PROMPT)) return { text: CLEANED };
		return {
			toolCalls: [
				{
					id: "toolu_spawn",
					name: "spawn_session",
					args: { title: TITLE, summary: "改登录时看到的，和这次改动无关，单独做更干净。", prompt: PROMPT, report_back: true },
				},
			],
		};
	});
	try {
		await gitIn("init", "-q", "-b", "main");
		await gitIn("add", "-A");
		await gitIn("commit", "-q", "--allow-empty", "-m", "smoke");
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		// 工作树开关只给项目会话：经界面把工作区登记成项目，在它下面发起对话。
		await until(`document.querySelector('[data-plume-section-action] button[aria-label="新建项目"]') !== null`, "侧栏有新建项目");
		await page(`document.querySelector('[data-plume-section-action] button[aria-label="新建项目"]').click()`);
		await until(`document.querySelector('[data-plume-add-folder]') !== null`, "打开新建项目");
		await page(`document.querySelector('[data-plume-add-folder]').click()`);
		await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好项目目录");
		await page(`[...document.querySelectorAll('button')].find(item => item.textContent.includes('创建项目')).click()`);
		await until(`document.querySelector('[data-screen=empty] h1')?.textContent.includes('workspace') === true`, "进到工作区项目");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(ASK);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		let parentId = "";
		await wait(async () => {
			parentId = (await agent.sessions()).find((item) => !previous.has(item.id))?.id ?? "";
			return parentId !== "";
		}, "对话已创建");
		await until(chatHas(SUGGESTED), "模型提完建议接着做");
		await until(`document.querySelector('[data-environment-toggle]') !== null`, "内置诊断插件已加载");

		const card = "[data-screen=chat] [data-spawn-suggestion=suggested]";
		await until(`document.querySelector(${JSON.stringify(card)})?.textContent.includes(${JSON.stringify(TITLE)}) === true`, "对话里画出建议卡片");
		if ((await page<string>(`document.querySelector('${card} [data-spawn-report]')?.dataset.spawnReport ?? ''`)) !== "on")
			throw new Error("模型要求交回，卡片上的「交回这里」没开着");
		await until(`document.querySelector('[data-environment-toggle] [data-environment-dot]') !== null`, "环境开关上挂着圆点");
		if (!(await page<string>(`document.querySelector('[data-environment-toggle]').getAttribute('aria-label')`)).includes("等你决定"))
			throw new Error("环境开关的说明里没有待决定的建议");
		const worktreeToggle = `${card} [data-plume-worktree-toggle]`;
		await until(`document.querySelector(${JSON.stringify(worktreeToggle)}) !== null`, "项目是仓库，卡片上有工作树开关");
		if ((await page<string>(`document.querySelector(${JSON.stringify(worktreeToggle)}).getAttribute('aria-pressed')`)) === "true")
			throw new Error("模型没说要并行改，卡片上的工作树开关却开着");
		await page(`document.querySelector(${JSON.stringify(worktreeToggle)}).click()`);
		await until(`document.querySelector(${JSON.stringify(worktreeToggle)}).getAttribute('aria-pressed') === 'true'`, "打开卡片上的工作树开关");
		await capture("smoke-spawn-session-card.png");

		await page(`document.querySelector('${card} [data-spawn-action=start]').click()`);
		let startedId = "";
		await wait(async () => {
			startedId = (await agent.sessions()).find((item) => item.spawnedFrom?.sessionId === parentId && item.spawnedFrom.toolCallId === "toolu_spawn")?.id ?? "";
			return startedId !== "";
		}, "开出新会话、记着来处");
		const started = (await agent.sessions()).find((item) => item.id === startedId);
		if (started?.title !== TITLE) throw new Error(`新会话的标题不是建议的标题：${started?.title}`);
		let startedCwd = "";
		await wait(async () => {
			startedCwd = (await agent.sessions()).find((item) => item.id === startedId)?.cwd ?? "";
			return startedCwd.includes(`${sep}worktrees${sep}`);
		}, "新会话第一轮换进自己的工作树");
		const branch = (await promisify(execFile)("git", ["symbolic-ref", "--short", "HEAD"], { cwd: startedCwd })).stdout.trim();
		if (!branch.startsWith("plume/session-")) throw new Error(`新会话的工作树不在它自己的分支上：${branch}`);
		await until(`document.querySelector('[data-screen=chat] [data-spawn-suggestion=started]') !== null`, "卡片缩成一行「新会话」");
		await until(`document.querySelector('[data-environment-toggle] [data-environment-dot]') === null`, "开始以后圆点撤下");

		const delivery = "[data-screen=chat] [data-delivery-kind=session]";
		await until(
			`document.querySelector(${JSON.stringify(delivery)})?.textContent.includes(${JSON.stringify(TITLE)}) === true`,
			"原对话里有「来自新会话」那一行",
		);
		await until(chatHas(RECEIVED), "交回叫起原对话一轮");
		if (await page<boolean>(`[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].some(e => e.textContent.includes('session_result'))`))
			throw new Error("交回的结果画成了人的气泡");
		// 输入框上方钉着交出去的那个会话：人没看着时它跑完了，这一行说「已完成 · 未查看」，点了过去。
		const handedOff = `[data-screen=chat] [data-handed-off-row="${startedId}"]`;
		await until(`document.querySelector(${JSON.stringify(handedOff)})?.dataset.state === 'done'`, "输入框上方那一条说新会话跑完了");
		if (!(await page<boolean>(`document.querySelector(${JSON.stringify(handedOff)}).textContent.includes(${JSON.stringify(TITLE)})`)))
			throw new Error("输入框上方那一条没写交出去的会话的标题");
		await capture("smoke-spawn-session-report.png");

		await page(`document.querySelector(${JSON.stringify(handedOff)}).click()`);
		await until(chatHas(CLEANED), "输入框上方那一条点了到新会话");
		await page(`document.querySelector('[data-plume-row="${parentId}"] > button').click()`);
		await until(`${chatHas(RECEIVED)} && document.querySelector(${JSON.stringify(handedOff)}) === null`, "回到原对话，看过的那一行收走");
		await page(`document.querySelector('[data-screen=chat] [data-spawn-action=open]').click()`);
		await until(chatHas(CLEANED), "那一行点了到新会话");
		await capture("smoke-spawn-session-opened.png");

		// 在新会话里要它做完就归档：这一轮停在 archive_session 这一下，收场后归档，界面离开它。
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(ARCHIVE_ASK);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "新会话里可以发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		await wait(async () => (await agent.sessions()).find((item) => item.id === startedId)?.archived === true, "archive_session 那一轮收场后会话归档");
		await until(`document.querySelector('[data-screen=chat]') === null || !(${chatHas(CLEANED)})`, "界面离开归档的会话");
		const archived = (await agent.sessions()).find((item) => item.id === startedId);
		if (archived?.stop?.reason !== "done") throw new Error(`归档的那一轮没有以完成收场：${JSON.stringify(archived?.stop)}`);
		if (afterArchive > 0) throw new Error("archive_session 之后又问了模型：这一轮没停在这一下");
		if ((await agent.sessions()).find((item) => item.id === parentId)?.archived) throw new Error("归档了提建议的那个对话");
		await capture("smoke-spawn-session-archived.png");
	} finally {
		setModel(undefined);
	}
}
