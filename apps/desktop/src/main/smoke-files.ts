import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import type { BrowserWindow } from "electron";
import { checkFileOperations } from "./smoke-file-operations.ts";
import { clickEachVisible, contextMenuVisible } from "./smoke-kit.ts";

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
	await writeFile(join(folder, "sample.key"), new Uint8Array([0, 1, 2, 3, 0, 255]));
	// 两页的演示文稿：第一页带一条外链，看链接画成 <a> 但不被直接打开；第二页看滚到附近才画。
	const ns =
		'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
	const rel = (type: string, target: string, id = "rId1", external = false) =>
		`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
	const rels = (...items: string[]) =>
		xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`);
	const tree = (shapes = "") => `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree>`;
	const box = (id: number, y: number, paragraphs: string) =>
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="${y}"/><a:ext cx="10363200" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
	const run = (text: string, size: number, extra = "") => `<a:p><a:r><a:rPr lang="en-US" sz="${size}">${extra}</a:rPr><a:t>${text}</a:t></a:r></a:p>`;
	const scheme = (name: string, value: string) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
	const three = (item: string) => item.repeat(3);
	const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	const part = (path: string, type: string) => `<Override PartName="/ppt/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
	await writeFile(
		join(folder, "sample.pptx"),
		zipSync({
			"[Content_Types].xml": xml(
				`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${part("presentation.xml", "presentationml.presentation.main")}${part("slides/slide1.xml", "presentationml.slide")}${part("slides/slide2.xml", "presentationml.slide")}${part("slideLayouts/slideLayout1.xml", "presentationml.slideLayout")}${part("slideMasters/slideMaster1.xml", "presentationml.slideMaster")}${part("theme/theme1.xml", "theme")}</Types>`,
			),
			"_rels/.rels": rels(rel("officeDocument", "ppt/presentation.xml")),
			"ppt/presentation.xml": xml(
				`<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": rels(
				rel("slideMaster", "slideMasters/slideMaster1.xml"),
				rel("slide", "slides/slide1.xml", "rId2"),
				rel("slide", "slides/slide2.xml", "rId3"),
				rel("theme", "theme/theme1.xml", "rId4"),
			),
			"ppt/slides/slide1.xml": xml(
				`<p:sld ${ns}><p:cSld>${tree(box(2, 914400, run("Slide preview", 4000) + run("Linked text", 2000, '<a:hlinkClick r:id="rId2"/>')))}</p:cSld></p:sld>`,
			),
			"ppt/slides/_rels/slide1.xml.rels": rels(rel("slideLayout", "../slideLayouts/slideLayout1.xml"), rel("hyperlink", "https://example.com/", "rId2", true)),
			"ppt/slides/slide2.xml": xml(`<p:sld ${ns}><p:cSld>${tree(box(2, 2743200, run("Second slide", 3600)))}</p:cSld></p:sld>`),
			"ppt/slides/_rels/slide2.xml.rels": rels(rel("slideLayout", "../slideLayouts/slideLayout1.xml")),
			"ppt/slideLayouts/slideLayout1.xml": xml(`<p:sldLayout ${ns} type="blank"><p:cSld name="Blank">${tree()}</p:cSld></p:sldLayout>`),
			"ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels(rel("slideMaster", "../slideMasters/slideMaster1.xml")),
			"ppt/slideMasters/slideMaster1.xml": xml(
				`<p:sldMaster ${ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${tree()}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
			),
			"ppt/slideMasters/_rels/slideMaster1.xml.rels": rels(rel("slideLayout", "../slideLayouts/slideLayout1.xml"), rel("theme", "../theme/theme1.xml", "rId2")),
			"ppt/theme/theme1.xml": xml(
				`<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Smoke"><a:themeElements><a:clrScheme name="Smoke">${scheme("dk1", "000000")}${scheme("lt1", "FFFFFF")}${scheme("dk2", "1F2937")}${scheme("lt2", "F3F4F6")}${["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((name) => scheme(name, "2563EB")).join("")}${scheme("hlink", "2563EB")}${scheme("folHlink", "7C3AED")}</a:clrScheme><a:fontScheme name="Smoke"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Smoke"><a:fillStyleLst>${three(solid)}</a:fillStyleLst><a:lnStyleLst>${three(`<a:ln w="6350">${solid}</a:ln>`)}</a:lnStyleLst><a:effectStyleLst>${three("<a:effectStyle><a:effectLst/></a:effectStyle>")}</a:effectStyleLst><a:bgFillStyleLst>${three(solid)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
			),
		}),
	);
	await click("[data-panel-toggle] button");
	await click('[data-panel-launch="plume/files"]');
	const shown = "[data-panel]:not([inert])";
	const row = (name: string) => `${shown} [data-file-tree] [data-path=${JSON.stringify(join(folder, name))}]`;
	await click(`${shown} [data-file-tree] [data-path=${JSON.stringify(folder)}]`);
	await until(`document.querySelector(${JSON.stringify(row("sample.docx"))}) !== null`, "文件树展开子目录");
	await capture(window, join(outDir, "smoke-files-tree.png"));
	await click(row("note.txt"));
	await until(`document.querySelector('${shown} .file-code .cm-content')?.getAttribute('contenteditable') === 'false'`, "代码预览保持只读");
	await click(`${shown} button[aria-label="项目文件"]`);
	const dropdown = '[role=group][aria-label="项目文件"]';
	if (!(await page(`document.querySelector('${dropdown} [data-path=${JSON.stringify(folder)}]')?.getAttribute('aria-expanded') === 'true'`)))
		await click(`${dropdown} [data-path=${JSON.stringify(folder)}]`);
	const note = `${dropdown} [data-path=${JSON.stringify(join(folder, "note.txt"))}]`;
	await until(`document.querySelector(${JSON.stringify(note)}) !== null`, "下拉树读取文件");
	await contextMenuVisible(page, note);
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
		await contextMenuVisible(page, `${shown} [data-file-tree] [role=tree]`);
		await click("[role=menuitem]:not(:disabled) > .min-w-0", "刷新");
		const expanded = await page(`document.querySelector('${shown} [data-path=${JSON.stringify(folder)}]')?.getAttribute('aria-expanded') === 'true'`);
		if (!expanded) await click(`${shown} [data-path=${JSON.stringify(folder)}]`);
		await click(row(name));
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
	await open("sample.pptx");
	const slide = (n: number) => `${shown} [data-document-slides] [data-document-slide="${n}"]`;
	await until(`document.querySelector('${slide(1)}')?.textContent.includes('Slide preview')`, "演示文稿第一页画出");
	if (!(await page(`document.querySelector('${slide(1)} a')?.getAttribute('href') === 'https://example.com/'`))) throw new Error("演示文稿的文字链接没画出来");
	await capture(window, join(outDir, "smoke-files-slides-light.png"));
	await page(`document.querySelector('${slide(2)}').scrollIntoView()`);
	await until(`document.querySelector('${slide(2)}')?.textContent.includes('Second slide')`, "演示文稿第二页滚到附近才画");
	await page(`window.plume.saveAppearance({ theme: 'dark' })`);
	await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "演示文稿切深色");
	await capture(window, join(outDir, "smoke-files-slides-dark.png"));
	await page(`window.plume.saveAppearance({ theme: 'light' })`);
	await until(`matchMedia('(prefers-color-scheme: light)').matches`, "演示文稿切浅色");
	await open("sample.key");
	await until(
		`document.querySelector('${shown}')?.textContent.includes('二进制文件') && [...document.querySelectorAll('${shown} button')].some(button => button.textContent.includes('用默认应用打开'))`,
		"预览不了的二进制文件给出默认应用入口",
	);
	await clickEachVisible(page, `[data-panel-tab] button[aria-label^="关闭"]`);
	await until(`document.querySelector('[data-panel-area]')?.inert === true`, "关闭文档测试标签");
	await checkPlugins?.(folder);
	await rm(folder, { recursive: true, force: true });
	console.log(
		"PLUME_FILES_SMOKE",
		JSON.stringify({
			tree: true,
			rename: true,
			readOnly: true,
			sqlite: true,
			workbook: true,
			word: true,
			slides: true,
			binary: true,
			themes: ["light", "dark"],
		}),
	);
}
