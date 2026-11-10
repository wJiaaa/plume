/**
 * 版本号写在哪些地方。
 *
 * 应用自己报的版本（`app.getVersion()`、安装包名、自动更新的比较）取 `apps/desktop/package.json`，它说了算；
 * 别的产品包跟着它一起改，免得几份 package.json 各说各的。插件（`packages/builtin/`、插件仓库的 `plugins/`）不在里面：
 * 插件经市场单独发版，版本归插件自己。
 *
 * 清单按目录现算，不手写：新加一个包不用记得来这里登记。内部依赖写的是 `workspace:*`，不受影响。
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 说了算的那份，别的都改成和它一样。 */
export const SOURCE = "apps/desktop/package.json";

/** `<目录>/*` 下带 package.json 的子目录。 */
function packagesUnder(relative) {
	return readdirSync(join(ROOT, relative), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(ROOT, relative, entry.name, "package.json")))
		.map((entry) => `${relative}/${entry.name}/package.json`);
}

export const MANIFESTS = [
	...packagesUnder("apps"),
	"packages/contract/package.json",
	...readdirSync(join(ROOT, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "builtin" && entry.name !== "contract")
		.flatMap((entry) => packagesUnder(`packages/${entry.name}`)),
].sort();

export async function readVersion(relative) {
	const manifest = JSON.parse(await readFile(join(ROOT, relative), "utf8"));
	return manifest.version;
}

/**
 * 只改版本号那一处，文件其余部分一个字节不动。
 *
 * 用正则而不是 `JSON.parse` 再 `stringify`：重新序列化会把一行的改动变成整个文件的 diff，把真正的改动淹掉。
 */
export async function writeVersion(relative, version) {
	const path = join(ROOT, relative);
	const text = await readFile(path, "utf8");
	const pattern = /("version"\s*:\s*")([^"]+)(")/;
	if (!pattern.test(text)) throw new Error(`${relative} 里找不到 version 字段`);
	await writeFile(path, text.replace(pattern, `$1${version}$3`));
}
