/**
 * 项目配置只覆盖当前工作目录的设置；可共享的文件里不接受供应商和密钥，也不能替人放宽权限。
 *
 * `.plume/config.json` 随仓库提交、被别人克隆，打开就生效，写它的人不是在这台机器上用 Plume 的人。各键按对权限的影响分三类：
 * - 放宽权限：`alwaysAllow`（事先替人答了「以后不再问」，连本体名下读项目外的 `read:<路径>` 也能写）、比本机宽的 `permissionMode`
 *   （帮我批准 → 完全访问之类）。一律不认，见 `withoutLoosening`；要放宽只能人在本机的设置里改、在审批卡上点。
 * - 收紧权限：比本机严的 `permissionMode`（团队要求这个仓库里每次改动都先问）。照常生效。
 * - 与权限无关：`defaultModel`、`favoriteModels`、`imageModel`、`thinking`、`personalization`、`retryPolicy`。照常生效。
 * 供应商、密钥（`PROJECT_FORBIDDEN`）和 `hooks`（钩子插件自己读、要人逐条信任）不进设置。
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigProblem, LayerOverride, PermissionMode, ProjectLayerView } from "@plume/contract";
import { normalizeSettings, settingsView, type StoredSettings } from "./models.ts";
import { text } from "./i18n.ts";

type Plain = Record<string, unknown>;
// magpie 同样能携带供应商密钥，不能绕过 providers 的限制。
const PROJECT_FORBIDDEN = new Set(["providers", "apiKey", "credentials", "githubToken", "mcpServers", "magpie"]);

function isRecord(value: unknown): value is Plain {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 对象递归合并，数组和其他值整体替换；不改全局的那份。 */
export function mergeLayer(base: Plain, over: Plain): Plain {
	return {
		...base,
		...Object.fromEntries(
			Object.entries(over)
				.filter(([, value]) => value !== undefined)
				.map(([key, value]) => [key, isRecord(value) && isRecord(base[key]) ? mergeLayer(base[key], value) : value]),
		),
	};
}

/** 只报告原本存在且被替换的值；对象只列真正变动的叶子。 */
export function layerOverrides(global: Plain, project: Plain, prefix = ""): LayerOverride[] {
	return Object.entries(project).flatMap(([key, value]) => {
		if (value === undefined) return [];
		if (!Object.hasOwn(global, key)) return [];
		const path = prefix ? `${prefix}.${key}` : key;
		const was = global[key];
		if (isRecord(value) && isRecord(was)) return layerOverrides(was, value, path);
		if (was === undefined || JSON.stringify(was) === JSON.stringify(value)) return [];
		return [{ key: path, kind: Array.isArray(value) ? "array" : "scalar", project: value, global: was }];
	});
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".plume", "config.json");
}

/** 钩子能执行本机命令，须由钩子插件独立读取和确认信任，不混入普通设置。 */
export function sanitizeProjectConfig(config: Plain): { config: Plain; refused: string[] } {
	return {
		config: Object.fromEntries(Object.entries(config).filter(([key]) => !PROJECT_FORBIDDEN.has(key) && key !== "hooks")),
		refused: Object.keys(config).filter((key) => PROJECT_FORBIDDEN.has(key)),
	};
}

export async function loadProjectLayer(cwd: string | null): Promise<{ config: Plain; refused: string[]; error?: string; problem?: ConfigProblem }> {
	if (!cwd) return { config: {}, refused: [] };
	const path = projectConfigPath(cwd);
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) return { config: {}, refused: [] };
	try {
		const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		if (!isRecord(parsed)) return { config: {}, refused: [], error: text("project.configNotObject", { path }), problem: { kind: "not-object", path } };
		return sanitizeProjectConfig(parsed);
	} catch (error) {
		// JSON.parse 的错误可能带上配置原文；只传位置，避免其中的密钥进入日志和界面。
		const message = error instanceof Error ? error.message : "";
		const detail = message.match(/at position \d+(?: \(line \d+ column \d+\))?/)?.[0] ?? "Invalid JSON";
		return { config: {}, refused: [], error: text("project.configInvalidJson", { path, error: detail }), problem: { kind: "invalid-json", path, detail } };
	}
}

/** 权限模式由严到宽。 */
const PERMISSION_ORDER: readonly PermissionMode[] = ["ask", "auto", "full"];

/**
 * 拿掉项目层里放宽权限的键，返回剩下的和拿掉的键名（给人看的提示用）。和本机设置比：本机设置随时会改，每次读设置都重新比一次。
 * - `alwaysAllow`：「以后不再问」是人在这台机器上对自己的插件、路径答的，项目里写的一律不认（写成空数组也不认：
 *   它也不该替人撤销批准，撤销在设置页）。
 * - `permissionMode`：比本机的宽、或者认不出时不认。认不出的值合并后会被校验丢掉、落回缺省的帮我批准，本机是请求批准时
 *   等于放宽，所以也算。
 */
function withoutLoosening(global: StoredSettings, layer: Plain): { layer: Plain; loosened: string[] } {
	const loosened: string[] = [];
	const kept = { ...layer };
	if (Object.hasOwn(kept, "alwaysAllow")) {
		delete kept.alwaysAllow;
		loosened.push("alwaysAllow");
	}
	if (Object.hasOwn(kept, "permissionMode") && kept.permissionMode !== undefined) {
		const rank = PERMISSION_ORDER.indexOf(kept.permissionMode as PermissionMode);
		if (rank < 0 || rank > PERMISSION_ORDER.indexOf(global.permissionMode ?? "auto")) {
			delete kept.permissionMode;
			loosened.push("permissionMode");
		}
	}
	return { layer: kept, loosened };
}

/** 重新经过全局设置同一套校验，项目值不能绕过范围和格式限制。 */
export function withProjectLayer(global: StoredSettings, layer: Plain): StoredSettings {
	return Object.keys(layer).length === 0 ? global : normalizeSettings(mergeLayer({ ...global }, layer));
}

export async function layerProjectSettings(global: StoredSettings, cwd: string | null) {
	const { config, ...result } = await loadProjectLayer(cwd);
	const { layer, loosened } = withoutLoosening(global, config);
	return { settings: withProjectLayer(global, layer), layer, loosened, ...result };
}

/** 设置页只拿覆盖项、拒绝和不认的键名，禁止项的值从不跨进程。 */
export async function projectLayerView(global: StoredSettings, cwd: string): Promise<ProjectLayerView> {
	const path = projectConfigPath(cwd);
	const exists = await stat(path).then(
		() => true,
		() => false,
	);
	if (!exists) return { path, exists: false, refused: [], loosened: [], overrides: [] };
	const { config, refused, error, problem } = await loadProjectLayer(cwd);
	const { layer, loosened } = withoutLoosening(global, config);
	return {
		path,
		exists,
		refused,
		loosened,
		...(error ? { error } : {}),
		...(problem ? { problem } : {}),
		overrides: layerOverrides({ ...global, ...settingsView(global) }, layer),
	};
}
