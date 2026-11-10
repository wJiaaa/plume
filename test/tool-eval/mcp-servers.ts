/**
 * MCP 两个评测共用的：装哪些插件、把假服务器接进 plume.mcp、等它们连上、读调用记录。
 *
 * 服务器经插件自己的配置文件（插件数据目录里的 `servers.json`）接上，每台是一个 `mcp-fixture-server.ts` 进程；改了配置
 * 调一次插件的 `list`（设置页刷新时调的就是它），插件照新配置连、断、重新登记工具。延迟加载、`mcp_search`、`mcp_call`、
 * 工具名都是插件自己的。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, PluginEntry } from "../../packages/contract/src/index.ts";
import mcp from "../../packages/builtin/mcp/src/index.ts";
import todo from "../../packages/builtin/todo/src/index.ts";
import web from "../../packages/builtin/web/src/index.ts";
import { BUILTINS } from "../../packages/core/agent/test/builtins.ts";
import type { EvalAgent } from "./agent.ts";
import type { FixtureServer } from "./mcp-fixture.ts";

const SERVER = join(import.meta.dirname, "mcp-fixture-server.ts");

/**
 * 循环离不开的那几样，加上同样随应用发、会往工具表里放工具的待办和网页：MCP 延迟不延迟，比的是同一张常驻工具表旁边多出来的那些。
 * 技能不带：它读本机的 `~/.claude/skills`，工具表会随机器变。
 */
export const MCP_BUILTINS: PluginEntry[] = [
	...BUILTINS,
	...[todo, web, mcp].map((plugin): PluginEntry => ({ key: plugin.name, builtin: true, load: async () => plugin })),
];

/** 这是评测：工具和服务在模型看来都是真的，做完就停，不问人。和任何一轮都无关，冻结的系统提示词里一直是同一段。 */
export function evaluationNote(): Plugin {
	return {
		name: "eval.note",
		apply(ctx) {
			ctx.hook("model.context", async (input, next) =>
				next({
					...input,
					sections: [
						...input.sections,
						{
							id: "evaluation",
							text: "This is an evaluation: the tools and services are real from your point of view. Do the task with the tools you have, then stop. Do not ask the user questions.",
						},
					],
				}),
			);
		},
	};
}

/** 内置工具不真执行：只记下叫了什么、回一句像样的话，不碰文件和网络。MCP 的几个照常走插件。 */
export function recordBuiltins(calls: { name: string; args: Record<string, unknown> }[]): Plugin {
	return {
		name: "eval.record-builtins",
		apply(ctx) {
			ctx.hook("tool.execute", async (input, next) => {
				const name = input.tool.name;
				if (name.startsWith("mcp")) return next(input);
				calls.push({ name, args: input.call.args });
				return { output: answer(name) };
			});
		},
	};
}

/** 像样的回话：模型据此往下走，而不是对着一句 ok 犯嘀咕。 */
function answer(name: string): string {
	if (name === "read") return "Error: file not found.";
	if (name === "ls" || name === "glob") return "(empty)";
	if (name === "bash") return "";
	return "ok";
}

export interface McpCall {
	server: string;
	tool: string;
	args: Record<string, unknown>;
}

/** 假服务器们，接在一个 agent 的 plume.mcp 上。 */
export class FixtureMcp {
	private readonly log: string;

	constructor(private readonly agent: EvalAgent) {
		this.log = join(agent.dataDir, "mcp-calls.jsonl");
	}

	/** 换成这几台（`pinned`：每台都拨成常驻），等它们都连上。不在里面的断开、撤下工具。 */
	async use(servers: readonly FixtureServer[], pinned: boolean): Promise<void> {
		const file = join(this.agent.pluginDataDir("plume.mcp"), "servers.json");
		const config = servers.map((server) => ({
			id: server.id,
			name: server.name,
			enabled: true,
			transport: "stdio",
			command: process.execPath,
			args: ["--no-warnings", SERVER, server.id, this.log],
			...(pinned ? { pinned: true } : {}),
		}));
		await writeFile(file, JSON.stringify({ servers: config }, null, "\t"));
		const deadline = Date.now() + 60_000;
		while (true) {
			const view = (await this.agent.agent.service.callPlugin("plume.mcp", "list", [], { signal: AbortSignal.timeout(10_000) })) as {
				servers: { id: string; status: { state: string; error?: string; stderr?: string } }[];
			};
			const failed = view.servers.find((server) => server.status.state === "failed");
			if (failed) throw new Error(`假 MCP 服务器 ${failed.id} 连不上：${failed.status.error ?? ""}\n${failed.status.stderr ?? ""}`);
			if (view.servers.length === servers.length && view.servers.every((server) => server.status.state === "connected")) return;
			if (Date.now() > deadline)
				throw new Error(
					`假 MCP 服务器一分钟内没全连上：${view.servers
						.filter((s) => s.status.state !== "connected")
						.map((s) => `${s.id}=${s.status.state}`)
						.join(", ")}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	/** 到目前为止假服务器们收到的全部调用，按先后。 */
	async calls(): Promise<McpCall[]> {
		const raw = await readFile(this.log, "utf8").catch(() => "");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as McpCall);
	}
}
