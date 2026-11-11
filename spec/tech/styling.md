# 样式写法

管怎么写样式：Tailwind 工具类、类名组合放哪、行内 style、全局样式、焦点和动效的统一处理，以及 `pnpm check:styles` 查什么、例外怎么登记。取值本身见 [`tokens.md`](./tokens.md)。

## 开发准则

### 写在哪

- 产品界面、`@plume/ui` 用 Tailwind 工具类，取值只用 token。Tailwind 自带的色板和字号已清空，写了不生效。
- 两处以上会用的组合（控件、卡片、代码、文字）放 `@plume/styles` 的 `src/index.ts`；只用一次的布局（栅格、页面边距、窗口顶行）写在用的地方。
- 能用 `@plume/ui` 组件的不自己拼类名，见 [`components.md`](./components.md)。
- 工具类写不清的视觉效果（伪元素、遮罩、`@starting-style`，比如会话背景图）写进渲染进程 `styles.css` 的 `@layer components`，类名带上组件名（`.chat-backdrop`），取值同样只用 token。
- 产品的 Tailwind 只扫描 `apps/desktop/src/renderer`、`packages/client`。插件单独构建，自己写的 Tailwind 类扫不到：插件用 `@plume/ui` 组件（文字用 `Text`）、`@plume/styles` 导出的组合，再不够用自己的类名加 `var(--plume-*)`；插件自己的 CSS 只管布局和颜色，字号、行高、字距、字体、字重、圆角、阴影只能写单个 `var(--plume-*)` 或关键字。

### 不能写的

- 颜色、字号、圆角、阴影、字体、行高、字距的任意值（`text-[13px]`、`rounded-[10px]`、`[color:...]`）。
- 代码里的色值（`#fff`、`rgb()`、`oklch()`……），theme.css 除外。
- 数字时长（`duration-200`、CSS 里的 `200ms`）。用默认值（quick），或 `duration-[var(--plume-t-base)]`。
- 行内 `style` 里的颜色、圆角、字号、行高、字距、字体、阴影、过渡只能取 `var(--plume-*)`，或 `transparent`、`inherit`、`currentColor`、`none`。布局和运行时算出来的尺寸、位置（间距、拖动宽度、窗口按钮偏移）可以写数字。

### 统一处理的，组件里不要重复

全在 `apps/desktop/src/renderer/styles.css` 的 base 层：

- **焦点**：浏览器默认轮廓去掉；键盘焦点（`:focus-visible`）统一是 2px 强调色、外移 2px。输入框不画焦点环，聚焦时底色深一档（`field` 自带）。
- **减少动态效果**：根节点 `data-reduce-motion` 是 `system` / `on` / `off`，用户选择优先于 `prefers-reduced-motion`。减少时统一清除延迟、把过渡和动画时长压到 0.01ms，结束事件照常触发；JS 动画通过 `motionReduced()` 读取同一偏好。
- **光标**：根节点 `data-pointer-cursor` 开启时，可交互的按钮、菜单项、选项等显示手形；默认箭头，输入区保留文本光标，禁用控件不显示手形。

### 交互反馈

- 悬停：底色到 `card-hover`，或字从 faint/muted 到 ink。
- 按下：底色再深一档到 `elevated`（危险操作是 `danger/15`）。不缩放、不位移。
- 禁用：降透明度（primary 40%，其余 45%），不换颜色；忙碌（loading）是 60%，和禁用区分开。

### 例外

确实需要破例（比如主进程里窗口启动时的底色只能写色值）时，登记在 `scripts/check-styles.mjs` 的 `ALLOWED_COLORS` 里并写明原因，不要绕过检查。

## 检查点

`pnpm check:styles` 跑这九条，`pnpm check` 包含它：

1. 依赖 token 的类名能生成样式（写错 token 名、用了被清空的色板会报）。
2. 颜色、字号、圆角、阴影、字体不用任意值。
3. 代码里不写色值（例外见 `ALLOWED_COLORS`）。
4. `SkinToken` 和 theme.css 一致。
5. `packages/builtin/` 和插件 SDK 的模板（`packages/sdk/plugin-sdk/template`）的 `className` 不写 Tailwind 类；插件 CSS 里的字号、行高、字距、字体、字重、圆角、阴影只取单个 `var(--plume-*)` 或关键字。市场插件由插件仓库自己的检查按同一份规则（插件 SDK 的 `lib/lint/styles.mjs`）查。
6. 不写数字时长。
7. 行内 style 的颜色、圆角、字号、字体、阴影、过渡只用 `var(--plume-*)` 和几个关键字。
8. ink-muted ≥ 4.5、ink-faint ≥ 3，在 shell、sidebar、card、input、float 上，浅深两种主题。
9. 按下不缩放、不位移（`active:scale-*`、`active:translate-*`）。

检查管不到的，交付前自己看：新组合在浅深两种主题下都看一眼（`pnpm smoke` 的截图跟随系统主题）。

## 事实来源

- `scripts/check-styles.mjs`
- `apps/desktop/src/renderer/styles.css`
- `packages/client/styles/src/index.ts`
