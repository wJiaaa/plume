---
name: plume-plugin
description: 写、改、排查 Plume 插件：工具、钩子（tool.execute、model.context、step.end、prompt.submit）、`/` 命令、工具卡片、面板、页面、皮肤、逻辑入口和界面入口之间的 serve / remote。新建或修改插件、判断一个需求能不能做成插件时使用。Use when writing, changing or debugging a Plume plugin.
---

# 写 Plume 插件

插件是一个目录，最多两个入口，都默认导出 `{ name, apply }`，`name` 相同：

- **逻辑入口** `src/index.ts` → `dist/index.mjs`：跑在 agent 进程（Node），`apply(ctx)` 里注册工具、往钩子里加层、开接口给界面。
- **界面入口** `src/ui.tsx` → `dist/ui.mjs`（可选）：跑在渲染进程（浏览器，没有 Node），`apply(ui)` 里注册卡片、面板、页面、皮肤。

两个入口一起启用、一起停用。所有注册都记在插件名下，停用或 `apply` 抛错时整体撤销，插件不用自己清理注册。

## 只依赖公开接口

写插件只用这几样，不读、不引用宿主的实现代码：

| 能用的 | 用来做什么 |
| --- | --- |
| 本 skill | 怎么写、有哪些约束 |
| 插件 SDK `@plumeai/plugin-sdk` | 类型声明、`plume-plugin` 命令（新建、检查、构建、安装、开发）、tsconfig；下面这些模块名的类型都由它提供。随 Plume 应用发，不经 npm |
| `@plume/contract`（逻辑入口）、`@plume/contract/ui`（界面入口） | 接口类型，以类型声明里的注释为准；只能 `import type` |
| `react`、`react/jsx-runtime`、`@plume/ui`、`@plume/styles` | 界面入口运行时和产品共用同一份实例 |
| `@plume/ui/icons` | 图标，打包进插件，只打用到的 |
| `node:*`、自己 `package.json` 里声明的第三方包 | 逻辑入口随便用；界面入口只能用浏览器能跑的 |
| 仓库里的插件（见文末） | 照着写 |

宿主运行时的一切从 `ctx` / `ui` 上拿。SDK 的类型里只有上表这些：`@plume/ui` 只开放 [references/components.md](references/components.md) 里的名字，引用别的类型检查就失败；`plume-plugin check` 还会查 import、色值和 Tailwind 类、写死的中文（Plume 的两个仓库里是 `pnpm check:plugins`，同一套规则）。

## 先判断能不能做成插件

插件能做的：

- 给 agent 加工具（`ctx.tools.register`）。
- 在每次工具调用外面加一层（钩子 `tool.execute`）：预先放行、拦截、改参数、改结果、整个接管。
- 一次操作要问人时先替人决定（钩子 `tool.approve`）：放行、拒绝，或交给里层弹审批卡；完全访问、`approved`、「以后不再问」由本体放行、到不了这一层，提权只认人答（层只能拒绝）；要人给答案（提问、计划、表单）不是审批，用 `run.request`，不经这一层，帮我批准的风险规则是内置插件 plume.approval 在这一层做的。
- 在工具里跑 shell 命令（`run.exec`）：沙箱档由本体按权限模式定，要更宽的一档经 `run.escalate` 申请（本体弹提权卡、只认人答、批了才换档），`run.shell()` 告诉你照哪个 shell 写；不自己起进程、不自己选档。
- 给自己的工具画审批卡（`ui.approvalCard`）：卡片摆在哪、排队、撤卡归产品，卡上画什么、有哪些按钮归插件。
- 让一次工具调用停下来等人给一份数据（`run.request` + `ui.requestCard`）：提问、批准计划、填表；不是权限，完全访问也照问，和审批同一队、同一格。
- 每一轮开始、人的消息写进会话之前看一眼（钩子 `prompt.submit`）：拦下这条消息（弹一条原因），或者放行并在它后面给模型补一段上下文。
- 在每次调模型前改发出去的内容（钩子 `model.context`）：按段加、换、删系统提示词，裁剪消息，隐藏工具。只影响这一次请求，会话里存的不变。
- 每一步收尾时让循环多做一步、给结束换个原因（钩子 `step.end`）：以用户身份对模型说一句再接着做，或者以出错、卡住结束这一轮；截断续写、空回复催促、重复提醒和久未汇报的提醒是本体在最里层做的。清单插件经 `StepEnd.progress` 提供汇报判定与提醒文案，本体统一计数；外层可以改写或换掉自然结论，拦不下本来要跑的那一步。
- 人撤回或编辑重发、要截掉一段对话之前，答那段里自己记着的改动能不能退回，人选了就退回去（钩子 `session.rewind`）；截断是本体做的，文件的退回是内置插件 plume.delivery 在这一层做的。
- 给输入框的 `/` 菜单供命令（`ctx.commands.provide`）：列出命令，发送时把 `/名字 参数` 展开成要发的话。
- 工具卡片可读取 `argumentsText` / `streaming` 绘制安全的静态草稿，成功后经受用户操作校验的 `send(text, event)` 回到卡片所属会话；`ui.captureWindow(rect)` 只能截当前窗口可见区域。用法见 [references/ui.md](references/ui.md)。
- 在对话里画某个工具的卡片（动态工具名可用 `ui.toolCard` 的 `match: "prefix"`），或者只登记它在转录里的说法（`ui.toolLine`：「查找符号 runAgent」、和读文件归成一类）；在工作区加面板（标签按会话保留，按标签归属会话提供 `session` / `cwd`，子会话保留 owner 语义；不能用单例保存当前会话）；在侧栏加页面；在输入框底下那排加一格（左边，或右边模型选择前面）、上方项目签那一行加一格；加一张跟着会话的卡片（浮在转录右上角或在输入框正上方）；在设置页加一节；换皮肤（只能改 token，`mode` 支持 system/light/dark）；经 `ui.ChatBackgroundSettings` 复用产品的背景设置，选图和拖入图片均由宿主校验。
- 在最新结束的回复下面画卡片（`ui.turnFooter`），随转录滚走，新一轮开始就撤下；每一轮回复底下的操作排里加按钮（`ui.replyAction`）；复用产品的高亮差异（`ui.FileDiff`）、文件预览（`ui.FilePreview`）、统一只读文档预览（`ui.DocumentPreview`；经 `ui.documentViewer` 按扩展名注册，读取与权限仍由调用方负责）、文件右键菜单（`ui.useFileMenu`），经 `ui.openFile` 打开指定会话工作目录内的文件。
- 用 `ui.codeBlock(language, Component)` 接管助手正文的某种围栏代码块；解析、具体 UI、状态和使用说明都归插件，收到原文、会话/消息/块标识、流式与完成状态；可选 `copyText` 在复制回复时提供当前可见值的文字。解析失败返回 `fallback`；宿主在渲染失败或停用时回到源码。完整块里真实点击后可经 `send(text, event)` 回到所属会话，不能在渲染或计时器中发送。
- 用 `ui.mentions` 给 `@` 菜单提供当前目录可用的智能体或技能引用；选中只插入 token，不自动发送。页面角标 `ui.pageBadge` 可带 `attention: true` 同时进入通知菜单。
- 给输入框一句灰字建议，人按 Tab 填进去（`ui.composerHint`）；换掉欢迎页问候下面的那一行（`ui.welcomeLine`）；画回复前拿掉插件让模型顺带写的标记（`ui.replyText`，只改显示和复制）；改会话标题（`ctx.sessions.setTitle`）。
- 用设置里的生图模型画图、改图（`ctx.model.findImageModel`、`ctx.model.image`），图存进会话媒体目录（`ctx.media`）；界面入口显示（`ui.mediaUrl`）、用产品的看图器看和标注（`ui.openImage`），另存、复制（`ui.saveImage`、`ui.copyImage`），把图带回某个会话的输入框（`ui.draftInSession`），跳到某次工具调用的卡片（`ui.revealToolCall`）；媒体图可在文件面板打开或在系统文件管理器定位（`ui.openMediaFile`、`ui.revealMediaFile`，菜单名取 `ui.revealMediaLabel()`）。
- 侧栏会话行首空闲时画自己的记号（`ui.sessionMark`）；删除确认框里补一句会连带、会留下什么（`ui.deleteNote`）；人点了按钮时归档会话（`ctx.sessions.setArchived`）；模型照人的要求归档它所在的对话时，工具那次调用经 `run.archiveAfterTurn()` 交给本体，这一轮以完成收场后才归档（只有顶层会话有）。
- 弹提示条（界面入口 `ui.notify`，逻辑入口 `ctx.notice`）、打开、关闭自己的面板（`ui.openPanel`、`ui.closePanel`）、把一段话写进输入框等人自己发（`ui.draftInSession`，`replace` 时整段换掉），或在项目签那一行的格子里，人点了写明要发什么的按钮时以人的身份直接发（`send`）；逻辑入口用默认模型做一次性的小调用（`ctx.model.complete`）、读会话（`ctx.sessions`）、读模型调用的花销（`ctx.model.usage`）。一次性结果要覆盖持久化内容时用 `ModelCompletion.requireComplete` 拒收截断结果；经 `ctx.sessions.onContextReset` 在压缩、撤回或上下文来源变化时作废自己的缓存。
- 人点了明确的按钮时，经 `ui.openConversationDraft({ project?, cwd?, text })` 打开项目或目录的空白对话并准备草稿，保留已有草稿、不自动发送；经 `ui.openSettings(id)` 打开自己占导航一行（`page: "nav"`）的设置分区，经 `ui.openExternal(url)` 在系统浏览器打开不带凭据的 HTTP(S) 链接，经 `ui.openPath(path)` 把本机的文件用默认程序、文件夹用文件管理器打开（逻辑入口只交回路径，不自己起 `open` / `explorer.exe` / `xdg-open`）。
- 开一个新的顶层会话并发出第一句话（`ctx.sessions.launch`，定时任务到点了、人点了「在新会话里执行」）：它进侧栏、不归插件，人接着聊，插件之后碰不到它；`done` 是第一轮怎么结束的，`idle` 在它第一次真闲下来时兑现（后台运行都回来、登记的后台任务都结束（开发服务器也算）、约好的唤醒都到点送过、问出去的请求都有了答复、唤起的几轮也做完），`reportBack(text, delivery)` 把结果交回开出它的会话一次（`idle` 兑现时带着最后一轮的收场和最后一段回复，交回用它）；`spawnedFrom` 记着从哪个会话、哪次调用（`run.toolCallId`）开出来，要交回时那次调用得是你自己的工具在那个会话里的调用，不然 `reportBack` 抛错；人点了按钮时经 `ui.openSession(id)` 打开它。要把会话接到 Plume 之外（外面的人发消息、在外面答卡），开时带 `steward: true`：会话由你代管，之后经 `ctx.sessions.post` 往里转话、`ctx.sessions.respond` / `answer` 替人答卡，人随时能停止代管（见 references/logic.md「代管会话」）。页面那一行挂数目（`ui.pageBadge`），别处的按钮经 `ui.openPage(id)` 带人去自己的页面。
- 建自己的子会话并发送消息（`ctx.sessions.create` / `send`），或经 `start` / `wait` 在后台跑、经 `report` 把该次结果送给真实父会话；`steer` 在运行中插话，`onStopped` 撤销尚未启动的排队工作。停止父会话后后台结果不能再唤醒它。自己的子会话里，自己的工具那次调用拿得到父会话（`run.parent`：`enqueue` 排进它的队列、`stop` 停下、`carryOn` 接着做、`status`），工具卡片上人点的按钮经 `handToParent` 把一件事排进父会话；作用对象只有这个父会话，写进去的话标着来自你的插件（显示名）、不算人的授权。`models` 只给无密钥的模型目录，建子会话时可选模型和思考档位。
- 给自己的页面建一个一直在的助手：`ctx.sessions.create` 不给 `parentId` 就是插件的独立会话（不挂在任何会话下、不进侧栏，只有你能发），界面经 `ui.Conversation` 画它，审批卡就压在这个视图的输入框上方。
- 界面经 `ui.Conversation`、`ui.useSession` 复用转录与实时状态；可局部定制任务消息、去掉回报重复正文，操控输入框用 `mode: "steer"`。`ui.Markdown` 复用正文和文件链接；`ui.composerAbove` 在主输入框上方独占一行。经 `ui.quoteAction` 接主会话划词菜单，`ui.quoteInPanel` 把引用追加到自己的面板草稿；`composer.draftKey` 按标签保存文字、附件和引用。`/` 命令可以自己办掉、不发消息（`{ handled: true }`）。
- 界面经 `ui.onSessionsChanged` 订阅已保存消息、摘要和删除事件，刷新画廊等页面；经 `ui.ComposerSend` 复用发送／停止按钮，人真实点击停止时调用 `ui.stopSession`。终端插件经 `ui.terminalOpener` 承接文件树等入口的目录打开请求，经 `ui.terminalRunner` 承接代码块的「在终端运行」，经 `ui.findFile` / `ui.openFile` 打开输出里的路径、`ui.openLink` 打开网址、`ui.droppedPaths` 读拖进来的文件路径。
- 截屏：经 `ui.screen` 开盖住屏幕的浮层、注册全局快捷键，浮层和钉在桌面上的小窗口里画自己的组件。
- 在逻辑入口跑长期的东西（子进程、定时器、文件），经 `ctx.serve` / `ui.remote()` 给自己的界面用；HTTP(S) 请求可用 `ctx.fetch(url, init)` 继承系统代理，响应兼容标准 Fetch，禁止 URL 凭据、自动重定向和共享 cookie，插件停用自动取消。
- 画网页：界面入口在面板里放 `<webview>`，逻辑入口经 `ctx.pages` 驱动它（加载、读、点按、输入、截图、缩放、视口、应答对话框）；`ctx.pages.inspect(url, options)` 可在独立临时沙箱中检查页面，返回异常、控制台错误、高度和可选分段截图，不需要挂面板。面板设 `keepAlive`，标签在统一扁平常驻层，换会话、去设置页都不重挂，后台仍收到归属会话；`shown` 按是否正在显示所属会话的当前标签计算，`available` 按目录和有无会话分别计算、只控制新开列表，不卸载已有标签；设 `detachable`，弹出去的窗口里仍重新挂上。工具结果带图（`images`）给模型看；把字连同图片附件接进输入框（`ui.draftInSession`，不给会话就是眼前的输入框）；回复里的网址、文件签多一种打开方式（`ui.linkOpener`）；主输入框排队条上，排着的消息「更多」菜单里多一项、把这条拿到别处去发（`ui.queueAction`）。
- 工具答完以后在后台接着跑的事，结束或有新进展时经 `run.background()` 的渠道送回这个会话（`report`，闲时开一轮、忙时在步骤边界读入，人按停后作废；只有顶层会话有）。还在跑的任务经 `run.track` 登记进本体（会话闲没闲算上它，删会话、退出时本体经你给的 `stop` 停掉），约会话过一会儿接着做经 `run.schedule`（到点经渠道送你给的话）；别的插件经 `ctx.sessions.jobs` / `wakeups` 列出、停掉、取消。
- 会话之间递话：顶层会话里，工具那次调用经 `run.letter(to, letter)` 给另一个顶层会话寄一封信（请求、答复或通知，本体照实填发件方、在前面说明不是用户的话），回执的 `read` 告诉你读到没有；请求的答复由本体配对，收件方没答、没读到、删掉了时本体代答，你不用记账。`run.letter`、`run.parent` 只在这次调用里能用，调用答完再用就抛错。
- 读磁盘文件前可用 `file.read` 服务的 `authorize(run, path)`，与内置文件工具共用项目目录、符号链接和密钥审批规则，只授予读取；通过 `inject` 声明依赖，成功后使用返回的绝对路径。
- 把只为这次答案写的文件放进会话的临时目录（`run.scratchDir`，会话删掉时一起删）：太大不值得交给模型的图写在这里、`output` 给路径、图放进结果的 `shownImages` 只给人看；经服务 `resources` 加一种资源地址（`scheme://路径`，模型用 read、ls 读它），或把大块原文存成 `artifact://` 地址（`keepArtifact`）。

插件做不到的：替换模型调用或 agent 循环、换掉别的工具（本体的、别的插件的）的审批卡、改模型回复（存下的那份；显示时拿掉标记见 `ui.replyText`）、在没有用户停止操作时让本来要接着做的一轮停下（`step.end` 只能多做或给结束换原因，`ui.stopSession` 只接受真实点击）、任意往会话里写东西或发起一轮（只允许自己的子会话和独立会话、钩子 `say` / `context`、宿主校验过的后台运行结果 `report`、工具经 `run.background()` 送回本会话的后台结果、工具经 `run.letter` 寄给另一个顶层会话的信（标着来自哪个会话）、`launch` 开出来的新会话的第一句话，以及自己的子会话里经 `run.parent` / `handToParent` 排进它父会话的任务；不能往别的已有会话里发、不能指定任意父会话或冒充用户授权）、没人点按钮时替人发送、绕过公开草稿接口操纵输入框、新增钩子或界面扩展点。

**需求要用到做不到的能力时，停下来报告缺的是哪个能力、哪个插件需要它**，这是宿主的改动，不在插件里绕过（不改宿主代码、不碰宿主内部对象、不往页面上自己挂 DOM 冒充扩展点）。

## 流程

1. **定名字**：插件名小写加点分段（Plume 自己提供的插件都以 `plume.` 开头）；目录名只用小写字母、数字和连字符，它也是 `plume-plugin://` 的主机名。
2. **搭目录**：`plume-plugin init <目录>` 从模板生成。命令在 `~/.plume/bin/plume-plugin`（Windows 的 cmd、PowerShell 里是同目录的 `plume-plugin.cmd`；Plume 启动过一次就有，用 Plume 自己的运行时跑，不用装 Node 和 npm）；Plume 的插件仓库（plume-plugins）里用 `pnpm plugin init plugins/<目录名>`（见下面的骨架），模板里是一个能跑的工具加卡片，改成自己的。
3. **逻辑入口**：读 [references/logic.md](references/logic.md)。
4. **界面入口**（要画东西时）：读 [references/ui.md](references/ui.md)。
5. **样式和文案**（有界面或给人看的文字时）：读 [references/style-i18n.md](references/style-i18n.md)。
6. **构建和加载**：
   - 独立项目：`plume-plugin dev` 构建、装进 `~/.plume/local-plugins/<目录名>/`（和市场装的同名时这一份生效，不被市场更新换掉，卸掉就回到市场那份），之后一改源码就重新构建、装上；Plume 开着的话每次都当场加载，不用重启。只装一次用 `plume-plugin build` 再 `plume-plugin install`。
   - Plume 的插件仓库里（`plugins/<目录名>`）：`pnpm plugin dev plugins/<目录名>`，和独立项目一样构建、装进本机的 Plume。
7. **自检**：对照文末清单，再跑检查（独立项目 `plume-plugin check`：类型检查加插件规则；仓库里 `pnpm check`）。

## 目录骨架

`plume-plugin init <目录> [--name 插件名] [--display 市场里的名字]` 生成：

```
<目录名>/
├── package.json       # plume.displayName、plume.category 是「插件市场」里的名字和分类；仓库里还写 @plumeai/plugin-sdk 等开发依赖
├── tsconfig.json      # 继承 @plumeai/plugin-sdk/tsconfig.json
├── README.md          # 「插件市场」里的介绍：它做了什么、怎么用
├── images/           # 可选：README 引用的图片（相对路径 `images/xx.png`），随包分发
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

用 serve / remote 时再加 `src/api.ts`，放两个入口共用的接口类型。

- `package.json` 的 `description`、`keywords`、`plume.displayName`、`plume.category` 填好，「插件市场」里显示它们。
- `plume.defaultPrompt` 可选，几句示例提问（字符串数组，最多显示四句）：插件装上并开着时，详情页「试试这样问」列出它们，点一句开新对话、写进输入框。
- README 里的图片：插件目录里的写相对路径（放在 `images/` 下，支持 PNG、JPEG、GIF、WebP、SVG，每张不超过 5 MiB），网上的写 https 地址；带深色版本的 `<picture>` 按窗口明暗选。
- 根目录的 `icon.png` 会自动作为插件图标，不用配置；使用正方形 PNG，建议 192×192，文件不超过 1 MiB。不提供或图片损坏时显示默认标记。
- `devDependencies` 只用于类型和打包：逻辑入口用到的第三方包全部打进 `dist/index.mjs`。
- `dependencies` 只放打不进去的原生模块（如 `node-pty`）：构建时连同实际安装的运行依赖、可选依赖和 peer 依赖一起复制进 `dist/node_modules`，只保留 Plume 发包的平台、架构（darwin、win32 的 arm64、x64，加上构建机）的包与预编译文件，随 `dist/` 一起装。
- 引入 `.css` 时加一个 `src/css.d.ts`（写法见 style-i18n.md）。

## 自检清单

- [ ] 两个入口的 `name` 相同，`satisfies Plugin` / `satisfies UiPlugin`。
- [ ] 只 `import type` `@plume/contract`；没有引用公开接口以外的东西。
- [ ] 工具结果里给模型的写进 `output`，给卡片的写进 `details`；卡片先校验 `details`，认不出就返回 `fallback`。
- [ ] 钩子的层：不需要处理的调用原样 `next(input)`；`order` 选得对（见 logic.md）；出错直接抛，不吞。
- [ ] 逻辑入口自己起的定时器、子进程、监听登记了 `ctx.effect`；界面入口在 apply 中启动的订阅、远端 watch 登记 `ui.effect` 清理（如 `ui.effect(() => call.cancel())`），停用、重载或 apply 失败时都会执行。
- [ ] 界面：没写 Tailwind 类；文字用 `Text`，组件只用 [references/components.md](references/components.md) 里列的；自己的 CSS 只管布局，颜色只取 `var(--plume-*)`；浅色、深色都能看。
- [ ] 给人看的文字中英两份；发给模型的文字和日志标了 `i18n-exempt`。
- [ ] `README.md` 写了它做什么、怎么用。
- [ ] 类型检查通过（仓库里 `pnpm check` 通过）；改了界面或行为的，装进 Plume 实际跑一遍。

## 可以照着写的插件

都在 Plume 插件仓库（plume-plugins）的 `plugins/` 下，`todo`、`commands`、`web`、`skills`、`git`、`side-chat`、`subagents`、`plan` 随应用发、在本体仓库的 `packages/builtin/` 下（拿不到仓库时，以模板和本 skill 里的代码片段为准）：

| 插件 | 看它的什么 |
| --- | --- |
| `todo` | 注册工具、details 让本体的转录认得（不注册卡片，调用并进一段活）；`step.end` 在本体的结论外面追问一句、工具结果带 `terminate` 结束这一轮、`run.calls` 看同一步的其他调用；跟着会话的卡片（`ui.conversationCard`）从会话的消息里读最新一份、按 `placement` 换外观、按钮经 `stop` / `carryOn` 停下或接着做；插件自带样式表；`messages.ts` 的写法 |
| `terminal` | `ctx.serve` / `ui.remote()` 流式输出和取消、原生依赖、`ctx.effect`、多标签面板、插件自带样式表、点链接打开文件和网址、拖文件进来粘贴路径 |
| `scheduled` | `ctx.dataDir` 存数据、页面（`ui.page`）经 `ui.remote()` 读写；逻辑入口常驻定时器按时 `ctx.sessions.launch` 开新会话、等第一轮结束判失败；`watch` 推状态，界面入口一直连着、给页面挂数目（`ui.pageBadge`）、在输入框上方说失败（`ui.composerAbove`、`ui.openPage`），卡片上「打开上次会话」（`ui.openSession`） |
| `git` | 大一点的插件：逻辑入口跑子进程、`ctx.model.complete` 写提交说明；面板里多个视图、`ui.remote()` 的 `.cancel()` 叫停远端调用；项目签那一行加格子（`ui.composerChip`）、`ui.notify`、`ui.openPanel`、`ui.draftInSession`；diff 评论攒起来经 `ui.draftInSession` 的 `send` 交给面板所在的会话；几个样式表一起挂；`ctx.provide` 提供服务 `session.worktree`；对话自己的工作树：`prompt.submit` 的 `cwd` 在第一轮把会话挪进去，`ctx.sessions.onDeleted`、`onArchived` 收回、检出回来，项目签那一格的 `send`、`ui.sessionMark`、`ui.deleteNote`、设置分区 |
| `memory` | `model.context` 按段插提示词、每个会话冻结一份；按条件对模型藏起工具；`ctx.sessions` 读旧会话、`ctx.model.complete` 在后台定时总结；设置分区画进「个性化」页（`page`），「智能体」页「会话」那张卡里一行选总结用的模型（`ui.ModelSelect`） |
| `usage` | 设置 › 数据里的一页（`ui.settingsSection` 的 `page: "nav"` 加 `group: "data"`，页头介绍用 `detail`）；逻辑入口经 `ctx.model.usage` 读花销、`ctx.serve` 转给界面；SVG 自己画的堆叠柱状图（悬停气泡 fixed 定位）、环图（`stroke-dasharray` 分段）、热力图和色点，插件自带的模型品牌标 |
| `screenshot` | 截屏浮层（`ui.screen`、`ui.screenOverlay`、`ui.pinnedShot`）、标注组件、输入框按钮（`ui.composerItem`）、占导航一行的设置分区（`ui.settingsSection` 的 `page: "nav"`）、逻辑入口跑子进程 |
| `commands` | `ctx.commands.provide` 供 `/` 命令（每次现读磁盘）；设置分区经 `ui.remote()` 新建、打开、删除文件 |
| `hooks` | 四个钩子一起用：`prompt.submit` 拦消息、补上下文，`tool.execute` 预先放行、要确认（`input.ask`）、改参数、接结果，`tool.approve`（order 2000）替人答审批，`step.end` 让它接着干；`ctx.sessions.observe` 的 `turnEnd`（默认导出写 `observe: "all"`，看每个会话）和 `ctx.sessions.onEnded` 接一轮失败、会话结束；逻辑入口跑子进程，项目钩子读 `.plume/config.json` 的 `hooks`、按内容指纹信任；运行记录存在 `ctx.dataDir`、`watch` 推变化，`ui.replyAction` 在回复底下看、`ui.composerAbove` 提示待审核、`ui.openSettings` 去设置分区；设置分区里 `ui.useProjects` 切范围、表单弹窗 |
| `im` | 不给 `page` 的设置分区：画进插件详情的「设置」一节，不占设置导航；密钥经 `ui.remote()` 交给逻辑入口存进 `ctx.dataDir`，界面只知道存没存 |
| `index` | `inject` 服务 `project.files` 列项目文件；按会话缓存工具要用的数据、会话删掉时丢掉；设置分区用 `ui.useProjects` 列项目、经 `ui.remote()` 看状态、触发重建 |
| `web` | 只读的工具（不弹审批卡）、`ctx.dataDir` 存 API key、key 不经界面（界面只知道填没填） |
| `mcp` | 运行中途增减工具：`ctx.tools.register` 返回的函数撤下单个工具；逻辑入口连外部服务、调用前 `run.ask`；大图存进 `ctx.media`、放进结果的 `shownImages` 由通用卡片画；服务要人填表时 `run.request` 带一句 `waiting`、卡片经 `ui.requestCard` 按 `kind` 登记；`model.context` 按估算的大小藏起工具、换成搜索入口；`ctx.sessions.onDeleted` 关按会话起的连接；`ctx.dataDir` 存配置和令牌，密钥不经界面；设置分区里的卡片（就地编辑、失焦保存）、弹窗和 `Popover` 菜单 |
| `skills` | `model.context` 按磁盘现状加一段、没东西时藏起自己的工具；`tool.execute` 的一层按会话状态拒掉调用；`prompt.submit` 的 `context` 给模型补一句；`ctx.commands.provide` 把技能放进 `/` 菜单、`displayText` 只给人看；设置分区里用 `ui.FileDiff` 画差异 |
| `subagents` | `start` / `wait` / `report` 后台派发和回报，按原子会话续跑，`steer` 插话；一个工具名、参数按会话换（`model.context` 改 `yield` 的参数为定义的输出结构），结果带 `terminate` 收尾，`step.end`（order -20）在父会话里有子代理没回来时经 `awaiting` 告诉里层别逼它交结论、每 4 次带工具的请求提醒一次在等谁，在子会话里每 60 步一个检查点，读子会话里最新的 `todo_write` 结果决定接着跑、`say` 一句让它列清单或讨交接（`stepsLeft` 只剩两步时也讨），讨交接的两步 `tool.execute` 拒掉别的工具、第二步的结果带 `terminate`；插件管理种类、名额和排队，停止监听清队列（子会话那一段跑完时由本体停掉它起的后台任务）；`composerAbove`、任务卡和回报卡，`ui.Conversation` 局部渲染与附件操控；「智能体」整页（`page: "agents"`）：读写定义文件、`ui.useProjects` 切范围、`ctx.tools.names` 挑工具、`ui.ModelSelect` 选模型、插件自己的选脸弹层 |
| `plan` | 按会话记的开关（`ui.composerItem` 里的 `ComposerToggle`、`/plan`，新对话的开关经 `prompt.submit` 交给建出来的会话）；`tool.execute` 每次调用设 `readOnly`（带拒绝时给模型的话，写、改文件的工具由本体拒绝）；工具经 `run.request` 带 `waiting`（「等你批准计划」）等人拍板，自己画卡（`ui.requestCard`），附言随回答一起交回；面板里划线评论（CSS Custom Highlight）；`context.compact` 往摘要后面接上批准的计划；`model.context` 加一段、`step.end` 提醒一次；`submit_plan` 经 `ui.toolLine` 在转录里读成一行，环境卡片里一节（`ui.environmentSection`）列出批准过的计划、点了打开面板，面板从会话消息里读 |
| `browser` | 网页：界面入口画 `<webview>`、挂上后把 id 交给逻辑入口，逻辑入口经 `ctx.pages` 驱动；面板 `keepAlive` + `detachable`，只给最近看过的几个会话挂页面、agent 要用时叫醒；逻辑入口经 `watch` 推来「开、关哪个标签」，界面用 `ui.openPanel` 的 `tab` / `background` 和 `ui.closePanel` 的 `tab` 照办；`browser_screenshot` 的结果带图；选取卡经 `ui.draftInSession` 带上截图；`ui.linkOpener` 接回复里的网址和 `.html`；逻辑入口起本机小服务开本地 `.html`；工具在调用期间接管页面的对话框；`ctx.dataDir` 存设置和书签；随包的 `skills/` |
| `side-chat` | 面板里的多段子会话，`ui.Conversation` 带输入框；`prompt.submit` 给每一问附上主会话的增量，主会话的下一问附上侧边聊天改过的文件（`inject: ["file.changes"]` 认工具结果上的改动记录）；`/btw` 自己办掉（`handled`、`openPanel`）；排队消息的「在侧边聊天中打开」（`ui.queueAction`）；关标签前用 `Confirm` 问一句；「会话」卡里一行选新侧边聊天的模型（`page: "session-models"`） |
| `image` | 用设置里的生图模型出图（`ctx.model.image`），图存进媒体目录（`ctx.media`）；工具卡片经进度推 JSON 行、边画边显示，`ui.mediaUrl` 显示、`ui.openImage` 看图和标注、`ui.draftInSession` 把图带回会话；`model.context` 没有生图模型时藏起工具；画廊页（`ui.page`）经 `ui.remote()` 扫全部会话、`ui.revealToolCall` 跳回那次调用 |
