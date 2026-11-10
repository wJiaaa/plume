/**
 * 界面入口用到的宿主能力：报一声（toast）、开自己的面板、往输入框里写一段草稿、把一段话交给会话。`apply` 时把 `ui` 存下来。
 */

import type { UiContext } from "@plume/contract/ui";

let current: UiContext | null = null;

export function setHost(ui: UiContext): void {
	current = ui;
}

export function notify(message: string, level: "info" | "warn" | "error" = "info"): void {
	current?.notify(message, level);
}

/** Git 面板的 id，在 `ui.tsx` 里注册。 */
export const PANEL_ID = "git";

export function openGitPanel(): void {
	current?.openPanel(PANEL_ID);
}

/** 把一句话放进当前输入框，换掉原来的草稿，等人看过再发。 */
export function draft(text: string): void {
	// 界面还没接上时什么都不做，和别的入口一样。
	void current?.draftInSession(undefined, { text, replace: true }).catch(() => undefined);
}

/**
 * 人按了「发给 Agent」：交给面板所在的会话，输入框原本是空的就直接发出去，人写了一半时接在草稿后面等人自己发。
 * 还没发过消息的新对话没有会话可指，交给当前输入框，同样是空的就发出去、开出会话。
 */
export async function handToSession(text: string, sessionId: string | undefined): Promise<void> {
	await current?.draftInSession(sessionId, { text, send: true });
}

export async function previewFile(path: string, sessionId: string): Promise<void> {
	try {
		await current?.openFile(path, sessionId);
	} catch (error) {
		notify(String(error), "error");
	}
}
