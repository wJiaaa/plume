import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { BrowserWindow } from "electron";
import { clickVisible, containing } from "./smoke-kit.ts";

/**
 * 上下文用量里的「记忆文件」点得开会话目录外的文件：工作目录的上一层做成仓库根、放一份 AGENTS.md，plume.prompt 把它整段放进提示词并标出
 * 来源；发一句话，点开上下文用量的圆环、展开「记忆文件」、点那一行，文件面板只读打开它。
 */
export async function checkMemoryFiles(options: {
	window: BrowserWindow;
	workspace: string;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, workspace, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const deadline = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > deadline) throw new Error(`记忆文件验证等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const click = (selector: string, text?: string) => clickVisible(page, selector, text === undefined ? undefined : containing(text));

	// 只是让 plume.prompt 认出仓库根，往上收到这一层：不是真仓库，这一段跑完就退出。
	const root = dirname(workspace);
	const instructions = join(root, "AGENTS.md");
	await mkdir(join(root, ".git"), { recursive: true });
	await writeFile(instructions, "# 上层约定\n\n记忆文件冒烟：这一份在会话目录外。\n");

	setModel(() => ({ text: "记忆文件准备好了。" }));
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("记忆文件：看看上层约定");
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await clickVisible(page, `[data-composer-send=send]`);
		await until(`document.querySelector('[data-screen=chat]')?.textContent.includes('记忆文件准备好了。') === true`, "这一轮答完");
	} finally {
		setModel(undefined);
	}

	await click("[data-screen=chat] [data-plume-context-meter]");
	await click("[data-plume-popover][role=group] button[aria-expanded]", "记忆文件");
	await click("[data-plume-popover][role=group] [data-plume-memory-file]", instructions);
	await until(`document.querySelector('[data-plume-popover][role=group]') === null`, "点了记忆文件，弹层收起");
	await until(`document.querySelector('[data-panel]:not([inert])')?.textContent.includes('这一份在会话目录外') === true`, "文件面板打开会话目录外的 AGENTS.md");
	if (await page(`document.querySelector('[data-plume-toaster]')?.textContent.includes('AGENTS.md') === true`)) throw new Error("不该提示读不到 AGENTS.md");
	// 面板滑出、弹层退场都放完再截图。
	await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
	await page(`Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`);
	await writeFile(join(outDir, "smoke-memory-files.png"), (await window.webContents.capturePage()).toPNG());
}
