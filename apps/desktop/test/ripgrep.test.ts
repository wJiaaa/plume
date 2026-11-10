/**
 * 主进程去找的 ripgrep（main/ripgrep.ts），就是安装包放进去的那一份。
 *
 * 两处对不上时什么也不报：应用照常启动，`grep` 工具找不到随包的 rg 就去 `PATH`，找不到再退回
 * JavaScript 扫描——只是每次搜索慢几十倍。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundledRipgrep } from "../src/main/ripgrep.ts";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const config = readFileSync(join(desktop, "electron-builder.yml"), "utf8");

for (const [key, platform, exe] of [
	["mac", "darwin", "rg"],
	["win", "win32", "rg.exe"],
] as const) {
	test(`${platform}：打包放的位置和主进程找的位置是同一个`, () => {
		// 没有 yaml 解析器可用，按 electron-builder.yml 里那一条的写法认。
		const entry = new RegExp(`- from: (vendor/ripgrep/${platform}-\\$\\{arch\\})\\n\\s+to: (\\S+)\\n\\s+filter: \\[([^\\]]*)\\]`).exec(config);
		assert.ok(entry, `${key}.extraResources 里没有 ripgrep`);
		const [, from = "", to = "", filter = ""] = entry;
		assert.ok(filter.includes(`"${exe}"`), `过滤规则把 ${exe} 本身滤掉了`);

		const packaged = bundledRipgrep({ platform, arch: "arm64", packaged: true, appPath: "/app.asar", resourcesPath: "/res" });
		assert.equal(packaged, join("/res", to, exe));

		// 开发时直接读 fetch-ripgrep.mjs 放的目录，打包时 `${arch}` 展开成的也是这个目录。
		const dev = bundledRipgrep({ platform, arch: "arm64", packaged: false, appPath: desktop, resourcesPath: "" });
		assert.equal(dev, join(desktop, from.replace("${arch}", "arm64"), exe));
	});
}

test("打包前由 fetch-ripgrep.mjs 备好正在打的那一份", () => {
	// beforePack 只能挂一个脚本，before-pack.mjs 把 rg 和插件 SDK 的二进制排在一起。
	assert.match(config, /^beforePack: \.\/scripts\/before-pack\.mjs$/m);
	const hook = readFileSync(join(desktop, "scripts", "before-pack.mjs"), "utf8");
	assert.match(hook, /from "\.\/fetch-ripgrep\.mjs"/);
	assert.match(hook, /fetchRipgrepForBuild\(context\)/);
});
