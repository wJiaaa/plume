/**
 * MCP 工具按需加载。工具一多，每轮都把几十个工具的说明和参数 Schema 放进请求，还没开始做事就花掉几千个 token；
 * 超过 `DEFER_TOKENS` 时（「常驻」的服务除外）工具表里只留 `mcp_search` 和 `mcp_call`，系统提示词列出有哪些服务、
 * 哪些工具名。模型要用时先搜到它的 Schema，再经 `mcp_call` 调；调用仍走那个工具自己的审批。
 * 一个会话一旦改成按需就不改回去：工具表在会话中途来回变，服务商的提示词缓存就白建了。
 */

import type { ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";

export const MCP_SEARCH = "mcp_search";
export const MCP_CALL = "mcp_call";
export const DEFER_TOKENS = 3_000;

/** 登记着的一个 MCP 工具。 */
export interface McpTool {
	/** 工具表里的名字：`mcp__<服务>__<工具>`。 */
	name: string;
	server: { id: string; name: string };
	/** 服务那边的名字。 */
	tool: string;
	description: string;
	parameters: Record<string, unknown>;
	readOnly: boolean;
	pinned: boolean;
	execute: ToolDefinition["execute"];
}

/** 粗估：一个 token 约 3.5 个字符。只用来判断工具表是不是太大，不用精确。 */
export function toolTokens(tools: readonly { name: string; description: string; parameters: unknown }[]): number {
	const text = tools.map((tool) => `${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`).join("");
	return Math.ceil(text.length / 3.5);
}

/** 系统提示词里那一段：有哪些服务的工具要先搜。 */
export function deferredSection(tools: readonly McpTool[]): string {
	const servers = new Map<string, { name: string; id: string; tools: string[] }>();
	for (const tool of tools) {
		const entry = servers.get(tool.server.id) ?? { name: tool.server.name, id: tool.server.id, tools: [] };
		entry.tools.push(tool.tool);
		servers.set(tool.server.id, entry);
	}
	const lines = [...servers.values()].map((server) => {
		let names = "";
		for (const name of [...server.tools].sort()) {
			const next = names ? `${names}, ${name}` : name;
			if (next.length > 240) {
				names = `${names}, …`;
				break;
			}
			names = next;
		}
		return `- MCP server ${server.name} (${server.tools.length} tools): ${names}`;
	});
	return [
		"## MCP tools to search for",
		"",
		`The tools of these MCP servers are not in your tool list, to keep it short. When a task needs one, call \`${MCP_SEARCH}\` with what you need to do, a tool name or a server to get its input schema, then run it with \`${MCP_CALL}\`. Search first: their arguments are not guessable.`,
		"",
		...lines,
	].join("\n");
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** `tools()` 是现在登记着、该搜的那些（常驻的不在里面）。 */
export function searchTool(tools: () => McpTool[]): ToolDefinition {
	return {
		name: MCP_SEARCH,
		description:
			'Find tools of the MCP servers listed under "MCP tools to search for" in the system prompt. They are not in your tool list until you search. ' +
			"Search by what you need to do (words from the task), a tool name, or a server; each match comes back with its full input schema. " +
			`Then run it with \`${MCP_CALL}\`. Search before calling: tool names and arguments are not guessable.`,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: 'What you need to do, or a tool or server name, e.g. "linear create issue".' },
				source: { type: "string", description: "Only search one MCP server: its name." },
				limit: { type: "integer", description: `How many matches to return, 1–${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`, minimum: 1, maximum: MAX_LIMIT },
			},
			required: ["query"],
		},
		category: "mcp",
		async execute(args): Promise<ToolOutput> {
			const query = typeof args.query === "string" ? args.query : "";
			const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_LIMIT));
			const pool = tools();
			const source = typeof args.source === "string" && args.source.trim() ? args.source.trim().toLowerCase() : undefined;
			const scoped = source ? pool.filter((tool) => tool.server.name.toLowerCase() === source) : pool;
			if (source && scoped.length === 0)
				return { output: `Nothing in the list is called "${String(args.source)}". Servers: ${serverList(pool)}.`, isError: true };
			const ranked = rank(scoped, query);
			if (ranked.length === 0)
				return { output: `No tool matched "${query}". Servers: ${serverList(pool)}. Try other words, or pass "source" to list one server's tools.` };
			const shown = ranked.slice(0, limit);
			const more = ranked.length - shown.length;
			const output = [
				...shown.map(describe),
				`Call one with ${MCP_CALL}: {"tool": "<name above>", "arguments": {…matching its input schema}}.${more > 0 ? ` ${more} more matched; add words or pass "source" to narrow.` : ""}`,
			].join("\n\n");
			return { output, details: { matches: shown.map((tool) => tool.name) } };
		},
	};
}

/** `tools()` 是全部 MCP 工具：常驻的也能经它调，模型照着搜到的名字叫就行。 */
export function callTool(tools: () => McpTool[]): ToolDefinition {
	return {
		name: MCP_CALL,
		description: `Run a tool found with \`${MCP_SEARCH}\`. "tool" is the exact name the search returned; "arguments" must match that tool's input schema.`,
		parameters: {
			type: "object",
			properties: {
				tool: { type: "string", description: `Exact tool name from ${MCP_SEARCH}, e.g. "mcp__linear__create_issue".` },
				arguments: { type: "object", description: "Arguments for that tool, matching its input schema.", additionalProperties: true },
			},
			required: ["tool"],
		},
		mutating: true,
		// 真正的那个工具自己问（带服务名和参数），这里不替它问。
		asks: true,
		category: "mcp",
		// 导出会话时这一行按真正调的那个工具写。
		forwards: (args) =>
			typeof args.tool === "string"
				? {
						name: args.tool,
						args: args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? (args.arguments as Record<string, unknown>) : {},
					}
				: undefined,
		async execute(args, run: ToolRun): Promise<ToolOutput> {
			const name = typeof args.tool === "string" ? args.tool.trim() : "";
			const all = tools();
			if (!name) return { output: `${MCP_CALL} needs "tool" (the exact name ${MCP_SEARCH} returned) and "arguments".`, isError: true };
			const tool = findTool(all, name);
			if (!tool) return { output: notFound(name, all), isError: true };
			let input: unknown = args.arguments ?? {};
			// 有的模型把参数写成一段 JSON 文字。
			if (typeof input === "string") {
				try {
					input = JSON.parse(input);
				} catch {}
			}
			if (!input || typeof input !== "object" || Array.isArray(input)) {
				return {
					output: `"arguments" must be an object matching ${tool.name}'s input schema, so it was not called.\nInput schema: ${JSON.stringify(tool.parameters)}`,
					isError: true,
				};
			}
			const required = Array.isArray(tool.parameters.required) ? tool.parameters.required.filter((key): key is string => typeof key === "string") : [];
			const missing = required.filter((key) => !(key in (input as Record<string, unknown>)));
			if (missing.length > 0) {
				return {
					output: `${tool.name} was not called: required arguments are missing (${missing.join(", ")}). Fix them and call again.\nInput schema: ${JSON.stringify(tool.parameters)}`,
					isError: true,
				};
			}
			return tool.execute(input as Record<string, unknown>, run);
		},
	};
}

function describe(tool: McpTool): string {
	const flags = tool.readOnly ? " [read-only]" : "";
	return [`${tool.name} — MCP ${tool.server.name}: ${tool.tool}${flags}`, tool.description, `Input schema: ${JSON.stringify(tool.parameters)}`].join("\n");
}

function serverList(tools: readonly McpTool[]): string {
	const names = [...new Set(tools.map((tool) => tool.server.name))];
	return names.length > 0 ? names.join(", ") : "(none)";
}

/** 先按全名找，再按「服务 + 工具」的几种写法，最后按光秃秃的工具名（只有一个对得上时）。 */
export function findTool(tools: readonly McpTool[], name: string): McpTool | undefined {
	const wanted = name.toLowerCase();
	const exact = tools.find((tool) => tool.name === name) ?? tools.find((tool) => tool.name.toLowerCase() === wanted);
	if (exact) return exact;
	const scoped = tools.filter((tool) => {
		const server = tool.server.name.toLowerCase();
		const raw = tool.tool.toLowerCase();
		return [`${server}__${raw}`, `${server}.${raw}`, `${server}/${raw}`, `${server}:${raw}`].includes(wanted);
	});
	if (scoped.length === 1) return scoped[0];
	const bare = tools.filter((tool) => tool.tool.toLowerCase() === wanted);
	return bare.length === 1 ? bare[0] : undefined;
}

function notFound(name: string, tools: readonly McpTool[]): string {
	const [, server, rest] = /^(?:mcp__)?([^_./:]+(?:[-_][^_./:]+)*?)(?:__|[./:])(.+)$/.exec(name) ?? [];
	const scoped = server ? tools.filter((tool) => tool.server.name.toLowerCase() === server.toLowerCase()) : [];
	const near = scoped.length > 0 ? rank(scoped, rest ?? "") : rank(tools, name.replace(/^mcp__/, ""));
	const close = (near.length > 0 ? near : scoped).slice(0, scoped.length > 0 ? 5 : 3).map((tool) => tool.name);
	return `No tool named "${name}"${close.length > 0 ? `. Closest: ${close.join(", ")}` : ""}. Use ${MCP_SEARCH} to find the right tool and its input schema, then call it with the exact name.`;
}

const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"to",
	"of",
	"in",
	"on",
	"for",
	"and",
	"or",
	"with",
	"from",
	"by",
	"my",
	"me",
	"i",
	"it",
	"is",
	"be",
	"at",
	"as",
	"into",
	"new",
	"mcp",
	"tool",
	"tools",
]);

function words(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9\u3400-\u9fff]+/)
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/** 工具名里的词最重，服务名其次，说明最轻；完全叫对名字的排最前。 */
export function rank(tools: readonly McpTool[], query: string): McpTool[] {
	const wanted = words(query);
	const whole = query.trim().toLowerCase();
	const scored: { tool: McpTool; score: number }[] = [];
	for (const tool of tools) {
		if (whole && (tool.name.toLowerCase() === whole || tool.tool.toLowerCase() === whole)) {
			scored.push({ tool, score: 1_000 });
			continue;
		}
		const fields: [string[], number][] = [
			[words(tool.tool), 4],
			[words(tool.server.name), 3],
			[words(tool.description), 1],
		];
		let score = 0;
		for (const word of wanted) {
			let best = 0;
			for (const [field, weight] of fields) {
				for (const candidate of field) {
					if (candidate === word) best = Math.max(best, weight);
					else if (word.length >= 3 && (candidate.startsWith(word) || word.startsWith(candidate))) best = Math.max(best, weight / 2);
				}
			}
			score += best;
		}
		if (score > 0) scored.push({ tool, score });
	}
	return scored.sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1)).map((entry) => entry.tool);
}
