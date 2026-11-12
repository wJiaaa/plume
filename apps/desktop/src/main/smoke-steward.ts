import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { clickVisibleScript, waitFor } from "./smoke-kit.ts";
import { runPluginCli } from "./smoke-plugin-cli.ts";

const PROBE = "example.steward-probe";
const PANEL = `${PROBE}/steward`;
const FIRST = "冒烟：开一个代管会话";
const READY = "代管会话开好了。";
const POST = "冒烟：在工作区新建 steward.txt，再问我一句";
const QUESTION = "文件写好了，要不要先备份？";
const PICK = "先备份";
const FINAL = "按你说的，先备份。";
const LATE = "冒烟：停止代管以后再转一句";
const DELEGATE = "冒烟：派个子 Agent 写 steward-child.txt";
const TASK_TITLE = "写代管子文件";
const CHILD_DONE = "子 Agent 写好了 steward-child.txt。";
const WAITING = "子 Agent 在后台写，我等它交回。";
const DELEGATED = "子 Agent 交回了，steward-child.txt 写好了。";

/** 请求里这次调用的结果的文字；还没有结果时是 undefined。 */
function toolResult(request: Record<string, unknown>, id: string): string | undefined {
	for (const message of (request.messages as { content?: unknown }[] | undefined) ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
			if (block.type !== "tool_result" || block.tool_use_id !== id) continue;
			if (typeof block.content === "string") return block.content;
			return ((block.content as { text?: string }[] | undefined) ?? []).map((part) => part.text ?? "").join("");
		}
	}
	return undefined;
}

/**
 * 插件代管会话（`launch({ steward: true })`、`ctx.sessions.post`、`respond`、`answer`），经测试插件「代管探针」（packages/testing/steward-probe）
 * 走一遍真界面：构建、装上它；在它的面板里开一个代管会话，标题栏标着由它代管；面板转进一句话开一轮，气泡标「代管探针 转来」，
 * 模型读到的前面有来处说明；假模型新建文件弹审批卡，面板上「允许这一次」，桌面上的卡跟着收起，那次调用底下写「由 代管探针 代答」；
 * 再调 `ask_user`，面板交回答案，模型拿到的就是它；面板列出模型的回复。再转一句让模型派一个子 Agent（plume.subagents 的子会话），
 * 子 Agent 新建文件弹的审批卡压在桌面的输入框上方，面板也收到、注明是子会话弹的，面板「允许这一次」，桌面的卡收起，
 * 子 Agent 读到的结果写明由插件转达，交回以后父会话接着说。最后人在会话菜单里「停止代管」，面板再转话被拒。
 */
export async function checkSteward(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; builtinDir: string; uploadDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = (code: string, label: string) => waitFor(() => page<boolean>(code), `代管会话：${label}`);
	const click = async (selector: string, text?: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)}) !== null`, `等到 ${text ?? selector}`);
		if (!(await page<boolean>(clickVisibleScript(selector, text)))) throw new Error(`点不到 ${text ?? selector}`);
	};
	const capture = async (name: string) => {
		await page(`new Promise(resolve => setTimeout(resolve, 500))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const chat = "[data-screen=chat]";
	const chatHas = (text: string) => `document.querySelector('${chat}')?.textContent.includes(${JSON.stringify(text)}) === true`;
	const probe = `[data-panel="${PANEL}"]:not([inert]) [data-steward-probe]`;
	/** 在面板里写一句话：先点进那个框，再像人一样敲进去。 */
	const type = async (field: string, words: string) => {
		await page(`document.querySelector(${JSON.stringify(`${probe} ${field}`)}).focus()`);
		await window.webContents.insertText(words);
	};
	const openPanel = async () => {
		if (await page<boolean>(`document.querySelector('[data-panel-area]')?.inert === true`)) await click("[data-panel-toggle] button");
		if (!(await page<boolean>(`document.querySelector('[data-panel-launch="${PANEL}"]') !== null`))) await click("button[data-panel-add]");
		await click(`[data-panel-launch="${PANEL}"]`);
		await until(`document.querySelector(${JSON.stringify(probe)}) !== null`, "开出代管探针的面板");
	};

	// 1. 构建、装上代管探针：源码在仓库里，复制一份到这次运行的目录里构建，不往仓库里写 dist/。
	if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
	const dir = join(outDir, "steward-probe");
	const source = join(plugin.builtinDir, "../testing/steward-probe");
	await Promise.all(["src", "package.json", "README.md"].map((name) => cp(join(source, name), join(dir, name), { recursive: true })));
	await runPluginCli(plugin.cli, ["build", dir]);
	await runPluginCli(plugin.cli, ["install", dir, "--to", plugin.uploadDir]);
	await waitFor(async () => (await agent.plugins()).some((status) => status.name === PROBE && status.state === "active"), "代管探针已启用");

	const requests: string[] = [];
	let answered: string | undefined;
	let approved: string | undefined;
	let childApproved: string | undefined;
	// 按整段对话认走到哪一步，越往后的越先认。
	setModel((request) => {
		const tools = new Set(((request.tools as { name?: string }[] | undefined) ?? []).map((tool) => tool.name));
		const all = JSON.stringify(request.messages ?? []);
		// 子 Agent 的请求：它有 write、没有派子 Agent 的 task。新建文件要审批，由面板代答。
		if (tools.has("write") && !tools.has("task")) {
			const wrote = toolResult(request, "toolu_steward_child_write");
			if (wrote === undefined)
				return { toolCalls: [{ id: "toolu_steward_child_write", name: "write", args: { path: "steward-child.txt", content: "child\n" } }] };
			childApproved = wrote;
			return { text: CHILD_DONE };
		}
		// 标题这类不带工具的小调用不参与。
		if (!tools.has("ask_user")) return { text: "代管" };
		requests.push(all);
		if (all.includes(DELEGATE)) {
			if (all.includes(CHILD_DONE)) return { text: DELEGATED };
			if (toolResult(request, "toolu_steward_task") !== undefined) return { text: WAITING };
			return {
				toolCalls: [
					{
						id: "toolu_steward_task",
						name: "task",
						args: { description: TASK_TITLE, prompt: "在 steward-child.txt 里写一行 child", subagent_type: "general" },
					},
				],
			};
		}
		const asked = toolResult(request, "toolu_steward_ask");
		if (asked !== undefined) {
			answered = asked;
			return { text: FINAL };
		}
		const wrote = toolResult(request, "toolu_steward_write");
		if (wrote !== undefined) {
			approved = wrote;
			return {
				toolCalls: [
					{
						id: "toolu_steward_ask",
						name: "ask_user",
						args: { question: QUESTION, options: [{ label: PICK }, { label: "直接用" }] },
					},
				],
			};
		}
		if (all.includes(POST)) return { toolCalls: [{ id: "toolu_steward_write", name: "write", args: { path: "steward.txt", content: "stewarded\n" } }] };
		return { text: READY };
	});
	try {
		// 「请求批准」档下新建文件要问人：审批卡才弹得出来。权限是这个会话（全局设置）的，插件转来的那一轮照它。
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await click("[data-permission-chip]");
		await until(`document.querySelectorAll('[role=menuitem]').length === 3`, "权限菜单列出三档");
		await page(`[...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent.trim().startsWith('请求批准')).click()`);
		await until(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip === 'ask'`, "权限签切到「请求批准」");

		// 2. 面板里开一个代管会话，转过去；标题栏标着由谁代管。
		await openPanel();
		await type("[data-probe-input]", FIRST);
		await click(`${probe} [data-probe-open]`);
		let sessionId = "";
		await waitFor(async () => {
			sessionId = (await agent.sessions()).find((item) => item.steward === PROBE)?.id ?? "";
			return sessionId !== "";
		}, "代管会话已创建");
		await until(chatHas(READY), "代管会话的第一轮回完");
		await until(
			`document.querySelector('header [data-plume-steward="${PROBE}"]')?.textContent.includes('由 代管探针 代管') === true`,
			"标题栏标着由代管探针代管",
		);

		// 3. 在这个会话里开面板，转进一句话：排进队、开一轮，气泡标着是代管探针转来的。
		await openPanel();
		await until(`document.querySelector('${probe}[data-steward-probe="${sessionId}"] [data-probe-stewarded=yes]') !== null`, "面板认出本插件代管着这个会话");
		await type("[data-probe-input]", POST);
		await click(`${probe} [data-probe-post]`);
		await until(
			`[...document.querySelectorAll('${chat} [data-plume-quote=user]')].some((bubble) => bubble.textContent.includes(${JSON.stringify(POST)}) && bubble.querySelector('[data-relayed-by="${PROBE}"]')?.textContent.includes('代管探针 转来'))`,
			"转来的话画成人的气泡，标着代管探针转来",
		);

		// 4. 新建文件弹审批卡：桌面上有卡，面板上也列出来；面板「允许这一次」，桌面的卡跟着收起。
		await until(`document.querySelector('[data-approval-card]')?.textContent.includes('steward.txt') === true`, "桌面上弹出新建文件的审批卡");
		await until(`document.querySelector('${probe} [data-probe-pending-type=approval]') !== null`, "面板经 observe 收到审批卡");
		await capture("smoke-steward-approval.png");
		await click(`${probe} [data-probe-allow]`);
		await until(`document.querySelector('${probe} [data-probe-pending-type=request]') !== null`, "面板收到提问卡");
		if (await page<boolean>(`document.querySelector('[data-approval-card]')?.textContent.includes('steward.txt') === true`))
			throw new Error("面板答过的审批卡还留在桌面上");
		await until(
			`document.querySelector('${chat} [data-answered-by="${PROBE}"]')?.textContent.includes('由 代管探针 代答') === true`,
			"新建文件那次调用底下写着由代管探针代答",
		);

		// 5. 提问卡：面板交回答案，模型拿到的就是它；面板列出模型的回复。
		await type("[data-probe-answer-input]", PICK);
		await click(`${probe} [data-probe-answer]`);
		await until(chatHas(FINAL), "答完以后模型接着说");
		await until(
			`[...document.querySelectorAll('${probe} [data-probe-reply]')].some((line) => line.textContent.includes(${JSON.stringify(FINAL)}))`,
			"面板列出模型的回复",
		);
		await until(`document.querySelectorAll('${chat} [data-answered-by="${PROBE}"]').length >= 2`, "提问那次调用底下也写着代答");
		if (!answered?.startsWith(PICK) || !answered.includes(`relayed by the plugin "${PROBE}"`))
			throw new Error(`模型拿到的回答应该是「${PICK}」并写明由插件转达，实际是 ${JSON.stringify(answered)}`);
		if (!approved?.includes(`relayed by the plugin "${PROBE}"`)) throw new Error(`新建文件的结果里应该写明审批由插件转达，实际是 ${JSON.stringify(approved)}`);
		const relayed = requests.find((text) => text.includes(POST));
		if (!relayed?.includes("（插件转来）") || !relayed.includes("不是用户在 Plume 的输入框里打的")) throw new Error("模型读到的转来的话前面没有来处说明");
		await capture("smoke-steward.png");

		// 6. 让模型派一个子 Agent：子会话挂在代管会话下面、由 plume.subagents 建；它新建文件弹的审批卡压在桌面的输入框上方，
		// 面板经 observe 也收到（注明是子会话弹的）并代答，桌面的卡跟着收起；子 Agent 交回以后父会话接着说。
		await type("[data-probe-input]", DELEGATE);
		await click(`${probe} [data-probe-post]`);
		await until(
			`document.querySelector('[data-approval-from]')?.textContent.includes(${JSON.stringify(TASK_TITLE)}) === true`,
			"子 Agent 的审批卡压在输入框上方",
		);
		// 派出子 Agent 时右栏自己开了子 Agent 面板、换到了它那一格：换回代管探针。
		await click(`[data-panel-tab="${PANEL}"] [role=tab]`);
		await until(`document.querySelector('${probe} [data-probe-pending-type=approval][data-probe-pending-child=yes]') !== null`, "面板收到子会话弹的审批卡");
		await capture("smoke-steward-child-approval.png");
		await click(`${probe} [data-probe-allow]`);
		await until(`document.querySelector('[data-approval-from]') === null`, "面板答过以后桌面上子 Agent 的卡收起");
		await until(chatHas(DELEGATED), "子 Agent 交回以后父会话接着说");
		if (!childApproved?.includes(`relayed by the plugin "${PROBE}"`))
			throw new Error(`子 Agent 新建文件的结果里应该写明审批由插件转达，实际是 ${JSON.stringify(childApproved)}`);
		const child = (await agent.sessions()).find((item) => item.parentId === sessionId);
		if (!child) throw new Error("代管会话下面没有子 Agent 的子会话");
		await capture("smoke-steward-child.png");

		// 7. 人在会话菜单里停止代管：标注拿掉，面板再转话被本体拒绝，会话里不多出这句。
		await click('header button[aria-label="会话操作"]');
		await click('[role=menu][aria-label="会话选项"] [role=menuitem]', "停止代管");
		await until(`document.querySelector('header [data-plume-steward]') === null`, "标题栏不再标代管");
		if ((await agent.sessions()).find((item) => item.id === sessionId)?.steward !== undefined) throw new Error("停止代管后摘要里还有 steward");
		await until(`document.querySelector('${probe} [data-probe-stewarded=no]') !== null`, "面板认出不再代管");
		await type("[data-probe-input]", LATE);
		await click(`${probe} [data-probe-post]`);
		await until(`document.querySelector('${probe} [data-probe-error]')?.textContent.includes('不由插件 ${PROBE} 代管') === true`, "停止代管后转话被拒");
		if (await page<boolean>(chatHas(LATE))) throw new Error("停止代管后转的话还是进了会话");
		await capture("smoke-steward-revoked.png");
	} finally {
		setModel(undefined);
	}
}
