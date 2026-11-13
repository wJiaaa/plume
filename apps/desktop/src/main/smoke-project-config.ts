import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { clickVisible } from "./smoke-kit.ts";

/** 权限菜单里各档的名字，按开头找（菜单项里还有一行说明）。 */
const MODE_TITLE: Record<string, RegExp> = { ask: /^请求批准/, auto: /^帮我批准/, full: /^完全访问/ };

/**
 * 只在冒烟工作目录临时写项目配置，结束后恢复：
 * 1. 经真实设置页验证覆盖项与拒绝项，放宽权限的项不认。
 * 2. 项目要求请求批准、本机是帮我批准时，输入框的权限签显示请求批准、说明是项目要求的，菜单顶上写明改的是本机设置。
 */
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
	const chip = `document.querySelector('[data-permission-chip]')`;
	const globalMode = await page(`${chip}?.dataset.permissionChip`);
	if (typeof globalMode !== "string" || !(globalMode in MODE_TITLE)) throw new Error(`输入框上应该有权限签，实际读到 ${String(globalMode)}`);
	if ((await page(`${chip}.dataset.permissionSource`)) !== "local") throw new Error("还没有项目配置时权限签应该按本机设置");
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
		await click("button", "返回工作区");
		await until(`${chip} !== null`, "回到对话");

		// 项目要求请求批准，本机换成更宽的帮我批准（本机已是帮我批准时重选一次）：换档时读过项目配置的会话重新比，权限签跟着变。
		await writeFile(file, JSON.stringify({ permissionMode: "ask" }));
		await clickVisible(page, "[data-permission-chip]");
		await clickVisible(page, "[role=menuitem]", MODE_TITLE.auto);
		await until(
			`${chip}?.dataset.permissionChip === 'ask' && ${chip}.dataset.permissionSource === 'project' && ${chip}.getAttribute('data-plume-tip').includes('.plume/config.json')`,
			"本机帮我批准、项目要求请求批准时，权限签显示请求批准并说明来自项目配置",
		);
		await clickVisible(page, "[data-permission-chip]");
		await until(
			`document.querySelector('[data-permission-project]')?.textContent.includes('.plume/config.json') === true && [...document.querySelectorAll('[role=menuitem][data-selected=true]')].map(item => item.textContent).join().startsWith('帮我批准')`,
			"权限菜单顶上说明项目的要求，勾仍打在本机的帮我批准上",
		);
		await capture(window, join(outDir, "smoke-project-permission.png"));
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
		await until(`document.querySelector('[data-permission-project]') === null`, "关上权限菜单");
	} finally {
		if (previous === null) await rm(file, { force: true });
		else await writeFile(file, previous);
		if (await page(`document.querySelector('[data-screen=settings]') !== null`)) await click("button", "返回工作区");
	}
	// 换回原来那档：本机设置还原，会话也重读还原了的项目配置，权限签回到本机那档。
	await clickVisible(page, "[data-permission-chip]");
	await clickVisible(page, "[role=menuitem]", MODE_TITLE[globalMode]!);
	if (globalMode === "full") await click("button", "确认开启");
	await until(
		`${chip}?.dataset.permissionChip === ${JSON.stringify(globalMode)} && ${chip}.dataset.permissionSource === 'local'`,
		"项目配置还原后权限签回到本机那档",
	);
	console.log("PLUME_PROJECT_CONFIG_SMOKE", JSON.stringify({ loosened: true, refused: true, projectChip: true, restored: true }));
}
