# 组件和类名组合

<!-- 由 `node scripts/check-plugins.mjs --fix` 从源码生成，不要手改。名单在 packages/client/ui/plugin-api.json。 -->

界面入口能用的 `@plume/ui` 组件和 `@plume/styles` 类名组合，就是这一页列出的这些；`@plume/ui` 的其他导出是产品内部用的，`pnpm check:plugins` 会拦。签名和注释摘自源码：解构的参数只留有默认值的（其余的看后面的类型），`keyof typeof` 的常量只列键，注释只取第一段。

怎么选：文字一律用 `Text`（字号档位自带行高、字距和字重，不在 CSS 里写字号）；按钮、输入框、开关、菜单、对话框用对应组件；工具卡片的外框用 `Card`。组件不够时用下面的类名组合，再不够才写自己的样式（见 [style-i18n.md](style-i18n.md)）。

## 文字

### `Text`

```tsx
/** 一段文字：`size` 选字号档位（每档带着自己的行高、字距和默认字重），`tone` 选颜色。 */
export function Text({ size = "label", tone = "default", as = "span", mono = false, numeric = false, className = "", ...rest }: {
	size?: keyof typeof SIZES;
	tone?: keyof typeof TONES;
	/** 覆盖这一档平时的字重。 */
	weight?: keyof typeof WEIGHTS;
	/** 渲染成什么元素。默认 `span`，能放进一句话里。 */
	as?: "span" | "p" | "div" | "h1" | "h2" | "h3" | "label" | "code";
	/** 等宽字体，给正文里引用的标识符和路径。 */
	mono?: boolean;
	/** 等宽数字，给原地变化的数——token 数、计时、diff 统计。 */
	numeric?: boolean;
	className?: string;
	children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>)

const SIZES = {
	/** 页面标题——一屏一个。 */
	display: …,
	/** 一屏里大分区的标题。 */
	heading: …,
	/** 小节和卡片的标题。 */
	title: …,
	/** 正文：消息、描述，一句一句读的东西。 */
	body: …,
	/** 控件、行、表格单元——界面的工作字号。 */
	label: …,
	/** 标签下面的次要细节。 */
	detail: …,
	/** 时间戳、计数、角标。 */
	caption: …,
} as const;

const TONES = {
	default: …,
	muted: …,
	faint: …,
	danger: …,
	accent: …,
} as const;

const WEIGHTS = {
	normal: …,
	medium: …,
	semibold: …,
} as const;
```

## 按钮

### `Button`

```tsx
export function Button({ variant = "ghost", size = "md", className = "", type = "button", ...data }: DataAttributes & {
	/** 只有图标的按钮不传。 */
	children?: ReactNode;
	icon?: ReactNode;
	onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
	variant?: ButtonVariant;
	size?: ButtonSize;
	disabled?: boolean;
	/** 忙碌。按钮不能按、变淡，宽度不变。 */
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

```tsx
/** 标签是一个图标的按钮。`label` 同时是悬停提示和无障碍名。 */
export function IconButton({ tone = "default", size = "md", tipSide = "bottom", className = "", ...data }: DataAttributes & {
	label: string;
	/** 无障碍名要比悬停提示多说一点时用。 */
	ariaLabel?: string;
	icon: React.ReactNode;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	/** 按住 / 开着，给「区分大小写」这类开关。 */
	active?: boolean;
	disabled?: boolean;
	/** 一排里现在值得按的那一个。 */
	emphasis?: boolean;
	/** 角上的计数。零和 null 都画成什么都没有。 */
	badge?: number | null;
	/** 禁用时也显示悬停提示，因为标签说明的正是为什么禁用。 */
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

```tsx
/** 不带样式的原生控件：布局、ref、选区和撤销历史都留在调用方手里。 */
export function Input(props: ComponentPropsWithRef<"input">)
```

### `Textarea`

```tsx
/** 同 `Input`，多行。要带框、滚动条和渐隐的多行框用 `TextArea`。 */
export function Textarea(props: ComponentPropsWithRef<"textarea">)
```

### `TextArea`

```tsx
/** 写很多字的地方，一种写法。 */
export function TextArea({ shell = "", className = "", resizable = false, ...rest }: {
	value: string;
	onChange: (value: string) => void;
	/** 外壳上的额外类。高度、外边距、宽度——和这个框在页面上待在哪儿有关的事，调用方说了算。 */
	shell?: string;
	/** 字那一层的额外类：等宽、字号、`h-[180px]` 这类只跟可写区域有关的。 */
	className?: string;
	/** 能不能用鼠标拉高。只给写长文的地方，比如一份系统提示词。 */
	resizable?: boolean;
} & Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange" | "className" | "ref">)
```

### `Select`

```tsx
export function Select<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
})
```

### `InlineSelect`

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

```tsx
export function Toggle(props: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	ariaLabel?: string;
	disabled?: boolean;
})
```

### `ComposerToggle`

```tsx
export function ComposerToggle({ size = "composer", iconOnly = false, ...data }: {
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

```tsx
export function WorktreeToggle({ size = "composer", iconOnly = false }: {
	on: boolean;
	onChange: (on: boolean) => void;
	/** `sm` 放在 `Button size="sm"` 旁边，比如建议卡片上：26px，主输入框的控件是 28px。 */
	size?: "composer" | "sm";
	/** 开着时也只有图标，见 `ComposerToggle` 的 `iconOnly`。 */
	iconOnly?: boolean;
})
```

### `Segmented`

```tsx
/** 一排互斥的选项，选中的那个下面垫着一块会滑过去的底。 */
export function Segmented<T extends string>(props: {
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

```tsx
export function TabStrip<T extends string>({ className = "" }: {
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

```tsx
/** 搜索框。独占一行的给 `size="comfortable"`，塞进面板标题行的用默认的 `compact`。 */
export function SearchField({ size = "compact", className = "" }: {
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

```tsx
/** 带自己画的步进按钮的数字框。`onChange` 只收到 `min`–`max` 以内的数，敲到一半的草稿留在框里。 */
export function NumberField({ min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, step = 1, width = 76 }: {
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

```tsx
/**
 * 轨道和把手自己画的滑块。原生 range 叠在最上面、完全透明，拖动、点轨道跳过去、方向键都是浏览器自己的，
 * 画出来的部分只跟着 value 走。
 */
export function Slider({ min = 0, max = 100, step = 1, width = 180 }: {
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

```tsx
/** 那枚色块。里面的输入框是色块的一部分（底色就是它编辑的颜色），不是一个单独的输入框，所以不用 Input 的外观。 */
export function ColorField({ readOnly = false }: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	readOnly?: boolean;
})
```

### `TimeField`

```tsx
/** 时间，用两个列表挑，不用浏览器的时钟。 */
export function TimeField(props: {
	/** `HH:mm`，24 小时制。 */
	value: string;
	onChange: (value: string) => void;
	label: string;
}): JSX.Element
```

### `ShortcutRecorder`

```tsx
/** 录一组快捷键：点一下进入录制，按下的那组键就是值（Electron accelerator 的写法）。Esc 放弃，⌫ / Delete 清空。 */
export function ShortcutRecorder({ value, onChange, placeholder }: { value?: string; onChange: (shortcut: string) => void; placeholder?: string })
```

### `useFieldFade`

```tsx
export function useFieldFade(field: React.RefObject<HTMLElement | null>, host: React.RefObject<HTMLElement | null>): void
```

### `ChoiceMark`

```tsx
/** 自己画的选中标记。 */
export function ChoiceMark({ indeterminate = false, className = "" }: {
	checked: boolean;
	kind: "checkbox" | "radio";
	indeterminate?: boolean;
	className?: string;
})
```

## 弹层、菜单、对话框

### `Popover`

```tsx
export function Popover({ placement = "top", align = "end", role = "menu", className = "", bodyClassName = "", surface = "menu" }: PopoverProps)

export interface PopoverProps {
	/** 弹层挂在哪个元素上，右键菜单则是一个点。 */
	anchor: Anchor;
	onClose: () => void;
	children: React.ReactNode;
	/** 优先放在哪一侧。地方不够时自动翻转。 */
	placement?: "top" | "bottom" | "right";
	/** 弹层的哪条边和锚点对齐。 */
	align?: "start" | "end" | "center";
	width?: PopoverWidth;
	/** 钉在滚动正文上面——搜索框、标题。 */
	header?: React.ReactNode;
	/** 钉在它下面，给不管列表多长都要够得着的动作。 */
	footer?: React.ReactNode;
	/** 钉在它左边——比如一列分类。 */
	aside?: React.ReactNode;
	/** 给否则会长满窗口的面一个上限——见 `MENU_MAX_HEIGHT`。 */
	maxHeight?: number;
	/** 这个面是什么，给读窗口而不是看窗口的东西。 */
	role?: "menu" | "listbox" | "dialog" | "group";
	/** 触发元素没说清时，给这个面一个名字。 */
	label?: string;
	className?: string;
	/** 加在滚动正文上，给自己给内容加内衬的面。 */
	bodyClassName?: string;
	/** 一列行（`menu`），还是一样东西（`panel`：整个正文交给内容，滑块浮在上面）。 */
	surface?: "menu" | "panel";
	/** 把悬停交给整个面，给悬停打开的弹层用。 */
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
}

export type Anchor = HTMLElement | PointAnchor | null;

export type PopoverWidth = keyof typeof MENU_WIDTH | number;

interface PointAnchor {
	x: number;
	y: number;
}

const MENU_WIDTH = {
	/** 只有动作，每个一两个词。 */
	compact: …,
	/** 普通的菜单——图标、文字，有时有第二行——以及所有下拉。 */
	default: …,
	/** 带搜索框的，或者长到要滚动的列表。 */
	wide: …,
	/** 不是菜单：一段读数、一个滑块、一张表单。 */
	panel: …,
	/** 内容多宽就多宽（`undefined` 就是「这一层别管宽度」）。 */
	hug: …,
} as const;
```

### `ContextMenu`

```tsx
/** 面本身。点了任何一行都会关掉它。 */
export function ContextMenu({ width = "default" }: {
	anchor: { x: number; y: number } | null;
	onClose: () => void;
	width?: PopoverWidth;
	children: React.ReactNode;
})
```

### `MenuItem`

```tsx
/** 菜单里的一行。 */
export function MenuItem({ className = "" }: {
	icon?: React.ReactNode;
	children: React.ReactNode;
	/** 解释这个选项的第二行。 */
	detail?: React.ReactNode;
	/** 右对齐的注记：数量、快捷键数字、上下文大小。 */
	hint?: React.ReactNode;
	/** 右对齐的元素，放勾或箭头。 */
	trailing?: React.ReactNode;
	/** 让这一行成为开关设置：行尾一个小开关，`menuitemcheckbox` 语义。 */
	checked?: boolean;
	selected?: boolean;
	danger?: boolean;
	disabled?: boolean;
	title?: string;
	/** 加在行本身上的类，给用别的方式标记行的菜单。 */
	className?: string;
	onClick?: () => void;
})
```

### `MenuSeparator`

```tsx
/** 分开菜单里的几组行。 */
export function MenuSeparator()
```

### `MenuLabel`

```tsx
/** 一组行上面的小标题。 */
export function MenuLabel({ children }: { children: React.ReactNode })
```

### `Dialog`

```tsx
/**
 * 里面放着 `DialogFrame` 的 `Overlay`。`actions` 和 `children` 可以是 `dismiss` 的函数，关对话框的按钮
 * 应该用它：`dismiss()` 播完退场再运行 `onClose`，`dismiss(after)` 改为运行 `after`。
 */
export function Dialog({ width = 480, ...frame }: {
	onClose: () => void;
	width?: number;
	label?: string;
	returnFocus?: HTMLElement;
	actions: ReactNode | ((dismiss: Dismiss) => ReactNode);
	children?: ReactNode | ((dismiss: Dismiss) => ReactNode);
} & Omit<Parameters<typeof DialogFrame>[0], "actions" | "children">)

export function DialogFrame({ className = "", ...rest }: {
	title: ReactNode;
	icon?: ReactNode;
	detail?: ReactNode;
	/** 放在正文里、滚动区上方——进度、警告，任何不能被滚走的东西。 */
	status?: ReactNode;
	children?: ReactNode;
	actions: ReactNode;
	height?: number;
	/**
	 * 滚动的正文最高能长到多高。只给是表单而不是问题的对话框用——默认值按一段话加一个列表定的，
	 * 设置表单放在它下面一次只能滚出三个字段。
	 */
	bodyClassName?: string;
	className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">)
```

### `DialogAction`

```tsx
/** 对话框底下的那一颗按钮。上面写着它会做的那件事：写字，不画图标。 */
export function DialogAction({ tone = "secondary", className = "", ...rest }: {
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

```tsx
/** 放在应用模态面上的问题：居中、压着遮罩、Escape 或点遮罩关掉。 */
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
	/** `danger` 是默认，给删除这类拿不回来的事；`normal` 给「以后要不要自动做这件事」这类问题。 */
	tone?: "danger" | "normal";
	onConfirm: () => void;
	/** 取消也要做点什么的时候。 */
	onCancel?: () => void;
	/** 同一个动词的另一种做法，比如「删除此会话」旁边的「删除 3 个会话」。 */
	alternate?: { label: string; onConfirm: () => void };
	/** 说明和按钮之间的那一块，比如「不再询问」。大多数问题用不着。 */
	children?: React.ReactNode;
}
```

### `useConfirmer`

```tsx
/** 给满是删除按钮的页面用的一个确认。 */
export function useConfirmer()
```

### `useConfirmGate`

```tsx
/** 同一个问题，可以 await。 */
export function useConfirmGate()
```

### `Tooltip`

```tsx
/** 应用的悬停提示，代替浏览器的 `title`。写成 JSX 包装，比直接写 `data-plume-tip` 属性读起来顺，两种写法表现一样。 */
export function Tooltip({ label, children, side = "bottom" }: { label: string; children: React.ReactElement; side?: "top" | "bottom" })
```

### `usePopover`

```tsx
/** 记下锚点元素和打开状态，每个弹层触发器都要的这一对。 */
export function usePopover()
```

### `MenuBody`

```tsx
/** 每个菜单的内容所在的盒子。 */
export function MenuBody({ insetIcons = false, className = "" }: {
	children: React.ReactNode;
	/** 每行都留出图标列，给只有部分行有图标的菜单用。 */
	insetIcons?: boolean;
	className?: string;
})
```

### `MenuSearch`

```tsx
/** 列出超过一屏的菜单顶上的筛选框，放进 `Popover` 的 `header` 槽位，列表滚动时它不动。Escape 先清空再关闭。 */
export function MenuSearch({ autoFocus = true }: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	autoFocus?: boolean;
	/** 给焦点留在输入框里、由它来移动高亮（方向键和 Enter）的菜单用。 */
	onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
})
```

### `MENU_MAX_HEIGHT`

```tsx
/** 列东西的菜单最高能长到多高。 */
export const MENU_MAX_HEIGHT = 340;
```

### `Overlay`

```tsx
/** Escape、点遮罩、取消和完成共用一套生命周期，嵌套的对话框也一样。 */
export function Overlay({ width = 460 }: {
	children: React.ReactNode | ((dismiss: Dismiss) => React.ReactNode);
	onClose: () => void;
	width?: number;
	label?: string;
	returnFocus?: HTMLElement;
})

export type Dismiss = (after?: () => void) => void;
```

## 卡片和代码

### `Card`

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

```tsx
export function CodeBlock({ children }: { children: string })
```

## 审批卡

### `ApprovalFrame`

```tsx
export function ApprovalFrame({ queued = 0 }: {
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

```tsx
/**
 * 这张卡还剩多久失效，每秒走一格（「4:59 后失效」）。到期没人答，本体按拒绝收场：不说出来的截止比没有截止更糟，
 * 人回来时这一轮已经被一个没见过的「不」结束了。
 */
export function ApprovalExpiry({ at }: { at: number })
```

## 设置分区

### `SettingsSectionTitle`

```tsx
/** 一组卡片上面的分组标题。 */
export function SettingsSectionTitle({ children }: { children: React.ReactNode })
```

### `SettingsCard`

```tsx
/** 其余属性原样透传，卡片可以带一个 `data-` 标记给测试量它。 */
export function SettingsCard({ children, className = "", ...rest }: React.ComponentProps<"div">)
```

### `SettingsRow`

```tsx
/** 卡片里带标签的一行，控件靠右。 */
export function SettingsRow(props: {
	title: React.ReactNode;
	detail?: React.ReactNode;
	control?: React.ReactNode;
	children?: React.ReactNode;
})
```

### `SettingsNotice`

```tsx
/** 页面要告诉你的一句话：出错了（`danger`）、有东西要看一眼（`accent`），或者只是让你知道（`muted`）。 */
export function SettingsNotice({ className = "", ...rest }: React.ComponentProps<"div"> & { tone: keyof typeof NOTICE_TONES; icon?: LucideIcon })

const NOTICE_TONES = {
	danger: …,
	accent: …,
	muted: …,
} as const;
```

## 面板

### `PanelEmpty`

```tsx
/** 空面板正文的中间。 */
export function PanelEmpty(props: {
	icon: LucideIcon;
	/** 画在图标的位置上、比一枚线性图标更能说明这里该有什么的东西——子智能体面板放的是几张睡着的脸。 */
	art?: React.ReactNode;
	title: string;
	/** 可省：有些空状态的标题已经把话说完了，底下再补一句就是在解释一个不需要解释的东西。 */
	children?: React.ReactNode;
})
```

### `RetainedViews`

```tsx
/** 留住少数几个看过的页面；藏起来的页面暂停 effect，保留局部状态。 */
export function RetainedViews<T extends string>({ active, render, limit = 3 }: { active: T; render: (key: T) => React.ReactNode; limit?: number })
```

### `useNarrow`

```tsx
/** 一个元素是不是窄到放不下两栏，按元素自己量。 */
export function useNarrow(threshold: number): [boolean, (node: HTMLDivElement | null) => void]
```

### `useLiveRefresh`

```tsx
export function useLiveRefresh(refresh: () => void | Promise<void>, running: boolean, ms = LIVE_POLL_MS): void
```

## 页面

### `PageTopRow`

```tsx
/**
 * 自己画顶行的页面（`ui.page` 给了 `topRow: true`）每一栏最上面那一行：坐在窗口顶行的高度上，和侧栏顶上那一行齐平。
 * 整行拖得动窗口、双击能缩放，行里能点的控件（按钮、链接、输入框）自动不拖动，不用一个个标。贴着页面左边的那一栏给
 * `start`（两栏页面的右栏在窄窗口里换成整页时也给），给侧栏收起时浮在这里的红绿灯和前进、后退让出宽度。
 * 高度、内边距之外的排法（间距、两端对齐）由 `className` 补；行里不折行，放不下的东西自己截断。
 */
export function PageTopRow({ start = false, className = "", ...rest }: { start?: boolean; className?: string; children?: ReactNode; ref?: Ref<HTMLElement> } & HTMLAttributes<HTMLElement>)
```

## 加载和占位

### `StatusSpinner`

```tsx
/** 一圈虚线，匀速转：这一条正在跑，顶替的是状态图标（任务清单的一步、工具卡的运行中）。颜色跟着周围的文字。 */
export function StatusSpinner({ size = 14, className = "" }: { size?: number; className?: string })
```

### `ActionSpinner`

```tsx
/** 一段亮弧沿着一圈淡轨道跑：你按的那下正在回来，顶替的是刚按下的动作图标或角标。 */
export function ActionSpinner({ size = 14, className = "" }: { size?: number; className?: string })
```

### `BreatheLoader`

```tsx
/** 一圈波纹离开静止的中心，颜色一路走过调色板：这个会话在跑，给侧栏的会话行和替一个会话报状态的地方。 */
export function BreatheLoader({ size = 14, className = "" }: { size?: number; className?: string })
```

### `SkeletonList`

```tsx
/** 一摞设置行，和它们代替的那个列表一致。 */
export function SkeletonList({ count = 5, label = translate("common.reading") }: { count?: number; label?: string })
```

### `SkeletonBar`

```tsx
/** 一块暗色的块。`width` 是任意 CSS 长度，一排这样的块看起来能像字而不是像条。 */
export function SkeletonBar({ width, height = 10, className = "" }: { width: string; height?: number; className?: string })
```

### `useSlowLoad`

```tsx
/** 一次加载是否已经久到值得画占位。 */
export function useSlowLoad(loading: boolean, delay = 220): boolean
```

## 列表的行

### `HoverRow`

```tsx
export function HoverRow({ className = "", ...rest }: ComponentPropsWithoutRef<"div"> & {
	controls: string;
})
```

### `HoverRowMark`

```tsx
/** 行首的图标列：每一行 git 都是同一个 12px 的框，工作树不额外缩进。 */
export function HoverRowMark({ className = "", children }: { className?: string; children: ReactNode })
```

### `HoverRowReveal`

```tsx
/** 按内容收缩的浮层。绝不做成定宽的一列：那样会把空着的框也画出来。 */
export function HoverRowReveal({ className = "", children }: { className?: string; children: ReactNode })
```

### `hoverSlot`

```tsx
/** 控件条量好之前先写进 `--plume-row-controls` 的兜底值。 */
export function hoverSlot(actions: 1 | 2 | 3): string
```

### `Caret`

```tsx
export function Caret({ size = 12, strokeWidth = 2, className = "" }: {
	open: boolean;
	from?: "down" | "right";
	size?: number;
	strokeWidth?: number;
	className?: string;
	style?: React.CSSProperties;
})
```

### `MarkNumber`

```tsx
/** 一枚圆形序号：把两处说的同一件东西对上号。 */
export function MarkNumber({ n, className = "", ...rest }: { n: number; className?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "children">)
```

## 过程行

### `FlowRow`

```tsx
export function FlowRow({ danger = false, ...rest }: {
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

```tsx
/** 取在当前主题下读得清的那个色值。深浅色跟随系统，和 theme.css 的 `prefers-color-scheme` 一致。 */
export function iconColour(look: FileLook): string
```

`FileLook` 见上文。

## 滚动

### `Scroller`

```tsx
/** 应用里唯一的滚动面。 */
export function Scroller({ className = "", contentClassName = "", top = "fade", bottom = "fade", overscroll = "contain" }: {
	children: React.ReactNode;
	className?: string;
	contentClassName?: string;
	/**
	 * 滚到自己的边界之后，滚轮还传不传给外面。页面里的一段内容（嵌在外层滚动面里的工具卡片、代码输出、
	 * 一列搜索结果）给 `"auto"`；独立的面（弹窗、浮层、菜单）用默认的 `"contain"`。
	 */
	overscroll?: "contain" | "auto";
	/** 上沿怎么收尾。 */
	top?: "fade" | "none";
	/** 默认值不适合这个列表时，上沿渐隐伸进去多深，单位 px。 */
	fadeTop?: number;
	/** 下沿的同一个问题。 */
	bottom?: "fade" | "none";
	onScroll?: (element: HTMLDivElement) => void;
	/** 内容或视口尺寸变了就调用。 */
	onResize?: (element: HTMLDivElement) => void;
	/** 下面滑块的一次拖动，按它本来的手势报出来。 */
	onUserScroll?: (direction: Direction) => void;
	/** 读者刚把手指按在了什么上面。 */
	onHold?: (target: EventTarget | null) => void;
	/** 给自己驱动滚动位置的调用方用，比如转录。 */
	scrollRef?: React.RefObject<HTMLDivElement | null>;
})
```

### `OverlayScrollbar`

```tsx
export function OverlayScrollbar({ placement = "overlay" }: {
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

```tsx
/** 一行字，到边上渐隐而不是以省略号结尾，所在的行被悬停时自己读出来：那一行（父级）要带 `plume-scroll` 类。 */
export function ScrollText({ className = "", textClassName = "" }: {
	text: ReactNode;
	className?: string;
	/** 加在装字形的那几个 span 上——正文和它循环用的副本——不加在盒子上。 */
	textClassName?: string;
})
```

### `Sideways`

```tsx
export function Sideways({ className = "", ...rest }: {
	children: React.ReactNode;
	/** 给会滚的那一层，`overflow-x-auto` 和「我在父级里占多大」的类都写在这里。 */
	className?: string;
	/** 需要自己够到滚动容器的地方传进来——比如「把选中的标签滚进视野」。 */
	trackRef?: React.RefObject<HTMLDivElement | null>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">)
```

## 语言

### `useI18n`

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

```tsx
/** 故意说得粗：列表里没人关心一次提交的确切分钟。 */
export function relativeTime(iso: string, now = Date.now()): string
```

### `TimeAgo`

```tsx
export function TimeAgo({ iso, className = "" }: { iso: string; className?: string })
```

## 键盘

### `macKeyboard`

```tsx
export function macKeyboard(platform = navigator.platform): boolean
```

### `composingKey`

```tsx
/** 这些键归输入法和 AltGr；当成命令处理的话，打字打到一半就切了窗格。 */
export function composingKey(event: KeyboardEvent): boolean
```

### `shortcutLetter`

```tsx
/** 快捷键按的是哪个字母：键帽上印的那个。 */
export function shortcutLetter(event: Pick<KeyboardEvent, "key" | "code">): string | null
```

### `shortcutLabel`

```tsx
/** 界面文案一律用紧凑的 Mac 写法；别的键盘要把修饰键写成名字。 */
export function shortcutLabel(text: string, platform = navigator.platform): string
```

### `acceleratorLabel`

```tsx
/** 把 Electron 的 accelerator 写成按键文字，不把 Control、Command 和 Windows 键混为一谈。 */
export function acceleratorLabel(accelerator: string, platform = navigator.platform): string
```

## 动效

### `motionReduced`

```tsx
export function motionReduced(): boolean
```

### `CountUp`

```tsx
export function CountUp({ ...rest }: {
	value: number;
	className?: string;
	format?: (shown: number) => string;
} & Omit<React.ComponentProps<"span">, "className" | "children">)
```

### `useRolled`

```tsx
/** 这个值是否被替换过——首次绘制时是 false，从第一次变化起是 true。 */
export function useRolled(value: string | number): boolean
```

### `RollingText`

```tsx
/** 一个值替换另一个值，不管发生在哪里。给会换成另一个值的标签用，不给连续跳的读数用。 */
export function RollingText({ className = "" }: {
	children: string | number;
	/** 落在外层元素上，它默认是 `inline`——需要的地方给它 `block`。 */
	className?: string;
	/** 改写什么算「换了一个值」，给带着一段总在变的部分的文字用。 */
	rollKey?: string | number;
})
```

### `useNow`

```tsx
/** 此刻的时间，`active` 时每 `every` 毫秒重画一次：给秒表、倒计时这类在走的读数用，不走的时候一次也不重画。 */
export function useNow(active: boolean, every: number): number
```

### `Collapse`

```tsx
/** 收起时的内容留到尺寸过渡走完，再放掉开销大的子树。 */
export function Collapse({ className = "", keepMounted = false }: {
	open: boolean;
	children: ReactNode;
	bodyClassName?: string;
	className?: string;
	keepMounted?: boolean;
})
```

## 折叠

### `Disclosure`

```tsx
export function Disclosure({ variant = "section", ...control }: {
	title: ReactNode;
	/** 显示在标题后面。零值得说；undefined 不说。 */
	count?: number;
	/** 属于这一段而不是它的内容的控件——一个编辑按钮、一个链接。 */
	trailing?: ReactNode;
	children: ReactNode;
	variant?: keyof typeof LOOK;
} & Control)

const LOOK = {
	section: …,
	compact: …,
	framed: …,
} as const;

type Control = { open: boolean; onToggle: () => void; defaultOpen?: never } | { open?: never; onToggle?: never; defaultOpen?: boolean };
```

## 智能体头像

### `AgentAvatar`

```tsx
export function AgentAvatar({ avatar, size = 20, mood = "idle", interactive = true, host, seed = "", label, cheer = null, className = "" }: AgentAvatarProps)

export interface AgentAvatarProps {
	avatar: Avatar;
	/** 像素边长。 */
	size?: number;
	mood?: AvatarMood;
	/** 悬停时眼睛跟着指针、身子弹一下。默认开。 */
	interactive?: boolean;
	/** 往上找的那个容器的选择器（`closest`）：在它里面任何地方悬停都算，而不是非得对准这 20 像素。 */
	host?: string;
	/** 名字，决定眨眼的节奏——七张脸不该踩着同一个拍子。 */
	seed?: string;
	/** 默认是装饰：名字总在旁边写着。单独出现、没有字陪着的时候才给它一个名字。 */
	label?: string;
	/** 换一个值就蹦一下——刚保存好、刚换了脸，给它一个「是我」的回应。 */
	cheer?: string | number | null;
	className?: string;
}

export type AvatarMood = "idle" | DispatchState;
```

### `AvatarPile`

```tsx
export function AvatarPile({ size = 22, max = 3, className = "" }: {
	faces: PileFace[];
	size?: number;
	max?: number;
	/** 要完整露出来的那一张（面板顶上：正在看的那个）。 */
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

```tsx
/** 一份名单里每个人的脸，保证互不相同。 */
export function assignAvatars(
	agents: readonly { name: string; avatar?: string }[],
	fallback: (name: string) => string | undefined = () => undefined,
): Map<string, Avatar>

export interface Avatar {
	shape: AvatarShape;
	color: AvatarColor;
}

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export type AvatarColor = (typeof AVATAR_COLORS)[number];
```

### `AVATAR_SHAPES`

```tsx
export const AVATAR_SHAPES = ["circle", "drop", "squircle", "blob", "cloud", "pill", "triangle", "flower", "hexagon", "ghost", "star", "bean", "arch", "diamond", "heart", "burst"] as const;
```

### `AVATAR_COLORS`

```tsx
export const AVATAR_COLORS = ["blue", "green", "pink", "teal", "violet", "brown", "orange", "red", "yellow", "indigo", "lime", "sky", "rose", "mint", "coral", "plum"] as const;
```

### `COLOR_ART`

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

```tsx
/** `cloud-violet` → `{ shape: "cloud", color: "violet" }`；认不出来的一律 `null`，由调用方兜底。 */
export function parseAvatar(value: unknown): Avatar | null
```

`Avatar` 见上文。

### `formatAvatar`

```tsx
export function formatAvatar(avatar: Avatar): string
```

`Avatar` 见上文。

### `freshAvatar`

```tsx
/** 给一个新智能体挑一张没人用过的脸。 */
export function freshAvatar(taken: Iterable<Avatar>, random: () => number = Math.random): Avatar
```

`Avatar` 见上文。

## 字体

### `withHanFallback`

```tsx
export function withHanFallback(stack: string): string
```

## 图片标注

### `useAnnotator`

```tsx
export function useAnnotator(src: string | RawPixels | null, options?: AnnotatorOptions): Annotator

export interface RawPixels {
	pixels: Uint8Array;
	width: number;
	height: number;
}

export interface AnnotatorOptions {
	/** 一个随图片变化的值，哪怕字节没有变。 */
	session?: number | string;
	/** 这张图的数值属于哪个色彩空间。 */
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
	/** 标注好的图，PNG data URL，按图片自己的尺寸；源图还没解码完时是 null。 */
	render: () => string | null;
	/**
	 * 把正在写的那段文字提交掉，如果有的话。返回有没有。任何要把这幅画变成一张图的操作（`render`）都得先调它；
	 * 返回 `true` 时画布还没重画，调用方等一帧再读。
	 */
	flushText: () => boolean;
	// 下面是画布要用的内部件，不给调用方用。
	/** `flushText` 怎么够到那段文字——它住在 `AnnotateCanvas` 里，不在这里。 */
	pendingText: React.RefObject<(() => void) | null>;
	shapes: Shape[];
	canvas: React.RefObject<HTMLCanvasElement | null>;
	setHistory: React.Dispatch<React.SetStateAction<History>>;
	image: React.RefObject<Decoded | null>;
	/** 这个网格大小的马赛克取样用的那张平均过的图，用到时才建，建了就缓存。 */
	mosaicSourceFor(block: number): HTMLCanvasElement | null;
	ready: boolean;
	/** 这个标注器先后解码过几张图——「源图换了，重画」唯一诚实的依赖。 */
	revision: number;
	/** 这张图和所有从它派生出来的 canvas 用的色彩空间。 */
	colorSpace: PredefinedColorSpace;
	/** 源图的原始宽度，放在 state 里而不是从 ref 上读。 */
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

interface Decoded {
	source: CanvasImageSource;
	width: number;
	height: number;
}
```

### `AnnotateCanvas`

```tsx
/**
 * @param className 替换画布自己的尺寸和外框，给需要把它摆得分毫不差的调用方。看图器要 `STAGE_FIT`
 *   ——按图片自己的像素定大小、以窗口为上限；截图浮层要的正相反，一块钉在它已经选好的矩形上的画布。
 *   不传的话画布按位图尺寸以 CSS 像素排版，在 Retina 屏上是它该盖住的区域的两倍。
 */
export function AnnotateCanvas({ annotator, zoom, className, style }: { annotator: Annotator; zoom: number; className?: string; style?: React.CSSProperties })
```

### `AnnotateToolbar`

```tsx
export function AnnotateToolbar({ grabbing = false, delivers = false, requireDirty = true, propertiesSide = "above" }: {
	annotator: Annotator;
	onCancel: () => void;
	onSave: () => void;
	/** 把这张图留在桌面上、浮在一切之上，而不是交出去。 */
	onPin?: () => void;
	/** 把这张图写进下载目录。理由同 `onPin`。 */
	onDownload?: () => void;
	/** 这一条要挪窝了：从哪儿按下的，按下时它在哪儿。挪到哪儿由调用方定；不传就是不能挪。 */
	onGrab?: (grab: { from: { x: number; y: number }; origin: { x: number; y: number } }) => void;
	/** 正在挪，好让整条和它上面每个控件都显示同一个光标。 */
	grabbing?: boolean;
	/** 当前工具的属性气泡往哪边开，以这条工具条为准。 */
	propertiesSide?: "above" | "below";
	/** 保存能不能替换原图，还是只能另出一份副本。 */
	canReplace: boolean;
	/** 副本是交出去接着用，而不是导出。 */
	delivers?: boolean;
	/** 覆盖保存按钮上的字。不传就按 `canReplace` 的意思说。 */
	saveLabel?: string;
	cancelLabel?: string;
	/** 保存是不是要求先画过东西。 */
	requireDirty?: boolean;
	style?: React.CSSProperties;
})
```

### `useToolbarPlacement`

```tsx
/** `bounds` 可以是 null。 */
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

type ToolbarAt = (Point & { side: "above" | "below" | "over" }) | null;
```

## 选区几何

### `HANDLES`

```tsx
/** 八个方向，按 CSS 光标的叫法命名。 */
export const HANDLES = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;
```

### `HANDLE_CURSOR`

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

```tsx
/** 手柄在哪，表示为选区边上的一个点。 */
export function handlePoint(rect: Rect, handle: Handle): Point

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

`Handle` 见上文。

### `hitHandle`

```tsx
/** 指针在哪个手柄上，没有就是 null。`tolerance` 是屏幕像素的半径，而不是手柄画出来的大小。 */
export function hitHandle(rect: Rect, at: Point, tolerance: number): Handle | null
```

`Rect`、`Point`、`Handle` 见上文。

### `insideRect`

```tsx
/** 点是否在选区里——在里面按下是移动，而不是重新拖一个。 */
export function insideRect(rect: Rect, at: Point): boolean
```

`Rect`、`Point` 见上文。

### `rectFromPoints`

```tsx
/** 由两个角得到矩形，两个角哪个在前都行。 */
export function rectFromPoints(a: Point, b: Point): Rect
```

`Point`、`Rect` 见上文。

### `resizeRect`

```tsx
/** 把一个手柄拖到某点之后的选区。 */
export function resizeRect(rect: Rect, handle: Handle, to: Point): Rect
```

`Rect`、`Handle`、`Point` 见上文。

### `moveRect`

```tsx
/** 选区平移一段，保持完整、保持在屏幕里。 */
export function moveRect(rect: Rect, dx: number, dy: number, within: { width: number; height: number }): Rect
```

`Rect` 见上文。

### `clampRect`

```tsx
/** 选区裁到屏幕以内，给拉过了边的改大小用。 */
export function clampRect(rect: Rect, within: { width: number; height: number }): Rect
```

`Rect` 见上文。

## `@plume/styles` 的类名组合

`import { text, card } from "@plume/styles"`，拼进 `className`。产品的 Tailwind 扫描这个包，这些类一定会生成。
`button`、`iconButton`、`code` 是 `Button`、`IconButton`、`CodeBlock` 的外观，用组件，这里不列。

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
