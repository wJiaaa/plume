/**
 * 逻辑入口经 ctx.serve 开给设置分区的接口，两个入口共用这一份类型。
 *
 * key 只在 agent 进程里：界面拿到的是每家「填没填」，填新的、清掉经这里写；存下的 key 不回到渲染进程。
 */

/** 要 key 的几家，也是设置文件 `keys` 里的键。 */
export const KEY_IDS = ["tavily", "deepseek", "brave", "exa"] as const;
export type KeyId = (typeof KEY_IDS)[number];

/** 设置里能选的后端，顺序就是设置页里的顺序。 */
export const PROVIDER_IDS = ["tavily", "deepseek", "brave", "exa", "ddg-instant", "duckduckgo"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type SearchKeys = Partial<Record<KeyId, string>>;

/** 插件数据目录里 `search.json` 的内容；文件里的 key 是加密过的，这里是解开后的。 */
export interface SearchSettings {
	/** 人选的那家；null 是没选，按规则自动挑。 */
	provider: string | null;
	keys: SearchKeys;
}

/** 给界面看的那份：key 只说填没填。 */
export interface SearchSettingsView {
	provider: string | null;
	keys: Record<KeyId, boolean>;
}

export interface WebApi {
	settings(): Promise<SearchSettingsView>;
	/** 选一家；null 是取消选择（自动）。 */
	setProvider(provider: string | null): Promise<SearchSettingsView>;
	/** 换上一把新的 key；空串是清掉。 */
	setKey(which: KeyId, key: string): Promise<SearchSettingsView>;
	/** 在系统浏览器里打开这家申请 key 的页面。 */
	openSignup(which: KeyId): Promise<void>;
}
