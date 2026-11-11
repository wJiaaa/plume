# 组件和类名组合

<!-- 由 `node scripts/check-plugins.mjs --fix` 从源码生成，不要手改。名单在 packages/client/ui/plugin-api.json。 -->

界面入口能用的 `@plume/ui` 组件和 `@plume/styles` 类名组合，就是这一页列出的这些；`@plume/ui` 的其他导出是产品内部用的，`pnpm check:plugins` 会拦。签名和注释原样摘自源码。

怎么选：文字一律用 `Text`（字号档位自带行高、字距和字重，不在 CSS 里写字号）；按钮、输入框、开关、菜单、对话框用对应组件；工具卡片的外框用 `Card`。组件不够时用下面的类名组合，再不够才写自己的样式（见 [style-i18n.md](style-i18n.md)）。

## 文字

### `Text`

源码：`packages/client/ui/src/primitives/Text.tsx`

```tsx
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
} & React.HTMLAttributes<HTMLElement>)

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
```

## 按钮

### `Button`

源码：`packages/client/ui/src/primitives/Button.tsx`

```tsx
export function Button({
	children,
	icon,
	onClick,
	variant = "ghost",
	size = "md",
	disabled,
	loading,
	label,
	ariaLabel,
	menu,
	expanded,
	pressed,
	className = "",
	type = "button",
	...data
}: DataAttributes & {
	/**
	 * 只有图标的按钮不传。
	 *
	 * 图标旁边再写一个字是把同一件事说两遍，一排这样的按钮会把工具栏变成一句话。图标说得清意思的地方，
	 * `label` 同时作悬停提示和无障碍名——读屏的人什么都没丢，丢的只是眼睛看到的那几个字。
	 */
	children?: ReactNode;
	icon?: ReactNode;
	onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
	variant?: ButtonVariant;
	size?: ButtonSize;
	disabled?: boolean;
	/**
	 * 忙碌。按钮不能按、变淡，宽度不变。
	 *
	 * 每个异步操作各自做这件事时，做法都略有不同——有的把文字换成转圈，整行跟着跳；有的按钮还能按，
	 * 能被按两次。宽度不变是因为：一个看着它的时候在缩的按钮，回头找的时候可能就找不到了。
	 */
	loading?: boolean;
	/** 悬停提示；没有可见文字时也是无障碍名。 */
	label?: string;
	/** 可见文字本身说不清按钮做什么时的无障碍名——`中文` 是一个值，不是一个动作。 */
	ariaLabel?: string;
	/** 会打开一个菜单；值是它现在开没开。普通按钮不传。 */
	menu?: boolean;
	/** 原地展开或收起一段——`aria-expanded`，但不像 `menu` 那样声明弹出。 */
	expanded?: boolean;
	/** 一排选择里选中的那个——筛选、视图。不是一组里的按钮不传。 */
	pressed?: boolean;
	className?: string;
	type?: "button" | "submit";
})

export type DataAttributes = { [key: `data-${string}`]: string | boolean | undefined };

export type ButtonVariant = "primary" | "ghost" | "subtle" | "soft" | "danger";

export type ButtonSize = "md" | "sm" | "xs";
```

### `IconButton`

源码：`packages/client/ui/src/primitives/IconButton.tsx`

```tsx
/**
 * 标签是一个图标的按钮。
 *
 * 各个工具栏各写各的，会长出五种高度、三种圆角，按下的反馈从没有到缩小 10% 都有。缩小是有意去掉的——
 * 一个在接触那一刻从指针底下跳开的控件读起来不稳，在这么小的尺寸上那是一下晃动而不是按下。按下用底色
 * 深一档表示，真的按钮就是这样：它待在原地，只是换了状态。
 *
 * 标签同时是悬停提示和无障碍名，调用方没法只给一个——只有图标的工具栏就是这样变得读屏读不出来的。
 * 类名组合在 `@plume/styles` 的 `iconButton`。
 */
export function IconButton({
	label,
	ariaLabel,
	icon,
	onClick,
	active,
	disabled,
	emphasis,
	badge,
	explainDisabled,
	tone = "default",
	size = "md",
	tipSide = "bottom",
	menu,
	expanded,
	className = "",
	...data
}: DataAttributes & {
	label: string;
	/**
	 * 无障碍名要比悬停提示多说一点时用。
	 *
	 * 一列同样的按钮在读屏里是同一个词念了一遍又一遍；无障碍名带上是哪一行（`归档会话「a」`），
	 * 悬停提示仍然短，因为指针已经在那一行上了。不传时 `label` 两样都是，这是通常的情况。
	 */
	ariaLabel?: string;
	icon: React.ReactNode;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	/** 按住 / 开着，给「区分大小写」这类开关。 */
	active?: boolean;
	disabled?: boolean;
	/**
	 * 一排里现在值得按的那一个。
	 *
	 * 满色的字，对比一排平时淡灰的字，这是界面里已经用来表示「就是这个」的对比。不是实心或彩色按钮：
	 * 长出 primary 按钮的工具栏就不再是工具栏了。
	 */
	emphasis?: boolean;
	/** 角上的计数。零和 null 都画成什么都没有。 */
	badge?: number | null;
	/**
	 * 禁用时也显示悬停提示，因为标签说明的正是为什么禁用。
	 *
	 * 默认关，对大多数工具栏默认是对的：一个因为显而易见的原因变灰的控件，再冒一个泡重复它的名字
	 * 没有意义。原因本身才是重点的地方就不对了——「当前分支没有上游」正是悬停在一个按不动的拉取按钮上
	 * 的人想知道的，没有这个他们只能得到一片沉默，自己去猜。
	 */
	explainDisabled?: boolean;
	tone?: "default" | "danger";
	/**
	 * `xs` 20px，是窗格标题行和一行小字的高度；圆角跟着降到 6px，这个尺寸的按钮都这样。`composer`
	 * 跟着主输入框自己的控件高度走，那个高度变了，它那一排仍然是一行。
	 */
	size?: "xs" | "sm" | "md" | "composer";
	tipSide?: "top" | "bottom";
	/** 会打开一个菜单；值是它现在开没开。和 `Button` 的一样。 */
	menu?: boolean;
	/** 原地展开或收起一段。和 `Button` 的一样。 */
	expanded?: boolean;
	className?: string;
})
```

## 输入

### `Input`

源码：`packages/client/ui/src/inputs/NativeField.tsx`

```tsx
/** 不带样式的原生控件：布局、ref、选区和撤销历史都留在调用方手里。 */
export function Input(props: ComponentPropsWithRef<"input">)
```

### `Textarea`

源码：`packages/client/ui/src/inputs/NativeField.tsx`

```tsx
/** 同 `Input`，多行。要带框、滚动条和渐隐的多行框用 `TextArea`。 */
export function Textarea(props: ComponentPropsWithRef<"textarea">)
```

### `TextArea`

源码：`packages/client/ui/src/inputs/TextArea.tsx`

```tsx
/**
 * 写很多字的地方，一种写法。
 *
 * 各处的多行输入框各写各的类名串，会长出好几种圆角、内衬和底色——而它们要人做的是同一件事。
 * 样子由 `.plume-textarea-shell` / `.plume-textarea` 出（见 `@plume/styles` 的 `ui/controls.css`），
 * 调用方只说高度和位置。
 *
 * 三样东西是一起来的，缺一件那个框就回到从前：
 *
 * - **边界在外壳上**。虚化收的是元素画出的一切，描边和字同在一个元素上，滚到顶时框的上下边会跟
 *   着字一起淡掉，像破了个口子。
 * - **滑块是自己画的**。原生滚动条在全局被关掉了（见 `OverlayScrollbar` 的开头），不补一个，一
 *   篇长草稿滚起来没有任何东西说它有多长。
 * - **两头化开**。硬切的半行字读起来像渲染坏了，见 `useFieldFade`。
 *
 * 主输入框、消息编辑框这类框里还站着别的东西（工具栏、附件条、那排按钮）的不走这里，外壳是各自的。
 * 共享的是同一个 `useFieldFade` 和同一条遮罩。
 */
export function TextArea({
	value,
	onChange,
	shell = "",
	className = "",
	fieldRef,
	resizable = false,
	...rest
}: {
	value: string;
	onChange: (value: string) => void;
	/** 外壳上的额外类。高度、外边距、宽度——和这个框在页面上待在哪儿有关的事，调用方说了算。 */
	shell?: string;
	/** 字那一层的额外类：等宽、字号、`h-[180px]` 这类只跟可写区域有关的。 */
	className?: string;
	fieldRef?: React.RefObject<HTMLTextAreaElement | null>;
	/** 能不能用鼠标拉高。只给写长文的地方，比如一份系统提示词。 */
	resizable?: boolean;
} & Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange" | "className" | "ref">)
```

### `Select`

源码：`packages/client/ui/src/inputs/Select.tsx`

```tsx
export function Select<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
})
```

### `InlineSelect`

源码：`packages/client/ui/src/inputs/Select.tsx`

```tsx
/** 设置行里用的紧凑行内下拉，像「Zed ˅」那样只有字和箭头。 */
export function InlineSelect<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
	quiet?: boolean;
	set?: boolean;
	/** 给面板标题行而不是设置行——见 `Dropdown` 的 `size`。 */
	compact?: boolean;
})
```

### `Toggle`

源码：`packages/client/ui/src/inputs/Toggle.tsx`

```tsx
export function Toggle({
	checked,
	onChange,
	ariaLabel,
	disabled,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	ariaLabel?: string;
	disabled?: boolean;
})
```

### `ComposerToggle`

源码：`packages/client/ui/src/inputs/ComposerToggle.tsx`

```tsx
export function ComposerToggle({
	on,
	onChange,
	icon,
	label,
	tip,
	size = "composer",
	iconOnly = false,
	...data
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	/** 16px 的图标，颜色跟着文字走。 */
	icon: ReactNode;
	/** 开着时图标旁边的字。 */
	label: string;
	/** 悬停提示和无障碍名：说点了会怎样。 */
	tip: string;
	/** `sm` 放在 `Button size="sm"` 旁边：26px；主输入框的控件跟着 `--plume-composer-control`。 */
	size?: "composer" | "sm";
	/**
	 * 开着时也只有图标，开没开只看颜色，名字和点了会怎样都在悬停提示里。给卡片上挨着一颗「开始」的开关：那里开着时带上的字
	 * 读起来像又一颗要按的按钮。主输入框里不用它，那一排的字说的是下一轮在什么模式里。
	 */
	iconOnly?: boolean;
} & { [key: `data-${string}`]: string | undefined })
```

### `WorktreeToggle`

源码：`packages/client/ui/src/inputs/WorktreeToggle.tsx`

```tsx
export function WorktreeToggle({
	on,
	onChange,
	size = "composer",
	iconOnly = false,
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	/** `sm` 放在 `Button size="sm"` 旁边，比如建议卡片上：26px，主输入框的控件是 28px。 */
	size?: "composer" | "sm";
	/** 开着时也只有图标，见 `ComposerToggle` 的 `iconOnly`。 */
	iconOnly?: boolean;
})
```

### `Segmented`

源码：`packages/client/ui/src/inputs/Segmented.tsx`

```tsx
/**
 * 一排互斥的选项，选中的那个下面垫着一块会滑过去的底。
 *
 * 一块共用的底从这里滑到那里，滑动本身就说明这几个选项是同一排里的几个位置，不是几个开关。
 * 位置是量出来的，不按等分算：中英混排的标签不一样宽。量在 layout effect 里，赶在这一帧画出来之前——晚一帧的话，
 * 第一次渲染就能看见那块底从左上角飞过来。
 *
 * 圆角外框 8px、滑块和每一格 6px：内衬 2px，两道圆弧才同心。
 */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (value: T) => void;
	/**
	 * 给了 `icon` 这一格就画成图标，`label` 变成它的提示和无障碍名字。
	 * `label` 无论如何都要给：只有图标、没有名字的控件，读屏读不出，别人也猜不着。
	 */
	options: { value: T; label: string; icon?: ReactNode }[];
})
```

### `TabStrip`

源码：`packages/client/ui/src/primitives/TabStrip.tsx`

```tsx
export function TabStrip<T extends string>({
	items,
	value,
	onChange,
	label,
	className = "",
}: {
	items: readonly TabStripItem<T>[];
	value: T;
	onChange: (value: T) => void;
	/** 标签列表的无障碍名。 */
	label: string;
	className?: string;
})

export interface TabStripItem<T extends string> {
	id: T;
	label: string;
	/** 跟在文字后面，比文字淡。不传或 `undefined` 什么都不画。 */
	count?: number;
	icon?: ReactNode;
}
```

### `SearchField`

源码：`packages/client/ui/src/inputs/SearchField.tsx`

```tsx
/**
 * 搜索框。
 *
 * 侧栏的会话搜索、审阅面板的文件筛选、文件树的筛选共用这一个。各写各的话，每个都有自己的高度、
 * 自己的描边、自己对放大镜在框里还是框旁的看法——一个只有一个答案的问题，得到三个答案。
 *
 * 两种尺寸，因为两种场合确实不同：独占一行的框（`comfortable`），和塞进面板标题行、周围的行都很矮
 * 的框（`compact`）。
 */
export function SearchField({
	value,
	onChange,
	placeholder,
	size = "compact",
	autoFocus,
	onEscape,
	onEnter,
	className = "",
}: {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	size?: "compact" | "comfortable";
	autoFocus?: boolean;
	/** Esc 先清空，已经空了才关闭，筛选框要的就是这样。 */
	onEscape?: () => void;
	/** 输入法组字结束后的 Enter——上屏候选词的那个 Enter 不算。 */
	onEnter?: () => void;
	className?: string;
})
```

### `NumberField`

源码：`packages/client/ui/src/inputs/pickers.tsx`

```tsx
/**
 * 带自己画的步进按钮的数字框。
 *
 * 用 `type="text"` 加数字键盘提示，不用 `type="number"`：后者的上下箭头每个浏览器画得都不一样，而且它认为不合法的
 * 输入一律报成空字符串，`1e5`、`--3` 看着像收下了，到手却是「什么也没敲」。
 *
 * 存的值不是每敲一下就改：聚焦时框里留一份草稿，下限是 11 时「1」才能留到变成「16」。永远到不了范围内的字符进不来，
 * 加减按钮停在同样的边界上。拒掉的按键不提示。
 */
export function NumberField({
	value,
	onChange,
	min = Number.NEGATIVE_INFINITY,
	max = Number.POSITIVE_INFINITY,
	step = 1,
	width = 76,
	label,
	name,
}: {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	width?: number;
	label: string;
	name?: string;
}): JSX.Element
```

### `Slider`

源码：`packages/client/ui/src/inputs/Slider.tsx`

```tsx
/**
 * 轨道和把手自己画的滑块。原生 range 叠在最上面、完全透明，拖动、点轨道跳过去、方向键都是浏览器自己的，
 * 画出来的部分只跟着 value 走。
 */
export function Slider({
	value,
	onChange,
	min = 0,
	max = 100,
	step = 1,
	label,
	width = 180,
}: {
	value: number;
	onChange: (value: number) => void;
	min?: number;
	max?: number;
	step?: number;
	label: string;
	width?: number | string;
})
```

### `ColorField`

源码：`packages/client/ui/src/inputs/ColorField.tsx`

```tsx
/**
 * 那枚色块。里面的输入框是色块的一部分（底色就是它编辑的颜色），不是一个单独的输入框，所以不用 Input 的外观。
 */
export function ColorField({
	value,
	onChange,
	label,
	readOnly = false,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	readOnly?: boolean;
})
```

### `TimeField`

源码：`packages/client/ui/src/inputs/pickers.tsx`

```tsx
/**
 * 时间，用两个列表挑，不用浏览器的时钟。
 *
 * `<input type="time">` 的分段、分隔符和弹出的面板都归平台：macOS 上是步进器，Windows 上是下拉。它还按系统区域解析和
 * 显示，同一个任务在一台机器上读作 `09:00`，在另一台上读作 `9:00 AM`，存的却是同一串字。
 *
 * 两个列表把这些都去掉，顺便去掉了打字：要的只是某个小时的某一分，00:00–23:59 之外没有别的值要表达。
 */
export function TimeField({
	value,
	onChange,
	label,
}: {
	/** `HH:mm`，24 小时制。 */
	value: string;
	onChange: (value: string) => void;
	label: string;
}): JSX.Element
```

### `ShortcutRecorder`

源码：`packages/client/ui/src/inputs/ShortcutRecorder.tsx`

```tsx
/**
 * 录一组快捷键：点一下进入录制，按下的那组键就是值（Electron accelerator 的写法）。Esc 放弃，⌫ / Delete 清空。
 */
export function ShortcutRecorder({ value, onChange, placeholder }: { value?: string; onChange: (shortcut: string) => void; placeholder?: string })
```

### `useFieldFade`

源码：`packages/client/ui/src/inputs/useFieldFade.ts`

```tsx
export function useFieldFade(field: React.RefObject<HTMLElement | null>, host: React.RefObject<HTMLElement | null>): void
```

### `ChoiceMark`

源码：`packages/client/ui/src/primitives/ChoiceMark.tsx`

```tsx
/**
 * 自己画的选中标记。
 *
 * 原生复选框带着宿主系统的样子：macOS 上是 Aqua，Windows 上是 Fluent，哪个都和周围 ink / accent 的
 * 卡片对不上。一个标记，两种形状。
 */
export function ChoiceMark({
	checked,
	kind,
	indeterminate = false,
	className = "",
}: {
	checked: boolean;
	kind: "checkbox" | "radio";
	indeterminate?: boolean;
	className?: string;
})
```

## 弹层、菜单、对话框

### `Popover`

源码：`packages/client/ui/src/overlay/Popover.tsx`

```tsx
export function Popover({
	anchor,
	onClose,
	children,
	placement = "top",
	align = "end",
	width,
	header,
	footer,
	aside,
	maxHeight,
	role = "menu",
	label,
	className = "",
	bodyClassName = "",
	surface: kind = "menu",
	onMouseEnter,
	onMouseLeave,
}: PopoverProps)

export interface PopoverProps {
	/** 弹层挂在哪个元素上，右键菜单则是一个点。 */
	anchor: Anchor;
	onClose: () => void;
	children: React.ReactNode;
	/**
	 * 优先放在哪一侧。地方不够时自动翻转。
	 *
	 * `right` 把菜单放在触发元素旁边而不是下面，这对列表里的一行很重要：往下掉的菜单会盖住你正要拿来
	 * 对比的那几行。
	 */
	placement?: "top" | "bottom" | "right";
	/** 弹层的哪条边和锚点对齐。 */
	align?: "start" | "end" | "center";
	width?: PopoverWidth;
	/**
	 * 钉在滚动正文上面——搜索框、标题。
	 *
	 * 不放进 `children`，因为它不能滚动：一用就离开屏幕的筛选框，要改它还得滚回去。
	 */
	header?: React.ReactNode;
	/** 钉在它下面，给不管列表多长都要够得着的动作。 */
	footer?: React.ReactNode;
	/**
	 * 钉在它左边——比如一列分类。
	 *
	 * 是槽位，理由和另外两个一样：跟着被筛选的列表一起滚走的筛选，要改还得滚回去。它也不能作为 sticky
	 * 的一列放在 `children` 里，因为滚动区的内容盒会裁掉横向溢出，而祖先上的任何 `overflow` 都会让
	 * `sticky` 粘在那个祖先上而不是视口上。
	 */
	aside?: React.ReactNode;
	/** 给否则会长满窗口的面一个上限——见 `MENU_MAX_HEIGHT`。 */
	maxHeight?: number;
	/**
	 * 这个面是什么，给读窗口而不是看窗口的东西。
	 *
	 * 写死成 `menu` 对大多数是对的，对不是菜单的就错了：重命名表单、一段读数、一个滑块。被播报成菜单项
	 * 的输入框，比什么都不播报更糟。
	 */
	role?: "menu" | "listbox" | "dialog" | "group";
	/** 触发元素没说清时，给这个面一个名字。 */
	label?: string;
	className?: string;
	/** 加在滚动正文上，给自己给内容加内衬的面。 */
	bodyClassName?: string;
	/**
	 * 一列行，还是一样东西。
	 *
	 * `menu` 是每个菜单要的内衬：圆角需要地方，行不能跑到滚动条底下，渐隐的边说明列表在那之外还有。
	 * 这三样对只装一块自己画底色的面板的面都是错的——比如一段 diff，它的代码底色会在离卡片右边 25px、
	 * 离顶 6px 处就停了，缝里露出浮层的底。面板读起来像嵌在一张它没填满的卡片里。
	 *
	 * `panel` 把整个正文交给内容，让叠加的滑块浮在上面，这正是叠加滚动条的用途。
	 */
	surface?: "menu" | "panel";
	/**
	 * 把悬停交给整个面，给悬停打开的弹层用。
	 *
	 * 调用方如果挂在自己传的 `header` 和 `children` 上，描边、滚动区自己的外边距、滚动条那一条和滑块都在
	 * 处理范围之外：指针从这些地方进入弹层，在调用方看来仍然在外面——待执行的关闭就跑了。抓住悬停预览的
	 * 滚动条会把它关掉。
	 */
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
}
```

### `ContextMenu`

源码：`packages/client/ui/src/overlay/ContextMenu.tsx`

```tsx
/**
 * 面本身。
 *
 * 每一行都会关掉它，在这里处理而不是每一项各自记得：右键菜单里没有不是动作的行，点完还开着的那个会是
 * 应用里唯一这样的菜单。监听在冒泡阶段，所以行自己的处理已经先运行了。
 */
export function ContextMenu({
	anchor,
	onClose,
	width = "default",
	children,
}: {
	anchor: { x: number; y: number } | null;
	onClose: () => void;
	width?: PopoverWidth;
	children: React.ReactNode;
})
```

### `MenuItem`

源码：`packages/client/ui/src/overlay/Menu.tsx`

```tsx
/**
 * 菜单里的一行。
 *
 * 每个菜单各自长一份的话——高度不同、圆角不同、有的干脆没有圆角——同一个手势在不同菜单里看着不一样。
 * 视觉状态放在 `.plume-item` 里，需要别的形状的行（比如两行的选项）也能用上它们。
 */
export function MenuItem({
	icon,
	children,
	detail,
	hint,
	trailing,
	checked,
	selected,
	danger,
	disabled,
	title,
	className = "",
	onClick,
}: {
	icon?: React.ReactNode;
	children: React.ReactNode;
	/**
	 * 解释这个选项的第二行。
	 *
	 * 在这里处理，而不是每个菜单自己排两行的行：自己排的话会长出自己的高度、内边距和悬停效果，同一个
	 * 手势在不同菜单里看着不一样。
	 */
	detail?: React.ReactNode;
	/** 右对齐的注记：数量、快捷键数字、上下文大小。 */
	hint?: React.ReactNode;
	/** 右对齐的元素，放勾或箭头。 */
	trailing?: React.ReactNode;
	/**
	 * 让这一行成为开关设置：行尾一个小开关，`menuitemcheckbox` 语义。
	 *
	 * 文字仍是设置的名字——「自动更新」——状态由开关说。两样都用字写的话，「自动更新：开（点击关闭）」
	 * 是一句要解析的话，而本该扫一眼就够，还会跑出菜单的右边。
	 */
	checked?: boolean;
	selected?: boolean;
	danger?: boolean;
	disabled?: boolean;
	title?: string;
	/**
	 * 加在行本身上的类，给用别的方式标记行的菜单。
	 *
	 * 比如右边那一列已经被占了、所以选中行用填充而不是打勾的菜单。选了这种方式的行得能说出来——在这里
	 * 说，高度、圆角和按下状态仍是共用的，而这正是行只住在一个地方的意义。
	 */
	className?: string;
	onClick?: () => void;
})
```

### `MenuSeparator`

源码：`packages/client/ui/src/overlay/Menu.tsx`

```tsx
/** 分开菜单里的几组行。 */
export function MenuSeparator()
```

### `MenuLabel`

源码：`packages/client/ui/src/overlay/Menu.tsx`

```tsx
/** 一组行上面的小标题。 */
export function MenuLabel({ children }: { children: React.ReactNode })
```

### `Dialog`

源码：`packages/client/ui/src/overlay/Dialog.tsx`

```tsx
/**
 * 里面放着 `DialogFrame` 的 `Overlay`。
 *
 * `actions` 和 `children` 可以是 `dismiss` 的函数，关对话框的按钮应该用它：`dismiss()` 播完退场再运行
 * `onClose`，`dismiss(after)` 改为运行 `after`。按钮直接调用 `onClose` 会在那一帧卸掉对话框——那样
 * 只有 Escape 和点遮罩是怎么来的就怎么走。
 */
export function Dialog({
	onClose,
	width = 480,
	label,
	returnFocus,
	actions,
	children,
	...frame
}: {
	onClose: () => void;
	width?: number;
	label?: string;
	returnFocus?: HTMLElement;
	actions: ReactNode | ((dismiss: Dismiss) => ReactNode);
	children?: ReactNode | ((dismiss: Dismiss) => ReactNode);
} & Omit<Parameters<typeof DialogFrame>[0], "actions" | "children">)
```

### `DialogAction`

源码：`packages/client/ui/src/overlay/Dialog.tsx`

```tsx
/**
 * 对话框底下的那一颗按钮。上面写着它会做的那件事。
 *
 * **写字，不画图标。** 这些按钮曾经有好几处只放一个 ✕ 和一个 ✓，名字挂在 tooltip 上。工具栏
 * 里的图标按钮可以这么省——周围一排东西替它说明它属于哪一类；对话框底下这两颗没有这个周围，
 * 它们是这次操作的结论本身，一个要说清按下去会发生什么，另一个要说清不按会怎样。一个勾在
 * 「删除会话」「卸载插件」「导入 33 个模型」上长得一模一样，而读出区别的唯一办法是把鼠标停
 * 上去等一个 tooltip——这正是一个「停下一切来问」的界面最不该要求的动作。
 *
 * `label` 留着，但只当 tooltip 用：可见的字已经是它的名字了。
 */
export function DialogAction({
	children,
	onClick,
	tone = "secondary",
	disabled,
	autoFocus,
	label,
	className = "",
	...rest
}: {
	children: ReactNode;
	onClick?: () => void;
	tone?: "secondary" | "primary" | "danger";
	disabled?: boolean;
	autoFocus?: boolean;
	/** 只当悬停提示。可见的字已经是按钮的名字。 */
	label?: string;
	className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick" | "type">)
```

### `Confirm`

源码：`packages/client/ui/src/overlay/Confirm.tsx`

```tsx
/**
 * 放在应用模态面上的问题：居中、压着遮罩、Escape 或点遮罩关掉。
 *
 * 这三样都由 `Overlay` 提供，而且和应用里其它对话框拿到的方式一样——这正是通过它来问、而不是在每个
 * 调用处各拼一个的意义。
 */
export function Confirm({ onCancel, ...options }: ConfirmOptions & { onCancel: () => void })

export interface ConfirmOptions {
	/** 问题，说出是哪个东西。「卸载 Chrome？」——而不是「确定吗？」。 */
	title: string;
	/** 代价是什么，一行。标题已经说全了就省掉。 */
	detail?: React.ReactNode;
	/** 动词，写在做这件事的按钮上。 */
	confirmLabel: string;
	/** 取消按钮上的字，默认「取消」。 */
	cancelLabel?: string;
	/**
	 * `danger` 是默认，因为这个东西本来是给删除用的。
	 *
	 * `normal` 留给另一类问题：不是「这个删了拿不回来」，而是「以后要不要自动做这件事」。
	 * 两种都该停下一切来问，但只有前一种该是红的——把每个问题都画成危险，等于没画过危险。
	 */
	tone?: "danger" | "normal";
	onConfirm: () => void;
	/**
	 * 取消也要做点什么的时候。
	 *
	 * 绝大多数确认框的取消就是「什么都别发生」，所以这是可选的。但有一种问题不是这样：
	 * 「以后要不要自动做这件事」——那里的取消是一个回答（不要），把它当成没问过，
	 * 意思就是下次还问。
	 */
	onCancel?: () => void;
	/**
	 * 同一个动词的另一种做法，比如「删除此会话」旁边的「删除 3 个会话」。
	 *
	 * 画成次要按钮，放在主按钮左边；有它的时候「取消」挪到最左，三颗按钮不挤成一排。
	 */
	alternate?: { label: string; onConfirm: () => void };
	/** 说明和按钮之间的那一块，比如「不再询问」。大多数问题用不着。 */
	children?: React.ReactNode;
}
```

### `useConfirmer`

源码：`packages/client/ui/src/overlay/Confirm.tsx`

```tsx
/**
 * 给满是删除按钮的页面用的一个确认。
 *
 * 每颗按钮交出自己的问题和自己的后果；面、两颗按钮的措辞、取消是安全的那个，这些在这里定。否则一个
 * 有六行可删除内容的页面要带着同一份状态的六个副本。
 */
export function useConfirmer()
```

### `useConfirmGate`

源码：`packages/client/ui/src/overlay/Confirm.tsx`

```tsx
/**
 * 同一个问题，可以 await。
 *
 * 给在循环里问的调用方——粘贴五个文件，其中两个重名——回答得先回来，下一步才能定。写成 promise，
 * 读起来就是普通的顺序代码，而不是每个分支一个回调。
 */
export function useConfirmGate()
```

### `Tooltip`

源码：`packages/client/ui/src/overlay/Tooltip.tsx`

```tsx
/**
 * 应用的悬停提示，写成 JSX 包装，比属性读起来顺。
 *
 * 它只给子元素打标记——气泡本身由 `tooltip.ts` 里那一个文档级监听器画。所以两种写法表现完全一样，
 * 这很重要，因为第三方库自己建的按钮只能靠属性够到。
 *
 * 取代浏览器的 `title`：那个改不了样式，要等一秒半左右，不跟应用的字体和主题，在 macOS 上画成一个
 * 系统面板，看着像属于另一个程序。
 */
export function Tooltip({ label, children, side = "bottom" }: { label: string; children: React.ReactElement; side?: "top" | "bottom" })
```

### `usePopover`

源码：`packages/client/ui/src/overlay/Popover.tsx`

```tsx
/** 记下锚点元素和打开状态，每个弹层触发器都要的这一对。 */
export function usePopover()
```

### `MenuBody`

源码：`packages/client/ui/src/overlay/Menu.tsx`

```tsx
/**
 * 每个菜单的内容所在的盒子。
 *
 * 行四周的留白在滚动区上（`--plume-menu-inset`），不在这里。这里再加一层内衬会叠在那圈外边距上，
 * 上下就成了左右的两倍。
 */
export function MenuBody({
	children,
	insetIcons = false,
	className = "",
}: {
	children: React.ReactNode;
	/** 每行都留出图标列，给只有部分行有图标的菜单用。 */
	insetIcons?: boolean;
	className?: string;
})
```

### `MenuSearch`

源码：`packages/client/ui/src/overlay/Menu.tsx`

```tsx
/**
 * 列出超过一屏的菜单顶上的筛选框。
 *
 * 每个菜单各写一份的话，同样的高度、同样的放大镜、同样的占位文案，每多一份就多一次走样的机会。
 * 给 `Popover` 的 `header` 槽位用，列表滚动时它不动；它下面那条线属于那个槽位，不在这里画。
 *
 * Escape 先清空再关闭，和 `SearchField` 一样：第一次按撤销输入，只有没东西可撤销时按才关掉菜单。
 */
export function MenuSearch({
	value,
	onChange,
	placeholder,
	autoFocus = true,
	onKeyDown,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	/** 给焦点留在输入框里、由它来移动高亮（方向键和 Enter）的菜单用。 */
	onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
})
```

### `MENU_MAX_HEIGHT`

源码：`packages/client/ui/src/overlay/Popover.tsx`

```tsx
/**
 * 列东西的菜单最高能长到多高。
 *
 * 交给窗口决定的话，高屏幕上的一个列表菜单会从输入框一直铺到屏幕顶——技术上没错，但四十行的列表没人
 * 读到底。会滚动的菜单出于同一个理由各挑一个上限（280、300、320），这里把这个理由说一次。
 */
export const MENU_MAX_HEIGHT = 340;
```

### `Overlay`

源码：`packages/client/ui/src/overlay/Overlay.tsx`

```tsx
/** Escape、点遮罩、取消和完成共用一套生命周期，嵌套的对话框也一样。 */
export function Overlay({
	children,
	onClose,
	align = "center",
	width = 460,
	label,
	returnFocus,
}: {
	children: React.ReactNode | ((dismiss: Dismiss) => React.ReactNode);
	onClose: () => void;
	align?: "center" | "bottom";
	width?: number;
	label?: string;
	returnFocus?: HTMLElement;
})

export type Dismiss = (after?: () => void) => void;
```

## 卡片和代码

### `Card`

源码：`packages/client/ui/src/index.tsx`

```tsx
export function Card({ title, subtitle, status, tone = "default", children }: CardProps)

export interface CardProps {
	title: ReactNode;
	/** 标题右边的简短说明，单行，超出省略。 */
	subtitle?: ReactNode;
	/** 右上角的状态文字。 */
	status?: ReactNode;
	tone?: "default" | "error" | "warning";
	children?: ReactNode;
}
```

### `CodeBlock`

源码：`packages/client/ui/src/index.tsx`

```tsx
export function CodeBlock({ children }: { children: string })
```

### `DiffView`

源码：`packages/client/ui/src/index.tsx`

```tsx
export function DiffView({ before, after }: { before: string; after: string })
```

## 审批卡

### `ApprovalFrame`

源码：`packages/client/ui/src/layout/ApprovalFrame.tsx`

```tsx
export function ApprovalFrame({
	requestId,
	icon,
	title,
	kind,
	expiresAt,
	queued = 0,
	children,
}: {
	/** 这次请求的 id（`toolCallId`）：换了一张卡，收起状态不带过去。 */
	requestId: string;
	/** 标题前 15px 的图标：权限请求是警告，提问是气泡。 */
	icon: ReactNode;
	title: ReactNode;
	/** 类型小标签（「执行命令」）；提问这类不是权限的不写。 */
	kind?: string;
	/** `ApprovalRequest.expiresAt`，有就画倒计时。 */
	expiresAt?: number | undefined;
	/** 排在这张后面还在等的张数，大于 0 时写 +N。 */
	queued?: number;
	/** 正文和按钮，收起时一起收。 */
	children: ReactNode;
})
```

### `ApprovalExpiry`

源码：`packages/client/ui/src/layout/ApprovalFrame.tsx`

```tsx
/**
 * 这张卡还剩多久失效，每秒走一格（「4:59 后失效」）。到期没人答，本体按拒绝收场：不说出来的截止比没有截止更糟，
 * 人回来时这一轮已经被一个没见过的「不」结束了。
 *
 * 单独一个组件，秒针走动不重画旁边正在打字的表单。走到零就不说了：正常情况下卡片这一刻已经收走，留下的只可能是
 * 一份过时的快照，「0:00 后失效」不该出现。
 */
export function ApprovalExpiry({ at }: { at: number })
```

## 设置分区

### `SettingsSectionTitle`

源码：`packages/client/ui/src/layout/Settings.tsx`

```tsx
/** 一组卡片上面的分组标题。 */
export function SettingsSectionTitle({ children }: { children: React.ReactNode })
```

### `SettingsCard`

源码：`packages/client/ui/src/layout/Settings.tsx`

```tsx
/**
 * 其余属性原样透传，卡片可以带一个 `data-` 标记给测试量它。
 *
 * 卡片用 `float` 那张纸：设置卡片和弹出菜单是同一个颜色，两个主题下都比页面亮一档的实底。边框随之用 `line-float`，
 * 那是给「画在自己那张纸上」的线准备的；卡片里面的线和控件怎么跟着换，见 `controls.css` 的 `.plume-settings-card`。
 */
export function SettingsCard({ children, className = "", ...rest }: React.ComponentProps<"div">)
```

### `SettingsRow`

源码：`packages/client/ui/src/layout/Settings.tsx`

```tsx
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
})
```

### `SettingsNotice`

源码：`packages/client/ui/src/layout/Settings.tsx`

```tsx
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
}: React.ComponentProps<"div"> & { tone: keyof typeof NOTICE_TONES; icon?: LucideIcon })

const NOTICE_TONES = {
	danger: "border-danger/30 bg-danger/10 text-danger",
	accent: "border-accent/35 bg-accent/6 text-ink-muted",
	muted: "border-line",
} as const;
```

## 面板

### `PanelEmpty`

源码：`packages/client/ui/src/layout/PanelEmpty.tsx`

```tsx
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
})
```

### `RetainedViews`

源码：`packages/client/ui/src/layout/RetainedViews.tsx`

```tsx
/** 留住少数几个看过的页面；藏起来的页面暂停 effect，保留局部状态。 */
export function RetainedViews<T extends string>({
	active,
	render,
	limit = 3,
	pageClassName = "plume-page-enter",
	slide,
}: {
	active: T;
	render: (key: T) => React.ReactNode;
	limit?: number;
	/** 到达时的类。不同的页面可以换一种更长的淡入加升起。 */
	pageClassName?: string;
	/**
	 * 标签，按标签条上的顺序：每次切换，新页面从它所在的那一侧滑进来并淡入，而不是一帧之内换掉。
	 *
	 * 用 Web Animations API 在布局 effect 里播，不用类。用类的话——见下面 `seen` 的注释——从 `display: none`
	 * 回来的页面会先在终点画一帧，动画才接上。布局 effect 在页面显示之后、任何东西画出来之前跑，所以谁看到的
	 * 第一帧都已经是滑入的第一帧。回到一个页面也播：标签条是来回切的地方，只在第一次有动画的切换，第二次读起来
	 * 就像坏了。
	 */
	slide?: readonly T[];
})
```

### `useNarrow`

源码：`packages/client/ui/src/hooks/useNarrow.ts`

```tsx
/**
 * 一个元素是不是窄到放不下两栏，按元素自己量。
 *
 * 面板里的内容没法问窗口自己有多宽——同一个组件既跑在 368px 的面板里，也跑在整列宽的正文里。
 * 这里看的是它实际拿到的那个盒子。
 *
 * 第一次测量在节点一到就做，而不是留给 observer 的首次回调。那次回调在绘制之后才到，一个从 `false`
 * 起步的组件会先画一帧错的布局——更糟的是，挂在这次翻转上的东西（比如列表/详情的重置）会在用户已经
 * 动手之后晚一拍才触发，把刚做的操作撤掉。
 *
 * 用回调 ref，不用 ref 对象。这不是风格问题：`useRef` + `useLayoutEffect` 只在 effect 第一次运行时
 * 挂 observer，一个先渲染了*别的*东西的组件——比如项目加载时的空状态——要么根本没挂上，要么挂到一个
 * 随后被换掉的节点上。两种情况下 observer 都在看一个不存在的东西，标记停在碰巧的那个值上，一个开到
 * 全屏的面板在一千像素宽时还在画堆叠布局。React 每次节点变化都会调用回调 ref，而节点变化正是要紧的那件事。
 */
export function useNarrow(threshold: number): [boolean, (node: HTMLDivElement | null) => void]
```

### `useLiveRefresh`

源码：`packages/client/ui/src/hooks/useLiveRefresh.ts`

```tsx
export function useLiveRefresh(refresh: () => void | Promise<void>, running: boolean, ms = LIVE_POLL_MS): void
```

## 页面

### `PageTopRow`

源码：`packages/client/ui/src/layout/PageTopRow.tsx`

```tsx
/**
 * 自己画顶行的页面（`ui.page` 给了 `topRow: true`）每一栏最上面那一行：坐在窗口顶行的高度上，和侧栏顶上那一行齐平。
 *
 * 整行拖得动窗口、双击能缩放；行里能点的控件（按钮、链接、输入框）自动挖成不拖动的，不用一个个标。不给整行
 * no-drag：那样这一栏宽的一段就既拖不动窗口、也双击不了。Windows、Linux 上窗口顶上另有一条拖窗口的带子，宿主在根元素上
 * 标 `data-plume-window-header`，这一行跟着改成不拖动（`app-region` 不认 `var()`，只能按选择器切）：在卡片里拖窗口会带上系统标题栏的行为（右键系统菜单、拖到屏幕边贴边）。
 *
 * `start` 是贴着页面左边的那一栏：侧栏收起时红绿灯和前进、后退浮在这里，左边让出它们的宽度（宿主经
 * `--plume-top-row-inset` 给，侧栏开着时是 0）。两栏页面的右栏在窄窗口里换成整页时，也给 `start`。
 *
 * 高度、内边距之外的排法（间距、两端对齐）由 `className` 补；行里不折行，放不下的东西自己截断。
 */
export function PageTopRow({
	start = false,
	className = "",
	children,
	...rest
}: { start?: boolean; className?: string; children?: ReactNode; ref?: Ref<HTMLElement> } & HTMLAttributes<HTMLElement>)
```

## 加载和占位

### `ActionSpinner`

源码：`packages/client/ui/src/motion/loaders.tsx`

```tsx
/**
 * 一段亮弧沿着一圈淡轨道跑。
 *
 * 轨道是这个记号的重点，不是装饰：亮弧单独转的话，图形的轮廓跟着弧一起走，在按钮那个方寸
 * 之间会读成「有东西在里面甩」。垫一圈淡的，形状就恒定是一个完整的圆，动的只有亮处。
 *
 * 轨道浓度走 `--plume-track`，默认 0.18。实心底的按钮（`bg-ink`、`bg-accent`）上 `currentColor`
 * 是底色的反色，0.18 基本看不见，那几处传 `onFill`——见 `ui/motion.css` 里那一档的注释。
 */
export function ActionSpinner({
	size = 14,
	className = "",
	onFill = false,
}: {
	size?: number;
	className?: string;
	/** 画在实心底的按钮上（`bg-ink` / `bg-accent`），轨道要更浓才看得见。 */
	onFill?: boolean;
})
```

### `BreatheLoader`

源码：`packages/client/ui/src/motion/loaders.tsx`

```tsx
/**
 * 一圈波纹离开静止的中心，颜色一路走过调色板。
 *
 * 给侧栏的会话行（替一个会话报状态的地方也用它，同一个会话在两处是同一个记号）。那一列可能同时有好几行在跑，而你还要用它读标题——所以这里连「亮处在走」都不
 * 要：什么都不旋转、什么都不位移，余光里它只是缓缓涨落的一团。换成上面那两个的话，一列里并排
 * 三四个各自明灭，读标题时总有东西在旁边闪。
 *
 * 颜色走完 accent → violet 的那 2.4 秒，是它说「跑了多久」的方式：扫一眼知道它活着，
 * 多看一会儿知道它**还**活着，而没有任何东西变快或变响。
 */
export function BreatheLoader({ size = 14, className = "" }: { size?: number; className?: string })
```

### `SkeletonList`

源码：`packages/client/ui/src/primitives/Skeleton.tsx`

```tsx
/** 一摞设置行，和它们代替的那个列表一致。 */
export function SkeletonList({ count = 5, label = translate("common.reading") }: { count?: number; label?: string })
```

### `SkeletonBar`

源码：`packages/client/ui/src/primitives/Skeleton.tsx`

```tsx
/** 一块暗色的块。`width` 是任意 CSS 长度，一排这样的块看起来能像字而不是像条。 */
export function SkeletonBar({ width, height = 10, className = "" }: { width: string; height?: number; className?: string })
```

### `useSlowLoad`

源码：`packages/client/ui/src/primitives/Skeleton.tsx`

```tsx
/**
 * 一次加载是否已经久到值得画占位。
 *
 * 只出现两帧的骨架是一次闪烁，闪烁读起来是故障而不是进度——缓存热的时候一个列表 59ms 就填满了，
 * 其中占位只待了 32ms。阈值以下什么都不显示，这是对一次没人察觉的等待最诚实的描绘。
 */
export function useSlowLoad(loading: boolean, delay = 220): boolean
```

## 列表的行

### `HoverRow`

源码：`packages/client/ui/src/row/HoverRow.tsx`

```tsx
export function HoverRow({
	controls,
	className = "",
	style,
	children,
	...rest
}: ComponentPropsWithoutRef<"div"> & {
	controls: string;
})
```

### `HoverRowMark`

源码：`packages/client/ui/src/row/HoverRow.tsx`

```tsx
/** 行首的图标列：每一行 git 都是同一个 12px 的框，工作树不额外缩进。 */
export function HoverRowMark({ className = "", children }: { className?: string; children: ReactNode })
```

### `HoverRowReveal`

源码：`packages/client/ui/src/row/HoverRow.tsx`

```tsx
/** 按内容收缩的浮层。绝不做成定宽的一列：那样会把空着的框也画出来。 */
export function HoverRowReveal({ className = "", children }: { className?: string; children: ReactNode })
```

### `hoverSlot`

源码：`packages/client/ui/src/row/HoverRow.tsx`

```tsx
/**
 * 控件条量好之前先写进 `--plume-row-controls` 的兜底值。
 *
 * 每个点击区约 21px（`p-1` 加 12.5 的图标）。左边 6px 对应右边的 `pr-1.5`，第一个图标的内距和
 * 最后一个一样。两个按钮的槽给 58px 时比置顶图标多出 17px——那就是多让出去的一段。
 */
export function hoverSlot(actions: 1 | 2 | 3): string
```

### `Caret`

源码：`packages/client/ui/src/primitives/Caret.tsx`

```tsx
export function Caret({
	open,
	/** 收起时箭头朝哪儿：`down` 展开到朝上（下拉），`right` 展开到朝下（树、折叠块）。 */
	from = "down",
	size = 12,
	strokeWidth = 2,
	className = "",
	/** 代码预览那种自带配色的表面上，颜色是算出来的而不是 token。 */
	style,
}: {
	open: boolean;
	from?: "down" | "right";
	size?: number;
	strokeWidth?: number;
	className?: string;
	style?: React.CSSProperties;
})
```

### `MarkNumber`

源码：`packages/client/ui/src/primitives/MarkNumber.tsx`

```tsx
/**
 * 一枚圆形序号：把两处说的同一件东西对上号。
 *
 * 正文里划线的那段字末尾挂一枚，审批卡上那条评论前面挂同一个数——人看到卡上的「2」，回到正文里
 * 找的就是那枚「2」，不用再读一遍引文去认。实心强调色、白字、等宽数字：两位数也不变形，深浅两套底色上
 * 都看得清。
 */
export function MarkNumber({ n, className = "", ...rest }: { n: number; className?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "children">)
```

## 过程行

### `FlowRow`

源码：`packages/client/ui/src/row/FlowRow.tsx`

```tsx
export function FlowRow({
	icon,
	title,
	summary,
	trailing,
	trailFrom,
	running,
	open,
	onToggle,
	label,
	danger = false,
	...rest
}: {
	/** 前置图标，常驻。它说的是这一行是什么，不参与展开、收起。 */
	icon: ReactNode;
	/** 这一行是什么（「自动压缩」）。不参与化开：装不下时先让出地方的永远该是摘要。 */
	title?: ReactNode;
	/** 这一行做了什么。长了两头化开、鼠标放上去自己读出来；运行中它是唯一带动效的东西。 */
	summary?: ReactNode;
	/** 靠右的附注，比如改动行数。 */
	trailing?: ReactNode;
	/** 挂上时附注从这个宽度缓过来，见 `FlowTrail`。 */
	trailFrom?: number | undefined;
	running?: boolean;
	/** 省略即为不可展开：不可展开的行没有箭头，也没有指针手势。 */
	open?: boolean | undefined;
	onToggle?: (() => void) | undefined;
	label?: string;
	/** 整行红字：这一行说的是一次失败（压缩失败）。 */
	danger?: boolean;
} & Record<`data-${string}`, string | undefined>)
```

## 文件图标

### `lookFor`

源码：`packages/client/ui/src/fileIcon.tsx`

```tsx
export function lookFor(name: string, isDirectory: boolean, expanded = false): FileLook

export interface FileLook {
	Icon: LucideIcon;
	/** 不走 Tailwind：行内设上，因为这些颜色不在主题推导的色阶里。 */
	light: string;
	dark: string;
}
```

### `iconColour`

源码：`packages/client/ui/src/fileIcon.tsx`

```tsx
/** 取在当前主题下读得清的那个色值。深浅色跟随系统，和 theme.css 的 `prefers-color-scheme` 一致。 */
export function iconColour(look: FileLook): string

export interface FileLook {
	Icon: LucideIcon;
	/** 不走 Tailwind：行内设上，因为这些颜色不在主题推导的色阶里。 */
	light: string;
	dark: string;
}
```

## 滚动

### `Scroller`

源码：`packages/client/ui/src/scroll/Scroller.tsx`

```tsx
/**
 * 应用里唯一的滚动面。
 *
 * 原生滚动容器做不到、而参考设计处处都有的几件事：
 *
 *   - 滚动条浮在内容上，而不是预留一条槽，列表一长过它的盒子，内容不会横向重排；
 *   - 边缘说明那个方向还藏着东西，画成边界实际的样子：内容化进空白的地方是渐隐，滑到实心的东西
 *     底下的地方是一道细线。见 `top`——选错了，列表看起来就像坏了。
 *
 * `overscroll-contain` 让滚到头的滚轮停在这里，而不是传给后面的窗口——否则嵌套列表一到底就会带着
 * 父级一起滚。
 *
 * 嵌在外层滚动面里的面（比如转录里的工具卡片、错误日志、代码输出），用 `overscroll="auto"`，
 * 里面滚到边界之后自然地接到外层。
 */
export function Scroller({
	children,
	className = "",
	contentClassName = "",
	top = "fade",
	fadeTop,
	bottom = "fade",
	overscroll = "contain",
	onScroll,
	onResize,
	onUserScroll,
	onHold,
	scrollRef,
}: {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	/**
	 * 滚到自己的边界之后，滚轮还传不传给外面。
	 *
	 * 判断标准是这一块**是页面里的一段内容，还是一块独立的面**。一段内容——设置页里的发版说明、一列
	 * 搜索结果——读到底了还想接着往下看页面，是很自然的一件事，那就该给 `"auto"`。一块
	 * 独立的面——弹窗、浮层、菜单、转录本身——滚到底就该停住，不然一个嵌套列表刚到底就把它背后的整页
	 * 带跑了，那是默认的 `"contain"` 要挡的事。
	 *
	 * 「滚不动的面要不要拦」不用在这里操心：它一律放行，见下面 `chain` 那段。
	 */
	overscroll?: "contain" | "auto";
	/**
	 * 上沿怎么收尾。
	 *
	 * `"fade"` 把最后几行柔化掉，不画任何东西就说出「这边还有」。上面是什么都成立——空窗格也好、
	 * 不透明的导航也好——因为它降的是内容自己的 alpha，而不是往上面刷颜色；为什么这一点就是全部，
	 * 见 `ui/scroll.css` 里 `.plume-fade-y` 上面那段。
	 *
	 * 只在确实有东西滚到底下去之后才出现，短列表完全没有边缘处理：边界在起作用时才值得画。
	 */
	top?: "fade" | "none";
	/** 默认值不适合这个列表时，上沿渐隐伸进去多深，单位 px。 */
	fadeTop?: number;
	/** 下沿的同一个问题。 */
	bottom?: "fade" | "none";
	onScroll?: (element: HTMLDivElement) => void;
	/** 内容或视口尺寸变了就调用。 */
	onResize?: (element: HTMLDivElement) => void;
	/**
	 * 下面滑块的一次拖动，按它本来的手势报出来。
	 *
	 * 滑块是视口的兄弟节点，靠赋值 `scrollTop` 移动视口，于是拖动传到跟随方那里，是一个和浏览器
	 * 夹住正在变短的转录分不开的滚动事件——而跟随方不能因为一次来路不明的位置变化就脱离（见
	 * `follow.ts`），就永远发现不了读者在往外拉。这是唯一知道真相的组件把那个手势明说出来。
	 */
	onUserScroll?: (direction: Direction) => void;
	/**
	 * 读者刚把手指按在了什么上面。
	 *
	 * 给跟随底部的那一方一个机会，把接下来这一次长高认成「读者点开了手里这一块」而不是「新消息
	 * 到了」——两者在 `onResize` 里长得一模一样，而处理方式正好相反。
	 */
	onHold?: (target: EventTarget | null) => void;
	/** 给自己驱动滚动位置的调用方用，比如转录。 */
	scrollRef?: React.RefObject<HTMLDivElement | null>;
})
```

### `OverlayScrollbar`

源码：`packages/client/ui/src/scroll/OverlayScrollbar.tsx`

```tsx
export function OverlayScrollbar({
	viewport,
	orientation,
	placement = "overlay",
}: {
	viewport: React.RefObject<HTMLElement | null>;
	orientation: "vertical" | "horizontal";
	/**
	 * `sticky`：轨道排在视口后面，粘在外面那个竖向滚动面的底部，落在内容在末尾预留的一条 10px 上。
	 * 视口溢出期间带着 `data-hscroll="on"`，好让它的样式预留那一条——滑块不能盖住最后一行。只用于横向。
	 */
	placement?: "overlay" | "sticky";
})
```

### `ScrollText`

源码：`packages/client/ui/src/scroll/ScrollText.tsx`

```tsx
/**
 * 一行字，到边上渐隐而不是以省略号结尾，所在的行被悬停时自己读出来。
 *
 * 省略号只报告标题被截了，不说截掉的是什么——每个以「帮我梳理这个项目的整体架构」开头的会话都缩成
 * 同一行没法用的字。渐隐说的是同一件事，但更安静，悬停滚动则真正回答了那个问题。
 *
 * 滚动只朝一个方向、连续地走。左右来回扫读起来像这一行在抽搐，而不是字在被读：眼睛得一次次重新
 * 找到开头。第一份后面跟着一份隐藏的副本，单向才能无缝循环——原文离开时，副本正好落在它开始的位置。
 *
 * 只有字真的读不全时才动：已经装得下的行，指针划过时不能抖。父级行带着 `plume-scroll`，悬停规则
 * 认的就是它。
 */
export function ScrollText({
	text,
	className = "",
	textClassName = "",
}: {
	text: ReactNode;
	className?: string;
	/**
	 * 加在装字形的那几个 span 上——正文和它循环用的副本——不加在盒子上。
	 *
	 * 给那些透过字本身画出来的效果用（`background-clip: text`、运行中的流光）。加在盒子上的话，它按
	 * 盒子自己那一层的字形裁剪，而跑马灯的 transform 把轨道抬进了单独的一层：悬停时整行变成空白。
	 */
	textClassName?: string;
})
```

### `Sideways`

源码：`packages/client/ui/src/scroll/Sideways.tsx`

```tsx
export function Sideways({
	children,
	className = "",
	trackRef,
	...rest
}: {
	children: React.ReactNode;
	/** 给会滚的那一层，`overflow-x-auto` 和「我在父级里占多大」的类都写在这里。 */
	className?: string;
	/** 需要自己够到滚动容器的地方传进来——比如「把选中的标签滚进视野」。 */
	trackRef?: React.RefObject<HTMLDivElement | null>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">)
```

## 语言

### `useI18n`

源码：`packages/client/ui/src/i18n/context.tsx`

```tsx
/** 当前界面语言和产品的文案目录。插件只用 `resolvedLocale` 选自己 `messages.ts` 里的那一份；`t()` 查的是产品的目录，插件的文字不在里面。 */
export function useI18n(): I18nValue

interface I18nValue {
	locale: UiLocale;
	resolvedLocale: ResolvedUiLocale;
	t: (key: MessageKey, variables?: MessageVariables) => string;
	formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
	formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}
```

## 时间

### `relativeTime`

源码：`packages/client/ui/src/lib/relative-time.ts`

```tsx
/** 故意说得粗：列表里没人关心一次提交的确切分钟。 */
export function relativeTime(iso: string, now = Date.now()): string
```

### `TimeAgo`

源码：`packages/client/ui/src/primitives/TimeAgo.tsx`

```tsx
export function TimeAgo({ iso, className = "" }: { iso: string; className?: string })
```

## 键盘

### `macKeyboard`

源码：`packages/client/ui/src/keyboard.ts`

```tsx
export function macKeyboard(platform = navigator.platform): boolean
```

### `composingKey`

源码：`packages/client/ui/src/keyboard.ts`

```tsx
/** 这些键归输入法和 AltGr；当成命令处理的话，打字打到一半就切了窗格。 */
export function composingKey(event: KeyboardEvent): boolean
```

### `shortcutLetter`

源码：`packages/client/ui/src/keyboard.ts`

```tsx
/**
 * 快捷键按的是哪个字母：键帽上印的那个。
 *
 * `key` 是拉丁字母时用 `key`。QWERTY、AZERTY、QWERTZ、Dvorak 上它就是键帽上的字母，也就是快捷键的
 * 写法；改用 `code` 匹配的话，AZERTY 的 Ctrl+Alt+A 会变成印着 Q 的那个键，Dvorak 的 Ctrl+B 变成印着 X 的。
 *
 * 否则用 `code`。没有拉丁字母的布局（俄语、希腊语、希伯来语）没有印着 A 的键可按，用户会去按 A 所在
 * 位置的那个键——浏览器自己的快捷键和 CodeMirror 的键位表都是这样兜底的。macOS 的 Option 也落到这里：
 * 它是死键修饰，⌥S 到达时是「ß」，只有位置还说明它是 S。
 */
export function shortcutLetter(event: Pick<KeyboardEvent, "key" | "code">): string | null
```

### `shortcutLabel`

源码：`packages/client/ui/src/keyboard.ts`

```tsx
/** 界面文案一律用紧凑的 Mac 写法；别的键盘要把修饰键写成名字。 */
export function shortcutLabel(text: string, platform = navigator.platform): string
```

### `acceleratorLabel`

源码：`packages/client/ui/src/keyboard.ts`

```tsx
/** 把 Electron 的 accelerator 写成按键文字，不把 Control、Command 和 Windows 键混为一谈。 */
export function acceleratorLabel(accelerator: string, platform = navigator.platform): string
```

## 动效

### `motionReduced`

源码：`packages/client/ui/src/motion/reduced.ts`

```tsx
export function motionReduced(): boolean
```

### `CountUp`

源码：`packages/client/ui/src/primitives/CountUp.tsx`

```tsx
export function CountUp({
	value,
	className,
	/** 走动中的数怎么写。默认是四舍五入的整数。 */
	format = plain,
	bidirectional,
	ms,
	...rest
}: {
	value: number;
	className?: string;
	format?: (shown: number) => string;
	/** 往下也走——见 `useCountUp`。给按更短的时段重算的读数。 */
	bidirectional?: boolean;
	ms?: number;
} & Omit<React.ComponentProps<"span">, "className" | "children">)
```

### `useRolled`

源码：`packages/client/ui/src/motion/RollingText.tsx`

```tsx
/**
 * 这个值是否被替换过——首次绘制时是 false，从第一次变化起是 true。
 *
 * 有两件事靠它做对，而它们往相反的方向拉。
 *
 * 首次绘制不能动。挂上就滚的话，菜单一打开每个标签都落进位，叠在菜单自己的进场上——两个不同方向的动作，
 * 读起来像面板在你面前被拼起来。
 *
 * 可类也不能来来去去，这一点更隐蔽：给元素加上 `animation` 就会**开始**那个动画。一个在下一次无关渲染时
 * 退回 false 的标记，会在再下一次渲染时把类加回来，于是输入框里任何一个标签一变，所有标签都滚一遍。所以它
 * 是锁存的：一旦为 true 就一直是 true，此后动画完全由 `key` 变化引起的重新挂载来驱动。
 *
 * 在渲染期间调整状态，是从一个变了的 prop 推导状态的官方做法——React 丢掉这一遍、立刻重跑组件，于是类和新
 * key 落在同一次提交里，元素挂上时就已经在动。
 */
export function useRolled(value: string | number): boolean
```

### `RollingText`

源码：`packages/client/ui/src/motion/RollingText.tsx`

```tsx
/**
 * 一个值替换另一个值，不管发生在哪里。
 *
 * 原地变化的字——输入框里的推理强度、刚选的模型、权限模式、「展开显示」变成「收起」——不滚的话，眼睛除了
 * 字形不同以外收不到任何「发生了什么」的信号：在正拖着的控件上读起来像渲染瑕疵，在刚点过的控件上读起来像
 * 那一下点了没用。
 *
 * 动作是 `ui/motion.css` 里的 `.plume-roll`——总是往下，一连串的变化读起来是一个东西在被拨动，而不是字在闪。
 * 有了这个组件，用上它就是选对元素的事，而不必记住一个两步的写法（`key={value}` 加 `plume-roll`）。
 *
 * 给标签用，不给读数用。会跳的数——token 数、计时器、百分比——是在连续变化而不是被替换，每跳一下滚一次，
 * 一块安静的仪表就成了整轮里一直在余光里动的东西。那些用 `tabular-nums` 定住。
 */
export function RollingText({
	children,
	className = "",
	rollKey,
}: {
	children: string | number;
	/** 落在外层元素上，它默认是 `inline`——需要的地方给它 `block`。 */
	className?: string;
	/** 改写什么算「换了一个值」，给带着一段总在变的部分的文字用。 */
	rollKey?: string | number;
})
```

### `useNow`

源码：`packages/client/ui/src/motion/useNow.ts`

```tsx
/**
 * 此刻的时间，`active` 时每 `every` 毫秒重画一次：给秒表、倒计时这类在走的读数用，不走的时候一次也不重画。
 *
 * 变成 `active` 的那一下先对一次表：不对的话，挂上以后过了很久才开始走的读数，头一拍显示的是挂上那一刻。
 */
export function useNow(active: boolean, every: number): number
```

### `Collapse`

源码：`packages/client/ui/src/layout/Collapse.tsx`

```tsx
/** 收起时的内容留到尺寸过渡走完，再放掉开销大的子树。 */
export function Collapse({
	open,
	children,
	bodyClassName,
	className = "",
	keepMounted = false,
}: {
	open: boolean;
	children: ReactNode;
	bodyClassName?: string;
	className?: string;
	keepMounted?: boolean;
})
```

## 折叠

### `Disclosure`

源码：`packages/client/ui/src/layout/Disclosure.tsx`

```tsx
export function Disclosure({
	title,
	count,
	trailing,
	children,
	variant = "section",
	...control
}: {
	title: ReactNode;
	/** 显示在标题后面。零值得说；undefined 不说。 */
	count?: number;
	/** 属于这一段而不是它的内容的控件——一个编辑按钮、一个链接。 */
	trailing?: ReactNode;
	children: ReactNode;
	variant?: keyof typeof LOOK;
} & Control)

const LOOK = {
	section: {
		root: "border-t border-line-soft first:border-t-0",
		head: "",
		button: "py-2.5",
		title: "text-label font-medium",
		body: "pb-3",
	},
	compact: {
		root: "",
		head: "",
		button: "py-1",
		title: "text-detail",
		body: "pl-3.5",
	},
	framed: {
		root: "overflow-hidden rounded-lg border border-line-soft",
		head: "pr-3",
		button: "py-2 pl-3",
		/*
		 * 没有自己的字号。framed 的折叠坐在页面已经定好字号的正文里——README 按 label 字号、消息按 body
		 * 字号——标题和周围的字差一档，读起来就像贴进来的第二份文档。
		 */
		title: "",
		body: "px-3 pb-3",
	},
} as const;

type Control = { open: boolean; onToggle: () => void; defaultOpen?: never } | { open?: never; onToggle?: never; defaultOpen?: boolean };
```

## 智能体头像

### `AgentAvatar`

源码：`packages/client/ui/src/avatar/AgentAvatar.tsx`

```tsx
export function AgentAvatar({
	avatar,
	size = 20,
	mood = "idle",
	badge = null,
	interactive = true,
	host,
	seed = "",
	label,
	cheer = null,
	className = "",
}: AgentAvatarProps)

export interface AgentAvatarProps {
	avatar: Avatar;
	/** 像素边长。 */
	size?: number;
	mood?: AvatarMood;
	/** 右下角的小圆点：在跑是强调色、会一圈圈往外扩；出错是红的。 */
	badge?: "running" | "failed" | null;
	/**
	 * 悬停时眼睛跟着指针、身子弹一下。默认开。
	 *
	 * `host` 是往上找的那个容器：一整行的任何地方悬停都算，而不是非得对准这 20 像素。
	 */
	interactive?: boolean;
	host?: string;
	/** 名字，决定眨眼的节奏——七张脸不该踩着同一个拍子。 */
	seed?: string;
	/** 默认是装饰：名字总在旁边写着。单独出现、没有字陪着的时候才给它一个名字。 */
	label?: string;
	/** 换一个值就蹦一下——刚保存好、刚换了脸，给它一个「是我」的回应。 */
	cheer?: string | number | null;
	className?: string;
}
```

### `AvatarPile`

源码：`packages/client/ui/src/avatar/AvatarPile.tsx`

```tsx
export function AvatarPile({
	faces,
	size = 22,
	max = 3,
	focus,
	className = "",
}: {
	faces: PileFace[];
	size?: number;
	max?: number;
	/**
	 * 要完整露出来的那一张（面板顶上：正在看的那个）。
	 *
	 * 它排在露出来的那几张的最后——也就是最上面，紧挨着旁边写它名字的标题。放不下的时候先让出别人的
	 * 位置，它自己一定在。
	 */
	focus?: string;
	className?: string;
})

export interface PileFace {
	key: string;
	avatar: Avatar;
	mood?: AvatarMood;
	seed: string;
}
```

### `assignAvatars`

源码：`packages/client/ui/src/lib/agent-avatar.ts`

```tsx
/**
 * 一份名单里每个人的脸，保证互不相同。
 *
 * 写明了的先落座（定义里的 `avatar`，其次是 `fallback` 给的，内置的那几个就走这条），剩下的
 * **按名字排好序**再逐个算——排序是为了让结果只取决于名单里有谁，不取决于名单是按什么顺序
 * 送来的：设置页和提及菜单拿到的是同一批人、不同的顺序，两边必须画出同一张脸。
 *
 * 写明了的两个撞了，照写的来：那是人自己挑的。
 */
export function assignAvatars(
	agents: readonly { name: string; avatar?: string }[],
	fallback: (name: string) => string | undefined = () => undefined,
): Map<string, Avatar>

export interface Avatar {
	shape: AvatarShape;
	color: AvatarColor;
}
```

### `AVATAR_SHAPES`

源码：`packages/client/ui/src/lib/agent-avatar.ts`

```tsx
export const AVATAR_SHAPES = [
	"circle",
	"drop",
	"squircle",
	"blob",
	"cloud",
	"pill",
	"triangle",
	"flower",
	"hexagon",
	"ghost",
	"star",
	"bean",
	"arch",
	"diamond",
	"heart",
	"burst",
] as const;
```

### `AVATAR_COLORS`

源码：`packages/client/ui/src/lib/agent-avatar.ts`

```tsx
export const AVATAR_COLORS = [
	"blue",
	"green",
	"pink",
	"teal",
	"violet",
	"brown",
	"orange",
	"red",
	"yellow",
	"indigo",
	"lime",
	"sky",
	"rose",
	"mint",
	"coral",
	"plum",
] as const;
```

### `COLOR_ART`

源码：`packages/client/ui/src/avatar/art.ts`

```tsx
/**
 * 色值是亮暗两种主题共用的一套中等明度：眼睛是深色的，身体太暗眼睛就看不见，太浅在白底上
 * 就化开了。所以没有黑、没有灰、也没有嫩黄。
 */
export const COLOR_ART: Record<AvatarColor, string> = {
	blue: "#2f7cf6",
	green: "#1fa35c",
	pink: "#e3398f",
	teal: "#12aaa0",
	violet: "#8b5cf6",
	brown: "#8f5d36",
	orange: "#ff9a1f",
	red: "#ee4d4d",
	yellow: "#f2b61b",
	indigo: "#5d63f0",
	lime: "#7cbb2c",
	sky: "#36b3f0",
	rose: "#fb6f8e",
	mint: "#2fcf8f",
	coral: "#ff7b56",
	plum: "#b34fc8",
};
```

### `parseAvatar`

源码：`packages/client/ui/src/lib/agent-avatar.ts`

```tsx
/** `cloud-violet` → `{ shape: "cloud", color: "violet" }`；认不出来的一律 `null`，由调用方兜底。 */
export function parseAvatar(value: unknown): Avatar | null

export interface Avatar {
	shape: AvatarShape;
	color: AvatarColor;
}
```

### `formatAvatar`

源码：`packages/client/ui/src/lib/agent-avatar.ts`

```tsx
export function formatAvatar(avatar: Avatar): string

export interface Avatar {
	shape: AvatarShape;
	color: AvatarColor;
}
```

### `freshAvatar`

源码：`packages/client/ui/src/lib/agent-avatar.ts`

```tsx
/**
 * 给一个新智能体挑一张没人用过的脸。
 *
 * 不只是「这个组合没人用」：形状和颜色能都不撞就都不撞。内置的几个已经把圆、水滴、方块……和
 * 蓝、绿、粉……占了，新来的要是个绿色的圆，组合是新的，一眼看过去却像 `general` 换了件衣服。
 * 两样都新的挑不出来，退一步只要形状新，再退一步只要组合新。
 */
export function freshAvatar(taken: Iterable<Avatar>, random: () => number = Math.random): Avatar

export interface Avatar {
	shape: AvatarShape;
	color: AvatarColor;
}
```

## 字体

### `withHanFallback`

源码：`packages/client/ui/src/lib/code/font-stack.ts`

```tsx
export function withHanFallback(stack: string): string
```

## 图片标注

### `useAnnotator`

源码：`packages/client/ui/src/image/Annotator.tsx`

```tsx
export function useAnnotator(src: string | RawPixels | null, options?: AnnotatorOptions): Annotator

export interface RawPixels {
	pixels: Uint8Array;
	width: number;
	height: number;
}

export interface AnnotatorOptions {
	/**
	 * 一个随图片变化的值，哪怕字节没有变。
	 *
	 * 截图浮层是一张长期存在的页面——显示、隐藏，而不是建了又拆——所以 `src` 是唯一能告诉它**新的**一次
	 * 截图开始了的东西。两次截图之间屏幕没变的话，编码出来的 PNG 逐字节相同，`src` 也就相同，第一次画上
	 * 的标记在第二次还会在。
	 */
	session?: number | string;
	/**
	 * 这张图的数值属于哪个色彩空间。
	 *
	 * 只有截图会说这件事，因为只有它拿到的是显示器帧缓冲的原始数值——一台 Display P3 的机器上，
	 * 屏幕上的纯红在那串数里是 234,51,35。默认按 sRGB 读，那是每一张解码出来的图片的答案（PNG
	 * 自带 profile，浏览器已经替我们转好了），也是没有色彩管理时的安全答案。
	 */
	colorSpace?: PredefinedColorSpace;
}

export interface Annotator {
	tool: Tool;
	setTool: (tool: Tool) => void;
	colour: string;
	setColour: (colour: string) => void;
	/** 文字底下垫什么；undefined 就是什么都不垫。 */
	backdrop: string | undefined;
	setBackdrop: (backdrop: string | undefined) => void;
	weight: number;
	setWeight: (weight: number) => void;
	undo: () => void;
	redo: () => void;
	clear: () => void;
	canUndo: boolean;
	canRedo: boolean;
	dirty: boolean;
	/** 选中的是哪个标记，或者 null。是当前状态那张清单里的下标。 */
	selected: number | null;
	setSelected: (index: number | null) => void;
	removeSelected: () => void;
	/** 把选中的标记挪这么多个屏幕点——方向键用的。 */
	nudge: (dx: number, dy: number) => void;
	/**
	 * 标注好的图，PNG data URL，按图片自己的尺寸；源图还没解码完时是 null。
	 *
	 * 重新画一遍，而不是从屏幕上那块画布读回来：那块是按屏幕的分辨率画的，图片显示得比它本身大的时候，
	 * 像素比图片本身还多。读回来的话，一张 1408px 的图交出去的是 2200px 的副本。两边用的是同一个
	 * `paintAll`，所以出来的就是屏幕上的样子，尺寸和进来时一样。
	 */
	render: () => string | null;
	/**
	 * 把正在写的那段文字提交掉，如果有的话。返回有没有。
	 *
	 * 任何要把这幅画变成一张图的操作都得先调它。文字在提交之前住在一个 `<textarea>` 里，提交它的是这个
	 * 输入框失去焦点——可工具条故意不拿焦点（`onMouseDown` → `preventDefault`），因为写字时按「粗」必须
	 * 是改这段字的大小，而不是结束它。于是光标还在文字里就按「完成」，什么也没提交：字在屏幕上，在画布
	 * 上面的一个输入框里，而被裁出来的是画布。出来的图上没有那段字。
	 *
	 * `true` 表示提交了东西、画布**还没有**重画——重画是一个 effect，要等 React 把状态变化刷出去以后才
	 * 落下。调用方等一帧再读。
	 */
	flushText: () => boolean;
	// 下面是画布要用的内部件，不给调用方用。
	/**
	 * `flushText` 怎么够到那段文字——它住在 `AnnotateCanvas` 里，不在这里。
	 *
	 * 用 ref 而不是 state：画布在写字时填上它、写完清空，没有任何东西因为它而渲染得不一样。为了这一次调用
	 * 把整套编辑状态提到这里来，要搬好几百行。
	 */
	pendingText: React.RefObject<(() => void) | null>;
	shapes: Shape[];
	canvas: React.RefObject<HTMLCanvasElement | null>;
	setHistory: React.Dispatch<React.SetStateAction<History>>;
	image: React.RefObject<Decoded | null>;
	/** 这个网格大小的马赛克取样用的那张平均过的图，用到时才建，建了就缓存。 */
	mosaicSourceFor(block: number): HTMLCanvasElement | null;
	ready: boolean;
	/**
	 * 这个标注器先后解码过几张图——「源图换了，重画」唯一诚实的依赖。
	 *
	 * `ready` 说不出这件事。新图解码时它变成 false，落地后又变回 true，所以两次截图之间它的**值**两次都是
	 * true——要是解码快到在 React 把那个 `false` 刷出去之前就完成了，两次更新落在同一轮里，这个标志根本没
	 * 变，盯着它的 effect 再也不会跑。`image` 也说不出：它是 ref，所以压根不能当依赖。
	 *
	 * 截图浮层是这件事看得出代价的地方。它在一个以 `ready` 为依赖的 effect 里用这张位图画冻结的桌面，而
	 * 第一次截图还开着时又截了一次，五毫秒就解码完了——于是浮层一边从这一次的图里裁，一边继续显示**上一次**
	 * 的画面，也再没发出让窗口上屏的 `ready` 握手，窗口只好等它 1500ms 的兜底超时。
	 */
	revision: number;
	/**
	 * 这张图和所有从它派生出来的 canvas 用的色彩空间。
	 *
	 * 传下去而不是各处自己猜：裁剪出来的那张、马赛克取样的那张、放大镜里的那张，都得跟主画布同一
	 * 个空间，否则 `drawImage` 会在它们之间做转换——一次转换就是一次色偏，而且只偏彩色不偏灰。
	 */
	colorSpace: PredefinedColorSpace;
	/**
	 * 源图的原始宽度，放在 state 里而不是从 ref 上读。
	 *
	 * 这里的每个尺寸——线宽、字号、马赛克格子——都由它推出来，从 `image.current` 推的话，推导就没有诚实的
	 * 依赖：ref 当不了依赖，拿 `ready` 标志顶替它是一句谎话，lint 拒绝它是对的。
	 */
	width: number;
	/** 现在画一笔马赛克会用的网格。已经画上的标记各自带着自己的。 */
	block: number;
	/**
	 * 在图片适配后的尺寸下，一个屏幕点盖住多少个图片像素：工具条给出的尺寸是屏幕尺寸，标记存的是图片像素，
	 * 靠它换算。由画布报上来——只有画布知道图片在屏幕上有多大。
	 */
	unit: number;
	setUnit: (unit: number) => void;
}
```

### `AnnotateCanvas`

源码：`packages/client/ui/src/image/AnnotateCanvas.tsx`

```tsx
/**
 * @param className 替换画布自己的尺寸和外框，给需要把它摆得分毫不差的调用方。看图器要 `STAGE_FIT`
 *   ——按图片自己的像素定大小、以窗口为上限；截图浮层要的正相反，一块钉在它已经选好的矩形上的画布。
 *   不传的话画布按位图尺寸以 CSS 像素排版，在 Retina 屏上是它该盖住的区域的两倍。
 */
export function AnnotateCanvas({ annotator, zoom, className, style }: { annotator: Annotator; zoom: number; className?: string; style?: React.CSSProperties })
```

### `AnnotateToolbar`

源码：`packages/client/ui/src/image/AnnotateToolbar.tsx`

```tsx
export function AnnotateToolbar({
	annotator,
	onCancel,
	onSave,
	onPin,
	onDownload,
	onGrab,
	grabbing = false,
	canReplace,
	delivers = false,
	saveLabel,
	cancelLabel,
	requireDirty = true,
	style,
	propertiesSide = "above",
}: {
	annotator: Annotator;
	onCancel: () => void;
	onSave: () => void;
	/**
	 * 把这张图留在桌面上、浮在一切之上，而不是交出去。
	 *
	 * 只在有意义的地方给——截图浮层——因为把一张已经开在窗口里的图的一块置顶，是给正在看的东西复制一份。
	 */
	onPin?: () => void;
	/** 把这张图写进下载目录。理由同 `onPin`。 */
	onDownload?: () => void;
	/**
	 * 这一条要挪窝了：从哪儿按下的，按下时它在哪儿。
	 *
	 * 挪到哪儿是调用方的事——它飘在一张截好的屏幕上，得留在屏幕里——所以这里只说「开始了」，外加
	 * 两个位置。带上 `origin` 而不是让调用方自己去 DOM 里量：这一条的位置只有它自己最清楚，而且
	 * 按住按钮触发的那一次是从定时器里发出的，那会儿 React 的合成事件早就没有 `currentTarget` 了。
	 *
	 * 不传就是不能挪。
	 */
	onGrab?: (grab: { from: { x: number; y: number }; origin: { x: number; y: number } }) => void;
	/** 正在挪，好让整条和它上面每个控件都显示同一个光标。 */
	grabbing?: boolean;
	/**
	 * 当前工具的属性气泡往哪边开，以这条工具条为准。
	 *
	 * `above` 开在工具条上面，`below` 开在下面。由调用方决定，因为只有调用方知道工具条摆在被标注的东西的
	 * 哪一边：气泡得往远离它的方向开，否则就把它盖住了。默认 `above`，看图器就是这样——工具条一开始贴着
	 * 舞台底边。
	 */
	propertiesSide?: "above" | "below";
	/** 保存能不能替换原图，还是只能另出一份副本。 */
	canReplace: boolean;
	/**
	 * 副本是交出去接着用，而不是导出。
	 *
	 * 对话里的一张图被标注，是为了让它照着重画，所以副本进那个对话的输入框：按钮是带勾的「完成」，而不是
	 * 一个下载箭头，许诺一个谁也没要的文件。
	 */
	delivers?: boolean;
	/** 覆盖保存按钮上的字。不传就按 `canReplace` 的意思说。 */
	saveLabel?: string;
	cancelLabel?: string;
	/**
	 * 保存是不是要求先画过东西。
	 *
	 * 对一张已经存在的图是 true——保存一份没动过的副本只会多出一个一模一样的文件，所以在有东西可存之前
	 * 按钮是死的。对截图浮层是 false：那个按钮就是确认这次截图的方式，而一块没有标注的区域是最常见的需求。
	 */
	requireDirty?: boolean;
	style?: React.CSSProperties;
})
```

### `useToolbarPlacement`

源码：`packages/client/ui/src/image/useToolbarPlacement.ts`

```tsx
/**
 * `bounds` 可以是 null。
 *
 * 组件在拿到第一帧数据之前就早返回了，而 hook 必须在那之前调用——所以这里收一个可能还不存在的
 * 屏幕尺寸。它为 null 时 `selection` 必然也是 null（没有截图就没有选区），下面那两处算位置的
 * 地方都走不到。
 */
export function useToolbarPlacement(selection: Rect | null, bounds: { width: number; height: number } | null): ToolbarPlacement

export interface ToolbarPlacement {
	/** 画在哪。`null` 表示还没有选区，也就没有工具条。 */
	at: ToolbarAt;
	/** 正在被拖动——调用方拿它改光标。 */
	dragging: boolean;
	/** 挂在工具条那个元素上的 ref 回调。 */
	measure: (el: HTMLDivElement | null) => void;
	/** 按住把手时调用，带上按下的点和当时工具条的位置。 */
	startDrag: (grab: { from: Point; origin: Point }) => void;
	/** 新一轮截图开始时调用：忘掉用户上一轮把它拖到了哪。 */
	reset: () => void;
}
```

## 选区几何

### `HANDLES`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/**
 * 八个方向，按 CSS 光标的叫法命名。
 *
 * 角在前，这样顺着这张表做的命中测试在角和边重叠的地方优先认角——它们总是重叠，而指针瞄的就是角。
 */
export const HANDLES = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;
```

### `HANDLE_CURSOR`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/** 每个手柄该显示的光标：它的名字加上 CSS 要的后缀。 */
export const HANDLE_CURSOR: Record<Handle, string> = {
	nw: "nwse-resize",
	se: "nwse-resize",
	ne: "nesw-resize",
	sw: "nesw-resize",
	n: "ns-resize",
	s: "ns-resize",
	e: "ew-resize",
	w: "ew-resize",
};

export type Handle = (typeof HANDLES)[number];
```

### `handlePoint`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/** 手柄在哪，表示为选区边上的一个点。 */
export function handlePoint(rect: Rect, handle: Handle): Point

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Handle = (typeof HANDLES)[number];

export interface Point {
	x: number;
	y: number;
}
```

### `hitHandle`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/**
 * 指针在哪个手柄上，没有就是 null。
 *
 * `tolerance` 是屏幕像素的半径，而不是手柄画出来的大小：目标得比记号大，理由和滚动条一样——八个像素见方
 * 的一块，手落不准。
 */
export function hitHandle(rect: Rect, at: Point, tolerance: number): Handle | null

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

export type Handle = (typeof HANDLES)[number];
```

### `insideRect`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/** 点是否在选区里——在里面按下是移动，而不是重新拖一个。 */
export function insideRect(rect: Rect, at: Point): boolean

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}
```

### `rectFromPoints`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/** 由两个角得到矩形，两个角哪个在前都行。 */
export function rectFromPoints(a: Point, b: Point): Rect

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
```

### `resizeRect`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/**
 * 把一个手柄拖到某点之后的选区。
 *
 * 写成「挪动这个手柄管的那几条边，再规范化」，所以拖过对边时矩形会翻过来，而不是得到负的宽度——这是人在
 * 其他任何地方改大小时预期的样子，`rectFromPoints` 本来就是这么写的。
 */
export function resizeRect(rect: Rect, handle: Handle, to: Point): Rect

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Handle = (typeof HANDLES)[number];

export interface Point {
	x: number;
	y: number;
}
```

### `moveRect`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/** 选区平移一段，保持完整、保持在屏幕里。 */
export function moveRect(rect: Rect, dx: number, dy: number, within: { width: number; height: number }): Rect

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
```

### `clampRect`

源码：`packages/client/ui/src/image/screenshot-geometry.ts`

```tsx
/** 选区裁到屏幕以内，给拉过了边的改大小用。 */
export function clampRect(rect: Rect, within: { width: number; height: number }): Rect

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
```

## `@plume/styles` 的类名组合

`import { text, card } from "@plume/styles"`，拼进 `className`。产品的 Tailwind 扫描这个包，这些类一定会生成。

### `text`

```ts
export const text = {
	/** 次要说明：路径、状态、空状态。 */
	faint: "text-caption text-ink-faint",
	error: "text-detail text-danger",
	link: "text-accent hover:underline",
};
```

### `field`

```ts
/** 单行输入框和下拉框：无描边的一块 card 底，悬停、聚焦时深一档。高度只有 control 这一档。 */
export const field =
	"h-control min-w-0 rounded-field bg-card px-4 text-label text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-card-hover focus:bg-card-hover";
```

### `fieldLabel`

```ts
/** 包住输入框的 label：上面一行小字，下面是控件。 */
export const fieldLabel = "flex flex-col gap-1.5 text-caption font-medium text-ink-muted";
```

### `textarea`

```ts
/** 多行输入框：没有框，放进自己画框的容器里（主输入框那种），外观由容器出。 */
export const textarea = "min-w-0 resize-none bg-transparent text-body text-ink outline-none placeholder:text-ink-faint";
```

### `button`

```ts
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
```

### `iconButton`

```ts
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
```

### `card`

```ts
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
```

### `actions`

```ts
/** 卡片底部一行：左边是说明，右边是按钮。 */
export const actions = {
	row: "mt-2.5 flex items-center gap-2",
	note: "flex-1 text-caption text-ink-muted",
};
```

### `code`

```ts
export const code = {
	block: `${PRE} px-2.5 py-2 break-words whitespace-pre-wrap`,
	diff: `${PRE} py-1.5`,
	diffLine: "px-2.5 break-words whitespace-pre-wrap",
	diffKind: { same: "", add: "bg-diff-add", remove: "bg-diff-remove" },
};
```
