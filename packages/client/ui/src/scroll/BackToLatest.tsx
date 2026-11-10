/**
 * 回到底部的路，只在确实有路可回时才给。
 *
 * 往上翻过的转录，除了一路拖回去，没有别的办法到最新那条消息——而一轮还在输出时，「一路」的终点
 * 还在往下走。所以给一个按钮，浮在输入框正上方、最后一条消息该在的位置。
 *
 * 不管显不显示它都挂着。按需挂载的话，它会以满不透明度直接出现在最终位置，看上去和布局抖了一下一样。
 *
 * 出现和离开不是镜像。出现时稍微往上升一点，因为它是从转录底部来的，也指向那里。离开时原地不动、
 * 直接化掉：它离开是因为你**已经到了**底部，滚动结束时一个按钮往下掉，读起来像最后又往下冲了一下
 * ——正是这个按钮要替你省掉的那一跳，被它当成谢幕动作做了一遍。
 *
 * `pointer-events` 跟着可见性走——看不见却还吞掉转录上点击的按钮，比没有按钮更糟。
 */

import { translate } from "../i18n/translate.ts";
import { ArrowDown } from "../icons/index.ts";

export function BackToLatest({ show, unread, onClick }: { show: boolean; unread: number; onClick: () => void }) {
	return (
		<div
			className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center"
			style={
				show
					? {
							transform: "translateY(0)",
							opacity: 1,
							transition: "opacity var(--plume-t-base) var(--plume-e-out), transform var(--plume-t-base) var(--plume-e-out)",
						}
					: {
							/*
							 * 等它化完了才落回起点。
							 *
							 * 这个偏移必须在，否则下次没有地方可以升起来。但还看得见时移动，就是这里要避免的
							 * 那一冲，所以位移不给时长、只给一段和淡出一样长的延迟：发生时按钮已经看不见了，
							 * 只是在起点等着。
							 */
							transform: "translateY(6px)",
							opacity: 0,
							transition: "opacity var(--plume-t-quick) var(--plume-e-out), transform 0s var(--plume-t-quick)",
						}
			}
		>
			<button
				type="button"
				tabIndex={show ? 0 : -1}
				aria-hidden={!show}
				/* 写在元素上，按钮隐藏时探针也能读到计数——问标签没用，隐藏的按钮什么都不说。 */
				data-unread={unread}
				data-plume-tip={translate(unread > 0 ? "backToLatest.unread" : "backToLatest.latest")}
				aria-label={translate(unread > 0 ? "backToLatest.unread" : "backToLatest.latest")}
				onClick={onClick}
				className={`plume-composer relative grid h-8 w-8 place-items-center rounded-full border border-line-soft bg-float text-ink-muted transition-colors duration-[var(--plume-t-quick)] hover:text-ink ${
					show ? "pointer-events-auto" : ""
				}`}
			>
				{/*
				 * 只有你在上面时确实来了新东西，才说「有新内容」。否则这是导航不是通知，挂个点就是狼来了。
				 */}
				{unread > 0 && <span aria-hidden className="absolute top-[5px] right-[5px] h-[6px] w-[6px] rounded-full bg-accent" />}
				<ArrowDown size={14} strokeWidth={2} aria-hidden />
			</button>
		</div>
	);
}
