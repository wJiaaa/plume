import type { ProjectEntry, SessionTarget } from "@plume/contract";
import type { ConversationDraft } from "@plume/contract/ui";

/** 插件只能准备草稿，不在导航时创建记录或发送消息。目标先校验，失败不改变当前页面。 */
export function conversationDraftTarget(options: ConversationDraft, projects: readonly ProjectEntry[]): SessionTarget {
	if (!options || typeof options.text !== "string" || !options.text.trim()) throw new Error("A conversation draft must contain text.");
	if (options.project !== undefined) {
		if (options.cwd !== undefined || typeof options.project !== "string" || !projects.some((project) => project.id === options.project)) {
			throw new Error("The conversation draft must target an existing project or a directory, not both.");
		}
		return { project: options.project };
	}
	if (typeof options.cwd !== "string" || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(options.cwd) || options.cwd.includes("\0")) {
		throw new Error("The conversation draft needs an absolute working directory.");
	}
	return { cwd: options.cwd };
}

/** 保留人已经写下的草稿和空白，不因来自插件的导航丢掉输入。 */
export function appendConversationDraft(held: string | undefined, incoming: string): string {
	return held ? `${held}\n\n${incoming}` : incoming;
}

export function externalWebUrl(raw: string): string {
	const url = new URL(raw);
	if ((url.protocol !== "http:" && url.protocol !== "https:") || /^https?:\/\/[^/]*@/i.test(url.href))
		throw new Error("Only HTTP(S) links without credentials can be opened.");
	return url.href;
}
