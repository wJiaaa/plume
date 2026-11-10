import type { ReactNode } from "react";

/** 这一轮里的一行。 */
export interface TurnEntry {
	key: string;
	node: ReactNode;
}

/**
 * 有过程的一轮：过程一行行摊在对话里（怎么分见 `turn-blocks.ts` 的 `TurnBlock`）。
 *
 * 跑着时不挂整轮的锚（「已工作 N 秒」）：它和底部运行指示说同一个数。
 *
 * 每一行各自一个带 key 的盒子：一句中途说的话，说出来的时候站在回答的位置上，模型接着干活它就成了过程的一部分——
 * 位置不变，不卸掉重建。
 */
export function TurnWork({ entries }: { entries: TurnEntry[] }) {
	return (
		// `group/turn`：收尾那句的页脚单独成行时（`Run.trailer`）跟着整轮悬停显出来。
		<div data-plume-turn-process="" className="group/turn">
			{entries.map((entry, index) => (
				// 里面那行什么也没画出来（一条空正文的回复）时，这层行距跟着不要，否则看不见的一行在两行之间多空出一截。
				<div key={entry.key} data-plume-entry={entry.key} className={index === 0 ? "has-[>:empty]:hidden" : "pt-2.5 has-[>:empty]:hidden"}>
					{entry.node}
				</div>
			))}
		</div>
	);
}
