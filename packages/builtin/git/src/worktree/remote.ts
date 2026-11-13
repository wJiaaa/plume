/**
 * 工作树的界面用到的几样：调逻辑入口的对象（和 Git 面板共用的那一个），宿主的提示条和「在文件管理器中显示」。`apply` 时存下来，组件从这里取。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { useI18n } from "@plume/ui";
import type { WorktreeApi } from "./api.ts";
import { WORKTREE_MESSAGES as MESSAGES, type WorktreeMessages as Messages } from "../messages.ts";

let current: { api: Remote<WorktreeApi>; ui: UiContext } | null = null;

export function setWorktreeHost(ui: UiContext, api: Remote<WorktreeApi>): void {
	current = { api, ui };
}

function host(): { api: Remote<WorktreeApi>; ui: UiContext } {
	if (!current) throw new Error("plume.git: worktree remote not ready");
	return current;
}

export const worktree = () => host().api;
/** 在系统的文件管理器里指出它（宿主的 `ui.revealPath`）。 */
export const revealPath = (path: string) => host().ui.revealPath(path);
export const notify = (message: string, level?: "info" | "warn" | "error") => host().ui.notify(message, level);

export function useText(): Messages {
	return MESSAGES[useI18n().resolvedLocale];
}

export const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
