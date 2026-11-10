/**
 * 模型看到的网页搜索。
 *
 * 只有一个参数：查什么。要几条、用哪家是配置的人定的事，模型不在那个位置上。
 *
 * 不审批（不是 mutating）：搜索只是把一句查询发给人配置好的服务、读回一串链接，不碰这台机器上的东西。
 * 结果是数据：摘要是陌生人写的字，用 `<search>` 包起来交给模型，而不是当成一段话贴进去。
 */

import type { ToolDefinition, ToolOutput } from "@plume/contract";
import { SearchError, type SearchRegistry } from "./search/index.ts";

const QUERY_KEYS = ["query", "pattern", "search"];

/** 返回几条：够一个有几种可能答案的问题列出来，又只占一段而不是一页。 */
const MAX_RESULTS = 8;
const SEARCH_TIMEOUT_MS = 30_000;

/** 模型常在几个名字之间漂（schema 写的是 `query`，它给 `pattern`），认几个别名；取第一个非空的字符串。 */
function textArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function errorResult(output: string): ToolOutput {
	return { output, isError: true };
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/**
 * @param configuredProvider 每次调用现读设置里选的那家（读的同时把 key 也换成最新的）。
 */
export function webSearchTool(registry: SearchRegistry, configuredProvider: () => Promise<string | null>): ToolDefinition {
	return {
		name: "web_search",
		// i18n-exempt：发给模型的工具说明
		description: "Search the web for pages: titles, snippets and URLs. Read one with web_fetch.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to search for." },
			},
			required: ["query"],
			additionalProperties: true,
		},
		mutating: false,

		async execute(args, run): Promise<ToolOutput> {
			const query = textArg(args, QUERY_KEYS);
			if (!query || query.trim().length === 0) return errorResult("`query` is required.");

			const cleanedQuery = query.trim();
			// 后端都是普通的 fetch，一个永远不回的服务会把这次调用一直挂到人按停止。
			const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

			try {
				const provider = await configuredProvider();
				const result = await registry.search({ query: cleanedQuery, maxResults: MAX_RESULTS, signal: AbortSignal.any([run.signal, deadline]) }, provider);
				if (result.sources.length === 0) {
					// 空列表也是答案，直接说没有，比给一个空块让模型去猜好。
					// i18n-exempt：发给模型的结果
					return { output: `<search query="${cleanedQuery}">没有找到结果。</search>` };
				}

				const lines = result.sources.map((source, index) => {
					const title = source.title ?? hostOf(source.url);
					const snippet = source.snippet ? `\n   ${source.snippet}` : "";
					const when = source.publishedAt ? ` (${source.publishedAt})` : "";
					return `${index + 1}. ${title}${when}\n   ${source.url}${snippet}`;
				});
				const answer = result.content ? `${result.content}\n\n` : "";
				// i18n-exempt：发给模型的结果
				const truncated = result.truncated ? `\n\n[只显示前 ${MAX_RESULTS} 条]` : "";

				return {
					output: `<search query="${cleanedQuery}">\n${answer}${lines.join("\n")}${truncated}\n</search>`,
					details: { kind: "web_search", query: cleanedQuery, count: result.sources.length },
				};
			} catch (error) {
				// 搜索失败多半是配置问题（没有后端、没填 key、两家都配了没选），消息说清是哪一种，模型转述给人就能改。
				// i18n-exempt：发给模型的错误
				if (deadline.aborted && !run.signal.aborted) return errorResult(`搜索超时（${SEARCH_TIMEOUT_MS / 1000} 秒没有响应）`);
				if (error instanceof SearchError) return errorResult(`搜索失败（${error.code}）：${error.message}`);
				return errorResult(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}
