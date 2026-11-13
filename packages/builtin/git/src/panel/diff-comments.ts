/**
 * 人在 Git 面板「改动」里逐行留给 Agent 的评论。
 *
 * 按仓库存，不按会话：评论的是这份工作区里的改动，换个会话看同一个仓库，评过的那几行还标着。
 * 只放内存：评论是一次审阅的草稿，发出去就清空；重启以后那些行多半已经被改过，留着只会标错地方。
 */

import type { ChangeLine } from "@plume/contract";
import type { Translate } from "./i18n.ts";

export interface DiffComment {
	id: string;
	path: string;
	/**
	 * 评的那几行，留的时候什么样就存什么样。
	 *
	 * 发给模型的是这几行原文，不只是行号：留完评论到发出去之间文件还可能被改，行号会漂，原文能让它
	 * 认出说的是哪一段。界面上标记也按原文对（见 `rowKey`），对不上的那一行就不再标。
	 */
	lines: ChangeLine[];
	text: string;
}

/**
 * 一行在 diff 里的身份：路径、哪一边的行号、这一行的字。
 *
 * 删掉的行只有旧行号，其余用新行号。字也算进去：文件被改过以后同一个行号上可能已经是别的内容，
 * 标在那里就是标错了地方。
 */
export function rowKey(path: string, line: ChangeLine): string {
	const at = line.type === "remove" ? `-${line.oldLine ?? ""}` : `+${line.newLine ?? ""}`;
	return `${path}\0${at}\0${line.text}`;
}

function firstLine(comment: DiffComment): number {
	const line = comment.lines[0];
	return line?.newLine ?? line?.oldLine ?? 0;
}

const EMPTY: readonly DiffComment[] = [];
/** 按仓库根目录。每次改动换一个新数组，界面按引用判断变没变。 */
let byRepo: ReadonlyMap<string, readonly DiffComment[]> = new Map();
const listeners = new Set<() => void>();

function put(cwd: string, comments: readonly DiffComment[] | null): void {
	const next = new Map(byRepo);
	if (comments) next.set(cwd, comments);
	else next.delete(cwd);
	byRepo = next;
	for (const listener of listeners) listener();
}

export const diffComments = {
	get(cwd: string): readonly DiffComment[] {
		return byRepo.get(cwd) ?? EMPTY;
	},
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	/** 带 `id` 就是改那一条（字和行都可能变：Shift 点能把它拉长），不带就是新加。 */
	save(cwd: string, comment: Omit<DiffComment, "id"> & { id?: string }): void {
		const was = byRepo.get(cwd) ?? [];
		const next = comment.id
			? was.map((it) => (it.id === comment.id ? { ...it, ...comment, id: it.id } : it))
			: [...was, { ...comment, id: crypto.randomUUID() }];
		// 按文件、再按行排：序号和发出去的顺序都跟着读 diff 的顺序走，不跟着留的先后。
		next.sort((a, b) => a.path.localeCompare(b.path) || firstLine(a) - firstLine(b));
		put(cwd, next);
	},
	remove(cwd: string, id: string): void {
		const was = byRepo.get(cwd);
		if (was)
			put(
				cwd,
				was.filter((it) => it.id !== id),
			);
	},
	clear(cwd: string): void {
		if (byRepo.has(cwd)) put(cwd, null);
	},
};

/** `src/a.ts:12-14`；只评了删掉的行时没有新行号，说明是改动前的第几行。 */
export function commentPlace(t: Translate, comment: Pick<DiffComment, "path" | "lines">): string {
	const range = (numbers: number[]) => {
		const low = Math.min(...numbers);
		const high = Math.max(...numbers);
		return low === high ? `${low}` : `${low}-${high}`;
	};
	const fresh = comment.lines.flatMap((line) => (line.type !== "remove" && line.newLine ? [line.newLine] : []));
	if (fresh.length > 0) return `${comment.path}:${range(fresh)}`;
	const old = comment.lines.flatMap((line) => (line.oldLine ? [line.oldLine] : []));
	return old.length > 0 ? t("diffComment.removedAt", { path: comment.path, range: range(old) }) : comment.path;
}

/** 比代码里最长的一串反引号多一个，代码里本身带着三个反引号时围栏也不会提前合上。 */
function fenceFor(code: string): string {
	// 反引号写成转义：字面的反引号会让 i18n 检查把后面的注释当成模板字符串。
	const longest = Math.max(0, ...[...code.matchAll(/\u0060+/g)].map((run) => run[0].length));
	return "\u0060".repeat(Math.max(3, longest + 1));
}

/**
 * 发给 Agent 的那一条消息：每条评论是位置、那几行 diff、评论本身。
 *
 * diff 照 unified 的写法带加号、减号、空格前缀：模型认得这个格式，也就分得清人评的是改之前还是改之后。
 * 序号写成「(1)」而不是「1.」：每条中间夹着代码块，Markdown 列表到那里就断了，转录里每条都显示成「1.」。
 */
export function diffCommentPrompt(t: Translate, cwd: string, comments: readonly DiffComment[]): string {
	const parts = comments.map((comment, index) => {
		const code = comment.lines.map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`).join("\n");
		const fence = fenceFor(code);
		return `(${index + 1}) \`${commentPlace(t, comment)}\`\n${fence}diff\n${code}\n${fence}\n${comment.text.trim()}`;
	});
	// 仓库选择器能指向会话目录之外的仓库和工作树，不能让相对路径落回会话自己的目录。
	return [t("diffComment.prompt"), `${t("common.workspace")}: ${JSON.stringify(cwd)}`, ...parts].join("\n\n");
}
