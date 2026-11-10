/**
 * 打包前把要随应用发的、主进程按路径读的东西放进 .stage/（electron-builder.yml 的 extraResources 从这里取）：
 *
 * - builtin/：内置插件，仓库的 packages/builtin/，每个构建好的插件只取发出去的那几样（和市场安装时一样）。
 *
 * 市场插件不随应用发，装的时候从网上的市场下载（src/main/market-remote.ts）。
 *
 * 用法：`node scripts/stage-resources.mjs <platform>-<arch>`，缺省是本机。插件构建时带上了各平台、各架构的原生模块
 * （见插件 SDK 的 lib/targets.mjs），放进来以后按目标只留那一份：.stage 走 extraResources，不经 electron-builder 的
 * `files` 过滤，不在这里裁，mac 的包里就带着 Windows 的 node-pty、koffi。一次打两个架构时 beforePack 每个架构调一次，
 * 每次都从仓库重新放一遍，前一个架构裁掉的不影响后一个。
 *
 * 插件 SDK（plugin-sdk/）也由 beforePack 整理进 .stage/，在这之后：这里先把整个 .stage 清掉。
 *
 * 要先构建插件、生成 SDK 的类型声明；根目录的 `pnpm package` 按顺序都做了。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { trimNative } from "../../../packages/sdk/plugin-sdk/lib/targets.mjs";

const desktop = resolve(import.meta.dirname, "..");
const repo = resolve(desktop, "../..");
const stage = join(desktop, ".stage");
/** 和 src/main/market.ts 的 SHIPPED 一致。 */
const SHIPPED = ["package.json", "README.md", "images", "icon.png", "dist", "skills"];
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;

rmSync(stage, { recursive: true, force: true });
for (const [from, to] of [["packages/builtin", "builtin"]]) {
	const catalog = join(repo, from);
	for (const entry of readdirSync(catalog, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const source = join(catalog, entry.name);
		if (!existsSync(join(source, "dist/index.mjs"))) throw new Error(`插件 ${entry.name} 没构建：先 pnpm build:plugins`);
		const dir = join(stage, to, entry.name);
		mkdirSync(dir, { recursive: true });
		for (const name of SHIPPED) {
			if (existsSync(join(source, name))) cpSync(join(source, name), join(dir, name), { recursive: true });
		}
		const removed = trimNative(join(dir, "dist", "node_modules"), target);
		if (removed.length > 0) console.log(`[stage] ${to}/${entry.name}（${target}）去掉 ${removed.length} 份别的平台的原生模块`);
	}
}
