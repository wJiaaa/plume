import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { net, protocol, type BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";

/** 无图片插件的真窗口验证显示、目录边界、文件刷新；网络仅替换指定测试域名。 */
export async function checkMarkdownImages(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = async (code: string, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await page<boolean>(code))) {
			if (Date.now() > end) throw new Error(`图片验证超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const send = async (text: string) => {
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(text);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可发送");
		await page(`document.querySelector('[data-composer-send=send]').click()`);
	};
	const capture = async (name: string) => {
		await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
		await page(
			`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`,
		);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const svg = (label: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="darkslateblue"/><text x="24" y="65" fill="white" font-size="20">${label}</text></svg>`;
	let remoteRequests = 0;
	protocol.handle("https", (request) => {
		if (new URL(request.url).hostname !== "markdown-images.invalid") return net.fetch(request, { bypassCustomProtocolHandlers: true });
		remoteRequests++;
		return new Response(svg("HTTPS image"), { headers: { "content-type": "image/svg+xml" } });
	});
	try {
		assert.ok(
			(await agent.plugins()).every((item) => item.name !== "plume.markdown-images"),
			"不安装图片插件",
		);
		setModel(() => ({ text: "图片验证准备完成。" }));
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "空白对话");
		await send("准备图片验证");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('图片验证准备完成。')`, "创建会话");
		const session = (await agent.sessions()).find((item) => !previous.has(item.id))!;
		const root = session.cwd;
		const docs = join(root, "image-docs");
		await mkdir(docs, { recursive: true });
		await writeFile(join(root, "picture.svg"), svg("Local image"));
		await writeFile(join(root, "broken.svg"), "not an image");
		const outside = join(outDir, "outside.svg");
		await writeFile(outside, svg("Outside"));
		await symlink(outside, join(root, "escaped.svg"));
		await writeFile(
			join(docs, "readme.md"),
			'# Markdown 文档图片\n\n![文档相对图](../picture.svg)\n\n<img src="../picture.svg" width="100" height="50" alt="徽章一"> <img src="../picture.svg" width="100" height="50" alt="徽章二">\n\n![远程图](https://markdown-images.invalid/document.svg)',
		);
		setModel(() => ({
			text: `本地图片：\n\n![本地图](picture.svg)\n\n![损坏图](broken.svg) ![缺失图](missing.svg) ![越界图](escaped.svg)\n\n![远程引用](https://markdown-images.invalid/reply.svg)\n\n[图片文档](${join(docs, "readme.md")})`,
		}));
		await send("显示图片");
		const image = '[data-screen=chat] img.md-image[alt="本地图"]';
		await until(`document.querySelector(${JSON.stringify(image)})?.naturalWidth === 240`, "回复本地图加载");
		await until(
			`!document.querySelector('[data-screen=chat] img[alt="损坏图"]') && document.querySelector('[data-screen=chat]')?.textContent.includes('缺失图')`,
			"失败保留链接",
		);
		assert.equal(await page(`document.querySelectorAll('[data-screen=chat] img[alt="越界图"], [data-screen=chat] img[alt="远程引用"]').length`), 0);
		assert.equal(remoteRequests, 0, "回复不请求远端");
		const first = await page<string>(`document.querySelector(${JSON.stringify(image)}).src`);
		assert.match(first, /\?v=\d/);
		for (const theme of ["light", "dark"]) {
			await page(`window.plume.saveAppearance({ theme: '${theme}' })`);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, theme);
			await page(`document.querySelector(${JSON.stringify(image)}).scrollIntoView({ block: 'center' })`);
			await capture(`smoke-markdown-images-${theme}.png`);
		}
		const documentLink = `[data-file-link] a[href=${JSON.stringify(join(docs, "readme.md"))}]`;
		await until(`document.querySelector(${JSON.stringify(documentLink)}) !== null`, "平滑出字到文档链接");
		await page(`document.querySelector(${JSON.stringify(documentLink)}).click()`);
		await until(`document.querySelector('[data-panel]:not([inert]) img[alt="文档相对图"]')?.naturalWidth === 240`, "文档相对图");
		await until(`document.querySelector('[data-panel]:not([inert]) img[alt="远程图"]')?.naturalWidth === 240`, "HTTPS 文档图片");
		assert.equal(remoteRequests, 1);
		assert.ok(
			await page(
				`(() => { const a = document.querySelector('img[alt="徽章一"]').getBoundingClientRect(); const b = document.querySelector('img[alt="徽章二"]').getBoundingClientRect(); return a.top === b.top && a.width <= 100; })()`,
			),
			"徽章保持行内和作者尺寸",
		);
		await capture("smoke-markdown-images-document.png");
		await page(`document.querySelectorAll('[data-panel-tab] button[aria-label^="关闭"]').forEach(button => button.click())`);
		await writeFile(join(root, "picture.svg"), svg("Updated image"));
		setModel(() => ({ text: "更新图片：\n\n![更新图](picture.svg)" }));
		await send("查看更新图片");
		await until(`document.querySelector('img[alt="更新图"]')?.naturalWidth === 240`, "同名覆盖后加载");
		assert.notEqual(await page(`document.querySelector('img[alt="更新图"]').src`), first);
		await until(`document.querySelector('[data-composer-send=stop]') === null`, "更新图片这一轮已结束");
		// 设置页只隐藏会话，不卸载；重新加载窗口才是在读取历史时首次挂载图片。
		await new Promise<void>((resolve) => {
			window.webContents.once("did-finish-load", () => resolve());
			window.webContents.reload();
		});
		await until(`document.querySelector('[data-screen]') !== null`, "界面重新加载");
		window.webContents.send("plume:command", `open-session:${session.id}`);
		await until(`document.querySelector('img[alt="更新图"]')?.naturalWidth === 240`, "历史图片无需插件即可恢复");
		assert.ok(await page(`!document.querySelector('.md-image-pending') && !document.querySelector('img[data-reveal]')`), "历史图片不重复占位和显影");
		setModel(() => ({ text: "流式图片：\n\n![尚未写完](picture", hang: true }));
		await send("检查占位");
		await until(`document.querySelector('.md-image-pending') !== null`, "未完成图片占位");
		await capture("smoke-markdown-images-pending.png");
		await page(`document.querySelector('[data-composer-send=stop]').click()`);
		await until(`document.querySelector('[data-composer-send=stop]') === null`, "停止流式");
		const size = window.getSize();
		window.setSize(600, size[1]!);
		await until(`innerWidth === 600`, "窄窗口");
		assert.ok(
			await page(
				`Array.from(document.querySelectorAll('img.md-image')).every(img => img.getBoundingClientRect().width <= img.parentElement.getBoundingClientRect().width)`,
			),
		);
		await capture("smoke-markdown-images-narrow.png");
		window.setSize(size[0]!, size[1]!);
		console.log(
			"PLUME_MARKDOWN_IMAGES_SMOKE",
			JSON.stringify({ ok: true, local: true, document: true, remote: true, boundary: true, refreshed: true, builtin: true, pending: true }),
		);
	} finally {
		protocol.unhandle("https");
		setModel(undefined);
	}
}
