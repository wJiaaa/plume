import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { plumeHome } from "./home.ts";

/** 沿用文件专项的真实文档，验证 Git 入口和 MCP 直接／延迟调用走同一预览。 */
export async function checkDocumentPlugins({
	window,
	agent,
	plugin,
	workspace,
	folder,
	outDir,
	setModel,
}: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { builtinDir: string };
	workspace: string;
	folder: string;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}) {
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 20_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`插件文档预览超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(`Boolean(${code})`), label);
	const click = async (selector: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)})`, selector);
		await page(`document.querySelector(${JSON.stringify(selector)}).click()`);
	};
	const capture = async (name: string, selector?: string) => {
		await page(
			"Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))",
		);
		if (selector)
			await page(`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			element.closest('.plume-scroll-view')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
			element.scrollIntoView({ block: 'start', behavior: 'instant' });
		})()`);
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const mcpDir = join(plumeHome(), "plugin-data", "plume.mcp");
	await mkdir(mcpDir, { recursive: true });
	// 只写本次冒烟的空配置；测试服务只返回上一步准备的文档。
	await writeFile(
		join(mcpDir, "servers.json"),
		JSON.stringify({
			servers: ["documents", "deferred"].map((name) => ({
				id: name,
				name,
				transport: "stdio",
				command: process.execPath,
				args: [join(plugin.builtinDir, "mcp/test/fixtures/echo-server.mjs")],
				env: { ELECTRON_RUN_AS_NODE: "1", ECHO_DOCUMENTS: folder, ECHO_MANY: name === "deferred" ? "60" : "0" },
				enabled: true,
				trustReadOnly: true,
				pinned: name === "documents",
			})),
		}),
		{ mode: 0o600 },
	);
	// Git、MCP 都是内置插件。MCP 启动时已照空配置连过，卸下再挂回来，让它照上面这份连。
	const mcp = { key: "mcp", dir: join(plugin.builtinDir, "mcp"), builtin: true };
	await agent.removePlugin("mcp");
	await agent.addPlugin(mcp);
	await wait(async () => (await agent.plugins()).some((item) => item.key === "mcp" && item.state === "active"), "重新加载 mcp");
	await promisify(execFile)("git", ["init", "-q", "-b", "main"], { cwd: workspace });
	await page("window.dispatchEvent(new Event('focus'))");
	await click("[data-panel-toggle] button");
	await click('[data-panel-launch="plume.git/git"]');
	const shown = "[data-panel]:not([inert])";
	const preview = `${shown} [data-git-preview="preview-fixtures/sample.xlsx"]`;
	await until(`document.querySelector(${JSON.stringify(preview)})`, "Git 文件行有预览入口");
	await page(`document.querySelector(${JSON.stringify(preview)}).focus()`);
	await capture("smoke-documents-git-list.png");
	await click(preview);
	await until(`document.querySelector('${shown} [data-document-sheet]')?.textContent.includes('Workbook apples')`, "Git 打开统一表格预览");
	await click('[data-panel-tab="plume.git/git"] [role=tab]');
	await click(`${shown} button[aria-label="切换为树状视图"]`);
	await click(`${shown} [data-git-preview="preview-fixtures/sample.docx"]`);
	await until(`document.querySelector('${shown} [data-document-word][data-document-ready]')?.srcdoc.includes('Word preserves')`, "Git 目录树打开 Word");
	await capture("smoke-documents-git-word.png");
	// diff 评论：在改动视图的行号上留一条，「发给 Agent」交给面板所在的会话；输入框原本是空的，直接发出去。
	await writeFile(join(workspace, "comment.txt"), "comment me\n");
	await page("window.dispatchEvent(new Event('focus'))");
	await click('[data-panel-tab="plume.git/git"] [role=tab]');
	const commentFile = `[...document.querySelectorAll('${shown} .git-file')].find((row) => row.querySelector('.git-tree-file-name')?.textContent === 'comment.txt')`;
	await until(commentFile, "Git 列出新写的文件");
	await page(`${commentFile}.querySelector('.git-tree-toggle').click()`);
	await until(`${commentFile}?.querySelector('.git-diff-pick')`, "改动视图的行号可以评论");
	await page(`(() => {
		${commentFile}.querySelector('.git-diff-pick').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		window.dispatchEvent(new MouseEvent('mouseup'));
	})()`);
	await until("document.querySelector('[data-diff-comment-input]')", "松手后弹出评论框");
	await page("document.querySelector('[data-diff-comment-input]').focus()");
	await window.webContents.insertText("改成大写");
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
	await until(
		`document.querySelector('${shown} [data-diff-comment-bar]')?.textContent.includes('1 条评论') && ${commentFile}?.querySelector('[data-diff-note="saved"]')`,
		"留下评论：行号换成序号，底下一条写着 1 条评论",
	);
	await capture("smoke-git-diff-comment.png");
	setModel(() => ({ text: "评论已处理。" }));
	await click(`${shown} [data-diff-comment-send]`);
	await until(
		"document.querySelector('[data-screen=chat]')?.textContent.includes('按下面这几条评论改代码') && document.querySelector('[data-screen=chat]')?.textContent.includes('评论已处理。')",
		"评论作为一条消息发进会话，Agent 回复",
	);
	await until(`!document.querySelector('${shown} [data-diff-comment-bar]')`, "发出去以后评论清空");
	// 弹到独立窗口再评一次：独立窗口没有输入框，「发给 Agent」转交主窗口，落进来源会话直接发出去。
	await click('button[aria-label="在新窗口中打开"]');
	// `until` 只认同步的值，`list()` 交回的是 Promise，在这里等它的结果。
	const panelWindows = async () => (await page<unknown[]>("window.plume.panelWindows.list()")).length;
	await wait(async () => (await panelWindows()) === 1, "Git 面板弹到独立窗口");
	const detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
	assert.ok(detached, "找到独立的 Git 窗口");
	try {
		const inDetached = (code: string, label: string) =>
			wait(() => detached.webContents.executeJavaScript(`Boolean(${code})`) as Promise<boolean>, `独立窗口：${label}`);
		await inDetached(commentFile, "Git 列出新写的文件");
		// 独立窗口没有卡片：标题栏贴着窗口顶，写面板的名字，不画标签；置顶按钮真的让窗口浮在最上面。
		await inDetached(
			`(() => { const chrome = document.querySelector('[data-panel-window-chrome]'); return chrome && chrome.getBoundingClientRect().top === 0 && document.querySelector('[data-panel-window-title]')?.textContent.includes('Git'); })()`,
			"标题栏贴顶、写着 Git",
		);
		assert.equal(
			await detached.webContents.executeJavaScript("document.querySelector('.rounded-panel, [data-panel-tab]') === null"),
			true,
			"独立窗口不画卡片和标签",
		);
		await detached.webContents.executeJavaScript("document.querySelector('[data-keep-on-top]').closest('button').click()");
		await wait(async () => detached.isAlwaysOnTop(), "面板窗口置顶");
		await inDetached(`document.querySelector('[data-keep-on-top]')?.dataset.keepOnTop === 'true'`, "置顶按钮按下");
		await detached.webContents.executeJavaScript("document.querySelector('[data-keep-on-top]').closest('button').click()");
		await wait(async () => !detached.isAlwaysOnTop(), "面板窗口取消置顶");
		await detached.webContents.executeJavaScript(
			"Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))",
		);
		await writeFile(join(outDir, "smoke-panel-window-git.png"), (await detached.webContents.capturePage()).toPNG());
		await detached.webContents.executeJavaScript(`(() => {
			const row = ${commentFile};
			if (!row.querySelector('.git-diff-pick')) row.querySelector('.git-tree-toggle').click();
		})()`);
		await inDetached(`${commentFile}?.querySelector('.git-diff-pick')`, "改动视图的行号可以评论");
		await detached.webContents.executeJavaScript(`(() => {
			${commentFile}.querySelector('.git-diff-pick').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
			window.dispatchEvent(new MouseEvent('mouseup'));
		})()`);
		await inDetached("document.querySelector('[data-diff-comment-input]')", "松手后弹出评论框");
		await detached.webContents.executeJavaScript("document.querySelector('[data-diff-comment-input]').focus()");
		await detached.webContents.insertText("独立窗口里的评论");
		await inDetached(`document.querySelector('button[aria-label="留下评论"]')?.disabled === false`, "评论写进框里");
		await detached.webContents.executeJavaScript(`document.querySelector('button[aria-label="留下评论"]').click()`);
		await inDetached(`document.querySelector('${shown} [data-diff-comment-bar]')?.textContent.includes('1 条评论')`, "底下一条写着 1 条评论");
		setModel(() => ({ text: "独立窗口的评论已处理。" }));
		await detached.webContents.executeJavaScript(`document.querySelector('${shown} [data-diff-comment-send]').click()`);
		await until(
			"document.querySelector('[data-screen=chat]')?.textContent.includes('独立窗口里的评论') && document.querySelector('[data-screen=chat]')?.textContent.includes('独立窗口的评论已处理。')",
			"独立窗口的评论转交主窗口，在来源会话里发出、Agent 回复",
		);
		await inDetached(`!document.querySelector('${shown} [data-diff-comment-bar]')`, "发出去以后评论清空");
	} finally {
		if (!detached.isDestroyed())
			await detached.webContents.executeJavaScript(`document.querySelector('button[aria-label="收回"]')?.click()`).catch(() => detached.close());
	}
	await wait(async () => (await panelWindows()) === 0, "Git 面板收回原会话");
	await page(`document.querySelectorAll('[data-panel-tab] button[aria-label^="关闭"]').forEach(button => button.click())`);
	let called = false;
	setModel((request) => {
		if (called) return { text: "MCP 文档已返回。" };
		const names = new Set((request.tools as Array<{ name: string }>).map((tool) => tool.name));
		assert.ok(names.has("mcp__documents__echo"));
		assert.ok(names.has("mcp_call"));
		called = true;
		return {
			toolCalls: [
				{ id: "document_direct", name: "mcp__documents__echo", args: { text: "documents" } },
				{ id: "document_deferred", name: "mcp_call", args: { tool: "mcp__deferred__echo", arguments: { text: "documents" } } },
			],
		};
	});
	await page("document.querySelector('.cm-content').focus()");
	await window.webContents.insertText("获取 MCP 文档预览");
	await click("[data-composer-send=send]");
	await until("document.querySelectorAll('[data-mcp-document]').length === 6", "直接与延迟调用均显示三份文档");
	await until("document.querySelector('[data-screen=chat]')?.textContent.includes('MCP 文档已返回。')", "MCP 回复完成");
	const direct = '[data-tool-call="document_direct"]';
	const deferred = '[data-tool-call="document_deferred"]';
	await click(`${direct} [data-mcp-document="sample.xlsx"]`);
	await until(`document.querySelector('${direct} [data-document-sheet]')?.textContent.includes('Workbook apples')`, "MCP 表格内容");
	await capture("smoke-documents-mcp-light.png", `${direct} .mcp-document-preview`);
	await click(`${direct} [data-mcp-document="sample.xlsx"]`);
	await click(`${direct} [data-mcp-document="sample.docx"]`);
	await until(`document.querySelector('${direct} [data-document-word][data-document-ready]')?.srcdoc.includes('Word preserves')`, "MCP Word 页式内容");
	assert.equal(await page(`document.querySelector('${direct} [data-document-word]').getAttribute('sandbox')`), "");
	assert.ok(await page(`document.querySelector('${direct} [data-document-word]').getBoundingClientRect().height >= 400`), "Word 填满预览容器");
	await page("window.plume.saveAppearance({ theme: 'dark' })");
	await until("matchMedia('(prefers-color-scheme: dark)').matches", "MCP 深色");
	await capture("smoke-documents-mcp-dark.png", `${direct} .mcp-document-preview`);
	await click(`${deferred} [data-mcp-document="sample.sqlite"]`);
	await until(`document.querySelector('${deferred} [data-document-sheet]')?.textContent.includes('inventory')`, "延迟调用的 SQLite 内容");
	// 重新加载整个插件，历史结果仍可从自己的内容快照读取。
	await agent.removePlugin("mcp");
	await until("!document.querySelector('[data-mcp-document]')", "撤销前缀和精确卡片");
	await agent.addPlugin(mcp);
	await until("document.querySelectorAll('[data-mcp-document]').length === 6", "重新加载恢复文档卡片");
	await click(`${direct} [data-mcp-document="sample.xlsx"]`);
	await until(`document.querySelector('${direct} [data-document-sheet]')?.textContent.includes('Workbook apples')`, "重新加载读取原快照");
	const size = window.getContentSize();
	window.setContentSize(640, 480);
	await capture("smoke-documents-mcp-compact.png", `${direct} .mcp-document-preview`);
	window.setContentSize(size[0]!, size[1]!);
	setModel(undefined);
	console.log(
		"PLUME_DOCUMENT_PLUGINS_SMOKE",
		JSON.stringify({
			gitList: true,
			gitTree: true,
			gitComment: true,
			gitCommentDetached: true,
			mcpDirect: true,
			mcpDeferred: true,
			reload: true,
			themes: ["light", "dark"],
		}),
	);
}
