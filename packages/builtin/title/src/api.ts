/** 设置（`ctx.settings`），设置分区经 `ui.useSettings` 读、改。 */
export interface TitleSettings {
	/** 起标题用的模型（`SessionModel.id`）；没选时是 undefined，用这个会话自己的模型。 */
	model: string | undefined;
	/** 智能标题总结开着没有；缺省开着。 */
	enabled: boolean;
}

/** 存下的、界面改的都过一遍：模型只认非空字符串，开关只有明确写了 false 才算关。 */
export function normalizeSettings(saved: Record<string, unknown>): TitleSettings {
	return { model: typeof saved.model === "string" && saved.model ? saved.model : undefined, enabled: saved.enabled !== false };
}
