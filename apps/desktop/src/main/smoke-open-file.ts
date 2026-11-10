import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { clipboard, shell, type BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";

/**
 * 真实应用里点开回复中的文件：文件签（带行号的停在那一行、亮一下）、悬停出口条（点「在访达中显示」）、右键菜单（「复制相对路径」）、
 * 同名的几份让人挑、文件面板里 ⌘F 的查找框，以及图片、PDF、音频、视频在文件面板里显示出来。
 *
 * 只替换系统出口（剪贴板、访达），不改用户剪贴板、不弹访达窗口；图片、PDF、视频都由应用自己当场做出来，仓库里不放二进制样本。
 */
export async function checkOpenFile(options: {
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
			if (Date.now() > end) throw new Error(`打开文件验证超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const waitMain = async (test: () => boolean, label: string) => {
		const end = Date.now() + 15_000;
		while (!test()) {
			if (Date.now() > end) throw new Error(`打开文件验证超时：${label}`);
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
	const press = (keyCode: string, modifiers: Array<"meta" | "control"> = []) => {
		window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
	};
	/** 回复里文件名是 `name` 的那枚签。 */
	const chip = (name: string) =>
		`[...document.querySelectorAll('[data-screen=chat] [data-file-link]')].find((link) => link.querySelector('[data-file-name]')?.textContent === ${JSON.stringify(name)})`;
	const panel = `document.querySelector('[data-panel="plume/file"]:not([inert])')`;
	const closeFileTabs = () => page(`document.querySelectorAll('[data-panel-tab] button[aria-label^="关闭"]').forEach(button => button.click())`);

	setModel(() => ({ text: "打开文件准备好了。" }));
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
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "空白对话");
		await send("准备打开文件");
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('打开文件准备好了。')`, "创建会话");
		const session = (await agent.sessions()).find((item) => !previous.has(item.id));
		assert.ok(session, "开出了打开文件的会话");

		// 找同名文件按 git 的清单、认 .gitignore；冒烟目录默认在仓库的 .smoke/ 里，整个被忽略，就什么都找不到。
		// 工作目录自己做成仓库（已经是的重新初始化一下，不碰已有的提交）。
		await promisify(execFile)("git", ["init", "-q"], { cwd: session.cwd });
		// 样本都放在会话工作目录下自己的子目录里，同名的两份只在这里。
		const root = join(session.cwd, "open-file");
		const app = join(root, "src", "app.ts");
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(
			app,
			Array.from({ length: 60 }, (_, index) => `export const line${index + 1} = ${index + 1};${index === 44 ? " // needle" : ""}`).join("\n"),
		);
		for (const side of ["a", "b"]) {
			await mkdir(join(root, side), { recursive: true });
			await writeFile(join(root, side, "smoke-twin.ts"), `export const where = "${side}";\n`);
		}
		const media = join(root, "media");
		await mkdir(media, { recursive: true });
		await writeFile(join(media, "pic.png"), (await window.webContents.capturePage()).resize({ width: 320 }).toPNG());
		await writeFile(join(media, "doc.pdf"), await window.webContents.printToPDF({}));
		await writeFile(join(media, "sound.wav"), tone());
		// 视频由页面自己录一段：画布黑白交替（默认的填充色和清空），MediaRecorder 录成 WebM。
		const video = await page<string>(`(async () => {
			const canvas = document.createElement('canvas');
			canvas.width = 160;
			canvas.height = 90;
			const context = canvas.getContext('2d');
			let frame = 0;
			const paint = () => (frame++ % 2 ? context.clearRect(0, 0, 160, 90) : context.fillRect(0, 0, 160, 90));
			paint();
			const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' });
			const chunks = [];
			recorder.ondataavailable = (event) => chunks.push(event.data);
			const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
			const timer = setInterval(paint, 60);
			recorder.start();
			await new Promise((resolve) => setTimeout(resolve, 800));
			recorder.stop();
			await stopped;
			clearInterval(timer);
			const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
			let binary = '';
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return btoa(binary);
		})()`);
		await writeFile(join(media, "clip.webm"), Buffer.from(video, "base64"));

		setModel(() => ({
			text: [
				"看这几个文件：",
				"",
				"- [app.ts](open-file/src/app.ts:30)",
				"- [smoke-twin.ts](smoke-twin.ts)",
				"- [pic.png](open-file/media/pic.png)",
				"- [doc.pdf](open-file/media/doc.pdf)",
				"- [sound.wav](open-file/media/sound.wav)",
				"- [clip.webm](open-file/media/clip.webm)",
			].join("\n"),
		}));
		await send("给我看看这些文件");
		await until(`Boolean(${chip("clip.webm")})`, "回复里画出文件签");
		await until(`${chip("app.ts")}?.querySelector('[data-file-line]')?.textContent === ':30'`, "文件签带着行号");

		// 点带行号的签：文件面板打开它，停在第 30 行并亮一下。
		await page(`${chip("app.ts")}.querySelector('a').click()`);
		await until(
			`(() => {
				const lit = ${panel}?.querySelector('.cm-file-reveal');
				if (!lit?.textContent.includes('line30 = 30')) return false;
				const box = lit.getBoundingClientRect(), view = ${panel}.querySelector('.cm-scroller').getBoundingClientRect();
				return box.top >= view.top && box.bottom <= view.bottom;
			})()`,
			"带行号的签打开文件并停在那一行",
		);
		await capture("smoke-open-file-line.png");

		// 悬停：签上方浮出出口条，点「在访达中显示」交给系统。
		const point = await page<{ x: number; y: number }>(
			`(() => { const box = ${chip("app.ts")}.querySelector('a').getBoundingClientRect(); return { x: Math.round(box.left + 8), y: Math.round(box.top + box.height / 2) }; })()`,
		);
		window.webContents.sendInputEvent({ type: "mouseMove", ...point });
		await until(
			`(() => { const bar = ${chip("app.ts")}.querySelector('[data-file-actions]'); const style = bar && getComputedStyle(bar); return style?.visibility === 'visible' && style.opacity === '1'; })()`,
			"悬停浮出出口条",
		);
		await capture("smoke-open-file-hover.png");
		const revealLabel = process.platform === "darwin" ? "在访达中显示" : process.platform === "win32" ? "在资源管理器中显示" : "在文件管理器中显示";
		await page(`${chip("app.ts")}.querySelector('[data-file-actions] button[aria-label=${JSON.stringify(revealLabel)}]').click()`);
		await waitMain(() => revealed === app, "出口条的「在访达中显示」定位到这个文件");
		window.webContents.sendInputEvent({ type: "mouseMove", x: 0, y: 0 });

		// 右键：菜单里有打开、打开方式、在访达中显示、复制路径和复制相对路径。
		await page(
			`(() => { const link = ${chip("app.ts")}.querySelector('a'); const box = link.getBoundingClientRect(); link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.bottom - 2 })); })()`,
		);
		const menuItems = `[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((item) => item.textContent.trim())`;
		await until(`${menuItems}.includes('复制相对路径')`, "右键菜单出现");
		const items = await page<string[]>(menuItems);
		for (const label of ["打开", "打开方式", revealLabel, "复制路径", "复制相对路径"])
			assert.ok(items.includes(label), `右键菜单缺「${label}」：${JSON.stringify(items)}`);
		await capture("smoke-open-file-menu.png");
		await page(`[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((item) => item.textContent.trim() === '复制相对路径').click()`);
		await waitMain(() => copied === join("open-file", "src", "app.ts"), "复制的是相对工作目录的路径");
		await until(`document.querySelector('[role=menu]') === null`, "点了菜单项菜单收起");

		// ⌘F：文件面板里的代码视图弹出查找框，敲词找到匹配，Esc 收起。
		await page(`${panel}.querySelector('.cm-content').focus()`);
		press("F", [process.platform === "darwin" ? "meta" : "control"]);
		await until(`${panel}?.querySelector('.cm-panel.cm-search[data-plume-labelled]') !== null && document.activeElement?.name === 'search'`, "⌘F 弹出查找框");
		await window.webContents.insertText("needle");
		press("Return");
		await until(`${panel}.querySelector('.cm-searchMatch')?.textContent === 'needle'`, "查找框找到匹配");
		await capture("smoke-open-file-search.png");
		press("Escape");
		await until(`${panel}.querySelector('.cm-panel.cm-search') === null`, "Esc 收起查找框");

		// 同名的两份：签不猜是哪一个，点了列出来让人挑，挑 b 那份就开它。
		await until(`${chip("smoke-twin.ts")} && !${chip("smoke-twin.ts")}.querySelector('[data-file-actions]')`, "找到两份同名文件");
		await page(`${chip("smoke-twin.ts")}.querySelector('a').click()`);
		const choices = `[role=menu][aria-label="项目里有 2 个同名文件"]`;
		await until(`document.querySelectorAll(${JSON.stringify(`${choices} [role=menuitem]`)}).length === 2`, "同名候选列出两份");
		await capture("smoke-open-file-choices.png");
		await page(`[...document.querySelectorAll(${JSON.stringify(`${choices} [role=menuitem]`)})].find((item) => item.textContent.trim().endsWith('b')).click()`);
		await until(`${panel}?.textContent.includes('export const where = "b"')`, "挑了 b 那份，面板打开它");
		await closeFileTabs();

		// 图片、PDF、音视频：都经 plume-media 协议取，在面板里显示出来。
		await page(`${chip("pic.png")}.querySelector('a').click()`);
		await until(`${panel}?.querySelector('img')?.naturalWidth === 320`, "图片在面板里显示");
		await capture("smoke-open-file-image.png");
		await page(`${chip("doc.pdf")}.querySelector('a').click()`);
		await until(`${panel}?.querySelector('embed[type="application/pdf"]') !== null`, "PDF 交给阅读器");
		const pdf = await page<{ ok: boolean; type: string | null; head: string }>(
			`fetch(${panel}.querySelector('embed').src).then(async (response) => ({ ok: response.ok, type: response.headers.get('content-type'), head: new TextDecoder().decode((await response.arrayBuffer()).slice(0, 5)) }))`,
		);
		assert.deepEqual(pdf, { ok: true, type: "application/pdf", head: "%PDF-" }, "PDF 经媒体协议取到");
		await capture("smoke-open-file-pdf.png");
		await page(`${chip("sound.wav")}.querySelector('a').click()`);
		await until(`(() => { const audio = ${panel}?.querySelector('audio'); return audio?.readyState >= 1 && audio.duration > 0.4; })()`, "音频读出时长");
		await page(`${chip("clip.webm")}.querySelector('a').click()`);
		await until(`(() => { const video = ${panel}?.querySelector('video'); return video?.readyState >= 1 && video.videoWidth === 160; })()`, "视频读出画面尺寸");
		await capture("smoke-open-file-video.png");
		await closeFileTabs();
		console.log(
			"PLUME_OPEN_FILE_SMOKE",
			JSON.stringify({ line: true, hover: true, menu: true, choices: true, search: true, image: true, pdf: true, audio: true, video: true }),
		);
	} finally {
		clipboard.writeText = originalCopy;
		shell.showItemInFolder = originalReveal;
		setModel(undefined);
	}
}

/** 半秒 440Hz 的 16 位单声道 WAV。 */
function tone(): Buffer {
	const rate = 8000;
	const samples = rate / 2;
	const wav = Buffer.alloc(44 + samples * 2);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + samples * 2, 4);
	wav.write("WAVE", 8);
	wav.write("fmt ", 12);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(samples * 2, 40);
	for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
	return wav;
}
