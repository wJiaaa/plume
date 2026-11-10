# 基础组件

管 `@plume/ui` 的组件和 `@plume/styles` 的类名组合：有哪些、什么时候用哪个、怎么加新的。两者经 import map 给插件用，是公开接口（见 [`safety.md`](../safety.md) 第 5 条）。`@plume/ui` 给插件用的范围是 [`packages/client/ui/plugin-api.json`](../../packages/client/ui/plugin-api.json) 列出的名字，插件引用名单外的会被 `pnpm check:plugins` 拦下；skill 里的组件参考 `skills/plume-plugin/references/components.md` 由名单和源码的签名、注释生成。

## 开发准则

### 有哪些

`@plume/ui` 分 primitives、inputs、overlay、scroll、row、layout、motion、avatar、image、hooks、lib、i18n 几个目录（terminal 不在本体，终端的配色和字体在插件仓库的 `plugins/terminal`），都从 `@plume/ui` 一个入口导出，图标从 `@plume/ui/icons`。各组件的用法以源文件开头的注释为准，这里只列常用的：

| 组件 | 用途 | 样式 |
|---|---|---|
| `Button` | 文字按钮，可带图标 | `@plume/styles` 的 `button` |
| `IconButton` | 只有图标的按钮：工具栏、行尾动作 | `iconButton` |
| `Input`、`Textarea` | 不带样式的原生控件，只加输入法守卫；要框加 `plume-field` 类 | `ui.css` 的 `.plume-field` |
| `TextArea` | 带描边外壳、自绘滚动条、两端渐隐的多行框 | `.plume-textarea-shell` |
| `Select`、`InlineSelect` | 下拉框，基于 `Popover` | `ui.css` |
| `TabStrip` | 可切换页签，方向键及 Home/End 导航；插件可复用 | `controls.css` |
| `Toggle`、`Segmented` | 布尔开关；一排互斥的选项，选中的那格下面垫一块滑过去的底 | Tailwind 类，圆点 `.plume-knob` |
| `Slider`、`ColorField` | 连续数值滑块、带十六进制编辑的色块；外观页与设计旋钮共用，滑块可指定宽度 | token 与用户选择的颜色 |
| `NumberField`、`TimeField` | 带步进按钮的数字框（敲到一半的草稿留着，规则在 `lib/number-draft.ts`）；时、分两个下拉挑时间 | `.plume-field.plume-number-field`、`InlineSelect` |
| `Popover`、`Menu*`、`ContextMenu`、`Dialog`、`Confirm`、`Tooltip` | 弹层、菜单、对话框、悬停提示 | `ui.css` |
| `Card` | 工具卡片的外框：标题、副标题、状态、正文 | `card` |
| `AgentAvatar`、`AvatarPile`、`assignAvatars` | 智能体头像、状态表情与叠放；按种类稳定分配，插件与产品共用 | `ui/motion.css` |
| `Collapse` | 展开、收起时保留内容直到尺寸过渡完成，支持减少动态效果 | `ui/motion.css` |
| `FlowRow` | 转录里的过程行：思考、一段工具活、压缩、送达和来信那一行，插件的工具卡片画成一行时也用它（建议新会话写到一半、开始以后） | `ui/flow.css` |
| `ApprovalFrame`、`ApprovalExpiry` | 审批卡的外框（收放的标题栏、类型小标签、倒计时、+N）和每秒走的「m:ss 后失效」；产品的通用审批卡、插件的提问卡共用外框，自己画外框的插件卡（计划、MCP 表单）只用倒计时 | Tailwind 类 |
| `Sideways` | 横向标签栏，普通鼠标滚轮横滚，触摸板保持原生方向；PR 账号标签复用 | `ui/scroll.css` |
| `CodeBlock`、`DiffView` | 工具输出、文件内容、改动对比 | `code` |
| `useAnnotator`、`AnnotateCanvas`、`AnnotateToolbar` | 图片标注：标记清单和撤销（hook）、画标记的画布、深色工具条；看图器和截图插件共用 | `ui.css` 的 `.plume-image-*`、`.plume-annotate-*`（压在图上，颜色不跟主题） |
| `useMovableBar`、`useToolbarPlacement`、`HANDLES` 等选区几何 | 标注工具条的落点和拖动：看图器里贴窗口底边、截图浮层里跟着选区；选区的手柄、移动、缩放 | 无 |
| `PageTopRow` | 自己画顶行的页面（`ui.page` 的 `topRow`）每一栏最上面那一行：顶行高、整行拖窗口、行里的控件不拖动、贴左边那一栏给红绿灯让位 | Tailwind 类，`ui/controls.css` 的 `.plume-top-row` |

只有类名组合、没有组件的：`text`（faint、error、link）、`fieldLabel`（标签在上、控件在下）、`actions`（理由在左、按钮在右的一行）、`textarea`（无框的多行框；主输入框不用它，是 `apps/desktop/src/renderer/composer/` 里的编辑器）。

悬停提示靠 `data-plume-tip` 属性，`main.tsx` 启动时调一次 `installTooltips()`。弹层只留在触发元素所在的那一列：正文是 `<main>`，面板列带 `plume-panel` 类。

不用这些组件、写原生 `<button>`、`<input>` 的只有这几种：

- 文字链接：一句话里或角落里的“新建”“设置”，用 `text.link`。
- 欢迎页的草稿建议：用页面内的原生按钮和 `.plume-draft-chip`，保持专用的半透明描边、图文渐亮与错峰入场，不覆盖通用 `Button` 的外观。
- 列表的行：侧栏会话、设置导航、供应商列表。整行可点，`rounded-field`，悬停和选中都是 `bg-card-hover`，按下 `active:bg-elevated`。
- 选择卡片和色块：外观页的主题缩略图、配色预设，是一排单选，用 `aria-pressed` 或 `aria-label` 说清楚。
- 控件里面的输入框：外观页色块里的十六进制，底色就是它编辑的颜色，不是一个单独的输入框。

### Button

- 外观五种：`primary` 一处只有一个，是要按的那个；`ghost`（默认）是平常的按钮，放在 primary 旁边；`subtle` 没有描边，用于一排动作；`soft` 有底没描边，用于 primary 旁边一排要一眼看出是按钮的选择；`danger` 用于破坏性操作，只在悬停时上色。
- 高度三档：`md` 32（默认，对话框和表单底部）、`sm` 26（面板里的行）、`xs` 20（跟在一行小字后面）。没有别的高度。`className` 只放布局，不改外观。
- 一组按钮的顺序：primary 在前，取消在后。
- 异步操作用 `loading`：变淡、不能再按、宽度不变。不要自己换成转圈或改文字。
- 一组选择里选中的那个用 `pressed`（只有 ghost、subtle 有样式），会带上 `aria-pressed`。
- 只有图标、没有文字时传 `label`（悬停提示兼无障碍名）；更常见的情况直接用 `IconButton`。
- 只透传 `data-*`，不透传其他 HTML 属性：展开状态用 `expanded`，会打开菜单用 `menu`。

### IconButton

- `label` 必填，同时作悬停提示和无障碍名；一列同样的按钮需要说清是哪一行时，用 `ariaLabel` 补充。
- 悬停提示走 `Tooltip`；禁用时默认不提示，提示正是禁用原因时传 `explainDisabled`。`onClick` 必填，展开状态用 `expanded`。
- 尺寸：`xs` 20、`sm` 22、`md` 26（默认），`composer` 跟主输入框的控件高度走；`badge` 画角上的计数。平时是 `ink-faint`，悬停才有底；`active` 是开着的开关，`emphasis` 是一排里现在值得按的那个；`tone="danger"` 悬停时变红。
- 不做成实心按钮：工具栏里长出 primary 就不再是工具栏。

### Input、Textarea、TextArea

- 都带输入法组字守卫：组字时的按键（选词的 Enter、取消候选的 Esc）不交给 `onKeyDown`，也不冒泡到外层快捷键。所以“Enter 发送”的处理里不用再判断 `isComposing`。
- `Input`、`Textarea` 不带样式：要输入框的样子就加 `plume-field`（另有 `plume-field-quiet`、`plume-field-compact`，`aria-invalid` 时红底），在对话框、弹层、设置卡片里会自动换成透明底加描边；其余类名只放布局。
- `TextArea`（大写 A）的 `onChange` 收字符串，高度写在 `shell` 上。

### 加新组件

- 先看 `@plume/ui` 里有没有能用的：有就用它的变体、尺寸、状态和 props，不另起一套。
- 产品里两处以上用到，或插件需要，才放进 `@plume/ui`；只有一处用的写在用的地方（比如设置页的 `settings/controls.tsx`）。
- 类名放 `@plume/styles`，组件只负责结构和行为；只用 token。
- 导出只加不改语义；改之前 `rg` 产品、插件仓库 `plugins/` 的全部引用。
- 新组件写进本页的表；插件要用的，名字加进 `plugin-api.json`。
- 改了名单里组件的签名或注释、改了 `@plume/styles` 的组合，跑 `node scripts/check-plugins.mjs --fix` 重新生成 skill 的组件参考，否则 `pnpm check` 不过。

## 检查点

- 没有新写的 `<button>`、`<input>`、`<textarea>` 能用组件而没用（上面列的几种除外）。
- 按钮高度只有 32、26、20 三种，图标按钮 26、22、20，输入框只有 34。按下不缩放。
- 只有图标的按钮都有无障碍名。
- 冒烟依赖的 `name`、`data-*` 属性和按钮文字没有变（见 `apps/desktop/src/main/smoke.ts`）。

## 事实来源

- `packages/client/ui/src/index.tsx`
- `packages/client/styles/src/index.ts`
- `apps/desktop/src/main/smoke.ts`
