---
name: plume-plugin
description: 写、改、排查 Plume 插件：工具、钩子（tool.execute、model.context、step.end、prompt.submit）、`/` 命令、工具卡片、面板、页面、皮肤、逻辑入口和界面入口之间的 serve / remote。新建或修改插件、判断一个需求能不能做成插件时使用。Use when writing, changing or debugging a Plume plugin.
---

# 写 Plume 插件

插件是一个目录，最多两个入口，都默认导出 `{ name, apply }`，`name` 相同：

- **逻辑入口** `src/index.ts` → `dist/index.mjs`：跑在 agent 进程（Node），`apply(ctx)` 里注册工具、往钩子里加层、开接口给界面。细节读 [references/logic.md](references/logic.md)。
- **界面入口** `src/ui.tsx` → `dist/ui.mjs`（可选）：跑在渲染进程（浏览器，没有 Node），`apply(ui)` 里注册卡片、面板、页面、皮肤。细节读 [references/ui.md](references/ui.md)，组件查 [references/components.md](references/components.md)，样式和文案读 [references/style-i18n.md](references/style-i18n.md)。

两个入口一起启用、一起停用。所有注册都记在插件名下，停用或 `apply` 抛错时整体撤销，插件不用自己清理注册。

## 只依赖公开接口

写插件只用这几样，不读、不引用宿主的实现代码：

| 能用的 | 用来做什么 |
| --- | --- |
| 本 skill | 怎么写、有哪些约束 |
| 插件 SDK `@plumeai/plugin-sdk` | 类型声明、`plume-plugin` 命令（新建、检查、构建、安装、开发）、tsconfig；下面这些模块名的类型都由它提供。随 Plume 应用发，独立项目经 `plume-plugin init` 链到这一份，不用 npm 装 |
| `@plume/contract`（逻辑入口）、`@plume/contract/ui`（界面入口） | 接口类型，以类型声明里的注释为准；只能 `import type` |
| `react`、`react/jsx-runtime`、`@plume/ui`、`@plume/styles` | 界面入口运行时和产品共用同一份实例 |
| `@plume/ui/icons` | 图标，打包进插件，只打用到的 |
| `node:*`、自己 `package.json` 里声明的第三方包 | 逻辑入口随便用；界面入口只能用浏览器能跑的 |
| 仓库里的插件（见文末） | 照着写 |

宿主运行时的一切从 `ctx` / `ui` 上拿。`@plume/ui` 只开放 components.md 里的名字，引用别的类型检查就失败；`plume-plugin check` 还会查 import、色值和 Tailwind 类、写死的中文（Plume 的两个仓库里是 `pnpm check:plugins`，同一套规则）。

## 先判断能不能做成插件

逻辑入口能做的（成员和钩子的全部说明在 logic.md）：

| 要做的事 | 用什么 |
| --- | --- |
| 给 agent 加工具 | `ctx.tools.register`；给模型的写进 `output`，给卡片的写进 `details`；带图给模型看用 `images` |
| 工具里跑 shell 命令 | `run.exec`：沙箱档由本体按权限模式定，要更宽一档经 `run.escalate` 申请（只认人答），照 `run.shell()` 的写法拼命令；不自己起进程 |
| 工具里读、写用户的文件 | `run.files`：本体守读写边界、记改动快照，人撤回时连文件一起退；可能改文件的命令带 `recordChanges` |
| 工具要问人放不放行，或要人给一份数据（提问、批准计划、填表） | `run.ask`；`run.request`（不是权限，完全访问也照问） |
| 工具答完后在后台接着做、送回结果，约会话过一会儿接着做，给另一个顶层会话寄信 | `run.background`、`run.track`、`run.schedule`、`run.letter`（除 `track` 外只有顶层会话有） |
| 在每次工具调用外面加一层：预先放行、拦截、改参数、改结果、整个接管 | 钩子 `tool.execute` |
| 一次操作要问人时先替人决定：放行、拒绝，或交给里层弹卡 | 钩子 `tool.approve`；完全访问、`approved`、「以后不再问」由本体放行、到不了这一层，提权只认人答 |
| 每一轮开始、人的消息写进会话前拦下它，或给模型补一段上下文 | 钩子 `prompt.submit` |
| 每次调模型前按段改系统提示词、裁剪消息、藏起工具（只影响这一次请求） | 钩子 `model.context` |
| 每一步收尾时让循环多做一步，或给结束换个原因 | 钩子 `step.end` |
| 换掉压缩的做法 | 钩子 `context.compact` |
| 给输入框的 `/` 菜单供命令 | `ctx.commands.provide` |
| 用默认模型做一次性的小调用、读花销、用生图模型出图 | `ctx.model`（`complete`、`usage`、`image`），图存进 `ctx.media` |
| 读会话、改标题、归档 | `ctx.sessions`（`list`、`messages`、`setTitle`、`setArchived`…） |
| 自己的子会话（侧边聊天、子 Agent），或页面上一直在的独立会话 | `ctx.sessions.create`，`send` / `start` / `wait` / `report` |
| 开一个新的顶层会话并发出第一句话；把会话接到 Plume 之外 | `ctx.sessions.launch`；带 `steward: true` 由你代管 |
| 列项目文件、在隔离视图里读 git、读写本体记下的改动 | `ctx.workspace`、`ctx.changes` |
| 加一种资源地址（`scheme://路径`） | `ctx.resources` |
| 跑长期的东西（子进程、定时器、文件）给自己的界面用 | `ctx.serve`（界面经 `ui.remote()` 调），清理登记 `ctx.effect` |
| 驱动面板里的网页（`<webview>`），或在临时沙箱里检查一页 | `ctx.pages` |
| HTTP(S) 请求走系统代理 | `ctx.fetch` |
| 插件之间提供、使用一组方法 | `ctx.provide` / `ctx.use` |

界面入口能做的（成员的全部说明在 ui.md）：

| 要做的事 | 用什么 |
| --- | --- |
| 工具在对话里的卡片，或只登记它在转录里的说法 | `ui.toolCard`、`ui.toolLine` |
| 给 `run.request` 画等人卡（审批卡只有产品那张） | `ui.requestCard` |
| 接管助手正文里某种语言的围栏代码块 | `ui.codeBlock` |
| 工作区加面板、侧栏加页面、设置页加一节 | `ui.panel`、`ui.page`、`ui.settingsSection` |
| 输入框周围：底下那排一格、上方项目签那一行一格、上方独占一行、灰字建议 | `ui.composerItem`、`ui.composerChip`、`ui.composerAbove`、`ui.composerHint` |
| 跟着会话的卡片、最新回复下面的卡片、回复操作排的按钮、环境卡片的一节 | `ui.conversationCard`、`ui.turnFooter`、`ui.replyAction`、`ui.environmentSection` |
| 画自己的子会话、独立会话 | `ui.Conversation`、`ui.useSession` |
| 复用产品的差异视图、文件预览、正文渲染、模型下拉 | `ui.FileDiff`、`ui.FilePreview`、`ui.Markdown`、`ui.ModelSelect` |
| 弹提示条、开关自己的面板、把字和图写进输入框 | `ui.notify`、`ui.openPanel`、`ui.draftInSession` |
| 换皮肤（只能改 token） | `ui.skin` |
| 截屏浮层、钉在桌面上的小窗口 | `ui.screen` |
| 侧栏记号、删除确认里的一句、网址和文件签的打开方式、划词菜单、排队消息的菜单…… | ui.md 的成员表 |

以人的名义做的事（以人的身份发送、停下一轮、归档、打开会话）只在人点了按钮时做，不在渲染、定时器里做；停下一轮用 `ui.ComposerSend` 的停止键（交给它 `sessionId`），卡片的 `send` 由宿主核对是真实点击。

插件做不到的：

- 替换模型调用或 agent 循环；换掉审批卡（本体只有一张）；改存下的模型回复（显示时拿掉标记用 `ui.replyText`）。
- 在没有用户停止操作时让本来要接着做的一轮停下（`step.end` 只能多做或给结束换原因）。
- 任意往会话里写东西或发起一轮。能写的只有：自己的子会话和独立会话、钩子的 `say` / `context`、后台结果（`report`、`run.background()` 的渠道）、`run.letter` 寄的信（标着来自哪个会话）、`launch` 开出来的新会话的第一句、代管会话里转的话，以及自己的子会话里经 `run.parent` / `handToParent` 排进它父会话的任务。不能往别的已有会话里发、不能指定任意父会话或冒充用户授权。
- 没人点按钮时替人发送；绕过公开草稿接口操纵输入框；新增钩子或界面扩展点。

**需求要用到做不到的能力时，停下来报告缺的是哪个能力、哪个插件需要它**，这是宿主的改动，不在插件里绕过（不改宿主代码、不碰宿主内部对象、不往页面上自己挂 DOM 冒充扩展点）。

## 流程

1. **定名字**：插件名小写加点分段（Plume 自己提供的插件都以 `plume.` 开头）；目录名只用小写字母、数字和连字符，它也是 `plume-plugin://` 的主机名。
2. **搭目录**：`plume-plugin init <目录>` 从模板生成，模板里是一个能跑的工具加卡片，改成自己的。命令在 `~/.plume/bin/plume-plugin`（Windows 的 cmd、PowerShell 里是同目录的 `plume-plugin.cmd`；Plume 启动过一次就有，用 Plume 自己的运行时跑，不用装 Node 和 npm）。Plume 的插件仓库（plume-plugins）里用 `pnpm plugin init plugins/<目录名>`。
3. **写逻辑入口**（logic.md），要画东西时**写界面入口**（ui.md、components.md），有界面或给人看的文字时照 style-i18n.md。
4. **构建和加载**：独立项目用 `plume-plugin dev`，插件仓库里用 `pnpm plugin dev plugins/<目录名>`：构建、装进 `~/.plume/local-plugins/<目录名>/`（和市场装的同名时这一份生效，不被市场更新换掉，卸掉就回到市场那份），之后一改源码就重新构建、装上；Plume 开着的话每次都当场加载，不用重启。只装一次用 `plume-plugin build` 再 `plume-plugin install`。
5. **自检**：对照下面的清单，再跑检查（独立项目 `plume-plugin check`：类型检查加插件规则；仓库里 `pnpm check`）。

## 目录骨架

`plume-plugin init <目录> [--name 插件名] [--display 市场里的名字]` 生成：

```
<目录名>/
├── package.json       # plume.displayName、plume.category 是「插件市场」里的名字和分类；仓库里还写 @plumeai/plugin-sdk 等开发依赖
├── tsconfig.json      # 继承 @plumeai/plugin-sdk/tsconfig.json
├── README.md          # 「插件市场」里的介绍：它做了什么、怎么用
├── images/            # 可选：README 引用的图片（相对路径 `images/xx.png`），随包分发
├── icon.png           # 可选：插件图标，市场、详情和设置页共用，随安装包分发
├── AGENTS.md、CLAUDE.md、.claude/skills/plume-plugin/   # 只有独立项目有：给接手的 agent
├── node_modules/      # 只有独立项目有：init 建的链接，指到随 Plume 发的 SDK；坏了跑 plume-plugin link
├── skills/            # 可选：随包的技能，`skills/<名字>/SKILL.md`；装了「技能」插件时进技能目录，和 dist/ 一起装
└── src/
    ├── index.ts       # 逻辑入口（必需）
    ├── ui.tsx         # 界面入口（可选）
    ├── messages.ts    # 给人看的文字，中英两份
    └── types.ts       # details 的类型和校验，两个入口共用
```

用 serve / remote 时再加 `src/api.ts`，放两个入口共用的接口类型；引入 `.css` 时加 `src/css.d.ts`（写法见 style-i18n.md）。

- `package.json` 的 `description`、`keywords`、`plume.displayName`、`plume.category` 填好，「插件市场」里显示它们。`plume.defaultPrompt` 可选，几句示例提问（字符串数组，最多显示四句）：插件装上并开着时，详情页「试试这样问」列出它们，点一句开新对话、写进输入框。
- README 里的图片：插件目录里的写相对路径（放在 `images/` 下，支持 PNG、JPEG、GIF、WebP、SVG，每张不超过 5 MiB），网上的写 https 地址；带深色版本的 `<picture>` 按窗口明暗选。
- 根目录的 `icon.png` 自动作为插件图标：正方形 PNG，建议 192×192，不超过 1 MiB；不提供或图片损坏时显示默认标记。
- `devDependencies` 只用于类型和打包：逻辑入口用到的第三方包全部打进 `dist/index.mjs`。
- `dependencies` 只放打不进去的原生模块（如 `node-pty`）：构建时连同实际安装的运行依赖、可选依赖和 peer 依赖一起复制进 `dist/node_modules`，只保留 Plume 发包的平台、架构（darwin、win32 的 arm64、x64，加上构建机）的包与预编译文件，随 `dist/` 一起装。复制出的 Mach-O、ELF 文件（如 node-pty 的 `spawn-helper`）由构建补上执行位，不用为此写 postinstall。

## 自检清单

- [ ] 两个入口的 `name` 相同，`satisfies Plugin` / `satisfies UiPlugin`。
- [ ] 只 `import type` `@plume/contract`；没有引用公开接口以外的东西。
- [ ] 工具结果里给模型的写进 `output`，给卡片的写进 `details`；卡片先校验 `details`，认不出就返回 `fallback`。
- [ ] 钩子的层：不需要处理的调用原样 `next(input)`；`order` 选得对（见 logic.md）；出错直接抛，不吞。
- [ ] 逻辑入口自己起的定时器、子进程、监听登记了 `ctx.effect`；界面入口在 apply 中启动的订阅、远端 watch 登记 `ui.effect` 清理（如 `ui.effect(() => call.cancel())`），停用、重载或 apply 失败时都会执行。
- [ ] 界面：没写 Tailwind 类；文字用 `Text`，组件只用 components.md 里列的；自己的 CSS 只管布局，颜色只取 `var(--plume-*)`；浅色、深色都能看。
- [ ] 给人看的文字中英两份；代码里发给模型的中文标了 `i18n-exempt`。
- [ ] `README.md` 写了它做什么、怎么用。
- [ ] 类型检查通过（仓库里 `pnpm check` 通过）；改了界面或行为的，装进 Plume 实际跑一遍。

## 可以照着写的插件

`todo`、`commands`、`web`、`skills`、`git`、`mcp`、`browser`、`side-chat`、`subagents`、`plan` 随应用发，在本体仓库的 `packages/builtin/` 下；其余在 Plume 插件仓库（plume-plugins）的 `plugins/` 下。拿不到仓库时，以模板和本 skill 里的代码片段为准。

| 插件 | 看它的什么 |
| --- | --- |
| `todo` | 工具的 details 让本体的转录认得（`category: "checklist"`，不注册卡片）；`step.end` 在本体的结论外面追问一句；工具结果带 `terminate`；`run.calls`；跟着会话的卡片（`ui.conversationCard`）按 `placement` 换外观、`stop` / `carryOn`；插件自带样式表；`messages.ts` |
| `terminal` | `ctx.serve` / `ui.remote()` 流式输出和取消；原生依赖；`ctx.effect`；多标签面板；点链接打开文件和网址；拖文件进来粘贴路径 |
| `scheduled` | `ctx.dataDir` 存数据；页面（`ui.page`）；常驻定时器按时 `ctx.sessions.launch`；`watch` 推状态、`ui.pageBadge` 挂数目、`ui.composerAbove` 说失败、`ui.openPage`、`ui.openSession` |
| `git` | 大一点的插件：子进程、`ctx.workspace.git`、`ctx.model.complete`；面板里多个视图、`.cancel()` 叫停远端调用；`ui.composerChip` 的 `send`；`ctx.provide` 提供服务 `session.worktree`；对话自己的工作树（`prompt.submit` 的 `cwd`、`ctx.sessions.onDeleted` / `onArchived`、`ui.sessionMark`、`ui.deleteNote`） |
| `memory` | `model.context` 按段插提示词、每个会话冻结一份；`ctx.model.complete` 在后台总结；设置分区画进「个性化」页、「智能体」页「会话」卡里一行（`ui.ModelSelect`） |
| `usage` | 设置 › 数据里的一页（`page: "nav"`、`group: "data"`）；`ctx.model.usage`；SVG 自己画的图表 |
| `screenshot` | `ui.screen`、`ui.screenOverlay`、`ui.pinnedShot`；标注组件；`ui.composerItem`；占导航一行的设置分区 |
| `commands` | `ctx.commands.provide`（每次现读磁盘）；设置分区经 `ui.remote()` 新建、打开、删除文件 |
| `hooks` | 六个钩子里的四个一起用（`tool.approve` 在 order 2000）；`observe: "all"` 和 `ctx.sessions.onEnded`；运行记录 `watch` 推变化、`ui.replyAction`、`ui.composerAbove`、`ui.openSettings`；`ui.useProjects` 切范围 |
| `im` | 不给 `page` 的设置分区（画进插件详情）；密钥经 `ctx.secrets` 存进 `ctx.dataDir`，界面只知道存没存 |
| `index` | `ctx.workspace.files`；按会话缓存、会话删掉时丢掉；设置分区里 `ui.useProjects` |
| `web` | 只读的工具（不弹审批卡）；API key 不经界面 |
| `mcp` | 运行中途增减工具；`run.ask`；`run.request` 带 `waiting` 和 `ui.requestCard`；大图放进 `shownImages`；`model.context` 藏工具换成搜索入口；前缀登记卡片；设置分区里的就地编辑、弹窗和 `Popover` 菜单 |
| `skills` | `model.context` 按磁盘现状加一段；`tool.execute` 按会话状态拒掉调用；`/` 菜单的 `displayText`；`ui.FileDiff` |
| `subagents` | `start` / `wait` / `report` 后台派发和回报，`steer` 插话；`model.context` 按会话换参数；`step.end` 的 `awaiting`；`ui.Conversation` 局部渲染；「智能体」整页（`page: "agents"`）、`ctx.tools.list()` 挑工具、`ui.ModelSelect` |
| `plan` | `ui.composerItem` 里的 `ComposerToggle`；`tool.execute` 设 `readOnly`；`run.request` 带 `waiting`、自己画卡；`context.compact` 接上批准的计划；`ui.toolLine`；`ui.environmentSection` |
| `browser` | `<webview>` + `ctx.pages`；面板 `keepAlive` + `detachable`；`ui.openPanel` 的 `tab` / `background`、`ui.closePanel`；工具结果带图；`ui.linkOpener`；随包的 `skills/` |
| `side-chat` | 面板里的多段子会话（`ui.Conversation` 带输入框）；`prompt.submit` 补上下文；`ctx.changes`；`/btw` 自己办掉（`handled`）；`ui.queueAction`；关标签前用 `Confirm` 问一句 |
| `image` | `ctx.model.image`、`ctx.media`；工具卡片边画边显示；`ui.mediaUrl`、`ui.openImage`、`ui.draftInSession`；画廊页经 `ui.remote()` 扫全部会话、`ui.revealToolCall` |
