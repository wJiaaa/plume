/**
 * 设置页里一节的版式：分组标题、卡片、带标签的一行。
 *
 * 放在这里而不是产品里，是因为插件也能往设置页加一节（`ui.settingsSection`）：两边用同一份，插件那一节和产品自己的几节
 * 才长得一样。产品的设置页经 `settings/layout.tsx` 用原来的名字（`SectionTitle`、`Card`、`Row`）引用它们。
 */

import type { LucideIcon } from "../icons/index.ts";
import { Text } from "../primitives/Text.tsx";

/**
 * 一组设置上面的分组标题。
 *
 * 只比行里的名字大一号、加粗，与下方卡片左沿对齐；标题下留 10px 接住卡片。
 */
export function SettingsSectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<Text as="h2" size="body" weight="semibold" className="mb-2.5">
			{children}
		</Text>
	);
}

/**
 * 一组设置。其余属性原样透传，卡片可以带一个 `data-` 标记给测试量它。自己画的一行带上 `data-settings-item`，就和 `SettingsRow` 算同一组的行。
 *
 * 装在一张圆角、细边、带 `card` 底色的卡片里，行与行之间一道细线（见 `controls.css` 的 `.plume-settings-card`），
 * 产品和插件画的设置分区共用这一种卡片。
 */
export function SettingsCard({ children, className = "", ...rest }: React.ComponentProps<"div">) {
	return (
		<div {...rest} className={`plume-settings-card ${className}`}>
			{children}
		</div>
	);
}

/**
 * 一组里带标签的一行，控件靠右。名字用中等字重，说明比名字小两档（`caption`）、用次要色：一页设置读下来先看到的是一列名字。
 *
 * 行的内边距、分隔线在 `controls.css`（`.plume-settings-row`）：行离卡片边 16px，上下 12px。
 * 自己画一行的地方（模型页的连接设置、智能体页的模型行）带上 `data-settings-item` 和这个类，就和这里排在同一组里。
 */
export function SettingsRow({
	title,
	detail,
	control,
	children,
}: {
	title: React.ReactNode;
	detail?: React.ReactNode;
	control?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		/*
		 * 行宽不够时控件掉到文字下面。控件是 `shrink-0`（挤没了的分段选择比挪了位置的更糟），并排时说明文字只能拿剩下的，
		 * 窄窗口下会变成两三个字宽、十几行高的一条。按这一行的宽度量（容器查询），宽窗口不受影响。
		 */
		<div data-settings-item="" className="plume-settings-row @container">
			{/*
			 * 控件落在这一行的中线上，不是贴着标题那一行：带说明文字的行占大多数，贴着标题的话一整组右边那列全体偏上。
			 * 只在同一行并排时才居中；窄窗口下控件掉到文字下面，是另一种排法。
			 */}
			<div data-settings-row className="flex flex-col gap-2 @md:flex-row @md:items-center @md:gap-8">
				<div className="min-w-0 flex-1">
					<Text as="div" size="label" weight="medium">
						{title}
					</Text>
					{detail && (
						<Text as="div" size="caption" tone="muted" className="mt-1 max-w-2xl leading-normal">
							{detail}
						</Text>
					)}
				</div>
				{control && <div className="flex shrink-0 items-center">{control}</div>}
			</div>
			{children}
		</div>
	);
}

const NOTICE_TONES = {
	danger: "border-danger/30 bg-danger/10 text-danger",
	accent: "border-accent/35 bg-accent/6 text-ink-muted",
	muted: "border-line",
} as const;

const NOTICE_ICONS = { danger: "text-danger", accent: "text-accent", muted: "text-ink-muted" } as const;

/**
 * 页面要告诉你的一句话：出错了（`danger`）、有东西要看一眼（`accent`），或者只是让你知道（`muted`）。
 *
 * 框和语气在这里定一次，产品的设置页和插件加的设置分区共用。安静的那种不定字色：用它的页面在里面放一行偏灰的标题、
 * 几行更淡的说明，这里给一种颜色会把层次压平。
 */
export function SettingsNotice({
	tone,
	icon: Icon,
	className = "",
	children,
	...rest
}: React.ComponentProps<"div"> & { tone: keyof typeof NOTICE_TONES; icon?: LucideIcon }) {
	return (
		<div {...rest} className={`rounded-lg border px-3.5 py-2.5 text-detail ${NOTICE_TONES[tone]} ${Icon ? "flex items-start gap-2" : ""} ${className}`}>
			{Icon && <Icon size={14} className={`mt-0.5 shrink-0 ${NOTICE_ICONS[tone]}`} aria-hidden />}
			{children}
		</div>
	);
}
