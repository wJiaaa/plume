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

it("项目配置只能收紧权限：放宽权限模式、写批准名单都不认并报出键名，收紧的照常生效", async () => {
	const global: StoredSettings = normalizeSettings({ providers: [], permissionMode: "auto", alwaysAllow: [{ plugin: "p", subject: "mine" }] });
	const grants = [{ subject: "read:/" }, { plugin: "plume.tools", subject: "rm -rf /" }];
	await writeFile(projectConfigPath(dir), JSON.stringify({ permissionMode: "full", alwaysAllow: grants, thinking: "high" }));
	const loose = await layerProjectSettings(global, dir);
	expect(loose.settings).toEqual({ ...global, thinking: "high" });
	expect(loose.loosened).toEqual(["alwaysAllow", "permissionMode"]);
	expect(loose.layer).toEqual({ thinking: "high" });
	const view = await projectLayerView(global, dir);
	expect(view.loosened).toEqual(["alwaysAllow", "permissionMode"]);
	expect(view.overrides.map((one) => one.key)).toEqual(["thinking"]);
	// 撤销批准也不归项目配置管：空数组同样不认，本机的批准留着。
	await writeFile(projectConfigPath(dir), JSON.stringify({ alwaysAllow: [] }));
	expect((await layerProjectSettings(global, dir)).settings.alwaysAllow).toEqual([{ plugin: "p", subject: "mine" }]);
	// 收紧：本机帮我批准，项目要求请求批准，照常生效；和本机一样宽的也照常，不算放宽。
	await writeFile(projectConfigPath(dir), JSON.stringify({ permissionMode: "ask" }));
	expect(await layerProjectSettings(global, dir)).toMatchObject({ settings: { permissionMode: "ask" }, loosened: [] });
	await writeFile(projectConfigPath(dir), JSON.stringify({ permissionMode: "auto" }));
	expect(await layerProjectSettings(global, dir)).toMatchObject({ settings: { permissionMode: "auto" }, loosened: [] });
	// 本机是请求批准时，项目的帮我批准、认不出的值（合并后会落回缺省的帮我批准）都是放宽。
	const strict: StoredSettings = { providers: [], permissionMode: "ask" };
	for (const permissionMode of ["auto", "full", "bogus", null]) {
		await writeFile(projectConfigPath(dir), JSON.stringify({ permissionMode }));
		expect(await layerProjectSettings(strict, dir)).toMatchObject({ settings: { permissionMode: "ask" }, loosened: ["permissionMode"] });
	}
	// 本机完全访问时项目的任何一档都不比它宽。
	await writeFile(projectConfigPath(dir), JSON.stringify({ permissionMode: "full" }));
	expect(await layerProjectSettings({ providers: [], permissionMode: "full" }, dir)).toMatchObject({ settings: { permissionMode: "full" }, loosened: [] });
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
		loosened: [],
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
