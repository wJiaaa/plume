/**
 * 工作树自己存的两样，都在插件数据目录：设置（`worktree.json`；`settings.json` 是 Git 那一半的提交说明语言）和按会话记下的工作树（`sessions.json`）。
 *
 * 会话的工作树记在这里而不是会话上：会话是宿主的，插件只经 `prompt.submit` 的 `cwd` 让它换个目录跑。删除、归档时会话
 * 的摘要已经说不出它出自哪个项目、在哪个分支上，这一份说得出。写入排成一队，挨得近的两次不会互相盖掉。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord, WorktreeSettings } from "./api.ts";

const DEFAULT_SETTINGS: WorktreeSettings = { rootDir: "", fetchFirst: false, autoClean: false, keepLimit: 15 };

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** 先写到旁边再改名：写到一半退出，留下的还是上一份完整的。 */
async function writeJson(file: string, value: unknown): Promise<void> {
	await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, "\t")}\n`);
	await rename(`${file}.tmp`, file);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 认得的字段取过来，别的丢掉；认不出的值回到默认。 */
export function normalizeSettings(value: unknown): WorktreeSettings {
	const raw = isObject(value) ? value : {};
	const keepLimit =
		typeof raw.keepLimit === "number" && Number.isFinite(raw.keepLimit) ? Math.min(100, Math.max(1, Math.round(raw.keepLimit))) : DEFAULT_SETTINGS.keepLimit;
	return {
		rootDir: typeof raw.rootDir === "string" ? raw.rootDir : DEFAULT_SETTINGS.rootDir,
		fetchFirst: typeof raw.fetchFirst === "boolean" ? raw.fetchFirst : DEFAULT_SETTINGS.fetchFirst,
		autoClean: typeof raw.autoClean === "boolean" ? raw.autoClean : DEFAULT_SETTINGS.autoClean,
		keepLimit,
	};
}

function normalizeRecord(value: unknown): SessionRecord | null {
	if (!isObject(value)) return null;
	const tree = value.worktree;
	const worktree =
		isObject(tree) && typeof tree.project === "string" && typeof tree.root === "string" && typeof tree.cwd === "string" && typeof tree.branch === "string"
			? { project: tree.project, root: tree.root, cwd: tree.cwd, branch: tree.branch, ...(typeof tree.base === "string" ? { base: tree.base } : {}) }
			: undefined;
	const error = typeof value.error === "string" ? value.error : undefined;
	return worktree || error ? { ...(worktree ? { worktree } : {}), ...(error ? { error } : {}) } : null;
}

export interface Store {
	settings(): Promise<WorktreeSettings>;
	saveSettings(patch: Partial<WorktreeSettings>): Promise<WorktreeSettings>;
	record(sessionId: string): Promise<SessionRecord | null>;
	/** 给 null 是删掉这个会话的记录。 */
	setRecord(sessionId: string, record: SessionRecord | null): Promise<void>;
	records(): Promise<Map<string, SessionRecord>>;
}

export function createStore(dataDir: string): Store {
	const settingsFile = join(dataDir, "worktree.json");
	const recordsFile = join(dataDir, "sessions.json");
	let records: Map<string, SessionRecord> | null = null;
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work);
		queue = next.catch(() => undefined);
		return next;
	};
	const loaded = async () => {
		if (records) return records;
		const raw = await readJson(recordsFile);
		const map = new Map<string, SessionRecord>();
		if (isObject(raw)) {
			for (const [id, value] of Object.entries(raw)) {
				const record = normalizeRecord(value);
				if (record) map.set(id, record);
			}
		}
		records = map;
		return map;
	};

	return {
		settings: async () => normalizeSettings(await readJson(settingsFile)),
		saveSettings: (patch) =>
			serial(async () => {
				const next = normalizeSettings({ ...normalizeSettings(await readJson(settingsFile)), ...patch });
				await writeJson(settingsFile, next);
				return next;
			}),
		record: async (sessionId) => (await loaded()).get(sessionId) ?? null,
		setRecord: (sessionId, record) =>
			serial(async () => {
				const map = await loaded();
				if (record) map.set(sessionId, record);
				else map.delete(sessionId);
				await writeJson(recordsFile, Object.fromEntries(map));
			}),
		records: async () => new Map(await loaded()),
	};
}
