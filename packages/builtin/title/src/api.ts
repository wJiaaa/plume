/** 逻辑入口经 `ctx.serve` 开给设置分区的接口。 */
export interface TitleApi {
	/** 起标题用的模型（`SessionModel.id`）；没选时是 undefined，用这个会话自己的模型。 */
	model(): Promise<string | undefined>;
	setModel(model: string | undefined): Promise<void>;
	/** 智能标题总结开着没有；缺省开着。 */
	enabled(): Promise<boolean>;
	setEnabled(enabled: boolean): Promise<void>;
}
