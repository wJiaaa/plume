/**
 * 改动快照和撤销：替模型写的每个文件、观测到的每条命令的改动，按会话存一份写之前和写之后的原文，撤回、交付卡的撤销从这里读。
 *
 * 快照放在数据目录的 `changes/<会话 id 的哈希>/<id>.json`（0600），不进会话存储、不经界面：撤销每次都重新读快照、重新查文件，
 * 不信任界面拿来的原文。会话删掉时整个目录删掉，之后迟到的记录（被停下的后台命令的退出回调）不再留下。
 */

import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Stats } from "node:fs";
import type { FileChangesSummary, UndoProblem } from "@plume/contract";
import { computeDiff, withinOrIs } from "@plume/platform";
import type { ChangeLock } from "./change-lock.ts";
import type { ChangeWords } from "./change-words.ts";
import { displayPath } from "./paths.ts";

export interface FileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	mode: number;
	nlink: number;
}

export function fileIdentity(stat: Stats): FileIdentity {
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, nlink: stat.nlink };
}

export interface RecordedChange {
	id: string;
	path: string;
	before: string | null;
	after: string | null;
	source: "tool" | "command";
	timestamp: number;
	beforeStat?: FileIdentity | null;
	afterStat?: FileIdentity;
}

function directory(dataDir: string, sessionId: string): string {
	return join(dataDir, "changes", createHash("sha256").update(sessionId).digest("hex"));
}

function validIdentity(value: unknown): value is FileIdentity {
	return (
		!!value &&
		typeof value === "object" &&
		["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink"].every(
			(key) => key in value && typeof (value as Record<string, unknown>)[key] === "number" && Number.isFinite((value as Record<string, number>)[key]),
		)
	);
}

async function readFileChange(dataDir: string, sessionId: string, id: string, words: ChangeWords): Promise<RecordedChange> {
	if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error(words.undoInvalid);
	const path = join(directory(await realpath(dataDir), sessionId), `${id}.json`);
	if (!(await lstat(path)).isFile() || (await realpath(path)) !== path) throw new Error(words.undoInvalid);
	const value = JSON.parse(await readFile(path, "utf8")) as Partial<RecordedChange> | null;
	if (
		!value ||
		value.id !== id ||
		typeof value.path !== "string" ||
		!isAbsolute(value.path) ||
		(value.before !== null && typeof value.before !== "string") ||
		(value.after !== null && typeof value.after !== "string") ||
		!Number.isFinite(value.timestamp) ||
		(value.source !== "tool" && value.source !== "command")
	)
		throw new Error(words.undoInvalid);
	if (value.source === "tool" && (!validIdentity(value.afterStat) || (value.before === null ? value.beforeStat !== null : !validIdentity(value.beforeStat))))
		throw new Error(words.undoInvalid);
	return value as RecordedChange;
}

export function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
	return a === null || b === null ? a === b : (Object.keys(a) as (keyof FileIdentity)[]).every((key) => a[key] === b[key]);
}

interface UndoPlan {
	path: string;
	before: string | null;
	after: string;
	stat: FileIdentity;
	mode: number;
}

const UNDO_WORDS = { command: "undoCommand", interleaved: "undoInterleaved", outside: "undoOutside", modified: "undoModified" } as const;

/** 不能自动退回，并说得出是哪一类：撤回对话时按类别告诉人哪个文件为什么没退。 */
class UndoRefused extends Error {
	constructor(
		readonly problem: UndoProblem,
		words: ChangeWords,
	) {
		super(words[UNDO_WORDS[problem]]);
	}
}

async function prepareUndo(cwd: string, changes: RecordedChange[], words: ChangeWords): Promise<UndoPlan> {
	const first = changes[0],
		last = changes.at(-1);
	if (!first || !last) throw new Error(words.undoEmpty);
	if (changes.some((change) => change.source === "command")) throw new UndoRefused("command", words);
	if (
		!changes.every(
			(change, index) =>
				change.path === first.path &&
				(!index || (change.before === changes[index - 1]!.after && sameIdentity(change.beforeStat ?? null, changes[index - 1]!.afterStat ?? null))),
		)
	)
		throw new UndoRefused("interleaved", words);
	const root = await realpath(cwd);
	if (!withinOrIs(root, first.path) || (await realpath(first.path)) !== first.path || (await realpath(dirname(first.path))) !== dirname(first.path))
		throw new UndoRefused("outside", words);
	const stat = await lstat(first.path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new UndoRefused("outside", words);
	if (last.after === null || !last.afterStat || !sameIdentity(fileIdentity(stat), last.afterStat) || (await readFile(first.path, "utf8")) !== last.after)
		throw new UndoRefused("modified", words);
	return { path: first.path, before: first.before, after: last.after, stat: fileIdentity(stat), mode: first.beforeStat?.mode ?? stat.mode };
}

/** 预检的身份一直传到落盘；同步的最后检查和替换之间不让其他工具插进来。 */
async function replaceRecorded(
	path: string,
	expected: string | null,
	content: string | null,
	expectedStat: FileIdentity | null,
	mode: number,
	words: ChangeWords,
): Promise<FileIdentity | null> {
	const parent = dirname(path),
		temporary = join(parent, `.plume-undo-${randomUUID()}`);
	try {
		if (content !== null) {
			await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await chmod(temporary, mode & 0o7777);
		}
		if (realpathSync(parent) !== parent) throw new Error(words.undoModified);
		let stat: Stats | null;
		try {
			stat = lstatSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && expected === null) stat = null;
			else throw error;
		}
		if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(words.undoOutside);
		if (!sameIdentity(stat ? fileIdentity(stat) : null, expectedStat) || (stat ? readFileSync(path, "utf8") : null) !== expected)
			throw new Error(words.undoModified);
		if (content === null) unlinkSync(path);
		else if (expected === null) {
			// 独占创建，回滚不会覆盖期间重新创建的文件。
			linkSync(temporary, path);
			unlinkSync(temporary);
		} else renameHeldOpen(temporary, path);
		return content === null ? null : fileIdentity(lstatSync(path));
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Windows 上别的进程开着目标时，改名得到的回答。 */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `renameSync`，Windows 上等别的进程放开目标。
 *
 * 文件刚被 agent 或回滚写过，Windows 上扫描新文件的杀毒软件、搜索索引会把它开着一瞬间，那时改名会被拒：等它过去，而不是
 * 报成撤销失败。同步地等，是因为最后的检查和替换之间不能让别的工具插进来（见 `replaceRecorded`）。只在 Windows 上等：
 * 别处同样的错误码说的是权限，等也不会变。一共试 8 次，每次多等 20ms，合计半秒多。
 */
function renameHeldOpen(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (attempt >= 8 || process.platform !== "win32" || !HELD_OPEN.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
		}
	}
}

/** 一组快照标识按文件分组，读不出的整组作废；首次 before 等于末次 after 的（改回原样）不算。 */
async function batches(dataDir: string, sessionId: string, ids: readonly string[], words: ChangeWords): Promise<RecordedChange[][]> {
	const grouped = new Map<string, RecordedChange[]>();
	for (const id of new Set(ids)) {
		const change = await readFileChange(dataDir, sessionId, id, words).catch(() => {
			throw new Error(words.undoInvalid);
		});
		const batch = grouped.get(change.path) ?? [];
		batch.push(change);
		grouped.set(change.path, batch);
	}
	return [...grouped.values()].filter((batch) => batch[0]!.before !== batch.at(-1)!.after);
}

/**
 * 快照的存取和撤销。`running` 交回现在正在跑一轮的会话的工作目录：同一个或嵌套的项目里还有会话在跑时不撤销，它可能正要改这些文件。
 */
export class ChangeStore {
	/** 删掉了的会话：它迟到的记录不再落盘。 */
	private readonly deleted = new Set<string>();

	constructor(
		private readonly dataDir: string,
		private readonly lock: ChangeLock,
		private readonly words: () => ChangeWords,
		private readonly running: () => Promise<readonly string[]>,
	) {}

	/** 记一次改动，交回快照标识；前后一样、会话已删时不记，交回 undefined。 */
	async record(
		sessionId: string,
		path: string,
		before: string | null,
		after: string | null,
		source: "tool" | "command" = "tool",
		beforeStat?: FileIdentity | null,
		afterStat?: FileIdentity,
	): Promise<string | undefined> {
		if (before === after || this.deleted.has(sessionId)) return undefined;
		const id = randomUUID();
		const dir = directory(await realpath(this.dataDir), sessionId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(
			join(dir, `${id}.json`),
			JSON.stringify({ id, path, before, after, source, timestamp: Date.now(), beforeStat, afterStat } satisfies RecordedChange),
			{ flag: "wx", mode: 0o600 },
		);
		// 删会话会终止后台命令；它迟到的退出回调不能重新留下快照。
		if (this.deleted.has(sessionId)) {
			await rm(dir, { recursive: true, force: true });
			return undefined;
		}
		return id;
	}

	/** 读一份快照；标识不对、文件被换成链接、内容对不上时抛错。 */
	read(sessionId: string, id: string): Promise<RecordedChange> {
		return readFileChange(this.dataDir, sessionId, id, this.words());
	}

	/** 会话删掉了：快照一起删，之后的记录不再落盘。 */
	async forget(sessionId: string): Promise<void> {
		this.deleted.add(sessionId);
		await rm(directory(this.dataDir, sessionId), { recursive: true, force: true });
	}

	/** 这组快照的净变化：同一文件只算首次 before 到末次 after，各自能不能撤销、为什么不能。 */
	async collect(sessionId: string, cwd: string, ids: readonly string[]): Promise<FileChangesSummary> {
		const words = this.words();
		const root = await realpath(cwd).catch(() => cwd);
		const grouped = new Map<string, RecordedChange[]>();
		const warnings: string[] = [];
		for (const id of new Set(ids)) {
			try {
				const change = await readFileChange(this.dataDir, sessionId, id, words);
				const batch = grouped.get(change.path) ?? [];
				batch.push(change);
				grouped.set(change.path, batch);
			} catch {
				if (!warnings.length) warnings.push(words.changeMissing);
			}
		}
		const files = [];
		for (const batch of grouped.values()) {
			const first = batch[0]!,
				last = batch.at(-1)!;
			if (first.before === last.after) continue;
			let undoReason: string | undefined = warnings.length ? words.undoInvalid : undefined;
			let undoProblem: UndoProblem | undefined;
			if (!undoReason) {
				try {
					await prepareUndo(root, batch, words);
				} catch (error) {
					// 读不出、对不上的（文件被删了、换成了目录）都算之后被改过。
					undoProblem = error instanceof UndoRefused ? error.problem : "modified";
					undoReason = error instanceof Error && Object.values(words).includes(error.message) ? error.message : words.undoModified;
				}
			}
			files.push({
				path: first.path,
				...computeDiff(first.before ?? "", last.after ?? ""),
				canUndo: !undoReason,
				...(undoReason ? { undoReason } : {}),
				...(undoProblem ? { undoProblem } : {}),
			});
		}
		return { files, warnings };
	}

	/** 把这组快照改过的文件退回去；`path` 不给时全部。写之前重新校验快照、当前内容和项目边界，写到一半失败把写了的退回原样。 */
	async undo(sessionId: string, cwd: string, ids: readonly string[], path?: string): Promise<void> {
		const words = this.words();
		const release = this.lock.beginUndo();
		try {
			const root = await realpath(cwd);
			for (const running of await this.running()) {
				const runningRoot = await realpath(running).catch(() => {
					throw new Error(words.undoRunning);
				});
				if (withinOrIs(root, runningRoot) || withinOrIs(runningRoot, root)) throw new Error(words.undoRunning);
			}
			// 每次操作重新读取私有快照，不信任界面保存的预览和原文。
			const selected = (await batches(this.dataDir, sessionId, ids, words)).filter(
				(batch) => path === undefined || path === batch[0]!.path || path === displayPath(root, batch[0]!.path),
			);
			if (!selected.length) throw new Error(words.undoEmpty);
			const plans = await Promise.all(selected.map((batch) => prepareUndo(root, batch, words)));
			if (new Set(plans.map((plan) => plan.path)).size !== plans.length) throw new Error(words.undoInvalid);
			const applied: { plan: UndoPlan; stat: FileIdentity | null }[] = [];
			try {
				for (const plan of plans) applied.push({ plan, stat: await replaceRecorded(plan.path, plan.after, plan.before, plan.stat, plan.mode, words) });
			} catch (error) {
				const failures = [error];
				for (const { plan, stat } of applied.reverse()) {
					try {
						await replaceRecorded(plan.path, plan.before, plan.after, stat, plan.stat.mode, words);
					} catch (cause) {
						failures.push(cause);
					}
				}
				if (failures.length > 1) throw new AggregateError(failures, words.undoFailed, { cause: error });
				throw error;
			}
		} finally {
			release();
		}
	}
}
