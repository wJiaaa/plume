/**
 * 界面入口取文案：按 `@plume/ui` 的界面语言从 `messages.ts` 的 `MESSAGES` 里挑一句，填进 `{名字}`。
 *
 * 带数目的句子在英文里分单复数，数目一律叫 `{n}`，由它决定用哪一种。
 */

import type { Locale } from "@plume/contract";
import { useI18n } from "@plume/ui";
import { useCallback } from "react";
import { MESSAGES, type MessageKey } from "../messages.ts";

type Variables = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, variables?: Variables) => string;

const rules = new Map<Locale, Intl.PluralRules>();

function pluralOf(locale: Locale, n: unknown): Intl.LDMLPluralRule {
	const count = typeof n === "number" ? n : typeof n === "string" && /^\d+$/.test(n) ? Number(n) : Number.NaN;
	if (!Number.isFinite(count)) return "other";
	let rule = rules.get(locale);
	if (!rule) {
		rule = new Intl.PluralRules(locale);
		rules.set(locale, rule);
	}
	return rule.select(count);
}

function translateIn(locale: Locale, key: MessageKey, variables?: Variables): string {
	const message: string | Partial<Record<Intl.LDMLPluralRule, string>> = MESSAGES[locale][key];
	const template = typeof message === "string" ? message : (message[pluralOf(locale, variables?.n)] ?? message.other ?? "");
	if (!variables) return template;
	return template.replace(/\{([^}]+)\}/g, (match, name: string) => {
		const value = variables[name];
		return value === undefined ? match : String(value);
	});
}

export function useT(): Translate {
	const locale = useI18n().resolvedLocale;
	return useCallback<Translate>((key, variables) => translateIn(locale, key, variables), [locale]);
}
