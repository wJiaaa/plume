// Plume 作为 Magpie 的 Agent：在 Magpie 的 Agent 页给 Plume 选一个 Magpie 的模型。
//
// 写的不是 Plume 自己的设置文件，而是 Plume 市场插件 plume.magpie 的数据目录：它把顶层的 `magpie` 对象变成一个供应商、
// 把 `defaultModel` 设成 Plume 的默认模型（插件仓库的 plugins/magpie）。模型引用是 `magpie/<网关里的模型 id>`，
// 和那个供应商下的模型对得上。
import { icon } from "./icon.js";

export const agent = {
	id: "plume",
	name: "Plume",
	icon,
	// 桌面应用，PATH 上没有命令；在 Plume 里装上 plume.magpie 就有这个目录，没装时 Magpie 不列出 Plume
	dir: "~/.plume/plugin-data/plume.magpie",
	// 插件启用时先建好 0600 的空文件：Magpie 写不存在的文件时按 0644 建，里面有网关的 key
	config: "~/.plume/plugin-data/plume.magpie/credentials.json",
	model: "defaultModel",
	prefix: "magpie/",
	// 资源库：技能放进个人技能目录；全局指令和 MCP 放进市场插件 plume.magpie 的数据目录，由它交给 Plume（见 README）
	library: {
		instructions: "~/.plume/plugin-data/plume.magpie/AGENTS.md",
		mcp: "~/.plume/plugin-data/plume.magpie/mcp.json",
		mcpFormat: "claude",
		skills: "~/.plume/skills",
	},
	notice: "Plume uses the new model from its next turn.",
};

export function connect({ gateway, models }) {
	return {
		// 不带 /v1：Plume 的适配器拼路径时自己处理 /v1
		"magpie.baseUrl": gateway.url,
		// Magpie 看这一键是否还是它给的 key，来判断这一行是否仍然接着
		"magpie.apiKey": gateway.key,
		// 整份目录写进去，Plume 的模型列表从这里列；Magpie 的目录变了会重新调 connect
		"magpie.models": models,
	};
}
