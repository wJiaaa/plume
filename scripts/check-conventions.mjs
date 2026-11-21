#!/usr/bin/env node
/**
 * 约定检查（`pnpm check` 的一部分）：AGENTS.md、spec/safety.md 和 packages/README.md 里写着、能机械判断的几条。
 *
 * 1. 包的位置：packages/ 下的包都在 `packages/<组>/<包>`，只有 contract 是 `packages/contract`。
 *    依赖方向的规则（.dependency-cruiser.cjs）按这个路径写，放错一层的包会悄悄躲开它们。
 * 2. 经 contract 转出的类型从 `@plume/contract` 引：contract/src/index.ts 里 `export type { … } from "<包>"` 列出的名字，
 *    除了定义它们的那个包和 contract 自己，别处一律从 `@plume/contract` 引，不绕到定义处。
 *    只查转出的这些；定义包自己的其余类型（如 `@plume/llm/types` 的 `ModelConfig`）不归这条管。
 * 3. 术语固定（AGENTS.md「约定」）：钩子、审批卡、工具卡片、界面入口、逻辑入口。下面 TERMS 里的别名不该出现在
 *    进仓库的文档、注释和文案里。CHANGELOG.md 抄的是已经发出去的提交信息，不查。
 * 4. 核心源文件行数：packages/core/{agent,loop,sandbox,workspace}/src 下的 TypeScript 文件每个最多 800 行；
 *    packages/core/llm 自成一体，不查。现有超限文件只在下面的 SOURCE_LINE_EXCEPTIONS 登记，每条带原因。
 *    例外表里的文件降到上限以内或已经不在了，也报出来，提醒把它删掉。
 *
 * 只看进仓库的文件（`git ls-files`，加上还没 add 的新文件），构建产物和被忽略的拷贝不算。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const self = relative(root, fileURLToPath(import.meta.url));

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
	.split("\0")
	.filter(Boolean);
/** 删掉了还没提交的文件仍在 ls-files 里。 */
const read = (file) => {
	try {
		return readFileSync(join(root, file), "utf8");
	} catch {
		return undefined;
	}
};

const problems = [];
const report = (file, line, message) => problems.push(`  ${file}${line ? `:${line}` : ""}：${message}`);
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// 1. 包的位置。
const manifests = files.filter((file) => file.startsWith("packages/") && file.endsWith("/package.json"));
for (const file of manifests) {
	if (file !== "packages/contract/package.json" && file.split("/").length !== 4) report(file, 0, "包要放在 packages/<组>/<包>（见 packages/README.md）");
}

// 2. 经 contract 转出的类型。
const packageDirs = new Map(manifests.map((file) => [JSON.parse(read(file) ?? "{}").name, dirname(file)]).filter(([name]) => typeof name === "string"));
const packageOf = (specifier) =>
	specifier
		.split("/")
		.slice(0, specifier.startsWith("@") ? 2 : 1)
		.join("/");
const forwarded = new Map();
for (const match of (read("packages/contract/src/index.ts") ?? "").matchAll(/export\s+type\s*\{([^}]*)\}\s*from\s*["']([^"'.][^"']*)["']/g)) {
	for (const name of names(match[1])) forwarded.set(name, packageOf(match[2]));
}

/** `{ a, type b, c as d }` 里引进来的原名。 */
function names(list) {
	return list
		.split(",")
		.map(
			(part) =>
				part
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)[0],
		)
		.filter(Boolean);
}

const sources = files.filter((file) => /^(apps|packages)\/.*\.(ts|tsx|mts|mjs)$/.test(file) && !file.startsWith("packages/contract/"));
for (const file of sources) {
	const text = read(file);
	if (!text) continue;
	for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
		const from = packageOf(match[2]);
		const home = packageDirs.get(from);
		if (!home || file.startsWith(`${home}/`)) continue;
		const wrong = names(match[1]).filter((name) => forwarded.get(name) === from);
		if (wrong.length > 0) report(file, lineOf(text, match.index), `${wrong.join("、")} 由 @plume/contract 转出，从 @plume/contract 引，不从 ${match[2]} 引`);
	}
}

// 3. 术语。
const TERMS = [
	[/勾子/g, "钩子"],
	[/工具卡(?!片)/g, "工具卡片"],
	[/审批(?:弹窗|弹框|对话框|框|窗)|批准卡|审批卡片/g, "审批卡"],
	[/(?:UI|前端) ?入口/g, "界面入口"],
	[/后端 ?入口/g, "逻辑入口"],
];
const prose = files.filter(
	(file) => /\.(md|ts|tsx|mts|mjs|cjs|js|json|yml|yaml)$/.test(file) && file !== self && file !== "CHANGELOG.md" && !file.startsWith("packages/core/llm/"),
);
for (const file of prose) {
	const text = read(file);
	if (!text) continue;
	for (const [pattern, term] of TERMS) {
		for (const match of text.matchAll(pattern)) report(file, lineOf(text, match.index), `「${match[0]}」写成「${term}」（AGENTS.md 的术语）`);
	}
}

// 4. 核心源文件行数。
const SOURCE_LINE_LIMIT = 800;
const SOURCE_LINE_EXCEPTIONS = new Map([["packages/core/agent/src/host.ts", "插件宿主，单独治理，不在 agent.ts 这次重构范围"]]);
const coreSources = files.filter((file) => /^packages\/core\/(?:agent|loop|sandbox|workspace)\/src\/.*\.ts$/.test(file));
for (const file of coreSources) {
	const text = read(file);
	if (text === undefined) continue;
	const lineCount = text === "" ? 0 : text.split(/\r\n|\n|\r/).length - (/(?:\r\n|\n|\r)$/.test(text) ? 1 : 0);
	// 例外只给仍超限的文件：降到上限以内就该从例外表删掉，免得它再长回去也没人拦。
	if (SOURCE_LINE_EXCEPTIONS.has(file)) {
		if (lineCount <= SOURCE_LINE_LIMIT) report(file, 0, `只有 ${lineCount} 行，不再超过上限 ${SOURCE_LINE_LIMIT}，从 SOURCE_LINE_EXCEPTIONS 删掉`);
	} else if (lineCount > SOURCE_LINE_LIMIT) report(file, 0, `实际 ${lineCount} 行，超过上限 ${SOURCE_LINE_LIMIT}`);
}
for (const file of SOURCE_LINE_EXCEPTIONS.keys()) if (!coreSources.includes(file)) report(file, 0, `文件已经不在了，从 SOURCE_LINE_EXCEPTIONS 删掉`);

if (problems.length > 0) {
	console.error(`约定检查没过：\n${problems.join("\n")}`);
	process.exit(1);
}
console.log("✓ 约定检查通过");
