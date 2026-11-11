/**
 * 共用的 Tailwind 类名组合：控件、卡片、代码、几种文字。产品界面、@plume/ui 的组件、插件的界面入口都从这里取，
 * 改一处外观各处一起变。只用 theme.css 里的 token。
 *
 * 产品的 Tailwind 扫描这个包，这里写到的类一定会生成：第三方插件自己写的 Tailwind 类扫不到，用这里导出的组合可以。
 * 只在一个页面用一次的布局（栅格、窗口顶行、页面边距）写在用的地方，不放进来。
 */

export const text = {
	/** 次要说明：路径、状态、空状态。 */
	faint: "text-caption text-ink-faint",
	error: "text-detail text-danger",
	link: "text-accent hover:underline",
};

/** 单行输入框和下拉框：无描边的一块 card 底，悬停、聚焦时深一档。高度只有 control 这一档。 */
export const field =
	"h-control min-w-0 rounded-field bg-card px-4 text-label text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-card-hover focus:bg-card-hover";

/** 包住输入框的 label：上面一行小字，下面是控件。 */
export const fieldLabel = "flex flex-col gap-1.5 text-caption font-medium text-ink-muted";

/** 多行输入框：没有框，放进自己画框的容器里（主输入框那种），外观由容器出。 */
export const textarea = "min-w-0 resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-faint";

type ButtonVariant = "primary" | "ghost" | "subtle" | "soft" | "danger";

/**
 * 按钮：五种外观、三档高度。焦点环是全局的（见渲染进程的 styles.css）；按下不缩放，底色深一档。
 * 组件见 @plume/ui 的 Button，一般不直接拼这些。
 */
export const button = {
	/** 禁用时不关掉指针事件：悬停提示要能解释它为什么不能按。 */
	base: "flex shrink-0 cursor-pointer items-center whitespace-nowrap transition-[background-color,border-color,opacity]",
	/** md 32 是默认，对话框和表单底部的按钮；sm 26 给面板里的行；xs 20 给跟在一行小字后面的动作，圆角随之降到 6px。 */
	size: {
		md: "h-8 rounded-lg text-label",
		sm: "h-6.5 rounded-lg text-label",
		xs: "h-5 rounded-md text-caption",
	},
	/** 只有图标时是正方形，图标居中；有字时字从左边起。 */
	square: { md: "w-8 justify-center", sm: "w-6.5 justify-center", xs: "w-5 justify-center" },
	pad: { md: "gap-1.5 px-3", sm: "gap-1.5 px-3", xs: "gap-1 px-1.5" },
	variant: {
		/** 一处只有一个，要按的那个：前景色压在底色上，不引入新的颜色也读得出是实心的。 */
		primary: "bg-ink text-shell font-medium hover:opacity-90 disabled:opacity-40",
		/** 描边，平常的按钮，放在 primary 旁边。 */
		ghost: "border border-line text-ink hover:border-ink-faint hover:bg-card-hover active:bg-elevated disabled:opacity-45",
		/** 没有描边，一排动作不想在面板上画出格子时用。 */
		subtle: "text-ink-muted hover:bg-card-hover hover:text-ink active:bg-elevated disabled:opacity-45",
		/** 有底没描边：放在 primary 旁边、指针没过来之前就要读得出是按钮的一排选择。 */
		soft: "bg-card text-ink hover:bg-card-hover active:bg-elevated disabled:opacity-45",
		/** 破坏性操作。只在悬停时上色：一排红按钮没人会读。 */
		danger: "border border-line text-danger hover:border-danger/50 hover:bg-danger/10 active:bg-danger/15 disabled:opacity-45",
	} satisfies Record<ButtonVariant, string>,
	/** 一组选择里选中的那个：悬停态一直保持。只有 ghost 和 subtle 有。 */
	pressed: {
		ghost: "border border-ink-faint bg-card-hover text-ink disabled:opacity-45",
		subtle: "bg-card-hover text-ink disabled:opacity-45",
	} as Partial<Record<ButtonVariant, string>>,
	/** 忙碌：和 disabled 分开，读起来是“在做”，不是“不能按”。宽度不变。 */
	loading: "opacity-60",
};

/** 图标按钮：平时是淡的字色，悬停才有底。按下底色深一档，不缩放。组件见 @plume/ui 的 IconButton。 */
export const iconButton = {
	/** 禁用时不关掉指针事件：`explainDisabled` 要靠悬停提示说明为什么不能按。 */
	base: "relative flex shrink-0 items-center justify-center transition-[color,background-color,opacity] disabled:opacity-40",
	/**
	 * xs 20 是标题行和一行小字的高度，圆角随之降到 6px。composer 跟着主输入框工具栏的控件边长走，
	 * 那个尺寸变了，这一排仍然是一行。
	 */
	size: { xs: "size-5 rounded-md", sm: "size-5.5 rounded-lg", md: "size-6.5 rounded-lg", composer: "plume-composer-control plume-composer-icon rounded-lg" },
	tone: {
		default: "text-ink-faint hover:bg-card-hover hover:text-ink active:bg-elevated",
		danger: "text-ink-faint hover:bg-danger/10 hover:text-danger active:bg-danger/15",
	},
	/** 开着的开关，比如“区分大小写”。 */
	active: "bg-card-hover text-ink active:bg-elevated",
	/** 一排里现在值得按的那个：满色的字，不是实心按钮。 */
	emphasis: "text-ink hover:bg-card-hover active:bg-elevated",
};

export const card = {
	frame: "overflow-hidden rounded-lg border bg-card text-detail",
	head: "flex min-w-0 items-center gap-2 px-3.5 py-2",
	title: "shrink-0 font-medium",
	subtitle: "min-w-0 flex-1 truncate font-mono text-caption text-ink-muted",
	status: "ml-auto shrink-0 text-caption text-ink-faint",
	body: "border-t border-line-soft px-3.5 py-2.5",
	/** 按语气换边框和标题行的底色。 */
	tone: {
		default: { frame: "border-line", head: "" },
		error: { frame: "border-danger/40", head: "bg-danger/10" },
		warning: { frame: "border-warning/40", head: "bg-warning/10" },
	},
};

const PRE = "max-h-72 overflow-auto rounded-lg border border-line-soft bg-code-bg font-mono text-code text-code-fg";

export const code = {
	block: `${PRE} px-2.5 py-2 break-words whitespace-pre-wrap`,
};
