/**
 * 跑一个插件的测试（`plume-plugin test`，`plume-plugin check` 也调它）：`test/` 下的 `*.test.ts`（`.mts`、`.js`、`.mjs`）
 * 用 Node 自带的 node:test 跑，插件作者不用装测试框架；随应用发的 SDK 用 Plume 自己的运行时跑。
 *
 * 先用 esbuild 把每个测试打成一个 .mjs（TypeScript、`../src/index.ts` 这类引用打进去），包都留作外部、跑的时候按 Node 的解析
 * 从插件的 node_modules 找（`@plumeai/plugin-sdk/testing`、装了的第三方包、原生模块）。所以打出来的文件放在插件目录的
 * node_modules/.plume-test/ 下，跑完删掉。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build } from "esbuild";

const TEST_FILE = /\.test\.(?:ts|mts|js|mjs)$/;

function testFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) testFiles(path, out);
		else if (TEST_FILE.test(name)) out.push(path);
	}
	return out.sort();
}

/**
 * @param {string} target 插件目录
 * @returns {Promise<"passed" | "failed" | "none">} `none`：没有测试
 */
export async function testPlugin(target) {
	const dir = resolve(target);
	const files = testFiles(join(dir, "test"));
	if (files.length === 0) return "none";

	const out = join(dir, "node_modules/.plume-test");
	rmSync(out, { recursive: true, force: true });
	try {
		await build({
			entryPoints: files,
			outdir: out,
			outbase: dir,
			outExtension: { ".js": ".mjs" },
			bundle: true,
			packages: "external",
			platform: "node",
			format: "esm",
			target: "node22",
			sourcemap: "inline",
			logLevel: "error",
		});
		const bundles = files.map((file) => join(out, relative(dir, file)).replace(TEST_FILE, ".test.mjs"));
		// 随应用发的 SDK 跑在 ELECTRON_RUN_AS_NODE 下，环境变量原样传下去，子进程还是那个运行时当 Node 用。
		const result = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...bundles], { stdio: "inherit", cwd: dir, env: process.env });
		return result.status === 0 ? "passed" : "failed";
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}
