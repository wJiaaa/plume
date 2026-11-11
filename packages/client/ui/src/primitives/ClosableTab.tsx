import { X } from "../icons/index.ts";
import type { MouseEvent, ReactNode } from "react";
import type { DataAttributes } from "./Button.tsx";

/**
 * 窗格标签条里的一个标签：用来挑它的名字，和关掉它的 ✕。
 *
 * 终端和文件窗格共用这一份，各写一份的话会慢慢走样——一个标签被读成标签，另一个被读成普通按钮。
 * `data-*` 落在外层上，测试按它找标签。
 *
 * ✕ 只出现在指着的那个和当前那个标签上。每个标签都带一个的话，三个标签的一条就成了六个目标，关闭
 * 按钮和名字一样响——而这一条的全部用处就是让人按名字挑。
 */
export function ClosableTab({
	children,
	current,
	onSelect,
	onClose,
	closeLabel,
	tip,
	onContextMenu,
	className = "",
	...data
}: DataAttributes & {
	children: ReactNode;
	current: boolean;
	onSelect: () => void;
	onClose: () => void;
	/** 说出关的是哪个标签：一排同样的「关闭」按钮对读屏什么都没说。 */
	closeLabel: string;
	tip?: string;
	onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
	className?: string;
}) {
	return (
		<div
			{...data}
			onContextMenu={onContextMenu}
			// 中键点标签关掉它，和浏览器的标签一样。按下时拦住，Windows 上中键按下会让外面那条横滚的标签栏进入自动滚动。
			onMouseDown={(event) => event.button === 1 && event.preventDefault()}
			onAuxClick={(event) => {
				if (event.button !== 1) return;
				event.preventDefault();
				onClose();
			}}
			className={`group/tab flex shrink-0 items-center gap-1 rounded-lg pr-0.5 pl-2 transition-colors duration-[var(--plume-t-quick)] ${
				// 悬停时也亮，否则一排名字说不出指针在哪一个上。
				current ? "bg-card-hover text-ink" : "text-ink-faint hover:bg-card-hover/60 hover:text-ink"
			} ${className}`}
		>
			<button type="button" role="tab" aria-selected={current} data-plume-tip={tip} onClick={onSelect} className="py-1 text-detail whitespace-nowrap">
				{children}
			</button>
			<button
				type="button"
				data-plume-hover-reveal
				aria-label={closeLabel}
				onClick={onClose}
				className={`rounded-md p-0.5 transition-opacity duration-[var(--plume-t-quick)] hover:bg-elevated ${
					current ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-60"
				}`}
			>
				<X size={11} strokeWidth={2.2} />
			</button>
		</div>
	);
}
