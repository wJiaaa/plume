/**
 * 环境卡片里的一行（`ui.environmentSection` 的 `background`、`output`、`foot` 几块都用它）：前置图标、一句话、行尾一小段事实，
 * 悬停时行尾换成一颗动作按钮。卡片里的行出自好几个插件，长得一样才读得出是同一张卡片。
 *
 * 只有一套说法：「还在跑」是图标右下角一个绿点；「还剩多少」是行底一根细线（`progress`），快到点了（`urgent`）换成强调色；
 * 行尾一律是浅色小字。图标一律浅灰，不按种类上色。
 */

import type { ReactNode } from "react";
import { ScrollText } from "../scroll/ScrollText.tsx";

export function EnvironmentRow({
	icon,
	title,
	fact,
	running = false,
	progress,
	urgent = false,
	tip,
	onClick,
	action,
	...rest
}: {
	/** 前置图标，14px，说这一行是什么（命令、检查、子会话）。 */
	icon: ReactNode;
	/** 这一行的那句话：人写的、或者命令的说明。装不下时悬停读出来。 */
	title: string;
	/** 行尾的事实：端口、几点、`2/5`、「已完成」。短；要说清的长话放 `tip`。 */
	fact?: ReactNode;
	/** 还在跑：图标右下角挂绿点。 */
	running?: boolean;
	/** 0–1，行底那根细线画多长：检查是剩下的时间，进度是走完的那段。不给就没有线。 */
	progress?: number | undefined;
	/** 快到点了：细线、图标和行尾换成强调色（检查的最后一分钟）。 */
	urgent?: boolean;
	/** 悬停提示，挂在整行上：完整的命令、种类和时间。 */
	tip?: string | undefined;
	/** 点了去哪；不给时这一行只是一条记录，不能点。 */
	onClick?: (() => void) | undefined;
	/** 悬停、键盘焦点进来时盖住行尾的那颗按钮：停下、取消。`label` 是按钮上的字。 */
	action?: ({ label: string; onClick: () => void; disabled?: boolean } & Record<`data-${string}`, string | undefined>) | undefined;
} & Record<`data-${string}`, string | undefined>) {
	const body = (
		<>
			<span className="plume-env-row-icon" data-running={running ? "" : undefined}>
				{icon}
			</span>
			<span className="plume-env-row-title">
				<ScrollText text={title} />
			</span>
		</>
	);
	const { label, onClick: act, disabled, ...actionData } = action ?? { label: "", onClick: () => {} };
	return (
		<div
			className="plume-env-row plume-scroll"
			data-environment-item=""
			data-urgent={urgent ? "" : undefined}
			data-has-action={action ? "" : undefined}
			{...rest}
		>
			{onClick ? (
				<button type="button" className="plume-env-row-main" data-plume-tip={tip} onClick={onClick}>
					{body}
				</button>
			) : (
				<div className="plume-env-row-main" data-plume-tip={tip}>
					{body}
				</div>
			)}
			{(fact !== undefined || action) && (
				<span className="plume-env-row-tail">
					{fact !== undefined && <span className="plume-env-row-fact">{fact}</span>}
					{action && (
						<button type="button" className="plume-env-row-action" disabled={disabled} onClick={act} {...actionData}>
							{label}
						</button>
					)}
				</span>
			)}
			{progress !== undefined && (
				<span className="plume-env-row-progress" aria-hidden>
					<i style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }} />
				</span>
			)}
		</div>
	);
}
