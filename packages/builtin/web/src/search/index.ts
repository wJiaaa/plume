/**
 * 网页搜索的接缝：模型那边只有一个工具，背后是哪家服务由这里选。
 *
 * 服务会变（有的收费了、有的换接口了），模型提问的方式不该跟着变，所以工具是一层、各家后端是另一层。
 *
 * 两条规矩：
 * - `available()` 只做本地判断（有没有 key），不联网。每次搜索都要重新选一次，选的时候发请求就等于每次搜索前都多探一次。
 * - 选择不看清单里的先后。指定的优先；没指定时填了 key 的胜过免配置的，只有一个免配置默认就用它，真的分不出来时报错让人选，
 *   不抛硬币。
 */

export interface SearchSource {
	url: string;
	title?: string;
	snippet?: string;
	/** 发布或抓取时间，按服务商给的原样。 */
	publishedAt?: string;
}

export interface SearchResult {
	/** 服务商自己写的一段答案（有的有，有的没有）。没有就空着，不编一段。 */
	content?: string;
	sources: SearchSource[];
	/** 接缝按 `maxResults` 截过。 */
	truncated: boolean;
}

export interface SearchRequest {
	query: string;
	/** 条数上限，接缝在返回时执行。不开给模型：花多少 token 是配置的人定的，模型看不到这份预算。 */
	maxResults?: number;
	signal?: AbortSignal;
}

export interface SearchProvider {
	/** 注册表里的键，设置里存的就是它。 */
	id: string;
	/** 出错时说是哪一家。 */
	name: string;
	/** 现在能不能用（有没有 key）。只做本地判断，不联网。 */
	available(): boolean;
	/**
	 * 免配置的后端怎么参与选择：`"default"` 是什么都没配时用的那个，`"optional"` 只在被点名时用。
	 * 只有不要 key 的后端带它：填了 key 是有人做的决定，免配置能用不是。
	 */
	keyless?: "default" | "optional";
	search(request: SearchRequest): Promise<SearchResult>;
}

/** 搜索跑不了的原因。`code` 是开放的，后端可以有自己的。 */
export class SearchError extends Error {
	readonly code: string;
	constructor(message: string, code: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SearchError";
		this.code = code;
	}
}

export interface SearchRegistry {
	/** 这一次搜索用哪一家。 */
	select(configuredId?: string | null): SearchProvider;
	/** 经选中的那家搜一次，并把条数压到上限以内。 */
	search(request: SearchRequest, configuredId?: string | null): Promise<SearchResult>;
}

/**
 * 在这几家里选。清单是写死的（`defaults.ts`），`id` 不重复、免配置的默认只有一个由那份清单保证。
 *
 * 发给模型的错误文字保持原样，不随界面语言变。
 */
export function createSearchRegistry(list: readonly SearchProvider[]): SearchRegistry {
	const providers = new Map(list.map((provider) => [provider.id, provider]));

	/** 唯一一种要人做决定而不是改设置的失败，把候选都列出来。 */
	function ambiguous(candidates: SearchProvider[]): SearchError {
		// i18n-exempt：发给模型的错误
		const ids = candidates.map((provider) => provider.id).join("、");
		return new SearchError(`有多个可用的搜索提供方（${ids}），请在设置里指定用哪个`, "SEARCH_PROVIDER_AMBIGUOUS");
	}

	function select(configuredId?: string | null): SearchProvider {
		// 每种失败各有自己的 code，因为改法不同：没注册是拼错了，注册了不能用是缺 key，两个都配了是还没选。
		if (configuredId) {
			const chosen = providers.get(configuredId);
			// i18n-exempt：发给模型的错误
			if (!chosen) throw new SearchError(`没有注册过叫 ${configuredId} 的搜索提供方`, "SEARCH_PROVIDER_MISSING");
			if (!chosen.available()) {
				// i18n-exempt：发给模型的错误
				throw new SearchError(`搜索提供方 ${configuredId} 还不能用（多半是没填 key）`, "SEARCH_PROVIDER_UNAVAILABLE");
			}
			return chosen;
		}
		const usable = [...providers.values()].filter((provider) => provider.available());
		// i18n-exempt：发给模型的错误
		if (usable.length === 0) throw new SearchError("没有可用的搜索提供方", "SEARCH_PROVIDER_UNAVAILABLE");
		if (usable.length === 1) return usable[0]!;

		// 填了 key 的先问：贴了 key 却没点单选的人是想用它，拿免配置的默认回答等于悄悄无视他的设置。两把 key 只有他自己能选。
		const configured = usable.filter((provider) => provider.keyless === undefined);
		if (configured.length === 1) return configured[0]!;
		if (configured.length > 1) throw ambiguous(configured);

		// 什么都没配，没有谁的设置被推翻，由默认的来答；没有默认就只能问人。
		const fallback = usable.filter((provider) => provider.keyless === "default");
		if (fallback.length === 1) return fallback[0]!;
		throw ambiguous(usable);
	}

	return {
		select,
		async search(request, configuredId) {
			const provider = select(configuredId);
			const result = await provider.search(request);
			// 截断放在这里而不是交给每家后端：要每个适配器都记得的上限，总有一个会忘。
			const limit = request.maxResults;
			if (limit !== undefined && result.sources.length > limit) {
				return { ...result, sources: result.sources.slice(0, limit), truncated: true };
			}
			return result;
		},
	};
}
