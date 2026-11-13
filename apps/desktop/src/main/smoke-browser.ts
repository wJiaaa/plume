import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import { BrowserWindow, webContents } from "electron";
import type { Remote } from "@plume/rpc";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { clickVisible, contextMenuVisibleIn, lastOf } from "./smoke-kit.ts";
import { windowClosed } from "./smoke-panels.ts";

/** 冒烟里假模型的一次请求：看得到工具表和消息，回一段。 */
export type ModelOverride = (request: Record<string, unknown>) => FakeReply;

/**
 * 内置的浏览器插件走一遍真窗口：从开始页开一个浏览器标签、地址栏打开本机的一页（`<webview>` 挂上、交给逻辑入口），
 * 再让假模型经 `browser_act` 读页面、按 ref 点一行只靠脚本响应点击的 div、点一个会弹 confirm 的按钮（宿主替它取消、写进结果）、点「登录」开出按尺寸开的小窗口
 * （开成真窗口、经 `window.opener` 把结果交回原页面后自己关掉，结果里叫 agent 找人）、点 `target=_blank` 的链接开出后台标签、
 * 点链接换到一张带密码框的页（`read: true` 交回的页面标着要登录）、`browser_screenshot`
 * 截图（图片跟在工具结果里），面板上画出光标；地址栏打开磁盘上的 `.html`；标签弹到独立窗口再收回，页面跟着换窗口；
 * 右键回复里的网址在内置浏览器里开出新标签；最后经菜单关掉标签，页面跟着没了。
 */
export async function checkBrowser(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	outDir: string;
	setModel(override: ModelOverride | undefined): void;
}): Promise<void> {
	const { window, agent, outDir } = options;
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

	let signedIn = false;
	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (request.url === "/next") response.end('<title>Next page</title><p>arrived</p><label>Password <input type="password"></label>');
		else if (request.url === "/tab") response.end("<title>Tab page</title><p>opened from a link</p>");
		// 第三方登录那样的小窗口：把结果交回开它的页面，然后自己关掉。
		else if (request.url === "/auth")
			response.end("<title>Sign in</title><p>signing in</p><script>window.opener.postMessage('token', '*'); setTimeout(() => window.close(), 300);</script>");
		else if (request.url === "/signed-in") {
			signedIn = true;
			response.end("ok");
		} else
			response.end(
				`<title>Plume Smoke</title><h1>Plume browser smoke</h1><button id="go" onclick="document.querySelector('h1').textContent = confirm('Really?') ? 'confirmed' : 'dismissed'">Press me</button><p><a href="/next">Next page</a></p>` +
					`<button id="login" onclick="window.open('/auth', 'plume-auth', 'width=420,height=520')">Sign in</button><p><a id="tab" href="/tab" target="_blank">Tab page</a></p><p id="account"></p>` +
					// 列表行那样只靠 cursor: pointer 和脚本响应点击的 div：read 要给它一个 ref，里面继承了 pointer 的 span 不单列。
					`<div id="row" style="cursor: pointer"><span>Open row</span></div><script>document.querySelector('#row').addEventListener('click', (event) => { event.currentTarget.textContent = 'row opened'; });</script>` +
					`<script>addEventListener('message', (event) => { if (event.data === 'token') { document.querySelector('#account').textContent = 'signed in'; fetch('/signed-in'); } });</script>`,
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
		// 浏览器是内置插件，随应用加载。
		await waitMain(async () => (await agent.plugins()).some((status) => status.key === "browser" && status.state === "active"), "浏览器插件已加载");

		// 从开始页开一个浏览器标签：空白页，地址栏打开本机那一页。
		const panel = '[data-panel="plume.browser/browser"]:not([inert])';
		await clickVisible(page, `button[data-panel-add]`);
		await until(`document.querySelector('[data-panel-launch="plume.browser/browser"]') !== null`, "开始页列出浏览器");
		await clickVisible(page, `[data-panel-launch="plume.browser/browser"]`);
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
			// 按 read 给的 ref 点那一行，不用选择器：验证 ref 指得到它。
			const row = /(e\d+) div #row Open row/.exec(messages)?.[1];
			if (row && !messages.includes("toolu_browser_row"))
				return { toolCalls: [{ id: "toolu_browser_row", name: "browser_act", args: { action: "click", ref: row, read: true } }] };
			if (!messages.includes("toolu_browser_press"))
				return { toolCalls: [{ id: "toolu_browser_press", name: "browser_act", args: { action: "click", selector: "#go" } }] };
			if (!messages.includes("toolu_browser_login"))
				return { toolCalls: [{ id: "toolu_browser_login", name: "browser_act", args: { action: "click", selector: "#login" } }] };
			// 像真的那样等人在小窗口里登完：原页面拿到结果后写着 signed in。
			if (!messages.includes("toolu_browser_signed"))
				return { toolCalls: [{ id: "toolu_browser_signed", name: "browser_act", args: { action: "wait", text: "signed in" } }] };
			if (!messages.includes("toolu_browser_tab"))
				return { toolCalls: [{ id: "toolu_browser_tab", name: "browser_act", args: { action: "click", selector: "#tab" } }] };
			if (!messages.includes("toolu_browser_next"))
				return { toolCalls: [{ id: "toolu_browser_next", name: "browser_act", args: { action: "click", selector: "a", read: true } }] };
			if (!messages.includes("toolu_browser_shot")) return { toolCalls: [{ id: "toolu_browser_shot", name: "browser_screenshot", args: {} }] };
			return { text: `浏览器验证完成。[另一页](${url}other)` };
		});
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("看一下浏览器里的页面");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "发送按钮可用");
		await clickVisible(page, `[data-composer-send=send]`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('浏览器验证完成。')`, "agent 操作完网页", 60_000);
		options.setModel(undefined);
		const last = seen.at(-1) ?? "";
		assert.ok(last.includes("Press me") && /e\d+ button #go Press me/.test(last), "read 交回了按钮那一行");
		assert.ok(/e\d+ div #row Open row/.test(last) && !/e\d+ span Open row/.test(last), "read 列出了靠脚本响应点击的那一行，没把里面的 span 单列");
		assert.ok(last.includes("row opened"), "按 ref 点到了那一行");
		assert.ok(last.includes("dismissed"), "confirm 由宿主取消，写进了结果");
		assert.ok(last.includes('\\"navigated\\": true'), "点链接以后等到了新的一页");
		assert.ok(last.includes("opened a separate window for 127.0.0.1") && last.includes("ask_user"), "登录小窗口写进结果、叫 agent 找人");
		assert.ok(last.includes("opened http://127.0.0.1") && last.includes("new background tab"), "target=_blank 开出后台标签、写进结果");
		assert.ok(/\\"wall\\": \\"sign-in\\"/.test(last), "带密码框的页标着要登录");
		await waitMain(() => signedIn, "小窗口经 window.opener 把结果交回了原页面");
		await waitMain(() => !BrowserWindow.getAllWindows().some((candidate) => candidate.webContents.getURL().endsWith("/auth")), "小窗口自己关掉了");
		await waitMain(() => titled("Tab page") !== undefined, "target=_blank 的链接开成了后台标签");
		// 测试用的模型不一定看图：看图的发出去是图片块，不看的由请求那一层换成一句说明；两样都说明工具结果里带着图。
		assert.ok(last.includes("Screenshot of Next page") && /"type":"image"|image omitted/.test(last), "截图跟在工具结果里");
		await waitMain(() => titled("Next page") !== undefined, "页面换到了下一页");
		await until(`document.querySelector('${panel} [data-browser-cursor]') !== null`, "面板上画出 agent 的光标");
		await capture("smoke-browser-agent.png");

		// 地址栏打开磁盘上的 `.html`：逻辑入口换成本机页面的地址。
		await page(`document.querySelector('${panel} [data-browser-omnibox] input').focus()`);
		await page(`document.querySelector('${panel} [data-browser-omnibox] input').select()`);
		await window.webContents.insertText(local);
		press("Return");
		await waitMain(() => titled("Local smoke")?.getURL().startsWith("http://127.0.0.1:") === true, "地址栏打开磁盘上的 .html");

		// 弹到独立窗口：那边挂上新的 `<webview>`，同一页接过去；收回来再回到主窗口。
		await clickVisible(page, `button[aria-label="在新窗口中打开"]`);
		await waitMain(() => BrowserWindow.getAllWindows().some((candidate) => candidate !== window && candidate.isVisible()), "浏览器标签弹到独立窗口");
		const detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible())!;
		await waitMain(() => titled("Local smoke")?.hostWebContents?.id === detached.webContents.id, "独立窗口里接上同一页");
		await until(`document.querySelector('[data-browser-panel] [data-browser-omnibox]') !== null`, "独立窗口里画出浏览器", 15_000, detached);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await writeFile(join(outDir, "smoke-browser-window.png"), (await detached.webContents.capturePage()).toPNG());
		// 收回时独立窗口跟着关掉，这一次脚本的结果回不来。
		await clickVisible((code: string) => page(code, detached), `button[aria-label="收回"]`).catch(windowClosed);
		await waitMain(() => titled("Local smoke")?.hostWebContents?.id === window.webContents.id, "收回主窗口后接上同一页");

		// 右键回复里的网址：在内置浏览器里开出这个会话的一个新标签。
		// 会话里还留着前面没做完的计划，清单插件在这一轮收尾时追问一次，假模型照样再答一遍：同样的链接有两条，右键最后那条。
		await contextMenuVisibleIn(page, lastOf(`[data-screen=chat] a[href="${url}other"]`), "回复里的「另一页」", 2, 2);
		await until(
			`[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.trim() === '在内置浏览器打开')`,
			"网址的右键菜单列出内置浏览器",
		);
		// 第一行说出默认浏览器的名字；这台机器查不到时退回「系统浏览器」。
		const first = await page<string>(`document.querySelector('[role=menuitem]').textContent.trim()`);
		assert.match(first, /^在 .+ 中打开$|^在系统浏览器中打开$/, "网址右键菜单的第一行是系统浏览器");
		await clickVisible(page, `[role=menuitem]`, "在内置浏览器打开");
		await waitMain(() => guests().some((contents) => contents.getURL() === `${url}other`), "内置浏览器开出回复里的网址");
		// 原来那页、target=_blank 开出的后台标签，加上这一个。
		await until(`document.querySelectorAll('[data-panel-tab="plume.browser/browser"]').length === 3`, "开成一个新标签");

		// 经菜单逐个关掉标签，页面跟着没了。
		for (let left = 3; left > 0; left--) {
			await clickVisible(page, `${panel} button[aria-label="浏览器菜单"]`);
			await until(`[...document.querySelectorAll('[role=menuitem]')].some((item) => item.textContent.trim() === '关闭标签页')`, "浏览器菜单打开");
			await clickVisible(page, `[role=menuitem]`, "关闭标签页");
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
				popupWindow: true,
				backgroundTab: true,
				signInWall: true,
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
