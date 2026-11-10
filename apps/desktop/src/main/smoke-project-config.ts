import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";

/** 只在冒烟工作目录临时写项目配置，经真实设置页验证覆盖项与拒绝项，结束后恢复。 */
export async function checkProjectConfig({
	window,
	workspace,
	outDir,
	page,
	until,
	click,
	capture,
}: {
	window: BrowserWindow;
	workspace: string;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	capture(window: BrowserWindow, path: string): Promise<void>;
}): Promise<void> {
	const directory = join(workspace, ".plume");
	const file = join(directory, "config.json");
	const previous = await readFile(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	const globalMode = await page(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip`);
	const projectMode = globalMode === "full" ? "ask" : "full";
	await mkdir(directory, { recursive: true });
	await writeFile(file, JSON.stringify({ permissionMode: projectMode, providers: [], magpie: {} }));
	const card = `([...document.querySelectorAll('[data-project-layer]')].find(element => element.textContent.includes(${JSON.stringify(file)})))`;
	try {
		window.webContents.send("plume:command", "settings");
		await until(`document.querySelector('[data-screen=settings]') !== null`, "打开设置验证项目配置");
		await click("[aria-label=设置章节] button", "常规");
		await until(
			`${card}?.querySelector('[data-project-layer-key="permissionMode"]')?.textContent.includes(${JSON.stringify(projectMode)}) === true`,
			"常规设置显示项目权限覆盖值",
		);
		await until(
			`${card}?.querySelector('[data-project-layer-refused="providers"]') !== null && ${card}?.querySelector('[data-project-layer-refused="magpie"]') !== null`,
			"项目配置拒绝供应商和网关字段",
		);
		if (!(await page(`${card}.textContent.includes('不生效') && ${card}.textContent.includes('已被忽略')`)))
			throw new Error("项目配置卡需要明确说出全局值不生效、禁止字段被忽略");
		await page(`${card}.scrollIntoView({ block: 'center' })`);
		await capture(window, join(outDir, "smoke-project-config.png"));
	} finally {
		if (previous === null) await rm(file, { force: true });
		else await writeFile(file, previous);
		if (await page(`document.querySelector('[data-screen=settings]') !== null`)) await click("button", "返回工作区");
	}
	console.log("PLUME_PROJECT_CONFIG_SMOKE", JSON.stringify({ overrides: true, refused: true, restored: true }));
}
