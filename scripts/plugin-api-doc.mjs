/**
 * skill plume-plugin 的接口参考 references/api.md：从 `@plume/contract` 的源码摘出插件用的那些类型，签名和注释原样照搬。
 * 由 scripts/check-plugins.mjs 的规则 2 生成和比对（`--fix` 重新生成），手写的 logic.md、ui.md 不再逐个列成员，只讲判断、流程和坑。
 *
 * 摘哪些类型写在 GROUPS 里：插件直接拿到、直接交出的（ctx、run、钩子的输入输出、ui 和它交给组件的 props）。
 * 签名里再用到的类型不跟着摘，要看的在 SDK 的类型声明里查（编辑器里跳过去）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 从 start 开始的一段声明的源码。函数到函数体的 `{` 为止（只要签名）；interface 到配对的 `}`；其余到顶层的 `;`。
 * 只数括号，不认字符串和注释：被摘的源码里括号在字符串、注释里也是成对的，摘出来的不完整时 checkComplete 会报。
 */
export function declarationText(text, start, kind) {
	let depth = 0;
	let params = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (char === "(" || char === "[") {
			depth++;
			if (char === "(") params = true;
		} else if (char === ")" || char === "]") depth--;
		else if (char === "{") {
			if (kind === "function" && depth === 0 && params) return text.slice(start, i).trimEnd();
			depth++;
		} else if (char === "}") {
			depth--;
			if (kind === "interface" && depth === 0) return text.slice(start, i + 1);
		} else if (char === ";" && depth === 0 && kind !== "function" && kind !== "interface") return text.slice(start, i + 1);
	}
	return text.slice(start);
}

/** 紧挨在 start 前面的 `/** … *\/` 注释。文件开头的那段是整个文件的说明，不算。 */
export function docBefore(text, start) {
	const before = text.slice(0, start).trimEnd();
	const at = before.lastIndexOf("/**");
	return before.endsWith("*/") && at > 0 ? before.slice(at) : "";
}

/** 按这个顺序列；`file` 相对 packages/contract/src。 */
const GROUPS = [
	{
		title: "逻辑入口（`@plume/contract`）",
		intro:
			"默认导出 `Plugin`，`apply` 收到 `PluginContext`；工具定义成 `ToolDefinition`，执行时收到 `ToolRun`；钩子的每一层收到 `Hooks` 里那个钩子的输入、交回它的输出。",
		types: [
			["plugin.ts", "Plugin"],
			["plugin.ts", "PluginContext"],
			["plugin.ts", "PluginSettings"],
			["plugin.ts", "PluginStore"],
			["plugin.ts", "PluginSessionStore"],
			["plugin.ts", "SessionAccess"],
			["plugin.ts", "ModelAccess"],
			["plugin.ts", "MediaAccess"],
			["plugin.ts", "PluginSecrets"],
			["plugin.ts", "PluginProviders"],
			["plugin.ts", "PluginWorkspace"],
			["resources.ts", "PluginResources"],
			["changes.ts", "PluginChanges"],
			["plugin.ts", "WebPages"],
			["plugin.ts", "Services"],
			["plugin.ts", "ToolDefinition"],
			["plugin.ts", "ToolOutput"],
			["plugin.ts", "ToolRun"],
			["plugin.ts", "RunFiles"],
		],
	},
	{
		title: "钩子",
		intro: "`ctx.hook(name, layer, { order })` 的 `layer` 是 `HookLayer<name>`：收到输入和 `next`，交回输出。",
		types: [
			["plugin.ts", "Hooks"],
			["plugin.ts", "HookLayer"],
			["plugin.ts", "ToolExecution"],
			["plugin.ts", "ToolApproval"],
			["plugin.ts", "ModelContext"],
			["plugin.ts", "StepEnd"],
			["plugin.ts", "StepVerdict"],
			["plugin.ts", "PromptSubmit"],
			["plugin.ts", "PromptVerdict"],
			["plugin.ts", "ContextCompact"],
			["plugin.ts", "CompactSummary"],
		],
	},
	{
		title: "界面入口（`@plume/contract/ui`）",
		intro: "默认导出 `UiPlugin`，`apply` 收到 `UiContext`；工具卡片、等人卡收到的 props 在后面。组件见 [components.md](components.md)。",
		types: [
			["ui.ts", "UiPlugin"],
			["ui.ts", "UiContext"],
			["ui.ts", "ToolCardProps"],
			["ui.ts", "RequestCardProps"],
		],
	},
];

/**
 * @param {string} root 仓库根目录
 * @returns {{ doc: string, problems: string[] }}
 */
export function pluginApiDoc(root) {
	const problems = [];
	const sources = new Map();
	const source = (file) => {
		if (!sources.has(file)) sources.set(file, readFileSync(join(root, "packages/contract/src", file), "utf8"));
		return sources.get(file);
	};
	const describe = ([file, name]) => {
		const text = source(file);
		const match = text.match(new RegExp(`^export\\s+(interface|type)\\s+${name}\\b`, "m"));
		if (!match) {
			problems.push(`packages/contract/src/${file} 里找不到 ${name}（scripts/plugin-api-doc.mjs 的 GROUPS 跟着改）`);
			return "";
		}
		const declaration = declarationText(text, match.index, match[1]);
		const complete = match[1] === "interface" ? declaration.endsWith("\n}") : declaration.endsWith(";");
		if (!complete) problems.push(`packages/contract/src/${file} 的 ${name} 没摘完整：注释或字符串里的括号不成对`);
		const doc = docBefore(text, match.index);
		return [`### \`${name}\``, "", "```ts", doc ? `${doc}\n${declaration}` : declaration, "```", ""].join("\n");
	};
	const doc = [
		"# 接口参考",
		"",
		"<!-- 由 `node scripts/check-plugins.mjs --fix` 从 packages/contract/src 生成，不要手改。摘哪些类型在 scripts/plugin-api-doc.mjs。 -->",
		"",
		"插件拿到的 `ctx`、`run`、钩子的输入输出、`ui` 的全部成员，签名和注释摘自类型声明，以这里为准。很长，不整份读：搜成员名（`launch(`、`toolCard(`）跳到那一行。",
		"怎么用、什么时候用哪个、有哪些坑在 [logic.md](logic.md)、[ui.md](ui.md) 按主题讲；签名里用到、这里没列的类型在 SDK 的类型声明里。",
		"",
		...GROUPS.flatMap((group) => [`## ${group.title}`, "", group.intro, "", ...group.types.map(describe)]),
	].join("\n");
	return { doc, problems };
}
