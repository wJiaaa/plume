// Plume 作为 Magpie 的 Agent：在 Magpie 的 Agent 页给 Plume 选一个 Magpie 的模型。
//
// Plume 的供应商是设置文件里的 `providers` 数组，Magpie 只会按点分路径改对象键，定位不到数组里的一项；
// 所以这里写的是顶层的 `magpie` 对象，Plume 读入时把它合成一个供应商（packages/core/agent/src/magpie.ts）。
// 模型引用是 `magpie/<网关里的模型 id>`，和那个供应商下的模型对得上。
import { icon } from "./icon.js";

export const agent = {
	id: "plume",
	name: "Plume",
	icon,
	// 桌面应用，PATH 上没有命令；开过一次 Plume 就有这个目录
	dir: "~/.plume",
	config: "~/.plume/settings.json",
	model: "defaultModel",
	prefix: "magpie/",
	// 资源库：技能放进个人技能目录，全局指令每轮读，MCP 和 Plume 自己的服务一起读（见 README）
	library: {
		instructions: "~/.plume/magpie/AGENTS.md",
		mcp: "~/.plume/magpie/mcp.json",
		mcpFormat: "claude",
		skills: "~/.plume/skills",
	},
	notice: "Plume uses the new model from its next turn. Restart Plume to see it in the model picker.",
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
