/**
 * 真能答上话的免配置选项：DuckDuckGo 公开的速答接口（Instant Answer API）。
 *
 * 无脚本页面那一家才是人以为的「网页搜索」，但它动不动就挡自动访问；这个接口稳定、平常不限流、不要账号。
 * 代价要说清：它不返回网页排名列表，只有百科式的答案和相关词条——答得了「X 是什么」「哪个页面讲 Y」，
 * 答不了「找最近关于 Z 的讨论」。所以什么都没配时用它（`keyless: "default"`）：能答的少，但答得出来。
 */

import { SearchError, type SearchProvider, type SearchRequest, type SearchResult, type SearchSource } from "./index.ts";

const INSTANT_PROVIDER_ID = "ddg-instant";

const ENDPOINT = "https://api.duckduckgo.com/";

interface InstantTopic {
	FirstURL?: string;
	Text?: string;
	/** 分组：接口返回的分类，成员在下一层。 */
	Topics?: InstantTopic[];
	Name?: string;
}

interface InstantPayload {
	AbstractText?: string;
	AbstractURL?: string;
	AbstractSource?: string;
	Heading?: string;
	Answer?: string;
	Definition?: string;
	DefinitionURL?: string;
	DefinitionSource?: string;
	RelatedTopics?: InstantTopic[];
}

export function instantAnswerProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
	return {
		id: INSTANT_PROVIDER_ID,
		// i18n-exempt：发给模型的名字
		name: "DuckDuckGo 速答（免配置，只有百科式答案）",
		available: () => true,
		keyless: "default",
		async search(request: SearchRequest): Promise<SearchResult> {
			const url = new URL(ENDPOINT);
			url.searchParams.set("q", request.query);
			url.searchParams.set("format", "json");
			url.searchParams.set("no_html", "1");
			url.searchParams.set("skip_disambig", "1");
			url.searchParams.set("t", "plume");

			let response: Response;
			try {
				response = await fetchImpl(url, { signal: request.signal, headers: { accept: "application/json" } });
			} catch (error) {
				// i18n-exempt：发给模型的错误
				throw new SearchError("速答接口请求失败", "SEARCH_PROVIDER_ERROR", { cause: error });
			}
			// i18n-exempt：发给模型的错误
			if (response.status === 429) throw new SearchError("速答接口限流了", "SEARCH_RATE_LIMITED");
			if (!response.ok) throw new SearchError(`速答接口返回 HTTP ${response.status}`, "SEARCH_PROVIDER_ERROR");

			let payload: InstantPayload;
			try {
				payload = (await response.json()) as InstantPayload;
			} catch (error) {
				// i18n-exempt：发给模型的错误
				throw new SearchError("速答接口的返回读不懂", "SEARCH_PROVIDER_ERROR", { cause: error });
			}

			const answer = answerOf(payload);
			return {
				...(answer ? { content: answer } : {}),
				sources: sourcesOf(payload, request.maxResults ?? 8),
				truncated: false,
			};
		},
	};
}

/** 直接的答案（定义、计算结果、摘要），有的话。 */
function answerOf(payload: InstantPayload): string | undefined {
	const parts = [payload.Answer, payload.AbstractText, payload.Definition].map((p) => p?.trim()).filter(Boolean);
	return parts.length > 0 ? parts[0] : undefined;
}

/**
 * 所有带 URL 的条目，摊平。
 *
 * `RelatedTopics` 里既有单条也有分组，分组的成员在下一层；只读顶层的话，落在某个分类上的查询大半答案都丢了。
 */
function sourcesOf(payload: InstantPayload, limit: number): SearchSource[] {
	const sources: SearchSource[] = [];
	const seen = new Set<string>();

	const add = (url: string | undefined, text: string | undefined) => {
		if (!url || seen.has(url) || sources.length >= limit) return;
		seen.add(url);
		const snippet = text?.trim();
		sources.push({
			url,
			// 这个接口的第一句就是标题，剩下的是摘要。
			...(snippet ? { title: (snippet.split(" - ")[0] ?? snippet).slice(0, 80), snippet } : {}),
		});
	};

	add(payload.AbstractURL, payload.AbstractText ?? payload.Heading);
	add(payload.DefinitionURL, payload.Definition);

	const walk = (topics: InstantTopic[] | undefined, depth: number) => {
		if (!topics || depth > 3) return;
		for (const topic of topics) {
			if (topic.Topics) walk(topic.Topics, depth + 1);
			else add(topic.FirstURL, topic.Text);
		}
	};
	walk(payload.RelatedTopics, 0);

	return sources;
}
