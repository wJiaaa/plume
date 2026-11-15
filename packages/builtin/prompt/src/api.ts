/**
 * 逻辑入口经 ctx.serve 开给设置分区「身份与准则」的接口，两个入口共用这一份类型。
 */

/** 内置那几套的 id，也是界面上取名字的键。 */
export const BUILTIN_IDS = ["general", "coding"] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

/** 身份、准则、名字的上限（UTF-8 字节；名字按字数）。 */
export const LIMITS = { identity: 4 * 1024, guidelines: 32 * 1024, name: 60 } as const;

/** 设置页里的一套。内置的没有 `name`，界面按 id 取当前语言的名字；`modified` 是内置的那套被人改过（自己写的总是 false）。 */
export interface PresetView {
	id: string;
	builtin: boolean;
	modified: boolean;
	name?: string;
	identity: string;
	guidelines: string;
}

/** 选中的那套用不了、退回了「通用」：找不到文件，或文件读不出、不合格。 */
export interface PresetProblem {
	id: string;
	reason: "missing" | "invalid";
}

export interface PresetsView {
	presets: PresetView[];
	/** 新开的会话用哪一套（用不了时已经是 `general`）。 */
	selected: string;
	problem: PresetProblem | null;
}

/** 新建或改一套时交上来的。 */
export interface PresetDraft {
	name: string;
	identity: string;
	guidelines: string;
}

export interface PromptApi {
	view(): Promise<PresetsView>;
	/**
	 * `id` 为 undefined 时新建一套。改内置的那套时名字不看，存成一份覆盖；改得和原文一样就是恢复默认。
	 * 不合格时抛错，错误文字按界面语言写。
	 */
	save(id: string | undefined, draft: PresetDraft): Promise<PresetsView>;
	/** 删掉自己建的一套（移进废纸篓）。删的是选中的那套时改选「通用」。内置的不能删。 */
	remove(id: string): Promise<PresetsView>;
	/** 内置的那套恢复成随应用发的原文。 */
	reset(id: string): Promise<PresetsView>;
	select(id: string): Promise<PresetsView>;
}
