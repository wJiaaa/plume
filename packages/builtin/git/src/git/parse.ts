/**
 * 读 git 的 `-z` 输出。
 *
 * 两种格式都把重命名的两个路径各写成一个以 NUL 结尾的字段，一条记录不总是一个字段，得边读边看。
 * 各处自己走一遍时，忘了这件事的那几处会把旧路径当成另一行：面板上多出一个不存在的文件。所以只走这一遍。
 */

/** `status --porcelain=v1 -z` 的一行。 */
export interface StatusEntry {
	/** 两个状态字母：暂存区，然后工作区。 */
	code: string;
	path: string;
	/** 重命名、复制的来处；别的情况和 `path` 相同。 */
	source: string;
}

/** `status --porcelain=v1 -z`，带不带 `--branch` 都行；`## …` 那一行单独返回。 */
export function parseStatusZ(out: string): { header: string; entries: StatusEntry[] } {
	const fields = out.split("\0");
	let header = "";
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		if (i === 0 && field.startsWith("## ")) {
			header = field.slice(3);
			continue;
		}
		const code = field.slice(0, 2);
		const path = field.slice(3);
		// 重命名的来处是下一个字段，不是另一行。
		const source = /[RC]/.test(code) ? (fields[++i] ?? path) : path;
		if (path) entries.push({ code, path, source });
	}
	return { header, entries };
}

/**
 * `status --branch` 那一行写的分支，以及有没有第一个提交。
 *
 * git 的几种写法：`main...origin/main [ahead 1]`、`main`、`No commits yet on main`（2.15 以前是 `Initial commit on main`）、
 * `HEAD (no branch)`。游离 HEAD 时为空。分支名不能含 `..`，所以第一个 `...` 就是分支名的结尾。
 */
export function statusBranch(header: string): { branch: string | null; born: boolean } {
	const unborn = /^(?:No commits yet|Initial commit) on (.+)$/.exec(header);
	if (unborn) return { branch: unborn[1] ?? null, born: false };
	if (!header || header.startsWith("HEAD (no branch)")) return { branch: null, born: true };
	return { branch: header.split("...")[0]?.split(" ")[0] ?? null, born: true };
}

/**
 * `--numstat -z` 的每个路径的行数。
 *
 * 普通改动写 `added\tremoved\tpath\0`；重命名写完行数后跟一个空路径，两个路径各占一个字段。二进制文件两个数都是 `-`：
 * 没有行可数，不是零行。按目标路径记，和 `status`、`--name-status` 报的一致。
 */
export function parseNumstat(stats: string): Map<string, { added: number; removed: number; binary: boolean }> {
	const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
	const fields = stats.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(field);
		if (!match) continue;
		const [, addedRaw, removedRaw, inline] = match;
		// 路径为空说明两个重命名路径跟在后面。
		const path = inline || fields[i + 2];
		if (!inline) i += 2;
		if (!path) continue;
		counts.set(path, {
			added: addedRaw === "-" ? 0 : Number(addedRaw),
			removed: removedRaw === "-" ? 0 : Number(removedRaw),
			binary: addedRaw === "-",
		});
	}
	return counts;
}

/** `worktree list --porcelain` 里的一个检出。 */
export interface WorktreeRecord {
	/** git 打印的样子：Windows 上也是正斜杠。 */
	path: string;
	/** 短分支名；游离时为空。 */
	branch: string | null;
}

/** `worktree list --porcelain`：每个检出一段，空行隔开，主检出在最前。 */
export function parseWorktreeList(out: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) records.push({ path: line.slice("worktree ".length), branch: null });
		else if (line.startsWith("branch ")) {
			const last = records.at(-1);
			if (last) last.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		}
	}
	return records;
}
