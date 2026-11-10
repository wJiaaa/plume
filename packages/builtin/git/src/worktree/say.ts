/**
 * 工作树逻辑层给人看的话按界面语言选；语言和 Git 那一半用同一个来源（`apply` 时接上 `ctx.locale`）。
 */

import type { Locale } from "@plume/contract";
import { currentLocale } from "../git/say.ts";
import { WORKTREE_MESSAGES as MESSAGES } from "../messages.ts";

export function say(): (typeof MESSAGES)[Locale] {
	return MESSAGES[currentLocale()];
}
