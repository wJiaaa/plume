/**
 * 构建 packages/builtin/（内置插件）下的每个插件。怎么打包由插件 SDK 定（packages/sdk/plugin-sdk/lib/build.mjs），
 * 和插件作者在仓库外用 `plume-plugin build` 的是同一份：仓库里的插件不走另一条路。市场插件在插件仓库里，由它自己构建。
 */

import { cp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildPlugin } from "../packages/sdk/plugin-sdk/lib/build.mjs";

const repo = resolve(import.meta.dirname, "..");
const builtin = join(repo, "packages/builtin");
const dirs = (await readdir(builtin, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(builtin, entry.name));
let failed = false;

// 技能插件随包带上写插件的技能（插件市场的「新建插件」点名它）。正本在仓库根目录的 skills/plume-plugin，
// 每次构建复制一份进技能插件的 skills/（git 忽略），不另存一份手写副本。
const bundledSkill = join(repo, "packages/builtin/skills/skills/plume-plugin");
await rm(bundledSkill, { recursive: true, force: true });
await cp(join(repo, "skills/plume-plugin"), bundledSkill, { recursive: true, dereference: true });

for (const dir of dirs) {
	const name = relative(repo, dir);
	try {
		console.log(`✓ ${name} → ${await buildPlugin(dir)}`);
	} catch (error) {
		// esbuild 的报错它自己已经打过了。
		if (!error?.errors) console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
		failed = true;
	}
}

if (failed) process.exit(1);
