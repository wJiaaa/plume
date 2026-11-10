/**
 * 什么都不用配的搜索：按没开脚本的浏览器那样请求 DuckDuckGo 的无脚本页面，从网页里读出结果。
 *
 * 这是几个选项里最弱的，名字和设置页的说明都这么写：网页不是接口，随时会改；对方还会限流、挡自动访问。
 * 所以它只在被点名时用，从不替人选上（`keyless: "optional"`），什么都没配时用的是速答接口。
 */

import { decodeEntities } from "../entities.ts";
import { SearchError, type SearchProvider, type SearchRequest, type SearchResult, type SearchSource } from "./index.ts";

const DUCKDUCKGO_PROVIDER_ID = "duckduckgo";

const ENDPOINT = "https://html.duckduckgo.com/html/";
/** 浏览器样子的 UA：别的 UA 拿到的是要脚本的另一版页面。 */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** 重试前等多久（毫秒）。第一次之后再试两次，第三次就是在硬压对方了。 */
const BACKOFF_MS = [400, 1200];

export function duckDuckGoProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
	return {
		id: DUCKDUCKGO_PROVIDER_ID,
		// i18n-exempt：发给模型的名字
		name: "DuckDuckGo（免配置，质量有限）",
		available: () => true,
		keyless: "optional",
		async search(request: SearchRequest): Promise<SearchResult> {
			const html = await fetchWithBackoff(fetchImpl, request);
			const sources = parseResults(html);
			if (sources.length === 0 && /anomaly|unusual traffic|blocked/i.test(html)) {
				// 被限流和真的没结果在列表上看是一样的，说清是哪一种：一个是「过会儿再试」，一个是「换个说法」。
				// i18n-exempt：发给模型的错误
				throw new SearchError("DuckDuckGo 暂时限流了，过一会儿再试", "SEARCH_RATE_LIMITED");
			}
			return { sources, truncated: false };
		},
	};
}

async function fetchWithBackoff(fetchImpl: typeof fetch, request: SearchRequest): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
		if (attempt > 0) {
			await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
			// i18n-exempt：发给模型的错误
			if (request.signal?.aborted) throw new SearchError("搜索已取消", "SEARCH_ABORTED");
		}
		try {
			const response = await fetchImpl(ENDPOINT, {
				method: "POST",
				signal: request.signal,
				headers: { "user-agent": USER_AGENT, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ q: request.query }).toString(),
			});
			// 这个端点要你慢一点时回 202。
			if (response.status === 429 || response.status === 202) {
				// i18n-exempt：发给模型的错误
				lastError = new SearchError("DuckDuckGo 限流", "SEARCH_RATE_LIMITED");
				continue;
			}
			// i18n-exempt：发给模型的错误
			if (!response.ok) throw new SearchError(`DuckDuckGo 返回 HTTP ${response.status}`, "SEARCH_PROVIDER_ERROR");
			return await response.text();
		} catch (error) {
			if (error instanceof SearchError && error.code !== "SEARCH_RATE_LIMITED") throw error;
			lastError = error;
		}
	}
	throw lastError instanceof SearchError
		? lastError
		: // i18n-exempt：发给模型的错误
			new SearchError("DuckDuckGo 请求失败", "SEARCH_PROVIDER_ERROR", { cause: lastError });
}

// 下面几个辅助函数放在 parseResults 前面：它的正则里引号成单数，check-i18n 的字符串扫描会从那里错位，后面的中文注释会被当成字符串。

/**
 * DuckDuckGo 点击跟踪外壳后面的真实地址。
 *
 * 结果链到 `/l/?uddg=<编码后的地址>` 而不是网站本身；把外壳交给模型，它拿到的是只在浏览器会话里有效、也看不出来源的地址。
 */
function unwrapRedirect(href: string): string | undefined {
	const decoded = href.replace(/&amp;/g, "&");
	const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
	const candidate = wrapped ? safeDecode(wrapped[1] ?? "") : decoded.startsWith("//") ? `https:${decoded}` : decoded;
	if (!candidate) return undefined;
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 从无脚本结果页里读出结果。
 *
 * 认的是这个页面用了多年的类名；拿不到真实 URL 的一条直接丢掉：没有能打开的地址就不算来源，编一个就是接缝在说谎。
 */
export function parseResults(html: string): SearchSource[] {
	const sources: SearchSource[] = [];
	const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

	const snippets: string[] = [];
	for (const match of html.matchAll(snippetPattern)) snippets.push(stripTags(match[1] ?? ""));

	let index = 0;
	for (const match of html.matchAll(linkPattern)) {
		const url = unwrapRedirect(match[1] ?? "");
		if (!url) {
			index += 1;
			continue;
		}
		const title = stripTags(match[2] ?? "");
		const snippet = snippets[index];
		sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
		index += 1;
	}
	return sources;
}
