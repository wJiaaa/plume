# 样式和文案

## 样式

插件单独构建，产品的 Tailwind 扫不到插件自己写的类名：**插件的 `className` 里不写 Tailwind 类**，写了也没有样式。按这个顺序选：

1. `@plume/ui` 的组件：**文字一律用 `Text`**（`size` 选字号档位，`tone` 选颜色）；按钮、输入框、菜单、卡片、代码块用对应组件。见 [components.md](components.md)。
2. `@plume/styles` 导出的类名组合（同样列在 components.md），产品一定会生成这些类。
3. 自己写样式：行内 `style`，或者插件自带的 `.css` 文件（布局、伪类、伪元素、第三方库的样式表）。

自己写的样式只管布局和颜色，按下时不缩放、不位移；`plume-plugin check` 查下面几条：

- 颜色只取 `var(--plume-*)`，不写色值（`#fff`、`rgb()`、`oklch()`）。确实只能写色值的文件（canvas 只认字面色值）在文件里写一行带 `color-exempt` 的注释写明原因，整个文件不查色值。
- 行内 `style` 的颜色、圆角、字号、行高、字距、字体、阴影、过渡只取 `var(--plume-*)`，或 `transparent`、`inherit`、`currentColor`、`none`；间距、尺寸这些布局值可以写数字。
- CSS 里的字号、行高、字距、字体、字重、圆角、阴影只能写单个 `var(--plume-*)` 或 `inherit` 这类关键字，`calc()` 照着拼一份档位也不行：文字交给 `Text`。原生 `<input>` 会继承外层的字号，外面包一层 `Text` 就行。
- 过渡时长用 `var(--plume-t-quick)`、`var(--plume-t-base)`、`var(--plume-t-slow)`，不写 `200ms`。

常用 token：面 `--plume-shell`、`--plume-card`、`--plume-card-hover`、`--plume-elevated`；线 `--plume-line`、`--plume-line-soft`；字 `--plume-ink`、`--plume-ink-muted`、`--plume-ink-faint`；状态 `--plume-ok`、`--plume-danger`、`--plume-warning`；强调 `--plume-accent`；字体 `--plume-font-sans`、`--plume-font-mono`；圆角 `--plume-radius-panel`、`--plume-radius-field`、`--plume-radius-item`。浅色、深色跟随系统，token 自动切换，不用自己判断主题。

自己画代码的，跟随外观设置里的代码外观：底色、字色 `--plume-code-bg`、`--plume-code-fg`，字体、字号 `--plume-font-mono`、`--plume-code-size`，行高、字距 `--plume-code-line-height`、`--plume-code-tracking`，语法色 `--plume-syntax-*`（操作符是 `operator`），行内代码 `--plume-inline-code-bg`、`--plume-inline-code-fg`、`--plume-inline-code-ring`。

自己画改动（加的行、删的行）的，跟随外观设置里的「差异标记」：根节点 `data-diff-markers` 是 `color`（默认，用底色）或 `symbols`（不铺底色，代码前标 `+` / `-`，没改的行垫一个空格对齐），在 CSS 里写 `:root[data-diff-markers="symbols"] …`。用 `ui.FileDiff` 的不用自己处理。

插件自带样式表：宿主不加载插件的样式表，自己挂一份。

```tsx
// src/css.d.ts
declare module "*.css" {
	const css: string;
	export default css;
}

// src/ui.tsx：按插件名认那个元素，重新加载时换内容、不叠加
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
- 拼句子时标点和语序也在文案里，不在代码里拼 `${a}：${b}`：检查连中文标点一起查。

**发给模型的文字不翻译**：工具的 `description`、`output`、提示词、`approved` 理由。这些写在代码里的中文，紧挨着在上一行写 `// i18n-exempt：原因`，作用到下一个空行为止。`messages.ts`、注释和日志调用（`ctx.log`、`console`）的参数不查。
