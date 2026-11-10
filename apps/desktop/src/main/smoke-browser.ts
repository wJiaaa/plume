import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import { BrowserWindow, webContents } from "electron";
import type { Remote } from "@plume/rpc";
import type { AgentProcessApi } from "../shared/protocol.ts";

/** 冒烟里假模型的一次请求：看得到工具表和消息，回一段。 */
export type ModelOverride = (request: Record<string, unknown>) => FakeReply;

/**
 * 浏览器插件走一遍真窗口：从开始页开一个浏览器标签、地址栏打开本机的一页（`<webview>` 挂上、交给逻辑入口），
 * 再让假模型经 `browser_act` 读页面、点一个会弹 confirm 的按钮（宿主替它取消、写进结果）、点链接换页、`browser_screenshot`
 * 截图（图片跟在工具结果里），面板上画出光标；地址栏打开磁盘上的 `.html`；标签弹到独立窗口再收回，页面跟着换窗口；
 * 右键回复里的网址在内置浏览器里开出新标签；最后经菜单关掉标签，页面跟着没了。
 */
export async function checkBrowser(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	outDir: string;
	setModel(override: ModelOverride | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir } = options;
	const page = <T>(expression: string, target = window): Promise<T> => target.webContents.executeJavaScript(expression) as Promise<T>;
	const until = async (expression: string, label: string, timeout = 15_000, target = window) => {
		const end = Date.now() + timeout;
		while (!(await page<boolean>(expression, target))) {
			if (Date.now() > end) throw new Error(`浏览器冒烟等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const waitMain = async (test: () => boolean | Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await test())) {
			if (Date.now() > end) throw new Error(`浏览器冒烟等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const capture = async (name: string) => writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	const press = (keyCode: string) => {
		window.webContents.sendInputEvent({ type: "keyDown", keyCode });
		window.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Return" ? "\r" : keyCode });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode });
	};

	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (request.url === "/next") response.end("<title>Next page</title><p>arrived</p>");
		else
			response.end(
				`<title>Plume Smoke</title><h1>Plume browser smoke</h1><button id="go" onclick="document.querySelector('h1').textContent = confirm('Really?') ? 'confirmed' : 'dismissed'">Press me</button><p><a href="/next">Next page</a></p>`,
			);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	const guest = () => webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().startsWith(url));
	const guests = () => webContents.getAllWebContents().filter((contents) => contents.getType() === "webview");
	const titled = (title: string) => guests().find((contents) => contents.getTitle() === title);
	const local = join(outDir, "smoke-local.html");
	await writeFile(local, "<title>Local smoke</title><p>read from disk</p>");
	try {
		if (!plugin.cli) throw new Error("没有 plume-plugin 启动脚本，装不了浏览器插件");
		await plugin.install("browser");
		await waitMain(async () => (await agent.plugins()).some((status) => status.key === "browser" && status.state === "active"), "装上浏览器插件");

		// 从开始页开一个浏览器标签：空白页，地址栏打开本机那一页。
		const panel = '[data-panel="plume.browser/browser"]:not([inert])';
		await page(`document.querySelector('button[data-panel-add]').click()`);
		await until(`document.querySelector('[data-panel-launch="plume.browser/browser"]') !== null`, "开始页列出浏览器");
		await page(`document.querySelector('[data-panel-launch="plume.browser/browser"]').click()`);
		await until(
			`document.querySelector('${panel} [data-browser-empty]') !== null && document.querySelector('${panel} [data-browser-omnibox] input') !== null`,
			"开出空白的浏览器标签",
		);
		await page(`document.querySelector('${panel} [data-browser-omnibox] input').focus()`);
		await window.webContents.insertText(url);
		press("Return");
		await waitMain(() => guest()?.getTitle() === "Plume Smoke", "地址栏打开本机的一页");
		await until(
			`document.querySelector('${panel} [data-browser-empty]') === null && [...document.querySelectorAll('[data-panel-tab]')].some((tab) => tab.textContent.includes('Plume Smoke'))`,
			"标签上写着页面的标题",
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await capture("smoke-browser.png");
		// dom-ready 早于网页进程交出第一帧；隐藏窗口里此时发原生点击会落空，先等它确实能画。
		await waitMain(async () => {
			try {
				const image = await guest()?.capturePage();
				return image !== undefined && !image.isEmpty();
			} catch {
				return false;
			}
		}, "网页第一帧已提交");

		// agent 读页面、点按钮（confirm 由宿主取消）、点链接换页。
		const seen: string[] = [];
		options.setModel((request) => {
			const messages = JSON.stringify(request.messages ?? []);
			seen.push(messages);
			if (!messages.includes("toolu_browser_read"))
				return { text: "先读一下。", toolCalls: [{ id: "toolu_browser_read", name: "browser_act", args: { action: "read" } }] };
			if (!messages.includes("toolu_browser_press"))
				return { toolCalls: [{ id: "toolu_browser_press", name: "browser_act", args: { action: "click", selector: "#go" } }] };
			if (!messages.includes("toolu_browser_next"))
				return { toolCalls: [{ id: "toolu_browser_next", name: "browser_act", args: { action: "click", selector: "a" } }] };
			if (!messages.includes("toolu_browser_shot")) return { toolCalls: [{ id: "toolu_browser_shot", name: "browser_screenshot", args: {} }] };
			return { text: `浏览器验证完成。[另一页](${url}other)` };
		});
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("看一下浏览器里的页面");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('浏览器验证完成。')`, "agent 操作完网页", 60_000);
		options.setModel(undefined);
		const last = seen.at(-1) ?? "";
		assert.ok(last.includes("Press me") && /e\d+ button #go Press me/.test(last), "read 交回了按钮那一行");
		assert.ok(last.includes("dismissed"), "confirm 由宿主取消，写进了结果");
		assert.ok(last.includes('\\"navigated\\": true'), "点链接以后等到了新的一页");
		// 测试用的模型不一定看图：看图的发出去是图片块，不看的由请求那一层换成一句说明；两样都说明工具结果里带着图。
		assert.ok(last.includes("Screenshot of Next page") && /"type":"image"|image omitted/.test(last), "截图跟在工具结果里");
		await waitMain(() => guest()?.getTitle() === "Next page", "页面换到了下一页");
		await until(`document.querySelector('${panel} [data-browser-cursor]') !== null`, "面板上画出 agent 的光标");
		await capture("smoke-browser-agent.png");

		// 地址栏打开磁盘上的 `.html`：逻辑入口换成本机页面的地址。
		await page(`document.querySelector('${panel} [data-browser-omnibox] input').focus()`);
		await page(`document.querySelector('${panel} [data-browser-omnibox] input').select()`);
		await window.webContents.insertText(local);
		press("Return");
		await waitMain(() => titled("Local smoke")?.getURL().startsWith("http://127.0.0.1:") === true, "地址栏打开磁盘上的 .html");

		// 弹到独立窗口：那边挂上新的 `<webview>`，同一页接过去；收回来再回到主窗口。
		await page(`document.querySelector('button[aria-label="在新窗口中打开"]').click()`);
		await waitMain(() => BrowserWindow.getAllWindows().some((candidate) => candidate !== window && candidate.isVisible()), "浏览器标签弹到独立窗口");
		const detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible())!;
		await waitMain(() => titled("Local smoke")?.hostWebContents?.id === detached.webContents.id, "独立窗口里接上同一页");
		await until(`document.querySelector('[data-browser-panel] [data-browser-omnibox]') !== null`, "独立窗口里画出浏览器", 15_000, detached);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await writeFile(join(outDir, "smoke-browser-window.png"), (await detached.webContents.capturePage()).toPNG());
		// 收回时独立窗口跟着关掉，这一次脚本的结果回不来。
		await page(`document.querySelector('button[aria-label="收回"]').click()`, detached).catch(() => {});
		await waitMain(() => titled("Local smoke")?.hostWebContents?.id === window.webContents.id, "收回主窗口后接上同一页");

		// 右键回复里的网址：在内置浏览器里开出这个会话的一个新标签。
		await page(
			`(() => { const link = document.querySelector('[data-screen=chat] a[href="${url}other"]'); const box = link.getBoundingClientRect(); link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: box.left + 2, clientY: box.top + 2 })); })()`,
		);
		await until(
			`[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.trim() === '在内置浏览器打开')`,
			"网址的右键菜单列出内置浏览器",
		);
		// 第一行说出默认浏览器的名字；这台机器查不到时退回「系统浏览器」。
		const first = await page<string>(`document.querySelector('[role=menuitem]').textContent.trim()`);
		assert.match(first, /^在 .+ 中打开$|^在系统浏览器中打开$/, "网址右键菜单的第一行是系统浏览器");
		await page(`[...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent.trim() === '在内置浏览器打开').click()`);
		await waitMain(() => guests().some((contents) => contents.getURL() === `${url}other`), "内置浏览器开出回复里的网址");
		await until(`document.querySelectorAll('[data-panel-tab="plume.browser/browser"]').length === 2`, "开成一个新标签");

		// 经菜单逐个关掉标签，页面跟着没了。
		for (let left = 2; left > 0; left--) {
			await page(`document.querySelector('${panel} button[aria-label="浏览器菜单"]').click()`);
			await until(`[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.trim() === '关闭标签页')`, "浏览器菜单打开");
			await page(`[...document.querySelectorAll('[role=menuitem]')].find((item) => item.textContent.trim() === '关闭标签页').click()`);
			await until(`document.querySelectorAll('[data-panel-tab="plume.browser/browser"]').length === ${left - 1}`, "关掉浏览器标签");
		}
		await until(`document.querySelector('[data-panel="plume.browser/browser"]') === null`, "浏览器标签都关了");
		await waitMain(() => guests().length === 0, "关掉标签以后页面没了");
		console.log(
			"PLUME_BROWSER_SMOKE",
			JSON.stringify({
				opened: true,
				agent: true,
				dialog: true,
				navigated: true,
				screenshot: true,
				local: true,
				detached: true,
				linkOpener: true,
				closed: true,
			}),
		);
	} finally {
		options.setModel(undefined);
		server.close();
	}
}
