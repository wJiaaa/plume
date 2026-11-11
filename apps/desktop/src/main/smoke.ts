/**
 * 冒烟验证（`pnpm smoke`）：用真实的 Electron 把产品和市场里的插件走一遍，只把模型换成本地的假 Anthropic 服务。
 * 全程经界面操作：
 *
 * 1. 在「模型设置」里添加假服务这个供应商和它的模型，把供应商导出成文件再导回来，在设置 › 常规里关掉智能标题总结；
 *    到侧栏的「插件市场」里装上定时任务和终端两个插件（不重启，装上就加载），打开定时任务的详情页看 README，
 *    再点筛选条的「已安装」看它们都在、在详情页停用再启用；然后从欢迎页选择项目（文件夹直接给准备好的工作目录），发一句话；
 * 2. 假模型一次回三个工具调用：todo_write、bash `cat hello.txt`、edit hello.txt；
 * 3. 发送前在输入框的权限签上从默认的「帮我批准」切到「请求批准」（菜单里有三档）：帮我批准下项目里的 edit 不问；
 *    read 不用确认；cat 是只读命令，也不用确认（在只读沙箱里跑）；cat 和 edit 在转录里合成一段活，点开它；只有 edit 在输入框上方弹出审批卡，正文是 diff，点「允许一次」；
 * 4. 假模型收到工具结果后说结束语；
 * 5. 点标题栏右端的开关打开面板区，是一个开始页标签，上面有任务、调用轨迹、项目文件和终端卡片；点「终端」这个标签变成终端面板，跑一条命令，用 ⌃` 收起、再打开；
 *    再用 `plume-plugin` 装上 Git 插件，把工作区变成仓库：开始页列出 Git，输入框上方出现分支签和改动计数，点改动计数开出 Git 面板，列出没提交的文件；
 * 6. 用 `plume-plugin`（应用生成的启动脚本）把子 Agent、侧边聊天插件装进安装目录，不重启就加载上；再装下一步建议插件发一句话：
 *    回复末尾的 `:followup[…]` 不画进正文、成了输入框的灰字，按 Tab 填进去；模型选择左边出现上下文用量的圆环（内置的用量与状态），点开写出窗口占用；
 *    装上使用统计插件，设置 › 数据里多出「使用统计」一页，读出上面那几轮的花销；设置 › 常规里切一次「不让电脑休眠」；
 * 7. 到「外观」里选深色主题、选一张会话背景图（选图对话框直接给第一张截图），回到会话看背景。
 *
 * 检查：外观设置存了下来、页面跟着变成深色、会话里铺上了背景；只有 edit 要确认、审批卡里有 diff、输入框上的权限签是「请求批准」；todo 清单卡片
 * 跟着会话（对话列够宽时浮在右上角，打开面板区变窄后回到输入框上方），两项、停在没勾上的那一步；
 * 模型收到的工具里有 todo_write；文件改对了；插件都是 active。
 *
 * 只在设置了 PLUME_SMOKE_OUT 时启用；这时模型设置写在冒烟输出目录里，不碰 ~/.plume/settings.json。
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fakeAnthropic, type FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { app, BrowserWindow, clipboard, dialog, shell, type SaveDialogOptions } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { plumeHome } from "./home.ts";
import { checkPanelResize, checkSidebarResize } from "./smoke-sidebar-resize.ts";
import { checkFiles } from "./smoke-files.ts";
import { checkDocumentPlugins } from "./smoke-document-plugins.ts";
import { checkDelivery } from "./smoke-delivery.ts";
import { checkPullRequests } from "./smoke-pull-requests.ts";
import { checkComposerHistory } from "./smoke-composer-history.ts";
import { checkQueueActions } from "./smoke-queue.ts";
import { checkQuoteSideChat, prepareQuoteSideChat } from "./smoke-quote-side-chat.ts";
import { checkProjectConfig } from "./smoke-project-config.ts";
import { checkGallery } from "./smoke-gallery.ts";
import { checkMessageEdits } from "./smoke-message-edits.ts";
import { checkRevertFiles } from "./smoke-revert-files.ts";
import { checkQuestion } from "./smoke-question.ts";
import { checkNativeUi } from "./smoke-native-ui.ts";
import { checkPreview } from "./smoke-preview.ts";
import { checkMarkdownImages } from "./smoke-markdown-images.ts";
import { checkOpenFile } from "./smoke-open-file.ts";
import { checkSkinStudio } from "./smoke-skin-studio.ts";
import { checkUsage } from "./smoke-usage.ts";
import { checkMemoryFiles } from "./smoke-memory-files.ts";
import { checkInputMenu } from "./smoke-input-menu.ts";
import { checkUpdate } from "./smoke-update.ts";
import { checkBackgroundJob } from "./smoke-background-job.ts";
import { checkEnvironment } from "./smoke-environment.ts";
import { checkPeers } from "./smoke-peers.ts";
import { checkSpawnSession } from "./smoke-spawn-session.ts";
import { checkHooks } from "./smoke-hooks.ts";
import { checkBrowser, type ModelOverride } from "./smoke-browser.ts";
import { checkNavigation } from "./smoke-navigation.ts";
import { checkCompact } from "./smoke-compact.ts";
import { checkPanelsFramework, checkSideChatWindow } from "./smoke-panels.ts";
import { checkFileTerminal } from "./smoke-file-terminal.ts";
import { checkSessionWindow } from "./smoke-session-window.ts";
import { checkConversations } from "./smoke-conversations.ts";
import { checkDesktopCompat } from "./smoke-desktop-compat.ts";
import { recentSessions } from "./tray-menu.ts";
import { clickVisibleScript, waitFor } from "./smoke-kit.ts";

export function smokeOutput(): { file: string; dir: string; workspace: string } | undefined {
	const file = process.env.PLUME_SMOKE_OUT;
	return file ? { file, dir: dirname(file), workspace: join(dirname(file), "workspace") } : undefined;
}

const FINAL_TEXT = "改好了：hello.txt 第一行现在是 hi。";
const TASK_TITLE = "写说明";
const CHILD_TEXT = "写好了 child.txt。";
const TASK_FINAL = "子 Agent 写好了说明。";
const SIDE_QUESTION = "它刚才写了什么？";
const SIDE_TEXT = "它让子 Agent 写了 child.txt。";
/** 装上下一步建议插件后的一轮：回复末尾顺带一行 `:followup[…]`，界面不画它、把它放进输入框的灰字。 */
const FOLLOWUP_HINT = "跑一遍单元测试";
const FOLLOWUP_REPLY = `都齐了。\n:followup[${FOLLOWUP_HINT}]`;
const SCHEDULED_TEXT = "定时任务看过了，没有问题。";

interface SmokeOptions {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	workspace: string;
	file: string;
	shutdown(): Promise<void>;
	/** 启动脚本（写不了时没有）、从市场装插件、内置插件的目录、市场装的和本地上传的各自的目录。 */
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; builtinDir: string; installDir: string; uploadDir: string };
}

export async function runSmoke({ window, agent, workspace, file, shutdown, plugin }: SmokeOptions): Promise<void> {
	const sessionMenuOnly = process.env.PLUME_SMOKE_ONLY === "session-menu";
	const pullRequestsOnly = process.env.PLUME_SMOKE_ONLY === "pull-requests";
	const sessionWindowOnly = process.env.PLUME_SMOKE_ONLY === "session-window";
	let childrenPhase = false;
	let scripted = 0;
	const replies: FakeReply[] =
		sessionMenuOnly || pullRequestsOnly || sessionWindowOnly
			? [{ text: "会话菜单验证完成。" }]
			: [
					{
						text: "先列个计划，看一眼文件再改。",
						toolCalls: [
							{
								id: "toolu_todo",
								name: "todo_write",
								args: {
									todos: [
										{ content: "看 hello.txt", status: "completed" },
										{ content: "把 hello 改成 hi", status: "in_progress", activeForm: "正在把 hello 改成 hi" },
									],
								},
							},
							{ id: "toolu_cat", name: "bash", args: { command: "cat hello.txt" } },
							// edit 之前要读过这个文件。
							{ id: "toolu_read", name: "read", args: { path: "hello.txt" } },
							{ id: "toolu_edit", name: "edit", args: { path: "hello.txt", old_string: "hello", new_string: "hi" } },
							...["a", "b", "c"].map((part) => ({
								id: `toolu_delivery_${part}`,
								name: "write",
								args: { path: `delivery-${part}.ts`, content: `export const ${part} = 1;\n` },
							})),
						],
					},
					// 第二个请求先 503 一次：重试接上后，转录里留一行「断了一下，已恢复」。
					{ status: 503 },
					// 接上的那次写到一半撞上输出上限：本体让它接着写，那句话不画成人的气泡。
					{ text: "先说结论，", truncated: true },
					{ text: FINAL_TEXT },
					// 回答后的清单追问只更新清单，不再生成正文；仍保留待办，覆盖停在半路的清单外观。
					{
						toolCalls: [
							{
								id: "toolu_todo_settle",
								name: "todo_write",
								args: {
									todos: [
										{ content: "看 hello.txt", status: "completed" },
										{ content: "把 hello 改成 hi", status: "in_progress", activeForm: "正在把 hello 改成 hi" },
									],
								},
							},
						],
					},
					{ text: FOLLOWUP_REPLY },
				];
	// 父子会话并发请求，不用固定序号猜是谁；审批未放行时父会话先正常收尾，覆盖闲时送达。
	// 单独一段冒烟（浏览器）临时接管假模型，用完放回。
	let override: ModelOverride | undefined;
	/** 各专项自行验收模型请求，不能混进基础流程的固定次数。 */
	let extraRequests = 0;
	const model = await fakeAnthropic((request) => {
		if (override) {
			extraRequests++;
			return override(request);
		}
		if (!childrenPhase) return replies[Math.min(scripted++, replies.length - 1)] ?? { text: "" };
		const tools = new Set(((request.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name));
		const messages = JSON.stringify(request.messages);
		if (tools.has("read_main_chat")) return { text: SIDE_TEXT };
		if (!tools.has("task") && !tools.has("write")) return { text: "只读检查完成。" };
		if (!tools.has("task"))
			return messages.includes("toolu_child_write")
				? { text: CHILD_TEXT }
				: { toolCalls: [{ id: "toolu_child_write", name: "write", args: { path: "child.txt", content: "child\n" } }] };
		if (messages.includes(CHILD_TEXT)) return { text: TASK_FINAL };
		if (messages.includes("toolu_task")) return { text: "子 Agent 在后台写说明，我等它交回结果。" };
		return {
			text: "交给子 Agent。",
			toolCalls: [
				{ id: "toolu_task", name: "task", args: { description: TASK_TITLE, prompt: "在 child.txt 里写一行 child", subagent_type: "general" } },
				{
					id: "toolu_task_review",
					name: "task",
					args: { description: "核对很长的任务标题以及窄面板下的状态文字布局", prompt: "只读检查", subagent_type: "explore" },
				},
			],
		};
	});
	const outDir = dirname(file);
	guardWindow(window);
	app.on("browser-window-created", (_event, created) => guardWindow(created));
	try {
		window.webContents.debugger.attach("1.3");
		// 窗口隐藏时 document.hasFocus() 为 false，键盘能换焦点但不画焦点环；模拟前台而不抢用户窗口。
		await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
		await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, "hello.txt"), "hello\n");

		const page = (code: string) => window.webContents.executeJavaScript(code) as Promise<unknown>;
		const until = (code: string, label: string) => waitFor(async () => Boolean(await page(code)), label);
		// 找不到时把原因带回来：页面里抛的错到这边只剩一句「Script failed to execute」。
		const click = async (selector: string, text?: string) => {
			if (!(await page(clickVisibleScript(selector, text)))) throw new Error(`找不到 ${selector} ${text ?? ""}`);
		};
		const type = (selector: string, value: string) =>
			page(`(() => {
				const input = document.querySelector(${JSON.stringify(selector)});
				const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)});
				input.dispatchEvent(new Event('input', { bubbles: true }));
			})()`);

		const checkSessionMenu = async () => {
			// 右键操作走真实页面、预加载和 IPC；只替换系统出口，不改用户剪贴板、不弹访达窗口。
			const sessionMenu = '[role=menu][aria-label="会话选项"]';
			const renameDialog = '[role=dialog][aria-label="重命名会话"]';
			// 「在访达中显示」按平台换说法，和菜单本身一样（`revealKey`）。
			const revealLabel = process.platform === "darwin" ? "在访达中显示" : process.platform === "win32" ? "在资源管理器中显示" : "在文件管理器中显示";
			const openSessionMenu = async () => {
				await until(`document.querySelector(${JSON.stringify(sessionMenu)}) === null`, "上一次会话菜单已关闭");
				await page(
					`(() => { const row = document.querySelector('[data-plume-row]'); const rect = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 80, clientY: rect.top + 16 })); })()`,
				);
				await until(`document.querySelector(${JSON.stringify(sessionMenu)}) !== null`, "会话右键菜单出现");
			};
			const closeSessionMenu = async () => {
				window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
				window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
				await until(
					`document.querySelector(${JSON.stringify(sessionMenu)}) === null && document.querySelector(${JSON.stringify(renameDialog)}) === null`,
					"Escape 关闭会话浮层",
				);
			};
			await openSessionMenu();
			const items = await page(`[...document.querySelectorAll(${JSON.stringify(`${sessionMenu} [role=menuitem]`)})].map(item => item.textContent.trim())`);
			if (
				JSON.stringify(items) !==
				JSON.stringify([
					"置顶",
					"重命名",
					"归档",
					"标记为未读",
					"项目",
					"打开方式",
					revealLabel,
					"复制工作目录",
					"导出原始记录",
					"导出为 Markdown",
					"复制会话 ID",
					"查看调用轨迹",
				])
			)
				throw new Error(`会话菜单项不符：${JSON.stringify(items)}`);
			await until(
				`document.querySelector(${JSON.stringify(sessionMenu)}).getAnimations().every(animation => animation.playState === 'finished')`,
				"菜单入场动画完成",
			);
			await capture(window, join(outDir, "smoke-session-menu-light.png"));
			await click(`${sessionMenu} [role=menuitem]`, "重命名");
			await until(`document.activeElement?.getAttribute('name') === 'session-title'`, "重命名输入框自动聚焦");
			await type("[name=session-title]", "   ");
			await until(`document.querySelector(${JSON.stringify(`${renameDialog} button[type=submit]`)})?.disabled === true`, "空白标题不能保存");
			await type("[name=session-title]", "  会话右键回归  ");
			await capture(window, join(outDir, "smoke-session-rename.png"));
			await click(`${renameDialog} button[type=submit]`);
			await until(
				`document.querySelector(${JSON.stringify(renameDialog)}) === null && document.querySelector('[data-plume-row]')?.textContent.includes('会话右键回归') && document.querySelector('[data-plume-screen-title]')?.textContent === '会话右键回归'`,
				"重命名同步侧栏和标题栏",
			);
			// 键盘也能打开同一个菜单，取消编辑不改标题。
			await page(
				`(() => { const row = document.querySelector('[data-plume-row] > button'); row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); })()`,
			);
			await until(`document.querySelector(${JSON.stringify(sessionMenu)}) !== null`, "Shift+F10 打开会话菜单");
			await click(`${sessionMenu} [role=menuitem]`, "重命名");
			await type("[name=session-title]", "不保存的标题");
			await click(`${renameDialog} button[aria-label="取消"]`);
			await closeSessionMenu();
			if (!(await page(`document.querySelector('[data-plume-row]').textContent.includes('会话右键回归')`))) throw new Error("取消重命名仍改了标题");
			// 顶部与侧栏复用菜单，但锚点方向不同；用真实键盘打开并量最终位置。
			const titleButton = 'header button[aria-label="会话操作"]';
			const openTitleMenu = async () => {
				await click(titleButton);
				await until(
					`document.querySelector(${JSON.stringify(sessionMenu)}) !== null && document.querySelector(${JSON.stringify(titleButton)})?.getAttribute('aria-expanded') === 'true'`,
					"顶部菜单打开且按钮激活",
				);
				await until(
					`document.querySelector(${JSON.stringify(sessionMenu)}).getAnimations().every(animation => animation.playState === 'finished')`,
					"顶部菜单入场完成",
				);
			};
			await page(`document.querySelector(${JSON.stringify(titleButton)}).focus()`);
			await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
			await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
			await until(
				`document.querySelector(${JSON.stringify(sessionMenu)}) !== null && document.querySelector(${JSON.stringify(sessionMenu)}).getAnimations().every(animation => animation.playState === 'finished')`,
				"回车打开顶部菜单",
			);
			const geometry = await page(`(() => {
				const button = document.querySelector(${JSON.stringify(titleButton)}).getBoundingClientRect();
				const menu = document.querySelector(${JSON.stringify(sessionMenu)}).getBoundingClientRect();
				const title = document.querySelector('[data-plume-screen-title]');
				const icon = title.previousElementSibling.getBoundingClientRect();
				return { width: innerWidth, left: menu.left - button.left, gap: menu.top - button.bottom, icon: [icon.width, icon.height], weight: getComputedStyle(title).fontWeight, items: [...document.querySelectorAll(${JSON.stringify(`${sessionMenu} [role=menuitem]`)})].map(item => item.textContent.trim()) };
			})()`);
			const head = geometry as { left: number; gap: number; icon: number[]; weight: string; items: string[] };
			if (
				Math.abs(head.left) > 1 ||
				Math.abs(head.gap - 8) > 1 ||
				head.icon.join() !== "15,15" ||
				head.weight !== "400" ||
				JSON.stringify(head.items) !== JSON.stringify(items)
			)
				throw new Error(`顶部菜单与参考布局不符：${JSON.stringify(geometry)}`);
			await capture(window, join(outDir, "smoke-session-title-light.png"));
			await closeSessionMenu();
			await until(`document.activeElement === document.querySelector(${JSON.stringify(titleButton)})`, "关闭顶部菜单后焦点回到按钮");
			await openTitleMenu();
			await click(titleButton);
			await until(`document.querySelector(${JSON.stringify(sessionMenu)}) === null`, "再次点击顶部按钮关闭菜单");
			await openTitleMenu();
			await click(`${sessionMenu} [role=menuitem]`, "重命名");
			await type("[name=session-title]", "这是一段用于验证窄窗口标题让位的很长会话标题，菜单按钮必须始终可见");
			await click(`${renameDialog} button[type=submit]`);
			await until(`document.querySelector(${JSON.stringify(renameDialog)}) === null`, "顶部重命名保存");
			const titleWindowSize = window.getSize();
			await page(`window.plume.saveAppearance({ theme: "dark" })`);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "顶部菜单切到深色");
			await openTitleMenu();
			await capture(window, join(outDir, "smoke-session-title-dark.png"));
			for (const [width, height] of [
				[380, titleWindowSize[1]!],
				[titleWindowSize[0]!, 440],
				[380, 440],
			]) {
				window.setSize(width!, height!);
				await until(
					`innerWidth <= ${width} && innerHeight <= ${height} && (() => { const menu = document.querySelector(${JSON.stringify(sessionMenu)})?.getBoundingClientRect(); const button = document.querySelector(${JSON.stringify(titleButton)})?.getBoundingClientRect(); const title = document.querySelector('[data-plume-screen-title]')?.getBoundingClientRect(); return menu && button && title && menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight && button.width === 28 && button.right <= innerWidth && title.right <= button.left; })()`,
					"长标题让位且顶部菜单不越界",
				);
			}
			await capture(window, join(outDir, "smoke-session-title-compact.png"));
			await closeSessionMenu();
			window.setSize(titleWindowSize[0]!, titleWindowSize[1]!);
			await until(`innerWidth > 380`, "恢复顶部测试窗口");
			await page(`window.plume.saveAppearance({ theme: "light" })`);
			await openTitleMenu();
			await click(`${sessionMenu} [role=menuitem]`, "重命名");
			await type("[name=session-title]", "会话右键回归");
			await click(`${renameDialog} button[type=submit]`);
			await until(`document.querySelector('[data-plume-screen-title]')?.textContent === '会话右键回归'`, "恢复测试标题");
			await openTitleMenu();
			await click("[data-nav=new-chat]");
			await until(
				`document.querySelector(${JSON.stringify(sessionMenu)}) === null && document.querySelector(${JSON.stringify(titleButton)}) === null`,
				"新对话不保留旧菜单或顶部入口",
			);
			await click("[data-plume-row] > button");
			await until(`document.querySelector(${JSON.stringify(titleButton)})?.getAttribute('aria-expanded') === 'false'`, "回到会话不带回旧菜单");
			console.log(`PLUME_SESSION_TITLE_SMOKE ${JSON.stringify(geometry)}`);

			const originalCopy = clipboard.writeText;
			const originalReveal = shell.showItemInFolder;
			let copied = "";
			let revealed = "";
			clipboard.writeText = async (text) => {
				copied = text;
			};
			shell.showItemInFolder = (path) => {
				revealed = path;
			};
			try {
				await openSessionMenu();
				await click(`${sessionMenu} [role=menuitem]`, "复制工作目录");
				await waitFor(async () => copied === workspace, "复制的是会话工作目录");
				const id = await page(`document.querySelector('[data-plume-row]').dataset.plumeRow`);
				await openSessionMenu();
				await click(`${sessionMenu} [role=menuitem]`, "复制会话 ID");
				await waitFor(async () => copied === id, "复制的是右键会话 ID");
				await openSessionMenu();
				await click(`${sessionMenu} [role=menuitem]`, revealLabel);
				await waitFor(async () => revealed === workspace, "访达定位的是会话工作目录");
			} finally {
				clipboard.writeText = originalCopy;
				shell.showItemInFolder = originalReveal;
			}
			const sessionId = (await page(`document.querySelector('[data-plume-row]').dataset.plumeRow`)) as string;
			const savedSummary = () => {
				const db = new DatabaseSync(join(plumeHome(), "sessions", "sessions.db"), { readOnly: true });
				try {
					return JSON.parse(db.prepare("SELECT summary FROM sessions WHERE id = ?").get(sessionId)!.summary as string) as {
						pinned?: boolean;
						unread?: boolean;
						project?: string;
						cwd: string;
					};
				} finally {
					db.close();
				}
			};
			const originalProject = savedSummary().project;
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "置顶");
			await until(
				`document.querySelector('[data-plume-section=pinned]') !== null && document.querySelectorAll('[data-plume-row]').length === 1`,
				"置顶分区出现且会话不重复",
			);
			await waitFor(async () => savedSummary().pinned === true, "置顶状态已落盘");
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "取消置顶");
			await until(
				`document.querySelector('[data-plume-section=pinned]') === null && document.querySelectorAll('[data-plume-row]').length === 1`,
				"取消置顶回到原分区",
			);
			await click('[data-plume-row] button[aria-label="置顶会话"]');
			await until(`document.querySelector('[data-plume-section=pinned]') !== null`, "行上置顶按钮生效");
			await click('[data-plume-row] button[aria-label="取消置顶"]');
			await until(`document.querySelector('[data-plume-section=pinned]') === null`, "行上取消置顶按钮生效");
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "标记为未读");
			await waitFor(async () => savedSummary().unread === true, "当前会话手动未读不立即消失");
			await until(`document.querySelector('[data-plume-row] [data-plume-status-mark=unread]') !== null`, "手动未读显示强调色实心点");
			await openTitleMenu();
			await until(
				`[...document.querySelectorAll(${JSON.stringify(`${sessionMenu} [role=menuitem]`)})].some(item => item.textContent.trim() === '标记为已读')`,
				"顶部和侧栏共享未读状态",
			);
			await click(`${sessionMenu} [role=menuitem]`, "标记为已读");
			await waitFor(async () => !savedSummary().unread, "手动标为已读");
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "标记为未读");
			await waitFor(async () => savedSummary().unread === true, "再次标为未读");
			await until(`document.querySelector('[data-plume-row] [data-plume-status-mark=unread]') !== null`, "未读状态已同步到会话行");
			await click("[data-plume-row] > button");
			await waitFor(async () => !savedSummary().unread, "点击已打开的会话也清除未读");
			await until(`document.querySelector('[data-plume-row] [data-plume-status-mark=idle]') !== null`, "已读恢复空心状态点");

			// 第二个项目也经界面登记；不同目录的迁移由 agent 测试覆盖。
			await click('[data-plume-section-action] button[aria-label="新建项目"]');
			await type("[data-plume-project-dialog] input", "菜单迁移目标");
			await click("[data-plume-add-folder]");
			await until(`document.querySelector('[data-plume-source-folder]') !== null`, "迁移项目选好目录");
			await click("button", "创建项目");
			await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('菜单迁移目标')`, "迁移目标创建完成");
			await click("[data-plume-row] > button");
			const projectMenu = '[role=menu][aria-label="移动到项目"]';
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "项目");
			await until(
				`[...document.querySelectorAll(${JSON.stringify(`${projectMenu} [role=menuitem]`)})].some(item => item.disabled && item.textContent.includes('当前项目'))`,
				"当前项目不可重复移动",
			);
			await capture(window, join(outDir, "smoke-session-projects.png"));
			await click(`${projectMenu} [role=menuitem]`, "返回");
			await until(`document.querySelector(${JSON.stringify(sessionMenu)}) !== null`, "项目页返回主菜单");
			await click(`${sessionMenu} [role=menuitem]`, "项目");
			await click(`${projectMenu} [role=menuitem]`, "菜单迁移目标");
			await waitFor(async () => Boolean(savedSummary().project && savedSummary().project !== originalProject), "迁入另一项目并落盘");
			await click("[data-nav=new-chat]");
			await until(
				`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('菜单迁移目标')`,
				"移动当前会话同步下一段对话的项目",
			);
			await click("[data-plume-row] > button");
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "项目");
			await click(`${projectMenu} [role=menuitem]`, "从 菜单迁移目标 中移除");
			await waitFor(async () => !savedSummary().project && savedSummary().cwd === workspace, "移出项目但保留工作目录");
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "项目");
			await click(`${projectMenu} [role=menuitem]`, "workspace");
			await waitFor(async () => savedSummary().project === originalProject, "移回原项目");

			// 保存对话框是唯一替身；预加载、IPC、agent 和实际导出文件都走正式路径。
			const originalSave = dialog.showSaveDialog;
			let cancelled = false;
			let saveCalls = 0;
			let saveOptions: SaveDialogOptions | undefined;
			dialog.showSaveDialog = (async (...args: unknown[]) => {
				saveCalls++;
				saveOptions = args.at(-1) as SaveDialogOptions;
				const extension = saveOptions.filters?.[0]?.extensions[0];
				return { canceled: cancelled, filePath: join(outDir, extension === "md" ? "session-export.md" : "session-export.db") };
			}) as typeof dialog.showSaveDialog;
			try {
				await openSessionMenu();
				await click(`${sessionMenu} [role=menuitem]`, "导出原始记录");
				await until(`document.querySelector('[data-plume-toaster]')?.textContent.includes('已导出原始记录')`, "原始记录导出成功");
				if (!saveOptions?.defaultPath?.endsWith(".db") || saveOptions.filters?.[0]?.extensions[0] !== "db") throw new Error("原始记录保存对话框格式不符");
				const exported = new DatabaseSync(join(outDir, "session-export.db"), { readOnly: true });
				try {
					const ids = exported
						.prepare("SELECT id FROM sessions")
						.all()
						.map((row) => row.id);
					if (JSON.stringify(ids) !== JSON.stringify([sessionId]) || Number(exported.prepare("SELECT COUNT(*) AS n FROM records").get()?.n) < 2)
						throw new Error("原始记录不是选中会话的完整单条导出");
				} finally {
					exported.close();
				}
				await openSessionMenu();
				await click(`${sessionMenu} [role=menuitem]`, "导出为 Markdown");
				await until(`document.querySelector('[data-plume-toaster]')?.textContent.includes('已导出为 Markdown')`, "Markdown 导出成功");
				const markdown = await readFile(join(outDir, "session-export.md"), "utf8");
				if (!markdown.includes("会话右键回归") || !saveOptions?.defaultPath?.endsWith(".md") || String(saveOptions.filters?.[0]?.extensions[0]) !== "md")
					throw new Error("Markdown 导出或保存对话框格式不符");
				await page(`document.querySelectorAll('[data-plume-toaster] button[aria-label="关闭"]').forEach(button => button.click())`);
				await until(`!document.querySelector('[data-plume-toaster]')`, "清除导出成功提示");
				cancelled = true;
				await openSessionMenu();
				await click(`${sessionMenu} [role=menuitem]`, "导出为 Markdown");
				await waitFor(async () => saveCalls === 3, "保存对话框取消");
				await until(`document.querySelector(${JSON.stringify(sessionMenu)}) === null`, "取消导出后菜单关闭");
				if ((await page(`document.querySelector('[data-plume-toaster]') !== null`)) || (await readFile(join(outDir, "session-export.md"), "utf8")) !== markdown)
					throw new Error("取消导出仍写文件或提示成功");
			} finally {
				dialog.showSaveDialog = originalSave;
			}
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "置顶");
			await waitFor(async () => savedSummary().pinned === true, "归档前置顶");
			await openSessionMenu();
			await click(`${sessionMenu} [role=menuitem]`, "归档");
			await until(`document.querySelector('[data-plume-row]') === null`, "归档后会话离开侧栏");
			await until(`document.querySelector('[data-screen=empty]') !== null`, "归档当前会话后右侧换成新对话");
			await click("button", "设置");
			await click("[aria-label=设置章节] button", "已归档的聊天");
			await until(`document.querySelector('[data-plume-archive-group]') !== null`, "已归档里列出这个会话");
			await click("[data-plume-archive-group] > button");
			await until(`document.querySelector('[data-plume-archive-row]') !== null`, "点开归档的项目");
			await delay(300);
			await capture(window, join(outDir, "smoke-archived.png"));
			await click("[data-plume-archive-row] button", "取消归档");
			await until(`document.querySelector('[data-plume-archive-row]') === null`, "取消归档后离开已归档");
			await click("button", "返回工作区");
			await until(
				`document.querySelector('[data-plume-row]') !== null && document.querySelector('[data-plume-section=pinned]') !== null`,
				"取消归档后回到置顶区",
			);
			if (!savedSummary().pinned) throw new Error("归档丢失置顶状态");
			// 归档时已经离开了它；重新打开，后面的步骤接着在这个会话里做。
			await click("[data-plume-row] > button");
			await until(`document.querySelector('[data-screen=chat]') !== null`, "取消归档后重新打开会话");

			await page(`window.plume.saveAppearance({ theme: "dark" })`);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "菜单切到深色");
			await openSessionMenu();
			await capture(window, join(outDir, "smoke-session-menu-dark.png"));
			const menuWindowSize = window.getSize();
			for (const [width, height] of [
				[380, menuWindowSize[1]!],
				[menuWindowSize[0]!, 440],
				[380, 440],
			]) {
				window.setSize(width!, height!);
				await until(
					`innerWidth <= ${width} && innerHeight <= ${height} && (() => { const rect = document.querySelector(${JSON.stringify(sessionMenu)})?.getBoundingClientRect(); return rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`,
					"窄、矮窗口菜单不越界",
				);
			}
			await capture(window, join(outDir, "smoke-session-menu-compact.png"));
			await click(`${sessionMenu} [role=menuitem]`, "重命名");
			await until(
				`(() => { const rect = document.querySelector(${JSON.stringify(renameDialog)})?.getBoundingClientRect(); return rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`,
				"最小窗口重命名表单不越界",
			);
			await capture(window, join(outDir, "smoke-session-rename-compact.png"));
			await click(`${renameDialog} button[aria-label="取消"]`);
			await closeSessionMenu();
			window.setSize(menuWindowSize[0]!, menuWindowSize[1]!);
			await until(`innerWidth > 380`, "恢复正常窗口宽度");
			await page(`window.plume.saveAppearance({ theme: "light" })`);
			await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "菜单验证后恢复浅色");

			console.log("PLUME_SESSION_MENU_SMOKE ok");
		};

		// 欢迎页和会话页必须用同一张实色卡片，项目条和卡片共用托盘的左右边。
		const checkComposer = async (label: string) => {
			const result = (await page(`(() => {
				const tray = document.querySelector('.plume-composer-tray');
				const shell = tray?.querySelector('.plume-composer');
				const project = tray?.querySelector('[data-project-trigger]');
				const send = shell?.querySelector('[data-composer-send]');
				if (!tray || !shell || !project || !send) return { error: '输入框结构不完整' };
				const outer = tray.getBoundingClientRect(), card = shell.getBoundingClientRect();
				const trigger = project.getBoundingClientRect(), button = send.getBoundingClientRect();
				const probe = document.createElement('span');
				probe.style.backgroundColor = 'var(--plume-float)';
				shell.append(probe);
				const expected = getComputedStyle(probe).backgroundColor;
				probe.remove();
				const style = getComputedStyle(shell);
				return {
					aligned: Math.abs(outer.left - card.left) < 1 && Math.abs(outer.right - card.right) < 1 && Math.abs(outer.bottom - card.bottom) < 1,
					filled: style.backgroundColor === expected,
					shadow: style.boxShadow,
					projectHeight: trigger.height,
					trayHeight: card.top - outer.top,
					fits: button.left >= card.left && button.right <= card.right && trigger.right <= outer.right,
				};
			})()`)) as { aligned?: boolean; filled?: boolean; shadow?: string; projectHeight?: number; trayHeight?: number; fits?: boolean };
			if (!result.aligned || !result.filled || result.shadow !== "none" || result.projectHeight !== 28 || result.trayHeight !== 40 || !result.fits) {
				throw new Error(`${label}输入框未对齐：${JSON.stringify(result)}`);
			}
		};

		// 欢迎页的头：问候是按时间的那几句之一，下面那一行有字，插图的下沿正好贴在输入框托盘的上沿、不压到问候。
		const checkWelcomeHead = async (label: string) => {
			await until(
				`document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).every(animation => animation.playState === 'finished' || animation.playState === 'idle')`,
				`${label}动画落位`,
			);
			const result = (await page(`(() => {
				const screen = document.querySelector('[data-screen=empty]');
				const greeting = screen?.querySelector('h1')?.textContent ?? '';
				const line = screen?.querySelector('[data-welcome-line]');
				const peek = screen?.querySelector('.plume-welcome-peek');
				const tray = screen?.querySelector('.plume-composer-tray');
				if (!line || !peek || !tray) return { error: '欢迎页结构不完整' };
				const head = line.parentElement.getBoundingClientRect(), mark = peek.getBoundingClientRect(), top = tray.getBoundingClientRect().top;
				return {
					greeting,
					line: line.textContent,
					greeted: ['夜深了', '早上好', '上午好', '中午好', '下午好', '晚上好'].includes(greeting),
					seated: Math.abs(mark.bottom - top) < 1 && mark.right <= tray.getBoundingClientRect().right,
					clear: [...line.parentElement.querySelectorAll('h1, [data-welcome-line] > span')].every(text => text.getBoundingClientRect().right <= mark.left),
					above: head.bottom <= top,
				};
			})()`)) as { error?: string; greeted?: boolean; line?: string; seated?: boolean; clear?: boolean; above?: boolean };
			if (result.error || !result.greeted || !result.line || !result.seated || !result.clear || !result.above)
				throw new Error(`${label}的问候和插图不对：${JSON.stringify(result)}`);
		};

		// 建议有自己的描边和悬停，不继承通用按钮；两种主题都用实际计算样式验证。
		const checkDraftChips = async (theme: string) => {
			const check = (hover: boolean) => `(() => {
				const chips = [...document.querySelectorAll('.plume-draft-chip')];
				const probe = document.createElement('span');
				document.body.append(probe);
				const color = value => { probe.style.backgroundColor = value; return getComputedStyle(probe).backgroundColor; };
				try {
					return chips.length === 4 && chips.every((chip, index) => {
						const hovered = ${hover} && index === 0;
						const style = getComputedStyle(chip), rect = chip.getBoundingClientRect();
						const icon = chip.querySelector('svg'), label = chip.querySelector('span');
						return rect.height === 32 && style.borderRadius === '8px' && style.borderTopWidth === '1px'
							&& style.paddingLeft === '12px' && style.paddingRight === '12px' && style.columnGap === '6px'
							&& icon?.getBoundingClientRect().width === 16 && icon.getAttribute('stroke-width') === '2'
							&& label && [icon, label].every(child => getComputedStyle(child).opacity === (hovered ? '1' : '0.7'))
							&& style.borderTopColor === color('color-mix(in srgb, var(--plume-ink) ' + (hovered ? '15%' : '10%') + ', transparent)')
							&& style.backgroundColor === color(hovered ? 'color-mix(in srgb, var(--plume-float) 50%, transparent)' : 'transparent')
							&& style.transitionDuration === '0.15s, 0.15s' && style.transitionTimingFunction === 'ease, ease';
					});
				} finally { probe.remove(); }
			})()`;
			window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
			await until(check(false), `${theme}建议的尺寸、描边和图文透明度`);
			// 新会话有入场位移，面板关闭也会移动按钮；落位之后再取鼠标坐标。
			await until(
				`document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).every(animation => animation.playState === 'finished' || animation.playState === 'idle')`,
				`${theme}欢迎页动画落位`,
			);
			const point = (await page(
				`(() => { const r = document.querySelector('.plume-draft-chip').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
			)) as { x: number; y: number };
			window.webContents.sendInputEvent({ type: "mouseMove", ...point });
			await until(check(true), `${theme}悬停时图文渐亮、描边加深和半透明底`);
			window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
			await until(check(true), `${theme}按下不引入通用按钮的底色`);
			// 移开后松开，避免外观检查触发草稿替换。
			window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
			window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 0, y: 0 });
			await until(check(false), `${theme}移开后恢复建议外观`);
		};

		// 1. 模型设置
		await until(`document.querySelector('[data-screen=empty]') !== null`, "界面就绪");
		await click("button", "模型设置");
		await until(`document.querySelector('[data-model-catalog]') !== null`, "打开模型设置");
		await click("[data-add-provider]");
		await until(`document.querySelector('[data-provider-form]') !== null`, "打开添加供应商");
		await type("#provider-name", "假模型");
		await click("[data-provider-form] [data-segmented] button", "Messages");
		await type("#provider-url", model.url);
		await type("#provider-key", "test-key");
		// 假服务只认对话请求，不拉模型列表。
		await click("[data-provider-form] [role=switch]");
		await click("[data-provider-add]");
		await until(`document.querySelector('[data-provider-editor] [data-add-model]') !== null`, "加上供应商");
		await click("[data-provider-editor] [data-add-model]");
		await until(`document.querySelector('[data-model-editor-id]') !== null`, "打开模型表单");
		await type("[data-model-editor-id]", "fake-model");
		await click("[data-model-editor-save]");
		await until(`document.querySelector('[data-model-row="fake-model"]') !== null`, "加上模型");
		// 导出再导回来：文件由 agent 进程读写，冒烟时对话框直接给冒烟目录里的路径。
		await click("[data-provider-transfer]");
		await click("[role=menuitem]", "把供应商导出为 JSON 文件");
		await click("button", "导出");
		await until(`document.querySelector('[data-plume-toaster] [role=status]')?.textContent.includes('文件含 API Key')`, "导出供应商的警告提示条");
		await click("[data-provider-transfer]");
		await click("[role=menuitem]", "从 JSON 文件导入供应商");
		await until(`document.querySelectorAll('[data-provider-import] [data-provider-import-row]').length === 1`, "导入预览列出一个供应商");
		await click("[data-provider-import-confirm]");
		await until(
			`[...document.querySelectorAll('[data-plume-toaster] [role=status]')].some(el => el.textContent.includes('已导入 1 个供应商'))`,
			"导入供应商的成功提示条",
		);
		await delay(300);
		await capture(window, join(outDir, "smoke-models.png"));
		await page(`document.querySelectorAll('[data-plume-toaster] button[aria-label="关闭"]').forEach(button => button.click())`);
		await until(`!document.querySelector('[data-plume-toaster]')`, "提示条关闭后退场");
		const exported = JSON.parse(await readFile(join(outDir, "providers.json"), "utf8")) as { kind?: string; providers?: unknown[] };
		if (exported.kind !== "plume.providers" || exported.providers?.length !== 1) throw new Error("导出的供应商文件不对");
		// 智能标题是内置插件，经 `page: "general"` 在常规页画一行开关。冒烟里关掉它：每段第一句较长的话都会让它在后台
		// 另发一次模型请求，各段按次数核对的假模型就对不上了。
		const titleSwitch = '[role=switch][aria-label="智能标题总结"]';
		await click("[aria-label=设置章节] button", "常规");
		await until(
			`document.querySelector('${titleSwitch}')?.getAttribute('aria-checked') === 'true' && !document.querySelector('${titleSwitch}').disabled`,
			"常规页有智能标题总结的开关，缺省开着",
		);
		await click(titleSwitch);
		await until(`document.querySelector('${titleSwitch}')?.getAttribute('aria-checked') === 'false'`, "关掉智能标题总结");
		await waitFor(
			async () => (await readFile(join(plumeHome(), "plugin-data", "plume.title", "settings.json"), "utf8").catch(() => "")).includes('"enabled": false'),
			"智能标题的开关存进插件数据目录",
		);
		await click("button", "返回工作区");
		await until(`document.querySelector('[data-screen=empty]') !== null && !document.querySelector('[data-warning=no-model]')`, "回到工作区");

		// 临时提示走全局提示条，不再挤在输入框上方；校验失败不能清掉草稿。
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("/clear extra");
		await until(`document.querySelector('.cm-content')?.textContent === '/clear extra'`, "命令草稿已输入");
		await click('button[aria-label="发送"]');
		await until(`document.querySelector('[data-plume-toaster] [role=status]')?.textContent.includes('这条命令不接收参数')`, "命令校验弹出警告提示条");
		if (!(await page(`document.querySelector('.cm-content')?.textContent === '/clear extra' && !document.querySelector('.plume-composer-dock [role=alert]')`)))
			throw new Error("命令警告丢失草稿或重复画在输入框上方");
		// 提示条按整个窗口居中，侧栏开着也不往右偏。
		const toastOffset = (await page(
			`(() => { const r = document.querySelector('[data-plume-toaster] > div').getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2); })()`,
		)) as number;
		if (toastOffset > 1) throw new Error(`提示条没在窗口里居中，偏了 ${toastOffset}px`);
		for (const theme of ["dark", "light"]) {
			await page(`window.plume.saveAppearance({ theme: ${JSON.stringify(theme)} })`);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, `提示条切到 ${theme}`);
			await until(
				`[...document.querySelectorAll('[data-plume-toaster] > div')].every(el => el.getAnimations().every(animation => animation.playState === 'finished'))`,
				"提示条入场动画完成",
			);
			await capture(window, join(outDir, `smoke-toast-${theme}.png`));
		}
		await click('[data-plume-toaster] button[aria-label="关闭"]');
		await until(`!document.querySelector('[data-plume-toaster]')`, "命令提示关闭后退场");
		await page(`document.querySelector('.cm-content').focus()`);
		for (let i = 0; i < "/clear extra".length; i++) {
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
		}
		await until(`document.querySelector('.cm-placeholder') !== null`, "命令草稿清空");
		await page(`(() => {
			const files = new DataTransfer();
			for (let i = 0; i < 9; i++) files.items.add(new File(['toast'], 'toast-' + i + '.txt', { type: 'text/plain' }));
			const input = document.querySelector('.plume-composer-dock input[type=file]');
			input.files = files.files;
			input.dispatchEvent(new Event('change', { bubbles: true }));
		})()`);
		await until(
			`document.querySelector('[data-plume-toaster] [role=status]')?.textContent.includes('一次最多带 8 个') && document.querySelectorAll('.plume-attachment-token').length === 8`,
			"附件超限弹出警告且保留前八份",
		);
		await page(`document.querySelector('.cm-content').focus()`);
		for (let i = 0; i < 16; i++) {
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
		}
		await until(`!document.querySelector('.plume-attachment-token') && document.querySelector('.cm-placeholder') !== null`, "移除测试附件和标记");
		await click('[data-plume-toaster] button[aria-label="关闭"]');
		await until(`!document.querySelector('[data-plume-toaster]')`, "附件提示关闭后退场");
		console.log(
			"PLUME_TOAST_SMOKE " +
				JSON.stringify({ providerTransfer: true, commandWarning: true, draftPreserved: true, attachmentLimit: true, themes: ["dark", "light"], dismiss: true }),
		);

		if (process.env.PLUME_SMOKE_ONLY === "navigation") {
			override = () => ({ text: "导航准备好了。" });
			await click('[data-plume-section-action] button[aria-label="新建项目"]');
			await click("[data-plume-add-folder]");
			await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好导航测试目录");
			await click("button", "创建项目");
			await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace')`, "导航测试项目");
			await click("[data-model-trigger]");
			await click("button", "fake-model");
			await page(`document.querySelector('.cm-content').focus()`);
			await window.webContents.insertText("导航准备");
			await click("[data-composer-send=send]");
			await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('导航准备好了。')`, "导航测试会话准备好");
			const sessionId = (await agent.sessions()).find((session) => session.title.includes("导航准备"))!.id;
			await checkNavigation({
				window,
				outDir,
				page,
				until,
				click,
				capture,
				setModel: (value) => {
					override = value;
				},
				sessionId,
			});
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "navigation" }));
			await shutdown();
			app.quit();
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "files" || process.env.PLUME_SMOKE_ONLY === "document-plugins") {
			override = () => ({ text: "文件预览准备好了。" });
			await click('[data-plume-section-action] button[aria-label="新建项目"]');
			await click("[data-plume-add-folder]");
			await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好文件预览测试目录");
			await click("button", "创建项目");
			await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace')`, "文件预览测试项目");
			await click("[data-model-trigger]");
			await click("button", "fake-model");
			await page(`document.querySelector('.cm-content').focus()`);
			await window.webContents.insertText("验证只读文件预览");
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
			await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('文件预览准备好了。')`, "文件预览会话就绪");
			await checkProjectConfig({ window, workspace, outDir, page, until, click, capture });
			await checkFiles({
				window,
				workspace,
				outDir,
				page,
				until,
				click,
				capture,
				checkPlugins:
					process.env.PLUME_SMOKE_ONLY === "document-plugins"
						? (folder) => checkDocumentPlugins({ window, agent, plugin, workspace, folder, outDir, setModel: (next) => (override = next) })
						: undefined,
			});
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: process.env.PLUME_SMOKE_ONLY }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "input-menu") {
			await checkInputMenu({ window, outDir });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "input-menu" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "update") {
			await checkUpdate({ window, outDir });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "update" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "memory-files") {
			await checkMemoryFiles({ window, workspace, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "memory-files" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "usage") {
			await checkUsage({ window, agent, plugin, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "usage" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "hooks") {
			await checkHooks({ window, agent, plugin, workspace, outDir, page, until, click, capture, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "hooks" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "skin-studio") {
			await checkSkinStudio({ window, agent, plugin, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "skin-studio" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "conversations") {
			await checkConversations({ window, agent, workspace, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "conversations" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "background-job") {
			await checkBackgroundJob({ window, agent, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "background-job" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "spawn-session") {
			await checkSpawnSession({ window, agent, outDir, workspace, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "spawn-session" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "peers") {
			await checkPeers({ window, agent, plugin, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "peers" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "environment" || process.env.PLUME_SMOKE_ONLY === "environment-summary") {
			const part = process.env.PLUME_SMOKE_ONLY === "environment" ? "wakeup" : "summary";
			await checkEnvironment({ window, agent, plugin, outDir, setModel: (next) => (override = next), part });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: process.env.PLUME_SMOKE_ONLY }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "markdown-images") {
			await checkMarkdownImages({ window, agent, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "markdown-images" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "open-file") {
			await checkOpenFile({ window, agent, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "open-file" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "native-ui") {
			await checkNativeUi({ window, agent, plugin, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "native-ui" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "gallery") {
			await checkGallery({ window, agent, plugin, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "gallery" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "quote-side-chat") {
			const options = { window, outDir, page, until, click, capture, setModel: (next: ModelOverride | undefined) => (override = next) };
			await prepareQuoteSideChat(options);
			await checkQuoteSideChat(options);
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "quote-side-chat" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "queue") {
			const options = { window, outDir, page, until, click, capture, setModel: (next: ModelOverride | undefined) => (override = next) };
			await prepareQuoteSideChat(options);
			await checkQueueActions(options);
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "queue" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "preview") {
			await checkPreview({ window, agent, plugin, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "preview" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "desktop-compat") {
			await checkDesktopCompat({ window, outDir, setModel: (next) => (override = next) });
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "desktop-compat" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		// 菜单、拉取请求和会话窗口专项共用最小会话，不依赖工具插件的假模型脚本。
		if (sessionMenuOnly || pullRequestsOnly || sessionWindowOnly) {
			await page(`window.plume.saveAppearance({ theme: "light" })`);
			await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "菜单切到浅色");
			await click('[data-plume-section-action] button[aria-label="新建项目"]');
			await click("[data-plume-add-folder]");
			await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好菜单测试项目目录");
			await click("button", "创建项目");
			await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace')`, "打开菜单测试项目");
			await click("[data-model-trigger]");
			await click("button", "fake-model");
			await page(`document.querySelector('.cm-content').focus()`);
			await window.webContents.insertText("验证会话右键操作");
			await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "菜单测试可发送");
			await click("[data-composer-send=send]");
			await until(
				`document.querySelector('[data-screen=chat]')?.textContent.includes('会话菜单验证完成。') && document.querySelector('[data-composer-send=send]') !== null`,
				"菜单测试会话已完成",
			);
			if (pullRequestsOnly) {
				await checkPullRequests({ window, agent, plugin, outDir, workspace });
				console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "pull-requests", requests: model.requests.length }));
				window.webContents.debugger.detach();
				await shutdown();
				await model.close();
				app.exit(0);
				return;
			}
			if (sessionWindowOnly) {
				// 侧栏里要有另一段会话开到独立窗口；主窗口停在第二段上。
				window.webContents.send("plume:command", "new-session");
				await until(`document.querySelector('[data-screen=empty]') !== null`, "会话窗口专项开新对话");
				await page(`document.querySelector('.cm-content').focus()`);
				await window.webContents.insertText("会话窗口专项的第二段");
				await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "第二段可发送");
				await click("[data-composer-send=send]");
				await until(
					`document.querySelectorAll('[data-plume-row]').length >= 2 && document.querySelector('[data-screen=chat]')?.textContent.includes('会话窗口专项的第二段') && document.querySelector('[data-screen=chat]')?.textContent.includes('会话菜单验证完成。') && document.querySelector('[data-composer-send=send]') !== null`,
					"第二段会话已完成",
				);
				const [second] = recentSessions(await agent.sessions());
				if (!second) throw new Error("agent 进程应该给出第二段会话");
				const file = join(workspace, "session-window.md");
				await writeFile(file, "# 会话窗口\n\n从独立窗口交给主窗口打开。\n");
				await checkSessionWindow({ window, outDir, page, until, click, capture, sessionId: second.id, finalText: "会话菜单验证完成。", file });
				console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "session-window", requests: model.requests.length }));
				window.webContents.debugger.detach();
				await shutdown();
				await model.close();
				app.exit(0);
				return;
			}
			await checkSessionMenu();
			const [menuSession] = recentSessions(await agent.sessions());
			if (!menuSession) throw new Error("agent 进程应该给出菜单测试的会话");
			await checkMessageEdits({
				window,
				outDir,
				page,
				until,
				click,
				capture,
				setModel: (next) => (override = next),
				sessionId: menuSession.id,
				finalText: "会话菜单验证完成。",
			});
			await checkRevertFiles({ window, outDir, page, until, click, capture, setModel: (next) => (override = next), cwd: menuSession.cwd });
			console.log(
				`PLUME_SMOKE ${JSON.stringify({ ok: true, suite: "session-menu", requests: model.requests.length, screenshot: join(outDir, "smoke-session-menu-light.png") })}`,
			);
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		if (process.env.PLUME_SMOKE_ONLY === "market") {
			// 扩展（插件市场）：插件都只在市场里，装上才加载
			const examples = ["scheduled", "terminal"];
			await click("[data-nav=market]");
			await until(
				`${JSON.stringify(examples)}.every((key) => document.querySelector('[data-screen=market] [data-card="' + key + '"]'))`,
				"市场列出定时任务和终端",
			);
			await delay(500);
			await capture(window, join(outDir, "smoke-market.png"));
			for (const key of examples) {
				await click(`[data-card="${key}"] button`, "安装");
				await until(`document.querySelector('[data-card="${key}"]')?.textContent.includes("已安装")`, `装上 ${key}`);
			}
			const loaded = await agent.plugins();
			const missing = examples.filter((key) => loaded.find((plugin) => plugin.key === key)?.state !== "active");
			if (missing.length > 0) throw new Error(`装上以后没加载起来：${missing.join()}`);
			await click(`[data-card="scheduled"] > button`);
			await until(`document.querySelector('[data-plugin-detail="scheduled"] [data-readme] h1') !== null`, "详情页画出 README");
			await delay(300);
			await capture(window, join(outDir, "smoke-plugin-detail.png"));
			// 回到网格：面包屑里的「插件市场」，不是侧栏那一行（同名，点了不关详情）。
			const marketCrumb = 'nav[aria-label="插件市场"] button';
			await click(marketCrumb);
			// 筛选条最前面是「已安装」：市场装的两个；内置插件都加载好了，一个都不列。
			await click("[data-screen=market] button[aria-pressed]", "已安装");
			await until(`document.querySelectorAll('[data-shelf="installed"] [data-card]').length === 2`, "「已安装」只列出市场装的两个插件");
			await delay(300);
			await capture(window, join(outDir, "smoke-market-installed.png"));
			// 「技能」「连接器」两类由内置插件画：原来设置里的两页搬到了这里。
			// 技能一类和插件一样用筛选条分开本机的和市场里的：默认是市场里的全部，「已安装」才是技能插件的那一节。
			await click('[data-market-kind="skills"]');
			await until(
				`document.querySelector('[data-market-tab="skills"] [role=group] button[aria-pressed="true"]') !== null && document.querySelector('[data-skills-settings]') === null`,
				"「技能」一类默认列市场里的，不混着本机的技能",
			);
			// 页顶「添加技能」：产品的「让 agent 写一个」，后面接技能插件登记的「打开个人技能目录」。
			await click('[data-market-add="skills"]');
			await until(
				`[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((item) => item.textContent).join('|').includes('打开个人技能目录')`,
				"「添加技能」菜单里有技能插件登记的一项",
			);
			await delay(200);
			await capture(window, join(outDir, "smoke-market-skills-offered.png"));
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
			await until(`document.querySelector('[role=menu]') === null`, "Escape 关掉「添加技能」菜单");
			// 技能卡片右上角的「＋」直接装上，「已安装」里看它。
			const skillCard = `[data-market-tab="skills"] [data-card]:has(button[aria-label="安装"])`;
			const skillKey = String(await page(`document.querySelector(${JSON.stringify(skillCard)})?.dataset.card ?? ""`));
			if (!skillKey) throw new Error("市场里没有能装的技能合集");
			const skillPack = String(await page(`document.querySelector('[data-card="${skillKey}"] [data-card-name]').textContent`));
			await click(`[data-card="${skillKey}"] button[aria-label="安装"]`);
			await until(`document.querySelector('[data-card="${skillKey}"] button[aria-label^="安装"]') === null`, `装上技能合集 ${skillKey}`);
			// 从技能这一类点开一张合集的详情，经面包屑返回时还在技能这一类。
			await click('[data-market-tab="skills"] [data-card] > button');
			await until(`document.querySelector('[data-plugin-detail]') !== null`, "技能合集的详情页");
			await click(marketCrumb);
			await until(`document.querySelector('[data-market-tab="skills"]') !== null`, "从详情返回时回到技能这一类");
			// 「已安装」是技能插件的那一节；看哪个项目、刷新由市场画在页头「添加技能」左边。
			await click('[data-market-tab="skills"] button[aria-pressed]', "已安装");
			await until(
				`document.querySelector('[data-market-tab="skills"] [data-skills-settings]') !== null && document.querySelector('[data-screen=market] [data-project-scope]') !== null`,
				"「技能」一类画出技能插件的那一节和项目选择",
			);
			// 市场装的技能合集一个插件一张合集卡片；内置插件带的（技能插件自己带着 plume-plugin）不列。
			const pack = JSON.stringify(`[data-skill-pack="${skillPack}"]`);
			await until(`document.querySelector(${pack}) !== null`, "「来自插件」里有刚装的技能合集");
			if (await page(`document.querySelector('[data-skill-pack="技能"]') !== null`)) throw new Error("「来自插件」列出了内置插件带的技能");
			await delay(300);
			await capture(window, join(outDir, "smoke-market-skills.png"));
			// 点合集卡片打开那个插件的详情，返回时还在「已安装」。
			await click(`[data-skill-pack="${skillPack}"] .skl-bundle-hit`);
			await until(`document.querySelector('[data-plugin-detail]') !== null`, "点合集卡片打开插件详情");
			await click(marketCrumb);
			await until(`document.querySelector('[data-market-tab="skills"] [data-skills-settings]') !== null`, "从详情返回时回到技能 › 已安装");
			// 连接器一类和技能一样：默认列市场里的连接器，「已安装」才是 MCP 插件的那一节。
			await click('[data-market-kind="connectors"]');
			await until(
				`document.querySelector('[data-market-tab="connectors"] [data-card]') !== null && document.querySelector('[data-mcp-settings]') === null`,
				"「连接器」一类默认列市场里的连接器",
			);
			await delay(300);
			await capture(window, join(outDir, "smoke-market-connectors-offered.png"));
			// 页头「添加连接器」只有 MCP 插件登记的「手动添加」一项：按下去直接换到「已安装」、弹出它的添加弹窗。
			await click('[data-market-add="connectors"]');
			await until(
				`document.querySelector('[data-market-tab="connectors"] [data-mcp-settings]') !== null && document.querySelector('[data-mcp-dialog]') !== null`,
				"「添加连接器」换到「已安装」并弹出添加弹窗",
			);
			await delay(300);
			await capture(window, join(outDir, "smoke-market-connectors.png"));
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
			await until(`document.querySelector('[data-mcp-dialog]') === null`, "Escape 关掉添加弹窗");
			await click('[data-market-kind="plugins"]');
			await until(`document.querySelector('[data-screen=market] [data-card="scheduled"]') !== null`, "回到插件那一类");
			// 插件能在详情页当场停用、再启用。
			await click(`[data-card="scheduled"] > button`);
			const scheduledSwitch = `[data-plugin-detail="scheduled"] [role=switch][aria-label="启用 定时任务"]`;
			await until(`document.querySelector('${scheduledSwitch}') !== null`, "详情页有开关");
			await click(scheduledSwitch);
			await until(`document.querySelector('${scheduledSwitch}')?.getAttribute('aria-checked') === 'false'`, "停用 plume.scheduled");
			if ((await agent.plugins()).find((plugin) => plugin.name === "plume.scheduled")?.state !== "disabled") throw new Error("plume.scheduled 没有停用");
			await click(scheduledSwitch);
			await until(`document.querySelector('${scheduledSwitch}')?.getAttribute('aria-checked') === 'true'`, "再启用 plume.scheduled");
			if ((await agent.plugins()).find((plugin) => plugin.name === "plume.scheduled")?.state !== "active") throw new Error("plume.scheduled 没有重新启用");
			await click(marketCrumb);
			// 右上角「创建插件」：菜单两条都带第二行说明，按开头的字点。冒烟里选文件夹给的是工作目录，不是插件，要说清楚。
			const createItem = (label: string) =>
				page(
					`[...document.querySelectorAll('[role=menu][aria-label="创建插件"] [role=menuitem]')].find((item) => item.textContent.startsWith(${JSON.stringify(label)})).click()`,
				);
			await click("[data-market-create]");
			await until(`document.querySelector('[role=menu][aria-label="创建插件"]') !== null`, "打开创建插件菜单");
			await delay(200);
			await capture(window, join(outDir, "smoke-market-create.png"));
			await createItem("从本地上传");
			await until(`document.querySelector('[data-screen=market]')?.textContent.includes('不是构建好的插件')`, "选的文件夹不是插件时说清楚");
			// 「新建插件」点名的技能由内置的技能插件登记：开新对话，输入框里是 /plume-plugin 命令。
			await click("[data-market-create]");
			await until(`document.querySelector('[role=menu][aria-label="创建插件"]') !== null`, "再打开创建插件菜单");
			await createItem("新建插件");
			await until(
				`document.querySelector('[data-screen=empty] .plume-command-token')?.textContent === '/plume-plugin' && document.activeElement?.classList.contains('cm-content')`,
				"新建插件：新对话的输入框里点名 plume-plugin 技能",
			);
			await delay(300);
			await capture(window, join(outDir, "smoke-create-plugin.png"));
			// 草稿撤掉，不带到后面的步骤里。
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
			await until(`document.querySelector('[data-screen=empty] .cm-placeholder') !== null`, "清掉新建插件的草稿");
			await until(`document.querySelector('[data-screen=empty]') !== null`, "从市场回到工作区");
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "market" }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}

		// 单独的段都在上面返回了；走到这里还设着段名，就是写错了或那一段已经删了，别不声不响地跑成主流程。
		if (process.env.PLUME_SMOKE_ONLY) throw new Error(`没有这一段：PLUME_SMOKE_ONLY=${process.env.PLUME_SMOKE_ONLY}`);

		// 扩展（插件市场）的界面在单独的 market 段；主流程只经 plume-plugin 装上后面要用的定时任务和终端。
		if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
		for (const name of ["scheduled", "terminal"]) await plugin.install(name);
		await waitFor(async () => {
			const loaded = await agent.plugins();
			return ["scheduled", "terminal"].every((key) => loaded.find((item) => item.key === key)?.state === "active");
		}, "装上定时任务和终端");

		// 欢迎页先验浅色，后面的外观步骤再验深色，避免只覆盖本机的系统主题。
		await click("button", "设置");
		await click("[aria-label=设置章节] button", "外观");
		await click("button[aria-pressed]", "浅色");
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "切到浅色");
		await click("button", "返回工作区");

		// 2. 新对话直接输入；建议只填草稿，重复点击、切项目和选模型都不创建会话。
		const sessionsDb = join(outDir, "home", "sessions", "sessions.db");
		// 只数人自己的会话：子 Agent、侧边聊天这些插件的子会话也存在这里。
		const storedSessions = async () => {
			const db = new DatabaseSync(sessionsDb, { readOnly: true });
			try {
				return (db.prepare("SELECT summary FROM sessions").all() as Array<{ summary: string }>)
					.map((row) => JSON.parse(row.summary) as { id: string; parentId?: string; project?: string; thinking?: string })
					.filter((session) => !session.parentId);
			} finally {
				db.close();
			}
		};
		await click("[data-nav=new-chat]");
		await click("[data-nav=new-chat]");
		await until(`document.activeElement?.classList.contains('cm-content') === true`, "新对话自动聚焦输入框");
		await click("button", "理解代码");
		await until(`document.querySelector('.cm-content')?.textContent.includes('整体架构')`, "建议填入草稿");
		await click("button", "审查改动");
		await until(
			`document.querySelector('.cm-content')?.textContent === '审查当前工作区未提交的改动，指出其中的缺陷和风险，按严重程度排序。'`,
			"审查建议替换草稿",
		);
		await click("button", "报错修复");
		await until(
			`document.querySelector('.cm-content')?.textContent === '帮我定位一个问题的根因。先复现，再定位，最后给出最小改动的修复。'`,
			"修复建议替换草稿",
		);
		// 建议点击会在下一帧聚焦编辑器；等它落定后再模拟键盘移动，避免旧回调抢走焦点。
		await page(`new Promise(resolve => requestAnimationFrame(() => { document.querySelector('.plume-draft-chip').focus(); resolve(); }))`);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
		await until(
			`document.activeElement?.textContent === '开发功能' && getComputedStyle(document.activeElement).outlineStyle === 'solid' && getComputedStyle(document.activeElement).outlineWidth === '2px'`,
			"键盘按顺序到达建议并显示焦点环",
		);
		// 原生按钮激活还需要回车字符事件，不只是 keydown。
		await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
		await until(
			`document.querySelector('.cm-content')?.textContent === '我想新增一个功能，先帮我确认现有代码里应该改哪些文件，再给出实现方案。' && document.activeElement?.classList.contains('cm-content')`,
			"键盘确认替换草稿并聚焦输入框",
		);
		// 零项目时也能从侧栏创建第一个项目；按钮沿用键盘聚焦时显露的交互。
		await until(
			`document.querySelector('[data-plume-section="projects"]') !== null && document.querySelector('[data-plume-project]') === null`,
			"零项目时保留项目标题",
		);
		await page(`document.querySelector('[data-plume-section="projects"]').focus()`);
		await until(
			`getComputedStyle(document.querySelector('[data-plume-section="projects"]').parentElement.querySelector('[data-plume-section-action]')).opacity === '1'`,
			"键盘聚焦时显示新建项目按钮",
		);
		await capture(window, join(outDir, "smoke-empty-projects.png"));
		await click('[data-plume-section-action] button[aria-label="新建项目"]');
		await click("[data-plume-add-folder]");
		await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选好项目目录");
		await click("button", "创建项目");
		await until(
			`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace') && document.querySelector('.cm-content .cm-placeholder') !== null`,
			"新项目的空白会话不串草稿",
		);
		await click("[data-model-trigger]");
		await click("button", "fake-model");
		await click("[data-effort-trigger]");
		await page(
			`(() => { const input = document.querySelector('[data-effort-menu] input[type=range]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '0'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
		);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		await until(`document.querySelector('[data-effort-menu]') === null`, "关闭思考档位菜单");
		if ((await storedSessions()).length !== 0 || model.requests.some(() => true)) throw new Error("空白页操作不应创建会话或请求模型");
		await checkComposer("浅色欢迎页");
		await checkWelcomeHead("浅色欢迎页");
		await checkDraftChips("浅色");
		// 用真实 CSS 动画的时间轴采样，不用静态截图代替中间帧验证。
		const reveal = await page(`(() => {
			const chips = [...document.querySelectorAll('.plume-draft-chip')];
			const animations = chips.map(chip => chip.getAnimations().find(animation => animation.animationName === 'plume-draft-chip-in'));
			if (animations.length !== 4 || animations.some(animation => !animation)) return { error: '缺少建议入场动画' };
			const timing = animations.map(animation => animation.effect.getTiming());
			const opacity = () => chips.map(chip => Number(getComputedStyle(chip).opacity));
			try {
				animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
				const start = opacity();
				animations.forEach(animation => { animation.currentTime = 130; });
				const middle = opacity();
				animations.forEach(animation => animation.finish());
				const end = opacity();
				return { ok: timing.every((value, index) => value.duration === 260 && value.delay === index * 65 && getComputedStyle(chips[index]).animationTimingFunction === 'cubic-bezier(0.22, 1, 0.36, 1)') && start.every(value => value === 0) && middle[0] > 0 && middle[0] < 1 && middle[3] === 0 && end.every(value => value === 1), timing, start, middle, end };
			} finally { animations.forEach(animation => animation.play()); }
		})()`);
		if (!(reveal as { ok?: boolean }).ok) throw new Error(`建议入场时序或中间帧不正确：${JSON.stringify(reveal)}`);
		await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		await until(
			`matchMedia('(prefers-reduced-motion: reduce)').matches && [...document.querySelectorAll('.plume-draft-chip')].every(chip => { const style = getComputedStyle(chip); return parseFloat(style.animationDuration) < 0.001 && parseFloat(style.animationDelay) === 0 && style.opacity === '1'; })`,
			"减少动态效果时建议直接到位且没有错峰延迟",
		);
		await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
		await capture(window, join(outDir, "smoke-welcome.png"));
		await checkSidebarResize(window, join(outDir, "smoke-sidebar-resize.png"));
		// 输入框是编辑器不是 textarea：经 webContents 真打字，再连点发送验证请求去重。
		await page(`document.querySelector('[data-screen=empty] .cm-content').focus()`);
		// 菜单里有本机 ~/.agents/skills 的技能（内置的技能插件照常读它）。指针停在哪一行上，那一行很长的描述就开始滚，
		// 一圈可能一分多钟，截图要等它播完：先把指针挪开，上一步留下的位置不该决定这一步要等多久。
		window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });
		// `/` 菜单：打出前缀弹出本体的 /clear，Tab 补全成命令签，再删干净。
		await window.webContents.insertText("/cl");
		await until(`document.querySelector('.plume-command-menu[data-open="true"] [data-command="clear"]') !== null`, "敲 / 弹出命令菜单");
		await capture(window, join(outDir, "smoke-commands.png"));
		const press = (keyCode: string) => {
			window.webContents.sendInputEvent({ type: "keyDown", keyCode });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode });
		};
		press("Tab");
		await until(
			`document.querySelector('[data-screen=empty] .plume-command-token')?.textContent === '/clear' && document.querySelector('.plume-command-menu[data-open="true"]') === null`,
			"Tab 补全成命令签、菜单收起",
		);
		for (let i = 0; i < "/clear ".length; i++) press("Backspace");
		await until(
			`document.querySelector('[data-screen=empty] .plume-command-token') === null && document.querySelector('[data-composer-send=send]')?.disabled === true`,
			"删掉命令",
		);
		// 默认是「帮我批准」，项目里的 edit 不会问：切到「请求批准」，让 edit 弹出审批卡。菜单项里还有一行说明，按开头的名字找。
		if ((await page(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip`)) !== "auto") throw new Error("权限签默认应该是「帮我批准」");
		await click("[data-permission-chip]");
		await until(`document.querySelectorAll('[role=menuitem]').length === 3`, "权限菜单列出三档");
		await page(`[...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent.trim().startsWith('请求批准')).click()`);
		await until(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip === 'ask'`, "权限签切到「请求批准」");
		await window.webContents.insertText("列个计划，然后把 hello.txt 里的 hello 改成 hi");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		const arrival = await page(`new Promise(resolve => {
			const timeout = setTimeout(() => { document.removeEventListener('animationstart', started); resolve({ error: '首发输入框没有播放入场动画' }); }, 5000);
			function started(event) {
				if (event.animationName !== 'plume-composer-arrive') return;
				clearTimeout(timeout);
				document.removeEventListener('animationstart', started);
				const animation = event.target.getAnimations().find(item => item.animationName === event.animationName);
				const timing = animation.effect.getTiming();
				const frames = animation.effect.getKeyframes();
				resolve({ ok: timing.duration === 220 && getComputedStyle(event.target).animationTimingFunction === 'cubic-bezier(0.22, 1, 0.36, 1)' && frames[0].transform === 'translateY(16px)' && frames[0].opacity === '0' && frames.at(-1).transform === 'none' && frames.at(-1).opacity === '1', timing, frames });
			}
			document.addEventListener('animationstart', started);
			const send = document.querySelector('[data-composer-send=send]'); send.click(); send.click();
		})`);
		if (!(arrival as { ok?: boolean }).ok) throw new Error(`首发输入框动画不正确：${JSON.stringify(arrival)}`);
		await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		await until(`parseFloat(getComputedStyle(document.querySelector('.plume-composer-arrive')).animationDuration) < 0.001`, "减少动态效果时首发输入框直接到位");
		await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

		// 3. 只有 edit 要确认，cat 已经执行完。cat 和 edit 连着做，合成一段活、默认收着：先点开，里面每次调用一行。
		const step = "[data-plume-step][data-plume-run] > button";
		await until(`document.querySelector('${step}') !== null`, "两次调用合成一段活");
		await click(`${step}[aria-expanded=false]`);
		await until(`document.querySelector('[data-status=approval]') !== null`, "出现审批");
		const pending = (await page(`[...document.querySelectorAll('[data-status=approval]')].map((card) => card.dataset.tool)`)) as string[];
		if (pending.join() !== "edit") throw new Error(`等待确认的应该只有 edit，实际是 ${pending.join()}`);
		if ((await page(`document.querySelector('[data-tool=bash]')?.dataset.status`)) !== "done") throw new Error("bash 应该已经直接执行完");
		const card = (await page(`document.querySelector('[data-approval-card]')?.textContent ?? ''`)) as string;
		if (!card.includes("Edit hello.txt") || !card.includes("-hello") || !card.includes("+hi")) throw new Error(`审批卡里应该是 edit 的 diff，实际是 ${card}`);
		if ((await page(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip`)) !== "ask") throw new Error("权限签应该是「请求批准」");
		await delay(300);
		await capture(window, join(outDir, "smoke-approval.png"));
		await click("[data-approval-card] button", "允许一次");
		for (const part of ["a", "b", "c"]) {
			await until(`document.querySelector('[data-approval-card]')?.textContent.includes('delivery-${part}.ts')`, "新建交付测试文件的审批");
			await click("[data-approval-card] button", "允许一次");
		}

		// 4. 结束语
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(FINAL_TEXT)})`, "模型给出结束语");
		await until(`document.querySelector('[data-screen=chat] [data-hiccup=recovered]') !== null`, "重试接上后留一行恢复记录");
		if (await page(`document.querySelector('[data-screen=chat]')?.textContent.includes('自动继续')`)) throw new Error("本体替人说的「接着写」不该画出来");
		await delay(300);
		await capture(window, file);

		// todo 清单是跟着会话的卡片，不是转录里的一张：这一轮收了尾而第二项没勾上，标题行说停在那一步。对话列够宽，浮在右上角。
		const todoCard = (placement: string) => `(() => {
			const card = document.querySelector('[data-screen=chat] [data-todo-list="${placement}"]');
			return card !== null && card.querySelectorAll('.plume-todo-row').length === 2 && card.textContent.includes('停在 · 把 hello 改成 hi')
				&& card.querySelector('.plume-todo-head-action button[aria-label="继续"]') !== null;
		})()`;
		await until(todoCard("floating"), "todo 清单浮在转录右上角，停在没勾上的那一步，标题行有「继续」");
		if (await page(`document.querySelector('[data-tool=todo_write] .todo-card') !== null`)) throw new Error("todo_write 不该在转录里另画一张卡片");
		await capture(window, join(outDir, "smoke-todo.png"));

		// 菜单栏图标和 plume:// 链接叫界面做的事（main/tray.ts、main/deep-link.ts）。菜单和链接本身见 test/tray.test.ts；
		// 这里直接发命令，不经 sendCommand：那会把藏着跑的冒烟窗口拿到前面来。最近会话问的是 agent 进程。
		const [recent] = recentSessions(await agent.sessions());
		if (!recent) throw new Error("agent 进程应该给出刚跑完的会话");
		window.webContents.send("plume:command", "settings");
		await until(`document.querySelector('[data-screen=settings]') !== null`, "菜单的「设置…」打开设置页");
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "菜单的「新对话」回到空白页");
		window.webContents.send("plume:command", `open-session:${recent.id}`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(FINAL_TEXT)})`, "最近会话、plume:// 链接打开那个会话");
		// 关窗口只是收起来：窗口和页面都还在，会话还开着。放回来要 show，会把冒烟窗口拿到人眼前，不在这里做。
		window.close();
		await delay(300);
		if (window.isDestroyed() || window.isVisible()) throw new Error("关主窗口应该只是把它藏起来");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(FINAL_TEXT)})`, "关窗口后页面和会话都还在");

		await checkFiles({ window, workspace, outDir, page, until, click, capture });
		await checkProjectConfig({ window, workspace, outDir, page, until, click, capture });

		if (process.env.PLUME_SMOKE_SUITE !== "panels") {
			await checkDelivery({ window, workspace, outDir, page, until, click, capture });
			await checkSessionMenu();
			await checkComposerHistory({ window, outDir, page, until, click, capture });
		}

		// 5. 面板
		// 收起时面板区也挂着，只是 inert；滑完才截图。按 data-* 找，不靠界面文案：文案随语言变。
		if ((await page(`document.querySelector('[data-panel-area]')?.inert`)) !== true) throw new Error("面板区默认应该是收起的");
		// 打开先是一个开始页标签，每个面板一张卡片；点卡片，这个标签就变成那个面板。后台的标签挂着但 inert。
		const shown = (panel: string) => `[data-panel="${panel}"]:not([inert])`;
		const tabStrip = () => page(`[...document.querySelectorAll('[data-panel-tab]')].map((tab) => tab.dataset.panelTab).join()`) as Promise<string>;
		await click("[data-panel-toggle] button");
		await until(`document.querySelector('[data-panel-area]')?.inert === false && document.querySelector('${shown("start")}') !== null`, "打开面板区的开始页");
		if (await page(`document.querySelector('[data-panel-toggle]') !== null`)) throw new Error("面板打开后正文标题栏不应显示面板开关");
		const launchers = (await page(`[...document.querySelectorAll('[data-panel-launch]')].map((card) => card.dataset.panelLaunch)`)) as string[];
		if (
			launchers.join() !==
			"plume.diagnostics/tasks,plume.diagnostics/trajectory,plume.browser/browser,plume.git/git,plume.side-chat/chat,plume.subagents/agents,plume/files,plume.terminal/terminal"
		)
			throw new Error(`开始页应有任务、调用轨迹、浏览器、Git、侧边聊天、子 Agent、项目文件和终端，实际是 ${launchers.join()}`);
		// 面板区占了一半，对话列放不下浮着的卡片：清单回到输入框正上方。
		await until(todoCard("inline"), "面板区打开后 todo 清单回到输入框上方");
		await delay(300);
		await capture(window, join(outDir, "smoke-panel-start.png"));

		// 终端：起在会话的工作目录里；经 xterm 的输入框打一条命令，结果画回 xterm。算出来的数只会出现在输出里，回显的是算式。
		const terminal = shown("plume.terminal/terminal");
		await click('[data-panel-launch="plume.terminal/terminal"]');
		// 等 shell 连上再打字：xterm 先建好，shell 开出来之前打的字没有去处。
		await until(
			`document.querySelector('${terminal} [data-terminal-id]:not([data-terminal-id=""])') !== null && document.querySelector('${terminal} .xterm-helper-textarea') !== null`,
			"打开终端面板",
		);
		if ((await tabStrip()) !== "plume.terminal/terminal") throw new Error(`开始页标签应该变成终端，标签条是 ${await tabStrip()}`);
		await delay(300);
		await capture(window, join(outDir, "smoke-panel.png"));
		await checkPanelResize(window, join(outDir, "smoke-panel-resize.png"));
		await page(`document.querySelector('${terminal} .xterm-helper-textarea').focus()`);
		// Windows 上终端插件起的是 PowerShell，算式和当前目录按它的语法写。
		await window.webContents.insertText(process.platform === "win32" ? 'Write-Output "PLUME_$(6*7):$($PWD.Path)"' : "echo PLUME_$((6*7)):$PWD");
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
		window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
		await until(`document.querySelector('${terminal} .xterm-rows')?.textContent.includes(${JSON.stringify(`PLUME_42:${workspace}`)})`, "终端里跑出命令结果");
		await delay(300);
		await capture(window, join(outDir, "smoke-terminal.png"));
		await checkPanelsFramework(window, outDir);
		await checkFileTerminal(window, workspace, outDir);
		await checkBrowser({ window, agent, outDir, setModel: (next) => (override = next) });
		const checkSessionPanels = async () => {
			window.webContents.send("plume:command", `open-session:${recent.id}`);
			await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(FINAL_TEXT)})`, "会话窗口验证回到原会话");
			await checkMessageEdits({
				window,
				outDir,
				page,
				until,
				click,
				capture,
				setModel: (next) => (override = next),
				sessionId: recent.id,
				finalText: FINAL_TEXT,
			});
			await checkSessionWindow({ window, outDir, page, until, click, capture, sessionId: recent.id, finalText: FINAL_TEXT });
		};
		if (process.env.PLUME_SMOKE_SUITE === "panels") {
			await checkSessionPanels();
			console.log("PLUME_SMOKE", JSON.stringify({ ok: true, suite: "panels", requests: model.requests.length }));
			window.webContents.debugger.detach();
			await shutdown();
			await model.close();
			app.exit(0);
			return;
		}
		// 快捷键 ⌃`：焦点在终端里按，收起面板区；再按一次直接回到终端。
		await click('[data-panel-tab="plume.terminal/terminal"] [role=tab]');
		await until(`document.querySelector('${terminal} textarea') !== null`, "快捷键验证先选回终端");
		await page(`document.querySelector('${terminal} textarea').focus()`);
		const shortcut = () => {
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "`", modifiers: ["control"] });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "`", modifiers: ["control"] });
		};
		shortcut();
		await until(`document.querySelector('[data-panel-area]')?.inert === true`, "快捷键收起面板区");
		shortcut();
		await until(`document.querySelector('[data-panel-area]')?.inert === false && document.querySelector('${terminal} .xterm-rows') !== null`, "快捷键打开终端");

		// Git（内置插件 plume.git）：工作区变成自己的仓库（分支 main），再留一个没提交的文件。开始页列出 Git（`available`），
		// 输入框上方的分支签和改动计数跟着重新探测换成这个仓库的；点改动计数（ui.openPanel）开出 Git 面板，面板里是分支和那个文件。
		// 提交身份只给这一次，不碰全局配置。
		await click("button[data-panel-add]");
		await until(`document.querySelector('[data-panel-launch="plume.terminal/terminal"]') !== null`, "「+」打开开始页");
		const gitIn = (...args: string[]) =>
			promisify(execFile)("git", ["-c", "user.name=Plume Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...args], {
				cwd: workspace,
			});
		await gitIn("init", "-q", "-b", "main");
		await gitIn("add", "-A");
		await gitIn("commit", "-q", "-m", "smoke");
		await writeFile(join(workspace, "notes.txt"), "git panel\n");
		await page(`window.dispatchEvent(new Event('focus'))`);
		await until(`document.querySelector('[data-panel-launch="plume.git/git"]') !== null`, "变成仓库后开始页列出 Git");
		await until(
			`document.querySelector('.plume-composer-tray')?.textContent.includes('main') && document.querySelector('.plume-composer-tray')?.textContent.includes('+1')`,
			"输入框上方出现分支签和改动计数",
		);
		const git = shown("plume.git/git");
		await page(`[...document.querySelectorAll('.plume-composer-tray button')].find((button) => button.textContent.includes('+1')).click()`);
		await until(
			`document.querySelector('${git} [data-plume-sync]') !== null && document.querySelector('${git}')?.textContent.includes('notes.txt')`,
			"改动计数打开 Git 面板，列出没提交的文件",
		);
		if (!(await tabStrip()).endsWith("plume.git/git")) throw new Error(`标签条最后应该是 Git，实际是 ${await tabStrip()}`);
		await delay(300);
		await capture(window, join(outDir, "smoke-git.png"));

		// 定时任务：插件加的页面排在侧栏的去处里；新建的任务记下会话的工作目录，存进插件的数据目录。
		await click('[data-nav="page:plume.scheduled/scheduled"]');
		await until(`document.querySelector('[data-scheduled-add]') !== null`, "打开定时任务");
		await click("[data-scheduled-add]");
		await until(`document.querySelector('[data-scheduled-task]')?.textContent.includes(${JSON.stringify(workspace)})`, "新建的任务带上会话的工作目录");
		const tasksFile = join(outDir, "home", "plugin-data", "plume.scheduled", "tasks.json");
		type StoredTask = { cwd?: string; enabled?: boolean; lastRunAt?: number; lastSessionId?: string; lastError?: string };
		const storedTasks = async () => JSON.parse(await readFile(tasksFile, "utf8").catch(() => "[]")) as StoredTask[];
		// 「立即运行一次」：任务还关着（每分钟那次检查不会抢先跑它），照样开出一个会话、把提示词发出去。假模型这一段归定时任务。
		let scheduledFails = false;
		override = () => (scheduledFails ? { status: 401 } : { text: SCHEDULED_TEXT });
		await click("[data-scheduled-task] [data-scheduled-run]");
		await until(`document.querySelector('[data-scheduled-task] [data-scheduled-open-last]') !== null`, "立即运行开出会话，卡片上出现「打开上次会话」");
		await until(`document.querySelector('[data-scheduled-task] [data-scheduled-status]') === null`, "这一次跑完，卡片上的运行状态收起");
		const firstRun = (await storedTasks())[0];
		if (!firstRun?.lastSessionId || !firstRun.lastRunAt || firstRun.lastError) throw new Error(`立即运行没记下这一次：${JSON.stringify(firstRun)}`);
		await click("[data-scheduled-task] [data-scheduled-open-last]");
		await until(
			`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(SCHEDULED_TEXT)}) && document.querySelector('[data-plume-row="${firstRun.lastSessionId}"]') !== null`,
			"「打开上次会话」进到那个会话，它在侧栏里，回复在转录里",
		);
		// 再跑一次，这次假模型报错。点了就回到会话：失败到的时候没人看着页面，才挂在输入框上方和侧栏上。
		scheduledFails = true;
		await click('[data-nav="page:plume.scheduled/scheduled"]');
		await until(`document.querySelector('[data-scheduled-task] [data-scheduled-run]')?.disabled === false`, "回到定时任务页");
		await page(`document.querySelector('[data-scheduled-task] [data-scheduled-run]').click()`);
		window.webContents.send("plume:command", `open-session:${firstRun.lastSessionId}`);
		const failureNav = `document.querySelector('[data-nav="page:plume.scheduled/scheduled"] [aria-label="1 个任务运行失败"]')`;
		await until(
			`document.querySelector('[data-screen=chat] [data-scheduled-alert]')?.textContent.includes('失败') && ${failureNav}?.textContent === '1'`,
			"失败了：输入框上方说一句，侧栏的定时任务那一行挂着 1",
		);
		await delay(300);
		await capture(window, join(outDir, "smoke-scheduled-alert.png"));
		await click("[data-scheduled-alert-look]");
		await until(
			`document.querySelector('[data-scheduled-task] [data-scheduled-error]')?.textContent.startsWith('失败：') && ${failureNav} === null`,
			"「查看」回到定时任务页，卡片上写着原因，侧栏的数目清掉",
		);
		const secondRun = (await storedTasks())[0];
		if (!secondRun?.lastError || !secondRun.lastSessionId || secondRun.lastSessionId === firstRun.lastSessionId)
			throw new Error(`失败没记到这一次上：${JSON.stringify(secondRun)}`);
		override = undefined;

		await click("[data-scheduled-task] [role=switch]");
		await until(`document.querySelector('[data-scheduled-task]')?.textContent.includes("下次运行")`, "打开任务后显示下次运行");
		await waitFor(async () => {
			const tasks = await storedTasks();
			return tasks.length === 1 && tasks[0]?.cwd === workspace && tasks[0]?.enabled === true;
		}, "任务存进插件的数据目录");
		await delay(300);
		await capture(window, join(outDir, "smoke-scheduled.png"));
		// 定时任务开出来的两个会话是人的会话，和别的一样归档、删除；删掉它们，后面的步骤只数原来那一个。
		await click(`[data-plume-row="${firstRun.lastSessionId}"] > button`);
		await until(`document.querySelector('[data-screen=chat]') !== null`, "回到定时任务开出的会话");
		for (const id of [firstRun.lastSessionId, secondRun.lastSessionId]) {
			await page(
				`[...document.querySelectorAll('[data-plume-row="${id}"] button')].find((button) => button.getAttribute('aria-label')?.startsWith('归档会话')).click()`,
			);
			await until(`document.querySelector('[data-plume-row="${id}"]') === null`, "定时任务开出的会话归档");
		}
		await click("button", "设置");
		await click("[aria-label=设置章节] button", "已归档的聊天");
		await click("[data-plume-delete-all-archived]");
		await page(`[...document.querySelectorAll('[role=dialog] button')].find((button) => /^删除 \\d+ 个$/.test(button.textContent.trim())).click()`);
		await until(`document.querySelector('[data-plume-delete-all-archived]') === null`, "删掉定时任务开出的会话");
		await click("button", "返回工作区");

		// 6. 插件作者的路子：应用生成的 plume-plugin 用应用自己的二进制跑，装进去的插件不重启就加载。
		if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");

		// 子 Agent、侧边聊天：都是内置插件，随应用加载，跑在子会话里（市场插件不重启当场加载，由下面的下一步建议验证）。
		// 主 Agent 派活给子 Agent，子 Agent 的 write 要确认，审批卡压在主输入框上方、标明是哪个子 Agent 问的；
		// 跑完点工具卡片上的 ↗，子 Agent 面板画出它的全过程。再敲 `/btw 问题`：这句话不进主对话，新开一格侧边聊天，回答画在那里。
		await click("[data-plume-row] button");
		await until(`document.querySelector('[data-screen=chat] .cm-content') !== null`, "回到会话");
		const sentBefore = model.requests.length;
		childrenPhase = true;
		await page(`document.querySelector('[data-screen=chat] .cm-content').focus()`);
		await window.webContents.insertText("派个子 Agent 写一份说明");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('[data-approval-from]')?.textContent.includes(${JSON.stringify(TASK_TITLE)})`, "子 Agent 的审批卡压在主输入框上方");
		const agentsPanel = shown("plume.subagents/agents");
		await until(
			`document.querySelector('${agentsPanel} [data-sub-brief]')?.textContent.includes('主 Agent 交代的任务') && document.querySelector('[data-subagent-bar]') !== null`,
			"派发自动打开面板并画任务卡和活动条",
		);
		await waitFor(
			async () =>
				model.requests
					.slice(sentBefore)
					.some(
						(request) =>
							((request.tools ?? []) as Array<{ name: string }>).some((tool) => tool.name === "task") &&
							JSON.stringify(request.messages).includes("只读检查完成。"),
					),
			"只读子任务已单独送达主会话",
		);
		await until(`document.querySelector('[data-screen=chat] [data-composer-send=send]') !== null`, "子任务等审批时主会话已经正常收尾");
		await click(`${agentsPanel} [data-sub-switch]`);
		await until(`document.querySelectorAll('.subagents-menu [role=menuitem]').length === 2`, "双任务切换菜单已展开");
		const checkMenuRows = async () => {
			const layout = await page(`(() => {
				const rows = [...document.querySelectorAll('.subagents-menu [role=menuitem]')];
				const boxes = rows.map(row => row.getBoundingClientRect());
				return rows.length === 2 && rows.every(row => row.scrollHeight <= row.clientHeight + 1) && boxes[0].bottom <= boxes[1].top + 1;
			})()`);
			if (!layout) throw new Error("子智能体菜单文字溢出固定行高或相邻行重叠");
		};
		await checkMenuRows();
		await page(`document.querySelector('.subagents-menu').style.maxWidth = '220px'`);
		await checkMenuRows();
		await capture(window, join(outDir, "smoke-subagents-menu-narrow.png"));
		await page(`document.querySelector('.subagents-menu').style.maxWidth = ''`);
		await capture(window, join(outDir, "smoke-subagents-menu.png"));
		await page(
			`[...document.querySelectorAll('.subagents-menu [role=menuitem]')].find((item) => item.textContent.includes(${JSON.stringify(TASK_TITLE)})).click()`,
		);
		// 面板换过子 Agent 时，换走的那个的输入框还挂着（隐藏，见宿主的 ChildConversation），按钮排在前面：只认看得见的那个。
		const agentsSend = `[...document.querySelectorAll('${agentsPanel} [data-composer-send=send]')].find((button) => button.checkVisibility())`;
		await until(`document.querySelector('${agentsPanel} [data-sub-header]')?.textContent.includes(${JSON.stringify(TASK_TITLE)})`, "面板换到写说明的子 Agent");
		await page(`[...document.querySelectorAll('${agentsPanel} .cm-content')].find((editor) => editor.checkVisibility()).focus()`);
		await window.webContents.insertText("补充说明：保留 child 内容");
		await until(`${agentsSend}?.disabled === false`, "运行中的子会话可以插话而不是停止");
		await page(`${agentsSend}.click()`);
		await until(
			`[...document.querySelectorAll('${agentsPanel} .cm-placeholder')].some((placeholder) => placeholder.checkVisibility()) && ${agentsSend}?.disabled === true`,
			"插话已排入子会话",
		);
		await delay(300);
		await capture(window, join(outDir, "smoke-subagent-approval.png"));
		await click("[data-approval-card] button", "允许一次");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(TASK_FINAL)})`, "主 Agent 拿到子 Agent 的回答");
		if ((await readFile(join(workspace, "child.txt"), "utf8").catch(() => "")) !== "child\n") throw new Error("子 Agent 没写出 child.txt");
		// 里面的活收着：点开收着的活，直到看见 task 的卡片。
		await until(
			`(() => {
			if (document.querySelector('[data-tool=task]')) return true;
			for (const button of document.querySelectorAll('[data-plume-step][data-plume-run] > button[aria-expanded=false]')) button.click();
			return false;
		})()`,
			"看见 task 的工具卡片",
		);
		await click(`[data-tool=task] button[aria-label="在面板里看 @general 的全过程"]`);
		await until(`document.querySelector('${agentsPanel} [data-sub-report]')?.textContent.includes(${JSON.stringify(CHILD_TEXT)})`, "子 Agent 单独画回报卡");
		await until(
			`document.querySelector('${agentsPanel} [data-child-conversation]')?.textContent.split(${JSON.stringify(CHILD_TEXT)}).length === 2`,
			"回报与末条正文不重复",
		);
		await until(`${agentsSend}?.disabled === true && document.querySelector('[data-subagent-bar]') === null`, "完成后保留禁用操控区，活动条退出");
		await delay(300);
		await capture(window, join(outDir, "smoke-subagents.png"));
		await page(`document.querySelector('[data-screen=chat] .cm-content').focus()`);
		await window.webContents.insertText(`/btw ${SIDE_QUESTION}`);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		await click("[data-composer-send=send]");
		const sidePanel = shown("plume.side-chat/chat");
		await until(
			`document.querySelector('${sidePanel} [data-child-conversation]')?.textContent.includes(${JSON.stringify(SIDE_TEXT)})`,
			"/btw 新开侧边聊天，回答画在那里",
		);
		if (
			await page(
				`[...document.querySelectorAll('[data-plume-transcript-rows]')].some((rows) => !rows.closest('[data-child-conversation]') && rows.textContent.includes(${JSON.stringify(SIDE_QUESTION)}))`,
			)
		)
			throw new Error("/btw 问的话不该进主对话");
		await delay(300);
		await capture(window, join(outDir, "smoke-side-chat.png"));
		await checkSideChatWindow(window, outDir);
		// 父会话派活后先收尾，再由结果唤起；并发请求按工具表认身份，不依赖到达顺序。
		const childPhaseRequests = model.requests.slice(sentBefore);
		const toolNames = (request: Record<string, unknown> | undefined) => ((request?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
		const parentRequests = childPhaseRequests.filter((request) => toolNames(request).includes("task"));
		const sideRequest = childPhaseRequests.find((request) => toolNames(request).includes("read_main_chat"));
		const childRequests = childPhaseRequests.filter((request) => !toolNames(request).includes("task") && !toolNames(request).includes("read_main_chat"));
		// 前段故意留下未完成清单；派活轮结束时子 Agent 还没回来，不追问清单（问了只会逼它提前写结论）。
		if (parentRequests.length !== 4 || childRequests.length !== 3 || !sideRequest)
			throw new Error(
				`后台派发预期父会话4次（子 Agent 没回来时不追问清单）、子会话3次及侧边聊天1次，实际 ${parentRequests.length}/${childRequests.length}/${Boolean(sideRequest)}`,
			);
		if (!JSON.stringify(parentRequests.at(-1)?.messages).includes(CHILD_TEXT)) throw new Error("后台结果没有送进父会话");
		if (!JSON.stringify(childRequests.findLast((request) => toolNames(request).includes("write"))?.messages).includes("补充说明：保留 child 内容"))
			throw new Error("操控区插话没有送进子会话");
		if (toolNames(sideRequest).includes("task")) throw new Error("侧边聊天不该拿到 task");
		if (!JSON.stringify(sideRequest.messages).includes("派个子 Agent 写一份说明")) throw new Error("侧边聊天的提问里没有主对话的内容");
		childrenPhase = false;
		// 排队消息、划词侧聊在单独的 queue、quote-side-chat 段。

		// 下一步建议（市场里的插件）、用量与状态（内置插件）：用宿主开的三个扩展点（灰字建议、回复过滤、输入框工具栏右边那一格）。
		// 回复末尾的 `:followup[…]` 不画进正文、变成输入框的灰字，按 Tab 整段填进去；模型选择左边是上下文用量的圆环，点开写出窗口占用。
		await plugin.install("followups");
		await waitFor(async () => (await agent.plugins()).some((status) => status.key === "followups" && status.state === "active"), "装上 followups 插件");
		const hintFrom = model.requests.length;
		await page(`document.querySelector('[data-screen=chat] .cm-content').focus()`);
		await window.webContents.insertText("都齐了吗");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes("都齐了。")`, "收到带下一步建议的回复");
		// 会话里的系统提示词是冻结的：中途装上的插件加的段，作为增量消息接在这一轮开头送到。
		const hinted = JSON.stringify(model.requests[hintFrom]?.messages ?? "");
		if (!hinted.includes('<section-update id=\\"followups\\">') || !hinted.includes(":followup[")) throw new Error("下一步建议插件的提示词没经增量送到");
		if (await page(`document.querySelector('[data-screen=chat] [data-plume-transcript-rows]')?.textContent.includes(':followup[')`))
			throw new Error("回复里的 :followup 标记不该画出来");
		await until(`document.querySelector('[data-screen=chat] .cm-placeholder')?.textContent === ${JSON.stringify(FOLLOWUP_HINT)}`, "下一步建议成了输入框的灰字");
		await until(
			`(() => {
			const meter = document.querySelector('[data-screen=chat] [data-plume-context-meter]');
			const model = document.querySelector('[data-screen=chat] [data-model-trigger]');
			return Boolean(meter && model && /^上下文占用 \\d+%$/.test(meter.getAttribute('aria-label') ?? '') && meter.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING);
		})()`,
			"模型选择左边出现上下文用量的圆环",
		);
		await click("[data-screen=chat] [data-plume-context-meter]");
		await until(
			`(() => {
			const text = document.querySelector('[data-plume-popover][role=group]')?.textContent ?? '';
			return /上下文窗口.+ \\/ .+（\\d+%）/.test(text) && ['对话消息', '工具', '系统提示词', '剩余空间'].every((label) => text.includes(label));
		})()`,
			"点开圆环写出上下文窗口占用和各段",
		);
		await capture(window, join(outDir, "smoke-context-meter.png"));
		await click("[data-screen=chat] [data-plume-context-meter]");
		await until(`document.querySelector('[data-plume-popover][role=group]') === null`, "再点一次收起上下文用量");
		await delay(300);
		await capture(window, join(outDir, "smoke-followups.png"));
		await page(`document.querySelector('[data-screen=chat] .cm-content').focus()`);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
		await until(
			`document.querySelector('[data-screen=chat] .cm-placeholder') === null && document.querySelector('[data-screen=chat] .cm-content')?.textContent === ${JSON.stringify(FOLLOWUP_HINT)}`,
			"按 Tab 把建议填进输入框",
		);
		// 草稿清掉，不带到后面的步骤里。灰字画在 .cm-content 里面，空了它会回来，所以看它在不在，不看字。
		for (let i = 0; i < FOLLOWUP_HINT.length; i++) {
			window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
			window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
		}
		await until(`document.querySelector('[data-screen=chat] .cm-placeholder') !== null`, "清掉填进去的草稿");

		// 6. 使用统计、存储：上面那一轮的调用记进了花销。使用统计是市场里的插件，装上后在设置 › 数据里「存储」上面多一页。
		await plugin.install("usage");
		await waitFor(async () => (await agent.plugins()).some((status) => status.key === "usage" && status.state === "active"), "装上 usage 插件");
		await click("button", "设置");
		// agent 进程报已装上时，界面入口还在加载：等它登记的那一页出现在导航里再点。
		await until(
			`[...document.querySelectorAll('[aria-label=设置章节] button')].some((button) => button.textContent.trim() === '使用统计')`,
			"使用统计出现在设置导航",
		);
		await click("[aria-label=设置章节] button", "使用统计");
		await until(
			`document.querySelector('[data-screen=settings][data-section="plugin:plume.usage/usage"] [data-usage-request-kpis]') !== null`,
			"使用统计读出花销",
		);
		if (await page(`document.querySelector('[data-usage-requests] [data-empty]') !== null && document.querySelector('[data-usage-bars]') === null`))
			throw new Error("今天的调用应该画成柱子");
		await delay(300);
		await capture(window, join(outDir, "smoke-usage.png"));
		await click("[aria-label=设置章节] button", "存储");
		await until(`/\\d/.test(document.querySelector('[data-usage-total]')?.textContent ?? '')`, "存储页量出会话记录");
		await capture(window, join(outDir, "smoke-storage.png"));
		// 插件的设置放在哪：IM 机器人只和自己有关，画进它在市场里的详情、不占设置导航；使用统计占导航一行，详情里给去那里的入口。
		await plugin.install("im");
		await waitFor(async () => (await agent.plugins()).some((status) => status.key === "im" && status.state === "active"), "装上 im 插件");
		await click("button", "返回工作区");
		await click("[data-nav=market]");
		await until(`document.querySelector('[data-screen=market] [data-card="im"] > button') !== null`, "市场列出 IM 机器人");
		await click(`[data-card="im"] > button`);
		await until(
			`document.querySelector('[data-plugin-detail="im"] [data-plugin-settings-section="plume.im/im"] [role=switch]') !== null`,
			"IM 的设置画在详情里",
		);
		await delay(300);
		await capture(window, join(outDir, "smoke-plugin-settings-inline.png"));
		await click('nav[aria-label="插件市场"] button');
		await until(`document.querySelector('[data-card="usage"] > button') !== null`, "回到市场网格");
		await click(`[data-card="usage"] > button`);
		await until(`document.querySelector('[data-plugin-detail="usage"] [data-plugin-settings] button') !== null`, "使用统计的详情里有去设置的入口");
		await click("[data-plugin-detail] [data-plugin-settings] button", "去 设置 › 使用统计");
		await until(`document.querySelector('[data-screen=settings][data-section="plugin:plume.usage/usage"]') !== null`, "从详情去设置 › 使用统计");
		if (
			await page(`[...document.querySelectorAll('[aria-label=设置章节] button')].some((button) => ['IM 机器人', '插件'].includes(button.textContent.trim()))`)
		)
			throw new Error("设置导航里不该有 IM 机器人，也不该再有「插件」");
		// 常规页：「运行期间不让电脑休眠」经主进程存进数据目录，关回去不留系统声明。
		await click("[aria-label=设置章节] button", "常规");
		await until(`document.querySelector('[data-screen=settings][data-section=general]') !== null`, "打开常规设置");
		await capture(window, join(outDir, "smoke-general.png"));
		const keepAwake = async (on: boolean) => {
			await click(`[role=switch][aria-label="运行期间不让电脑休眠"]`);
			await waitFor(
				async () => {
					const saved = JSON.parse(await readFile(join(plumeHome(), "keep-awake.json"), "utf8").catch(() => "{}")) as { keepAwake?: boolean };
					return saved.keepAwake === on;
				},
				on ? "打开不让休眠并存下" : "关掉不让休眠并存下",
			);
		};
		await keepAwake(true);
		await keepAwake(false);
		await click("button", "返回工作区");

		// 7. 外观：主题和会话背景
		await click("button", "设置");
		await click("[aria-label=设置章节] button", "外观");
		await until(`document.querySelector('[data-screen=settings][data-section=appearance]') !== null`, "打开外观设置");
		const checkCodeLayout = async (uiSize: number) => {
			const metrics = (await page(`(() => {
				const card = document.querySelector('[data-plume-code-appearance]');
				const section = card.parentElement;
				const first = card.querySelector('[data-settings-row]');
				const title = first.querySelector('.text-label');
				const detail = title.nextElementSibling;
				const border = [...card.children].find(node => node.contains(card.querySelector('[role=switch][aria-label="描边"]')));
				const specimen = card.querySelector('.markdown');
				const preview = card.querySelector('[data-code-preview]');
				return {
					sectionGap: parseFloat(getComputedStyle(section.parentElement).rowGap),
					headingGap: card.getBoundingClientRect().top - section.querySelector('h2').getBoundingClientRect().bottom,
					padding: parseFloat(getComputedStyle(card).paddingLeft),
					titleSize: parseFloat(getComputedStyle(title).fontSize),
					detailSize: parseFloat(getComputedStyle(detail).fontSize),
					detailGap: detail.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
					borderBottom: parseFloat(getComputedStyle(border).borderBottomWidth),
					specimenGap: specimen.getBoundingClientRect().top - border.getBoundingClientRect().bottom,
					previewGap: preview.getBoundingClientRect().top - specimen.getBoundingClientRect().bottom,
				};
			})()`)) as Record<string, number>;
			const expected = {
				sectionGap: 36,
				headingGap: 12,
				padding: 16,
				titleSize: uiSize,
				detailSize: uiSize - 2,
				detailGap: 0,
				borderBottom: 0,
				specimenGap: 16,
				previewGap: 24,
			};
			if (Object.entries(expected).some(([key, value]) => !Number.isFinite(metrics[key]) || Math.abs(metrics[key]! - value) > 0.5)) {
				throw new Error(`代码外观布局未对齐：${JSON.stringify({ expected, actual: metrics })}`);
			}
		};
		const checkPreferenceText = async (uiSize: number) => {
			await until(
				`(() => {
				const rows = [...document.querySelectorAll('[data-appearance-preferences] [data-settings-row]')];
				return rows.length > 0 && rows.every(row => {
					const [title, detail] = row.firstElementChild.children;
					return getComputedStyle(title).fontSize === '${uiSize}px' && getComputedStyle(detail).fontSize === '${uiSize - 2}px';
				});
			})()`,
				"偏好设置标题和说明按同一字号层级缩放",
			);
		};
		await checkCodeLayout(14);
		await checkPreferenceText(14);
		await page(
			`(() => { const card = document.querySelector('[data-appearance-preferences]'); card.parentElement.scrollIntoView({ block: 'start' }); card.closest('.plume-scroll-view').scrollTop -= 48; })()`,
		);
		await capture(window, join(outDir, "smoke-preferences-light.png"));
		// 经真实设置控件检查 CSS、预览与落盘值，不直接修改 store。
		await click('[role=switch][aria-label="使用指针光标"]');
		await until(
			`document.documentElement.dataset.pointerCursor === 'true' && getComputedStyle(document.querySelector('[data-appearance-reset]')).cursor === 'pointer'`,
			"指针偏好实时生效",
		);
		await click('[data-segment="on"]');
		await until(
			`document.documentElement.dataset.reduceMotion === 'on' && parseFloat(getComputedStyle(document.querySelector('[data-segment="off"]')).transitionDuration) < 0.001`,
			"减少动态效果覆盖全局时长",
		);
		await type('[data-plume-number="uiFontSize"] input', "16");
		await until(`getComputedStyle(document.body).fontSize === '16px'`, "界面字号实时生效");
		await checkPreferenceText(16);
		if (process.platform === "darwin") {
			await click('[role=switch][aria-label="窗口毛玻璃"]');
			await until(`document.documentElement.dataset.vibrancy === 'off'`, "关闭窗口毛玻璃");
			if (window.getBackgroundColor() === "#00000000") throw new Error("关闭毛玻璃后窗口底色仍透明");
			await click('[role=switch][aria-label="窗口毛玻璃"]');
			await until(`document.documentElement.dataset.vibrancy === 'on'`, "重新打开窗口毛玻璃");
		}
		await click('[aria-label="浅色代码高亮"]');
		await click("[role=menuitem]", "Solarized Light");
		await click('[aria-label="深色代码高亮"]');
		await click("[role=menuitem]", "GitHub Dark");
		await type('[data-plume-number="codeFontSize"] input', "15");
		await type('[data-plume-number="codeLineHeight"] input', "1.8");
		await type('[data-plume-number="codeLetterSpacing"] input', "0.02");
		await click('[data-segment="syntax"]');
		await click('[role=switch][aria-label="描边"]');
		await until(
			`(() => { const preview = document.querySelector('[data-code-preview="light"] textarea'); const style = preview && getComputedStyle(preview); return style?.fontSize === '15px' && style.lineHeight === '27px' && Math.abs(parseFloat(style.letterSpacing) - 0.3) < 0.01; })()`,
			"代码排版实时应用到预览",
		);
		await type('[data-code-preview="light"] textarea', "const hello = '你好';\nconsole.log(hello);");
		await until(`document.querySelector('[data-code-preview="dark"] textarea')?.value.includes('console.log(hello)')`, "两套代码预览共用样例");
		await page(
			`(() => { const section = document.querySelector('[data-plume-code-appearance]').parentElement; section.scrollIntoView({ block: 'start' }); section.closest('.plume-scroll-view').scrollTop -= 48; })()`,
		);
		await checkCodeLayout(16);
		await capture(window, join(outDir, "smoke-code-appearance-light.png"));
		await click("button[aria-pressed]", "深色");
		await until(
			`matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).getPropertyValue('--plume-code-bg').trim() === '#0d1117'`,
			"深色代码主题实际生效",
		);
		await checkCodeLayout(16);
		await capture(window, join(outDir, "smoke-code-appearance-dark.png"));
		await page(
			`(() => { const border = document.querySelector('[role=switch][aria-label="描边"]').closest('[data-settings-row]'); border.scrollIntoView({ block: 'start' }); border.closest('.plume-scroll-view').scrollTop -= 48; })()`,
		);
		await capture(window, join(outDir, "smoke-code-appearance-preview.png"));
		await click('[data-segment="custom"]');
		await type('input[aria-label="深色底色"]', "#D6C300");
		await until(`getComputedStyle(document.documentElement).getPropertyValue('--plume-inline-code-bg').trim() === '#D6C300'`, "行内代码自定义底色生效");
		await waitFor(async () => {
			const persisted = JSON.parse(await readFile(join(outDir, "home", "appearance.json"), "utf8"));
			return (
				persisted.pointerCursor === true &&
				persisted.reduceMotion === "on" &&
				persisted.uiFontSize === 16 &&
				persisted.codeDarkTheme === "github-dark" &&
				persisted.codeFontSize === 15 &&
				persisted.inlineCodeDarkBg === "#D6C300"
			);
		}, "外观偏好与代码样式持久化");
		const appearanceWindowSize = window.getSize();
		window.setSize(380, 440);
		await until(`innerWidth <= 380`, "窄窗口外观页");
		await page(
			`(() => { const section = document.querySelector('[data-plume-code-appearance]').parentElement; section.scrollIntoView({ block: 'start' }); section.closest('.plume-scroll-view').scrollTop -= 48; })()`,
		);
		await checkCodeLayout(16);
		await checkPreferenceText(16);
		await until(
			`(() => { const rects = [...document.querySelectorAll('[data-plume-code-appearance] [data-settings-row], [data-code-preview]')].map(node => node.getBoundingClientRect()); return rects.every(rect => rect.left >= 0 && rect.right <= innerWidth); })()`,
			"窄窗口代码控件不溢出",
		);
		await capture(window, join(outDir, "smoke-code-appearance-compact.png"));
		window.setSize(appearanceWindowSize[0]!, appearanceWindowSize[1]!);
		await click("[data-appearance-reset]");
		await until(
			`document.documentElement.dataset.pointerCursor === 'false' && document.documentElement.dataset.reduceMotion === 'system' && getComputedStyle(document.body).fontSize === '14px' && getComputedStyle(document.documentElement).getPropertyValue('--plume-code-size').trim() === '12px'`,
			"整页恢复默认清除外观覆盖",
		);
		await waitFor(async () => Object.keys(JSON.parse(await readFile(join(outDir, "home", "appearance.json"), "utf8"))).length === 0, "恢复默认写入存储");
		await checkPreferenceText(14);
		await click("button[aria-pressed]", "深色");
		await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "切到深色");
		await page(
			`(() => { const card = document.querySelector('[data-appearance-preferences]'); card.parentElement.scrollIntoView({ block: 'start' }); card.closest('.plume-scroll-view').scrollTop -= 48; })()`,
		);
		await capture(window, join(outDir, "smoke-preferences-dark.png"));
		await capture(window, join(outDir, "smoke-appearance.png"));
		// 背景只在换肤工坊里设置，外观页不再有入口；这里经同一套预加载接口铺一张图，只在对话中显示，欢迎页截图不叠加。
		await page(
			`(async () => { const picked = await window.plume.chatBackground.pick(''); await window.plume.saveAppearance({ chatBackground: picked.name, chatBackgroundOnNewChat: false, chatBackgroundInChat: true }); })()`,
		);
		await waitFor(async () => {
			const saved = JSON.parse(await readFile(join(outDir, "home", "appearance.json"), "utf8")) as { theme?: string; chatBackground?: string };
			return saved.theme === "dark" && Boolean(saved.chatBackground);
		}, "外观设置存下来");
		await click("button", "返回工作区");
		await until(`document.querySelector('[data-screen=chat] > .chat-backdrop') !== null`, "会话里铺上背景");
		await delay(500);
		await checkComposer("深色背景图会话页");
		await capture(window, join(outDir, "smoke-backdrop.png"));
		await checkSidebarResize(window, join(outDir, "smoke-sidebar-resize-dark.png"));
		await checkPanelResize(window, join(outDir, "smoke-panel-resize-dark.png"));
		// 背景图验完就不在对话里铺了：它是一张应用截图，后面各段按纯色底核对像素（网页预览的整页截图）时会被它搅乱。
		await page(`window.plume.saveAppearance({ chatBackgroundInChat: false })`);
		await until(`document.querySelector('[data-screen=chat] > .chat-backdrop') === null`, "对话里撤下背景");

		// 7.5 设置 › 智能体：子智能体插件画名单和编辑器，侧边聊天插件在「会话」那张卡里登记一行选模型。
		await click("button", "设置");
		await click("[aria-label=设置章节] button", "智能体");
		await until(
			`document.querySelector('[data-subagents-settings] [data-agent-profile=general]') !== null && document.querySelector('[data-session-model="plume.side-chat/model"]') !== null`,
			"智能体页列出内置子智能体和侧边聊天模型",
		);
		await delay(300);
		await capture(window, join(outDir, "smoke-agents-settings.png"));
		await click("[data-agent-profile=general] button", "");
		await until(`document.querySelector('[data-agent-editor] [data-agent-avatar]') !== null`, "点一行打开子智能体编辑器");
		await click("[data-agent-editor] [data-agent-avatar]");
		await until(`document.querySelectorAll('[data-avatar-picker] [data-avatar-shape]').length > 0`, "选脸弹层列出形状");
		await delay(300);
		await capture(window, join(outDir, "smoke-agents-editor.png"));
		await page(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
		await until(`document.querySelector('[data-avatar-picker]') === null`, "收起选脸弹层");
		await click("button", "取消");
		await until(`document.querySelector('[data-agent-editor]') === null`, "关掉子智能体编辑器");
		await click("button", "返回工作区");
		await until(`document.querySelector('[data-screen=chat]') !== null`, "从智能体页回到会话");

		// 8. 新对话继承当前项目；离开项目恢复 Chat 草稿，不改已有会话的归属。
		const sessions = await storedSessions();
		if (sessions.length !== 1 || !sessions[0]?.project || sessions[0].thinking !== "off") throw new Error("首次发送没有保存项目和思考档位，或重复创建了会话");
		// 面板框架专项重载过页面，内存草稿已释放；在本组导航验收前重新准备 Chat 草稿。
		await click("[data-nav=new-chat]");
		await until(`document.querySelector('button[aria-label="不在项目中工作"]') !== null`, "准备项目外草稿");
		await click('button[aria-label="不在项目中工作"]');
		await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent === '想聊点什么？'`, "打开 Chat 草稿");
		await click("button", "开发功能");
		await until(`document.querySelector('.cm-content')?.textContent.includes('新增一个功能')`, "重新准备导航验收草稿");
		window.webContents.send("plume:command", `open-session:${sessions[0].id}`);
		await until(`document.querySelector('[data-screen=chat]') !== null`, "回到项目会话验证导航");
		// 点收起和看开关在同一段脚本里：面板还在往右滑，标题栏的「显示面板」要先藏着，不然和面板自己那颗「收起面板」叠成一道虚影。
		const toggleWhileSliding = await page(`(() => {
			document.querySelector('[data-panel-area] button[aria-label="收起面板"]')?.click();
			const toggle = document.querySelector("[data-panel-toggle]");
			return toggle === null ? "none" : getComputedStyle(toggle).opacity;
		})()`);
		if (toggleWhileSliding !== "0" && toggleWhileSliding !== "none")
			throw new Error(`收起面板时标题栏的面板开关没等面板滑走就露出来了（不透明度 ${String(toggleWhileSliding)}）`);
		await until(
			`document.querySelector('[data-panel-area]')?.inert === true && document.querySelector('[data-panel-toggle] button') !== null`,
			"收起面板后正文标题栏恢复打开按钮",
		);
		await click("[data-nav=new-chat]");
		await until(
			`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace') && document.querySelectorAll('[data-plume-row]').length === 1`,
			"新对话继承项目而不生成空行",
		);
		// 侧边聊天、子 Agent 只围着一个会话转：新对话还没发消息时开始页不列（面板区收着也挂着开始页）。
		await until(
			`(() => {
			const launchers = [...document.querySelectorAll('[data-panel-launch]')].map((card) => card.dataset.panelLaunch);
			return launchers.includes('plume.terminal/terminal') && !launchers.includes('plume.side-chat/chat') && !launchers.includes('plume.subagents/agents');
		})()`,
			"新对话的开始页不列侧边聊天和子 Agent",
		);
		// 标题先出现，自动聚焦在下一帧；等它完成再模拟键盘转移焦点。
		await until(`document.activeElement?.classList.contains('cm-content') === true`, "新对话完成自动聚焦");
		await page(`document.querySelector('[data-project-trigger]').focus()`);
		await until(`getComputedStyle(document.querySelector('button[aria-label="不在项目中工作"]').parentElement).opacity === '1'`, "键盘聚焦项目时显示清除按钮");
		await click('button[aria-label="不在项目中工作"]');
		await until(
			`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent === '想聊点什么？' && document.querySelector('.cm-content')?.textContent.includes('新增一个功能')`,
			"项目外草稿恢复",
		);
		await checkComposer("深色欢迎页");
		await checkWelcomeHead("深色欢迎页");
		await checkDraftChips("深色");
		await capture(window, join(outDir, "smoke-welcome-dark.png"));
		const originalSize = window.getSize();
		window.setSize(380, 440);
		await until(`window.innerWidth <= 380`, "窄窗口欢迎页");
		await page(`document.querySelector('[data-composer-send]').scrollIntoView({ block: 'center' })`);
		await until(
			`(() => { const rect = document.querySelector('[data-composer-send]').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`,
			"最小窗口仍能到达发送按钮",
		);
		await checkComposer("最小窗口欢迎页");
		await checkWelcomeHead("最小窗口欢迎页");
		await page(`document.querySelector('.plume-draft-chip:last-child').scrollIntoView({ block: 'end' })`);
		await until(
			`(() => { const chips = [...document.querySelectorAll('.plume-draft-chip')]; const rects = chips.map(chip => chip.getBoundingClientRect()); return rects.length === 4 && rects.every(rect => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight) && new Set(rects.map(rect => rect.top)).size > 1; })()`,
			"最小窗口建议换行且四项都可到达",
		);
		await capture(window, join(outDir, "smoke-welcome-compact.png"));
		window.setSize(originalSize[0]!, originalSize[1]!);
		await click("[data-plume-row] button");
		await until(`document.querySelector('[data-screen=chat]') !== null`, "返回已有会话");
		if (await page(`document.querySelector('.plume-composer-arrive') !== null`)) throw new Error("普通打开已有会话不应播放首次发送动画");
		if ((await storedSessions()).length !== 1) throw new Error("新对话不应落盘");
		await capture(window, join(outDir, "smoke-sidebar.png"));
		// 第一轮五次：第二个请求先被 503 了一次，重试的那次写到一半，第四次接着写完，第五次是答完后的清单收尾（只勾清单、就此结束）。
		// 后面八次是后台子 Agent 和侧边聊天的，上面查过。
		const [first, , second, last] = model.requests.slice(0, 4);
		if (!first || !second || !last || model.requests.length !== 14 + extraRequests)
			throw new Error(`基础流程应请求模型十四次（首轮五次、父子会话八次、下一步建议一次；专项的 ${extraRequests} 次另算），实际 ${model.requests.length} 次`);
		if (!JSON.stringify(last.messages).includes("自动继续")) throw new Error("截断以后的请求里没有接着写的那句话");
		if (first.model !== "fake-model") throw new Error(`请求里的模型应该是 fake-model，实际是 ${String(first.model)}`);
		if (!JSON.stringify(first.system).includes("You are Plume")) throw new Error("系统提示词里没有身份那段：内置插件 plume.prompt 没加载");
		const offered = (first.tools as Array<{ name: string }>).map((tool) => tool.name);
		if (!offered.includes("todo_write")) throw new Error(`模型收到的工具里没有 todo_write：${offered.join()}`);
		const content = await readFile(join(workspace, "hello.txt"), "utf8");
		if (content !== "hi\n") throw new Error(`hello.txt 没有被改对：${JSON.stringify(content)}`);
		const plugins = await agent.plugins();
		const inactive = plugins.filter((plugin) => plugin.state !== "active");
		if (inactive.length > 0) throw new Error(`有插件不是 active：${JSON.stringify(inactive)}`);
		const builtins = plugins.filter((plugin) => plugin.builtin).map((plugin) => plugin.name);
		for (const name of [
			"plume.sandbox",
			"plume.tools",
			"plume.approval",
			"plume.ask-user",
			"plume.prompt",
			"plume.compaction",
			"plume.delivery",
			"plume.documents",
			"plume.todo",
			"plume.skills",
			"plume.commands",
			"plume.web",
			"plume.browser",
			"plume.status",
			"plume.title",
		])
			if (!builtins.includes(name)) throw new Error(`内置插件 ${name} 没加载：${builtins.join()}`);

		// 拉取请求、生成式界面、后台命令、网页预览、导航、换肤工坊、会话列表、点开文件不在这条主流程里：
		// 它们各有单独的一段（`PLUME_SMOKE_ONLY=<段名>`），`pnpm smoke` 和主流程并行跑，见 scripts/smoke.mjs。
		// 提问、/compact 各开一段会话（新会话、分叉），放在会话数量断言之后。
		await checkQuestion({
			window,
			outDir,
			page,
			until,
			click,
			capture,
			setModel: (next) => (override = next),
			sessionId: recent.id,
			finalText: FINAL_TEXT,
		});
		await checkCompact({
			window,
			outDir,
			page,
			until,
			click,
			capture,
			setModel: (next) => (override = next),
			sessionId: recent.id,
			finalText: FINAL_TEXT,
		});
		// 编辑重发、分叉、撤回和独立会话窗口在单独的 session-menu、session-window 段。
		console.log(`PLUME_SMOKE ${JSON.stringify({ ok: true, requests: model.requests.length, toolsOffered: offered, screenshot: file, plugins })}`);
		window.webContents.debugger.detach();
		await shutdown();
		await model.close();
		app.exit(0);
	} catch (error) {
		console.error(`PLUME_SMOKE ${JSON.stringify({ ok: false, error: String(error), requests: model.requests.length })}`);
		await capture(window, file).catch(() => undefined);
		if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
		await shutdown().catch(() => undefined);
		await model.close();
		app.exit(1);
	}
}

/** 一次页面脚本最多等多久。要比各处 `until` 的 15 秒宽，又要远小于 `scripts/smoke.mjs` 的总上限。 */
const PAGE_SCRIPT_TIMEOUT = 60_000;

/**
 * 冒烟里的每扇窗口（主窗口和之后开出的面板、会话窗口）都这样处理：
 *
 * - 显示而不抢焦点。冒烟在人正在用的桌面上跑，面板弹到独立窗口、交回主窗口时产品会 `show()` + `focus()`，
 *   窗口就抢走键盘，人这时打的字（或别的程序往前台终端发的命令）打进冒烟的窗口。页面那边不受影响：
 *   键盘事件经 `sendInputEvent` 直接送进页面，主窗口还用焦点模拟当作在前台。
 * - 页面脚本有上限，出错时带上是哪一段脚本。`settle`、`until` 里的 `requestAnimationFrame`、动画的 `finished` 都在页面里等，
 *   窗口停画或动画停住时一次执行就永远不返回；`until` 只在两次执行之间看截止时间，管不到它。
 *   绕过 `scripts/smoke.mjs` 直接起 Electron 时也没有那边的总上限，卡住了就不会自己退出。
 */
function guardWindow(target: BrowserWindow): void {
	target.show = () => target.showInactive();
	target.focus = () => undefined;
	const contents = target.webContents;
	const execute = contents.executeJavaScript.bind(contents);
	contents.executeJavaScript = (code: string, userGesture?: boolean) =>
		new Promise((resolve, reject) => {
			const script = code.replace(/\s+/g, " ").slice(0, 160);
			const timer = setTimeout(() => reject(new Error(`页面脚本 ${PAGE_SCRIPT_TIMEOUT / 1000} 秒没有返回：${script}`)), PAGE_SCRIPT_TIMEOUT);
			execute(code, userGesture)
				// Electron 只说「Script failed to execute」，不说是哪一段：把脚本开头接上，失败时知道卡在哪一步。
				.then(resolve, (error: unknown) => reject(new Error(`${String(error)}（页面脚本：${script}）`)))
				.finally(() => clearTimeout(timer));
		});
}

async function capture(window: BrowserWindow, file: string): Promise<void> {
	// DOM 断言通过不代表新画面已提交给合成器，等绘制后再取图，避免截到上一页。
	await window.webContents.executeJavaScript(`(async () => {
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
	})()`);
	const image = await window.webContents.capturePage();
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, image.toPNG());
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
