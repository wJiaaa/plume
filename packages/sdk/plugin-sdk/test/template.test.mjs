/**
 * 模板是对外的：拿不到 Plume 源码的人 init 出来就要能过类型检查、能构建、产物能被宿主加载。
 * 这里在仓库外的临时目录里 init 一个插件（独立项目：不经 npm，init 自己把 SDK 链进 node_modules），跑一遍类型检查和构建。
 * 需要先生成 SDK 的类型声明（包的 typecheck 脚本），pnpm check 里 typecheck 在 test 前面。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { pathToFileURL } from "node:url";
import { buildPlugin } from "../lib/build.mjs";
import { checkPlugin } from "../lib/check.mjs";
import { initPlugin } from "../lib/init.mjs";
import { installPlugin } from "../lib/install.mjs";
import { packPlugin } from "../lib/pack.mjs";

const sdk = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "plume-plugin-sdk-"));
const dir = join(work, "hello-world");

beforeAll(() => {
	assert.ok(existsSync(join(sdk, "dist/ui.d.ts")), "先生成 SDK 的类型声明：pnpm --filter @plumeai/plugin-sdk typecheck");
	initPlugin(dir);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

test("init 出独立项目：不写依赖，SDK 链进 node_modules，带上 skill 和给 agent 的说明", () => {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	assert.equal(pkg.devDependencies, undefined);
	assert.equal(realpathSync(join(dir, "node_modules/@plumeai/plugin-sdk")), realpathSync(sdk));
	for (const name of ["@types/node", "@types/react"]) assert.ok(existsSync(join(dir, "node_modules", name, "package.json")), name);
	for (const file of ["AGENTS.md", "CLAUDE.md", ".gitignore", ".claude/skills/plume-plugin/SKILL.md", "src/index.ts", "src/ui.tsx"]) {
		assert.ok(existsSync(join(dir, file)), file);
	}
	assert.doesNotMatch(readFileSync(join(dir, "src/index.ts"), "utf8"), /__NAME__|__TOOL__/);
});

test("模板只靠 SDK 就能过类型检查和插件规则（含 @plume/ui/icons）", async () => {
	// 加一个图标，顺带验证 @plume/ui/icons 的类型和构建。
	const ui = join(dir, "src/ui.tsx");
	const source = readFileSync(ui, "utf8");
	assert.match(source, /^import .* from "@plume\/ui";$/m);
	writeFileSync(
		ui,
		source
			.replace(/^import .* from "@plume\/ui";$/m, '$&\nimport { Smile } from "@plume/ui/icons";')
			.replace("<Card title={text.greeting}>", "<Card title={text.greeting}>\n\t\t\t<Smile size={14} />"),
	);
	assert.ok(await checkPlugin(dir));
});

test("构建出的产物：逻辑入口能加载，界面入口把共享模块留给宿主、图标打进去", async () => {
	await buildPlugin(dir);
	const logic = (await import(pathToFileURL(join(dir, "dist/index.mjs")).href)).default;
	assert.equal(logic.name, "hello-world");
	assert.equal(typeof logic.apply, "function");

	const ui = readFileSync(join(dir, "dist/ui.mjs"), "utf8");
	assert.match(ui, /from\s*"@plume\/ui"/);
	assert.match(ui, /from\s*"react\/jsx-runtime"/);
	assert.doesNotMatch(ui, /from\s*"lucide-react"/);
	assert.doesNotMatch(ui, /from\s*"@plume\/ui\/icons"/);
});

test("界面入口里 import() 的模块拆到 dist/chunks，不进启动就加载的 ui.mjs；重新构建不留旧文件", async () => {
	const marker = "plume-split-chunk-marker";
	const ui = join(dir, "src/ui.tsx");
	const heavy = join(dir, "src/heavy.ts");
	const source = readFileSync(ui, "utf8");
	writeFileSync(heavy, `export const marker = ${JSON.stringify(marker)};\n`);
	writeFileSync(ui, `${source}\nexport const loadHeavy = () => import("./heavy.ts");\n`);
	try {
		await buildPlugin(dir);
		assert.doesNotMatch(readFileSync(join(dir, "dist/ui.mjs"), "utf8"), new RegExp(marker));
		const chunks = readdirSync(join(dir, "dist/chunks"));
		assert.ok(chunks.some((name) => readFileSync(join(dir, "dist/chunks", name), "utf8").includes(marker)));
	} finally {
		writeFileSync(ui, source);
		rmSync(heavy);
	}
	await buildPlugin(dir);
	assert.ok(!existsSync(join(dir, "dist/chunks")));
});

test("install 复制说明和产物，不带源码", () => {
	const target = installPlugin(dir, join(work, "installed"));
	assert.ok(existsSync(join(target, "dist/index.mjs")));
	assert.ok(existsSync(join(target, "package.json")));
	assert.ok(!existsSync(join(target, "src")));
});

test("构建写下用哪一版 SDK：dist/build.json", () => {
	const version = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version;
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "dist/build.json"), "utf8")), { sdk: version });
});

test("SDK 的链接被删了（npm 装包会这样）：check 自己链回来再查", async () => {
	rmSync(join(dir, "node_modules/@plumeai"), { recursive: true, force: true });
	assert.ok(await checkPlugin(dir));
	assert.equal(realpathSync(join(dir, "node_modules/@plumeai/plugin-sdk")), realpathSync(sdk));
});

test("pack 打出只含发给插件的文件的文件夹，说出发市场前还缺什么；不许打进 dist/", async () => {
	const out = join(work, "packed");
	const packed = await packPlugin(dir, out);
	assert.equal(packed.dir, join(out, "hello-world"));
	assert.ok(existsSync(join(packed.dir, "dist/index.mjs")));
	assert.ok(existsSync(join(packed.dir, "package.json")));
	assert.ok(!existsSync(join(packed.dir, "src")));
	assert.ok(!existsSync(join(packed.dir, "node_modules")));
	assert.ok(packed.problems.some((problem) => problem.includes("description")));
	await assert.rejects(packPlugin(dir, join(dir, "dist")));
});
