/**
 * 找「代码在、功能不在」。
 *
 *   node --experimental-transform-types test/tool-eval/wiring-scan.ts [base-ref]
 *
 * 不给 `base-ref` 时用本地的 `main`，没有就用 `master`。
 *
 * 一种反复出现、而且每次都是碰上而不是查出来的模式：一个字段解析得很仔细、一个模块测得很全，产品里却没有任何东西调用它——
 * 可选字段没人读、整个执行侧不存在（读结果的那条线接好了，写它的那条从不运行）、提示词向模型承诺了一件代码里零引用的事、
 * 一份「项目级配置」从来没被打开过。
 *
 * 判据很粗，也只能粗：相对 `base-ref` 改动过的产品源文件（`apps/`、`packages/`；市场插件在插件仓库里，不在这里查）里导出的**值**（函数、常量、类），
 * 如果在产品代码里没有任何引用——测试不算，`index.ts` 那种再导出也不算（摆上货架不等于有人用）——就值得看一眼。
 * 和 knip 不同：knip 回答「这个导出删了会不会坏」，测试用到了就算有人用；这里问的是「产品有没有在跑它」。
 *
 * 它会误报，而且方向是固定的：同文件内部用的辅助函数、留给以后的接口、诊断工具。输出里标了「同文件也在用」——那一类基本可以跳过，
 * 剩下的才要一个个看。
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** 产品代码在这几处；`scripts/`、`test/` 是开发用的，不算引用。 */
const PRODUCT_DIRS = ["apps", "packages"];

const say = (line = "") => process.stderr.write(`${line}\n`);
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const OFF = "\x1b[0m";

/**
 * 只看值：函数、常量、类。
 *
 * `interface` 和 `type` 会把结果淹掉，而且淹得没有信息量——一个只在自己文件里当参数类型用的导出接口完全正常。
 * 这里要找的是「有人写了一段会跑的代码，而没有任何东西会去跑它」。
 */
const EXPORT = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;

/** 构建产物、依赖和打包暂存目录里的不是源码。 */
const SKIP_DIRS = new Set(["node_modules", "out", "dist", "release", "vendor"]);

async function sourceFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
		else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

const isTestPath = (path: string) => path.includes("/test/") || /\.test\.tsx?$/.test(path);

async function defaultBase(): Promise<string> {
	for (const ref of ["main", "master"]) {
		const found = await run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT }).then(
			() => true,
			() => false,
		);
		if (found) return ref;
	}
	throw new Error("本地没有 main 也没有 master，给一个 base-ref");
}

async function main(): Promise<void> {
	const base = process.argv[2] ?? (await defaultBase());
	const { stdout } = await run("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT });
	const changed = stdout
		.split("\n")
		.filter((path) => /\.(ts|tsx|mts)$/.test(path) && PRODUCT_DIRS.some((dir) => path.startsWith(`${dir}/`)) && !isTestPath(path));

	/*
	 * 先去掉再导出的那几行，而不是把整个文件跳过：一个既是货架、又真的在组装工具表的文件（比如插件的 `tools.ts`），
	 * 按文件跳会把它里面每一次真实使用一起丢掉，扫描器就会报出一个注册得好好的工具。查「有没有人用」的工具，自己先漏报，
	 * 是最不该发生的事。
	 */
	const bodies = new Map<string, string>();
	for (const dir of PRODUCT_DIRS) {
		for (const path of await sourceFiles(join(ROOT, dir))) {
			const raw = await readFile(path, "utf8");
			bodies.set(path, raw.replace(/^export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gm, ""));
		}
	}

	const suspects: { name: string; file: string; testOnly: boolean; sameFile: boolean }[] = [];
	for (const rel of changed) {
		const abs = join(ROOT, rel);
		const source = bodies.get(abs);
		if (!source) continue;

		for (const match of source.matchAll(EXPORT)) {
			const name = match[1]!;
			const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);

			let testOnly = false;
			let used = false;
			for (const [path, body] of bodies) {
				if (path === abs || !word.test(body)) continue;
				if (isTestPath(relative(ROOT, path))) testOnly = true;
				else {
					used = true;
					break;
				}
			}
			if (used) continue;

			// 定义之外还出现过 = 同文件自己在用，多半是顺手导出的内部辅助。
			const inOwnFile = (source.match(new RegExp(word.source, "g")) ?? []).length > 1;
			suspects.push({ name, file: rel, testOnly, sameFile: inOwnFile });
		}
	}

	const real = suspects.filter((s) => !s.sameFile);
	say(`\n扫了 ${changed.length} 个相对 ${base} 改动过的源文件\n`);

	if (real.length === 0) {
		say("没有找到产品代码里无人调用的导出。\n");
	} else {
		say(`${RED}${real.length} 个导出，产品代码里没有调用者${OFF}：\n`);
		for (const item of real) say(`  ${item.name.padEnd(28)} ${item.file}  ${item.testOnly ? "（只有测试用）" : "（连测试都没有）"}`);
		say("");
	}

	const skipped = suspects.length - real.length;
	if (skipped > 0) say(`${DIM}另有 ${skipped} 个只在自己文件里用（内部辅助顺手导出的，通常不是问题）。${OFF}\n`);
}

await main();
