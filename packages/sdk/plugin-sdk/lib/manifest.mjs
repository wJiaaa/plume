/**
 * 插件包的格式：什么目录算一个插件、发给插件的有哪些文件、`package.json` 里给市场看的说明怎么读、发到市场前必须写齐哪些、
 * 市场目录 `marketplace.json` 的一条怎么读回来。
 *
 * 用到它的几处说的是同一份格式：应用（主进程找插件、读说明、装市场的包，打包时放内置插件）、这里的 `plume-plugin install`
 * 和 `init`、插件仓库发市场（校验、打包写目录）。插件仓库经 npm 上的 SDK 引它（`@plumeai/plugin-sdk/manifest`），
 * 两个仓库不用各写一份。类型（`PluginKind`、`PluginManifest`）在 `@plume/contract`，旁边的 manifest.d.mts 引它。
 * 只用 Node 自带的，不引别的包。
 */

/** 插件目录名：也是安装目录名、市场条目的 `name`、`plume-plugin://` 的主机名。 */
export const DIR_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** 逻辑入口：插件目录里有它才算一个插件（没构建的源码目录不算）。 */
export const PLUGIN_ENTRY = "dist/index.mjs";

/**
 * 发给插件的文件：说明、介绍和它引用的图片、图标、构建产物、随包的技能、MCP 服务的声明、许可证。源码、node_modules 不发。
 * 市场的包、`plume-plugin install`、应用里「从本地上传」都只装这些，应用算文件指纹也只看这些。
 */
export const SHIPPED = ["package.json", "README.md", "images", "icon.png", "dist", "skills", ".mcp.json", "LICENSE"];

const KINDS = new Set(["plugin", "skill", "connector"]);

/** 读 `package.json` 的内容。字段类型不对或是空的当没写，一个坏字段不拖垮整份；`plume.kind` 没写或写错按普通插件。 */
export function readManifest(raw) {
	const manifest = record(raw);
	const plume = record(manifest.plume);
	return compact({
		kind: kindOf(plume.kind),
		displayName: text(plume.displayName),
		description: text(manifest.description),
		version: text(manifest.version),
		author: text(manifest.author) ?? text(record(manifest.author).name),
		category: text(plume.category),
		keywords: texts(manifest.keywords),
		homepage: text(manifest.homepage),
		license: text(manifest.license),
		prompts: texts(plume.defaultPrompt),
	});
}

/** 读市场目录里一条的说明部分（打包时写的是 `{ name, ...readManifest(...) }`）。目录名不合规矩的是 null。 */
export function readCatalogInfo(raw) {
	const entry = record(raw);
	const name = text(entry.name);
	if (!name || !DIR_NAME.test(name)) return null;
	return {
		name,
		...compact({
			kind: kindOf(entry.kind),
			displayName: text(entry.displayName),
			description: text(entry.description),
			version: text(entry.version),
			author: text(entry.author),
			category: text(entry.category),
			keywords: texts(entry.keywords),
			homepage: text(entry.homepage),
			license: text(entry.license),
			prompts: texts(entry.prompts),
		}),
	};
}

/** 发到市场的插件必须写的说明，缺了哪样：版本号（x.y.z）、显示名、说明、合法的 kind。一样一句。 */
export function manifestProblems(raw) {
	const manifest = record(raw);
	const plume = record(manifest.plume);
	const problems = [];
	const version = typeof manifest.version === "string" ? manifest.version : "";
	if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`version 要写成 x.y.z（现在是 ${version || "空的"}）`);
	if (!text(plume.displayName)) problems.push("package.json 没写 plume.displayName（市场里的名字）");
	if (!text(manifest.description)) problems.push("package.json 没写 description");
	if (plume.kind !== undefined && !KINDS.has(plume.kind)) problems.push(`plume.kind 只能是 ${[...KINDS].join("、")}`);
	return problems;
}

function kindOf(value) {
	return KINDS.has(value) ? value : "plugin";
}

function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function text(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 字符串数组里非空的那些；一个都没有算没写。 */
function texts(value) {
	const list = Array.isArray(value) ? value.flatMap((item) => text(item) ?? []) : [];
	return list.length > 0 ? list : undefined;
}

/** 去掉没写的字段：说明会经 IPC 给界面、写进 JSON，不留一串 undefined。 */
function compact(value) {
	return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}
