/**
 * 拿这个仓库的插件 SDK 构建插件仓库（plume-plugins），打出一份本机用的市场目录，给冒烟用（`PLUME_SMOKE_MARKET=<目录> pnpm smoke`）。
 *
 *   pnpm market:local [<插件仓库>] [--out <目录>]          打出市场目录，缺省 .smoke/market
 *   pnpm market:local [<插件仓库>] -- <命令> [<参数>...]   不打市场，换上本地 SDK 后在插件仓库里跑这条命令（如 pnpm check）
 *
 * 插件仓库缺省取 PLUME_PLUGINS_DIR（<插件仓库>/plugins）的上一级。改插件接口时线上的插件和 npm 上的 SDK 都跟不上，
 * 用这一条在本机先把插件仓库对着新接口构建、检查一遍，冒烟也装这一份。
 *
 * 做法：生成 SDK 的类型声明，整理成发 npm 的那一份、`npm pack` 成 tgz；在插件仓库的 pnpm-workspace.yaml 里临时加一条
 * `overrides` 指向它、`pnpm install`，构建插件、`scripts/build-dist.mjs` 只打本机平台的包（或跑给的命令）。
 * 不管成没成，最后都还原插件仓库的 pnpm-workspace.yaml、pnpm-lock.yaml 并按原来的锁文件重装：这两个文件动手前必须是干净的。
 * 只按路径起插件仓库自己的命令，不引用它的文件（.dependency-cruiser.cjs 的 no-plugin-repo）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const repo = resolve(import.meta.dirname, "..");
const sdk = join(repo, "packages/sdk/plugin-sdk");
/** 临时改动、用完还原的两个文件。 */
const TOUCHED = ["pnpm-workspace.yaml", "pnpm-lock.yaml"];

const split = process.argv.indexOf("--", 2);
const command = split < 0 ? [] : process.argv.slice(split + 1);
const { values, positionals } = parseArgs({
	args: process.argv.slice(2, split < 0 ? undefined : split),
	options: { out: { type: "string" } },
	allowPositionals: true,
});
const fromEnv = process.env.PLUME_PLUGINS_DIR && dirname(resolve(process.env.PLUME_PLUGINS_DIR));
const plugins = positionals[0] ? resolve(positionals[0]) : fromEnv;
if (!plugins) fail("用法：pnpm market:local <插件仓库> [--out <目录>] [-- <命令>...]（或设 PLUME_PLUGINS_DIR=<插件仓库>/plugins）");
if (!existsSync(join(plugins, "scripts/build-dist.mjs"))) fail(`${plugins} 不像插件仓库：没有 scripts/build-dist.mjs`);
const out = resolve(values.out ?? join(repo, ".smoke/market"));
const dirty = spawnSync("git", ["status", "--porcelain", "--", ...TOUCHED], { cwd: plugins, encoding: "utf8" });
if (dirty.status !== 0) fail(`读不了插件仓库的 git 状态：${dirty.stderr}`);
if (dirty.stdout.trim()) fail(`插件仓库的 ${TOUCHED.join("、")} 有没提交的改动，先处理掉（这里用完会还原它们）`);
if (/^overrides:/m.test(await readFile(join(plugins, "pnpm-workspace.yaml"), "utf8"))) fail("插件仓库的 pnpm-workspace.yaml 已经有 overrides，这里不合并");

// Ctrl-C 时子进程自己会停，这里不跟着退出，好走到下面的还原。
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const work = await mkdtemp(join(tmpdir(), "plume-sdk-"));
let touched = false;
let failed = false;
try {
	await run("pnpm", ["--filter", "@plumeai/plugin-sdk...", "typecheck"], repo);
	await run("node", [join(sdk, "scripts/stage.mjs"), join(work, "sdk"), "--npm"], repo);
	await run("npm", ["pack", "--silent", "--pack-destination", work], join(work, "sdk"));
	const tarball = (await readdir(work)).find((name) => name.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack 没有打出 tgz");
	touched = true;
	await appendFile(
		join(plugins, "pnpm-workspace.yaml"),
		`\n# 临时：scripts/local-market.mjs 换上本地构建的 SDK，用完还原\noverrides:\n  "@plumeai/plugin-sdk": "file:${join(work, tarball)}"\n`,
	);
	await run("pnpm", ["install", "--no-frozen-lockfile"], plugins);
	if (command.length > 0) await run(command[0], command.slice(1), plugins);
	else {
		await run("pnpm", ["build:plugins"], plugins);
		await run("node", ["scripts/build-dist.mjs", "--out", out, "--targets", `${process.platform}-${process.arch}`], plugins);
		console.log(`\n本地市场：${out}\n冒烟用它：PLUME_SMOKE_MARKET=${out} pnpm smoke`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	failed = true;
} finally {
	if (touched) {
		console.log(`还原插件仓库的 ${TOUCHED.join("、")} 和依赖`);
		await run("git", ["checkout", "--", ...TOUCHED], plugins).catch(() => (failed = true));
		await run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], plugins).catch(() => (failed = true));
	}
	await rm(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

function run(file, args, cwd) {
	return new Promise((done, reject) => {
		const child = spawn(file, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? done() : reject(new Error(`${file} ${args.join(" ")} 失败（${code}）`))));
	});
}

function fail(message) {
	console.error(message);
	process.exit(1);
}
