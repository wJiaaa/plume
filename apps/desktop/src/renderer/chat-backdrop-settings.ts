import type { Appearance, ChatBackgroundEffect, ChatBackgroundFit } from "../shared/appearance.ts";
import { CHAT_BACKGROUND_DEFAULTS } from "../shared/appearance.ts";
import type { ManagedSkin } from "./skin-values.ts";

export type EffectiveChatBackdrop = {
	source: { kind: "skin"; image: string } | { kind: "global"; name: string | null };
	effect: ChatBackgroundEffect;
	fit: ChatBackgroundFit;
	opacity: number;
	onNewChat: boolean;
	inChat: boolean;
};

/** 皮肤背景只覆盖这一刻怎么画；人的全局图片和各项偏好不参与写回，撤下皮肤即可原样恢复。 */
export function effectiveChatBackdrop(appearance: Appearance, managed: ManagedSkin | undefined): EffectiveChatBackdrop {
	const background = managed?.background;
	if (background) {
		return {
			source: { kind: "skin", image: background.image },
			effect: background.effect,
			fit: background.fit,
			opacity: background.opacity,
			onNewChat: background.onNewChat,
			inChat: background.inChat,
		};
	}
	return {
		source: { kind: "global", name: appearance.chatBackground ?? null },
		effect: appearance.chatBackgroundEffect ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundEffect,
		fit: appearance.chatBackgroundFit ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundFit,
		opacity: appearance.chatBackgroundOpacity ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundOpacity,
		onNewChat: appearance.chatBackgroundOnNewChat ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundOnNewChat,
		inChat: appearance.chatBackgroundInChat ?? CHAT_BACKGROUND_DEFAULTS.chatBackgroundInChat,
	};
}
