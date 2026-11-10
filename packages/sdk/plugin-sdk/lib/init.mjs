/**
 * 从 template/ 生成一个新插件。
 *
 * 两种情况：
 * - 独立项目（SDK 随 Plume 应用发来，或者目标不在 Plume 仓库里）：不经 npm，node_modules 里链到这份 SDK（见 link.mjs）；
 *   另外带上 skill、AGENTS.md、CLAUDE.md、.gitignore，让接手的 agent 一打开项目就知道怎么写。
 * - Plume 的仓库里（SDK 就是本体仓库里这份、目标在一个 pnpm workspace 里）：本体仓库里依赖写 `workspace:*`，
 *   旁边插件仓库（plume-plugins）里写 `link:` 指回本体仓库的 SDK；skill 和 AGENTS.md 用仓库根目录的，不另带；
 *   构建交给本体仓库的 `pnpm build:plugins`。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { linkSdk } from "./link.mjs";

const sdk = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));

/** 目录名也是 plume-plugin:// 的主机名。 */
export const DIR_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** 插件名：小写，点分段，段里可以有连字符。 */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

/** 只给独立项目的文件。 */
const STANDALONE_ONLY = new Set(["AGENTS.md", "CLAUDE.md", "gitignore"]);

/** `start` 所在的 pnpm workspace 根目录（往上找 pnpm-workspace.yaml）。 */
function workspaceOf(start) {
	for (let dir = start; dir !== dirname(dir); dir = dirname(dir)) {
		if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
	}
	return undefined;
}

/** SDK 所在的 pnpm workspace 根目录；随应用发出去的那份没有。 */
function workspaceRoot() {
	return workspaceOf(sdk);
}

/** skill 的来源：随应用发的那份里是 skill/（打包时复制进去），仓库里是根目录的 skills/plume-plugin。 */
export function skillDir() {
	const packed = join(sdk, "skill");
	if (existsSync(join(packed, "SKILL.md"))) return packed;
	const root = workspaceRoot();
	const repo = root && join(root, "skills/plume-plugin");
	if (repo && existsSync(join(repo, "SKILL.md"))) return repo;
	throw new Error("找不到 skill plume-plugin");
}

function copyTemplate(from, to, replace, skip) {
	mkdirSync(to, { recursive: true });
	for (const name of readdirSync(from)) {
		if (skip(name)) continue;
		const source = join(from, name);
		const target = join(to, name === "gitignore" ? ".gitignore" : name);
		if (statSync(source).isDirectory()) copyTemplate(source, target, replace, () => false);
		else writeFileSync(target, replace(readFileSync(source, "utf8")));
	}
}

/**
 * @param {string} target 新插件的目录，不能已经存在
 * @param {{ name?: string, displayName?: string }} [options]
 * @returns {{ dir: string, name: string, workspace: boolean }}
 */
export function initPlugin(target, options = {}) {
	const dir = resolve(target);
	const key = basename(dir);
	if (!DIR_NAME.test(key)) throw new Error(`目录名 ${key} 不行：只能用小写字母、数字和连字符`);
	if (existsSync(dir)) throw new Error(`${dir} 已经存在`);
	const root = workspaceRoot();
	// 目标所在的 workspace：本体仓库自己，或者旁边的插件仓库。随应用发的 SDK 没有仓库，总是独立项目。
	const home = root === undefined ? undefined : workspaceOf(dirname(dir));
	const workspace = home !== undefined;
	const sdkDep = home === root ? "workspace:*" : `link:${relative(dir, sdk).replaceAll("\\", "/")}`;
	const name = options.name ?? (workspace ? `plume.${key}` : key);
	if (!PLUGIN_NAME.test(name)) throw new Error(`插件名 ${name} 不行：小写字母、数字、连字符，用点分段`);
	const displayName = options.displayName ?? key;
	const tool = `${key.replaceAll("-", "_")}_greet`;

	const replace = (text) => text.replaceAll("__NAME__", name).replaceAll("__TOOL__", tool).replaceAll("__DISPLAY__", displayName);
	copyTemplate(join(sdk, "template"), dir, replace, (file) => workspace && STANDALONE_ONLY.has(file));

	const deps = manifest.dependencies;
	const pkg = {
		name: `@plume-plugins/${key}`,
		version: "0.1.0",
		description: "",
		keywords: [],
		plume: { displayName, category: "" },
		private: true,
		type: "module",
		// 仓库里照 workspace 的规矩写依赖、由 pnpm 装；独立项目不经 npm，靠 link.mjs 建的链接。
		...(workspace
			? {
					scripts: { typecheck: "tsc -p tsconfig.json" },
					devDependencies: { "@plumeai/plugin-sdk": sdkDep, "@types/node": deps["@types/node"], "@types/react": deps["@types/react"] },
				}
			: {}),
	};
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
	if (!workspace) {
		cpSync(skillDir(), join(dir, ".claude/skills/plume-plugin"), { recursive: true, dereference: true });
		linkSdk(dir);
	}
	return { dir, name, workspace };
}
