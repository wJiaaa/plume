/**
 * 要 API key 的几家，拿 key 换更好的结果。
 *
 * 都是给程序用的搜索服务：返回结构化的结果、摘要已经抽好，正常用量不限流，也没有会变的网页。代价是要注册账号。
 * 几家只差几个字段名和认证头，所以按同一个形状写，不再多抽一层。
 */

import { SearchError, type SearchProvider, type SearchRequest, type SearchResult, type SearchSource } from "./index.ts";

export const TAVILY_PROVIDER_ID = "tavily";
export const EXA_PROVIDER_ID = "exa";
export const BRAVE_PROVIDER_ID = "brave";
export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** 请求怎么发：多数是 POST 带 JSON，Brave 从 GET 的查询串里读。 */
type Transport = "post" | "get";

interface KeyedSpec {
	transport?: Transport;
	id: string;
	name: string;
	endpoint: string;
	/** key 放在请求的哪里，几家各不相同。 */
	auth: (key: string) => Record<string, string>;
	body: (request: SearchRequest) => unknown;
	/** 从服务商的返回里读出通用的形状。 */
	parse: (payload: unknown) => SearchResult;
}

const SPECS: Record<string, KeyedSpec> = {
	[TAVILY_PROVIDER_ID]: {
		id: TAVILY_PROVIDER_ID,
		name: "Tavily",
		endpoint: "https://api.tavily.com/search",
		auth: (key) => ({ authorization: `Bearer ${key}` }),
		body: (request) => ({
			query: request.query,
			max_results: request.maxResults ?? 8,
			// Tavily 除了结果还能写一段答案，有的话比第一条摘要对模型更有用。
			include_answer: true,
		}),
		parse: (payload) => {
			const data = payload as { answer?: string; results?: { url?: string; title?: string; content?: string }[] };
			const sources: SearchSource[] = [];
			for (const item of data.results ?? []) {
				if (!item.url) continue;
				sources.push({
					url: item.url,
					...(item.title ? { title: item.title } : {}),
					...(item.content ? { snippet: item.content } : {}),
				});
			}
			return { ...(data.answer ? { content: data.answer } : {}), sources, truncated: false };
		},
	},
	[EXA_PROVIDER_ID]: {
		id: EXA_PROVIDER_ID,
		name: "Exa",
		endpoint: "https://api.exa.ai/search",
		auth: (key) => ({ "x-api-key": key }),
		body: (request) => ({
			query: request.query,
			numResults: request.maxResults ?? 8,
			type: "auto",
			contents: { highlights: { numSentences: 1 } },
		}),
		parse: (payload) => {
			const data = payload as {
				results?: { url?: string; title?: string; highlights?: string[]; publishedDate?: string }[];
			};
			const sources: SearchSource[] = [];
			for (const item of data.results ?? []) {
				if (!item.url) continue;
				// 没有 highlight 的结果没有可用的摘要，也没别的字段能拼出一段；丢掉而不是空着返回，编一段就是说谎。
				const snippet = item.highlights?.find((h) => h.trim().length > 0);
				if (!snippet) continue;
				sources.push({
					url: item.url,
					...(item.title ? { title: item.title } : {}),
					snippet: snippet.trim(),
					...(item.publishedDate ? { publishedAt: item.publishedDate } : {}),
				});
			}
			return { sources, truncated: false };
		},
	},
	[BRAVE_PROVIDER_ID]: {
		id: BRAVE_PROVIDER_ID,
		name: "Brave Search",
		endpoint: "https://api.search.brave.com/res/v1/web/search",
		transport: "get",
		auth: (key) => ({ "x-subscription-token": key, accept: "application/json" }),
		body: (request) => ({ q: request.query, count: String(request.maxResults ?? 8) }),
		parse: (payload) => {
			const data = payload as { web?: { results?: { url?: string; title?: string; description?: string; age?: string }[] } };
			const sources: SearchSource[] = [];
			for (const item of data.web?.results ?? []) {
				if (!item.url) continue;
				sources.push({
					url: item.url,
					...(item.title ? { title: stripHighlightMarkers(item.title) } : {}),
					...(item.description ? { snippet: stripHighlightMarkers(item.description) } : {}),
					...(item.age ? { publishedAt: item.age } : {}),
				});
			}
			return { sources, truncated: false };
		},
	},
	[DEEPSEEK_PROVIDER_ID]: {
		id: DEEPSEEK_PROVIDER_ID,
		name: "DeepSeek",
		endpoint: "https://api.deepseek.com/v1/tools/search",
		auth: (key) => ({ authorization: `Bearer ${key}` }),
		body: (request) => ({
			query: request.query,
			count: request.maxResults ?? 8,
			// `need_content` 用默认：一次搜索带回八整页是模型没要的一页上下文，给它读的是下面的 `summary`。
		}),
		parse: (payload) => {
			const data = payload as {
				results?: { url?: string; title?: string; snippet?: string; summary?: string; date?: string }[];
			};
			const sources: SearchSource[] = [];
			for (const item of data.results ?? []) {
				if (!item.url) continue;
				// `summary` 是写给模型的 600–800 字版本，`snippet` 是写给界面的 100–200 字版本；两个都有时给长的，短摘要常常停在有用的地方之前。
				const snippet = item.summary?.trim() || item.snippet?.trim();
				sources.push({
					url: item.url,
					...(item.title ? { title: item.title } : {}),
					...(snippet ? { snippet } : {}),
					...(item.date ? { publishedAt: item.date } : {}),
				});
			}
			return { sources, truncated: false };
		},
	},
};

/** Brave 用 `<strong>` 包住命中的词给浏览器加粗；模型读到的是要绕开的标记，还可能照抄回来。 */
function stripHighlightMarkers(text: string): string {
	return text.replace(/<\/?(?:strong|b|em)>/gi, "");
}

/**
 * 一家要 key 的后端，key 从调用方存的地方读。
 *
 * `readKey` 是函数而不是字符串：`available()` 反映的是此刻的 key，设置里贴上 key 不用重启就能搜。
 */
export function keyedSearchProvider(id: string, readKey: () => string | undefined, fetchImpl: typeof fetch = fetch): SearchProvider {
	const spec = SPECS[id];
	// i18n-exempt：发给模型的错误
	if (!spec) throw new SearchError(`未知的搜索提供方 ${id}`, "SEARCH_PROVIDER_MISSING");

	return {
		id: spec.id,
		name: spec.name,
		// 只看本地有没有 key；去问服务商就等于每次选后端前都多一次网络往返。
		available: () => Boolean(readKey()?.trim()),
		async search(request: SearchRequest): Promise<SearchResult> {
			const key = readKey()?.trim();
			// i18n-exempt：发给模型的错误
			if (!key) throw new SearchError(`${spec.name} 没有配置 API key`, "SEARCH_PROVIDER_UNAVAILABLE");

			let response: Response;
			try {
				response =
					spec.transport === "get"
						? await fetchImpl(`${spec.endpoint}?${new URLSearchParams(spec.body(request) as Record<string, string>)}`, {
								method: "GET",
								signal: request.signal,
								headers: spec.auth(key),
							})
						: await fetchImpl(spec.endpoint, {
								method: "POST",
								signal: request.signal,
								headers: { "content-type": "application/json", ...spec.auth(key) },
								body: JSON.stringify(spec.body(request)),
							});
			} catch (error) {
				// i18n-exempt：发给模型的错误
				throw new SearchError(`${spec.name} 请求失败`, "SEARCH_PROVIDER_ERROR", { cause: error });
			}

			// i18n-exempt：发给模型的错误
			if (response.status === 401 || response.status === 403) {
				throw new SearchError(`${spec.name} 拒绝了这个 API key`, "SEARCH_PROVIDER_UNAUTHORIZED");
			}
			if (response.status === 429) throw new SearchError(`${spec.name} 限流了`, "SEARCH_RATE_LIMITED");
			if (!response.ok) throw new SearchError(`${spec.name} 返回 HTTP ${response.status}`, "SEARCH_PROVIDER_ERROR");

			try {
				return spec.parse(await response.json());
			} catch (error) {
				// i18n-exempt：发给模型的错误
				throw new SearchError(`${spec.name} 的返回读不懂`, "SEARCH_PROVIDER_ERROR", { cause: error });
			}
		},
	};
}
