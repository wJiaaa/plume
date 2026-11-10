import type { LucideIcon } from "../icons/index.ts";

/**
 * 空面板正文的中间。
 *
 * 居中的图标、名字、一句话说这是什么。每一种标签页都是同一个形状，面板读起来是一个东西装着几种内容，
 * 而不是碰巧共用一个框的几块互不相干的屏。
 *
 * 单独一个文件，因为面板外壳和它里面的东西都要用它，由外壳导出的话两边会互相 import。
 */
export function PanelEmpty({
	icon: Icon,
	art,
	title,
	children,
}: {
	icon: LucideIcon;
	/** 画在图标的位置上、比一枚线性图标更能说明这里该有什么的东西——子智能体面板放的是几张睡着的脸。 */
	art?: React.ReactNode;
	title: string;
	/** 可省：有些空状态的标题已经把话说完了，底下再补一句就是在解释一个不需要解释的东西。 */
	children?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 pb-6 text-center">
			{art ?? <Icon size={30} strokeWidth={1.35} className="text-ink-faint" />}
			<h2 className="mt-3.5 text-title font-medium text-ink">{title}</h2>
			{children !== undefined && <p className="mt-2 max-w-[290px] text-label leading-relaxed text-ink-muted">{children}</p>}
		</div>
	);
}
