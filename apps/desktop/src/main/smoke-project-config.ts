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
	// 仓库里的配置只能收紧权限：本机不是完全访问时写一档完全访问，看它被当成放宽权限不认；本机已是完全访问时写请求批准，看它照常覆盖。
	const loosen = globalMode !== "full";
	const projectMode = loosen ? "full" : "ask";
	await mkdir(directory, { recursive: true });
	await writeFile(file, JSON.stringify({ permissionMode: projectMode, alwaysAllow: [{ subject: "read:/" }], providers: [], magpie: {} }));
	const card = `([...document.querySelectorAll('[data-project-layer]')].find(element => element.textContent.includes(${JSON.stringify(file)})))`;
	try {
		window.webContents.send("plume:command", "settings");
		await until(`document.querySelector('[data-screen=settings]') !== null`, "打开设置验证项目配置");
		await click("[aria-label=设置章节] button", "常规");
		await until(`Boolean(${card}?.querySelector('[data-project-layer-loosened="alwaysAllow"]'))`, "项目配置里的批准名单写明会放宽权限、不认");
		if (loosen) {
			await until(`Boolean(${card}?.querySelector('[data-project-layer-loosened="permissionMode"]'))`, "项目配置里更宽的权限模式写明不认");
			if (await page(`${card}.querySelector('[data-project-layer-key="permissionMode"]') !== null`)) throw new Error("不认的权限模式不该再列成覆盖值");
		} else
			await until(
				`${card}?.querySelector('[data-project-layer-key="permissionMode"]')?.textContent.includes(${JSON.stringify(projectMode)}) === true`,
				"常规设置显示项目收紧的权限覆盖值",
			);
		await until(
			`Boolean(${card}?.querySelector('[data-project-layer-refused="providers"]')) && Boolean(${card}?.querySelector('[data-project-layer-refused="magpie"]'))`,
			"项目配置拒绝供应商和网关字段",
		);
		if (!(await page(`${card}.textContent.includes('会放宽权限') && ${card}.textContent.includes('已被忽略')`)))
			throw new Error("项目配置卡需要明确说出放宽权限的项、禁止字段被忽略");
		await page(`${card}.scrollIntoView({ block: 'center' })`);
		await capture(window, join(outDir, "smoke-project-config.png"));
	} finally {
		if (previous === null) await rm(file, { force: true });
		else await writeFile(file, previous);
		if (await page(`document.querySelector('[data-screen=settings]') !== null`)) await click("button", "返回工作区");
	}
	console.log("PLUME_PROJECT_CONFIG_SMOKE", JSON.stringify({ loosened: true, refused: true, restored: true }));
}
