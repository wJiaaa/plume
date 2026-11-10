/** 运行中的普通输入框提供停止；插话输入框始终发送，禁用时仍保留整张卡片。 */
export function childComposerState({
	active,
	running,
	loading,
	sending,
	disabled,
	steer,
	hasContent,
}: {
	active: boolean;
	running: boolean;
	loading: boolean;
	sending: boolean;
	disabled: boolean;
	steer: boolean;
	hasContent: boolean;
}) {
	const blocked = !active || loading || disabled;
	return {
		disabled: blocked,
		readOnly: blocked,
		stop: !blocked && running && !steer,
		canSend: !blocked && !sending && (!running || steer) && hasContent,
	};
}
