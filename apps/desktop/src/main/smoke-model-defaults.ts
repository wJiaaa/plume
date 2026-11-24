import assert from "node:assert/strict";
import { join } from "node:path";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import type { ModelOverride } from "./smoke-browser.ts";
import { clickVisibleIn, closeSettings } from "./smoke-kit.ts";

/** 临时选的模型只给当前会话用；改默认模型后，新建、跨项目新建和 /clear 都不能沿用它。 */
export async function checkModelDefaults({
	window,
	agent,
	outDir,
	page,
	until,
	click,
	type,
	capture,
	setModel,
}: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	outDir: string;
	page(code: string): Promise<unknown>;
	until(code: string, label: string): Promise<void>;
	click(selector: string, text?: string): Promise<void>;
	type(selector: string, value: string): Promise<unknown>;
	capture(window: BrowserWindow, path: string): Promise<void>;
	setModel(override: ModelOverride | undefined): void;
}): Promise<void> {
	const requests: unknown[] = [];
	setModel((request) => {
		requests.push(request.model);
		return { text: "模型选择验证完成。" };
	});
	const trigger = "document.querySelector('main [data-model-trigger]')";
	const shows = (model: string) => `${trigger}?.textContent.trim() === ${JSON.stringify(model)}`;
	const send = async (text: string, model: string) => {
		const count = requests.length;
		await page(`document.querySelector('main .cm-content').focus()`);
		await window.webContents.insertText(text);
		await click("[data-composer-send=send]");
		await until(
			`document.querySelector('[data-screen=chat]')?.textContent.includes('模型选择验证完成。') && !document.querySelector('[data-composer-send=stop]')`,
			text,
		);
		assert.deepEqual(requests.slice(count), [model], "实际请求必须使用输入框选中的模型");
	};

	// 先明确选 A，再把设置里的默认改成 B，保留能区分默认与临时选择的两个模型。
	await click("[data-model-trigger]");
	await click("[role=menuitem]", "fake-model");
	await send("保留原会话的模型", "fake-model");
	const original = (await agent.sessions())[0]!;
	assert.ok(original.model?.endsWith("/fake-model"));
	window.webContents.send("plume:command", "settings");
	await click('[aria-label="设置章节"] button', "模型设置");
	await click("[data-provider-item]");
	await click("[data-add-model]");
	await type("[data-model-editor-id]", "fake-default");
	await click("[data-model-editor-save]");
	await until(`document.querySelector('[data-model-row="fake-default"]') !== null`, "添加另一个默认模型");
	await clickVisibleIn(
		page,
		`document.querySelector('[data-model-row="fake-default"]').parentElement.querySelectorAll('button[aria-label="更多操作"]')`,
		"新模型的行菜单",
	);
	await click("[role=menuitem]", "设为默认模型");
	await until(`document.querySelector('[data-model-row="fake-default"]')?.textContent.includes('默认')`, "默认模型已改为 B");
	await closeSettings(page);
	await until(shows("fake-model"), "已有会话保留 A");
	await click(`[data-plume-row="${original.id}"] [data-plume-row-archive]`);
	await until(`document.querySelector('[data-screen=empty]') !== null && ${shows("fake-default")}`, "归档返回空白页不带入已用过的 A");

	window.webContents.send("plume:command", "new-session");
	await until(`document.querySelector('[data-screen=empty]') !== null && ${shows("fake-default")}`, "新会话使用默认 B、不沿用 A");
	await send("新会话使用默认模型", "fake-default");
	assert.equal((await agent.sessions()).find((session) => session.id === original.id)?.model, original.model, "新建不能改掉原会话的模型");

	// 没发送的临时选择也不应污染下一次新建；换项目同样经新建入口重置。
	window.webContents.send("plume:command", "new-session");
	await until(`document.querySelector('[data-screen=empty]') !== null`, "再次打开空白页");
	await click("[data-model-trigger]");
	await click("[role=menuitem]", "fake-model");
	await until(shows("fake-model"), "当前空白页可以另选 A");
	await click('[data-plume-section-action] button[aria-label="新建项目"]');
	await click("[data-plume-add-folder]");
	await until(`document.querySelector('[data-plume-source-folder]') !== null`, "选择另一个项目目录");
	await click("button", "创建项目");
	await until(
		`document.querySelector('[data-screen=empty] [data-welcome-line]')?.textContent.includes('workspace') && ${shows("fake-default")}`,
		"跨项目新建使用默认 B",
	);
	await send("跨项目新会话使用默认模型", "fake-default");

	await click("[data-model-trigger]");
	await click("[role=menuitem]", "fake-model");
	await click("button", "确认切换");
	await until(shows("fake-model"), "当前会话仍能单独改为 A");
	await page(`document.querySelector('main .cm-content').focus()`);
	await window.webContents.insertText("/clear");
	await click("[data-composer-send=send]");
	await until(`document.querySelector('[data-screen=empty]') !== null && ${shows("fake-default")}`, "/clear 使用默认 B");
	for (const theme of ["light", "dark"]) {
		await page(`window.plume.saveAppearance({ theme: ${JSON.stringify(theme)} })`);
		await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`, `默认模型 ${theme}`);
		await capture(window, join(outDir, `smoke-model-default-${theme}.png`));
	}
	console.log(
		"PLUME_MODEL_DEFAULTS_SMOKE",
		JSON.stringify({ requests, existingPreserved: true, archiveReset: true, unsentReset: true, crossProject: true, clear: true }),
	);
}
