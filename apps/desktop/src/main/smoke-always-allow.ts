import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { BrowserWindow } from "electron";
import { clickVisible } from "./smoke-kit.ts";
import { toolResult } from "./smoke-question.ts";

const FIRST = "冒烟：把 always-allow.txt 写两遍";
const AGAIN = "冒烟：撤销后再写一遍 always-allow.txt";
const FIRST_DONE = "两遍都写好了。";
const AGAIN_DONE = "又写了一遍。";
const FILE = "always-allow.txt";

/**
 * 「以后不再问」能看、能撤销：权限切到请求批准，假模型连着两次 `write` 同一个文件。
 *
 * 1. 第一次弹审批卡，点「以后不再问」；第二次不再弹卡。
 * 2. 设置 › 常规 › 权限里列出这一条：写的是这个文件的路径，记在内置工具插件名下；点「撤销」，名单空了。
 * 3. 回到对话再写一次，审批卡重新弹出；这次又点「以后不再问」，到设置里点「全部撤销」，名单又空了。
 */
export async function checkAlwaysAllow(options: {
	window: BrowserWindow;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 15_000;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`「以后不再问」等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(code), label);
	const capture = async (name: string) => {
		await page(`new Promise(resolve => setTimeout(resolve, 500))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const chatHas = (text: string) => `document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(text)}) === true`;
	const send = async (text: string) => {
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(text);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, `「${text}」可以发送`);
		await clickVisible(page, `[data-composer-send=send]`);
	};
	const card = `document.querySelector('[data-approval-card]')?.textContent.includes(${JSON.stringify(FILE)}) === true`;
	const rows = `[...document.querySelectorAll('[data-always-allow-list] [data-always-allow]')]`;
	const openPermissions = async (label: string) => {
		window.webContents.send("plume:command", "settings");
		await until(`document.querySelector('[data-screen=settings]') !== null`, `${label}：打开设置`);
		await clickVisible(page, "[aria-label=设置章节] button", "常规");
	};
	const back = () => clickVisible(page, "button", "返回工作区");

	const write = (id: string) => ({ toolCalls: [{ id, name: "write", args: { path: FILE, content: `${id}\n` } }] });
	setModel((request) => {
		// 标题这类不带工具的小调用不答。
		if (!((request.tools as { name?: string }[] | undefined) ?? []).some((tool) => tool.name === "write")) return { text: "以后不再问" };
		const all = JSON.stringify(request.messages ?? []);
		if (all.includes(AGAIN)) return toolResult(request, "toolu_always_3") === undefined ? write("toolu_always_3") : { text: AGAIN_DONE };
		if (toolResult(request, "toolu_always_2") !== undefined) return { text: FIRST_DONE };
		return toolResult(request, "toolu_always_1") === undefined ? write("toolu_always_1") : write("toolu_always_2");
	});
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		if ((await page(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip`)) !== "ask") {
			await clickVisible(page, "[data-permission-chip]");
			await clickVisible(page, `[role=menuitem]`, /^请求批准/);
			await until(`document.querySelector('[data-permission-chip]')?.dataset.permissionChip === 'ask'`, "权限签切到「请求批准」");
		}

		// 1. 第一次问，答「以后不再问」；第二次同一个文件不再问。
		await send(FIRST);
		await until(card, "第一次写文件弹出审批卡");
		await clickVisible(page, "[data-approval-card] button", "以后不再问");
		await until(chatHas(FIRST_DONE), "第二次写同一个文件没再问，这一轮收尾");
		if (await page<boolean>(`document.querySelector('[data-approval-card]') !== null`)) throw new Error("答过「以后不再问」后不该再弹卡");

		// 2. 设置里列出这一条，撤销。
		await openPermissions("看批准");
		await until(`${rows}.some((row) => row.dataset.alwaysAllow.endsWith(${JSON.stringify(FILE)}))`, "设置 › 常规列出这条「以后不再问」");
		const row = (await page<{ plugin: string; text: string }[]>(`${rows}.map((row) => ({ plugin: row.dataset.alwaysAllowPlugin, text: row.textContent }))`))[0];
		if (row?.plugin !== "plume.tools") throw new Error(`这条批准应记在内置工具插件名下：${JSON.stringify(row)}`);
		await page(`document.querySelector('[data-always-allow-list]').scrollIntoView({ block: 'center' })`);
		await capture("smoke-always-allow.png");
		await clickVisible(page, "[data-always-allow-list] [data-always-allow-revoke]", "撤销");
		await until(`document.querySelector('[data-always-allow-list]') === null`, "撤销后名单空了");
		await back();

		// 3. 撤销后再写，审批卡重新弹出；再答一次「以后不再问」，到设置里全部撤销。
		await until(`document.querySelector('[data-screen=chat]') !== null`, "回到对话");
		await send(AGAIN);
		await until(card, "撤销后再写，审批卡重新弹出");
		await clickVisible(page, "[data-approval-card] button", "以后不再问");
		await until(chatHas(AGAIN_DONE), "第三次写完");
		await openPermissions("全部撤销");
		await until(`${rows}.length === 1`, "又记下一条");
		await clickVisible(page, "[data-always-allow-clear]", "全部撤销");
		await until(`document.querySelector('[data-always-allow-list]') === null`, "全部撤销后名单空了");
		await back();
	} finally {
		setModel(undefined);
	}
	console.log("PLUME_ALWAYS_ALLOW_SMOKE", JSON.stringify({ listed: true, revoked: true, askedAgain: true, cleared: true }));
}
