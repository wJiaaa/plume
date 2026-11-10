# 样式和文案

## 样式

插件单独构建，产品的 Tailwind 扫不到插件自己写的类名：**插件的 `className` 里不写 Tailwind 类**，写了也没有样式。按这个顺序选：

1. `@plume/ui` 的组件：**文字一律用 `Text`**（`size` 选字号档位，`tone` 选颜色），按钮、输入框、菜单、卡片、代码块用对应组件。有哪些、怎么用见 [components.md](components.md)。
2. `@plume/styles` 导出的类名组合（同样列在 [components.md](components.md)），产品一定会生成这些类。
3. 行内 `style`：颜色、圆角、字号、行高、字距、字体、阴影、过渡只能取 `var(--plume-*)`，或 `transparent`、`inherit`、`currentColor`、`none`；间距、尺寸这些布局值可以写数字。
4. 布局（flex、间距、宽度）、伪类、伪元素、第三方库的样式表，写一个 `.css` 文件，按文字引入，自己挂到页面上（下面的例子）。CSS 只管布局和颜色：颜色只用 `var(--plume-*)`；字号、行高、字距、字体、字重、圆角、阴影只能写单个 `var(--plume-*)` 或 `inherit` 这类关键字，`calc()` 照着拼一份档位也不行，文字交给 `Text`。原生 `<input>` 会继承外层的字号，外面包一层 `Text` 就行。

不能写的：色值（`#fff`、`rgb()`、`oklch()`）、数字时长（`200ms`，用 `var(--plume-t-*)`）、按下时缩放或位移。确实只能写色值的（比如 canvas 只认字面色值）要登记例外并写明原因。

常用 token：面 `--plume-shell`、`--plume-card`、`--plume-card-hover`、`--plume-elevated`；线 `--plume-line`、`--plume-line-soft`；字 `--plume-ink`、`--plume-ink-muted`、`--plume-ink-faint`；状态 `--plume-ok`、`--plume-danger`、`--plume-warning`；强调 `--plume-accent`；字体 `--plume-font-sans`、`--plume-font-mono`；圆角 `--plume-radius-panel`、`--plume-radius-field`、`--plume-radius-item`；时长 `--plume-t-quick`、`--plume-t-base`。浅色、深色跟随系统，token 自动切换，不用自己判断主题。

代码显示跟随外观设置：底色/字色用 `--plume-code-bg` / `--plume-code-fg`，字体/字号用 `--plume-font-mono` / `--plume-code-size`，行高/字距用 `--plume-code-line-height` / `--plume-code-tracking`；语法色用 `--plume-syntax-*`（操作符为 `operator`），行内代码用 `--plume-inline-code-bg` / `--plume-inline-code-fg` / `--plume-inline-code-ring`。这些也可以通过皮肤覆盖；用户明确设置的代码外观仍优先。界面种子通常也是用户优先，只有同时给出 name、mode 的数据皮肤管理配色时暂时忽略界面种子与深浅模式，停用后恢复原偏好。

自己画改动（加的行、删的行）的，跟随外观里的「差异标记」：根节点 `data-diff-markers` 是 `color`（默认，用底色）或 `symbols`（不铺底色，代码前标 `+` / `-`，没改的行垫一个空格对齐），在 CSS 里写 `:root[data-diff-markers="symbols"] …`。`@plume/ui` 的 `DiffView` 本来就同时标 `+` / `-`，不用管。

插件自带样式表：

```tsx
// src/css.d.ts
declare module "*.css" {
	const css: string;
	export default css;
}

// src/ui.tsx：宿主不加载插件的样式表，自己挂一份；按插件名认那个元素，重新加载时换内容不叠加
import myCss from "./my.css";

function mountStyles(): void {
	const id = "example.my-thing";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = myCss;
}
// apply(ui) 里先调 mountStyles()
```

自己的类名带上插件前缀，免得和产品或别的插件撞上。

## 文案

给人看的文字（卡片、面板、页面、审批理由、错误提示）中英两份，写在 `src/messages.ts`：

```ts
import type { Locale } from "@plume/contract";

const zhCN = {
	title: "计划",
	empty: "这个会话还没有计划。",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: { title: "Plan", empty: "This conversation has no plan yet." },
};
```

- 界面入口：`MESSAGES[useI18n().resolvedLocale]`（`useI18n` 来自 `@plume/ui`），切换语言时跟着重画。
- 逻辑入口：`MESSAGES[ctx.locale()]`。
- 面板、页面的 `title`、`description` 传 `(locale) => string`，产品每次按当前语言调用。
- 拼句子时标点和语序也在文案里，不在代码里拼 `${a}：${b}`。

**发给模型的文字不翻译**：工具的 `description`、`output`、提示词、`approved` 理由，以及日志。代码里出现中文时，紧挨着在上一行写 `// i18n-exempt：原因`，作用到下一个空行为止；`pnpm check` 会查没登记的中文。
