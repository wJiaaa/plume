/**
 * 项目指令（`AGENTS.md` 这类文件）和工作目录是什么样的仓库：组系统提示词时每一轮按磁盘现状读一次，改了文件下一轮就生效。
 */

import { access, lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProjectInstructions {
	path: string;
	content: string;
}

/** 同一个目录里的优先级。几份都在时只用第一份：后面的多半是从别的工具迁过来没删的旧版本，两份一起放会自相矛盾。 */
const INSTRUCTION_FILES = ["PLUME.md", "AGENTS.md", "CLAUDE.md", ".agent/AGENTS.md", ".agents/AGENTS.md"];
/** 往上找的层数上限，防病态路径，不是语义。 */
const MAX_DEPTH = 10;
/** 一份指令最多放进提示词多少字节；超过的截断，并告诉模型去读全文。 */
export const INSTRUCTION_BYTE_LIMIT = 100 * 1024;

/**
 * 从工作目录一路往上收到仓库根，每层一份，从远到近排：根的约定先出现、子包的后出现，后者更具体，冲突时模型按后者办。
 * 不在 git 仓库里时只读工作目录自己：再往上是 `~` 和 `/`，那里的指令属于别的项目。
 */
export async function loadProjectInstructions(cwd: string): Promise<ProjectInstructions[]> {
	const root = await findRepoRoot(cwd);
	const found: ProjectInstructions[] = [];
	let dir = cwd;
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		for (const name of INSTRUCTION_FILES) {
			const path = join(dir, name);
			const content = (await readFile(path, "utf8").catch(() => ""))?.trim();
			if (!content) continue;
			found.push({ path, content: budgetInstructions(content, path) });
			break;
		}
		if (root === null || dir === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found.reverse();
}

/** Magpie 共享指令最多放进提示词多少个字符。 */
const MAGPIE_CHAR_LIMIT = 100 * 1024;

/**
 * Magpie 资源库分发的全局指令：`<Plume 数据目录>/magpie/AGENTS.md`，由 Magpie 写、撤回时删。每轮现读，和人自己的全局指令
 * 一起放进提示词，不抄进设置，撤回后不留副本。没有就是没分发过；读不了只留一句诊断，不拖垮这一轮。
 * shortcut：最多放 102400 个字符，超过的只放开头；需要更长时改成截断后告诉模型去读全文。
 */
export async function loadMagpieInstructions(appDataDir: string, log: { warn(message: string): void }): Promise<string> {
	const path = join(appDataDir, "magpie", "AGENTS.md");
	const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") log.warn(`无法读取 ${path}`);
		return "";
	});
	if (text.length > MAGPIE_CHAR_LIMIT) log.warn(`${path} 超过 ${MAGPIE_CHAR_LIMIT} 个字符，只放开头部分`);
	return text
		.replace(/^\uFEFF/, "")
		.slice(0, MAGPIE_CHAR_LIMIT)
		.trim();
}

/** 按 UTF-8 的字边界截断，并写明完整文件在哪。 */
function budgetInstructions(content: string, path: string): string {
	if (Buffer.byteLength(content, "utf8") <= INSTRUCTION_BYTE_LIMIT) return content;
	const bytes = Buffer.from(content, "utf8");
	let end = INSTRUCTION_BYTE_LIMIT;
	while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n\n[Instructions truncated at 100 KiB. Read the complete file at ${JSON.stringify(path)} before acting on rules outside this excerpt.]`;
}

/** 含 `.git` 的最近祖先，没有就是 null。worktree 里 `.git` 是文件不是目录，所以只看在不在。 */
export async function findRepoRoot(cwd: string): Promise<string | null> {
	let dir = cwd;
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		if (await isGitRepo(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/** 这个目录本身是不是一个 git 仓库（或 worktree）的根。 */
function isGitRepo(dir: string): Promise<boolean> {
	return access(join(dir, ".git")).then(
		() => true,
		() => false,
	);
}

/**
 * 这个目录是不是一份 git worktree。主仓库里 `.git` 是目录，worktree 和 submodule 里是一个写着 `gitdir:` 的文件；
 * submodule 里的改动是用户实实在在的改动，靠 gitdir 指向 `…/worktrees/…` 还是 `…/modules/…` 区分。
 * 拿不准的一律 false，理由见 `SystemPromptInput.isolatedWorktree`。
 */
export async function isIsolatedWorktree(cwd: string): Promise<boolean> {
	try {
		const dotGit = join(cwd, ".git");
		// lstat 不跟随：指向别处的 `.git` 链接不算副本。
		if (!(await lstat(dotGit)).isFile()) return false;
		return /^\s*gitdir:\s*.*[/\\]worktrees[/\\]/m.test(await readFile(dotGit, "utf8"));
	} catch {
		return false;
	}
}
