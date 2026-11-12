import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { toolResult } from "./smoke-question.ts";

const ASK = "冒烟计划：把 hello.txt 里的 hello 改成 planned";
const ROUND2 = "冒烟计划：按原样再交一次";
const PLAN_V1 = "# 改 hello.txt\n\n## 概要\n把 hello 改成 planned。";
const PLAN_V2 = "# 改 hello.txt（先读再改）\n\n## 概要\n先读一遍 hello.txt，再把 hello 改成 planned。";
const PLAN_V3 = "# 改 hello.txt（定稿）\n\n## 概要\n读 hello.txt，把 hello 改成 planned。";
const FEEDBACK = "先读一遍再改";
const DONE = "按计划改好了。";
const PLAN_ON = "Plan mode is on";

/**
 * 计划模式（内置插件 plume.plan）经真界面走一遍。计划卡是等人原语（`run.request` / `ui.requestCard`），不是审批卡，
 * 权限模式管不着：
 *
 * 1. 新对话里点输入框底下的计划模式开关，发第一句话，开关跟着建出来的会话；假模型先试 `edit`，被拒（「Plan mode: it edits files」），
 *    文件不变，再交计划：输入框上方出现计划卡（运行行说在等回答、卡上没有「允许一次」），右栏自动打开计划面板。
 *    卡在右栏开着（窄）和收起（宽）时，主按钮都不被单独挤到第二行；后面几张卡也量一次。
 * 2. 点「修改…」写意见、修订：模型收到的是没批准和这句意见，开关还开着，它改完再交；这一次点「拒绝」：这一轮停下，开关不动。
 * 3. 权限切到完全访问再发一句：`edit` 照样被拒，命令跑在只读沙箱里写不出文件，申请离开沙箱的被拒；计划卡照样出来、停着不被自动放行。
 *    点「接受」：卡收起、开关关掉，同一轮里模型接着读、改 hello.txt，改成了；模型收到的批准结果说计划模式已关。
 * 4. 环境卡片里「计划」一节列出批准的那份。
 *
 * 模型经工具进计划模式没有这条路（只有人拨开关或 `/plan`）；提问卡在主流程（`smoke-question.ts`）里走过，这里不重复。
 */
export async function checkPlan(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	outDir: string;
	workspace: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, outDir, workspace, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`计划模式等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => setTimeout(resolve, 500))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const chatHas = (text: string) => `document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(text)}) === true`;
	const send = async (text: string) => {
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(text);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, `「${text}」可以发送`);
		await page(`document.querySelector('[data-composer-send=send]').click()`);
	};
	// 开关是插件画的 `ComposerToggle`：开着时说「退出计划模式」，关着时说「进入计划模式：…」。
	const toggleOn = `document.querySelector('button[aria-label="退出计划模式"]')?.getAttribute('aria-pressed') === 'true'`;
	const toggleOff = `document.querySelector('button[aria-label^="进入计划模式"]')?.getAttribute('aria-pressed') === 'false'`;
	const card = "[data-approval-card][data-approval-plan]";
	/** 计划卡出来了，而且是等人卡：运行行说在等回答，卡上没有审批的按钮。 */
	const planCard = async (title: string, label: string) => {
		await until(`document.querySelector('${card}') !== null && document.querySelector('[data-plume-waiting=answer]') !== null`, label);
		await until(`document.querySelector('[data-plan-body]')?.textContent.includes(${JSON.stringify(title)}) === true`, `${label}：右栏的计划面板读的是这份`);
		if (await page<boolean>(`[...document.querySelectorAll('[data-approval-region] button')].some(button => button.textContent.includes('允许一次'))`))
			throw new Error("计划卡上不该有审批的「允许一次」");
	};
	/**
	 * 卡上的主按钮（接受那一组的最后一颗）不单独占一行：和别的按钮至少一颗在同一行上。收起、展开右栏时等卡片宽度停下来再量。
	 */
	const mainNotAlone = async (label: string) => {
		const width = () => page<number>(`document.querySelector('${card}')?.getBoundingClientRect().width ?? 0`);
		for (let last = -1, now = await width(); now !== last; last = now, now = await width()) await new Promise((resolve) => setTimeout(resolve, 250));
		const rows = await page<{ main: number; others: number[] } | null>(`(() => {
			const main = document.querySelector('${card} .plume-plan-main > button:last-child');
			if (!main) return null;
			const others = [...document.querySelectorAll('${card} [data-approval-plan-actions] button')].filter((button) => button !== main);
			return { main: main.getBoundingClientRect().top, others: others.map((button) => button.getBoundingClientRect().top) };
		})()`);
		if (!rows) throw new Error(`${label}：计划卡上找不到接受那一组`);
		if (!rows.others.some((top) => Math.abs(top - rows.main) < 4)) {
			await capture("smoke-plan-actions-wrapped.png");
			throw new Error(`${label}：主按钮被单独挤到一行（${JSON.stringify(rows)}）`);
		}
	};
	const turnEnded = `document.querySelector('${card}') === null && document.querySelector('[data-plume-running]') === null`;

	/** 各次请求里看到的工具结果；第一轮的系统提示词里有没有计划模式那一段。 */
	const seen: Record<string, string | undefined> = {};
	let planOn = false;
	const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args });
	setModel((request) => {
		// 标题这类不带工具的小调用不答。
		if (!((request.tools as { name?: string }[] | undefined) ?? []).some((tool) => tool.name === "submit_plan")) return { text: "计划" };
		const all = JSON.stringify(request.messages ?? []);
		const result = (id: string) => (seen[id] = toolResult(request, id));
		// 按整段对话认走到哪一步，越往后的越先认。
		if (all.includes("toolu_plan_apply")) {
			result("toolu_plan_apply");
			return { text: DONE };
		}
		if (result("toolu_plan_submit3") !== undefined)
			return {
				toolCalls: [
					call("toolu_plan_read", "read", { path: "hello.txt" }),
					call("toolu_plan_apply", "edit", { path: "hello.txt", old_string: "hello", new_string: "planned" }),
				],
			};
		if (all.includes("toolu_plan_escalate")) {
			for (const id of ["toolu_plan_edit2", "toolu_plan_write", "toolu_plan_escalate"]) result(id);
			return { toolCalls: [call("toolu_plan_submit3", "submit_plan", { plan: PLAN_V3 })] };
		}
		if (all.includes(ROUND2)) {
			result("toolu_plan_submit2");
			return {
				toolCalls: [
					call("toolu_plan_edit2", "edit", { path: "hello.txt", old_string: "hello", new_string: "planned" }),
					call("toolu_plan_write", "bash", { command: "echo plan > blocked.txt", description: "试着写一个文件" }),
					call("toolu_plan_escalate", "bash", {
						command: "echo plan > escalated.txt",
						description: "申请离开沙箱",
						escalate: "workspace-write",
						justification: "冒烟：试一下计划模式下能不能离开沙箱",
					}),
				],
			};
		}
		if (result("toolu_plan_submit1") !== undefined) return { toolCalls: [call("toolu_plan_submit2", "submit_plan", { plan: PLAN_V2 })] };
		if (all.includes("toolu_plan_edit")) {
			// 系统提示词一个会话冻结一份（plume.prompt，为了前缀缓存），段的增减在下一轮开头以增量消息补上：批准以后同一轮里
			// 系统提示词照旧，靠工具结果说计划模式关了。所以只在第一轮看它在不在。
			planOn = JSON.stringify(request.system ?? "").includes(PLAN_ON);
			result("toolu_plan_edit");
			return { toolCalls: [call("toolu_plan_submit1", "submit_plan", { plan: PLAN_V1 })] };
		}
		return {
			text: "先看看再交计划。",
			toolCalls: [call("toolu_plan_edit", "edit", { path: "hello.txt", old_string: "hello", new_string: "planned" })],
		};
	});
	try {
		// 开在项目里：edit 落在工作区，帮我批准下不问，完全访问下也不问。
		await until(`document.querySelector('[data-plume-section-action] button[aria-label="新建项目"]') !== null`, "侧栏有新建项目");
		await page(`document.querySelector('[data-plume-section-action] button[aria-label="新建项目"]').click()`);
		await until(`document.querySelector('[data-plume-add-folder]') !== null`, "打开新建项目");
		await page(`document.querySelector('[data-plume-add-folder]').click()`);
		await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好项目目录");
		await page(`[...document.querySelectorAll('button')].find(item => item.textContent.includes('创建项目')).click()`);
		await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace') === true`, "进到工作区项目");

		// 1. 新对话里拨开关：拨的是新对话的那一份，第一句话发出去时交给建出来的会话。
		await until(toggleOff, "输入框底下有计划模式开关，缺省关着");
		await page(`document.querySelector('button[aria-label^="进入计划模式"]').click()`);
		await until(toggleOn, "新对话的计划模式开关拨开");
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		await send(ASK);
		let sessionId = "";
		await wait(async () => {
			sessionId = (await agent.sessions()).find((item) => !previous.has(item.id))?.id ?? "";
			return sessionId !== "";
		}, "对话已创建");
		await planCard("改 hello.txt", "交上来的计划弹出计划卡");
		if (!planOn) throw new Error("计划模式开着，系统提示词里却没有计划模式那一段");
		if (!seen.toolu_plan_edit?.includes("Plan mode: it edits files"))
			throw new Error(`计划模式下 edit 应该被拒，模型收到的是 ${JSON.stringify(seen.toolu_plan_edit)}`);
		if ((await readFile(join(workspace, "hello.txt"), "utf8")) !== "hello\n") throw new Error("计划模式下 hello.txt 被改了");
		if (!(await page<boolean>(toggleOn))) throw new Error("建出来的会话没接上新对话的计划模式开关");
		await mainNotAlone("右栏开着、卡片窄");
		await capture("smoke-plan-card.png");
		// 收起右栏看宽的那一种，再打开：后面每份新计划还要在面板里读到。
		await page(`document.querySelector('[data-panel-area] button[aria-label="收起面板"]').click()`);
		await until(
			`document.querySelector('[data-panel-area]:not([inert])') === null && document.querySelector('[data-panel-toggle] button') !== null`,
			"收起右栏",
		);
		await mainNotAlone("右栏收着、卡片宽");
		await capture("smoke-plan-card-wide.png");
		await page(`document.querySelector('[data-panel-toggle] button').click()`);
		await until(`document.querySelector('[data-panel-area]:not([inert])') !== null`, "再打开右栏");

		// 2. 修改：写下意见、修订，模型收到的是没批准和这句意见，开关不动，它改完再交。
		await page(`document.querySelector('${card} [data-plan-action=revise]').click()`);
		await until(`document.querySelector('${card} [data-plan-revise-input]') !== null`, "点「修改…」出来写意见的框");
		await page(`document.querySelector('${card} [data-plan-revise-input]').focus()`);
		await window.webContents.insertText(FEEDBACK);
		await until(`document.querySelector('${card} [data-plan-send-revision]')?.disabled === false`, "写了意见可以修订");
		await mainNotAlone("写修改意见时");
		await capture("smoke-plan-revise.png");
		await page(`document.querySelector('${card} [data-plan-send-revision]').click()`);
		await planCard("改 hello.txt（先读再改）", "改过的计划再弹出计划卡");
		if (!seen.toolu_plan_submit1?.includes("did not approve") || !seen.toolu_plan_submit1.includes(FEEDBACK))
			throw new Error(`修改以后模型应该收到没批准和意见，实际是 ${JSON.stringify(seen.toolu_plan_submit1)}`);
		if (!(await page<boolean>(toggleOn))) throw new Error("要求修改以后计划模式不该关");

		// 拒绝：这一轮停下，开关不动。
		await page(`document.querySelector('${card} [data-plan-action=reject]').click()`);
		await until(turnEnded, "拒绝以后卡收起、这一轮停下");
		if (!(await page<boolean>(toggleOn))) throw new Error("拒绝以后计划模式不该关");

		// 3. 权限切到完全访问：要再确认一次。
		await page(`document.querySelector('[data-permission-chip]').click()`);
		await until(`document.querySelectorAll('[role=menuitem]').length === 3`, "权限菜单列出三档");
		await page(`[...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent.trim().startsWith('完全访问')).click()`);
		await until(`[...document.querySelectorAll('button')].some(button => button.textContent.trim() === '确认开启')`, "开完全访问要再确认一次");
		await page(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '确认开启').click()`);
		await until(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip === 'full'`, "权限签切到完全访问");

		await send(ROUND2);
		await planCard("改 hello.txt（定稿）", "完全访问下计划卡照样弹出");
		if (!seen.toolu_plan_submit2?.includes("not approved")) throw new Error(`拒绝以后模型应该收到没批准，实际是 ${JSON.stringify(seen.toolu_plan_submit2)}`);
		if (!seen.toolu_plan_edit2?.includes("Plan mode: it edits files"))
			throw new Error(`完全访问下 edit 照样该被拒，实际是 ${JSON.stringify(seen.toolu_plan_edit2)}`);
		if (!seen.toolu_plan_escalate?.includes("may not leave")) throw new Error(`申请离开沙箱应该被拒，实际是 ${JSON.stringify(seen.toolu_plan_escalate)}`);
		for (const file of ["blocked.txt", "escalated.txt"])
			if (
				await access(join(workspace, file)).then(
					() => true,
					() => false,
				)
			)
				throw new Error(`计划模式下命令写出了 ${file}（模型收到 ${JSON.stringify(seen.toolu_plan_write)}）`);
		// 停一会儿看它不被自动放行：完全访问放行的是审批，等人卡要人答。
		await new Promise((resolve) => setTimeout(resolve, 1500));
		if (seen.toolu_plan_submit3 !== undefined || !(await page<boolean>(`document.querySelector('${card}') !== null`)))
			throw new Error("完全访问下计划卡被自动放行了");
		if (await page<boolean>(`document.querySelector('${card} [data-plan-action=accept-auto]') !== null`))
			throw new Error("完全访问下不该有「接受并开启自动模式」");
		await mainNotAlone("完全访问下");
		await capture("smoke-plan-full-access.png");

		// 接受：卡收起、开关关掉，同一轮里模型接着改。
		await page(`document.querySelector('${card} [data-plan-action=accept]').click()`);
		await until(chatHas(DONE), "批准以后模型接着做完");
		await until(turnEnded, "批准的那一轮收尾");
		await until(toggleOff, "批准以后计划模式关掉");
		// 上面等的时候它还是 undefined，TypeScript 把它收窄成了 undefined：重新取一次。
		const approved = seen["toolu_plan_submit3" as string];
		if (!approved?.includes("The user approved the plan")) throw new Error(`模型应该收到批准，实际是 ${JSON.stringify(approved)}`);
		const content = await readFile(join(workspace, "hello.txt"), "utf8");
		if (content !== "planned\n")
			throw new Error(`批准以后 edit 应该改成了 planned，实际是 ${JSON.stringify(content)}（模型收到 ${JSON.stringify(seen.toolu_plan_apply)}）`);
		const stop = (await agent.sessions()).find((item) => item.id === sessionId)?.stop;
		if (stop && stop.reason !== "done") throw new Error(`批准的那一轮没有正常收尾：${JSON.stringify(stop)}`);

		// 4. 环境卡片里「计划」一节列出批准的那份；看完收起，免得它留在后面的截图里。
		await until(`document.querySelector('[data-environment-toggle]') !== null`, "环境开关在");
		await page(`document.querySelector('[data-environment-toggle]').click()`);
		await until(`document.querySelector('[data-plan-section]')?.textContent.includes('改 hello.txt（定稿）') === true`, "环境卡片里列出批准的计划");
		await capture("smoke-plan-environment.png");
		await page(`document.querySelector('[data-environment-toggle]').click()`);
		await until(`document.querySelector('[data-plan-section]') === null`, "收起环境卡片");
	} finally {
		setModel(undefined);
	}
}
