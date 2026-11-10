import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import type { BrowserWindow } from "electron";
import { checkFileOperations } from "./smoke-file-operations.ts";

/** 使用当前会话的临时工作目录，经文件树打开、改名和预览；不碰用户资料。 */
export async function checkFiles({
	window,
	workspace,
	outDir,
	page: rawPage,
	until,
	click,
	capture,
	checkPlugins,
}: {
	window: BrowserWindow;
	workspace: string;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	capture(window: BrowserWindow, path: string): Promise<void>;
	checkPlugins?(folder: string): Promise<void>;
}): Promise<void> {
	const page = async (code: string) => {
		try {
			return await rawPage(code);
		} catch (cause) {
			throw new Error(`文件预览脚本失败：${code}`, { cause });
		}
	};
	const folder = join(workspace, "preview-fixtures");
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, "note.txt"), "Readonly preview\n");
	const database = new DatabaseSync(join(folder, "sample.sqlite"));
	database.exec(
		"CREATE TABLE inventory (name TEXT, quantity INTEGER); INSERT INTO inventory VALUES ('Preview apples', 12), ('Preview oranges', 7); CREATE TABLE empty (label TEXT)",
	);
	database.close();
	const xml = (text: string) => strToU8(text);
	await writeFile(
		join(folder, "sample.docx"),
		zipSync({
			"[Content_Types].xml": xml(
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
			),
			"_rels/.rels": xml(
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			),
			"word/document.xml": xml(
				'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>Document preview</w:t></w:r></w:p><w:p><w:r><w:t>Word preserves its page, table and text.</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Apples</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
			),
		}),
	);
	await writeFile(
		join(folder, "sample.xlsx"),
		zipSync({
			"[Content_Types].xml": xml(
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
			),
			"_rels/.rels": xml(
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
			),
			"xl/workbook.xml": xml(
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stock" sheetId="1" r:id="rId1"/></sheets></workbook>',
			),
			"xl/_rels/workbook.xml.rels": xml(
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
			),
			"xl/worksheets/sheet1.xml": xml(
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Workbook apples</t></is></c><c r="B1"><v>12</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Oranges</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>',
			),
		}),
	);
	const pick = async (selector: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)}) !== null`, `文件入口 ${selector}`);
		await click(selector);
	};
	await click("[data-panel-toggle] button");
	await click('[data-panel-launch="plume/files"]');
	const shown = "[data-panel]:not([inert])";
	const row = (name: string) => `${shown} [data-file-tree] [data-path=${JSON.stringify(join(folder, name))}]`;
	await pick(`${shown} [data-file-tree] [data-path=${JSON.stringify(folder)}]`);
	await until(`document.querySelector(${JSON.stringify(row("sample.docx"))}) !== null`, "文件树展开子目录");
	await capture(window, join(outDir, "smoke-files-tree.png"));
	await pick(row("note.txt"));
	await until(`document.querySelector('${shown} .file-code .cm-content')?.getAttribute('contenteditable') === 'false'`, "代码预览保持只读");
	await click(`${shown} button[aria-label="项目文件"]`);
	const dropdown = '[role=group][aria-label="项目文件"]';
	if (!(await page(`document.querySelector('${dropdown} [data-path=${JSON.stringify(folder)}]')?.getAttribute('aria-expanded') === 'true'`)))
		await pick(`${dropdown} [data-path=${JSON.stringify(folder)}]`);
	const note = `${dropdown} [data-path=${JSON.stringify(join(folder, "note.txt"))}]`;
	await until(`document.querySelector(${JSON.stringify(note)}) !== null`, "下拉树读取文件");
	await page(
		`(() => { const row = document.querySelector(${JSON.stringify(note)}); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX:r.left+40, clientY:r.top+12 })); })()`,
	);
	await click("[role=menuitem]:not(:disabled) > .min-w-0", "重命名");
	await until(`document.querySelector('${dropdown} .plume-name-input') !== null`, "改名输入框");
	await page(`(() => { const input = document.querySelector('${dropdown} .plume-name-input'); input.focus(); input.select(); })()`);
	await window.webContents.insertText("renamed.txt");
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
	await until(
		`document.querySelector('${shown}')?.textContent.includes('renamed.txt') && !document.querySelector('${dropdown} .plume-name-input')`,
		"改名后打开的文件跟随新路径",
	);
	if ((await readFile(join(folder, "renamed.txt"), "utf8")) !== "Readonly preview\n") throw new Error("改名改变了文件内容");
	window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
	window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
	const open = async (name: string) => {
		await click('[data-panel-tab="plume/files"] [role=tab]');
		await page(
			`(() => { const tree = document.querySelector('${shown} [data-file-tree] [role=tree]'); const r = tree.getBoundingClientRect(); tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 12 })); })()`,
		);
		await click("[role=menuitem]:not(:disabled) > .min-w-0", "刷新");
		const expanded = await page(`document.querySelector('${shown} [data-path=${JSON.stringify(folder)}]')?.getAttribute('aria-expanded') === 'true'`);
		if (!expanded) await pick(`${shown} [data-path=${JSON.stringify(folder)}]`);
		await pick(row(name));
	};
	await checkFileOperations({ window, folder, outDir, page, until, click, capture });
	await open("sample.sqlite");
	await until(`document.querySelector('${shown} [data-document-sheet]')?.textContent.includes('inventory')`, "SQLite 通过统一插件展示表格");
	await click(`${shown} .documents-tabs button`, "inventory");
	await until(`document.querySelector('${shown} [data-document-sheet]')?.textContent.includes('Preview apples')`, "数据库单元格可读");
	await capture(window, join(outDir, "smoke-files-sqlite.png"));
	await open("sample.xlsx");
	await until(`document.querySelector('${shown} [data-document-sheet]')?.textContent.includes('Workbook apples')`, "Excel 展示网格而非 Markdown");
	await capture(window, join(outDir, "smoke-files-sheet-light.png"));
	await page(`window.plume.saveAppearance({ theme: 'dark' })`);
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "文档预览切深色");
	await capture(window, join(outDir, "smoke-files-sheet-dark.png"));
	await open("sample.docx");
	await until(`document.querySelector('${shown} [data-document-word]')?.srcdoc.includes('Word preserves')`, "Word 页式排版生成");
	if (!(await page(`document.querySelector('${shown} [data-document-word]').getAttribute('sandbox') === ''`))) throw new Error("Word 预览必须隔离脚本");
	const wordPainted = () => until(`document.querySelector('${shown} [data-document-word][data-document-ready]') !== null`, "隔离 Word 页面已加载");
	await wordPainted();
	await capture(window, join(outDir, "smoke-files-word-dark.png"));
	await page(`window.plume.saveAppearance({ theme: 'light' })`);
	await until(`matchMedia('(prefers-color-scheme: light)').matches`, "文档预览切浅色");
	await wordPainted();
	await capture(window, join(outDir, "smoke-files-word-light.png"));
	await click('[data-panel-area] button[aria-label="全屏"]');
	await wordPainted();
	await capture(window, join(outDir, "smoke-files-word-full.png"));
	await click('[data-panel-area] button[aria-label="退出全屏"]');
	const size = window.getContentSize();
	window.setContentSize(640, 480);
	await wordPainted();
	await capture(window, join(outDir, "smoke-files-word-compact.png"));
	window.setContentSize(size[0]!, size[1]!);
	await page(`document.querySelectorAll('[data-panel-tab] button[aria-label^="关闭"]').forEach(button => button.click())`);
	await until(`document.querySelector('[data-panel-area]')?.inert === true`, "关闭文档测试标签");
	await checkPlugins?.(folder);
	await rm(folder, { recursive: true, force: true });
	console.log(
		"PLUME_FILES_SMOKE",
		JSON.stringify({ tree: true, rename: true, readOnly: true, sqlite: true, workbook: true, word: true, themes: ["light", "dark"] }),
	);
}
