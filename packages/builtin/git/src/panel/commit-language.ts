/**
 * 提交说明能让模型用哪几种语言写。选择放在魔杖旁边，不放设置页：提交前没人会去翻设置。
 * 存的是 id；菜单显示 `native`。和逻辑入口认的 id 是同一份。
 */

// i18n-exempt：每种语言用它自己的文字写自己的名字，翻译了反而认不出
export const COMMIT_LANGUAGES = [
	{ id: "zh", label: "中文", native: "简体中文" },
	{ id: "en", label: "English", native: "English" },
	{ id: "ja", label: "日本語", native: "日本語" },
	{ id: "ko", label: "한국어", native: "한국어" },
	{ id: "es", label: "Español", native: "Español" },
	{ id: "fr", label: "Français", native: "Français" },
	{ id: "de", label: "Deutsch", native: "Deutsch" },
	{ id: "pt", label: "Português", native: "Português" },
	{ id: "ru", label: "Русский", native: "Русский" },
] as const;

export type CommitLanguageId = (typeof COMMIT_LANGUAGES)[number]["id"];

const KNOWN = new Set<string>(COMMIT_LANGUAGES.map((language) => language.id));

export function resolveCommitLanguage(id: string | undefined | null): CommitLanguageId {
	return id && KNOWN.has(id) ? (id as CommitLanguageId) : "zh";
}

export function commitLanguageLabel(id: string | undefined | null): string {
	const resolved = resolveCommitLanguage(id);
	return COMMIT_LANGUAGES.find((language) => language.id === resolved)?.label ?? resolved;
}
