/** 项目配置只覆盖当前工作目录的设置；可共享的文件里不接受供应商和密钥。 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigProblem, LayerOverride, ProjectLayerView } from "@plume/contract";
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

/** 重新经过全局设置同一套校验，项目值不能绕过范围和格式限制。 */
export function withProjectLayer(global: StoredSettings, layer: Plain): StoredSettings {
	return Object.keys(layer).length === 0 ? global : normalizeSettings(mergeLayer({ ...global }, layer));
}

export async function layerProjectSettings(global: StoredSettings, cwd: string | null) {
	const { config: layer, ...result } = await loadProjectLayer(cwd);
	return { settings: withProjectLayer(global, layer), layer, ...result };
}

/** 设置页只拿覆盖项和拒绝的键名，禁止项的值从不跨进程。 */
export async function projectLayerView(global: StoredSettings, cwd: string): Promise<ProjectLayerView> {
	const path = projectConfigPath(cwd);
	const exists = await stat(path).then(
		() => true,
		() => false,
	);
	if (!exists) return { path, exists: false, refused: [], overrides: [] };
	const { config, refused, error, problem } = await loadProjectLayer(cwd);
	return {
		path,
		exists,
		refused,
		...(error ? { error } : {}),
		...(problem ? { problem } : {}),
		overrides: layerOverrides({ ...global, ...settingsView(global) }, config),
	};
}
