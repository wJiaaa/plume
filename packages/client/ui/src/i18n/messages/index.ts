import { en } from "./en.ts";
import { zhCN, type MessageCatalog, type MessageKey, type PluralForms } from "./zh-CN.ts";

import type { Locale } from "@plume/contract";

/** 界面实际用的语言：设置里的「跟随系统」解析之后的那一种。 */
export type ResolvedUiLocale = Locale;
export type { MessageKey, PluralForms };

export const MESSAGE_CATALOGS: Record<ResolvedUiLocale, MessageCatalog> = {
	"zh-CN": zhCN,
	en,
};
