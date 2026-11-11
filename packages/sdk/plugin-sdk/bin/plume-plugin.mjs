#!/usr/bin/env node
/**
 * plume-plugin：新建、检查、构建、安装 Plume 插件。随 Plume 应用发，应用启动时生成 `~/.plume/bin/plume-plugin`，
 * 用 Plume 自己的运行时跑这个文件，插件作者的机器上不用装 Node 和 npm。
 *
 *   plume-plugin init <目录> [--name 插件名] [--display 市场里的名字]
 *   plume-plugin check [目录]              类型检查和插件规则（公开接口、样式、文案），缺省当前目录
 *   plume-plugin build [目录]
 *   plume-plugin install [目录] [--to 目录]  装进 ~/.plume/local-plugins，Plume 开着就当场加载
 *   plume-plugin dev [目录] [--to 目录]      构建、装上，之后一改源码就重新来一遍
 *   plume-plugin link [目录]               重新链到这份 SDK（Plume 挪了位置、npm 删了链接时）
 */

import { buildPlugin } from "../lib/build.mjs";
import { checkPlugin } from "../lib/check.mjs";
import { devPlugin } from "../lib/dev.mjs";
import { initPlugin } from "../lib/init.mjs";
import { installPlugin } from "../lib/install.mjs";
import { linkSdk } from "../lib/link.mjs";

const USAGE = `用法：
  plume-plugin init <目录> [--name 插件名] [--display 市场里的名字]
  plume-plugin check [目录]
  plume-plugin build [目录]
  plume-plugin install [目录] [--to 目录]
  plume-plugin dev [目录] [--to 目录]
  plume-plugin link [目录]`;

const [command, ...rest] = process.argv.slice(2);
const positional = [];
const flags = {};
for (let index = 0; index < rest.length; index++) {
	const arg = rest[index];
	if (arg.startsWith("--")) flags[arg.slice(2)] = rest[++index];
	else positional.push(arg);
}
const dir = positional[0] ?? process.cwd();

try {
	if (command === "init") {
		if (!positional[0]) throw new Error(USAGE);
		const created = initPlugin(positional[0], { name: flags.name, displayName: flags.display });
		console.log(`✓ ${created.name} → ${created.dir}`);
		console.log(
			created.workspace
				? "  在仓库根目录跑 pnpm install，再 pnpm build:plugins"
				: "  写法见 .claude/skills/plume-plugin/SKILL.md；写完 plume-plugin check、plume-plugin dev",
		);
	} else if (command === "check") {
		if (!(await checkPlugin(dir))) process.exitCode = 1;
		else console.log("✓ 检查通过");
	} else if (command === "build") {
		console.log(`✓ ${await buildPlugin(dir)}`);
	} else if (command === "install") {
		console.log(`✓ 装到 ${installPlugin(dir, flags.to)}；Plume 开着的话已经加载`);
	} else if (command === "dev") {
		devPlugin(dir, { root: flags.to });
		console.log("盯着 src/、package.json、README.md，改了就重新构建、装上；Ctrl+C 结束");
	} else if (command === "link") {
		linkSdk(dir);
		console.log("✓ 已链到这份 SDK");
	} else {
		console.log(USAGE);
		if (command && command !== "help" && command !== "--help") process.exitCode = 1;
	}
} catch (error) {
	// esbuild 的报错它自己已经打过了。
	if (!error?.errors) console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
