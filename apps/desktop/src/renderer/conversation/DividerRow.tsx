import type { HTMLAttributes, ReactNode } from "react";

/** 转录里标一个分界点的那种行：一条横线，当中一个图标一句话。换模型、压缩完上下文都是这样一个分界。 */
export function DividerRow({ icon, text, ...rest }: { icon: ReactNode; text: string } & HTMLAttributes<HTMLDivElement>) {
	return (
		<div {...rest} className="flex items-center gap-3 py-1 text-caption text-ink-faint">
			<span aria-hidden className="h-px min-w-6 flex-1 bg-line-soft" />
			<span className="flex min-w-0 items-center gap-1.5" data-plume-tip={text}>
				{icon}
				<span className="truncate">{text}</span>
			</span>
			<span aria-hidden className="h-px min-w-6 flex-1 bg-line-soft" />
		</div>
	);
}
