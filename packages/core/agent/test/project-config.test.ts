import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { normalizeSettings, type StoredSettings } from "../src/models.ts";
import {
	layerOverrides,
	layerProjectSettings,
	loadProjectLayer,
	mergeLayer,
	projectConfigPath,
	projectLayerView,
	sanitizeProjectConfig,
	withProjectLayer,
} from "../src/project-config.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-project-config-"));
	await mkdir(join(dir, ".plume"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("对象深合并，数组和标量替换，undefined 保留原值，null 真正替换", () => {
	const global = { personalization: { tone: "friendly", customInstructions: "global" }, alwaysAllow: ["a"], thinking: "medium", defaultModel: "p/main" };
	expect(mergeLayer(global, { personalization: { tone: "concise" }, alwaysAllow: [], thinking: undefined, defaultModel: null })).toEqual({
		personalization: { tone: "concise", customInstructions: "global" },
		alwaysAllow: [],
		thinking: "medium",
		defaultModel: null,
	});
	expect(global.personalization.tone).toBe("friendly");
	expect(global.alwaysAllow).toEqual(["a"]);
});

it("只报告确实替换的叶子，忽略新增值和相同值", () => {
	expect(
		layerOverrides(
			{ personalization: { tone: "friendly", customInstructions: "same" }, alwaysAllow: ["a"] },
			{
				personalization: { tone: "concise", customInstructions: "same" },
				alwaysAllow: ["b"],
				thinking: "high",
			},
		),
	).toEqual([
		{ key: "personalization.tone", kind: "scalar", global: "friendly", project: "concise" },
		{ key: "alwaysAllow", kind: "array", global: ["a"], project: ["b"] },
	]);
});

it("供应商、MCP、凭据和 Magpie 均拒绝，钩子不混入配置", () => {
	const forbidden = ["providers", "apiKey", "credentials", "githubToken", "mcpServers", "magpie"];
	const { config, refused } = sanitizeProjectConfig({ ...Object.fromEntries(forbidden.map((key) => [key, "secret"])), hooks: [], permissionMode: "ask" });
	expect(config).toEqual({ permissionMode: "ask" });
	expect(refused).toEqual(forbidden);
	expect(JSON.stringify({ config, refused })).not.toContain("secret");
});

it("读取工作目录自己的配置，接受 BOM，不向上找", async () => {
	await writeFile(projectConfigPath(dir), '\uFEFF{"permissionMode":"ask","defaultModel":"p/cheap"}');
	expect(await layerProjectSettings({ providers: [], permissionMode: "full" }, dir)).toMatchObject({
		settings: { permissionMode: "ask", defaultModel: "p/cheap" },
	});
	expect(await loadProjectLayer(join(dir, "nested"))).toEqual({ config: {}, refused: [] });
	expect(await loadProjectLayer(null)).toEqual({ config: {}, refused: [] });
});

it("项目值与全局共用校验，保留全局供应商和嵌套的其他值", async () => {
	const global: StoredSettings = normalizeSettings({
		providers: [],
		permissionMode: "full",
		personalization: { tone: "friendly", customInstructions: "global" },
	});
	await writeFile(
		projectConfigPath(dir),
		JSON.stringify({ permissionMode: "ask", personalization: { tone: "unknown" }, thinking: "invalid", providers: [{ apiKey: "secret" }] }),
	);
	const result = await layerProjectSettings(global, dir);
	expect(result.settings).toEqual({ providers: [], permissionMode: "ask", personalization: { customInstructions: "global" } });
	expect(global.permissionMode).toBe("full");
	expect(withProjectLayer(global, {})).toBe(global);
});

it("坏 JSON 和非对象回落全局并报告，错误不带文件原文", async () => {
	const global: StoredSettings = { providers: [], permissionMode: "auto" };
	await writeFile(projectConfigPath(dir), "secret-never-in-error");
	const result = await layerProjectSettings(global, dir);
	expect(result.settings).toBe(global);
	expect(result.problem?.kind).toBe("invalid-json");
	expect(JSON.stringify(result)).not.toContain("secret-never-in-error");
	await writeFile(projectConfigPath(dir), "[]");
	expect((await loadProjectLayer(dir)).problem?.kind).toBe("not-object");
});

it("设置页报告生效默认值的覆盖和拒绝键，不传密钥", async () => {
	await writeFile(projectConfigPath(dir), JSON.stringify({ permissionMode: "ask", apiKey: "private-key", magpie: { apiKey: "gateway-key" } }));
	const view = await projectLayerView({ providers: [] }, dir);
	expect(view).toEqual({
		path: projectConfigPath(dir),
		exists: true,
		refused: ["apiKey", "magpie"],
		overrides: [{ key: "permissionMode", kind: "scalar", global: "auto", project: "ask" }],
	});
	expect(JSON.stringify(view)).not.toContain("private-key");
	expect(JSON.stringify(view)).not.toContain("gateway-key");
	expect(await projectLayerView({ providers: [] }, join(dir, "missing"))).toMatchObject({ exists: false, refused: [], overrides: [] });
});

it("配置对象的原型键不污染合并后的继承字段", () => {
	const layer = JSON.parse('{"__proto__":{"permissionMode":"full"}}') as Record<string, unknown>;
	expect(withProjectLayer({ providers: [] }, layer).permissionMode).toBeUndefined();
	expect(Object.getPrototypeOf(mergeLayer({}, layer))).toBe(Object.prototype);
	expect(layerOverrides({}, JSON.parse('{"constructor":"x","__proto__":{"permissionMode":"full"}}') as Record<string, unknown>)).toEqual([]);
});
