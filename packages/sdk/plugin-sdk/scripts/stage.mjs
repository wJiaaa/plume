/**
 * 把 SDK 整理成发出去的一份，两种：
 *
 * - `node scripts/stage.mjs <输出目录> --npm`：发 npm 的包（scripts/publish.mjs 整理到临时目录再 `npm publish`）。只放下面的命令、
 *   类型声明、tsconfig.json、模板、skill、LICENSE 和去掉开发依赖的 package.json，依赖由装它的人的包管理器装。源码目录的 package.json
 *   写着 private，防的是直接在源码目录里发（那里没有 skill/）；这里去掉它。
 * - `node scripts/stage.mjs <输出目录> [<platform>-<arch>]`：随 Plume 应用发的一份，平台和架构缺省是本机。
 *
 * 随应用发的这份不经 npm，自己带齐运行要的东西：
 * - 命令（bin/、lib/）、类型声明（dist/，先跑包的 typecheck 生成）、tsconfig.json、模板、skill（从仓库根目录的 skills/plume-plugin 复制）；
 * - node_modules：dependencies 和它们的依赖，平铺、解引用（pnpm 的链接发不出去）。可选依赖按 package.json 的
 *   `os`、`cpu` 只带给目标平台和架构的那份（esbuild、typescript 按平台分的二进制包）：node_modules 里有别的平台
 *   的包时（换过机器、装过别的架构），不挑的话一份 SDK 会带上二十几个平台的二进制，近 1 GB。目标的那份不在就报错，
 *   不发一个跑不起来的 SDK。peerDependencies 不带：lucide-react 要的 react 构建时留作外部，运行时由宿主提供。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const sdk = resolve(import.meta.dirname, "..");
const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error("用法：node scripts/stage.mjs <输出目录> [<platform>-<arch> | --npm]");
const npm = process.argv[3] === "--npm";
const target = (!npm && process.argv[3]) || `${process.platform}-${process.arch}`;
const [platform, arch] = target.split("-");
/** 必须带上的原生二进制包：`plume-plugin` 构建插件靠它们，按 Node 的平台、架构命名。 */
const NATIVE = [`@esbuild/${target}`, `@typescript/typescript-${target}`];
if (!existsSync(join(sdk, "dist/ui.d.ts"))) throw new Error("先生成 SDK 的类型声明：pnpm --filter @plumeai/plugin-sdk typecheck");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** package.json 的 `os`、`cpu` 这一项容不容得下 value：没写是都行，`!x` 是除了 x。 */
function fits(list, value) {
	if (!Array.isArray(list) || list.length === 0) return true;
	if (list.includes(`!${value}`)) return false;
	const wanted = list.filter((entry) => !entry.startsWith("!"));
	return wanted.length === 0 || wanted.includes(value);
}

/** 从 from 这个包的真实目录往上找 node_modules/<name>，和 Node 的解析一样；找不到返回 undefined。 */
function locate(name, from) {
	for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
	}
	return undefined;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ["bin", "lib", "dist", "template", "tsconfig.json", "LICENSE"]) cpSync(join(sdk, name), join(out, name), { recursive: true });
cpSync(resolve(sdk, "../../../skills/plume-plugin"), join(out, "skill"), { recursive: true, dereference: true });

const manifest = readJson(join(sdk, "package.json"));
const { devDependencies: _dev, scripts: _scripts, ...shipped } = manifest;
if (npm) {
	const { private: _private, ...published } = shipped;
	writeFileSync(join(out, "package.json"), `${JSON.stringify({ ...published, publishConfig: { access: "public" } }, null, 2)}\n`);
	console.log(`✓ SDK（npm）→ ${out}`);
	process.exit(0);
}
writeFileSync(join(out, "package.json"), `${JSON.stringify(shipped, null, 2)}\n`);

/** 已经放进去的包 → 版本；同名不同版本放不进一个平铺的 node_modules，直接报错。 */
const placed = new Map();
const queue = Object.keys(manifest.dependencies).map((name) => ({ name, from: sdk, optional: false }));
while (queue.length > 0) {
	const { name, from, optional } = queue.shift();
	const source = locate(name, from);
	if (!source) {
		if (optional) continue;
		throw new Error(`找不到 ${name}（${from} 要的）：先 pnpm install`);
	}
	const pkg = readJson(join(source, "package.json"));
	if (optional && !(fits(pkg.os, platform) && fits(pkg.cpu, arch))) continue;
	const seen = placed.get(name);
	if (seen !== undefined) {
		if (seen !== pkg.version) throw new Error(`${name} 有两个版本：${seen} 和 ${pkg.version}，平铺不下`);
		continue;
	}
	placed.set(name, pkg.version);
	// 包自己的 node_modules（pnpm 放 .bin 之类）不要：依赖都平铺在外层。
	cpSync(source, join(out, "node_modules", name), {
		recursive: true,
		dereference: true,
		filter: (path) => !path.startsWith(join(source, "node_modules")),
	});
	for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: source, optional: false });
	for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: source, optional: true });
}

const missing = NATIVE.filter((name) => !placed.has(name));
if (missing.length > 0) throw new Error(`没有 ${target} 的 ${missing.join("、")}：pnpm 只装了装包那台机器要的那份，换到目标平台和架构的机器上打包`);

console.log(`✓ SDK（${target}）→ ${out}（${[...placed.keys()].join("、")}）`);
