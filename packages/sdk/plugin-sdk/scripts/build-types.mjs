/**
 * 生成 SDK 里的类型声明（包的 typecheck 脚本；pnpm 按依赖顺序先跑完 @plume/llm 等包再跑它）。
 *
 * 插件作者拿不到 Plume 的源码，写插件时引用的 `@plume/contract`、`@plume/contract/ui`、`@plume/ui`、`@plume/ui/icons`、
 * `@plume/styles` 由 SDK 的 tsconfig.json 用 paths 指到这里生成的声明上，写法和仓库里的插件一模一样。
 *
 * 1. 用 tsconfig.types.json 从这几个包的源码生成声明到 dist/，目录和源码一一对应（rootDir 是 packages/）。
 * 2. `@plume/llm` 自己在 typecheck 时生成声明，这里只复制它的 dist/ 进来；@plume/styles 的 theme.css 也复制一份（插件检查认类名用）。
 * 3. 声明里留下的 `@plume/*` 引用改成相对路径：发出去以后这些包都不存在。
 * 4. `@plume/ui` 只开放 packages/client/ui/plugin-api.json 里的名字：dist/ui.d.ts 只转出这些。
 *
 * 先生成在旁边的临时目录里，做完再整个换上：几个会话会同时跑检查和冒烟，原地删了重写的话，别的进程正好在这时读
 * （插件的 typecheck）或也在生成，就会拿到缺文件的一份——缺的不是入口时，下面的校验也看不出来，插件里引用到它的类型全成了 any。
 *
 * 声明之外 SDK 不带宿主的任何运行时代码：`react`、`@plume/ui`、`@plume/styles` 运行时由宿主的 import map 提供。
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const sdk = resolve(import.meta.dirname, "..");
const packages = resolve(sdk, "../..");
const dist = join(sdk, "dist");
/** 这一次生成的地方：和 dist/ 同一个目录，换上去是一次改名。 */
const staging = join(sdk, `.dist-${process.pid}`);

/** 声明里允许出现的 `@plume/*` 引用 → 它在 dist/ 里的位置。 */
const TARGETS = {
	"@plume/contract": "contract/src/index.d.ts",
	"@plume/contract/ui": "contract/src/ui.d.ts",
	"@plume/rpc": "infra/rpc/src/index.d.ts",
	"@plume/styles": "client/styles/src/index.d.ts",
	"@plume/ui": "client/ui/src/index.d.ts",
	"@plume/ui/icons": "client/ui/src/icons/index.d.ts",
	"@plume/llm/types": "core/llm/types.d.ts",
	"@plume/llm/model-catalog-format": "core/llm/model-catalog-format.d.ts",
	"@plume/llm/retry-policy": "core/llm/config/retry-policy.d.ts",
};

rmSync(staging, { recursive: true, force: true });

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
try {
	execFileSync(process.execPath, [tsc, "-p", join(sdk, "tsconfig.types.json"), "--outDir", staging], { stdio: "inherit" });
} catch {
	rmSync(staging, { recursive: true, force: true });
	process.exit(1);
}

const llmDist = join(packages, "core/llm/dist");
if (!existsSync(join(llmDist, "types.d.ts"))) {
	console.error("✗ 找不到 @plume/llm 的声明（packages/core/llm/dist），先跑它的 typecheck");
	rmSync(staging, { recursive: true, force: true });
	process.exit(1);
}
cpSync(llmDist, join(staging, "core/llm"), { recursive: true });
// 插件检查认类名要和产品的 Tailwind 一致（lib/lint/styles.mjs），带一份 token。
cpSync(join(packages, "client/styles/src/theme.css"), join(staging, "theme.css"));

function declarations(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) declarations(path, out);
		else if (name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

let failed = false;
for (const file of declarations(staging)) {
	const text = readFileSync(file, "utf8");
	const next = text.replace(/(from\s*|import\(\s*)(["'])(@plume\/[^"']+)\2/g, (whole, lead, quote, specifier) => {
		const target = TARGETS[specifier];
		if (!target) {
			console.error(`✗ ${relative(sdk, file)}：引用了 ${specifier}，它不在 SDK 里`);
			failed = true;
			return whole;
		}
		let path = relative(dirname(file), join(staging, target)).replaceAll("\\", "/");
		if (!path.startsWith(".")) path = `./${path}`;
		return `${lead}${quote}${path}${quote}`;
	});
	if (next !== text) writeFileSync(file, next);
}
for (const target of Object.values(TARGETS)) {
	if (!existsSync(join(staging, target))) {
		console.error(`✗ 没有生成 dist/${target}`);
		failed = true;
	}
}

const publicNames = JSON.parse(readFileSync(join(packages, "client/ui/plugin-api.json"), "utf8")).flatMap((group) => group.names);
writeFileSync(
	join(staging, "ui.d.ts"),
	`/** @plume/ui 对插件开放的部分：packages/client/ui/plugin-api.json 里的名字。由 scripts/build-types.mjs 生成。 */\nexport { ${publicNames.join(", ")} } from "./${TARGETS["@plume/ui"]}";\n`,
);

if (failed) {
	rmSync(staging, { recursive: true, force: true });
	process.exit(1);
}

/*
 * 旧的挪开、新的改名换上。中间只有两次改名之间那一下没有 dist/。另一个进程抢先换上了它的那份时改名会失败，
 * 两份是同一份源码生成的，留它那份、丢掉自己的。
 */
const retired = join(sdk, `.dist-old-${process.pid}`);
try {
	renameSync(dist, retired);
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
try {
	renameSync(staging, dist);
} catch (error) {
	if (!["ENOTEMPTY", "EEXIST", "EPERM"].includes(error.code)) throw error;
	rmSync(staging, { recursive: true, force: true });
}
rmSync(retired, { recursive: true, force: true });
console.log("✓ 插件 SDK 的类型声明 → dist/");
