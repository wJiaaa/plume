import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";
import { clickVisibleIn, firstOf } from "./smoke-kit.ts";

/** 真输入框的 @、命令面板及通知跳转；系统通知由主进程的注入式测试验证，不打扰桌面。 */
export async function checkNavigation({
	window,
	outDir,
	page,
	until,
	click,
	capture,
	setModel,
	sessionId,
	installPlugin,
}: {
	window: BrowserWindow;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	capture(window: BrowserWindow, path: string): Promise<void>;
	setModel(override: ModelOverride | undefined): void;
	sessionId: string;
	/** 从市场装一个插件，等它在 agent 进程里生效。 */
	installPlugin(name: string): Promise<void>;
}): Promise<void> {
	const clear = async () => {
		await page(`document.querySelector('main .cm-content').focus()`);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
		// 按键不等页面处理完就返回：紧接着 insertText 的字可能先到、再被这次全选删掉。
		await until(`document.querySelector('main .cm-placeholder') !== null`, "清空输入框");
	};
	const escape = () => {
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
	};
	const search = 'button[aria-label="搜索会话"]';
	// 输入框的编辑区带补全菜单，也是 role=combobox、aria-autocomplete=list，而且排在弹窗前面：只认弹窗里的那个 input。
	const palette = "[role=dialog] input[role=combobox]";
	let referenced = false;
	setModel((request) => {
		const messages = JSON.stringify(request.messages);
		if (messages.includes("session://")) referenced = true;
		if (messages.includes('"tool_use_id":"navigation-ask"')) return { text: "引用已收到。" };
		if (!(request.tools as { name: string }[] | undefined)?.some((tool) => tool.name === "ask_user")) return { text: "引用测试" };
		return { toolCalls: [{ id: "navigation-ask", name: "ask_user", args: { question: "引用哪一段？", options: ["这一段", "下一段"] } }] };
	});
	try {
		await click(search);
		await until(`document.querySelector('${palette}') !== null`, "命令面板打开");
		for (const theme of ["light", "dark"]) {
			await page(`window.plume.saveAppearance({ theme: ${JSON.stringify(theme)} })`);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, `命令面板 ${theme}`);
			await capture(window, join(outDir, `smoke-palette-${theme}.png`));
		}
		await page(
			`(() => { const input=document.querySelector('${palette}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'新对话'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
		);
		await until(`document.querySelector('[data-plume-palette-item="new-chat"]') !== null`, "命令面板搜索新对话");
		await click('[data-plume-palette-item="new-chat"]');
		await until(`document.querySelector('[data-screen=empty]') !== null && !document.querySelector('${palette}')`, "命令执行后关闭面板");
		// 新对话跟着上一次的去处：前面各段可能把它留在项目外，项目外没有目录可列，@ 里就没有文件。回到 workspace 项目再试 @。
		if (!(await page(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace') === true`))) {
			await click("[data-project-trigger]");
			await click("[role=menuitem]", "workspace");
			await until(`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace') === true`, "新对话回到 workspace 项目");
		}
		await page(`document.querySelector('main .cm-content').focus()`);
		await window.webContents.insertText("@");
		await until(
			`document.querySelector('[data-mention-kind=file]') !== null && document.querySelector('[data-mention-kind=session]') !== null`,
			"@ 列出文件和会话",
		);
		await capture(window, join(outDir, "smoke-mentions-dark.png"));
		await page(`window.plume.saveAppearance({ theme: 'light' })`);
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "@ 切到浅色");
		await capture(window, join(outDir, "smoke-mentions-light.png"));
		// Esc 收起菜单、「@」还留在输入框里时装上一个插件：菜单按新的插件名单重拉条目，收起后还画着的上一份里有子智能体的脸，不能因此崩掉。
		await until(`document.querySelector('[data-mention-kind=subagent]') !== null`, "@ 列出子智能体");
		escape();
		await until(`document.querySelector('[data-mention-kind=subagent]')?.closest('[data-open]')?.getAttribute('data-open') === 'false'`, "Esc 收起引用菜单");
		await installPlugin("usage");
		// 界面入口在 plugins 事件到了之后才载入，页面上看不出载完没有：给它一会儿。
		await delay(1500);
		if (!(await page(`document.querySelector('main .cm-content') !== null`))) throw new Error("引用菜单收起时装插件，界面崩了");
		await clear();
		await window.webContents.insertText("@");
		await until(`document.querySelector('[data-mention-kind=file]')?.closest('[data-open]')?.getAttribute('data-open') === 'true'`, "重新打开引用菜单");
		await click("[data-mention-kind=file]");
		await until(`document.querySelector('main .cm-content')?.textContent.includes('@"')`, "文件引用加引号");
		await clear();
		await window.webContents.insertText("@");
		// 收起的菜单还画着上一份条目（inert）：只认开着的菜单里的，不然菜单还没重开这一步就判过了。
		await until(`document.querySelector('[data-mention-kind=session]')?.closest('[data-open]')?.getAttribute('data-open') === 'true'`, "再次打开引用菜单");
		await click("[data-mention-kind=session]");
		await until(`document.querySelector('.plume-composer-dock [data-session-references] button') !== null`, "会话引用变成可移除签");
		await window.webContents.insertText("参考它问我一个问题");
		await click("[data-composer-send=send]");
		await until(`document.querySelector('[data-ask-form]') !== null`, "引用发送后提问");
		if (!referenced) throw new Error("会话引用没有给模型 session:// 入口");
		if (!(await page(`document.querySelector('[data-plume-quote=user] [data-session-references]') !== null`))) throw new Error("消息没保留会话引用");
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "离开待回复的会话");
		await click('button[aria-label="通知"]');
		await until(`document.querySelector('[data-plume-notice=waiting]') !== null`, "通知列出待批准会话");
		await capture(window, join(outDir, "smoke-notifications.png"));
		await click("[data-plume-notice=waiting]");
		await until(`document.querySelector('[data-ask-form]') !== null`, "通知跳回审批卡");
		await clickVisibleIn(page, firstOf("[data-ask-option]"), "第一个选项");
		await click("[data-ask-action=submit]");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('引用已收到。')`, "通知中的提问答复完成");
		// 最小窗口里列表和输入框都必须留在视口内。
		window.setSize(380, 440);
		await until(`document.querySelector('button[aria-label^="显示侧边栏"]') !== null`, "窄窗口侧栏开关");
		await click('button[aria-label^="显示侧边栏"]');
		await click(search);
		await until(`document.querySelector('[data-plume-palette-item]') !== null`, "窄窗口命令面板");
		await capture(window, join(outDir, "smoke-palette-narrow.png"));
		escape();
	} finally {
		window.setSize(1100, 720);
		setModel(undefined);
		window.webContents.send("plume:command", `open-session:${sessionId}`);
	}
	console.log("PLUME_NAVIGATION_SMOKE", JSON.stringify({ mentions: true, sessionReference: true, palette: true, notification: true }));
}
