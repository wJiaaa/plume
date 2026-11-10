import { createElement } from "react";

/**
 * 字号档位，做成组件。
 *
 * 档位本身在 `theme.css` 里，每一档带着自己的行高和字距，都由用户设的那一个字号推出来。这个文件只说
 * 哪一档配哪个字重——缺的正是这个搭配。
 *
 * 只靠字号区分层级、档与档只差半个像素的话（一行 12.5，下面那行 12，再下面 11.5），半个像素没有人
 * 看得出。读起来不是三个层级，而是一个层级排得不讲究。
 *
 * 所以每一档在下面配一次字重。标题更大*也*更重，说明更小*也*更淡，层级同时在两个轴上分开，而不是在
 * 一个轴的零头上。`weight` 仍然可以覆盖，给一行要强调又不改字号的情况——但默认值应该对得足够常，
 * 很少需要去动它。
 */
const SIZES = {
	/** 页面标题——一屏一个。 */
	display: "text-display",
	/** 一屏里大分区的标题。 */
	heading: "text-heading",
	/** 小节和卡片的标题。 */
	title: "text-title",
	/** 正文：消息、描述，一句一句读的东西。 */
	body: "text-body",
	/** 控件、行、表格单元——界面的工作字号。 */
	label: "text-label",
	/** 标签下面的次要细节。 */
	detail: "text-detail",
	/** 时间戳、计数、角标。 */
	caption: "text-caption",
} as const;

const TONES = {
	default: "text-ink",
	muted: "text-ink-muted",
	faint: "text-ink-faint",
	danger: "text-danger",
	accent: "text-accent",
} as const;

const WEIGHTS = {
	normal: "",
	medium: "font-medium",
	semibold: "font-semibold",
} as const;

/**
 * 没人指定时每一档的字重。
 *
 * 标题加重，因为档距一小，光靠字号就分不开了；连续的正文不加，因为加粗的正文更难读，并不更重要。
 */
const DEFAULT_WEIGHT: Record<keyof typeof SIZES, keyof typeof WEIGHTS> = {
	display: "semibold",
	heading: "semibold",
	title: "medium",
	body: "normal",
	label: "normal",
	detail: "normal",
	caption: "normal",
};

/** 一段文字：`size` 选字号档位（每档带着自己的行高、字距和默认字重），`tone` 选颜色。 */
export function Text({
	size = "label",
	tone = "default",
	weight,
	as = "span",
	mono = false,
	numeric = false,
	className = "",
	children,
	...rest
}: {
	size?: keyof typeof SIZES;
	tone?: keyof typeof TONES;
	/** 覆盖这一档平时的字重。 */
	weight?: keyof typeof WEIGHTS;
	/** 渲染成什么元素。默认 `span`，能放进一句话里。 */
	as?: "span" | "p" | "div" | "h1" | "h2" | "h3" | "label" | "code";
	/** 等宽字体，给正文里引用的标识符和路径。 */
	mono?: boolean;
	/**
	 * 等宽数字。
	 *
	 * 给原地变化的数——token 数、计时、diff 统计。比例数字每跳一下字就左右挪，读起来是闪烁。
	 */
	numeric?: boolean;
	className?: string;
	children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
	return createElement(
		as,
		{
			...rest,
			className: [SIZES[size], TONES[tone], WEIGHTS[weight ?? DEFAULT_WEIGHT[size]], mono ? "font-mono" : "", numeric ? "tabular-nums" : "", className]
				.filter(Boolean)
				.join(" "),
		},
		children,
	);
}
