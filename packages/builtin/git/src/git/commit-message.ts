/**
 * 用模型按真实的 diff 写一句提交说明：问的是暂存的补丁（没有暂存就是工作区），不带工具。
 * 提示词发给模型，写英文，不翻译。
 */

import { withView, type RepoView } from "./view.ts";

const PATCH_LIMIT = 16_000;

/** 和界面的 `commit-language.ts` 同一套 id。认不出的退回中文。 */
const COMMIT_LANGUAGE_PROSE: Record<string, string> = {
	zh: "Write the commit message in Simplified Chinese.",
	en: "Write the commit message in English.",
	ja: "Write the commit message in Japanese.",
	ko: "Write the commit message in Korean.",
	es: "Write the commit message in Spanish.",
	fr: "Write the commit message in French.",
	de: "Write the commit message in German.",
	pt: "Write the commit message in Portuguese.",
	ru: "Write the commit message in Russian.",
};

export function buildCommitPrompt(patch: string, language: string, source: "staged" | "unstaged"): { system: string; user: string } {
	const languageLine = COMMIT_LANGUAGE_PROSE[language] ?? COMMIT_LANGUAGE_PROSE.zh;
	const scope =
		source === "staged"
			? "This patch is what is currently staged and will go into the next commit."
			: "Nothing is staged. This patch is the unstaged working tree; describe that work anyway.";
	return {
		system: [
			"You write git commit messages.",
			"Use Conventional Commits: type(optional-scope): subject.",
			"Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore.",
			"The first line is the subject, at most 72 characters, no trailing period.",
			"Add a blank line and a short body only when the subject cannot carry the change.",
			"Do not wrap the message in markdown fences or quotes.",
			"Do not mention being an AI, and do not invent files that are not in the patch.",
			languageLine,
		].join(" "),
		user: `${scope}\n\n${patch}`,
	};
}

/** 模型偶尔还是会包一层代码围栏或引号，剥掉。 */
export function cleanCommitMessage(raw: string): string {
	let text = raw.trim();
	if (text.startsWith("```"))
		text = text
			.replace(/^```[a-zA-Z0-9_-]*\s*/, "")
			.replace(/\s*```$/, "")
			.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
	return text;
}

/**
 * 要描述的补丁：有暂存就是暂存的，否则是工作区的改动加上没跟踪的文件名；都没有为空。
 * 在视图里读：仓库配置里的 `diff.external`、textconv 不会被执行，补丁也就是 git 自己排的那份。
 */
export async function collectCommitPatch(cwd: string): Promise<{ patch: string; source: "staged" | "unstaged" } | null> {
	return (await withView(cwd, patchIn).catch(() => null)) ?? null;
}

async function patchIn(view: RepoView): Promise<{ patch: string; source: "staged" | "unstaged" } | null> {
	const staged = await view.git(["diff", "--cached", "--no-color"]).catch(() => "");
	if (staged.trim()) return { patch: cap(staged), source: "staged" };

	const unstaged = await view.git(["diff", "--no-color", "--ignore-submodules=dirty"]).catch(() => "");
	const untracked = await view.git(["ls-files", "--others", "--exclude-standard"]).catch(() => "");
	const parts: string[] = [];
	if (unstaged.trim()) parts.push(unstaged.trim());
	if (untracked.trim()) {
		parts.push(
			`Untracked files:\n${untracked
				.trim()
				.split("\n")
				.map((path) => `  ${path}`)
				.join("\n")}`,
		);
	}
	if (parts.length === 0) return null;
	return { patch: cap(parts.join("\n\n")), source: "unstaged" };
}

function cap(text: string): string {
	if (text.length <= PATCH_LIMIT) return text;
	return `${text.slice(0, PATCH_LIMIT)}\n\n[diff truncated]`;
}
