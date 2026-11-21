/**
 * 设置页的版式：一章的页头、卡片、带标签的一行。
 *
 * 同一件事有两种形状，区别正是要点：`Row` 把标签和控件放在一行，控件小的时候合适；`Field` 上下叠放，整行宽的输入框要这种。
 * 两个并排放在这里，选哪个一眼看得出。
 */

import { Text } from "@plume/ui";

// 分组标题、卡片、一行在 @plume/ui 里，插件加的设置分区也用它们；这里沿用设置页一直用的名字。
export { SettingsCard as Card, SettingsNotice as Notice, SettingsRow as Row, SettingsSectionTitle as SectionTitle } from "@plume/ui";

/**
 * 一章顶上那一块：一句介绍，右边可能有一两颗按钮；`children` 接在介绍下面（模型页那行目录版本）。
 *
 * 章名在设置浮层顶上的面包屑里，这里只把它留给读屏（`h1`），不再画一个大标题。没有介绍、按钮时这一块不占地方，
 * 正文从顶上开始。介绍到正文的距离、介绍的行宽都在这里定一次：各页各写一份的话会漂成好几种，相邻两章切过去正文第一行上下跳。
 */
export function PageHeader({
	title,
	intro,
	actions,
	children,
	className = "",
}: {
	title: React.ReactNode;
	intro?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
	/** 位置和宽度，不是间距：下面那一段由这里给。 */
	className?: string;
}) {
	const shown = Boolean(intro || actions || children);
	return (
		<header className={`${shown ? "flex flex-wrap items-start justify-between gap-3 pb-6" : ""} ${className}`}>
			<h1 className="sr-only">{title}</h1>
			{shown && (
				<div className="min-w-0">
					{intro && <p className="max-w-[600px] text-label leading-relaxed text-ink-muted">{intro}</p>}
					{children}
				</div>
			)}
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
		</header>
	);
}

/** 标签在上、控件在下，给要整行宽的输入框用。 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<label className="block">
			<Text size="label" tone="muted" className="mb-1.5 block">
				{label}
			</Text>
			{children}
			{hint && (
				<Text size="detail" tone="faint" className="mt-1.5 block">
					{hint}
				</Text>
			)}
		</label>
	);
}
