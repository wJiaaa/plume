# 界面入口

跑在渲染进程（沙箱化的浏览器环境，没有 Node），和产品共用同一份 React。类型从 `@plume/contract/ui` 来。

```tsx
import type { UiPlugin } from "@plume/contract/ui";

export default {
	name: "example.my-thing", // 和逻辑入口相同
	apply(ui) {
		// 在这里注册。界面入口加载失败只记日志，对应的卡片退回通用卡片。
	},
} satisfies UiPlugin;
```

界面入口的数据只有两个来源：

- **会话里的**：工具结果的 `details`（卡片的 `result.details`），以及面板、页面拿到的 `session`（只读视图：面板是标签归属会话，页面是当前会话；`summary` 里有 `id`、`title`、`cwd`、`running` 等，`messages` 是全部消息）。
- **逻辑入口开的**：`ui.remote()`（见下）。

## ui

| 成员 | 用途 |
| --- | --- |
| `ui.name` | 插件名 |
| `ui.openSession(id)` | 用户点击后打开已有会话，和点侧栏那一行一样，不自动发送；没有的会话抛错 |
| `ui.codeBlock(language, Component, { order, copyText })` | 按语言接管助手正文的围栏块，失败或停用显示源码，详见下文 |
| `ui.toolCard(tool, Component, { order, match, inline })` | 给工具注册工具卡片；`match: "prefix"` 按工具名前缀匹配动态工具族；`inline: true` 时调用照常并进一段活，传函数 `(args, argumentsText) => boolean` 时逐次判断 |
| `ui.approvalCard(tool, Component, { order, match })` | 给自己的工具画审批卡；`match: "kind"` 按 `request.kind` 认（旧写法） |
| `ui.requestCard(kind, Component, { order })` | 给 `run.request` 画等人给数据的卡（问题、计划、表单），按 `request.kind` 认 |
| `ui.toolLine(tool, { verb, subject, like, group, times, callOnly, icon })` | 转录里怎么说自己的工具：行上的动作和对象、归哪一类、怎么数、图标；画法还是通用卡片 |
| `ui.panel(id, Component, options)` | 往面板区加一个面板 |
| `ui.page(id, Component, options)` | 往侧栏加一个页面 |
| `ui.skin({ name?, mode?, light, dark })` / `ui.skin(null)` | 更新皮肤或撤下自己的皮肤；name 与 mode 都提供时管理配色和深浅模式 |
| `ui.useTheme()` / `ui.setTheme(theme)` | 读、改应用的主题偏好（设置 › 外观的跟随系统、浅色、深色），见「皮肤」 |
| `ui.ChatBackgroundSettings` | 自包含的背景设置组件，可传 `title`；管理全局的图片、显示位置、铺满／平铺、效果、浓淡，以及整个窗口的磨砂质感（外圈、停靠侧栏和对话区一起，不看皮肤、不要图；外观页不再有背景设置），支持选图和拖入图片，不向插件暴露磁盘路径 |
| `ui.onSessionsChanged(listener)` | 订阅所有会话的已保存消息、摘要和删除变化，包含当前未打开的会话；返回取消订阅函数，组件 effect 结束时调用，插件停用时也会撤下。事件 `SessionChange` 的字段见下文 |
| `ui.effect(dispose)` | 界面入口的生命周期清理，停用、重载或 apply 失败时逆序执行 |
| `ui.composerItem(id, Component, { side, order })` | 输入框底下那排控件加一格：左边，或右边模型选择前面（右边的也画进 `ui.Conversation` 的输入框） |
| `ui.composerChip(id, Component, { side, order })` | 输入框上方、项目签那一行加一格 |
| `ui.composerAbove(id, Component, { order })` | 主输入框上方独占一行，收到 `{ session }`；返回 null 不占位，组件自己管理展开退场，不会浮到转录侧面 |
| `ui.conversationCard(id, Component, { order, lane })` | 跟着会话的一张卡片：对话列够宽时浮在转录右上角，不够时在输入框正上方；`lane: true` 的占右边一列（够宽停靠、不够浮在转录上，从不到输入框上方，太长自己滚） |
| `ui.environmentSection(id, Component, { label, order, attention? })` | 往会话的环境卡片（`plume.diagnostics` 画）里加一节，收到 `{ session }`；返回 null 不占位、不画分隔线；`label` 是卡片「显示哪些内容」菜单里的名字；`attention(session)` 是 hook，有事等人决定时返回一句话，卡片收着时开关上挂圆点 |
| `ui.mentions(provider)` | 每次打开 `@` 时传 `{ cwd?, sessionId? }`，返回 `ComposerMention[]` 或 Promise：`id/title/kind/token` 必填，kind 是 subagent 或 plugin，可带 description/origin/avatar；只插入 token，用户自行发送，停用自动撤销 |
| `ui.composerHint(session => text)` | 输入框空着时的灰字建议，按 Tab 填进去 |
| `ui.welcomeLine(locale => ({ text, source }))` | 换掉欢迎页问候下面的那一行（默认问要在哪个项目里做什么），只问最后注册的那一个 |
| `ui.replyText(text => text)` | 画回复正文、复制回复前过一遍，拿掉插件让模型顺带写的标记 |
| `ui.sessionMark(Component)` | 侧栏会话行首空闲时的记号，收到 `{ session, fallback }`，不是自己的会话返回 `fallback` |
| `ui.deleteNote((sessionId, locale) => text)` | 删除确认框里补一句：删掉这个会话会连带什么、会留下什么 |
| `ui.notify(message, level)` | 窗口顶上弹一条提示，过一会儿自己消失 |
| `ui.openPanel(id, sessionId?, { tab, background }?)` | 打开自己注册的面板；指定会话时不因异步期间切换会话而串到别处；能开好几个的面板给 `tab` 开指定的那个标签，`background` 只加标签不切过去 |
| `ui.closePanel(id, sessionId?, tab?)` | 关闭自己在该会话打开的面板，仍经过 `onClose`；给了 `tab` 只关那一个标签 |
| `ui.turnFooter(id, Component, { order })` | 最新结束的回复下面挂组件，收到 `{ session, timestamp }`；随转录滚动，运行中、新问未答和翻看旧窗口时不挂 |
| `ui.replyAction(id, Component, { order })` | 每一轮收尾那条回复底下的操作排（时间、复制、分叉）里加一个按钮，排在复制和分叉之间，收到 `{ sessionId, from, to }`：`from` 是这一轮开口那条消息的位置，`to` 是收尾回复的位置加一，插件按自己记下的消息位置挑出归这一轮的东西。悬停才显出来、行高 24，按钮不高过 `IconButton` 默认尺寸，点开的东西用 `Popover`；返回 null 不占位（`plume.hooks` 的运行记录） |
| `ui.terminalOpener(open)` | 为文件树等入口登记“在终端中打开”：人点击后调用 `open(directory, sessionId)`，目录和归属会话由宿主提供。一个插件保留一个处理器，最新登记的优先；停用后恢复前一个，没有处理器时宿主提示安装并启用终端插件，执行失败弹提示条 |
| `ui.terminalRunner(run)` | 为回复里 shell 代码块（`bash`、`sh`、`zsh`、`shell`、`console`、`terminal`）的「在终端运行」登记处理器：人点击后调用 `run(command, sessionId)`，命令已去掉 `$ ` / `> ` 提示符和注释行，要带回车原样执行；登记规则和没有处理器时的提示同 `ui.terminalOpener` |
| `ui.openFile(path, sessionId)` | 在指定会话的文件面板打开文件；读取仍受会话目录边界约束，只有这个会话最近一次请求的「记忆文件」（`PromptSection.files` 标的来源）在边界外也能只读打开 |
| `ui.findFile(path, sessionId)` | 纯文字里印出来的路径（终端输出）指的那个文件，返回绝对路径：绝对路径看在不在，相对路径先按会话目录拼、再按结尾找唯一的一个；不存在、不止一个、文件夹、边界外都是 `null`，答出来的 `ui.openFile` 打得开 |
| `ui.droppedPaths(transfer)` | 拖放带着的本机绝对路径（访达的文件、文件面板的行），不带路径是 `null`；在 `drop` 里同步调，`dragover` 时只答空数组 |
| `ui.useFileMenu(root)` | 组件内调用的 hook，返回 `{ open, onContextMenu(event, { path, onOpen }), element }`；复用打开方式、在访达中显示和复制路径菜单 |
| `ui.FileDiff` | `{ hunks, path?, showPath?, maxLines? }`，按文件语言高亮的差异视图，行号和横向滚动复用产品实现 |
| `ui.FilePreview` | `{ sessionId, path, contents }`，文件标题栏和只读预览；`contents` 是插件经 remote 读取的 `FileContents`，不授予额外文件读取权限 |
| `ui.documentViewer(extensions, Component)` | 注册只读文档预览，扩展名小写且不带点；同扩展名后注册的生效，停用后恢复前一个 |
| `ui.DocumentPreview` | `{ name, identity, readBytes(signal), fallback? }`，文件面板和插件共用的文档展示；调用方负责读取与权限校验，只交数据、不交磁盘路径，identity 随文件版本改变；无匹配或渲染失败回到 fallback |
| `ui.quoteAction({ label, run })` | 在主会话划词菜单加一项，人点击后调用 `run(quote, sessionId)`；一个插件保留一项，重复登记替换前一项，停用时撤下 |
| `ui.quoteInPanel(panelId, sessionId, quote)` | 把划词引用追加到本插件面板的输入框；复用该会话当前可见标签，否则新开一个，保留已有草稿、不自动发送。面板须将 `PanelProps.tab` 传给 `composer.draftKey` |
| `ui.draftInSession(sessionId \| undefined, { text, images?, send?, replace? })` | 把字和图片（base64；`from` 记着它是媒体目录里哪张图的标注副本）接在草稿后面，`replace` 时换掉整段草稿；给了 `sessionId` 先打开那个会话，不给就是眼前的输入框（当前对话或新对话）。`send` 且人刚点过（用户激活还在）、输入框原本是空的时直接发出去（如 Git 面板的「发给 Agent」），没人点时只放进草稿。弹出的面板窗口里只能交给面板来源的会话（转交主窗口），会话不在了抛错 |
| `ui.revealToolCall(sessionId, toolCallId)` | 打开会话，转录滚到那次调用的工具卡片放在中间，外层带一下 `data-plume-flash`（插件的样式按它闪）；只在主窗口里能用 |
| `ui.openMediaFile(name, sessionId)` | 在指定会话的文件面板打开媒体目录中的图片；传 `ctx.media.save` 返回的媒体名，不传磁盘路径；独立窗口会把打开请求交给主窗口对应会话 |
| `ui.revealMediaFile(name)` / `ui.revealMediaLabel()` | 在系统文件管理器中定位该媒体文件；菜单文字用 `revealMediaLabel()`，随系统和语言取正确名称。宿主校验媒体名及真实路径，不开放任意磁盘路径 |
| `ui.mediaUrl(name, thumb?)` | 会话媒体目录里一张图（`ImageContent.media`、`ctx.media.save` 交回的名字）给 `<img src>` 的地址；名字不对是空串。给 `thumb`（像素）时是长边缩到这么长的缩略图（宿主算一次存在盘上，原图不比它大时就是原图；GIF 不缩），格子、列表里用它，看图、另存、复制用不带 `thumb` 的原图 |
| `ui.openImage(images, index, { from?, edit? })` | 用产品的看图器看几张图：从 `from` 元素飞出、关上飞回；`edit` 打开就进标注，标注完交给那张图的 `onAttach(dataUrl)` |
| `ui.captureWindow({ x, y, width, height })` | 截取当前插件界面所在窗口的可见矩形，单位 CSS 像素、整数，返回 PNG data URL；临时隐藏浮动导航、通知与提示；只能截本窗口，不能越界或读取别的窗口 |
| `ui.saveImage(src)` / `ui.copyImage(src)` | 和看图器的「另存为」「复制」一样：存一份到磁盘、放进剪贴板（转 PNG，剪贴板不接时退回存文件）；`src` 是 `data:` 或 `mediaUrl` |
| `ui.linkOpener({ label, icon?, web?, takesClicks?, file?, open })` | 回复里的网址、文件签多一种打开方式（内置浏览器），见下文 |
| `ui.queueAction({ label, icon?, run })` | 主输入框排队条上，每条排着的消息「更多」菜单里多一项（在侧边聊天中打开），见下文 |
| `ui.openConversationDraft({ project?, cwd?, text })` | 人点击明确的按钮后，打开已登记项目或绝对目录的空白对话，把 text 追加在目标已有草稿后；不发送、不落会话记录。project 与 cwd 二选一，目录由逻辑入口准备，失败不改变当前页面 |
| `ui.openSettings(id)` | 打开本插件注册的、单独占导航一行（`page: "nav"`）的设置分区；不能跳到别的插件或未登记分区 |
| `ui.openPage(id)` | 人点了按钮时打开本插件注册的页面（输入框上方提示里的「查看」）；不能开别的插件的页面 |
| `ui.pageBadge(id, { count, label } \| null)` | 侧栏去处里本插件那一页的那一行右端挂一个数（没人看见的失败），`label` 给读屏和悬停提示；`null` 或 0 拿掉，人正在那一页上时不画，停用时一起拿掉 |
| `ui.openExternal(url)` | 用户点击后在系统浏览器打开 HTTP(S) 链接，不接受带凭据的网址或其他协议 |
| `ui.openLink(url, sessionId)` | 用户点击后像回复里的网址那样打开：有插件接手点击（`takesClicks`，内置浏览器）时开在它那里，否则系统浏览器；限制同 `ui.openExternal` |
| `ui.settingsSection(id, Component, options)` | 加一节设置：默认画进本插件详情的「设置」一节；`page: "nav"` 时单独占设置导航一行（`group` 选「Agent 能力」「数据」「代码与版本控制」组），给别的 `page` 时画进产品的那一页（「个性化」「智能体」，或「智能体」里「会话」那张卡的一行，或「插件市场」的「技能」「连接器」两类），见下文 |
| `ui.ModelSelect` | 产品的模型下拉：`{ value, onChange(modelId), ariaLabel, inheritLabel, inheritDetail?, inheritedModelId?, inheritedSource?, disabled?, compact? }`；`value` 为空串是「跟随」，菜单顶上那一项就是它，选了 `onChange("")`；`compact` 只剩一枚箭头，贴在它管的按钮旁边当分体按钮（计划卡的「在新会话里执行」），选了什么由那颗按钮自己说 |
| `ui.ModelControls` | 输入框右下角那两枚（模型、思考档位），样子和菜单都和输入框里的一样：`{ model, thinking?, onModelChange(modelId), onThinkingChange(level), disabled? }`；`model` 为空串、`thinking` 不给时显示默认模型和默认推理强度。不改哪个会话，只把选择交出来，给开新会话前先选好怎么跑的地方用（建议新会话的卡片），选的再交给 `ctx.sessions.launch` |
| `ui.useModelDefaults()` | React hook：`{ defaultModel?, sessionModel?, thinking }`——新会话的默认模型、当前会话的模型、默认思考档位，「跟随」时写哪个模型名用它 |
| `ui.useProjects()` | React hook：侧栏里的项目 `{ id, name, path }[]`，随增删更新；几个项目可能登记在同一个目录上 |
| `ui.usePluginDisplayName()` | React hook：返回 `(plugin) => string \| undefined`，按插件名（`owner`、`fromPlugin` 里的那种）查人看到的显示名，和侧栏会话卡片、「来自…」同一份；停用、卸载了或还没读到时是 undefined，退回一个通用的词，不把 `plume.xxx` 这种插件名画给人 |
| `ui.screen` | 截屏的宿主能力：开截图浮层、全局快捷键、选文件夹 |
| `ui.screenOverlay(Component)` | 截图浮层里画的组件 |
| `ui.pinnedShot(Component)` | 钉在桌面上的截图窗口里画的组件 |
| `ui.stopSession(sessionId, event)` | 人点击停止按钮时停止明确指定的会话，各窗口均可用；须在真实 React click 回调内同步调用，不能先 await、伪造事件或重复使用事件，插件须仍启用 |
| `ui.ComposerSend` | 产品的发送／停止按钮，收到 `{ running, disabled?, tip?, onSend, onStop }`；签名与使用见下文。经 `ui` 使用，不从 `@plume/ui` 导入 |
| `ui.useSession(sessionId)` | React hook：一个会话的视图（摘要、消息、草稿、进度、审批），随它的事件更新；还没读到是 undefined |
| `ui.useSessionActivity(sessionId)` | React hook：侧栏行首给这个会话的记号：`"waiting"`（它或子会话在等批准）、`"done"`、`"failed"`（人没看着时跑完、没跑完，人打开看过就清掉），没有记号是 undefined；只在内存里，重开应用都算看过。卡片上要「看过就不再提」时用它 |
| `ui.contextBreakdown(sessionId)` | 这个会话的上下文窗口按段拆开：对话消息、工具、MCP 工具、技能目录、系统提示词、项目指令、记忆（`segments` 的 key 是 `memory`）各多少 token（按最近一次请求估，有服务商的总数时按比例缩放到它），`memoryFiles` 是项目指令和记忆按文件的来源（`{ path, tokens }[]`，插件经段的 `files` 标的）；本次启动后还没发过请求是 null。每次现算，要看时再调 |
| `ui.listCommands({ cwd? })` | 输入框 `/` 菜单此刻有的命令（`ListedCommand[]`：`SlashCommand` 加 `plugin`），同名去重后的样子：产品自己的 `/clear`（没有 `plugin`）在前，再是各插件经 `ctx.commands` 供的；`cwd` 决定项目里的命令文件、技能列不列。只读，展开、发送仍走输入框；每次现问，要看时再调。命令设置页靠它列「内置」那一段（没有 `source` 的） |
| `ui.Conversation` | 产品的对话视图组件：画一个会话（插件自己的子会话、独立会话），可选底下一个输入框 |
| `ui.Markdown` | `{ text, sessionId?, streaming?, className?, inline? }`，复用产品正文渲染；指定 sessionId 时文件签按该会话解析，不指定时继承所在转录。`inline` 只画一句话里的行内记号（代码、加粗、强调、删除线），包在一个带 `className` 的 `span` 里，链接和图片只留字；代码和加粗的样子由宿主定（卡片底色、正文色、等宽代码字号），不跟着正文的代码外观设置走 |
| `ui.remote<T>()` | 调自己逻辑入口经 `ctx.serve` 开的对象 |

## 会话变化与停止按钮

`SessionChange` 是 `{ sessionId, type: "messages" | "summary" | "deleted", tools?: string[] }`。`messages` 在消息保存或撤回后通知；工具结果带 `tools: [toolName]`，其他消息不带。`summary` 通知运行状态等摘要变化，`deleted` 通知删除。监听只用于刷新界面数据，不是模型流式增量；通过 `ui.useSession` 或自己的 remote 重新读取所需内容。订阅例子：

```tsx
useEffect(() => ui.onSessionsChanged((event) => {
	if (event.type === "deleted" || event.tools?.includes("image_generate")) void refresh();
}), [refresh]);
```

`ui.ComposerSend` 的 `running` 决定显示发送还是停止；`disabled` 只禁用发送，运行中始终保留停止入口，`tip` 只覆盖发送时的提示。`onStop` 收到 `React.MouseEvent<HTMLButtonElement>`，将同一个事件交给 `ui.stopSession`：

```tsx
<ui.ComposerSend
	running={running}
	disabled={!canSend}
	onSend={send}
	onStop={(event) => {
		void ui.stopSession(sessionId, event).catch((error) => ui.notify(String(error), "error"));
	}}
/>
```

停止是用户当次点击的操作，不能放进定时器、订阅回调或后台完成逻辑。`ui.stopSession` 不授予发送、修改或删除其他会话的能力。

## 回复正文的代码块

`ui.codeBlock("ui", Component)` 按围栏语言注册（忽略大小写）；order 小的优先，同 order 后注册的优先，撤下后恢复前一个。只接助手正文，用户消息、思考、文件预览和 `ui.Markdown` 不接，避免把引用材料变成可操作的回复。

组件收到 `CodeBlockProps`：`language`、`code`（围栏内原文）、`sessionId`、`messageId`（会话内展示标识，不是数据库 id）、`blockId`、`streaming`、`complete`、`fallback` 和可选的 `send`。同消息中多个块的标识不同。解析、校验、控件、状态及模型说明都由插件实现，宿主不识别其中的语法。可选 `copyText({ code, sessionId })` 在复制成功完成的助手回复时同步读取当前状态并返回可读文字；返回 `undefined`、抛错或插件停用时保留围栏源码。它只影响复制，不改显示、存储，也不能发消息。解析失败返回 `fallback`；渲染抛错或停用自动回到原始代码。

`complete` 只在原始围栏闭合、消息成功结束且平滑出字完成后为真，中断和截断不算完成。未完成块和只读视图没有 `send`；插件仍应禁用不完整表单。`send(text, event)` 必须在真实 click / submit 回调内同步调用，传入 React 事件；不可先 await，再调用。宿主拒绝程序生成的事件、重复使用的事件、卸载后及插件停用后的调用，内容须非空且不超过 32,000 字符。主会话复用输入框排队，子会话复用该视图的 composer.send，不把发送目标交给插件指定。

```tsx
ui.codeBlock("my-language", ({ code, complete, send, fallback }) => {
	const value = parseMyLanguage(code);
	if (!value) return <>{fallback}</>;
	return <Button disabled={!complete || !send} onClick={(event) => {
		void send?.(value.reply, event).catch((error) => ui.notify(String(error), "error"));
	}}>{value.label}</Button>;
});
```

模型的输出是不可信数据，不能当 JavaScript 执行，也不能把任意属性透传到 DOM。组件认不出的写法应整体回退，不静默丢控件。示例见 `plugins/native-ui`。

## 工具在转录里的说法

不画卡片的工具，转录里用宿主的通用卡片：一行图标加一句做了什么，连着做的同类调用合成一段活。没登记说法时那句话就是工具名、自成一类、图标是终端那枚；登记了就和内置工具一个样子：

```tsx
ui.toolLine("symbol", {
	verb: (locale) => MESSAGES[locale].toolVerb, // 「查找符号」
	subject: (args) => (typeof args.name === "string" ? args.name : undefined),
	like: "read",
});
```

- 一次调用说成「动作 对象」（「查找符号 runAgent」），一段活里几次合在一起数个数（「查找符号 3 个」）。`verb` 写成事后描述的动词短语，和内置的「读取文件」「搜索内容」一个口吻。
- `subject` 收到的参数是模型给的、没校验过：取不出就返回 undefined，只说动作；抛错也按没有对象处理。
- `like` 是做的事像哪个内置工具（`read`、`grep`、`edit`、`write`、`bash`）：读和搜索归「探索」、改和写归「改文件」、`bash` 归「跑命令」，连着做时并进同一段活；运行行用同一种说法；没给 `icon` 时用它的图标。不给就自成一类。
- `group` 是插件自己起名的一类活（浏览器的五个工具都写 `"browser"`）：同一类的连着做合成一段，和读、跑命令、改文件那几类也接成一段——边改边在页面上验是一件事。给了就不按 `like` 归类，`like` 照旧管运行行和图标。只该给「一段活里的一步」，要人单独看见的事（问人、派活）别给。
- `times: true`：几次合在一起时数次数（「操作网页 4 次」），不数个数。
- `callOnly: true`：`verb` 只说这一次调用（跑着时那一行、展开后那一行），一段活收起后照没登记说法的工具说「使用工具」。给不算一件活、只是收尾手续的工具（子智能体交结果的 `yield`）。
- `icon` 是 `@plume/ui/icons` 里的图标，13px。
- 同时登记了 `toolCard` 的工具单独一行画卡片（`inline: true` 的照常并进一段活），`fallback` 用这里的说法。同一工具后登记的生效，它撤下后前一个恢复；插件登记的优先于产品给内置工具的说法。

## 工具卡片

工具卡片还收到 `argumentsText`（流式原始 JSON）和 `streaming`（参数尚未完成）。草稿只能作静态展示，不执行未完成的代码。`send(text, event)` 仅在可写视图、工具成功完成时提供，发送到卡片所属会话；必须同步传真实点击/提交事件，或卡片内部当前聚焦 iframe 的原生 `MessageEvent`。宿主校验用户激活、来源、会话、挂载及注册状态，重复事件不能再次发送；iframe 消息间隔至少 1500ms。嵌入页仍须在自身桥里校验真实用户事件，不能用计时器代替点击。文本最多 32000 字符；页面插件应进一步限制短消息。可传第三参 `displayText` 作为气泡中的简短说明（同样最多 32000 字符），第一参仍是完整模型输入；主会话及提供 `composer.sendMessage` 的子会话保留两者。

```tsx
function MyCard({ call, status, progress, result, fallback }: ToolCardProps) {
	const data = (result?.details as { items?: unknown } | undefined)?.items;
	if (status === "failed" || !isItems(data)) return <>{fallback}</>;
	return <Card title="…" status="…">…</Card>;
}
ui.toolCard("my_tool", MyCard);
```

- 工具卡片收到 `call`（`{ id, name, args }`）、`status`（`"approval" | "running" | "done" | "failed"`）、`progress`（执行中的输出）、`result`（执行完才有，含 `details`）、`fallback`（通用卡片）、`sessionId`（这张卡所在的会话）；卡片在子会话里（侧边聊天）时还有 `handToParent(instruction)`：人点了按钮时把一件事排进那个子会话的父会话的队列，和 `run.parent.enqueue` 一样。
- **先校验再画**：`details` 可能来自旧版本存下的会话，认不出就返回 `fallback`，不画半成品。
- **动态工具名**：例如 MCP 可用 `ui.toolCard("mcp__", Card, { match: "prefix" })`。精确工具名的卡片优先于前缀卡片；所有匹配前缀按 order、注册先后排序。不匹配结果仍返回 fallback，停用后撤销前缀注册。
- **只补东西的卡片**：登记了卡片的调用默认单独一行，不和前后的调用合成一段活。卡片只是在通用卡片下面补一点（认不出时直接返回 `fallback`）、调用本身该和同类的合在一起时，加 `inline: true`：调用照常按归类并进一段活，单独一次时那一行、展开一段活后的那一行由这张卡画。例子是 `plume.mcp` 的文档预览。只有一部分调用画大东西、其余只画 `fallback` 时，`inline` 传函数逐次判断，返回 true 的那次并进一段活：参数还在写时 `args` 是空对象，只有 `argumentsText` 在长；只看这次调用自己的参数，参数写完后答案不能再变（一次调用从头到尾是转录里的同一行），不能等结果或后面的调用再定。例子是网页预览：截图检查只画一行，并进前后的活，发布的那次单独一行画网页。
- **崩溃让位**：每张卡片外面有错误边界，渲染出错时让给同一工具的下一个注册者，都不行用通用卡片。组件里不用自己 try/catch。
- **后注册的生效**：同一工具 `order` 小的在前；`order` 相同时后注册的在前，它撤下后前一个恢复。卡片的 `order` 默认是 0，写更小的 `order` 也能排到前面。
- 外框用 `@plume/ui` 的 `Card`（`title`、`subtitle` 放命令或路径、`status`）；输出用 `CodeBlock`，改动用 `ui.FileDiff`。
- 卡片只占一行时（参数还在写、事情已经交出去了）用 `@plume/ui` 的 `FlowRow`：和转录里思考、工具活、送达那几行同一个骨架（前置图标、标题、摘要、尾部、在跑时摘要扫光、`onToggle` 给了才可点），例子是 `plume.spawn-session` 的卡片写参数时那一行和开始以后那一行。
- 审批卡压在输入框正上方，不在工具卡片里：等待确认时工具卡片收到 `status: "approval"`，卡片里不放允许、拒绝。要给自己的工具换一种审批卡，见下面「审批卡」。

## 审批卡

```tsx
function ShellApproval({ request, sessionId, respond, permission, allowAuto, compact, fallback }: ApprovalCardProps) {
	if (!request.detail) return <>{fallback}</>;
	return <div className="my-card">…<Button onClick={() => void respond("once")}>允许</Button></div>;
}
ui.approvalCard("my_shell", ShellApproval);
```

- 只给自己的工具画（`request.tool`）：卡片压在输入框正上方的那一格、排队一次一张、停下这一轮时撤卡归产品；组件画整张卡（外框、正文、按钮）。认不出这次请求就返回 `fallback`（产品的通用卡），渲染出错时让给下一个注册者，都不行用通用卡。
- 回答只有 `"once"`、`"always"`、`"reject"`，问的是放不放行。要人给答案（回答问题、批准计划、填表）用下面的「等人给数据的卡」。
- `match: "kind"` 按 `request.kind` 登记、`userOnly` 的审批卡是还没迁走的旧写法，新写的不用。
- `permission` 是现在的权限模式；`allowAuto()` 只把请求批准切到帮我批准（「接受并开启自动模式」），先切再 `respond`，别的档调用不改。只在人点了卡上的按钮时调。
- `compact`：窄窗口，面板区一次只摆一格，开面板会盖住卡片，要读的东西画在卡里。`from` 是问的子会话的标题，卡上要写明。
- 没人答时卡会过期（权限请求 5 分钟），截止时刻在 `request.expiresAt`；`queued` 是排在这张后面还在等的张数。外框想和产品的审批卡一样（收放的标题栏、倒计时、+N），用 `@plume/ui` 的 `ApprovalFrame`，正文和按钮放在里面；自己画外框的，标题行放一个 `ApprovalExpiry`（`at={request.expiresAt}`），有排队时写 `+{queued}`。
- 等这张卡时对话末尾、侧栏悬停和系统通知说的那句状态，`run.ask` 带 `waiting` 给（按 `ctx.locale()`）；不给时宿主说「等待你的批准」。

## 等人给数据的卡

```tsx
function QuestionCard({ request, answer, decline, from, queued, fallback }: RequestCardProps) {
	const question = readQuestion(request.payload);
	if (!question) return <>{fallback}</>;
	return <ApprovalFrame …>…<Button onClick={() => void answer({ answer: picked })}>确认</Button><Button onClick={() => void decline()}>取消</Button></ApprovalFrame>;
}
ui.requestCard("ask_user", QuestionCard);
```

- 工具经 `run.request({ kind, title, payload })` 要人给数据（见 logic.md），卡片按 `kind` 登记；`request.payload` 是工具给的数据，认不出就返回 `fallback`（产品的通用卡，只能「不答」）。渲染出错时让给下一个注册者。
- 人答了调 `answer(value)`，`value` 原样交回 `run.request`（工具那边会再核一遍，卡上也先查一遍，拦住手误）；人不答调 `decline()`，工具得到 `reason: "declined"`。没送到时两者都抛错，卡片把错误摆出来、让人再答。一个回答连同附言（评论、修改意见）一起放进 `value`，不用经 `remote` 另交。
- 摆在哪、排队、过期（30 分钟）、停下这一轮时撤卡和审批卡一样归产品；`from`、`queued`、`compact`、`permission`、`allowAuto()` 的意思同审批卡。外框用 `ApprovalFrame`，或自己画、标题行放 `ApprovalExpiry`。例子是 `packages/builtin/ask-user`（`ApprovalFrame`）、`plan` 插件（`ApprovalExpiry`、「接受并开启自动模式」先 `allowAuto()` 再 `answer`）和 `mcp` 插件的表单。
- 卡片一出来把焦点给它，键盘能直接答。
- 等这张卡时那句状态由 `run.request` 带 `waiting` 给（「等你批准计划」，按 `ctx.locale()`）；不给时宿主说「等待你的回答」。

## 面板

```tsx
ui.panel("plan", PlanPanel, {
	title: (locale) => MESSAGES[locale].plan,     // 开始页上那一行的标题、标签上的字
	description: (locale) => MESSAGES[locale].desc,
	icon: ListTodo,                                // 来自 @plume/ui/icons，颜色跟着文字走
	shortcut: "CommandOrControl+Shift+P",          // Electron accelerator 写法，可选；和别的面板重了归后注册的，Plume 自己的（⌘B、后退前进、Esc、⌘P 文件树、⌥⌘P 文件面板）拿不走
	order: 0,                                      // 开始页的列表按它从小到大
	multiple: false,                               // 能不能开好几个标签
	listed: true,                                  // false：只从卡片等入口打开，不在开始页或「+」菜单列出
	restore: false,                                // true：重启恢复标签，插件须按 tab 恢复数据
	detachable: false,                             // true：可弹出独立窗口，插件须跨渲染进程按 tab 接回资源
	keepAlive: false,                              // true：标签关掉之前组件一直挂着，换会话、去设置页只是藏起来
	available: ({ cwd, session }) => Boolean(cwd), // 现在能不能用，可选；可以返回 Promise
});
```

工作区显示当前会话的面板，标签按会话保留；`multiple` 只控制同一会话能否开多个标签，不是整个窗口的单例限制。组件状态按标签隔离，跨挂载的资源按稳定 `tab` 保存，不能用一个全局「当前 session/cwd」覆盖其他会话的标签。

`keepAlive` 给卸掉就丢东西、又没法从逻辑入口接回来的面板：网页的 `<webview>` 一卸页面就没了，后台会话里 agent 也操作不了它。所有 `keepAlive` 标签放在统一扁平常驻层，换会话、去设置页只是隐藏，不重挂。后台仍收到标签归属会话的 `session` 和 `cwd`，`shown` 按是否正在显示所属会话的当前标签计算；挂着的每一页都占着资源，用不着的自己少挂。终端这类能按 `tab` 从逻辑入口接回来的不用它。弹出、收回窗口仍会重新挂载，`detachable` 的资源恢复语义不变。

`available` 不给就一直能新开。产品按目录（`cwd`）和有无会话（`session`，新对话还没发消息时是 false）分别计算；这两个值变化、窗口回到前台、一轮结束时重算。答 false、还没答上来或抛错时，只从开始页等新开列表排除它、快捷键不新开；已有标签不隐藏、不卸载。只拿来判断「这里有没有东西可看」（Git 面板：这个项目是不是仓库；侧边聊天、子 Agent：有没有会话），不拿来藏错误：要说明的原因在面板里说。

面板组件收到：

- `session`：标签归属会话的只读视图，不跟随窗口焦点；子会话面板保留 owner 语义。新对话尚无会话时为空，后台标签仍收到自己的会话。
- `cwd`：标签归属会话下一轮的工作目录，子会话面板沿用 owner 的目录语义；还没发消息的新对话是选中项目的目录，不属于项目的聊天为空。看项目的面板用它，别从 `session` 推（新对话里没有会话），也别读取窗口当前聚焦会话的目录。
- `shown`：标签归属会话正在显示、面板区已展开且它是当前标签。后台标签和收起的面板区为假，定时联网之类只为给人看的事在 `shown` 为假时停下。
- `tab`：所在标签的 id，标签关掉前不变。`multiple` 的面板用它分开各自的东西。
- `setTitle(title)`：改标签上的字，传 `undefined` 回到面板名。
- `onClose(handler)`：用户点标签上的 ✕ 时先调它，返回 `false` 不关；自己的东西（比如 shell）在这里收掉。返回撤销函数。

宽度和收起偏好在窗口内共享；关闭最后一个标签后收起面板区，可从标题栏重新打开开始页。全屏状态按会话保存，盖满工作区；窄窗口也盖满工作区，正文和面板放不下横排时上下排列。

组件卸掉不等于标签关了：未设 `keepAlive` 时换会话、去设置页可能卸掉；弹出或收回窗口仍会卸掉组件，回来再挂上同一个 `tab`。要跨卸载保留的状态放在逻辑入口（经 `remote`），不放组件里。`restore`、`detachable` 默认 false，只有能按稳定 `tab` 恢复资源的面板才声明。弹出、收回不调 `onClose`；独立窗口的系统关闭与标签 ✕ 都先调 `onClose`，返回 false 保留窗口。终端可跨窗口接回 shell，应用退出后恢复的是新 shell，不会复活旧进程。

## 页面

```tsx
ui.page("scheduled", ScheduledPage, { title: (locale) => MESSAGES[locale].title, icon: Clock, order: 0 });
```

侧栏多一行，点了正文区整块换成这个页面。组件收到 `session`（打开着的会话）和 `workspace`（当前工作区：打开着的会话的 `project`、`cwd`，没打开会话时是空白页选着的项目或目录，都没选时为空；项目的目录按 `project` 在 `ui.useProjects()` 里查）。要在「人现在所在的项目」里建东西（定时任务的新任务）用 `workspace`，不用 `session`：人停在某个项目的空白页时没有会话。插件停用时侧栏那一行撤掉。

那一行右端可以挂一个数，告诉人这一页上有东西在等他看（定时任务没人看见的失败）：`ui.pageBadge("scheduled", { count, label })`，数变了再调一次，`null` 拿掉。数要跟着逻辑入口走、不等人打开页面，所以在 `apply` 里一直连着逻辑入口的 `watch`，每次推来时调它。别处的按钮（输入框上方那一行的「查看」）经 `ui.openPage(id)` 把人带到这一页。

平时宿主在页面上方留一行和标题栏一样高的空白，它是拖动窗口的地方，页面从它下面开始。怎么选：

- 单栏、标题写在内容里的页面（定时任务、画廊的相册）：用默认，顶上那一行空着拖窗口。
- 左边列表、右边详情这种两栏页面，或者有盖满整页的一层（画廊的大图详情）：给 `topRow: true`，宿主不再留那一行，页面从卡片顶边开始，每一栏最上面放一个 `PageTopRow`（`@plume/ui`）。分隔线才能和侧栏一样从顶边通到底，盖满整页的那一层也不会先空一截。

```tsx
ui.page("pull-requests", PullRequestsPage, { title, icon: GitPullRequest, topRow: true });

// 贴着页面左边的那一栏给 `start`：侧栏收起时红绿灯和前进、后退浮在那里，它让出那段宽度。
<PageTopRow start>
	<Text size="label" weight="medium">{text.title}</Text>
	<span className="my-spacer" />
	<IconButton label={text.refresh} icon={<RotateCw size={13} />} onClick={reload} />
</PageTopRow>
<PageTopRow>…右栏的标题和按钮…</PageTopRow>
```

`PageTopRow` 管高度、左右内边距、整行拖窗口、行里的按钮和输入框挖成不拖动的，不用自己写 `app-region`；间距、两端对齐经 `className` 补。每一栏都要有这一行，空着的也放一个，不然那一段拖不动窗口。Windows、Linux 上窗口顶上另有一条拖窗口的带子，宿主让这一行不拖动，插件不用分平台处理。两栏页面贴左边那一栏的宽度要加上让出的那段：`width: calc(300px + var(--plume-top-row-inset))`；这两个变量（`--plume-top-row-height`、`--plume-top-row-inset`）是宿主在页面外层给的，不是 token，皮肤改不了。

## 输入框里的一格

```tsx
ui.composerItem("capture", CaptureButton, { order: 0 });          // 左边，排在「添加附件」和权限后面
ui.composerItem("context", ContextMeter, { side: "end" });        // 右边，排在模型选择前面
```

新对话和会话里的输入框都有这一格。`side` 默认 `start`：左边放动作（截图）；`end` 放跟下一轮的模型有关的读数（上下文用量）。组件收到 `sessionId`（新对话里还没有会话，是 undefined）、`running`（这个会话在跑一轮）、`model`（下一轮会用的模型：`id`、`name`、`contextWindow`；一个可用的都没有时为空），自己画按钮：`IconButton`，`size="composer"`，加 `emphasis`；有开、关两态的模式开关用 `ComposerToggle`（关着是淡色图标，开着带字、用强调色）；读数这类不铺悬停底色的，自己的按钮加上 `plume-composer-control plume-composer-icon` 跟着工具栏的控件边长。会话的消息和用量用 `ui.useSession(sessionId)` 拿（回复的 `usage`），上下文按段的大小在点开时用 `ui.contextBreakdown(sessionId)` 要。这一格不该显示时（比如设置里关掉了）返回 null。

这一排放不下时，模型名先缩；缩到认不出，宿主按顺序藏掉标了 `data-plume-fit-drop` 的元素：`"1"` 先藏（权限签和 `ComposerToggle` 开着时的字，`ComposerToggle` 自己带着），`"2"` 再藏（上下文用量这类看一眼的读数）。量是宿主做的，插件只在可让的元素上标这个属性；不标的一直画着。

## 项目签那一行

```tsx
ui.composerChip("branch", BranchChip, { side: "start" }); // 跟在项目签后面
ui.composerChip("changes", ChangeBar, { side: "end" });   // 靠右
```

输入框上方那一行，左边是产品的项目签。组件收到 `sessionId`（新对话里为空）、`cwd`（下一轮在哪个目录跑：会话的工作目录，新对话是选中项目的目录；不属于项目的聊天为空）、`running`（这个会话在跑一轮）、`send(text)`。自己画，高度用 `plume-composer-control`；不该显示时（不是仓库、没有可说的）返回 null。

`send(text)` 以人的身份把一句话发进这个会话：画成人的气泡，在跑时和人打字发的一样排进队，新对话里什么都不做。只在人点了这一格里写明要发什么的按钮时调（工作树的「交给这个对话解决」），不在渲染、定时器里自己调；要人改过再发的用 `ui.draftInSession(undefined, { text, replace: true })`。

## 跟着会话的卡片

```tsx
ui.conversationCard("todo", TodoCard);
```

一直在变的一件事（todo 清单做到哪了），不是转录里的又一条记录，所以不随消息滚走。对话那一列放得下它（320px 的卡片之外还剩 420px 正文）时浮在转录右上角，放不下时（窄窗口、面板区开着）在输入框正上方；只画开着的会话，新对话不画。组件收到 `session`（会话的视图：消息、`summary.running`、`summary.stop`）和 `placement`（`floating` / `inline`）：浮着的要自己的实底（`--plume-float`）和阴影（`--plume-shadow-glass`），压在正文上面也读得清。没什么可说时（清单空了、全勾完了）返回 null，不占地方。

卡片上可以有停下、接着做的按钮：`stop()` 停下这个会话正在跑的一轮（和输入框的停止按钮一样），`carryOn(text)` 替人说一句让它接着做（和转录底下的「继续」一样，会话里标成界面替人说的话）。只在人点了卡片上的按钮时调，不在渲染、定时器里自己调。

## 输入框的灰字建议、回复里的标记

```ts
ui.composerHint((session) => nextFollowup(session.messages));
ui.replyText((text) => withoutFollowups(text));
```

两者常一起用：逻辑入口经 `model.context` 让模型在回复末尾顺带写一个标记，界面入口从回复里读出它当建议，再把它从显示里拿掉。

- `ui.composerHint(hint)`：输入框空着时，宿主按注册先后问每个插件，取第一个给出字的当占位灰字；人按 Tab 整段填进去，看过再自己发。只问开着的会话，新对话不问；`session` 是这个会话的视图（含 `draft`，正在生成时自己决定给不给）。渲染时同步调，别做耗时的事。返回空串或 undefined 表示没有建议。
- `ui.replyText(transform)`：回复正文画出来、复制出去之前过一遍，只改显示和复制，会话里存的、发给模型的都不变。正在生成的回复也会过：写了一半的标记也要拿掉。拿完只剩空白的一段整段不画。
- 两样每个插件各只能有一个，再注册换掉上一个；停用时撤下。

## 欢迎页的那一行

```ts
ui.welcomeLine((locale) => api.today(locale));
```

欢迎页问候（早上好、下午好……）下面的那一行字，默认是「要在某个项目里开发什么？」（不在项目里时「想聊点什么？」）。宿主每次画欢迎页时按界面语言问一次，可以返回 Promise：等答复时那一行先空着，回来了再淡入，不会先闪一下默认的那句；`text` 是这句话，`source` 是出处（可不给），跟在后面、小一号、更淡。

- 只问最后注册的那一个；它停用后还给前一个，都没有就是默认的那句。
- 返回 undefined、空串或抛错时显示默认的那句（抛错记日志）。每个插件只能有一个，再注册换掉上一个。
- 要花时间的事（调模型、读网络）放在逻辑入口里做好缓存，界面入口经 `remote()` 取；欢迎页常开，别每次打开都调一次模型。

## 侧栏的记号、删除确认框

```tsx
ui.sessionMark(({ session, fallback }) => (branches[session.id] ? <span data-plume-tip={tipOf(session)}><GitFork size={11} strokeWidth={2.1} /></span> : <>{fallback}</>));
ui.deleteNote(async (sessionId, locale) => leftovers(sessionId, MESSAGES[locale]));
```

- `ui.sessionMark(Component)`：侧栏会话行首 14px 的那一格。在跑（呼吸点）、未读（实心点）由产品画，压过插件；只有空闲时问插件，插件不说话时是产品的空心圈。组件收到 `session`（会话摘要）和 `fallback`：不是自己要说的会话原样返回 `fallback`。几个插件都注册时按注册先后套起来，先注册的在外层，`fallback` 是里面那一层；渲染出错的那一层让给里面的。图标 11px 左右、颜色用 `var(--plume-ink-faint)`，悬停说明经 `data-plume-tip`（加 `data-plume-tip-side="right"`）。每一行都画一次，别在里面逐行调远端：一份共用的数据，行挂上、`session.cwd` 变了时重读。
- `ui.deleteNote(note)`：人点了删除、确认框打开前问各插件，`note(sessionId, locale)` 返回一句话（可以是 Promise），各占一行接在产品那句后面，按注册先后。最多等 600ms，没答上来、返回空、抛错的不写；`locale` 是当前界面语言，按它选自己的文案。只说会话删掉后自己那边会怎样（工作树：没提交的文件留在哪、没合并的分支留着），不是自己的会话返回 undefined。
- 两样每个插件各只能有一个，再注册换掉上一个；停用时撤下。

## 提示、开面板、写输入框

- `ui.notify(message, level)`：`level` 是 `"info"`（默认）、`"warn"`、`"error"`。说的是刚才那一下的结果（操作失败、导出好了），不是一直存在的状态：一直存在的状态画在自己的界面里。同样的话连着说几次合成一条。
- `ui.openPanel(id)`：只能开自己注册的面板，和按它的快捷键一样（开着就切过去，没开就新开标签，面板区收着就展开）。能开好几个的面板给了 `tab`，开的是 id 为它的那个标签，没有就用这个 id 新开（id 要全局唯一，用 `crypto.randomUUID()`）：逻辑入口那边先有了东西（agent 开了一页网页），再让界面开出对应的标签。`background: true` 只加标签、不切过去、不展开面板区。
- `ui.closePanel(id, sessionId?, tab?)`：关掉自己的面板，照样经过 `onClose`；给了 `tab` 只关那一个。
- `ui.draftInSession(undefined, { text, replace: true })`：整段换掉眼前输入框的草稿、光标移进去，不替人发送。用在「让 Agent 处理」这类按钮上：把要说的话写好，人看过再发。按钮上已经写明了要它做什么、不用人改的，在项目签那一行的格子里用 `send(text)` 直接发。
- `ui.draftInSession(sessionId?, { text, images? })`：接在已有草稿后面（原来有字时空一行），`images` 是 `{ data, mimeType }`（base64、不带 `data:` 前缀，png、jpeg、webp、gif），作为附件挂上、标记落在最后。用在「把选中的这一块连同截图交给 Agent」这类地方，人原来打的字不丢。`send: true` 只在人点了按钮时给：宿主核对人刚点过、输入框原本是空的，才直接发出去，还没发消息的新对话就此开出会话（Git 面板的「发给 Agent」）；人写了一半、或没人点时照草稿留着。
- 这两样在弹出去的面板窗口里调也行：那边没有输入框，交给主窗口里来源会话的输入框。

## 网址、文件签的打开方式

`ui.linkOpener(opener)` 让回复里的网址、文件签多一种打开方式，宿主只在人点了的那一刻调 `open`：

```tsx
ui.linkOpener({
	label: (locale) => MESSAGES[locale].openInBuiltin, // 网址右键菜单那一行、文件签悬停按钮的字
	icon: Globe,
	web: true,                                          // 网址（http、https）的右键菜单多这一行
	takesClicks: () => settings.openLinks === "builtin", // 点网址时由它开；Shift 点照旧交给系统浏览器。点的那一刻同步问
	file: (path) => /\.html?$/i.test(path),             // 这个文件（绝对路径）它开得了：文件签悬停时多一个按钮，点签本身照旧开文件面板
	open: async (target, sessionId) => { /* target 是 { url } 或 { path }；sessionId 是链接所在的会话，新对话里为空 */ },
});
```

`takesClicks`、`file` 在点击、渲染时同步调，别做耗时的事；抛错的当作「不」。`open` 出错弹成提示条。几个插件都注册时按注册先后排，点网址时第一个 `takesClicks` 的接手。一个插件只能有一个，再注册换掉上一个。

## 划词询问

`DraftQuote` 是 `{ id, text, from: "user" | "assistant" }`，`id` 标识这一次划选，不是原消息 id；只保留文字和说话者，不携带 DOM。`QuoteAction` 是 `{ label: LocalizedText, run(quote, sessionId): void | Promise<void> }`。标签随界面语言取值，操作放在“引用到输入框”之前；抛错由宿主弹提示条。

```tsx
ui.quoteAction({
	label: (locale) => MESSAGES[locale].askSide,
	run: (quote, sessionId) => ui.quoteInPanel("chat", sessionId, quote),
});
```

`ui.quoteInPanel` 只能打开本插件登记的面板。该会话正在显示这个面板时，引用进入当前标签；面板收起、当前显示的是其他面板，或原标签只在独立窗口里时，新开标签。引用追加成独立的引用条，保留文字、附件和已有引用，并聚焦输入框；不会因此创建子会话或调用模型。面板使用 `ui.Conversation` 时传 `composer.draftKey: tab`，引用随该标签的草稿保存，发送时才连同原草稿交给插件。

## 排队消息拿到别处去发

会话正忙时人按回车，话排在主输入框上方的排队条里。`ui.queueAction(action)` 给每条排着的消息「更多」菜单加一项，排在产品自己的「编辑」后面：

```tsx
ui.queueAction({
	label: (locale) => MESSAGES[locale].queueSideChat,
	icon: MessageSquarePlus,
	// message 是排着的那条（OutgoingMessage：正文、附件、气泡上的字），sessionId 是它排在哪个会话
	async run(message, sessionId) {
		const tab = (await api.firstTab(sessionId)) ?? crypto.randomUUID();
		const sideId = await api.open(tab, sessionId);
		ui.openPanel("chat", sessionId, { tab });
		void api.ask(sideId, message);
	},
});
```

宿主只在人点了那一项时调 `run`，调之前已经把这条从排队里拿掉；抛错弹提示条，这条不放回排队。没有插件登记时排队条直接放「编辑」按钮，不出菜单。几个插件按注册先后排；一个插件只能有一个，再注册换掉上一个。

## 画一个子会话

插件自己的子会话（逻辑入口经 `ctx.sessions.create` 建的，见 logic.md「子会话」）用产品的对话视图画，转录、工具卡片、思考和主列一样：

```tsx
function SidePanel({ tab }: PanelProps) {
	const sideId = useBound(tab);                 // 这个标签画的是哪个子会话，插件自己记
	const side = ui.useSession(sideId);           // 摘要、消息，跟着事件走
	return (
		<div style={{ height: "100%" }}>
			<ui.Conversation
				sessionId={sideId}                    // 不给：画 empty 和输入框（第一句还没发）
				empty={<PanelEmpty icon={MessagesSquare} title="侧边聊天" />}
				composer={{ placeholder: "问点什么", model: "choose", send: (text) => api.ask(sideId, text), stop: () => api.stop(sideId) }}
			/>
		</div>
	);
}
```

- 不给 `composer` 就只读。默认按发送调 `send`，会话跑着时发送键换成停止键、按了调 `stop`，保持侧边聊天行为。`mode: "steer"` 时运行中也能发送，发送键不变停止键；`disabled` 保留但禁用操控区。停止可放在面板头部。
- 输入框右下和主输入框一样：插件经 `ui.composerItem(…, { side: "end" })` 加的格子（上下文用量）会话在就画，拿到的是子会话；`model: "choose"` 再画能换的模型和思考档位（菜单最前面是「跟随主会话」，选了就清掉子会话自己的），`model: "show"` 画只读的模型和档位、悬停说明末尾接 `modelTip`。量的都是下一轮实际会用的：子会话没选的跟着父会话。会话还没建（第一句没发）时这些都不画；要让人在第一句之前就选，给 `blank: { parentId, model }`（第一句开在哪个会话下面、人没动过时插件要用的模型），`model: "choose"` 的模型和档位照画（没有用量格子），选的经 `send(text, choice)`、`sendMessage(message, choice)` 的 `choice`（`SessionChoice`：`model` 没有是跟随父会话）交回，建会话时照它给 `ctx.sessions.create({ parentId, ...choice })`。`footer` 放插件自己的东西，排在它们前面。
- 提供 `sendMessage` 时输入框接入附件，交回完整 `OutgoingMessage`；不提供仍是纯文字。草稿与附件按子会话隔离，异步发送失败不会把文字还到另一个子会话。
- 需要保留草稿、接收划词引用或弹出窗口时设置 `composer.draftKey: tab`（`PanelProps.tab`）。未发送文字、附件和引用按标签保存，支持 `sendMessage`；弹出、收回先确认存储成功，失败阻止交接并保留内存草稿。发送时引用附在消息文字前面，发送失败保留草稿，关闭标签后清理草稿；是否允许关闭仍由面板的 `onClose` 决定。
- `renderUserMessage(message, fallback)` 只改当前视图用户消息的样子，可按 `origin === "parent"` 画任务卡，其余返回 fallback。`replyText(text, message)` 只过滤当前视图正文与复制，回报卡去重时只拿掉该条最终正文，不动工具和思考，也不改存储。回报卡复用 `ui.turnFooter`。
- `reask: true`：人说的最后一句底下多一颗「编辑并重新提问」，宿主截掉它和之后的、拿改过的字重跑一轮（照常经 `prompt.submit`，插件按截掉后的记录算），不问要不要退文件；一轮在跑时置灰。没有撤回、分叉。侧边聊天开它，子 Agent 的全过程不开（话是派它的会话写的）。
- 这个子会话经 `run.parent.enqueue`、卡片的 `handToParent` 交给父会话的事走到了哪（`ChildTask`：排队中、在跑、做完、失败、随父会话停下）由宿主给，要画就给 `tasks={Component}`：组件收到 `{ sessionId, parentId, tasks, runNow, withdraw?, retry, dismiss }`，画在转录和输入框之间，留几件、摆哪些按钮由你定（侧边聊天的回执条见 `packages/builtin/side-chat/src/TaskStrip.tsx`）；不给就不画。`withdraw` 把那件从父会话的队里收回、那句话放回 `composer.draftKey` 那份草稿，没给 `draftKey` 时没有它。操作出错时宿主弹提示条。
- 没有「继续」：子会话的一轮只有插件能发起。等人批准的那一次压在主输入框上方，转录里只标「等待确认」。
- 画的是独立会话（`create` 不给 `parentId`，见 logic.md「独立会话」）时：等人批准的那一次（和 `run.request` 等人给数据的卡）就压在这个视图的输入框上方（插件的 `ui.approvalCard`、`ui.requestCard` 照样用），因为它不挂在哪个对话下、没有别处可压；所以只在人看得到的地方画它，页面没开着时用 `ui.useSession` 读 `approval`、经 `ui.pageBadge` 带 `attention: true` 提醒人。`model: "choose"` 的菜单没有「跟随主会话」，没选的用默认模型；没有划词引用。
- 外面那一层给它高度（面板里 `height: 100%`），它自己撑满、底下贴着输入框。

## 设置分区

先想清楚放哪：**只和这个插件有关的选项**（它自己的开关、阈值、账号）不给 `page`，画进插件详情（「插件市场」里点开它）的「设置」一节，不占设置导航：

```tsx
ui.settingsSection("im", ImSettings, { title: (locale) => MESSAGES[locale].title, detail: (locale) => MESSAGES[locale].detail });
```

详情里先画「设置」两个字，只有一节时不再写小标题（就是插件名），有 `detail` 时画在组件上面；几节时每节上面是 `title`。

**用户不管装了哪个插件、都会到设置里直接找的功能**（截图、使用统计这类）给 `page: "nav"`，单独占设置导航一行；插件详情里会有一个「去 设置 › 标题」的入口：

```tsx
ui.settingsSection("screenshot", ScreenshotSettings, { title: (locale) => MESSAGES[locale].title, icon: Camera, order: 0, page: "nav" });
```

`nav` 时设置页左边「基本」那一组多一行，点了右边是这一节。页头（标题，给了 `detail` 时下面再跟一段介绍）由宿主画。不管放哪，组件都只画内容：分组标题用 `SettingsSectionTitle`，卡片用 `SettingsCard`，卡片里一行用 `SettingsRow`（`title`、`detail`、右边的 `control`），出错或要提醒的一句用 `SettingsNotice`（`tone` 是 `danger`、`accent`、`muted`），快捷键用 `ShortcutRecorder`——和产品自己的设置页同一套，长得才一样。设置值存在逻辑入口（`ctx.dataDir`），经 `remote` 读写。

一节里有不止一个分组时，分节间距要自己补：产品的设置页把每节包在 `<section>` 里、靠 `gap-9`（36px）隔开，插件这一层没有。给卡片挂一个 `margin-bottom: 36px` 的类（`screenshot` 插件是 `.shot-settings-card`），不然第二个分组标题会贴在上一张卡片上。

再按这一页管的事给 `group`，组里按 `order` 排：管 Agent 能做什么的页（命令、钩子、网页搜索）给 `"agent"`，放进「Agent 能力」组、排在「智能体」后面；读写本机数据的页（符号索引、使用统计）给 `"data"`，放进「数据」组、排在「存储」前面；管仓库、工作树的页给 `"vcs"`，放进「代码与版本控制」组；不给的排在「基本」组最后。`group` 只和 `page: "nav"` 一起给，别的位置给了宿主报错：

```tsx
ui.settingsSection("usage", UsagePage, { title: (locale) => MESSAGES[locale].title, detail: (locale) => MESSAGES[locale].intro, icon: BarChart3, group: "data", page: "nav" });
```

和产品某一页说的是同一件事时（比如记忆之于「个性化」），给那一页的 `page`，画进那一页，插件详情里同样有去那一页的入口：

```tsx
ui.settingsSection("memory", MemorySettings, { title: (locale) => MESSAGES[locale].title, page: "personalization" });
```

管技能、MCP 连接器的插件给 `page: "extensions-skills"`、`"extensions-connectors"`：画进「插件市场」页「技能」「连接器」两类筛选条的「已安装」里（「全部」和各个货架是市场里的技能合集、连接器，由宿主画），宽度和设置页一样；插件详情里是「去 插件市场 › 技能」这样的入口，落在「已安装」。内置的 `plume.skills`、`plume.mcp` 就是这样放的。

- 刷新（技能还有看哪个项目）由宿主画在页头，组件经参数（`ExtensionsSectionProps`）拿到 `refreshKey`（人点了刷新就变）、`openPlugin(key)`（打开一个插件的详情，`key` 是插件目录名），技能的组件还拿到 `project`（选中的项目目录，null 是只看个人的），照着读、照着画列表。组件只画列表，不画自己的工具条。
- 只有这个插件做得到的添加方式经 `actions`（`SectionAction`：`label`、`detail`、`icon`、`run`）放进页顶「添加技能」「添加连接器」：技能的排在宿主自己那一项（让 agent 写一个）后面；只有一项时按钮直接做它。`run` 跑完宿主换到「已安装」，要弹对话框的，在 `run` 里记下、等那一节画出来再开（`plume.mcp` 的「手动添加」就是这样）。

```tsx
ui.settingsSection("skills", (props) => <SkillsSettings {...props} />, {
	title: (locale) => MESSAGES[locale].settingsTitle,
	icon: WandSparkles,
	page: "extensions-skills",
	actions: [{ label: (locale) => MESSAGES[locale].openPersonalDir, icon: FolderOpen, run: () => api.reveal(null, null) }],
});
```

画进产品页的 `page` 有四种，宿主都不画这一节的页头，`title` 只当无障碍名（`general`、`session-models` 例外，见下）；同一页的几节按 `order` 排：

- `"general"`：「常规」页「常规」那张卡里的一行，排在「显示思考过程」后面。行的名字和说明由宿主按 `title`、`detail` 画，组件只画右边的控件，通常是一个 `Toggle`。给随应用发、不能停用的插件放自己的开关（停用不了，关掉只能靠它）；市场里的插件开关就是启用、停用，不占这里。例子是 `title` 插件的「智能标题总结」。
- `"personalization"`：画在「全局指令」和「语气」之间。组件自己用 `SettingsSectionTitle` 画小标题，下面接卡片，和这一页别的节一个样子。例子是 `memory` 插件。
- `"agents"`：「智能体」那一页的主体，画在页头和「会话」那一组之间；有插件往这一页画东西时导航里才有这一页。工具条、分组和卡片由组件自己画。例子是 `subagents` 插件。
- `"session-models"`：「智能体」页「会话」那张卡里的一行，给某个功能选模型。行的名字和说明由宿主按 `title`、`detail` 画（几个插件的行在同一张卡里，字号和留白要一样），组件只画右边的控件，通常是一个 `ui.ModelSelect`：

```tsx
ui.settingsSection("model", ModelSetting, { title: (locale) => MESSAGES[locale].modelTitle, detail: (locale) => MESSAGES[locale].modelDetail, page: "session-models" });

function ModelSetting() {
	const defaults = ui.useModelDefaults();
	// model 存在逻辑入口（`ctx.dataDir`），经 remote 读写；空串是跟随
	return <ui.ModelSelect ariaLabel={text.modelTitle} value={model ?? ""} inheritLabel={text.followMain} inheritedModelId={defaults.sessionModel ?? defaults.defaultModel} inheritedSource={text.followMainShort} onChange={save} />;
}
```

逻辑入口拿到选好的模型后，`ctx.model.complete({ model })` 或 `ctx.sessions.create({ parentId, model })` 用它；那个模型后来被删了时 `complete` 抛错、不换成别的，下拉里那一项也会写「不可用」。例子是 `side-chat`、`title`、`memory` 插件。

## 截屏

截屏里插件做不到的部分由宿主做，经 `ui.screen`：

- `start()`：拍下指针所在的那块屏幕，开一层盖住它的浮层，浮层里画 `ui.screenOverlay` 注册的组件。没给屏幕录制权限时返回 false（系统会弹授权）。
- `setShortcut(accelerator | null)`：全局快捷键（Electron accelerator 写法，如 `Alt+A`），按下等于 `start()`；被占了返回 `taken`，写法不认是 `invalid`。界面入口在主窗口、浮层、钉图窗口里各跑一份，只有主窗口的设置生效，在 `apply` 里按设置调就行。
- `pickDirectory(title)`、`desktopDirectory()`：选保存目录、没设时的默认目录。

浮层组件（`ScreenOverlayProps`）拿到这一次的 `session`（整屏快照的 RGBA 像素、屏幕在全局坐标里的位置、色彩空间、指针位置），每次截图换一个 id、组件重新挂上。背景画好后调 `ready()` 宿主才把浮层亮出来；结束时调 `finish(png?)`（给了 PNG data URL 就放进剪贴板）、`cancel()` 或 `pin(png, at)`（钉成置顶小窗口）；`copy(png)` 只进剪贴板；`passThrough(true)` 让点击穿过浮层（浮层上只剩一句提示时）；Esc 是宿主注册的全局键，经 `onEscape` 订阅。

钉图组件（`PinnedShotProps`）拿到图和窗口操作：画好后 `ready()`，`close()`，拖动用 `dragStart()` 加 `dragMove(dx, dy)`（离按下点的屏幕偏移）。

标注、选区几何用 `@plume/ui` 的 `useAnnotator`、`AnnotateCanvas`、`AnnotateToolbar`、`useToolbarPlacement` 和几何函数（见 components.md）。完整的例子是截图插件 `screenshot`。

## 皮肤

`ui.skin({ light: { … }, dark: { … } })`，只能覆盖 `SkinToken` 列出的 token（就是 `--plume-*` 去掉前缀），值是 CSS 值。颜色由四个种子 `bg`、`fg`、`accent`、`contrast`（0–1）推出整套面、线、字，通常只给种子；推出来的哪一档不满意再单独覆盖。同一时间只有一个皮肤，后注册的生效，它撤下后前一个恢复；同一入口可反复调用更新，`ui.skin(null)` 只撤下自己的皮肤。

同时提供 `name`（非空、最多 80 字符）和 `mode: "system" | "light" | "dark"` 时成为管理配色的数据皮肤。宿主暂时忽略用户保存的界面种子与深浅模式，外观页实时显示当前皮肤名和只读配色；字体、代码外观和其他偏好仍可改，原配色不被改写，皮肤停用后恢复。只提供 `{ light, dark }` 的旧皮肤不接管偏好，用户明确设置的项仍优先。深浅模式由宿主主进程按窗口暂存，插件不访问内部配置或 `window.plume`。

只传 `{ name: "Plume", mode: "system" }`、不传 token 时，使用产品原生配色并跟随系统；`light`、`dark` 则固定模式。这和 `ui.skin(null)` 不同：前者暂时管理配色并屏蔽原有种子覆盖，后者退出管理、恢复原用户偏好。

要让人在插件里切「跟随系统 / 浅色 / 深色」，就是改外观页那三张主题卡片，不是做一套皮肤：`ui.setTheme("dark")` 等同人在外观页点「深色」，存盘、各窗口同步；组件里用 `ui.useTheme()` 读当前选的是哪张。有皮肤接管深浅模式时外观页的主题只读，`setTheme` 同样不改，所以先 `ui.skin(null)` 撤下自己的皮肤再调。只在人点了插件界面上的按钮时调，不在工具或定时逻辑里替人改。

背景操作复用 `<ui.ChatBackgroundSettings title="…" />`，`title` 来自插件文案，省略时用产品的「会话背景」。用户在该组件做的修改直接保存到全局背景偏好，切换皮肤或停用插件不撤销；图片格式和体积检查、复制、失败提示和跨窗口更新均由宿主负责，不另存一份背景。

`root` 是窗口最外层与透明停靠侧栏共用的底色，默认跟随 `shell`；`sidebar` 只给 compact 浮出侧栏铺底，不给停靠侧栏另铺一层；`accent-dim` 是强调弱底，默认是强调色的 10% 透明底。数据皮肤可直接给出完整的面、线、字 token；若一份配色只适用于一个模式，给 `light`、`dark` 同一组 token，并用 `mode` 指定深浅模式。

`root-image` 是盖在 `root` 上的底纹，值是 CSS 图像，可以逗号分隔叠几层（例如 `linear-gradient(160deg, #…, #…)`，先写的在上面），默认 `none`。颗粒、噪点这类质感不写进皮肤：磨砂是用户在背景设置里开关的，宿主叠在底纹上面，哪套皮肤都一样。只在管理配色的数据皮肤下铺在窗口外圈和透明的停靠侧栏上，正文卡片仍是 `shell` 的实底。宿主把它固定在视口上（`background-attachment: fixed`），外圈、侧栏吸顶标题和 Windows 顶带画的是同一片；平铺的小图按自身尺寸重复，渐变铺满整个窗口。侧栏的字直接压在它上面，渐变两端的颜色都要和 `root` 一样满足文字对比度。

在界面入口的 `apply` 中开启远端 watch 时，用 `ui.effect(() => call.cancel())` 登记取消。清理按后登记先执行，一项抛错不妨碍其余清理；宿主先让旧入口失效再清理，因此停用、重载或 apply 失败后，旧异步回调的 `ui.skin` 不会复活皮肤。组件内的订阅仍用 React effect 清理。

## remote：调自己的逻辑入口

```tsx
apply(ui) {
	const api = ui.remote<MyApi>();      // 在 apply 里拿一次，组件里用
	function MyPanel(props: PanelProps) { /* 用 api */ }
	ui.panel("my", MyPanel, { … });
}
```

- 类型参数写逻辑入口那边的接口（`src/api.ts`），末尾的 `CallContext` 参数这边不传。
- 每个方法返回一个调用：`await` 拿结果；逻辑入口返回异步迭代器的，`for await` 逐个拿中间值；`.cancel()` 取消，对端的 `signal` 中止。组件卸载时记得取消还在流的调用。
- 逻辑入口没开或插件停用了，调用以错误结束，界面要能显示这种状态。

## 共享模块

`react`、`react/jsx-runtime`、`@plume/ui`、`@plume/styles` 不打包，运行时用产品的那一份；其余（包括 `@plume/ui/icons` 和第三方库）打进 `dist/ui.mjs`。宿主启动时就加载每个插件的 `ui.mjs`：只在某个操作里才用到的大库（预览、图表、编辑器）写成 `await import("…")`，构建时拆到 `dist/chunks/`，用到时才取。能用哪些组件、各自的签名和用法，见 [components.md](components.md)（从源码生成）；`@plume/ui` 里没列在那里的导出是产品内部用的，引用了 `pnpm check:plugins` 会拦。

## 运行诊断入口

- `ui.sessionToolbar(id, Component)` 在有会话的标题栏放局部控件，收到 `{ session }`；新会话不画，不能接管标题与布局。使用 `IconButton`，停用自动撤下。
- `ui.sessionMenuItem(id, { label, icon?, run })` 在会话操作菜单加一项。`run` 收到被点的会话摘要，异步操作固定使用它的 id，不跟随焦点；报错由宿主提示。同插件同 id 替换。
- `ui.jobViewer((sessionId, jobId) => ...)` 登记后台任务（服务 `background.jobs` 列出的那些）的查看入口，只在人点击时调用；后登记的生效，撤下恢复前一个，不改变送达或命令状态。画后台任务那一行的插件用 `ui.useJobViewer()` 拿到它（没人登记时是 `undefined`，那一行就不给点）：两边都不用知道对方是谁。
- `ui.agentDelivery(Component)` 画本插件交回的结果在对话里的那一行（`ctx.sessions.report`、`channel.report`、`reportBack` 带了 `delivery` 的）：收到 `{ sessionId, reports }`，一次送达里本插件交的几份一起给（连着几次只带 `inline` 的送达并成一次），画成一行（子 Agent 的「消息来自 @explore」、plume.tools 的「后台命令完成」，用 `FlowRow`）。每份的 `details` 是你交的时候给的自己的数据，宿主不读，原样带回来。宿主记着每份是哪个插件交的，只交给那个插件登记的组件；再登记换掉自己前一个，停用时撤下；没登记（或停用了）时宿主按 `title`、`status` 画默认的一行，带 `sessionId` 的（新会话交回）画成「来自新会话」、点了过去；组件出错时只丢这一行。
- `ui.ProjectOpener` 以 `{ path }` 显示目录的打开方式，复用文件预览的默认应用与选择菜单；只有用户点击才调用系统打开。
- `ui.environmentSection(id, Component, { label, order?, attention? })` 往环境卡片里加一节：和会话相关的一件周边的事，每一行只是入口，点了去自己的页面或面板（`ui.openPage`、`ui.openPanel`）。没东西时返回 null。order 排进卡片自己的几节之间：打开方式 0、后台任务 10、子会话 20（按建它的插件分几节，节名是 `ui.usePluginDisplayName` 查到的显示名）、计划 30、定时唤醒 50、压缩记录 85、引用 90。卡片不替插件画小标题，要小标题的自己画（文字用 `Text size="caption" tone="faint"`）。例子：`plume.pull-requests` 用 60 放当前分支的拉取请求（一行，没有小标题）；`plume.summary` 用 80 放会话摘要（带「摘要」小标题）。`attention` 是一个 React hook（规则同 hook），这一节有事等人回来决定时返回一句话（按界面语言），没有返回 undefined：卡片收着、这一节没被藏起来时，标题栏的环境开关上挂一个圆点，这句话接在开关的说明后面。只为「等人决定」，不为「有东西在跑」。例子：内置的 `plume.spawn-session` 用 40 放「建议的新会话」，还没人点开始的建议经 `attention` 说「N 条建议的新会话等你决定」。
- `ui.useEnvironmentSections()` 是给画环境卡片的插件用的 React hook：返回各插件登记的节（`key` 为 `插件名/id`、`label`、`order`、已包好错误边界的 `component`），按 order 排好。

内置 `plume.diagnostics` 用以上入口和 `ui.panel`、`ui.conversationCard` 提供任务、轨迹与环境卡。工具结果和历史正文读 `SessionView`，观察数据与后台任务经自己的 `remote` 读取。

`ui.pageBadge` 的 badge 可带 `attention: true`，同时在通知菜单中显示该页面的待处理事项；label 是通知标题，点击打开该页面。
