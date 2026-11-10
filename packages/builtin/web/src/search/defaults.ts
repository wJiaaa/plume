import type { SearchKeys } from "../api.ts";
import { duckDuckGoProvider } from "./duckduckgo.ts";
import type { SearchRegistry } from "./index.ts";
import { instantAnswerProvider } from "./instant.ts";
import { BRAVE_PROVIDER_ID, DEEPSEEK_PROVIDER_ID, EXA_PROVIDER_ID, keyedSearchProvider, TAVILY_PROVIDER_ID } from "./keyed.ts";

/**
 * 装上就能搜：免配置的两家无条件注册；要 key 的几家调用时才读 key，贴上 key 当场可用，没贴就不碍事。
 * 用哪一家由 `select` 定：人选的那家；没选时填了 key 的胜过免配置的默认。
 */
export function registerDefaultSearchProviders(registry: SearchRegistry, keys: () => SearchKeys, fetchImpl: typeof fetch = fetch): void {
	registry.register(duckDuckGoProvider(fetchImpl));
	registry.register(instantAnswerProvider(fetchImpl));
	registry.register(keyedSearchProvider(TAVILY_PROVIDER_ID, () => keys().tavily, fetchImpl));
	registry.register(keyedSearchProvider(EXA_PROVIDER_ID, () => keys().exa, fetchImpl));
	registry.register(keyedSearchProvider(BRAVE_PROVIDER_ID, () => keys().brave, fetchImpl));
	registry.register(keyedSearchProvider(DEEPSEEK_PROVIDER_ID, () => keys().deepseek, fetchImpl));
}
