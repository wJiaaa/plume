/** 插件自带的图标；没提供或图片损坏时，保留同尺寸的默认标记。 */

import { translate } from "@plume/ui";
import { Blocks } from "@plume/ui/icons";
import { useState } from "react";

export function PluginIcon({ logo, size = 32 }: { logo?: string; size?: number }) {
	const [failed, setFailed] = useState<string>();
	const radius = size > 40 ? "rounded-panel" : "rounded-field";
	if (logo && logo !== failed) {
		return <img src={logo} alt="" width={size} height={size} draggable={false} onError={() => setFailed(logo)} className={`shrink-0 object-cover ${radius}`} />;
	}
	return (
		<span
			role="img"
			// 只给读屏：旁边总有插件名，悬停再说一遍「插件」是第三遍。
			aria-label={translate("pluginIcon.plugin")}
			style={{ width: size, height: size }}
			className={`flex shrink-0 items-center justify-center border border-line-soft bg-gradient-to-b from-card to-card/40 text-ink-faint ${radius}`}
		>
			<Blocks size={Math.round(size * 0.42)} strokeWidth={1.7} />
		</span>
	);
}
