/** 运行中的普通输入框提供停止；插话输入框有东西时发送，能停（`stoppable`）的空着时是停止键；禁用时仍保留整张卡片。 */
export function childComposerState({
	active,
	running,
	loading,
	disabled,
	steer,
	stoppable,
	hasContent,
}: {
	active: boolean;
	running: boolean;
	loading: boolean;
	disabled: boolean;
	steer: boolean;
	stoppable: boolean;
	hasContent: boolean;
}) {
	const blocked = !active || loading || disabled;
	return {
		disabled: blocked,
		readOnly: blocked,
		stop: !blocked && running && (!steer || (stoppable && !hasContent)),
		// 不看「正在发送」：它从按下到发送返回只活一两帧，算进来只会让发送键闪一下暗；防连按由输入框自己的 pending 挡着。
		canSend: !blocked && (!running || steer) && hasContent,
	};
}
