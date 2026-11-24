/**
 * 项目脚本的数据校验、slug 生成、互斥角色维护与 `.plume/scripts.json` 文本解析。
 * 纯函数（不依赖 Node 模块），供逻辑入口、界面入口与单元测试共用。
 */

import { SCRIPT_ICONS, type ProjectScript, type RepoScriptsResult, type ScriptIconId, type ScriptInput, type ScriptsSettings } from "./types.ts";

const ICON_SET = new Set<string>(SCRIPT_ICONS);

export const DEFAULT_SETTINGS: ScriptsSettings = {
	globalScripts: [],
	byProject: {},
};

function isScriptIcon(value: unknown): value is ScriptIconId {
	return typeof value === "string" && ICON_SET.has(value);
}

/** 从脚本名称生成稳定、唯一的 slug id。 */
export function slugifyScriptId(name: string, existingIds: readonly string[]): string {
	const base =
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "script";
	const taken = new Set(existingIds);
	if (!taken.has(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

function cleanInput(input: ScriptInput): ScriptInput {
	const name = input.name.trim();
	const command = input.command.trim();
	const icon: ScriptIconId = isScriptIcon(input.icon) ? input.icon : "play";
	const runOnWorktreeCreate = input.runOnWorktreeCreate === true;
	const waitForSetup = runOnWorktreeCreate && input.waitForSetup === true;
	const stopOnArchive = input.stopOnArchive === true;
	const previewUrl = typeof input.previewUrl === "string" ? input.previewUrl.trim() : "";
	const autoOpenPreview = previewUrl.length > 0 && input.autoOpenPreview === true;
	return {
		name,
		command,
		icon,
		...(runOnWorktreeCreate ? { runOnWorktreeCreate: true } : {}),
		...(waitForSetup ? { waitForSetup: true } : {}),
		...(stopOnArchive ? { stopOnArchive: true } : {}),
		...(previewUrl ? { previewUrl } : {}),
		...(autoOpenPreview ? { autoOpenPreview: true } : {}),
	};
}

function normalizeScript(raw: unknown, existingIds: readonly string[] = []): ProjectScript | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const command = typeof value.command === "string" ? value.command.trim() : "";
	if (!name || !command) return null;
	const rawId = typeof value.id === "string" ? value.id.trim() : "";
	const id = rawId && !existingIds.includes(rawId) ? rawId : slugifyScriptId(name, existingIds);
	const cleaned = cleanInput({
		name,
		command,
		icon: isScriptIcon(value.icon) ? value.icon : "play",
		runOnWorktreeCreate: value.runOnWorktreeCreate === true,
		waitForSetup: value.waitForSetup === true,
		stopOnArchive: value.stopOnArchive === true,
		previewUrl: typeof value.previewUrl === "string" ? value.previewUrl : undefined,
		autoOpenPreview: value.autoOpenPreview === true,
	});
	return { id, ...cleaned };
}

function normalizeScriptList(raw: unknown): ProjectScript[] {
	if (!Array.isArray(raw)) return [];
	const out: ProjectScript[] = [];
	const ids: string[] = [];
	let seenSetup = false;
	for (const entry of raw) {
		const script = normalizeScript(entry, ids);
		if (!script) continue;
		ids.push(script.id);
		// 同一列表内最多保留一个 runOnWorktreeCreate。
		if (script.runOnWorktreeCreate) {
			if (seenSetup) {
				const { runOnWorktreeCreate: _dropRun, waitForSetup: _dropWait, ...rest } = script;
				out.push(rest);
				continue;
			}
			seenSetup = true;
		}
		out.push(script);
	}
	return out;
}

export function normalizeSettings(saved: Record<string, unknown>): ScriptsSettings {
	const globalScripts = normalizeScriptList(saved.globalScripts);
	const byProject: Record<string, ProjectScript[]> = {};
	if (saved.byProject && typeof saved.byProject === "object" && !Array.isArray(saved.byProject)) {
		for (const [projectId, list] of Object.entries(saved.byProject as Record<string, unknown>)) {
			if (typeof projectId !== "string" || !projectId || !Array.isArray(list)) continue;
			byProject[projectId] = normalizeScriptList(list);
		}
	}
	return { globalScripts, byProject };
}

export function hasProjectOverride(settings: ScriptsSettings, projectId: string): boolean {
	return Object.hasOwn(settings.byProject, projectId);
}

/** 获取项目实际生效的脚本列表：有项目覆盖用项目覆盖，否则继承全局默认。 */
export function effectiveScripts(settings: ScriptsSettings, projectId: string | undefined): ProjectScript[] {
	if (projectId && hasProjectOverride(settings, projectId)) return settings.byProject[projectId]!;
	return settings.globalScripts;
}

/** 选出分割按钮的主脚本：优先上次运行的，其次首个非初始化脚本，再次首个脚本。 */
export function primaryScript(scripts: readonly ProjectScript[], preferredId?: string | null): ProjectScript | undefined {
	if (preferredId) {
		const preferred = scripts.find((script) => script.id === preferredId);
		if (preferred) return preferred;
	}
	return scripts.find((script) => !script.runOnWorktreeCreate) ?? scripts[0];
}

/** 找出工作树创建时自动执行的初始化脚本。 */
export function setupScript(scripts: readonly ProjectScript[]): ProjectScript | undefined {
	return scripts.find((script) => script.runOnWorktreeCreate === true);
}

/** 新增或更新脚本，同时维护 `runOnWorktreeCreate` 的互斥唯一性。 */
export function upsertScript(list: readonly ProjectScript[], scriptId: string | null, input: ScriptInput): { scripts: ProjectScript[]; script: ProjectScript } {
	const cleaned = cleanInput(input);
	// i18n-exempt：逻辑层参数校验错误，界面表单会先校验。
	if (!cleaned.name) throw new Error("Script name is required.");
	if (!cleaned.command) throw new Error("Script command is required.");

	const id =
		scriptId && list.some((entry) => entry.id === scriptId)
			? scriptId
			: slugifyScriptId(
					cleaned.name,
					list.map((entry) => entry.id),
				);
	const saved: ProjectScript = { id, ...cleaned };

	// 若新脚本开启了 runOnWorktreeCreate，释放同列表中其他脚本的该角色。
	const releaseOthers = (entry: ProjectScript): ProjectScript => {
		if (!saved.runOnWorktreeCreate || entry.id === saved.id || !entry.runOnWorktreeCreate) return entry;
		const { runOnWorktreeCreate: _dropRun, waitForSetup: _dropWait, ...rest } = entry;
		return rest;
	};

	const exists = list.some((entry) => entry.id === saved.id);
	const scripts = exists ? list.map((entry) => (entry.id === saved.id ? saved : releaseOthers(entry))) : [...list.map(releaseOthers), saved];
	return { scripts, script: saved };
}

export function deleteScriptFromList(list: readonly ProjectScript[], scriptId: string): ProjectScript[] {
	return list.filter((entry) => entry.id !== scriptId);
}

/** 过滤仓库 `.plume/scripts.json` 中尚未导入到当前列表的脚本（按命令或忽略大小写的名称去重）。 */
export function filterImportableScripts(existing: readonly ProjectScript[], repoScripts: readonly ScriptInput[]): ScriptInput[] {
	return repoScripts.filter(
		(candidate) =>
			!existing.some(
				(script) => script.command.trim() === candidate.command.trim() || script.name.trim().toLowerCase() === candidate.name.trim().toLowerCase(),
			),
	);
}

/** 解析 `.plume/scripts.json` 文本内容，只读不执行。 */
export function parseRepoScripts(rawText: string): RepoScriptsResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		// i18n-exempt：JSON 结构校验信息，供设置页提示定位。
		return { status: "invalid", error: 'Root value must be an object containing a "scripts" array.' };
	}
	const root = parsed as Record<string, unknown>;
	if (!Array.isArray(root.scripts)) {
		return { status: "invalid", error: 'Expected a "scripts" array.' };
	}
	const scripts: ScriptInput[] = [];
	for (let i = 0; i < root.scripts.length; i++) {
		const item = root.scripts[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return { status: "invalid", error: `scripts[${i}] must be an object.` };
		}
		const record = item as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		const command = typeof record.command === "string" ? record.command.trim() : "";
		if (!name || !command) {
			return { status: "invalid", error: `scripts[${i}] requires non-empty "name" and "command".` };
		}
		if (record.icon !== undefined && !isScriptIcon(record.icon)) {
			return { status: "invalid", error: `scripts[${i}].icon "${String(record.icon)}" is not supported.` };
		}
		scripts.push(
			cleanInput({
				name,
				command,
				icon: isScriptIcon(record.icon) ? record.icon : "play",
				runOnWorktreeCreate: record.runOnWorktreeCreate === true,
				waitForSetup: record.waitForSetup === true,
				stopOnArchive: record.stopOnArchive === true,
				previewUrl: typeof record.previewUrl === "string" ? record.previewUrl : undefined,
				autoOpenPreview: record.autoOpenPreview === true,
			}),
		);
	}
	return { status: "valid", scripts };
}
