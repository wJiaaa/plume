/**
 * 设置页里一节的版式：分组标题、卡片、带标签的一行。
 *
 * 放在这里而不是产品里，是因为插件也能往设置页加一节（`ui.settingsSection`）：两边用同一份，插件那一节和产品自己的几节
 * 才长得一样。产品的设置页经 `settings/layout.tsx` 用原来的名字（`SectionTitle`、`Card`、`Row`）引用它们。
 */

import type { LucideIcon } from "../icons/index.ts";
import { Text } from "../primitives/Text.tsx";

/** 一组卡片上面的分组标题。 */
export function SettingsSectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<Text as="h2" size="title" weight="semibold" className="mb-3">
			{children}
		</Text>
	);
}

/**
 * 其余属性原样透传，卡片可以带一个 `data-` 标记给测试量它。
 *
 * 卡片用 `float` 那张纸：设置卡片和弹出菜单是同一个颜色，两个主题下都比页面亮一档的实底。边框随之用 `line-float`，
 * 那是给「画在自己那张纸上」的线准备的；卡片里面的线和控件怎么跟着换，见 `controls.css` 的 `.plume-settings-card`。
 */
export function SettingsCard({ children, className = "", ...rest }: React.ComponentProps<"div">) {
	return (
		<div {...rest} className={`plume-settings-card overflow-hidden rounded-lg border border-line-float bg-float ${className}`}>
			{children}
		</div>
	);
}

/** 卡片里带标签的一行，控件靠右。 */
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
		<div className="@container border-b border-line-soft px-4 py-3.5 last:border-b-0">
			{/*
			 * 控件落在这一行的中线上，不是贴着标题那一行：带说明文字的行占大多数，贴着标题的话一整张卡片右边那列全体偏上。
			 * 只在同一行并排时才居中；窄窗口下控件掉到文字下面，是另一种排法。
			 */}
			<div data-settings-row className="flex flex-col gap-2 @md:flex-row @md:items-center @md:gap-4">
				<div className="min-w-0 flex-1">
					<Text as="div" size="label" weight="medium">
						{title}
					</Text>
					{detail && (
						<Text as="div" size="label" tone="muted" className="mt-0.5 leading-relaxed">
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
