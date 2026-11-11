import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { BrowserWindow, nativeImage, shell } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { plumeHome } from "./home.ts";

/** 真生图插件、会话事件和窗口交接；模型与生图服务只访问本机，系统定位出口用记录替身。 */
export async function checkGallery(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (ready: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 20_000;
		while (!(await ready())) {
			if (Date.now() > end) throw new Error(`画廊验证超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(`Boolean(${code})`), label);
	const click = async (selector: string, text?: string) => {
		await until(
			`(() => { const item = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => ${text === undefined ? "true" : `node.textContent.trim() === ${JSON.stringify(text)}`}); if (!item || item.disabled) return false; item.click(); return true; })()`,
			`点击 ${text ?? selector}`,
		);
	};
	const type = async (selector: string, value: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)}) !== null`, `输入 ${selector}`);
		await page(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); if (input.select) input.select(); })()`);
		await window.webContents.insertText(value);
	};
	const nativeClick = async (selector: string) => {
		const point = await page<{ x: number; y: number }>(
			`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
		);
		window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
		window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
	};
	const send = async (text: string) => {
		await type(".cm-content", text);
		await click('.plume-composer [data-composer-send="send"]');
	};
	const capture = async (name: string) => {
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
		await page(
			"Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))",
		);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	let requests = 0;
	let hold = false;
	let pending: ServerResponse | undefined;
	const respond = (response: ServerResponse) => {
		const width = 160 + requests * 20;
		const image = nativeImage.createFromBitmap(Buffer.alloc(width * 100 * 4, 255), { width, height: 100 });
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ b64_json: image.toPNG().toString("base64") }] }));
	};
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			if (!request.url?.endsWith("/images/generations") && !request.url?.endsWith("/images/edits")) {
				response.writeHead(404).end();
				return;
			}
			requests++;
			if (hold) pending = response;
			else respond(response);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("生图假服务未监听端口");
	const savedReveal = shell.showItemInFolder;
	let revealed: string | undefined;
	let detached: BrowserWindow | undefined;
	let call = 0;
	const draw = (edit: boolean) => {
		const id = `gallery_${++call}`;
		let asked = false;
		setModel(() => {
			if (asked) return { text: `画廊生成完成 ${id}` };
			asked = true;
			return { toolCalls: [{ id, name: "image_generate", args: { prompt: `gallery smoke ${id}`, ...(edit ? { images: ["#1"] } : {}) } }] };
		});
	};
	const gallery = async () => {
		await click("button", "画廊");
		await until("document.querySelector('[data-image-gallery]') !== null", "画廊打开");
	};
	try {
		assert.ok(plugin.cli, "插件启动脚本存在");
		await plugin.install("image");
		await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.image" && item.state === "active"), "生图插件加载");
		window.webContents.send("plume:command", "settings");
		await click("button", "模型设置");
		await click("[data-add-provider]");
		await type("#provider-name", "画廊假生图");
		await type("#provider-url", `http://127.0.0.1:${address.port}`);
		await type("#provider-key", "gallery-test-key");
		await click("[data-provider-form] [role=switch]");
		await click("[data-provider-add]");
		await until(
			"document.querySelector('[data-provider-editor]')?.textContent.includes('画廊假生图') && !document.querySelector('[data-provider-form]')",
			"新供应商成为当前编辑对象",
		);
		await click("[data-provider-editor] [data-add-model]");
		await type("[data-model-editor-id]", "gpt-image-1");
		await click("[data-model-editor-save]");
		await until("document.querySelector('[data-model-row=\"gpt-image-1\"]') !== null", "生图模型保存");
		await click("button", "返回工作区");

		const before = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until("document.querySelector('[data-screen=empty]') !== null", "新会话");
		draw(false);
		await send("画廊验收：先画一张图");
		await until("document.querySelector('[data-image-card=done] img')?.naturalWidth > 0", "真实生图工具输出");
		await until("!document.querySelector('.plume-composer [data-composer-send=stop]')", "首轮完成");
		const session = (await agent.sessions()).find((item) => !before.has(item.id))!;
		assert.ok(session, "找到图片所属会话");

		// 看图器复制 `plume-media://` 的图：和页面不同源，读回像素那一步曾因画布被污染而失败。剪贴板换成记录替身，不碰系统剪贴板。
		await click("[data-image-card=done] img");
		await page(
			"window.__galleryClipboardWrite = navigator.clipboard.write; navigator.clipboard.write = async items => { window.__galleryCopied = (await items[0].getType('image/png')).size; }; void 0;",
		);
		await click('button[aria-label="复制图片"]');
		await until("window.__galleryCopied > 0", "看图器复制会话媒体里的图");
		await page("navigator.clipboard.write = window.__galleryClipboardWrite; delete window.__galleryClipboardWrite; delete window.__galleryCopied;");
		await click('button[aria-label="关闭 Esc"]');
		await until("!document.querySelector('button[aria-label=\"复制图片\"]')", "看图器关闭");
		await gallery();
		await until("document.querySelectorAll('[data-image-gallery-tile]').length === 1", "首张图进入画廊");
		await click("[data-image-gallery-tile]");
		await until("document.querySelector('[data-image-gallery-detail]') !== null", "详情打开");
		const original = await page<string>("document.querySelector('[data-image-gallery-detail]').dataset.imageGalleryDetail");

		// 返回会话发送、再回画廊等待；新图落盘时页面无需重新进入就换到结果。
		hold = true;
		draw(true);
		await type("[data-image-gallery-words]", "画廊验收：改成第二张");
		await click("[data-image-gallery-send] button");
		await wait(async () => pending !== undefined, "生图请求挂起");
		await gallery();
		await until("document.querySelector('[data-image-gallery-send] [data-composer-send=stop]') !== null", "改图按钮显示停止");
		respond(pending!);
		pending = undefined;
		await until("document.querySelectorAll('[data-image-gallery-tile]').length === 2", "生成落盘实时刷新");
		await until(
			`(() => { const detail = document.querySelector('[data-image-gallery-detail]'); return detail && detail.dataset.imageGalleryDetail !== ${JSON.stringify(original)}; })()`,
			"详情承接改图结果",
		);
		await until("document.querySelector('[data-image-gallery-send] [data-composer-send=send]') !== null", "生成完成恢复发送");
		for (const theme of ["light", "dark"]) {
			await page(`window.plume.saveAppearance({ theme: ${JSON.stringify(theme)} })`);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, theme);
			await capture(`smoke-gallery-${theme}.png`);
		}

		draw(true);
		await type("[data-image-gallery-words]", "画廊验收：这次停止");
		await click("[data-image-gallery-send] button");
		await wait(async () => pending !== undefined, "停止前生图挂起");
		await gallery();
		const stop = "[data-image-gallery-send] [data-composer-send=stop]";
		await until(`document.querySelector(${JSON.stringify(stop)}) !== null`, "停止入口就绪");
		await nativeClick(stop);
		await wait(async () => !(await agent.sessions()).find((item) => item.id === session.id)?.running, "真实点击停止会话");
		await wait(async () => pending?.destroyed === true, "生图网络请求取消");
		pending = undefined;
		assert.equal(await page("document.querySelectorAll('[data-image-gallery-tile]').length"), 2, "取消不增加画廊图片");

		window.webContents.send("plume:command", `open-session:${session.id}`);
		await until("document.querySelector('[data-screen=chat]') !== null", "原会话");
		await type(".cm-content", "保留已有草稿");
		await gallery();
		await type("[data-image-gallery-words]", "追加改图要求");
		await click("[data-image-gallery-send] button");
		await until(
			"document.querySelector('.cm-content')?.textContent.includes('保留已有草稿') && document.querySelector('.cm-content')?.textContent.includes('追加改图要求')",
			"改图保留并追加草稿",
		);
		assert.equal((await agent.sessions()).find((item) => item.id === session.id)?.running, false, "已有草稿时不自动发送");
		assert.equal(requests, 3, "保护草稿没有发起第四次生图");

		// 真会话窗口中的菜单把文件面板交回主窗口，目标仍是这张图所属会话。
		await page(`window.plume.sessionWindows.open(${JSON.stringify(session.id)})`);
		await wait(async () => {
			for (const candidate of BrowserWindow.getAllWindows()) {
				if (candidate === window || candidate.isDestroyed()) continue;
				if ((await candidate.webContents.executeJavaScript("window.plume?.sessionWindows.boot").catch(() => null)) === session.id) detached = candidate;
			}
			return detached !== undefined;
		}, "独立会话窗口");
		await wait(
			async () => Boolean(await detached!.webContents.executeJavaScript("document.querySelector('[data-image-card=done] img')?.naturalWidth > 0")),
			"独立窗口图片",
		);
		const context = `(() => { const picture = document.querySelector('[data-image-card=done] .plume-image-canvas'); const r = picture.getBoundingClientRect(); picture.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 4, clientY: r.y + 4 })); })()`;
		await detached!.webContents.executeJavaScript(context);
		await wait(
			async () =>
				Boolean(
					await detached!.webContents.executeJavaScript(
						"Boolean([...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === '在新标签页中打开图片'))",
					),
				),
			"图片右键菜单",
		);
		await detached!.webContents.executeJavaScript(
			"[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === '在新标签页中打开图片').click()",
		);
		await until("document.querySelector('[data-panel]:not([inert]) img')?.naturalWidth > 0", "托管媒体在普通文件面板加载");
		assert.equal(await page(`document.querySelector('[data-plume-row="${session.id}"] > button')?.getAttribute('aria-current')`), "page", "面板保持来源会话");
		await capture("smoke-gallery-file-pane.png");
		shell.showItemInFolder = (path) => {
			revealed = path;
		};
		await detached!.webContents.executeJavaScript(context);
		const revealLabel = process.platform === "darwin" ? "在访达中显示" : process.platform === "win32" ? "在资源管理器中显示" : "在文件管理器中显示";
		await wait(
			async () =>
				Boolean(
					await detached!.webContents.executeJavaScript(
						`Boolean([...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === ${JSON.stringify(revealLabel)}))`,
					),
				),
			"定位菜单项",
		);
		await detached!.webContents.executeJavaScript(
			`[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === ${JSON.stringify(revealLabel)}).click()`,
		);
		await wait(async () => revealed !== undefined, "定位托管图片");
		assert.equal(revealed, await page(`window.plume.media.path(${JSON.stringify(original)})`));

		const secret = join(outDir, "media-outside.png");
		const escaped = `${"f".repeat(40)}.png`;
		await writeFile(secret, "outside");
		await mkdir(join(plumeHome(), "session-media"), { recursive: true });
		await symlink(secret, join(plumeHome(), "session-media", escaped));
		assert.equal(await page(`window.plume.media.path(${JSON.stringify(escaped)})`), null);
		assert.equal(await page(`fetch('plume-media://m/${escaped}').then(response => response.ok)`), false, "媒体协议拒绝软链越界");
		assert.equal(await page(`window.plume.media.path('../settings.json')`), null);
		console.log(
			"PLUME_GALLERY_SMOKE",
			JSON.stringify({ ok: true, stop: true, liveRefresh: true, editResult: true, draftPreserved: true, detached: true, mediaBoundary: true }),
		);
	} finally {
		shell.showItemInFolder = savedReveal;
		if (detached && !detached.isDestroyed()) detached.close();
		pending?.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		setModel(undefined);
	}
}
