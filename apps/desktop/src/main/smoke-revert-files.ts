import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";
import { clickRealIn, lastOf } from "./smoke-kit.ts";

/**
 * 撤回时连文件一起退回，经真界面走一遍：让假模型在项目里新建一个文件，撤回那一问时确认框列出这个文件，选「撤回对话和文件」，
 * 文件删掉、那句话回到输入框。再发一次、在磁盘上改掉那个文件，撤回时它标成「之后被改过」，只剩「只撤回对话」，选了对话截掉、
 * 人改过的文件原样留着。
 */
export async function checkRevertFiles(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
	/** 会话的工作目录：假模型写的文件落在这里。 */
	cwd: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel, cwd } = options;
	const chat = "[data-screen=chat]";
	const name = "revert-smoke.txt";
	const path = join(cwd, name);
	const content = () =>
		readFile(path, "utf8").then(
			(text) => text,
			() => null,
		);
	const composerText = `[...document.querySelectorAll('.cm-content .cm-line')].map((line) => { const copy = line.cloneNode(true); copy.querySelectorAll('.cm-placeholder').forEach((node) => node.remove()); return copy.textContent; }).join('\\n')`;
	const dialog = `document.querySelector('[role=dialog]')`;
	setModel((request) =>
		JSON.stringify(request.messages).includes("toolu_revert_write")
			? { text: "写好了。" }
			: { toolCalls: [{ id: "toolu_revert_write", name: "write", args: { path: name, content: "smoke\n" } }] },
	);
	const ask = async () => {
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "写文件的问题可以发送");
		await click("[data-composer-send=send]");
		await until(
			`document.querySelector('${chat}')?.textContent.includes('写好了。') && document.querySelector('[data-composer-send=send]') !== null`,
			"假模型写好了文件",
		);
		if ((await content()) !== "smoke\n") throw new Error(`假模型应该写出 ${path}`);
		// 交付卡出来时有一段展开的过渡，等它停下再点：不然算好的坐标点下去时，按钮已经被挤走了。
		await until(`document.querySelector('${chat}')?.textContent.includes('已编辑 1 个文件')`, "交付卡出现");
		await new Promise((resolve) => setTimeout(resolve, 800));
	};
	try {
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText("写一个文件");
		await ask();

		// 能安全退回：列出文件和增删行数，主按钮是连文件一起撤。
		await clickRealIn(window, lastOf(`${chat} [data-message-undo]`), "最后一条消息的撤回");
		await until(`${dialog}?.querySelector('[data-revert-file]')?.textContent.includes(${JSON.stringify(name)})`, "撤回先列出要退回的文件");
		await capture(window, join(outDir, "smoke-revert-files.png"));
		await click("[role=dialog] button", "撤回对话和文件");
		await until(
			`${dialog} === null && !document.querySelector('${chat}')?.textContent.includes('写好了。') && ${composerText} === '写一个文件'`,
			"对话撤回，问题回到输入框",
		);
		if ((await content()) !== null) throw new Error("连文件一起撤回以后，新建的文件应该删掉");

		// 之后被人改过：标出来，只能撤回对话，人改过的文件不动。
		await ask();
		await writeFile(path, "人改过\n");
		await clickRealIn(window, lastOf(`${chat} [data-message-undo]`), "最后一条消息的撤回");
		await until(`${dialog}?.querySelector('[data-revert-file]')?.textContent.includes('之后被改过')`, "被改过的文件标出来");
		if (await page(`[...${dialog}.querySelectorAll('button')].some((button) => button.textContent.trim() === '撤回对话和文件')`))
			throw new Error("有文件不能安全退回时不应该给「撤回对话和文件」");
		await capture(window, join(outDir, "smoke-revert-files-blocked.png"));
		await click("[role=dialog] button", "只撤回对话");
		await until(`${dialog} === null && !document.querySelector('${chat}')?.textContent.includes('写好了。')`, "只撤回了对话");
		if ((await content()) !== "人改过\n") throw new Error("只撤回对话时，人改过的文件应该原样留着");
	} finally {
		setModel(undefined);
	}
}
