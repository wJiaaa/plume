# 样式和文案

## 样式

`@plume/ui` 和 `--plume-*` token 是**推荐选项，不是强制要求**。插件可以按场景自由选择两种写法，也可以混用：

- **贴合 Plume 原生外观（推荐，尤其是嵌在主界面缝隙里的小控件）**：输入框按钮（`ui.composerItem`）、标题栏控件（`ui.sessionToolbar`）、环境卡片行（`ui.environmentSection`）、设置分区等，强烈建议用 `@plume/ui` 组件（文字用 `Text`）、`@plume/styles` 导出的类名组合和 `var(--plume-*)`（见 [components.md](components.md)），可以免费跟随浅深色、皮肤（`ui.skin`）和字号缩放。
- **自定义设计（适合独立页面、面板、回复内代码块等专属画布）**：可以不依赖 `@plume/ui`，直接写自己的 `.css`、配色、字号、圆角、阴影或引入第三方 React 组件库，自己通过 `ui.useTheme()` 或 `var(--plume-*)` 照顾好浅色与深色两种主题即可。

### 两条底线（`plume-plugin check` 默认检查）

无论选哪种写法，都必须守住这两条技术边界：

1. **不要在 `className` 里写产品的 Tailwind 类**：插件单独构建，产品的 Tailwind 扫不到插件源码里的类名，写了会静默失效。要复用产品样式请从 `@plume/styles` 导入类名组合，否则写自己的 CSS 类。
2. **不要写污染宿主的全局 CSS 选择器**：插件的样式表直接挂在主文档的 `<head>` 里，没有自动隔离。每条 CSS 选择器必须带上插件自己的类名（如 `.my-plugin-card`、`.my-plugin-card button`）、ID，或者整体放进 `@scope (.my-plugin)` 里；禁止裸写 `*`、`html`、`body`、`:root`、`button`、`input`、`[disabled]` 这类会波及宿主和其他插件的选择器。

### 严格设计系统检查（`plume-plugin check --strict-style`）

如果希望插件完全贴合 Plume 原生设计系统（Plume 仓库内的内置插件和模板默认启用），跑 `plume-plugin check --strict-style` 会额外检查下面四项：

- 颜色只取 `var(--plume-*)`，不写字面色值（`#fff`、`rgb()`、`oklch()`）。确实和主题无关的文件（如 canvas 绘图）在文件注释里写 `color-exempt` 并说明原因，整文件豁免。
- 行内 `style` 的颜色、圆角、字号、行高、字距、字体、阴影、过渡只取 `var(--plume-*)`，或 `transparent`、`inherit`、`currentColor`、`none`；间距、尺寸等布局值可写数字。
- CSS 里的字号、行高、字距、字体、字重、圆角、阴影只能写单个 `var(--plume-*)` 或 `inherit` 这类关键字（`calc()` 拼档位不行）：文字交给 `Text`。
- 过渡时长用 `var(--plume-t-quick)`、`var(--plume-t-base)`、`var(--plume-t-slow)`，浮层离开用 `var(--plume-t-leave)`，不写数字时长（如 `200ms`）；按下不缩放、不位移。

### 常用主题 token（自愿复用，自动适配浅深色和换肤）

- 表面与线条：`--plume-shell`、`--plume-card`、`--plume-card-hover`、`--plume-elevated`、`--plume-line`、`--plume-line-soft`
- 文字与状态：`--plume-ink`、`--plume-ink-muted`、`--plume-ink-faint`、`--plume-ok`、`--plume-danger`、`--plume-warning`、`--plume-accent`
- 字体与圆角：`--plume-font-sans`、`--plume-font-mono`、`--plume-radius-panel`、`--plume-radius-field`、`--plume-radius-item`

自己画代码的，可跟随外观设置里的代码外观：底色、字色 `--plume-code-bg`、`--plume-code-fg`，字体、字号 `--plume-font-mono`、`--plume-code-size`，行高、字距 `--plume-code-line-height`、`--plume-code-tracking`，语法色 `--plume-syntax-*`（操作符是 `operator`），行内代码 `--plume-inline-code-bg`、`--plume-inline-code-fg`、`--plume-inline-code-ring`。

自己画改动（加的行、删的行）的，可跟随外观设置里的「差异标记」：根节点 `data-diff-markers` 是 `color`（默认，用底色）或 `symbols`（不铺底色，代码前标 `+` / `-`，没改的行垫一个空格对齐），在 CSS 里写 `:root[data-diff-markers="symbols"] .my-plugin-diff …`。用 `ui.FileDiff` 的不用自己处理。

### 插件自带样式表

宿主不加载插件的样式表，自己挂一份（类名带上插件前缀，或用 `@scope (.my-plugin) { ... }` 限定作用域，避免和产品或别的插件撞上）：

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
