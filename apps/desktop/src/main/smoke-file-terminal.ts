import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { nativeEnter } from "./smoke-message-edits.ts";
import { windowClosed } from "./smoke-panels.ts";
import { clickEachVisible, clickVisible, contextMenuVisible } from "./smoke-kit.ts";

/** 接在面板框架验收后：只操作 smoke 目录和终端，最后留一个正常终端供后续步骤使用。 */
export async function checkFileTerminal(window: BrowserWindow, workspace: string, outDir: string): Promise<void> {
	const panel = '[data-panel="plume.terminal/terminal"]:not([inert])';
	const terminalTab = '[data-panel-tab="plume.terminal/terminal"]';
	const treeTab = '[data-panel-tab="plume/files"]';
	const tree = '[data-panel="plume/files"]:not([inert]) [data-file-tree]';
	const page = <T>(code: string, target = window): Promise<T> => target.webContents.executeJavaScript(code);
	/** 超时时留下现场：截图，以及终端里显示的字、连着哪个 shell、退没退、焦点在哪。 */
	const diagnose = async (label: string, target: BrowserWindow) => {
		const name = `smoke-file-terminal-timeout-${Date.now()}`;
		try {
			await writeFile(join(outDir, `${name}.png`), (await target.webContents.capturePage()).toPNG());
			const state = await page<unknown>(
				`(() => {
					const host = document.querySelector('${panel} [data-terminal-id]');
					const active = document.activeElement;
					return {
						terminalId: host?.dataset.terminalId ?? null,
						terminalReady: host?.dataset.terminalReady ?? null,
						exited: document.querySelector('${panel} .terminal-exited')?.textContent ?? null,
						focus: active ? active.tagName + (active.className && typeof active.className === 'string' ? '.' + active.className.split(' ').join('.') : '') : null,
						rows: [...(document.querySelector('${panel} .xterm-rows')?.children ?? [])].map((row) => row.textContent),
					};
				})()`,
				target,
			);
			await writeFile(join(outDir, `${name}.json`), JSON.stringify({ label, state }, null, 2));
		} catch (error) {
			await writeFile(join(outDir, `${name}.json`), JSON.stringify({ label, error: String(error) }, null, 2)).catch(() => {});
		}
	};
	const wait = async (condition: () => Promise<boolean>, label: string, target = window) => {
		const deadline = Date.now() + 20_000;
		while (!(await condition())) {
			if (Date.now() > deadline) {
				await diagnose(label, target);
				throw new Error(`文件树终端验收超时：${label}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 80));
		}
	};
	const until = (code: string, label: string, target = window) => wait(() => page<boolean>(code, target), label, target);
	const click = (selector: string, text?: string, target = window) => clickVisible((code: string) => page(code, target), selector, text, 20_000);
	const capture = async (name: string, target = window) => {
		await page("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", target);
		await writeFile(join(outDir, name), (await target.webContents.capturePage()).toPNG());
	};
	/*
	 * Windows 上终端插件起的是 PowerShell（`SHELL` 指着一个 Windows 路径的除外），这里打进去的命令按它的语法写；别处是 bash、zsh。
	 * PowerShell 的单引号里只有 `''` 特殊，`$(…)` 是子表达式，`cd` 是别名、要先删掉才能换成记录用的函数。
	 */
	const powershell = process.platform === "win32";
	const quote = (value: string) => (powershell ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`);
	const type = async (command: string, target = window) => {
		await until(`document.querySelector('${panel} [data-terminal-ready="true"] .xterm-helper-textarea') !== null`, "终端回放完成，输入框可用", target);
		await page(`document.querySelector('${panel} .xterm-helper-textarea').focus()`, target);
		await target.webContents.insertText(command);
		nativeEnter(target);
	};
	const output = (text: string, target = window) =>
		until(`document.querySelector('${panel} .xterm-rows')?.textContent.includes(${JSON.stringify(text)}) === true`, `真实 shell 输出 ${text}`, target);
	const cwdIs = async (directory: string, label: string, target = window) => {
		await type(
			powershell ? `Write-Output "PLUME_FILE_TERMINAL_${label}_$(6*7):$($PWD.Path)"` : `printf 'PLUME_FILE_TERMINAL_${label}_%s:%s\\n' "$((6*7))" "$PWD"`,
			target,
		);
		await output(`PLUME_FILE_TERMINAL_${label}_42:${directory}`, target);
	};
	const terminalId = (target = window) => page<string>(`document.querySelector('${panel} [data-terminal-id]').dataset.terminalId`, target);
	const tabId = (target = window) => page<string>(`document.querySelector('${terminalTab}').dataset.panelTabId`, target);
	const countTabs = (target = window) => page<number>(`document.querySelectorAll('${terminalTab}').length`, target);
	const waitForTerminal = (target = window) =>
		until(`Boolean(document.querySelector('${panel} [data-terminal-ready="true"]'))`, "终端已连接 shell 且回放完成", target);
	const folder = await mkdtemp(join(workspace, "file-terminal-"));
	const first = join(folder, "first");
	const quoted = join(folder, "it's [quoted]");
	const reused = join(folder, "reused");
	const changes = join(outDir, "smoke-file-terminal-cd.log");
	await Promise.all([first, quoted, reused].map((path) => mkdir(path)));
	await writeFile(changes, "");
	let detached: BrowserWindow | undefined;
	const openTree = async () => {
		if (await page<boolean>(`document.querySelector('${treeTab}') !== null`)) await click(`${treeTab} [role=tab]`);
		else {
			if (await page<boolean>("document.querySelector('[data-panel-area]')?.inert === true")) await click("[data-panel-toggle] button");
			if (!(await page<boolean>("document.querySelector('[data-panel-launch=\"plume/files\"]') !== null"))) await click("[data-panel-add]");
			await click('[data-panel-launch="plume/files"]');
		}
		await until(`document.querySelector('${tree} [role=tree]') !== null`, "文件树可用");
	};
	const menu = async (selector: string, label: string) => {
		await contextMenuVisible(page, selector, 40, 12, 20_000);
		await click("[role=menuitem]:not(:disabled) > .min-w-0", label);
	};
	const fromTree = async (directory: string) => {
		await openTree();
		const parent = `${tree} [data-path=${JSON.stringify(folder)}]`;
		if (!(await page<boolean>(`document.querySelector(${JSON.stringify(parent)}) !== null`))) await menu(`${tree} [role=tree]`, "刷新");
		await until(`document.querySelector(${JSON.stringify(parent)}) !== null`, "文件树出现验收目录");
		if (!(await page<boolean>(`document.querySelector(${JSON.stringify(parent)})?.getAttribute('aria-expanded') === 'true'`))) await click(parent);
		await menu(`${tree} [data-path=${JSON.stringify(directory)}]`, "在终端中打开");
	};
	// PowerShell 写的是 CRLF，Windows PowerShell 5.1 按 UTF-8 写时还在开头加 BOM。
	const recorded = async () =>
		(await readFile(changes, "utf8"))
			.replace(/^\uFEFF/, "")
			.split(/\r?\n/)
			.filter(Boolean);
	try {
		assert.equal((await page<unknown[]>("window.plume.panelWindows.list()")).length, 0, "先前的面板验收应已收回独立窗口");
		// 首次必须由文件树创建，不能误把已有 shell 当成首次打开成功。
		await clickEachVisible(page, `${terminalTab} button[aria-label^="关闭"]`);
		await until(`document.querySelectorAll('${terminalTab}').length === 0`, "关掉先前验收的终端标签");
		await fromTree(first);
		await waitForTerminal();
		assert.equal(await countTabs(), 1, "文件树首次打开只建一个终端");
		const originalShell = await terminalId();
		const originalTab = await tabId();
		await output(first);
		await cwdIs(first, "first");
		await capture("smoke-file-terminal-first.png");

		// 在真实 shell 里记录 cd 次数；UI 回显或重复绘制不能伪造这份文件。
		await type(
			powershell
				? `Remove-Item Alias:cd -Force -ErrorAction SilentlyContinue; function cd { Set-Location @args; if ($?) { Add-Content -LiteralPath ${quote(changes)} -Value $PWD.Path -Encoding UTF8 } }; Write-Output "PLUME_CD_READY_$(6*7)"`
				: `cd() { builtin cd "$@" && printf '%s\\n' "$PWD" >> ${quote(changes)}; }; echo PLUME_CD_READY_$((6*7))`,
		);
		await output("PLUME_CD_READY_42");
		await fromTree(reused);
		await waitForTerminal();
		await wait(async () => (await recorded()).length >= 1, "已有终端执行 cd");
		await cwdIs(reused, "reuse");
		assert.equal(await terminalId(), originalShell, "复用已有 shell");
		assert.equal(await tabId(), originalTab, "复用已有标签");
		assert.equal(await countTabs(), 1);
		assert.deepEqual(await recorded(), [reused], "一次文件树操作只执行一次 cd");

		await click('button[aria-label="在新窗口中打开"]');
		await until("window.plume.panelWindows.list().then(list => list.length === 1)", "终端弹到独立窗口");
		detached = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.isVisible());
		assert.ok(detached, "找到独立终端窗口");
		await waitForTerminal(detached);
		assert.equal(await terminalId(detached), originalShell, "弹出窗口接回原 shell");
		await fromTree(quoted);
		await wait(async () => (await recorded()).length >= 2, "主窗口文件树的单引号目录送到独立终端");
		await cwdIs(quoted, "detached", detached);
		assert.equal(await terminalId(detached), originalShell);
		assert.equal(await countTabs(), 0, "主窗口不新建第二个终端");
		// 独立窗口不画标签，数里面挂着的终端。
		assert.equal(await page<number>(`document.querySelectorAll('${panel} [data-terminal-id]').length`, detached), 1, "独立窗口里只有这一个终端");
		assert.deepEqual(await recorded(), [reused, quoted], "跨窗口只执行一次 cd，单引号保持字面含义");
		await capture("smoke-file-terminal-detached.png", detached);
		// 点「收回」时独立窗口跟着关掉，这一次脚本的结果可能回不来（Render frame was disposed）；收回了没有由下一步核对。
		await click('button[aria-label="收回"]', undefined, detached).catch(windowClosed);
		await until("window.plume.panelWindows.list().then(list => list.length === 0)", "终端收回原会话");
		detached = undefined;
		await waitForTerminal();
		await cwdIs(quoted, "docked");
		assert.equal(await terminalId(), originalShell);
		assert.deepEqual(await recorded(), [reused, quoted], "收回重挂不会再次执行已领取的 cd");

		await type("exit");
		await until(`document.querySelector('${panel} .terminal-exited') !== null`, "真实 shell 已退出");
		await fromTree(first);
		await until(
			`document.querySelector('${panel} [data-terminal-id]')?.dataset.terminalId !== ${JSON.stringify(originalShell)} && document.querySelector('${panel} [data-terminal-id]')?.dataset.terminalId`,
			"已退出的标签重新建立 shell",
		);
		await waitForTerminal();
		await output(first);
		await cwdIs(first, "restarted");
		assert.equal(await tabId(), originalTab, "重开仍复用原标签");
		assert.equal(await countTabs(), 1);
		await capture("smoke-file-terminal-restarted.png");
		await type(powershell ? `Set-Location -LiteralPath ${quote(workspace)}` : `cd ${quote(workspace)}`);
		await cwdIs(workspace, "restored");
		await click(`${treeTab} button[aria-label^="关闭"]`);
		await until(`document.querySelector('${treeTab}') === null`, "收起本次新增的文件树标签");
		console.log("PLUME_FILE_TERMINAL_SMOKE", JSON.stringify({ first: true, reuse: true, quotedPath: true, detachedReuse: true, cdOnce: true, restart: true }));
	} finally {
		if (detached && !detached.isDestroyed()) {
			await click('button[aria-label="收回"]', undefined, detached).catch(() => detached?.close());
		}
		await rm(folder, { recursive: true, force: true });
	}
}
