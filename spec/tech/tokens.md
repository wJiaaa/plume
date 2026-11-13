# 设计 token

管颜色、字号、圆角、尺寸、阴影、动效的取值和用途，以及什么时候能加新 token。定义只有一处：`packages/client/styles/src/theme.css`。

## 开发准则

### 颜色从种子推

- 种子只有四个：背景 `--plume-bg`、前景 `--plume-fg`、强调色 `--plume-accent`、对比度 `--plume-contrast`（0–1）。面、线、字都由它们 `color-mix` 推出来，深浅色只换种子和几个系数（`--plume-k-*`，不是 token，皮肤不改）。
- 新颜色先想能不能从种子推（比如“比 card 深一点”用前景的透明度），不能再加 token。状态色的浅底用透明度修饰（`bg-danger/10`），不另设 token。
- 浅色下输入框和浮层往白色混（像纸），深色下往前景混（变亮），这是有意的，不要统一。

### 每个 token 用在哪

| 组 | token（Tailwind 类名） | 用途 |
|---|---|---|
| 面 | `root` | 窗口最外层与停靠侧栏共用的底层，默认 `var(--plume-shell)`，数据皮肤可与正文区分开 |
| | `root-image`（无 Tailwind 类） | 盖在 root 上的底纹，CSS 图像（可多层，如渐变），默认 `none`；只在数据皮肤接管配色时铺在外圈，固定在视口上，外圈、侧栏吸顶标题和 Windows 顶带取同一片。磨砂颗粒不是 token，是用户开关（外观偏好 `grain`），叠在它上面 |
| | `shell` | 正文区 |
| | `sidebar` | compact 浮出侧栏；停靠侧栏透明，共用窗口 root，不另铺一层 |
| | `card` | 卡片：工具卡片、用户消息；输入框（field）的底 |
| | `card-hover` | 悬停、选中（侧栏的会话、设置导航、列表里选中的行）、输入框聚焦：前景色的薄纱，压在什么面上都看得出来 |
| | `elevated` | 按下，比 card-hover 再深一档 |
| | `input` | 主输入框 |
| | `float` | 浮在最上面的：菜单、弹层、设置卡片、审批卡 |
| | `knob` | 开关的圆点，深浅色都是白的 |
| | `shade` | 纯黑，只按透明度用：对话框的遮罩、白色旋钮的描边 |
| | `window-tint` | 毛玻璃窗口盖在系统材质上的半透明底 |
| 线 | `line` | 普通描边、分隔 |
| | `line-soft` | 卡片内部、代码块这种更弱的分隔 |
| | `line-float` | 画在 float 上的线；正文卡片压在毛玻璃上的描边 |
| 字 | `ink` | 正文、标题 |
| | `ink-muted` | 次要文字，每种面上 ≥ 4.5:1 |
| | `ink-faint` | 最淡的说明、占位符、图标按钮平时的颜色，≥ 3:1，不放需要细读的长句 |
| 色 | `accent` | 链接、焦点环、开关打开 |
| | `accent-dim` | 共享强调弱底（如 ComposerToggle 开启态），默认强调色 10% 透明底，数据皮肤可直接指定 |
| | `ok` / `danger` / `warning` | 状态；浅底写 `/10`、描边写 `/40` |
| | `violet`、`on-accent` | 呼吸灯的第二色相、强调色实底上的字 |
| | `chart-2` … `chart-6` | 图表里排在 accent、violet、ok 之后的系列色（使用统计、上下文用量的分段），不表示状态 |
| 代码 | `code-bg`、`code-fg`、`diff-add`、`diff-remove` | 代码的底色、字色与 diff 两种行底，跟随代码主题 |
| | `inline-code-bg`、`inline-code-fg`、`inline-code-ring` | 行内代码底色、字色、可选描边，app / syntax / custom 三档 |
| | `code-line-height`、`code-tracking` | 代码行高和字距，默认 1.6 / 0em |
| | `syntax-keyword`、`syntax-string`、`syntax-number`、`syntax-comment`、`syntax-function`、`syntax-type`、`syntax-variable`、`syntax-operator`、`syntax-punctuation`、`syntax-tag`、`syntax-attribute` | 代码块的语法配色，只经 `var(--plume-syntax-*)` 用在高亮样式里，不映射成 Tailwind 类 |

### 深度

面按层叠：`shell` → `sidebar`/`card` → `card-hover`（悬停）→ `elevated`（按下）；`float` 盖在一切上面。照着别处做一个东西时，换的是深度，不是整段类名：放在 card 上的悬停仍然是 `hover:bg-card-hover`，不要为了“看起来深一点”另写一个色值或透明度。

### 圆角、尺寸、字号

- 圆角：`rounded-panel` 12（一整块内容区、设置卡片）、`rounded-field` 8（输入框、提示框、侧栏和列表里的行）、`rounded-item` 6（菜单里的行、分段控件里的一段）。按钮用 Tailwind 刻度：≥ 22px 的按钮 `rounded-lg`（8），≤ 20px 的 `rounded-md`（6）；大卡片、气泡用 `rounded-2xl`。落在两档之间的往小取。
- 菜单外框 `rounded-menu` 10px，内衬 `menu-inset` 4px、行高 `menu-row` 32px。输入框 `composer-in/x/out/control` 分别是 12/16/24/28px；对话列最宽 `content` 864px；窗格 `frame-pad/pane-chrome` 是 2/5px。这些尺寸不开放给皮肤。
- 高度：输入框和下拉只有 `h-control`（34）；按钮 32 / 26 / 20 三档，见 [`components.md`](./components.md)。
- 正文字号档：`text-caption`、`text-detail`、`text-label`（工作字号，默认）、`text-body`（正文，顺着读的句子）、`text-title`、`text-heading`、`text-display`、`text-hero`（只给欢迎页的问候）、`text-code`。都由 `--plume-ui-size`、`--plume-code-size` 算出，自带行高和字距。字重不在档里：title 配 `font-medium`，heading、display 配 `font-semibold`，hero 配 `font-medium`。

- 数字角标另用 `text-badge` 和 `text-mark`（UI 字号减 5px / 4px），不用于正文。

### 动效

- 时长按“什么在动”选：`--plume-t-quick` 150（悬停、按下，`transition-*` 的默认值就是它）、`--plume-t-base` 220（位置、尺寸）、`--plume-t-reveal` 260（建议逐个展开，四分之一时长为 65ms 错峰间隔）、`--plume-t-slow` 340（新出现的东西）。
- 曲线按方向选：`ease-out` 出现、`ease-in` 离开、`ease-soft` 原地变化（默认）。
- 减少动态效果由全局一条规则统一处理，组件不用各自判断（见 [`styling.md`](./styling.md)）。

### 阴影

按用途选八档：`shadow-rest` 主输入框、`shadow-menu` 菜单浮层、`shadow-tip` 提示、`shadow-dialog` 对话框、`shadow-overlay` 图片上的浮条、`shadow-knob` 旋钮、`shadow-glass` 带内高光的半透明浮层、`shadow-toast` 提示条。深色的旋钮和玻璃阴影单独加深，深色的提示条只留一道贴边的影子；抽屉靠底色和线分层，不额外投影。

### 加 token、皮肤

- 加 token 四处一起改：theme.css 的 `:root`（深色需要时在 `@media` 里覆盖）、`@theme inline` 的映射、`@plume/contract/ui` 的 `SkinToken`、本页的表。动效时长和曲线不开放给皮肤，不加进 `SkinToken`；直接经 CSS 变量使用的时长不需要 Tailwind 映射。
- 皮肤插件经 `ui.skin` 覆盖 `--plume-*`，通常只改种子。`SkinToken` 是公开接口，只加不删。
- 用户在外观页挑的配色、UI 字体字号、代码主题与排版写在 `:root:root` 上，比 theme.css 和皮肤插件（`ui.skin`）写的 `:root` 都高一级：用户挑过的通常生效，没挑过的字段照常用皮肤或默认值。恢复默认删除对应覆盖，不把出厂配色写死到皮肤上方。代码主题原色表在 `packages/client/ui/src/lib/code/themes.ts`，只给代码区的 token 赋值。见 `apps/desktop/src/renderer/appearance-settings.ts`。
- 同时给出 `name`、`mode` 的数据皮肤管理界面配色：只暂时屏蔽用户的 bg/fg/accent/contrast 种子与深浅模式，外观页实时展示皮肤名及只读配色；字体、代码外观（包括代码底色）、背景图和其他偏好仍优先且可改。恢复默认也不清除被管理的原配色，停用后恢复。模式支持 system/light/dark；同时提供 name、mode 而不提供 token 时使用产品默认配色，system 随系统切换，不把默认配色复制成静态 12 色。深浅覆盖存在主进程内存，按渲染窗口 owner 释放，不写用户偏好。`ui.skin` 可重复更新或以 null 撤回自己，旧入口失效后不能复活；apply 中开启的 watch 以 `ui.effect` 收回。

## 检查点

- 没有新写色值、任意字号、任意圆角（`pnpm check:styles` 规则 2、3）。
- 新 token 在 `SkinToken` 里（规则 4）。
- 新的面或文字组合，浅深两种主题下对比度够（规则 8 只算 ink-muted、ink-faint 在五种面上，新组合要自己算）。

## 事实来源

- `packages/client/styles/src/theme.css`
- `packages/contract/src/ui.ts`（`SkinToken`、`Skin`）
- `apps/desktop/src/renderer/skins.ts`（CSSOM 皮肤叠栈）、`plugins.tsx`（界面入口生命周期）
- `scripts/check-styles.mjs`
