import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";

const SUMMARY = "冒烟摘要：hello.txt 已改成 hi。";
const FOCUS = "保留 hello 的改动";
/** 约四万多 token：比窗口的 12%（原样留着的尾部）大，压完才会变小；又远在触发线以下，不会自己压。 */
const LONG_REPLY = "This line pads the history so that /compact has something to fold.\n".repeat(2400);

/**
 * 人敲 `/compact 说明`，经真界面走一遍：命令由内置插件 plume.compaction 供，不进对话；转录里是一只写着那条命令的气泡，
 * 底下一行从「正在压缩」走到「已压缩」。说明要进摘要请求的指令。在从最后那条回复分叉出的会话里做（垫一段长回复才有东西可压），
 * 原会话不动，最后回到原会话。
 */
export async function checkCompact(options: {
	window: BrowserWindow;
	outDir: string;
	page: (code: string) => Promise<unknown>;
	until: (code: string, label: string) => Promise<void>;
	click: (selector: string, text?: string) => Promise<void>;
	capture: (window: BrowserWindow, path: string) => Promise<void>;
	setModel(override: ModelOverride | undefined): void;
	sessionId: string;
	finalText: string;
}): Promise<void> {
	const { window, outDir, page, until, click, capture, setModel, sessionId, finalText } = options;
	const chat = "[data-screen=chat]";
	const summaries: Array<Record<string, unknown>> = [];
	setModel((request) => {
		const sent = JSON.stringify(request.messages);
		if (sent.includes(FOCUS)) {
			summaries.push(request);
			return { text: SUMMARY };
		}
		return { text: sent.includes("垫一段长的") && !sent.includes("短问题") ? LONG_REPLY : "好的。" };
	});
	const say = async (text: string, reply: string) => {
		const before = (await page(`document.querySelectorAll('${chat} [data-plume-quote=assistant]').length`)) as number;
		await page(`document.querySelector('${chat} .cm-content').focus()`);
		await window.webContents.insertText(text);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, `「${text}」可以发送`);
		await click("[data-composer-send=send]");
		await until(
			`(() => { const replies = document.querySelectorAll('${chat} [data-plume-quote=assistant]'); return replies.length > ${before} && replies[replies.length - 1].textContent.includes(${JSON.stringify(reply)}) && document.querySelector('[data-composer-send=send]') !== null; })()`,
			`「${text}」有了回答`,
		);
	};
	try {
		await page(`[...document.querySelectorAll('${chat} [data-plume-quote=assistant] [data-message-fork]')].at(-1).click()`);
		await until(`document.querySelector('[data-plume-screen-title]')?.textContent.endsWith('（分叉）')`, "分叉出压缩用的会话");
		await say("垫一段长的", "This line pads the history");
		await say("短问题一", "好的。");
		await say("短问题二", "好的。");

		await page(`document.querySelector('${chat} .cm-content').focus()`);
		await window.webContents.insertText(`/compact ${FOCUS}`);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "/compact 可以发送");
		await click("[data-composer-send=send]");
		await until(
			`document.querySelector('${chat} [data-compaction]') !== null && document.querySelector('${chat} [data-compaction][data-compaction-status=running]') === null`,
			"/compact 那一行出现并收场",
		).catch(async (error: unknown) => {
			await capture(window, join(outDir, "smoke-compact-failed.png"));
			throw error;
		});
		const row = (await page(`document.querySelector('${chat} [data-compaction]').textContent`)) as string;
		const status = await page(`document.querySelector('${chat} [data-compaction]').dataset.compactionStatus`);
		if (status !== "done") throw new Error(`/compact 应该压完，实际是 ${String(status)}：${JSON.stringify(row)}`);
		if (!row.includes("/compact") || !row.includes(FOCUS)) throw new Error(`/compact 的气泡应该写着那条命令，实际是 ${JSON.stringify(row)}`);
		if (!row.includes("已压缩上下文")) throw new Error(`/compact 底下那一行应该说压完了，实际是 ${JSON.stringify(row)}`);
		if (await page(`[...document.querySelectorAll('${chat} [data-plume-quote=user]')].some((bubble) => bubble.textContent.includes(${JSON.stringify(FOCUS)}))`))
			throw new Error("/compact 不该作为一句话发进对话");
		if (summaries.length === 0) throw new Error("/compact 后面的说明没有进摘要请求");
		await page(`document.querySelector('${chat} [data-compaction]').scrollIntoView({ block: 'center' })`);
		await capture(window, join(outDir, "smoke-compact.png"));
	} finally {
		setModel(undefined);
	}
	window.webContents.send("plume:command", `open-session:${sessionId}`);
	await until(
		`!document.querySelector('[data-plume-screen-title]')?.textContent.endsWith('（分叉）') && document.querySelector('${chat}')?.textContent.includes(${JSON.stringify(finalText)})`,
		"回到原会话",
	);
}
