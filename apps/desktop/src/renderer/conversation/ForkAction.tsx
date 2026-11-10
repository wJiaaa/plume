/**
 * 消息底下那排的「从这里分叉」，问题和回复底下是同一颗。
 *
 * 在问题上分叉，新会话停在它之前、问题回到输入框——撤回的那一套，做在副本上；在回复上分叉，新会话带着这条回复，
 * 输入框是空的，从这里换个方向接着说。原会话两种都不动，所以一轮还在跑也照样给。
 */

import { IconButton, useI18n } from "@plume/ui";
import { Split } from "@plume/ui/icons";
import { useState } from "react";

export function ForkAction({ onFork }: { onFork: () => Promise<void> }) {
	const { t } = useI18n();
	// 按下了、新会话还没开出来：再按一次会从同一处分叉两份。
	const [forking, setForking] = useState(false);
	return (
		<IconButton
			data-message-fork=""
			label={t("messageActions.fork")}
			disabled={forking}
			onClick={() => {
				if (forking) return;
				setForking(true);
				void onFork().finally(() => setForking(false));
			}}
			icon={<Split size={12.5} strokeWidth={1.8} className="rotate-90" />}
		/>
	);
}
