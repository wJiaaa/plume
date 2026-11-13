import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { contextMenuVisible } from "./smoke-kit.ts";

/** 只操作 smoke 的临时 fixture；菜单、键盘和拖放都经真实渲染进程。 */
export async function checkFileOperations({
	window,
	folder,
	outDir,
	page,
	until,
	click,
	capture,
}: {
	window: BrowserWindow;
	folder: string;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	capture(window: BrowserWindow, path: string): Promise<void>;
}) {
	const shown = "[data-panel]:not([inert])";
	const tree = `${shown} [data-file-tree]`;
	const row = (path: string) => `${tree} [data-path=${JSON.stringify(path)}]`;
	const selectTree = () => click('[data-panel-tab="plume/files"] [role=tab]');
	const menu = async (path: string | null, item: string) => {
		const selector = path ? row(path) : `${tree} [role=tree]`;
		await contextMenuVisible(page, selector);
		await click("[role=menuitem]:not(:disabled) > .min-w-0", item);
	};
	const exists = async (path: string) => {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	};
	const rowExists = (path: string) => until(`document.querySelector(${JSON.stringify(row(path))}) !== null`, `文件树出现 ${path}`);
	const typeName = async (name: string) => {
		const selector = `${tree} .plume-name-input`;
		await until(`document.querySelector(${JSON.stringify(selector)}) !== null`, "新建名称输入框");
		await page(`document.querySelector(${JSON.stringify(selector)}).focus()`);
		await window.webContents.insertText(name);
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
		await until(`document.querySelector(${JSON.stringify(selector)}) === null`, "名称输入已提交");
	};
	await selectTree();
	await menu(folder, "新建文件夹");
	await typeName("operations");
	const target = join(folder, "operations");
	await rowExists(target);
	await menu(target, "新建文件");
	await typeName("created.txt");
	await until(`document.querySelector('${shown} .file-code .cm-content')?.getAttribute('contenteditable') === 'false'`, "新文件预览仍只读");
	await selectTree();
	const created = join(target, "created.txt");
	await rowExists(created);
	await writeFile(created, "file operation fixture");
	await menu(created, "创建副本");
	const duplicate = join(target, "created copy.txt");
	await rowExists(duplicate);
	if ((await readFile(duplicate, "utf8")) !== "file operation fixture") throw new Error("文件副本内容不一致");
	await menu(duplicate, "剪切");
	await menu(folder, "粘贴");
	const moved = join(folder, "created copy.txt");
	await rowExists(moved);
	if (await exists(duplicate)) throw new Error("剪切粘贴没有移动原文件");
	await menu(moved, "复制");
	await menu(target, "粘贴");
	await rowExists(duplicate);
	await menu(moved, "复制");
	await menu(target, "粘贴");
	await until(`document.querySelector('[role=dialog]')?.textContent.includes('已存在')`, "同名粘贴出现替换确认");
	await click("[role=dialog] button", "取消");
	await until(`document.querySelector('[role=dialog]') === null`, "取消同名覆盖");
	if ((await readFile(duplicate, "utf8")) !== "file operation fixture") throw new Error("取消替换修改了目标");
	await menu(moved, "删除");
	await until(`document.querySelector('[role=dialog]')?.textContent.includes('删除')`, "删除文件必须确认");
	await click("[role=dialog] button", "取消");
	await until(`document.querySelector('[role=dialog]') === null`, "取消删除");
	if (!(await exists(moved))) throw new Error("取消删除却丢失文件");
	await menu(moved, "永久删除");
	await until(`document.querySelector('[role=dialog]')?.textContent.includes('无法恢复')`, "永久删除清楚说明后果");
	await click("[role=dialog] button", "永久删除");
	await until(`document.querySelector(${JSON.stringify(row(moved))}) === null`, "永久删除刷新文件树");
	if (await exists(moved)) throw new Error("永久删除未删除临时文件");

	const dragSource = join(folder, "drag.txt");
	await writeFile(dragSource, "drag fixture");
	await mkdir(join(target, "nested"));
	await menu(folder, "刷新");
	await rowExists(dragSource);
	await page(
		`(() => { window.__fileDrag = new DataTransfer(); document.querySelector(${JSON.stringify(row(dragSource))}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__fileDrag })); })()`,
	);
	await page(
		`(() => { const target = document.querySelector(${JSON.stringify(row(target))}); target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__fileDrag })); target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__fileDrag })); document.querySelector(${JSON.stringify(row(dragSource))})?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__fileDrag })); delete window.__fileDrag; })()`,
	);
	await rowExists(join(target, "drag.txt"));
	if (await exists(dragSource)) throw new Error("文件树拖放没有移动源文件");
	await menu(target, "在此文件夹中搜索");
	await until(
		`document.querySelector(${JSON.stringify(tree)})?.textContent.includes('created.txt') && !document.querySelector(${JSON.stringify(row(join(folder, "sample.docx")))})`,
		"只看选中的文件夹",
	);
	await capture(window, join(outDir, "smoke-file-operations.png"));
	await click(`${tree} button[aria-label="只看 operations"]`);
	console.log(
		"PLUME_FILE_OPERATIONS_SMOKE",
		JSON.stringify({
			create: true,
			duplicate: true,
			clipboard: true,
			replaceConfirm: true,
			removeConfirm: true,
			permanentRemove: true,
			dragMove: true,
			scope: true,
		}),
	);
}
