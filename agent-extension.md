# Plume Agent 扩展架构（设计稿）

> 状态：已实施。代码位置和进程连接见 `ARCHITECTURE.md`。

## 1. 结论与边界

模型请求、agent 循环、会话、审批卡和命令的沙箱（`packages/core/sandbox`，权限模式对应哪一档、提权、只读）是产品本体；基本工具、帮我批准的风险规则、系统提示词、压缩是随应用发的内置插件（`packages/builtin/`）。循环里依赖它的能力——新工具、工具结果、发给模型的上下文——通过**钩子**和**工具注册**开放给插件；对话里和这些能力配套的**工具卡片**也开放给插件画（审批卡是产品自己的）；对话旁边的**面板区**是产品的，里面的每个面板由插件注册。read / write / edit / ls / glob / grep / bash 是内置插件 plume.tools 的工具，内置插件先于其他插件加载；插件注册同名工具就覆盖它，后登记的生效。

| 能力 | 可变？ | 插件怎么改 |
| --- | --- | --- |
| 模型调用（`@plume/llm`） | 不可变 | 不能替换；经 `model.context` 改发给模型的内容 |
| agent 循环 | 不可变 | 结构固定：组上下文 → 调模型 → 执行工具（相邻的只读调用同时跑）→ 写回会话 → 收尾，一轮最多 200 步；只能在钩子处插入行为 |
| 模型的回复 | 不可变 | 不能改回复内容 |
| 人发来的消息 | 部分可变 | `prompt.submit`：一轮开始、写进会话之前拦下它（这一轮不跑，弹一条原因），或放行并在它后面补一段给模型的上下文，或让这个会话从这一轮起换个目录跑（工作树）；不能改写这条消息 |
| 一步之后怎么走 | 部分可变 | `step.end`：本来要结束时让它接着做（以用户身份对模型说一句），或给结束换个原因；本来要接着做的拦不下，出错和用户停止不经过它 |
| 会话 | 不可变 | 格式和存储位置固定；只有循环能写入，插件经 `ctx.sessions` 列出会话、读消息原文、改标题（`setTitle`）；插件不能在已有的用户会话里发起一轮，只有自有后台运行的结果能经 `report` 由宿主送回真实父会话；插件自己经 `launch({ steward: true })` 开出、正代管着的会话例外：能往里转话、替人答卡，人随时停止代管（见下方「会话的边界」）；能开一个新的顶层会话并发出它的第一句话（`launch`，见下方「会话的边界」）；顶层会话里工具的那次调用能要求这一轮完成后归档它所在的会话（`ToolRun.archiveAfterTurn`）；在自己建的子会话里，自己的工具的那次调用够得着它的父会话（`ToolRun.parent`：排一件事、停下、接着做、看状态），人在那个子会话的卡片上点也只到父会话（`ToolCardProps.handToParent`）；跟着会话的卡片上的按钮是人点的，经 `stop` / `carryOn` 停下或接着做，和输入框的停止、转录底下的「继续」一样。压缩只记账在本体（摘要、头、边界和剪枝视图怎么拼回历史，转录里的压缩行），何时压、剪哪些、摘要怎么写由 `context.compact` 的层定（内置插件 plume.compaction）；插件经 `ctx.sessions.compact` 现在就压一次（`/compact`）。插件可以建挂在某个会话下的**子会话**（见下方「会话的边界」），只在自己建的子会话里发起一轮 |
| 有哪些工具 | 可变 | `ctx.tools.register` 新增或覆盖；read / write / edit / ls / glob / grep / bash 是内置插件 plume.tools 的，插件注册同名工具就覆盖它 |
| 工具怎么执行 | 可变 | `tool.execute`：放行、拦截、改参数、改结果，或者整个接管 |
| 审批 | 可变 | 哪些调用要问是本体定的（写了 `asks` 的工具自己问，其余会改动的执行前问，层可以调 `ask`），排在 `tool.execute` 所有层的里面；权限模式（请求批准 / 帮我批准 / 完全访问）的含义也是本体的：完全访问、`approved`、「以后不再问」的名单（按发起审批的那件工具的插件分开记，本体读边界的单独记在本体名下）直接放行，提权只认人在卡上答或代管这个会话的插件经 `ctx.sessions.respond` 转达（钩子答放行不算）；其余经 `tool.approve`，内置插件 plume.approval 按帮我批准的风险规则放行，插件在外层替人答或交给里层弹卡。插件也可在 `tool.execute` 外层预先放行（`approved`）或拦截。工具经 `run.request` 要人给数据（提问、计划、表单）不是审批：不经 `tool.approve`、权限模式管不着，只和审批共用队列和卡位 |
| 系统提示词、历史消息、工具列表 | 可变 | `model.context`；系统提示词按段（`sections`）给出，插件按段名加、换、删；只作用于这一次请求，会话里存的不变。系统提示词由 plume.prompt 按会话冻结，中途变了的段作为增量消息接在下一轮开头；工具表同样按会话冻结，变化在下一轮开头生效。宿主给的工具表按固定规则排，和依赖声明、加载先后无关：内置插件里声明了 `kind` 的在前，再是内置插件的其余工具、非内置插件的工具（按插件名、再按工具名），MCP 的工具在最后（`host.ts` 的 `compareTools`） |
| 工具卡片 | 可变 | 插件的界面入口按工具名注册；没注册的用产品的通用卡片。结果里的图（交给模型的 `images`，和 `shownImages` 里只给人看的）通用卡片都画 |
| 会话的临时目录 | 不可变 | 宿主给每个会话一个（`<数据目录>/scratch/<会话 id>`，`ToolRun.scratchDir`、`ModelContext.scratchDir`），会话删掉时连目录一起删；同一脉的会话（沿子会话、分叉、建议开出的新会话的来处连在一起的）的临时目录经 `ToolRun.scratchDirs`、`ToolApproval.scratchDirs` 给出，互相写不问，别的会话的写不进或要问；读哪个会话的临时目录都不问；里面放什么由插件定（太大没交给模型的图、截断前的全文），plume.prompt 把它写进系统提示词 |
| 读用户的文件 | 不可变 | 本体守读的边界（`@plume/workspace`）：工具经 `ToolRun.files.read` 读路径或地址、经 `readCommand` 判一行命令写明要读的路径，工作区、项目目录、临时目录、附件不问，密钥按文件问、别处按项目问（过闸，卡片 `kind` 是 `view`）；plume.tools 的 read、ls、grep、glob、bash 和别的插件的工具是同一个答案、同一份批准记录。项目文件清单经 `ctx.workspace.files`，没人点的仓库读（status、diff、日志、后台获取）经 `ctx.workspace.git`，本体在隔离视图里问 git，不执行仓库配置的程序；人点的写操作仍由插件自己在真实仓库上跑 |
| 写用户的文件、记下改了什么 | 不可变 | 本体守写的边界、记改动快照（`@plume/workspace`）：工具经 `ToolRun.files.change` 写文件（Plume 自己的数据目录、别的会话的临时目录不写，链接逃不出工作区，同一个文件排队、写之前再核一遍），经 `write` 写 `scratch://`；带 `recordChanges` 的 `run.exec` 由本体在命令前后对比工作区。改了哪些文件由本体记在这次调用的结果上（`ToolOutput.changes` → `ToolResultMessage.changes`），工具和层伪造不了；插件经 `ctx.changes` 读净变化、撤销（plume.delivery 的交付卡），撤回、编辑重发时连文件一起退由本体据它做，全有或全无。问不问人仍归工具（`run.ask`） |
| 资源地址 | 部分可变 | 本体的 `ctx.resources`：`scheme://路径`，解析经 `ToolRun.files.read`（plume.tools 的 read、ls 认它）；插件经 `register` 加只读的 scheme（技能插件的 `skill://`，停用时本体撤下），经 `keepArtifact` 把大块原文存成 `artifact://`；本体自带 `scratch://`（唯一可写，经 `ToolRun.files.write`，write、edit 认它）、`artifact://`、`session://`、`plugin://` |
| 插件的密钥 | 不可变 | 逻辑入口 `ctx.secrets`（本体给，插件换不掉）：`seal` 把令牌、密码加密成带 `plume-sealed:v1:` 前缀的文本，插件写回自己的配置，`unseal` 解回、`isSealed` 认出密文；钥匙是本体给供应商 key 用的 `vault.key`，按插件名派生子钥，一个插件封的另一个插件解不开（null）；模型读钥匙文件要问人 |
| 审批卡 | 部分可变 | 产品的一张卡，压在输入框上方；插件在 `tool.execute` 里调 `ask` 时，卡上是这次调用的参数和它给的理由。插件换不掉这张卡，可以经 `ui.requestCard` 按 `kind` 画 `run.request` 等人给数据的卡（计划、提问、表单），经 `waiting` 说等这张卡时的那句状态；放不放行、过期、排队（+N）是本体的 |
| 面板 | 可变 | 插件的界面入口用 `ui.panel` 注册，并列在面板区里；面板区本身（位置、宽度、标签、开关）是产品的 |
| 插件 HTTP 请求 | 可变 | 逻辑入口 `ctx.fetch` 使用桌面系统网络栈，继承代理；只接受 HTTP(S)，不共享 cookie、不跟随重定向，插件停用或调用方取消会终止请求；认证和响应上限仍由插件负责，模型网络实现不变 |
| 移到废纸篓 | 不可变 | 逻辑入口 `ctx.trash` 把文件或目录移到系统的废纸篓（Windows 上是回收站），桌面应用经主进程的 `shell.trashItem` 做；agent 不在桌面应用里跑时抛错 |
| 页面 | 可变 | 插件的界面入口用 `ui.page` 注册，侧栏去处里多一行，点了占满正文区；侧栏本身、产品的「插件」去处是产品的 |
| 侧栏会话行首的记号 | 可变 | `ui.sessionMark` 只在空闲那一档换掉产品的空心圈；在跑、未读由产品画，压过插件 |
| 删除确认框 | 可变 | `ui.deleteNote` 在产品那句后面补一句会连带、会留下什么；问题、按钮和删不删是产品的 |
| 输入框底下那排的一格 | 可变 | `ui.composerItem` 在左边「添加附件」后面（`start`）或右边模型选择前面（`end`）加一格；输入框的内容和其余控件是产品的 |
| 输入框上方项目签那一行 | 可变 | `ui.composerChip` 在项目签后面（`start`）或靠右（`end`）加一格；项目签和这一行本身是产品的 |
| 输入框的草稿 | 可变 | `ui.draftInSession(sessionId?, { text, images?, replace?, send? })` 把字接在草稿后面（`replace` 时整段换掉）并挂上图片附件，给了会话先打开它、不给就是眼前的输入框（面板窗口里调交给主窗口）；`send` 只在人刚点过（用户激活还在）且输入框原本是空的时直接发出，其余都只放进草稿；项目签那一行的格子收到 `send(text)`，人点了格子里写明要发什么的按钮时以人的身份发进当前会话（在跑时排队）；正文代码块另有绑定所属会话、校验真实点击的发送回调；`ui.composerHint` 在输入框空着时给一句灰字建议，人按 Tab 整段填进去 |
| 插件页面导航 | 部分可变 | 人点击明确的按钮时，`ui.openConversationDraft({ project?, cwd?, text })` 打开项目或目录的空白对话并追加草稿，保留目标已有输入，不发送、不提前建会话；`ui.openSettings(id)` 只打开自己注册的、占导航一行（`page: "nav"`）的设置分区；`ui.openPage(id)` 只打开自己注册的页面，`ui.pageBadge(id, …)` 只在自己页面那一行挂数目；`ui.openSession(id)` 打开侧栏里有的顶层会话，和点那一行一样；`ui.openExternal(url)` 只打开不带凭据的 HTTP(S) 外链，`ui.openPath(path)` 把本机文件交给默认程序、文件夹交给文件管理器（会运行它的改成在文件夹里指出来），`ui.revealPath(path)` 在文件管理器里打开上级目录并选中它（「在访达中显示」，不打开它本身），`ui.openLink(url, sessionId)` 限制相同，有插件接手点击（内置浏览器）时开在它那里。PR 的账号和临时工作目录归插件，不给它任意写会话的权限 |
| Markdown 图片 | 固定 | 本体默认显示助手回复的本地图（相对路径按会话的工作目录算）和打开的文档配图（按文档所在的目录算）；本地读取受会话目录边界限制，仅用户打开的文档自动加载 HTTPS 图片，`data:` 图哪里都直接画；思考、人发的气泡、插件的 `ui.Markdown` 里的本地图不读，只留链接；加载失败保留链接；生图、图库另由插件提供 |
| 回复正文的代码块 | 可变 | `ui.codeBlock` 按语言接管助手正文围栏，插件拿到原文、会话/消息/块标识、流式与完成状态；停用或解析、渲染失败回到源码。语法和所有具体 UI 在插件内；可选 `copyText({ code, sessionId })` 在复制完整回复时现取文字，失败保留源码；宿主只在完整块的真实用户事件中提供绑定会话的 `send`，主会话排队，子会话沿用该视图的发送接口，只读视图不提供 |
| 回复正文的显示 | 可变 | `ui.replyText` 在画正文、复制之前把字过一遍，拿掉插件让模型顺带写的标记；会话里存的、发给模型的不变 |
| 提示条 | 可变 | `ui.notify`（界面入口）、`ctx.notice`（逻辑入口）在窗口顶上弹一条，过一会儿自己消失；位置、样式、合并重复的规则是产品的 |
| 插件自己调模型 | 可变 | `ctx.model.complete` 做一次性的小调用：不带工具、不思考、不写进会话、不经 `model.context`；用默认模型，替会话做的（给 `sessionId`）用会话的模型、花销记在它名下；`fork` 从会话上一次主请求分叉（宿主照那一次的系统提示词、工具、思考档位、缓存键发，发前核对前缀，对不上不发），给压缩吃缓存用。`ctx.model.usage` 只读花销表（每次计费的调用按小时、供应商、模型合好），记账本身是产品的 |
| 生图和会话里的图 | 可变 | `ctx.model.findImageModel` / `image` 用人在模型设置里标成生图的模型出图、改图，key 不出宿主；`ctx.media` 存、读会话媒体目录里的图。界面入口 `ui.mediaUrl` 显示、`ui.openImage` 用产品的看图器看和标注、`ui.saveImage` / `ui.copyImage` 另存和复制、`ui.draftInSession` 把字和图接进某个会话的草稿（原本空着时可以直接发）、`ui.revealToolCall` 跳到某次调用的工具卡片；`revealToolCall` 只在主窗口能用，`draftInSession` 在面板窗口里调交给主窗口。生图模型的配置和默认生图模型是产品的 |
| 设置分区 | 可变 | `ui.settingsSection` 默认画进插件详情的「设置」一节，不占设置导航；`page: "nav"` 时在设置导航里加一行（不给 `group` 在「基本」组，`group: "agent"` 在「Agent 能力」组，`"data"` 在「数据」组的「存储」前面，`"vcs"` 在「代码与版本控制」组），或带别的 `page` 画进产品的某一页（「常规」页「常规」卡里的一行、「个性化」的全局指令和语气之间、「智能体」页的主体、「智能体」页「会话」卡里的一行、「插件市场」页的「技能」「连接器」两类），插件详情里给去那里的入口；页头、导航、详情和那一页其余部分是产品的 |
| 截屏 | 可变 | 拍屏、浮层窗口、钉图窗口、剪贴板、全局快捷键是宿主的（`ui.screen`）；浮层和钉图窗口里画什么由 `ui.screenOverlay`、`ui.pinnedShot` 注册 |
| 布局、会话列表、设置页的其余部分 | 不可变 | 不开放 |
| 钩子和界面扩展点本身 | 不可变 | 插件不能新增；组合规则固定 |

两条约定：

- **契约之外的改法不受保护**：插件和 agent 同进程，技术上能改进程里的任何东西。上表之外的改法不保证可用，升级后可能失效。
- **隐藏不等于禁用**：在 `model.context` 里去掉某个工具，只是让模型看不到它；要禁止执行，在 `tool.execute` 里拦。

### 会话的边界

侧边聊天和子 Agent 都是「不是主会话的另一段对话」：它们的数据就是会话，用同一个循环、审批、存储和事件。所以会话的边界这样放宽，而不是让插件另存一套对话：

- **子会话是产品的**：会话挂在另一个会话下面（`parentId`），记着创建插件（`owner`），只挂一层，不进侧栏。界面上按 `owner` 说是哪个插件建的（会话卡片的用量、环境卡片里子会话的分节）都用插件的显示名，插件的界面入口经 `ui.usePluginDisplayName` 查，查不到时说通用的「子会话」，不把插件名露给人。工作目录、项目随父会话；没另选时模型和思考档位也跟随。父会话删掉时一起删（`onDeleted` 每个都会收到）。模型目录经 `ctx.sessions.models()` 给出，不含凭据。
- **插件的独立会话**：插件自己的页面要一个一直在的助手（plume.ssh 主机页右边的运维助手）时，`create` 不给 `parentId`，建一个不挂在任何会话下、记着 `owner` 的独立会话，在给的 `project` / `cwd` 里跑，都不给就在聊天目录。它和子会话一样只由插件发起一轮、不进侧栏（搜索、托盘、`@` 引用、已归档列表、系统通知也都没有），但不是顶层会话：没有后台渠道、寄信和 `archiveAfterTurn`，不能 `start`、不能挂子会话、不能归档，`prompt.submit` 给的 `cwd` 不换它的目录。它不挂在哪个对话下，审批卡没有别处可压，就压在插件经 `ui.Conversation` 画它的那个视图的输入框上方。插件停用不删它，只由插件 `delete` 或人在设置 › 数据里按时间清理时删掉。
- **插件只运行自己的子会话**：`create`、`send`、`stop`、`delete` 只认自己的 `owner`。`send` 等一轮结束，可带 `signal`；`start` 当场返回每次运行独立的句柄，`wait` 等那一次结束，同一个子会话再次 `start` 保留历史。提示词和工具限制仍由插件经 `model.context`、`tool.execute` 管，不另加子智能体专用钩子。
- **后台结果只回真实父会话**：`report(runId, text, { frame?, delivery? })` 校验所属插件、运行结束和取消状态，每次运行只接受一次；宿主短暂聚合，同一插件带 `frame` 的几份合成一段（开头一次、结尾在送出那一刻取一次），带 `delivery`（`DeliveryInput`）的由宿主记下是哪个插件交的、交给那个插件经 `ui.agentDelivery` 登记的组件在对话里画成一行（没登记就按通用字段画默认的一行），父忙时在工具结果完整后的安全边界读入，闲时串行唤起。消息标成运行时结果，不冒充用户授权；插件不能任意指定目标会话或直接写库。
- **工具的后台结果回自己的会话**：调用答完以后还在后台跑的事（plume.tools 的后台命令、`monitor`）经 `ToolRun.background()` 拿一条渠道，`report(text, delivery?)` 可以送多次，和子会话交回的结果走同一条聚合、边界读入和空闲唤起；`text` 可以是函数，送出那一刻才取，返回 `undefined` 就不送（模型这期间自己读过了）；`delivery`（和子会话交回、`reportBack` 同一个形状 `DeliveryInput`：`id`、`title`、`status`、`incomplete?`、`inline?`、`details?`，宿主只留这几个字段、拷一份、记下是哪个插件交的）让界面在对话里画一行——plume.tools 自己经 `ui.agentDelivery` 画「后台命令完成」「定时唤醒」，`details` 是它自己的数据，宿主不读；`inline` 的几份插在一段活中间时并进那段活。点了跳到别的会话的 `sessionId` 插件写不了，给了也丢掉，只有宿主在 `reportBack` 时填。只有顶层会话有渠道：插件的子会话没人等它们的后台结果。渠道按会话一代一代给：人按停、删会话、退出应用时这一代作废（`signal` 触发，攒着的丢掉），之后的调用拿到新的一代；撤回、编辑重发只作废截掉的那段里的调用拿到的渠道。送达的抬头只说「这是运行时送来的，不是用户说的话」，来源由各段自己的标签说（`<subagent_result>`、`<background_job>`、`<monitor_events>`）。
- **后台任务和唤醒登记在本体**：会话闲没闲（`LaunchedSession.idle`、`ParentStatus`、`SessionSummary.background`、`idle` 事件、`busy()`）只有本体算得了，所以工具起的后台工作要登记进来（`jobs.ts`、`wakeups.ts`）。调用答完以后还在跑的任务（plume.tools 的后台命令、`monitor`）经 `run.track({ command, description?, pid?, wakes?, output(), stop(force) })` 登记，拿回本体给的 `id`、`done(exitCode, error?)` 和 `stand()`；本体据此算闲没闲：只有会自己结束、结束后要叫醒会话的才算在等（顶层会话里没结束、起它那次调用的渠道还有效的任务在，会话就不算闲），挂着的不算——`wakes` 的监视，和跑起来以后被登记它的工具认出是长跑服务、调了 `stand()` 的（plume.tools 看到后台命令打印出本机带端口的地址就标上；本体不查端口），删会话、退出应用、登记它的插件停用、子会话经 `start` 派出的那次运行结束时调 `stop(true)`，经 `ctx.sessions.jobs` / `jobOutput` / `stopJob` 列给界面（读输出调回 `output`，不算模型读过）。人按停、撤回截掉起它的调用时本体不停它，只是不再算在等（渠道作废，它的结果不会再送回会话，和停掉、撤回的派发不算一样）；停不停归工具（plume.tools 的普通后台命令照跑，监视跟着停）。「以后再接着做」经 `run.schedule({ at | cron, recurring?, expiresAt?, prompt, reason?, message })` 交给本体调度（只有顶层会话有）：到点经约它那次调用的渠道送一条运行时送达，那一行记在约它的插件名下，送进去的话由插件的 `message(wakeup, { next, skipped })` 给（本体不写插件的工具名）；上一次送进去开的那一轮没做完就跳过、记着跳过几次；cron 的第一次至少在一分钟以后，`expiresAt` 之前对不上就不登记；人按停时全部取消并提示取消了几个，撤回截掉约它的调用时取消它，删会话、退出应用、约它的插件停用时取消；`ctx.sessions.wakeups` / `cancelWakeup` 读、取消。唤醒是挂着的：没触发的唤醒不挡会话闲下来，到点照样叫醒它。
- **停止不能被后台结果撤销**：父轮正常收尾不停止后台，用户明确停止父会话则取消后台与待送达；单独停子会话不影响其他任务。插件停用、热重载时先停自己的执行再撤钩子；父删除和应用退出也清理。`onStopped` 通知插件撤销尚未开始的排队项，排队规则仍属于插件。
- **插话在安全边界送入**：`steer` 只接受自己正在运行的子会话，不打断当前工具。发送消息支持完整附件，`origin: "parent"` 区分派发／续跑任务与用户插话，既有 `prompt.submit` 仍可拦截。
- **界面直接接会话事件**：子会话的消息、草稿、进度、审批走现有的 `watch` 事件；插件的界面入口经 `ui.useSession` 读一个会话的视图，经 `ui.Conversation` 用产品的对话视图画它（可以带一个输入框，发什么由插件经自己的逻辑入口决定），工具卡片和主列一样。子会话要人批准时，审批卡压在父会话的输入框上方，写明是哪个子会话在问。独立会话的审批卡压在画它的视图里。
- **上下文分段由宿主给**：发出去的请求（经过 model.context 各层和压缩之后）只有 agent 进程见过，所以宿主在发请求时按段估一次大小（对话消息、工具表（注册它的插件标了 `ToolDefinition.category: "mcp"` 的算 MCP 工具，单独一段）、系统提示词，系统提示词里插件标了 `category: "skills"` 的段（技能目录）、`category: "conventions"` 的段（项目里的指令文件）和 `category: "memory"` 的段（记忆）单独列，后两类里插件经段的 `files` 标了来源的按文件列；宿主不认工具名和段名），记在内存里；界面经 AgentService 的 `contextBreakdown` 要，宿主按最近一条回复报的总数等比缩放。不为读数重跑钩子：那些层是插件，有的会记状态。输入框里的上下文用量圆环（本体的，`apps/desktop/src/renderer/composer/ContextMeter.tsx`）点开时用它。
- **代管：插件开的会话，插件接着往里说话**：把会话接到 Plume 之外（外面的人经插件发消息、在外面答卡）要的是同一个会话来回好几轮。`launch({ …, steward: true })` 开出来的会话在摘要里记下 `steward`（开它的插件），之后这个插件能：`ctx.sessions.post(sessionId, message)` 往里转一句话，排进和人同一条队（落盘），闲着当场开一轮、忙着排着，不插进正在跑的那一轮，气泡标「X 转来」（`UserMessage.origin: "plugin"`、`fromPlugin`），模型读到的前面有一句本体写的来处说明（插件从 Plume 之外转来、不是人在输入框里打的、发送者 Plume 没核实、权限和审批照会话设置），`prompt.submit` 的 `launched` 为 true；`ctx.sessions.respond(sessionId, toolCallId, "once" | "reject")`、`answer(sessionId, toolCallId, value)` 替人答这个会话弹着的那张卡（审批卡含提权，等人给数据的卡），和人点卡同一个 settle，谁先到算谁的，另一边的卡收起；「以后不再问」不给插件（它改的是人的设置）。挂在代管会话下面的子会话（模型派的子智能体、人开的侧边聊天，`owner` 是哪个插件都行）弹的卡同样能答，`sessionId` 传子会话的；认的是父会话此刻的 `steward`，规矩同上。要是只能答代管会话自己的卡，远程那头遇上子会话的审批就卡死了：人不在桌面前。转话不跟着放开：`post` 只进代管会话自己，子会话里的一轮归建它的插件发起。代答的调用结果记 `answeredBy`，界面在那次调用底下写「由 X 代答」，交给模型的结果后面写明是插件转达的。卡和回复经 `ctx.sessions.observe`（`approval`、`response`、`turnEnd`）读，转出去哪些、答的人是不是该答的人由插件自己确认，本体不核。会话种类不变（还是人的顶层会话，`SessionScope.steward` 给钩子看），权限照这个会话的设置，不因来处而变；分叉出来的不带 `steward`。只认自己代管的顶层会话（答卡还认它下面的子会话）：别人的会话、别的插件代管的、往子会话里转话、人停止代管以后（会话菜单「停止代管」，`AgentService.revokeSteward`：去掉 `steward`，拿掉那个插件还排着的话，正在跑的那一轮不停；那时已经弹着的卡、包括子会话的，之后只能人答）都抛错，插件停用后也抛错。标题栏标题旁和侧栏悬停卡片写「由 X 代管」。
- **插件可以开新会话，碰不到已有的**：`launch({ project?, cwd?, message, model?, spawnedFrom?, title? })` 开一个顶层会话、当场发出第一句话，和人在侧栏新建会话再发第一句走同一条路——第一句照常经 `prompt.submit`、画成人的气泡，模型不给用默认模型。新会话进侧栏、不记 `owner`，人能接着聊；插件只拿到 `done`（第一轮为什么结束）和 `idle`（第一次真闲下来：后台运行都回来，登记着的一次性后台任务都结束，经 `ToolRun.letter` 问出去的请求都有了答复，它们唤起的几轮也做完；挂着的监视、开发服务器、约好的唤醒不等），之后不能再往里发、停、删。唯一往回的路是 `reportBack(text, delivery)`：把它做出来的结果交回 `spawnedFrom` 那个会话一次（`spawnedFrom.toolCallId` 要是本插件的工具在那个会话里的一次调用，插件停用后也交不了，免得插件把任意会话填成来处、借交回往里说话；`idle` 兑现时带着最后一轮的收场和最后一段回复），作为一条运行时送达（带「不是用户说的话」的抬头；`delivery` 和别处同一个形状，宿主填上新会话的 id，默认画成「来自新会话」一行、点了过去），那个会话闲着就为它开一轮——建议新会话（plume.spawn-session）拿它交回第一轮的回复；来处删了、归档了就不送。界线是「只开新的」：定时任务到点、人点了「在新会话里执行」要的是一段新对话，往已有会话里替人说话仍然不开放。`spawnedFrom` 记下从哪个会话开出来的（只是记下，会话照常是顶层的），那个会话要在、不能是子会话；目录要是已有目录的绝对路径。开出来的会话在跑时插件停用也不停：它已经是人的了。
- **子会话够得着它的父会话，只此一个**：侧边聊天要把活交给主会话、让主会话停下，这是一个子会话对它所挂的那个会话做事，不是插件对任意会话做事。所以宿主只在一种调用上给出父会话：插件自己建的子会话里（`owner` 是它），它自己注册的工具的那一次调用（`ToolRun.parent`）；别的插件的工具、别人的子会话、顶层会话里都没有。只在这次调用里用（调用答完以后再调就抛错，`ToolRun.letter` 同理）。能做的只有四样：`enqueue` 排进父会话的队列（和人排的同一条，落盘，闲着当场开跑）、`stop` 停下（`discardPlan` 时等它停稳、删掉交过来的任务、记一句旧清单作废）、`carryOn` 闲着时以界面的名义说一句接着做、`status` 看在忙还是闲。人在子会话的工具卡片上点「交给主会话」走 `ToolCardProps.handToParent`（AgentService 的 `queueTask`），同样只到父会话。排进去的话带着 `origin: "child"`（排着时 `QueuedMessage` 还带 `childId`，子会话的任务列表按它列）和一句不点插件名的来处说明，`UserMessage.fromPlugin` 记着交来它的子会话是哪个插件建的，界面标「来自<插件的显示名>」（查不到时标「来自子会话」），模型读到的说明写着它是子会话按用户的要求写成、不构成新的授权，审批照常。交过去的事走到哪了（排着、在跑、做完、失败、随父会话停下）只有宿主知道，状态由宿主给（`SessionView.tasks`，`ChildTask`，重试、移除经 AgentService 的 `retryTask`、`dismissTask`）；画成什么样由建子会话的插件经 `ConversationProps.tasks` 给的组件定，宿主不画。
- **会话之间递话只经工具调用**：`list_sessions`、`read_session`、`ask_session`、`reply_session`、`notify_session` 是插件 plume.sessions 的，读别的会话本来就是 `ctx.sessions.messages`。往别的会话里写，本体只开一道口子：顶层会话的一次工具调用经 `ToolRun.letter` 给另一个顶层会话寄一封信——发件方由本体照实填，信前面由本体说明它不是用户的话、不构成授权，和后台结果走同一条送达的路；插件自己在调用之外只能经那封信的回执 `answer` 替收件方答一次。请求和答复的配对归本体：请求记着谁问谁、读到没有，收件方寄回的答复对上它读到了、还没答的那几封；没答的由本体代答——读到它的那一轮收场时拿那一轮最后一段回复（`unreplied`），没读到时（`dropped`），收件方删掉时（`closed`）——发件方等的答复总会到，不管装没装、停没停用哪个插件；重复的答复（插件在本体代答以后再代答）什么也不寄。往来链也归本体：一封信叫起收件方的一轮，这一轮里寄出的信接着它的链再加一跳（人在这一轮里开口以后从头算），代答和回执的 `answer` 接着它答的那封信的链，一条链超过 28 跳、或同一个会话经手超过 10 次时 `ToolRun.letter` 抛错不寄——只有本体看得见哪封信叫起了哪一轮、代答又叫起了哪一轮，放在插件里，收件方总不正面回答时链就断了，不经那个插件寄的信也不受拦。插件仍然不能凭空往一个已有会话里说话、不能冒充用户。一封多长、发得多快、重复的发不发这些路由的账在插件里：寄出去的每一封都经它的工具，它看得全；代答一封答一封，放大不了。
- **会话只能归档自己，而且等这一轮做完**：人说「做完就归档」时，模型调 `archive_session`（内置插件 plume.spawn-session）。插件拿不到「归档任意会话」的权力（`ctx.sessions.setArchived` 只在人点了插件界面上的按钮时用），本体只开一道口子：顶层会话的一次工具调用经 `ToolRun.archiveAfterTurn()` 要求归档它所在的那个会话。不当场归档——这一轮还在等这次调用的结果，工具同时返回 `terminate: "done"` 让这一轮停在这一下；本体在这一轮以完成收场后归档，和人在侧栏上点归档一样（界面离开它，`onArchived`、`onEnded` 照常）。这一轮被人停下、出错、卡住收场时不归档、请求作废：人在调用之后按的停是更新的意思，出错时归档会把出的事藏起来。子会话没有这道口子：替它归档的会是派它来的人的对话。
- **观察只看和自己有关的会话，要看全部得声明**：`ctx.sessions.observe` 推的是会话正在发生的事：发给模型的整段请求（系统提示词、历史）、模型的回复、弹着的卡、运行状态和收场。不声明时插件只收到和它有关的会话的（宿主每次按会话算一遍，见 `agent.ts` 的 `concerned`）：它建的（子会话、独立会话的 `owner`）、它代管的和挂在代管会话下面的子会话（代管插件要看得见子智能体弹的卡才答得了）、它经 `launch` 开出还没兑现 `idle` 的。诊断轨迹、给每个会话写摘要、一轮收场后跑用户的钩子这类本来就要看每个会话的插件，在默认导出上写 `observe: "all"`（`Plugin.observe`），和 `inject` 并列，翻源码一眼看得到；宿主把它带进 `PluginStatus.observe`，插件市场详情页对装着的插件写一句「能看到所有会话的运行情况」。内置插件不例外，走同一个声明（`plume.diagnostics` 记轨迹）。声明放在逻辑入口而不是 `package.json`：`package.json` 的 `plume` 只是给市场看的说明，不改运行时的行为；代价是还没装的插件在市场里看不到这一条。这是声明和可见性，不是安全边界：插件和 agent 同进程，`list`、`get`、`messages` 仍能按 id 读任意会话的消息原文（钩子、工具拿到的就是所在会话的 id），会话库也在磁盘上。
- **命令可以不发消息**：`/btw 问题` 这类命令由插件自己办掉（`expand` 返回 `{ handled: true, openPanel? }`），输入框清空，主对话里什么都不留，要开面板的新开一格。

### 开放哪些界面

原则是**界面跟着能力走**：只有插件已经能往 agent 里加某样东西，配套的界面扩展点才开放，否则插件能画也拿不到数据。每开一个界面扩展点，先要有一个真实插件需要它。

| 界面位置 | 现在 | 什么时候开 | 前提（缺的能力） |
| --- | --- | --- | --- |
| 工具卡片 | 开放 | — | 插件已能注册工具，数据放在 `details` |
| 工具在转录里的说法（通用卡片那一行的动作和对象、归哪一类、图标、是不是记清单） | 开放 | — | 插件已能注册工具（索引插件的 `symbol`）；本体不认插件的工具名，自成一类（`apart`，MCP）、按前缀登记经 `ui.toolLine` 说，记清单在工具定义上说（`category: "checklist"`，界面经工具表拿到）；结果里的进度清单、后台任务按 `@plume/contract` 的 `ChecklistDetails`、`BackgroundJobDetails` 认，人按了停按 `CancelledDetails` 认，改了一个文件的 diff 按 `FileDiffDetails` 认，读了文件的哪一块（压缩据此清掉被顶替的旧读）按 `FileViewDetails` 认 |
| 审批卡 | 部分开放 | 插件要给自己的工具换审批卡、产品的通用卡说不清时 | 审批是本体的（放不放行、排队、过期），卡只有产品的一张，插件调 `ask` 时卡上是这次调用的参数和理由；`run.request` 的卡经 `ui.requestCard` 按 `kind` 画，没登记的是只能「不答」的通用卡 |
| 自定义消息渲染 | 部分开放 | 整条消息：插件能往会话里写自己的条目之后 | 已开的两处：送达那一行（插件交的后台结果）由交它的插件经 `ui.agentDelivery` 画；插件自己放的 `ui.Conversation` 里经 `renderUserMessage` 换人话气泡的画法，只在那个视图里、不改存储。主转录里的消息仍是产品画的：插件还不能往会话里写自己的条目（缺会话日志写入） |
| 会话头部小部件 | 开放 | — | `ui.sessionToolbar` 在会话标题栏加局部控件（环境卡片的开关），不能接管标题或布局 |
| 设置分区 | 开放 | — | `ui.settingsSection` 画在插件详情、设置导航或产品的某一页 |
| `/命令` | 开放 | — | 本体有 `/` 菜单和 `/clear`，插件经 `ctx.commands.provide` 列命令、把 `/名字 参数` 展开成要发的话；发出去的照常经过 `prompt.submit`；也可以自己办掉、不发消息（`handled`，如 `/btw`） |
| `@` 候选 | 开放 | — | `ui.mentions` 提供候选，选中只插入 token、不改写用户输入 |
| 页面（侧栏去处里的一行，点了占满正文区） | 开放 | — | 数据在插件自己那边（如定时任务的列表），经 `ui.remote()` 调逻辑入口读写；拿得到当前会话的视图 |
| 跟着会话的卡片（浮在转录右上角或在输入框正上方） | 开放 | — | 一直在变的一件事（todo 清单做到哪了），不随消息滚走；数据来自会话里的工具结果 |
| 环境卡片的一节 | 开放 | — | 卡片由内置插件 `plume.environment` 画（`ui.sessionToolbar` 的开关加 `lane` 卡片，自己只有打开方式、子会话、引用三节；后台任务、定时唤醒、压缩记录是 `plume.diagnostics` 登记的），别的插件经 `ui.environmentSection` 按 order 放一节、只做入口；卡片经 `ui.useEnvironmentSections` 拿到各节，不认是谁登记的。`attention` 让收着的开关挂圆点，只给两种事：等人决定的（建议的新会话），和会自己叫醒这个会话的（待触发的定时唤醒、在跑的监视）；普通在跑的东西不算 |
| 面板（和对话并排、插件长期占用的区域） | 开放 | — | 工作区显示当前会话的面板，标签按会话保留；子会话面板保留 owner 语义。数据来自会话里的工具结果（如子 Agent 面板）；要实时数据或操作的经 `ui.remote()` 调自己的逻辑入口（如终端） |
| 网页（面板里的 `<webview>`，人和 agent 操作同一页） | 开放 | — | 界面入口画 `<webview>`，挂上后交给逻辑入口；主进程只开 `ctx.pages` 这组原语（加载、读、点按、输入、截图、缩放、视口、对话框），地址栏、标签、书签都在插件里（如浏览器）；面板 `keepAlive`，换会话时不卸；`detachable` 的弹到面板窗口里重新挂上；工具结果能带图（`images`）给模型看 |
| 侧边聊天、子 Agent 的面板 | 开放 | — | 子会话（见「会话的边界」）+ 面板里用产品的对话视图（`ui.Conversation`） |
| 布局、会话列表、输入框本体、设置页框架 | 不开放 | 一直是产品的 | — |

输入框的 `@` 引用由本体统一画菜单和装饰，插件通过 `ui.mentions(provider)` 提供当前目录可用的智能体或技能 token；选中只写入草稿，不自动发送。通知菜单复用会话状态和插件页面角标，`ui.pageBadge` 的 `attention` 表示也需要在铃里提示。系统通知由主进程订阅事件，循环的 `idle` 事件表示后台运行、待送结果、登记的一次性后台任务都已收尾，避免把一轮之间的空隙报告为完成；挂着的监视、开发服务器、约好的唤醒不挡它。

## 2. 架构图

```
Electron
│
├─ 渲染进程  apps/desktop/src/renderer
│     产品界面：布局 · 会话列表 · 对话 · 输入框 · 面板区 · 设置
│     对话里的工具卡片        ◀── 插件的界面入口 dist/ui.mjs
│     面板区里的面板          ◀──    没注册的卡片用通用卡片
│        │
│        │ MessagePort · RPC（流式、取消）
│        ▼
├─ agent 进程  utilityProcess · packages/core/agent
│     AgentService：会话增删、发送、停止、回应审批、订阅事件
│     会话存储 · 模型调用 @plume/llm · agent 循环 · 命令的沙箱 @plume/sandbox（run.exec）
│        │ 在固定位置调用钩子
│        ▼
│     插件宿主：ctx · 钩子（洋葱）· 工具表 · 注册自动撤销 · 失败隔离
│        ▲                ▲                  ▲
│     内置插件（packages/builtin/*）：工具 plume.tools、提问 plume.ask-user、系统提示词、压缩
│     插件（插件仓库的 plugins/*，逻辑入口 dist/index.mjs）
│
│        ▲ parentPort · RPC：插件状态 / 关闭
│        │
└─ 主进程  apps/desktop/src/main
      窗口 · 启动和关闭 agent 进程 · 转交 MessagePort
      选文件夹对话框
      插件市场 · plume-plugin:// 协议（渲染进程从这里加载插件的界面入口）
```

一个插件最多两个入口：逻辑入口跑在 agent 进程，界面入口跑在渲染进程。两者同名，一起启用、一起关掉。

## 3. 进程与模块划分

| 进程 | 代码 | 做什么 |
| --- | --- | --- |
| 主进程 | `apps/desktop/src/main` | 窗口；启动和关闭 agent 进程；把渲染进程的 MessagePort 转交给 agent 进程；选文件夹对话框；插件市场（装、卸、更新），用 `plume-plugin://` 协议提供插件文件 |
| agent 进程（utilityProcess） | `packages/core/agent`，入口在 `apps/desktop` | 会话、模型调用、循环、AgentService；插件宿主；加载插件的逻辑入口 |
| 渲染进程 | `apps/desktop/src/renderer` | 产品界面；加载已启用插件的界面入口，把它们注册的卡片画进对话 |

进程之间走 `packages/infra/rpc` 的通道有两条：渲染进程 ↔ agent 进程（MessagePort），agent 进程 ↔ 主进程（parentPort）。

**为什么 agent 单独一个进程**：插件在 agent 进程内加载，可以做任何事。一旦死循环或崩溃，受影响的只有 agent 进程，窗口和主进程都不受牵连。主进程只做必须由它做的事（对话框、窗口、协议）。

| 包 | 跑在哪 | 职责 |
| --- | --- | --- |
| `packages/contract` | 只有类型 | 所有共享类型：插件 API（`@plume/contract` 给逻辑入口，`@plume/contract/ui` 给界面入口）、AgentService 及事件和视图 |
| `packages/core/agent` | agent 进程 | 产品本体：会话、模型调用、循环、AgentService；插件宿主 |
| `packages/core/llm` | agent 进程 | 模型调用，自成一体的包 |
| `packages/infra/rpc` | 三个进程 | 双向 RPC：流式返回、取消；不依赖第三方库 |
| `packages/client/ui` | 渲染进程 | 基础组件：卡片外框、代码块、diff 视图；产品界面和插件卡片共用 |
| `apps/desktop` | 主进程、渲染进程 | 桌面版：Electron 外壳、agent 进程入口、产品界面、冒烟验证 |
| 插件仓库的 `plugins/*` | agent 进程、渲染进程 | 内置插件以外的插件；经插件市场安装 |

## 4. 插件模型

### 插件的形状

插件是一个目录，最多两个 ESM 入口，都默认导出 `{ name, apply }`，`name` 必须相同：

- `dist/index.mjs`：逻辑入口，跑在 agent 进程，`apply(ctx)`；
- `dist/ui.mjs`：界面入口（可选），跑在渲染进程，`apply(ui)`。

插件只 `import type` 产品的类型，运行时的一切都从 `ctx` 或 `ui` 上拿。界面入口和产品共用同一份 React：渲染进程用 import map 把 `react`、`react/jsx-runtime`、`@plume/ui`、`@plume/styles` 指向产品正在用的实例；`@plume/ui/icons` 不共享，构建时只把用到的图标打进插件。

```ts
// 逻辑入口：src/index.ts
import type { Plugin } from "@plume/contract";

export default {
	name: "acme.redact-secrets",
	apply(ctx) {
		ctx.hook("tool.execute", async (input, next) => {
			const result = await next(input);
			return { ...result, output: redact(result.output) };
		}, { order: -100 });
	},
} satisfies Plugin;
```

```tsx
// 界面入口：src/ui.tsx
import type { ToolCardProps, UiPlugin } from "@plume/contract/ui";

function TodoCard({ result }: ToolCardProps) {
	const todos = (result?.details as { todos?: Todo[] } | undefined)?.todos ?? [];
	return <ul>{todos.map((todo) => <li key={todo.id}>{todo.done ? "☑" : "☐"} {todo.text}</li>)}</ul>;
}

export default {
	name: "example.todo",
	apply(ui) {
		ui.toolCard("todo_write", TodoCard);
	},
} satisfies UiPlugin;
```

界面入口拿不到 agent 进程里的东西，按 props 画。它需要的数据由逻辑入口放进工具结果的 `details`，随会话保存，重新打开会话也能画出来；不随会话保存的实时数据和操作（比如终端），由逻辑入口经 `ctx.serve` 开出来，界面入口用 `ui.remote()` 调。

### ctx 和 ui 的能力

`ctx`、`ui` 各有哪些成员、每个怎么用，以 `@plume/contract` 的类型（`PluginContext`、`UiContext`）和写插件的 skill [`skills/plume-plugin`](skills/plume-plugin/SKILL.md) 为准，这里不另列一份。设计上的三条：

- 所有注册都记在插件名下，停用时按账整体撤销，插件不需要自己清理。
- 插件之间经**服务**配合：一个插件 `ctx.provide(名字, 实现)`，别的插件把名字写进 `inject`、经 `ctx.use(名字)` 拿到。依赖的是服务名，不是某个插件；同一项服务只有一个生效的提供方，非内置的优先于内置的，所以装一个提供同名服务的插件就替换了 Plume 自带的实现。拿到的是宿主包过的一份，只有方法、改不动；要改它的行为，挂它的钩子或整个替换。服务只在插件之间：本体给的能力（`ctx.secrets`、`ctx.fetch`、`ctx.media`……）挂在 `ctx` 上，不是服务，插件换不掉。界面入口之间也一样按名字配合：一方 `ui.provide(名字, 实现)`，另一方在组件里 `ui.useService(名字)`（类型在 `@plume/contract/ui` 的 `UiServices`）；没有 `inject`，没人提供时拿到 `undefined`，后提供的生效、撤下恢复前一个，换了跟着重画。本体自己也要用的（打开链接、终端、文件预览）不走它，按种类登记成接手者。插件不按名字认另一个插件的工具和段（内置插件之间也一样，`pnpm check:plugins` 查）：要对某一类工具、段区别对待，或在提示词里点名别的插件的工具，按声明认（`ToolDefinition.category`、`PromptSection.category`、`details` 里 `@plume/contract` 定的形状）。
- 给人看的文字插件自带中英两份；交给产品显示的标题、说明给 `(locale) => string`，产品每次按当前语言调用，界面加一种语言时插件的写法不用变。发给模型的文字（工具结果、提示词）和日志不翻译。

### 生命周期

```
            ┌──inject 的服务有人提供了──┐
            ▼                            │
loading ──apply 成功──▶ active ──应用退出 / 停用──▶ disposed
   │  │                   │
   │  │                   └──用的服务换了提供方──▶ 停用后重新 apply（缺了就回到 waiting）
   │  └──inject 的服务还没人提供──▶ waiting
   └──apply 抛错 / 超时──▶ failed   已做的注册全部撤销，不影响其他插件；启用就再试一次，停用就成 disabled

disabled：配置里关掉，两个入口都不加载（内置插件不能关）
```

- **apply 超时**：非内置插件的 `apply` 15 秒不返回就按抛错处理，记 `failed`、写明超时，后面的插件照常加载；它之后再调 `ctx` 上的注册方法会抛错。内置插件不限时：它们是主路径，第一轮请求不能在它们装好之前发出去。
- **装、卸、启停排队**：运行中的装上、卸下、启用、停用一次做完一件，后来的等前面的做完（市场的装卸和界面的启停来自两条路，交错的话一个会撞上另一个装到一半的插件）。

- **发现**：插件目录下每个子目录一个插件。来源有三个：随应用发的**内置插件**（仓库的 `packages/builtin/`，打包时放进资源目录的 `builtin/`，直接从那里加载，市场不列），插件市场装进 `~/.plume/plugins/` 的，本地上传进 `~/.plume/local-plugins/` 的（「从本地上传」、`plume-plugin install`/`dev`）；同名时按内置、本地上传、市场装的顺序只认第一份。市场的目录在网上：插件仓库 plume-plugins 按平台打包、发到 GitHub Pages，装的时候下载这台机器那份、核对后解开（`apps/desktop/src/main/market-remote.ts`）；运行中装上、卸下、开关插件当场生效，不用重启。主进程还盯着后两处目录：`plume-plugin install`/`dev` 装进来的、手动放进或删掉的插件，按文件指纹当场加载、重新加载或卸下。
- **顺序**：先加载内置插件，再加载本地上传的和市场装的；同名目录只认先找到的。要用的服务还没人提供的插件先等着，提供方加载后再加载。加载顺序只影响工具重名时谁生效（后登记的生效，覆盖记一条日志；它停用或卸下后前一个恢复）。钩子各层的先后只看 `order`，和加载顺序无关。
- **关掉插件**：在 `<数据目录>/plugins.json` 里写 `{ "disabled": ["插件目录名"] }`，停用着的插件不导入、顶层代码不跑。内置插件关不掉、卸不了；要换掉它，装一个提供同名服务的插件，或在它的钩子外层接管。谁提供了哪些服务、同名的谁顶下了谁，宿主写进 `PluginStatus.provides`（`ProvidedService` 的 `replaces`、`replacedBy`），插件市场的详情页对装着的插件写出来。
- **界面入口跟着逻辑入口走**：agent 进程把已启用的插件列表告诉界面，界面只加载这些插件的 `ui.mjs`。界面入口加载失败只记日志，对应的卡片退回通用卡片。
- **信任**：插件和 agent 同进程、权限相同，即「插件可以做任何事」。界面入口跑在沙箱化的渲染进程里，没有 Node 能力。不加载项目目录里的插件，见第 8 节。

## 5. 钩子清单

### 钩子在循环里的位置

```
用户消息 ─▶ 钩子 prompt.submit（洋葱，最里层放行）─▶ 拦下：这一轮结束
            │
            ▼
         写进会话（放行时带的上下文跟在后面）
            │
            ▼
   ┌──── 循环的一步（最多 200 步）───────────────────────────────┐
   │ 1. 组上下文：系统提示词 + 历史消息 + 工具表                    │
   │       └─▶ 钩子 model.context（洋葱，最里层原样返回）           │
   │       └─▶ 钩子 context.compact（洋葱，里层是 plume.compaction）  │
   │           压了就重组一次上下文                                 │
   │ 2. 调模型，流式草稿推给界面                                    │
   │ 3. 回复写进会话；出错、被停下 ─▶ 这一轮结束                     │
   │ 4. 处理工具调用（相邻的只读调用同时跑，改动的单独跑）：        │
   │       └─▶ 钩子 tool.execute（洋葱，最里层执行工具）             │
   │    结果写进会话                                                │
   │ 5. 收尾：                                                      │
   │       └─▶ 钩子 step.end（洋葱，最里层是本体的续写、催促和重复提醒）│
   │    接着做 ─▶ 回到 1；结束 ─▶ 这一轮以它给的原因结束             │
   └────────────────────────────────────────────────────────────┘
用户停止：中止当前请求或工具；没执行的调用补一条「没有执行」的结果
回复出错、被停下、工具参数撞上输出上限：开了头的调用都补一条不执行的结果（协议要求每个调用都有回答）
```

### 组合方式：洋葱

每一层的形状是 `(input, next) => Promise<output>`：

- 调 `next(input')`：把（可以改过的）输入交给里一层；拿到结果后还可以再改。
- 不调 `next`、直接返回：等于拦下，里层和工具都不会执行。
- `order` 小的在外层；`order` 相同时按注册先后。
- 某一层抛错时，整个钩子失败，不会跳过这一层继续执行。原因是审批、脱敏这类层一旦被跳过，就等于放行或泄露，所以出错时按最严的方式处理。循环会把这次失败转成交给模型的错误结果，这一轮照常继续。
- `step.end` 失败或交回认不得的结论（漏了 `return`、`say` 不是一句话、`reason` 不认得）时循环按自然结论走（有工具结果就接着做，否则本体决定续写、催一句还是结束），界面提示出错的插件：它只能让循环多做，退回默认不会放过什么。
- `context.compact` 失败时转录里那一行写「压缩失败」，这一步照常发全文。
- 组合后实际怎么走的记进运行观察（`SessionObservation` 的 `hooks`，`HookTrace`）：宿主在 `PluginHost.run` 里逐层记下插件、`order`、结果（`next` 往里交、`answered` 自己给了结果、`failed` 出错，里层的错只记在出错的那一层）、有没有改输入（`changedInput`）和结果（`changedOutput`），以及最里层走到了（`ran`）还是被本体按外层的设定停下（`stopped`）。只记有没有改、不记改成了什么，观察里不因此多出参数和结果的内容；「改了」按值比，照原样展开再交下去不算。记的是 `tool.execute`、`tool.approve`（带调用 id）、`model.context`（带它组出的那次请求的 id，组了没发出去的不记）和 `prompt.submit`（单独一条，拦下的也记）；`step.end`、`context.compact` 不记。没有插件层的钩子调用不记。内置插件 plume.diagnostics 在调用轨迹的详情里画出来。
- 每个钩子的输入和工具的 `ToolRun` 都带着 `session`（`SessionScope`：`id`、`kind`、`parentId?`、`owner?`、`spawnedFrom?`、`project?`、`steward?`），本体照会话摘要填。`kind` 是 `top`（侧栏里的会话）、`child`（插件的子会话）、`standalone`（插件的独立会话），由本体按 `parentId`、`owner` 算出；本体和插件判断「是不是人的那段对话」都只看它，插件不用为找自己那条去 `ctx.sessions.list()`（钩子之外用 `ctx.sessions.get`）。

### 每个钩子

| 钩子 | 触发时机 | 输入 → 输出 | 最里层 | 典型用途 | 出错时 |
| --- | --- | --- | --- | --- | --- |
| `tool.execute` | 每个工具调用 | `ToolExecution` → `ToolOutput` | 执行工具表里的工具 | 审批、改参数、改结果、拦截、接管、重试、计时 | 这次调用以错误结果交给模型 |
| `model.context` | 每次调模型前 | `ModelContext` → `ModelContext` | 原样返回 | 按段加、换、删系统提示词，裁剪或改写消息，隐藏工具；每层交接时宿主按 `sections` 重拼 `systemPrompt` | 这一轮结束，界面显示错误 |
| `prompt.submit` | 每一轮开始，人的消息写进会话之前 | `PromptSubmit` → `PromptVerdict` | 放行 | 按内容拦下消息、给模型补上下文（会话开始时的说明、提交时的检查结果）、第一轮把会话挪进它自己的工作树（`cwd`） | 这一轮结束，界面显示错误，消息不写进会话 |
| `step.end` | 每一步收尾，回复出错、被停下的那步除外 | `StepEnd` → `StepVerdict` | 本体的自然结论：有工具结果接着做；没有的截断了接着写、空回复催一句，否则结束；够到重复警告线时带一句提醒 | 换掉本体的续写和催促、以出错或卡住结束 | 按自然结论走，界面显示错误 |
| `context.compact` | 每次发请求前（过完 `model.context`）；服务商说超长时再一次（`force`）；人敲 `/compact` 时（`force`、`manual`）；一轮干净收尾、有可分叉的主请求时（`idle`，宿主为它再经一遍 `model.context`） | `ContextCompact` → `CompactSummary`；有多满（`usage`）和估 token 的算法（`estimate`）由本体给，和上下文用量圆环是同一份 | 不压；紧挨着它的 plume.compaction 快满时先剪工具结果，不够再把较早的换成摘要 | 换一种压法（留多少、摘要怎么写、用什么模型） | 那一行写压缩失败，照常发全文 |
| `tool.approve` | 一个调用要问人时（工具的 `run.ask`、会改动的工具执行前、层的 `ask`） | `ToolApproval` → `ApprovalDecision` | 把审批卡弹给人、等人答；紧挨着它的 plume.approval 按帮我批准的风险规则放行（完全访问、`approved`、「以后不再问」本体已放行，到不了这里） | 放行自己的工具、按参数拒绝、换一套风险规则；提权只能拒绝，放行本体不认 | 这次调用以错误结果交给模型 |

```ts
interface ToolExecution {
	sessionId: string;
	session: SessionScope;     // 调用所在的会话：{ id, kind: "top" | "child" | "standalone", parentId?, owner?, spawnedFrom?, project?, steward? }
	cwd: string;
	call: { id: string; name: string; args: Record<string, unknown> };
	tool: { name: string; mutating: boolean; plugin: string };
	/** 外层已经放行的理由。设了它本体就不再问人（提权和层自己问的除外）。 */
	approved?: string;
	/**
	 * 外层要求这次调用不改动工作区（计划模式）。本体从设上它的那一层往里交时，`kind` 是 create、modify 的工具不再往里交，
	 * 以 `refusal` 作错误结果交回；别的照常交下去，`run.exec` 一律只读、`run.escalate` 直接拒。只能收紧，里层不去掉它。
	 */
	readOnly?: { refusal: string };
	/** 用户停止这一轮时中止。 */
	signal: AbortSignal;
	/** 弹出审批卡，等用户决定；经 tool.approve（`byLayer`）。 */
	ask(reason: string): Promise<boolean>;
	/** 执行中的输出，推给界面。 */
	progress(chunk: string): void;
}

interface ToolOutput {
	/** 交给模型的结果。 */
	output: string;
	/** 跟在 output 后面交给模型的图。 */
	images?: { data: string; mimeType: string }[];
	isError?: boolean;
	/** 只给人看、不交给模型的图：本体把大图挪进媒体目录，通用卡片画在 images 后面。 */
	shownImages?: ToolOutput["images"];
	/** 给工具卡片和插件自己用的结构化数据，存进会话，不发给模型。形状归插件，别人只认 `@plume/contract` 定的几个声明：
	 * checklist（ChecklistDetails）、job（BackgroundJobDetails）、fileView（FileViewDetails）、path / hunks（FileDiffDetails）。 */
	details?: unknown;
	/** 这次调用改了哪些文件（`FileChanges`：快照标识、绝对路径、没记全时的说明），由本体记下、填上，工具交的不算；存进会话（`ToolResultMessage.changes`），撤回、交付卡据它认。 */
	changes?: FileChanges;
	/** 这一步的结果写完以后这一轮就此结束；几个都带了时有 stalled 就按 stalled。 */
	terminate?: "done" | "stalled";
	/** 以后没人要读（没搜到、空目录）：压缩剪枝时换成一句「无结果」。 */
	uneventful?: boolean;
	/** 要照着做的说明（技能正文），不是观察：压缩不剪、不当作被顶替的旧结果清掉。 */
	instructions?: boolean;
}

interface ModelContext {
	sessionId: string;
	session: SessionScope;
	parentId?: string;         // 插件的子会话挂在哪个会话下面，同 SessionSummary.parentId；顶层会话不带
	owner?: string;            // 建这个会话的插件，同 SessionSummary.owner；子会话、插件的独立会话才有
	cwd: string;
	permissionMode: "ask" | "auto" | "full";
	readOnly?: boolean;        // 外层要求这一轮不改动工作区（计划模式），本体按它重算 shell
	shell: { kind: "posix" | "powershell"; label: string; sandbox: SandboxMode }; // 命令跑在哪个 shell、哪一档沙箱，本体每层交接时按 permissionMode、readOnly 重算
	systemPrompt: string;      // 就是 sections 用空行连起来
	sections: PromptSection[]; // { id, text, category?, files? }：identity、guidelines、boundaries、environment、tone、userInstructions、projectInstructions、workspace；提供它的插件按 id 改自己的，别的插件按 category（identity、guidelines……）找
	messages: Message[];
	tools: ToolSpec[];
}

interface StepEnd {
	sessionId: string;
	session: SessionScope;
	cwd: string;
	step: number;       // 这一轮的第几步，从 1 数
	stepsLeft: number;  // 是 0 时要接着做也会以「用满步数」结束
	reply: AssistantMessage;
	toolResults: ToolResultMessage[];
	signal: AbortSignal;
}

type StepVerdict =
	| { continue: true; say?: string }  // say：以用户身份说一句，会话里标成 synthetic；本来要结束时必须给
	| { continue: false; reason?: "error" | "stalled"; error?: string };  // 有工具结果时不起作用

interface ToolDefinition {
	name: string;
	description: string;
	/** JSON Schema。 */
	parameters: Record<string, unknown>;
	/**
	 * 模型常写错的参数名：规范名 → 别名（`{ path: ["file", "filePath"] }`）。本体在这一步的回复写进会话之前换成规范名、删掉别名，
	 * tool.execute 的层改写参数时写成别名的，往里交之前再换一次；钩子的各层、审批、转录、压缩和工具自己看到的都是同一份参数，按参数拦调用的守卫不会被换个写法绕过。别名不能是参数里的名字。
	 */
	aliases?: Record<string, readonly string[]>;
	/** 会改动工作区（写文件、执行命令）。没写 asks 的，本体据此在执行前问。 */
	mutating?: boolean;
	/** 工具自己在 execute 里经 run.ask 问。 */
	asks?: boolean;
	/** 导出会话成 Markdown 时这一次调用写成的一行；本体不认插件的工具名，说法跟着定义走。 */
	describe?(args: Record<string, unknown>): string | undefined;
	/** 导出时结果里要引在这一行下面的那段（子智能体的结论）。 */
	exportResult?(result: ToolResultMessage): string | undefined;
	/** 这次调用是替哪个工具调的（按需加载时的总入口）：导出时这一行按被调的写。 */
	forwards?(args: Record<string, unknown>): { name: string; args: Record<string, unknown> } | undefined;
	/**
	 * 对本机文件和命令做的是哪种活，只在这里写一处：`view` 读文件、`list` 列目录、`find` 按名字找、`search` 按内容搜、
	 * `create` 写出一个文件、`modify` 改已有的文件、`command` 跑命令、`watch` 长跑的命令、`job` 查看或停掉后台任务。
	 * 本体（重复检测在成功的写、改之后清零）、界面（转录的说法和归类、审批卡、文件签）、别的插件（只读的子智能体、计划模式、
	 * 提示词里点名「读文件的那件」）都从工具表里读它。不碰本机文件和命令的工具不标。
	 */
	kind?: "view" | "list" | "find" | "search" | "create" | "modify" | "command" | "watch" | "job";
	/**
	 * 哪一类工具：`mcp` 的上下文用量单独算一段；`checklist` 记进度清单（转录把它并进旁边那段活，界面经工具表拿到），`question` 停下来问人，`web` 只读地查网页，`delegate` 把活派给子智能体。
	 * 本体和别的插件不认工具名，只认这几样声明：别的插件按种类、类别在 `ctx.tools.list()` / `run.tools()` 里找它这会儿叫什么。
	 */
	category?: "mcp" | "checklist" | "question" | "web" | "delegate";
	execute(
		args: Record<string, unknown>,
		run: {
			session: SessionScope;
			cwd: string;
			signal: AbortSignal;
			progress(chunk: string): void;
			ask(content: ApprovalContent): Promise<ApprovalDecision>;
			/** ask 得到 "reject" 时原样交给模型的话：本体给的一句，说被拒了、别换个法子再做一遍，本体自己拒绝时也是这一句。 */
			rejection: string;
			/** 等人给一份数据（提问、计划、表单）：不经 tool.approve，和审批同一队；没答时说清是不答、过期还是停下。 */
			request<T>(input: { kind: string; title: string; payload?: unknown; waiting?: string }): Promise<{ answered: true; value: T } | { answered: false; reason: "declined" | "expired" | "stopped" }>;
			/** 这次调用跑命令用的 shell 和沙箱档（本体按权限模式、readOnly 选）。 */
			shell(): Promise<{ kind: "posix" | "powershell"; label: string; sandbox: SandboxMode }>;
			/** 在那一档沙箱里起一条命令；`denied(output)` 看输出像不像被沙箱拒了，像就交回给模型的那句说明，`mode` 是实际跑的那一档。`recordChanges` 时本体在命令前后对比工作区，记下改了什么。 */
			exec(command: string, options?: { cwd?: string; env?: Record<string, string>; recordChanges?: boolean }): Promise<RunProcess>;
			/** 申请这次调用更宽的一档：弹提权卡、只认人答，批了之后的 exec 才换档；不批时 message 是交给模型的说明。 */
			escalate(request: { mode: "workspace-write" | "danger-full-access"; justification: string; title: string; detail: string }): Promise<{ granted: true } | { granted: false; message: string }>;
			/** 替这次调用读写用户的文件（`read`、`readCommand`、`resolve`、`change`、`write`、`includeChanges`）：读写边界、改动快照在本体，改了哪些文件记在结果的 `changes` 上。 */
			files: RunFiles;
		},
	): Promise<ToolOutput>;
}
```

输入里可以直接放函数（`ask`、`progress`）和 `AbortSignal`，这是插件和循环同在一个进程带来的便利，不需要再定义一套跨进程协议。

### 界面扩展点

| 扩展点 | 注册 | 组件收到 | 多个插件都注册时 | 没注册或出错时 |
| --- | --- | --- | --- | --- |
| 工具卡片 | `ui.toolCard(tool, Component, { order, match })` | `call`、`status`、`progress`、`result`（含 `details`）、`fallback` | 精确工具名优先于 `match: "prefix"` 的前缀；`order` 小的生效，同 order 后注册的优先 | 让位给下一个注册者，都不行用通用卡片 |
| 工具的说法 | `ui.toolLine(tool, { verb, subject, file, note, command, job, group, times, icon })` | 不是组件：宿主的通用卡片、一段活、运行行按它说这个工具（「查找符号 runAgent」），按 `group` 归到插件起名的那一类（和读、跑命令、改文件接成一段），没有 `group` 时按工具定义上的 `kind`（读、列目录、找文件、搜、写、改、跑命令、长跑的命令、后台任务；agent 进程经 `AgentService.listTools()` 和 `tools` 事件把工具表带给界面）归类，没给 `verb`、`icon` 时用这种活默认的说法和图标；`file` 是这次对着的文件（读文件那一行说路径，回复里的文件签按它认），`note` 是模型写的说明，`command` 是跑的命令，`job` 是查看、停掉的后台任务；`times` 几次合起来数「次」。读文件、跑命令这些基本工具也由 plume.tools 这样登记，宿主不认工具名 | 后登记的生效，它撤下后前一个恢复 | 没登记时说工具名、自成一类、终端图标；`verb`、`subject` 取不出时退回工具名、只说动作 |
| 面板 | `ui.panel(id, Component, { title, description, icon, shortcut, order, multiple, listed, restore, detachable, keepAlive, available })` | `session`（标签归属会话的视图，新对话尚无会话时为空；子会话面板保留 owner 语义）；`cwd`（归属会话下一轮的目录，新对话是选中项目的目录）；`shown`（标签归属会话正在显示、面板区已展开且它是当前标签）；`tab`（所在标签的 id）、`setTitle`（改标签上的字）、`onClose`（关标签前问、收掉自己的东西） | 并列，开始页的列表按 `order` 从小到大；标签按会话保留，`multiple` 控制同一会话能否开多个；同一插件同一 id 后注册的替换前一次，快捷键重了归后注册的（它撤下后还给前一个），Plume 自己的快捷键（⌘B、后退前进、Esc，本体文件树的 ⌘P、文件面板的 ⌥⌘P）拿不走 | 没有插件注册面板时，面板区和它的开关都不出现；`available` 按目录和有无会话分别计算，答 false、待定或抛错只影响新开列表及快捷键新开，不隐藏、不卸载已有标签；渲染出错只在它那一格里提示，不影响别的面板 |
| 页面 | `ui.page(id, Component, { title, icon, order, topRow })` | `session`（当前会话的视图，没打开会话时为空）、`workspace`（当前的项目和工作目录，都没选时为空） | 并列，侧栏里按 `order` 从小到大，都在产品的「插件」前面；同一插件同一 id 后注册的替换前一次。`topRow` 的页面从正文卡片顶边开始，每一栏最上面放 `@plume/ui` 的 `PageTopRow`（顶行高、拖窗口、给红绿灯让位都在里面），宿主不再留标题栏那一行 | 渲染出错只在正文区提示；插件停用时侧栏那一行撤掉，后退、前进也跳过它 |
| 输入框的一格 | `ui.composerItem(id, Component, { side, order })` | `sessionId`（新对话里还没有会话时为空）、`running`，`model`（下一轮会用的模型：`id`、`name`、`contextWindow`；没有可用模型时为空） | 并列，`start` 排在「添加附件」和权限后面、`end` 排在模型选择前面，各按 `order` 从小到大；同一插件同一 id 后注册的替换前一次 | 返回 null 就不占位；渲染出错只撤掉它那一格 |
| 项目签那一行的一格 | `ui.composerChip(id, Component, { side, order })` | `sessionId`（新对话里为空）、`cwd`（下一轮在哪个目录跑；不属于项目的聊天为空）、`running`、`send(text)`（以人的身份发进当前会话，只在人点了写明要发什么的按钮时调） | 并列，`start` 跟在项目签后面、`end` 靠右，各按 `order` 从小到大；同一插件同一 id 后注册的替换前一次 | 同上 |
| 跟着会话的卡片 | `ui.conversationCard(id, Component, { order, lane })` | `session`（开着的会话的视图）、`placement`（对话列放得下 320px 的卡片外加 420px 正文时 `floating`，浮在转录右上角；放不下时 `inline`，在输入框正上方；`lane: true` 的卡片占右边 300px 的一列、总是 `floating`：对话列让出 324px 后还剩 520px 正文时停靠、转录和输入框让位，不够时浮在转录右上角，有它时别的浮着的卡片排到它下面）、`stop()`、`carryOn(text)`（只在人点了卡片上的按钮时调） | 并列，按 `order` 从小到大；同一插件同一 id 后注册的替换前一次 | 返回 null 就不占位；渲染出错只撤掉它那一张；新对话不画 |
| 最新回复的页脚 | `ui.turnFooter(id, Component, { order })` | `session` 和最后回复的 `timestamp`；只挂当前结束的一轮，随转录滚动 | 并列，按 `order`；同一插件同一 id 替换前一次 | 返回 null 不占位；独立错误边界；开始新一轮或翻到旧转录窗口时撤下 |
| 回复底下的操作 | `ui.replyAction(id, Component, { order })` | `sessionId`、`from`（这一轮开口那条消息的位置）、`to`（收尾回复的位置加一）；每一轮收尾的回复都有 | 排在产品的复制和分叉之间，按 `order`；同一插件同一 id 替换前一次 | 返回 null 不占位；独立错误边界 |
| 网址、文件签的打开方式 | `ui.linkOpener({ label, icon, web, takesClicks, file, open })` | 点了的网址（`{ url }`）或文件（`{ path }`，绝对路径）和链接所在的会话 | 按注册先后：网址右键菜单在系统浏览器那一行（写着默认浏览器的名字）后面各占一行，文件签悬停条各多一个按钮；点网址时第一个 `takesClicks` 的接手（Shift 点照旧系统浏览器）；每个插件一个，再注册换掉上一个 | `takesClicks`、`file` 抛错当作「不」，记日志；`open` 出错弹提示条 |
| 排队消息的菜单项 | `ui.queueAction({ label, icon, run })` | 人点了的那条排着的消息（`OutgoingMessage`）和它排在哪个会话；调之前宿主已经把它从本体的队列里拿掉（AgentService 的 `removeQueued`） | 主输入框排队条上，每条的「更多」菜单在产品的「编辑」后面各占一行，按注册先后；每个插件一个，再注册换掉上一个 | 没有插件登记时不出菜单，直接是「编辑」按钮；`run` 出错弹提示条，这条不放回排队 |
| 输入框的灰字建议 | `ui.composerHint(session => text)` | 当前会话的视图（新对话不问） | 按注册先后问，取第一个给出字的；每个插件一个，再注册换掉上一个 | 都没给时是产品的占位文字；抛错的跳过，记日志 |
| 欢迎页的那一行 | `ui.welcomeLine(locale => ({ text, source }))` | 当前界面语言；每次画欢迎页时问一次，可以是 Promise | 只问最后注册的那一个；每个插件一个，再注册换掉上一个；等答复时那一行先空着 | 没有插件、返回空、抛错时是产品默认的「要在某个项目里开发什么？」，抛错记日志 |
| 回复正文的过滤 | `ui.replyText(text => text)` | 一段回复正文（正在生成的也给） | 按注册先后串起来；每个插件一个，再注册换掉上一个 | 抛错的跳过，字照原样往下传；过滤后只剩空白的一段不画 |
| 侧栏会话行首的记号 | `ui.sessionMark(Component)` | `session`（会话摘要）、`fallback`（里面一层的记号，最里层是产品的空心圈）；只在空闲、未读之外问 | 按注册先后套起来，先注册的在外层；每个插件一个，再注册换掉上一个 | 返回 `fallback` 就是不说话；渲染出错的那一层让给里面的 |
| 删除确认框里的一句 | `ui.deleteNote((sessionId, locale) => text)` | 要删的会话 id、当前界面语言；人点了删除、确认框打开前问 | 按注册先后各占一行，接在产品那句后面；每个插件一个，再注册换掉上一个 | 最多等 600ms；没答上来、返回空、抛错的不写，抛错记日志 |
| 设置分区 | `ui.settingsSection(id, Component, { title, detail, icon, order, group, page })` | — | 并列。不给 `page` 的画进插件详情（「插件市场」里点开它的那一页）的「设置」一节，一节时不写小标题、几节时各写 `title`，`detail` 在组件上面；`page: "nav"` 的排在「基本」那组产品自己的几节后面，给了 `group`（只能和 `nav` 一起给）的排进那一组：`"agent"` 是「Agent 能力」组（「智能体」后面），`"data"` 是「数据」组「存储」前面，`"vcs"` 是「代码与版本控制」组，单独成页时页头由宿主画，`detail` 是标题下面那段介绍，`icon` 只画在这一行上；画进产品页的不占导航：`"general"` 是「常规」页「常规」卡里的一行（排在显示思考过程后面，名字和说明由宿主画、组件只画右边的开关，给不能停用的内置插件放自己的开关），`"personalization"` 画进「个性化」页的全局指令和语气之间，`"agents"` 画进「智能体」页的页头和「会话」组之间（这一页一直在导航里，本体的默认生图模型也在这一页），`"session-models"` 是「会话」卡里的一行，名字和说明（`title`、`detail`）由宿主画、组件只画右边的控件；`"extensions-skills"`、`"extensions-connectors"` 画进「插件市场」页的「技能」「连接器」两类（分类标签下面，整节由组件画），给管技能、MCP 连接器的插件；同一处按 `order` 排 | 渲染出错只在那一节里提示；插件停用时导航那一行（或页里那一节）撤掉，正在看它时回到「常规」 |
| 截图浮层 | `ui.screenOverlay(Component)`，配合 `ui.screen.start()`、`setShortcut()` | `session`（整屏快照、屏幕位置、色彩空间、指针位置）、`ready`、`finish`、`cancel`、`pin`、`copy`、`passThrough`、`onEscape` | 只有一个：后注册的生效，它撤下后前一个恢复 | 没注册时 `start()` 报错；组件 1.5 秒内没调 `ready` 这一次截屏作废 |
| 钉图窗口 | `ui.pinnedShot(Component)` | `image`、`ready`、`close`、`dragStart`、`dragMove` | 只有一个：后注册的生效，它撤下后前一个恢复 | 没注册或 5 秒内没调 `ready` 时窗口关掉 |
| 皮肤 | `ui.skin({ name?, mode?, light, dark })` / `ui.skin(null)` | —（浅色、深色各给一组 token 值，没写的沿用默认） | 只有一个皮肤：后注册的生效，它撤下后前一个恢复；可重复更新，null 只撤下自己的 | 默认 token；token 名、值、管理元数据不合法时整套不生效，抛错 |

```ts
interface ToolCardProps {
	/** 这次调用所在的会话。 */
	sessionId: string;
	call: { id: string; name: string; args: Record<string, unknown> };
	status: "approval" | "running" | "done" | "failed";
	/** 执行中的输出。 */
	progress?: string;
	/** 执行完才有。 */
	result?: ToolOutput;
	/** 通用卡片。认不出 details 时直接返回它。 */
	fallback: ReactNode;
}
```

八条规则：

- **后注册的生效**：同一个工具 `order` 小的在前；`order` 相同时后注册的在前（覆盖记一条日志），它撤下后前一个恢复。卡片的 `order` 默认是 0，写更小的 `order` 也能排到前面。
- **崩溃让位**：每张插件卡片包一层错误边界。渲染出错时让给同一工具的下一个注册者，都不行才用通用卡片；不影响对话里的其他内容。
- **认不出的数据退回**：`details` 可能来自旧版本存下的会话，卡片先校验，认不出就返回 props 里的 `fallback`。
- **共享基础组件**：除了 React，渲染进程还通过 import map 共享产品的基础组件包 `@plume/ui`（卡片外框、代码块、diff 视图、按钮、图标按钮、输入框，用法见 `spec/tech/components.md`）和类名包 `@plume/styles`，插件卡片和产品外观一致，也不用各自打包一份。
- **皮肤只改 token**：皮肤只能覆盖 `SkinToken` 列出的 token（就是 theme.css 里的 `--plume-*`），不能塞任意 CSS；宿主经 CSSOM 把值写进变量，按 `prefers-color-scheme` 分浅色、深色。颜色由四个种子（`bg`、`fg`、`accent`、`contrast`）推出整套面、线、字，不带 `name`、`mode` 的普通皮肤通常只给种子，用户覆盖仍优先。数据皮肤同时给出 `name` 和 `mode` 时，外观页实时显示当前皮肤及只读配色，暂时忽略用户种子和深浅模式；字体、代码外观、背景和其他偏好仍可调整，停止管理后恢复原配色。`root` 用于窗口最外层与透明停靠侧栏共用的底层，`sidebar` 只给 compact 浮出侧栏铺底；`accent-dim` 用于共享强调弱底。模式覆盖只存主进程内存，按渲染窗口 owner 释放；销毁、崩溃、重载只清掉该窗口的记录，最后一个释放后才恢复用户主题，不写 appearance.json。窗口加载前仍用默认底色。`mode` 支持 system/light/dark；同时提供 name、mode 但不传 token 时使用原生默认配色，和 null 撤回并恢复用户原偏好不同。
- **背景设置复用**：`ui.ChatBackgroundSettings` 是自包含组件，可传本地化的 `title`；管理全局的图片及显示位置、铺满／平铺、效果、浓淡偏好，外观页不再重复这一节。选图与拖入图片走宿主统一校验和存储，不向插件暴露任意路径，也不另建插件背景副本；停用插件保留背景设置。
- **界面订阅随入口收回**：`ui.effect(dispose)` 登记 apply 中开启的订阅（如远端 watch 的 cancel），停用、热重载、apply 失败时逆序清理，一项失败不妨碍其余。清理前先让入口失效，旧闭包之后调用 `ui.skin` 无效，避免异步结果复活已撤下的皮肤。组件内资源仍由 React effect 收回。
- **样式用 token**：产品用 Tailwind，颜色、字号、圆角、字体是 `@plume/styles` 的 `theme.css` 里的 `--plume-*` 变量，浅色深色跟随系统。插件单独构建，产品的 Tailwind 扫不到它们自己写的类名，所以插件不自己写 Tailwind 类：用 `@plume/ui` 组件和 `@plume/styles` 导出的类名组合（产品扫描这个包，这些类一定生成），其余写行内 style 并取 `var(--plume-*)`（例子见 `packages/builtin/todo`）；要伪类、伪元素或第三方库的样式表时，`.css` 按文字引入，插件自己挂一个 `<style>`（例子见 `plugins/terminal`）。

另外：

- 审批卡的位置、排队和收场是产品的（`renderer/conversation/ApprovalOverlay.tsx`），审批卡只有产品的一张，插件只能经 `ui.requestCard`（等人给数据）画整张卡；卡压在输入框正上方：人的视线本来停在那里，卡片占住自己的高度，对话照样能往上翻。标题栏是标题、类型小标签和收起箭头；正文是理由和要做的事（命令原文、diff、插件工具的参数）；底部是拒绝、以后不再问、允许一次，提权请求和没有可记对象的请求只有拒绝、允许一次。等待时工具卡片只标「等待确认」（`status: "approval"`）。人的回答经 AgentService 的 `respond(sessionId, toolCallId, decision)` 回到问的那一处；代管这个会话的插件经 `ctx.sessions.respond` / `answer` 答的是同一张卡，谁先到算谁的。同一格也摆 `run.request` 等人给数据的卡（`HumanRequest`，`type: "request"`，和审批同在 `SessionView.approval`）：插件经 `ui.requestCard` 按 `kind` 画，人交回的数据经 `answer(sessionId, toolCallId, value)` 回去，「不答」是 `respond(…, "reject")`；没有插件能画时是一张只有标题和「不答」的通用卡。同时要问的几张（审批和等人的混在一起，按问的先后）在本体排队，一次弹一张，标题栏写后面还排着几张（+N，`approval` 事件和 `SessionView.queuedApprovals`）；每张从问出来起计时，没人答时审批 5 分钟后按拒绝收场，`run.request` 30 分钟后得到 `expired`，截止时刻随卡片发出（`expiresAt`），标题栏有「m:ss 后失效」；停下这一轮时排着的、弹着的一起收掉（`run.request` 得到 `stopped`）。外框（收放的标题栏、倒计时、+N）是 `@plume/ui` 的 `ApprovalFrame`，插件画的卡也用它或 `ApprovalExpiry`。有卡在等时侧栏的会话行首是警示色的点（渲染进程从 `approval` 事件推出来、只在内存里，见 `renderer/sidebar/activity.ts`；子会话在等也标在父会话上），运行行说「等待你的批准」，等 `run.request` 的说「等待你的回答」（插件给了 `waiting` 就用它）。
- 界面入口到逻辑入口只有一条路：逻辑入口 `ctx.serve(api)`，界面入口 `ui.remote()`，中间是 AgentService 的 `callPlugin(插件名, 方法, 参数)`，只能调到自己那个插件。方法的最后一个参数是 CallContext；参数和返回值要能结构化克隆。第一个用它的是终端插件 `plume.terminal`：attach 返回一个流，先回放再接着推输出，取消就是断开，shell 照常跑。
- 工作区显示当前会话的面板，标签按会话保留；`session` / `cwd` 始终来自标签归属会话，子会话面板保留 owner 语义。`shown` 是标签归属会话正在显示、面板区已展开且它是当前标签。`available` 按目录和有无会话分别计算，只控制新开列表及快捷键新开，不隐藏、不卸载已有标签。
- 面板宽度和收起偏好在窗口内共享；全屏状态按会话保存，盖满工作区。窄窗口面板盖满工作区，按 Esc 收起；正文与面板放不下横排时上下排列。关掉最后一个标签收起面板区，可从标题栏重新打开开始页。面板只在工作区出现，设置页不画。
- 面板区顶上一排标签，每个会话一组；声明 `restore` 的标签按会话落盘，其余只在内存。「+」开一个「开始」标签：所有面板列在一张卡片里，每个一行（图标、标题、说明、快捷键），超过 6 个且面板够宽时分两列，点一行这个标签就变成那个面板（不是 `multiple` 的在该会话已开着就切过去）；`listed: false` 的不列在这里，只经 `ui.openPanel` 开。还没开过标签时打开面板区就是一个开始页。面板给了 `shortcut` 时，按它在当前会话切到那个面板（没开着就开一个），正在看它时再按收起面板区；在终端这类自己接管按键的面板里也生效。
- 所有 `keepAlive` 标签放在统一扁平常驻层，换会话、去设置页只隐藏、不重挂，后台仍收到标签归属会话的 `session` / `cwd`。未设 `keepAlive` 的组件卸掉不等于标签关了，回来仍是同一个 `tab`；跨卸载资源由插件按 `tab` 恢复。弹出、收回窗口仍会重新挂载，不调 `onClose`，独立窗口关闭仍先调 `onClose`，不改变既有弹窗语义。

## 6. 一次工具调用如何穿过洋葱

装上语言服务插件时，`tool.execute` 从外到内是这样（最里层的执行是本体的，要问时经 `tool.approve`）：

```
tool.execute(input)
┌ order 0     plume.lsp              等里层返回后，edit、write 的结果附上这个文件的错误 ─┐
│ ┌ 最里层（本体）  审批：会改动的调用经 tool.approve 问，下面几种不弹给人 ──────┐ │
│ │                 本体放行：完全访问、有 approved、以后不再问                   │ │
│ │                 plume.approval 放行：帮我批准下看不出风险的                    │ │
│ │                 不问：能证明只读的命令                                        │ │
│ │                 用户拒绝 → 直接返回「用户拒绝」，不执行                       │ │
│ │                 执行工具（命令跑在权限模式对应的沙箱里）                      │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **`bash cat hello.txt`**：语言服务层 → plume.tools 的 bash（能证明只读，不问；跑在权限模式对应的沙箱里）→ 执行 → 回到语言服务层，不是 edit、write，原样交回。
- **`edit hello.txt`**：语言服务层 → plume.tools 的 edit 校验完参数后问用户 → 输入框上方弹出审批卡，正文是这次改动的 diff → 用户允许一次 → 执行 → 回到语言服务层，结果后面附上这个文件的错误（只附错误、最多 10 条）。
- **谁来问**：写了 `asks` 的工具（plume.tools 的 write、edit、bash）校验完参数再问（注定失败的先报掉，不问人一个没法成立的问题），没写 `asks` 的 `mutating` 工具在执行前按参数问。本体先按权限模式放行这几种：权限模式是完全访问；外层设了 `approved`；问的对象（命令、文件的绝对路径、插件工具名）答过「以后不再问」，记在本机设置文件的 `alwaysAllow`（项目的 `.plume/config.json` 里写的不认），按发起审批的一方分开记、分开比对：工具经 `run.ask` 给的 `subject`（和本体替没写 `asks` 的工具在执行前问的工具名）记在注册这件工具的插件名下（`{ plugin, subject }`，插件名由本体按注册记，不取插件自己说的），只放行同一个插件的工具再问同一个 `subject`；本体自己给的 `subject`（`run.files` 读边界的 `read:<项目>`）记在本体名下（`{ subject }`），哪个工具来读都认这一份，插件写出同样的字符串既用不上它、也盖不过它。插件停用、卸载时它名下的批准留着：和它的数据目录、加密的配置一样按插件名认，再启用、重装后照旧有效；名下的插件不在时这些条目放行不了任何调用。名单经 `AgentService.getSettings` 的 `alwaysAllow` 给设置页列出，人经 `revokeAlwaysAllow`、`clearAlwaysAllow` 撤销。其余经钩子 `tool.approve`，内置插件 plume.approval 在 order 1000 放行帮我批准下 bash、write、edit 按风险规则（`packages/builtin/approval/src/risk*.ts`：递归删除、强制推送、写到项目外、密钥文件……）看不出风险的，命中的把理由写在卡上。能证明只读的 bash 命令根本不问。插件的层自己调 `ask` 只在完全访问下由本体放行，其余经 `tool.approve`，只能答一次。权限模式（`ask` 请求批准；`auto` 帮我批准，默认；`full` 完全访问）存在设置文件的 `permissionMode`，经 `AgentService.setPermissionMode` 改；项目的 `.plume/config.json` 只能把它往严了设，比本机宽的不认（`packages/core/agent/src/project-config.ts`），界面上是输入框工具栏左边的权限签，在签的菜单里或设置 › 常规的「完全访问」开关打开完全访问都要确认一次，往严了切不确认；项目收紧了的那档经会话摘要的 `projectPermission` 给界面，签上显示它（读这个会话的设置时重算，变了推 `sessions`）。用户拒绝时交给模型的结果说明被拒，并让它别换个方式做同一件事。
- **命令的沙箱和提权**：请求批准下 bash 跑在只读沙箱里，帮我批准下只能写项目目录和临时目录（macOS `sandbox-exec`，Windows 受限令牌，Linux 没有后端、这两档跑不了命令，Windows 上受约束的命令跑在 PowerShell 里、完全访问跑在 Git Bash 里；档位到沙箱的对应在本体的 `packages/core/agent/src/commands.ts`，工具经 `run.exec` 起命令、选不了档），完全访问下不进沙箱；外层设了 `readOnly`（计划模式）时一律只读；这台机器给不了沙箱时命令直接报错，不悄悄裸跑。命令被沙箱拒绝时，结果里告诉模型可以带上 `escalate`（`workspace-write` 或 `danger-full-access`）和 `justification` 重试一次。提权经 `run.escalate`，由本体查申请合不合规矩、弹卡、换档：放宽沙箱是另一件事，只认人在卡上答或代管这个会话的插件转达，完全访问、`approved`、「以后不再问」都不是对它的回答，`tool.approve` 上的层答放行本体也不认（拒绝照算）；批准只管这一次，不记进「以后不再问」。
- **要看最终结果的层放在最外层**：最外层看到的就是交给模型的最终结果，里面任何一层（包括拒绝提示）的输出都会经过它；比如把结果里的密钥换掉的脱敏层，该用很小的 order（如 -100）套在所有层外面。

## 7. 验证插件

| 插件 | 用到 | 做什么 | 冒烟验证点 |
| --- | --- | --- | --- |
| `plume.commands` | `ctx.commands` + `ctx.serve` + `ui.remote` + `ui.settingsSection` + `ui.useProjects` | 从项目和个人的 `.plume/commands`、`.claude/commands` 读 Markdown 命令供给 `/` 菜单，发送时展开（`$ARGUMENTS`、`$1`）；设置里「命令」一节列出个人或所选项目的命令，新建、打开、删除 | `PLUME_SMOKE_ONLY=hooks` 里设置 › 命令列出内置命令，切到项目后列出项目里的命令、「打开命令目录」换成项目的；单测在 `packages/builtin/commands/test`（frontmatter、同名遮蔽、参数展开） |
| `plume.hooks` | `prompt.submit` + `tool.execute` + `tool.approve` + `step.end` + `ctx.sessions.observe`（`turnEnd`，声明 `observe: "all"`）+ `ctx.sessions.onEnded` + `ctx.notice` + `ctx.serve` + `ui.remote` + `ui.settingsSection` + `ui.replyAction` + `ui.composerAbove` | 按 Claude Code 的约定跑用户和项目配的命令：SessionStart、UserPromptSubmit 拦消息或补上下文，PreToolUse 拦、问、放、改参数，PermissionRequest 在要弹卡时替人答（提权的放行不算），PostToolUse(Failure) 往结果后面接上下文，Stop 让它接着干（一轮最多三次），StopFailure、SessionEnd 只通知；用户钩子存在插件数据目录的 `hooks.json`，项目钩子在 `.plume/config.json` 的 `hooks`、按内容指纹信任后才跑；每次运行记进运行记录，出岔子的那一轮回复底下有按钮看；设置里「钩子」一节切范围、增删改、开关、信任，输入框上方提示待审核 | `PLUME_SMOKE_ONLY=hooks`：工作区里放一条没信任的项目钩子，输入框上方提示待审核，「去审核」到设置页信任它，再让它拦下一次 bash，回复底下有「钩子」按钮、点开是运行记录。单测在 `plugins/hooks/test`（退出码与 JSON 决定、工具前后、SessionStart 只跑一次、Stop 上限、设置读写、PermissionRequest、StopFailure 与 SessionEnd、项目钩子信任、运行记录）；宿主的 `turnEnd`、`onEnded` 在 `packages/core/agent/test/session-end.test.ts` |
| `plume.web` | `ctx.tools.register` + `ctx.dataDir` + `ctx.serve` + `ui.remote` + `ui.settingsSection` + `ui.toolLine` + `ctx.secrets`（加密 API key） | `web_search`（Tavily、DeepSeek、Brave、Exa、DuckDuckGo、DuckDuckGo 速答）和 `web_fetch`；后端和 API key 存在插件数据目录，key 经 `ctx.secrets` 加密落盘、不经界面 | 单测在 `packages/builtin/web/test`（选后端、解析结果、网页转文字、抓取的跳转和截断） |
| `plume.mcp` | `ctx.tools.register`（返回的撤销函数）+ `model.context` + `ctx.commands` + `ctx.sessions.onDeleted` + `ctx.dataDir` + `ctx.appDataDir`（Magpie 下发的服务）+ `ctx.plugins.list`（插件带来的 `.mcp.json`）+ `ctx.serve` + `ui.remote` + `ui.settingsSection` + `ui.requestCard` + `ui.toolCard`（按前缀 `mcp__`，和 `mcp_call`）+ `ui.DocumentPreview` + `ui.toolLine`（按前缀 `mcp__`，自成一类）+ `ctx.resources`（`mcp://`）+ `ctx.secrets`（加密密钥和 OAuth 令牌） | 按插件数据目录的 `servers.json` 连 stdio、Streamable HTTP、SSE 的 MCP 服务，Magpie 资源库下发的（数据目录的 `magpie/mcp.json`，只读，改要去 Magpie）和开着的插件随包带的 `.mcp.json` 一起读进来；连上后把工具登记成 `mcp__名称__工具`，服务声明的资源经 `mcp://` 给 read 读，彻底连不上、关掉、改启动方式时撤下；断了退避重连，重连期间工具留着；每次调用前经 `run.ask` 问人，对信任只读声明的服务，帮我批准下只读工具不问；`${NAME}` 空位、OAuth 登录；工具多了经 `model.context` 藏起来，换成 `mcp_search` / `mcp_call` 和一段目录（常驻的服务除外）；每个会话独立的服务按会话另起连接，会话删掉时关；服务的 prompt 进 `/` 菜单；服务中途要人填表时经那次调用的 `run.request` 弹一张 `kind` 为 `mcp-form` 的卡，界面入口按 kind 画成表，填的值随回答交回、按字段再核一遍；太长的结果全文、200 KiB 到 5 MB 的图存进会话的临时目录（`run.scratchDir`），模型拿到路径，图记在 `shownImages` 给人看，再小的图经 `images` 交给模型；结果里嵌着的 Office、SQLite 文档存进插件数据目录，工具卡片上经 `ui.DocumentPreview` 打开预览；「插件市场 › 连接器」（`page: "extensions-connectors"`）添加、就地编辑、开关、重连、填值、登录、删除，像密钥的环境变量和请求头不发给界面 | 冒烟的 `document-plugins` 段连一个 stdio 服务、调它的工具，主流程看「插件市场 › 连接器」画出来；单测在 `packages/builtin/mcp/test`（密钥名、草稿、空位、prompt 参数、按需搜索、工具名、Schema、结果转换和存全文、图按大小分档，连一个真的 stdio 服务：登记、审批、改名、关掉、起不来时的 stderr、断了重连、prompt、每个会话一份、缺值、服务反问的表单；嵌入文档的存取和上限） |
| `plume.documents` | `ctx.serve` + `ui.remote` + `ui.documentViewer` | 文件面板与插件经 `ui.DocumentPreview` 共用 Excel／ODS／SQLite 网格及 Word 页式预览；调用方负责目录权限和版本校验，只传数据。表格解析隔离进程、5 秒超时；Word 隔离文档样式与脚本 | 解析与超时取消测试、文件面板真实 Electron 冒烟 |
| `plume.skills` | `model.context` + `prompt.submit` + `ctx.tools.register` + `ctx.commands` + `ctx.sessions.onDeleted` + `ctx.plugins.list` + `ctx.resources`（`register`）+ `ctx.serve` + `ui.remote` + `ui.settingsSection` + `ui.FileDiff` + `ui.toolLine` | 从项目的 `.plume/skills`、`.claude/skills`、`.agents/skills` 和个人的 `~/.plume/skills`、`~/.agents/skills`，以及别的插件随包带的 `skills/` 读 `SKILL.md`，系统提示词加 `skills` 一段列名字和描述，`skill` 工具交回正文（上下文里已有的同一份不再给），没有可用的技能时藏起工具；登记 `skill://` 地址，read、ls 能读技能的正文和目录里的文件；技能写了 `allowed-tools` 的，生效期间经 tool.execute 拒掉别的工具；技能进 `/` 菜单，话里的 `/skill:名字` 经 prompt.submit 补一句；「插件市场 › 技能」（`page: "extensions-skills"`）按目录列个人的和插件带来的技能，选了项目（`ui.useProjects`）时连那个项目的，开关、打开、删除（插件带来的不给删），同名的看差异、改用另一个 | 冒烟主流程看「插件市场 › 技能」画出来、带项目选择；单测在 `packages/builtin/skills/test`（frontmatter、校验和遮蔽、偏好、`allowed-tools`、目录段、正文包装、插件带来的技能、`skill://` 的读、列目录和越界） |
| `plume.git` | `ctx.serve` + `ctx.provide`（`session.worktree`）+ `ctx.model.complete` + `prompt.submit`（`cwd`）+ `ctx.sessions`（`list`、`onDeleted`、`onArchived`、`setArchived`）+ `ui.remote` + `ui.panel` + `ui.composerChip`（`send`）+ `ui.notify` + `ui.openPanel` + `ui.draftInSession` + `ui.sessionMark` + `ui.deleteNote` + `ui.settingsSection` | git 命令在逻辑入口跑，提交说明让默认模型写；Git 面板有改动、历史、分支三个视图和提交与推送弹窗；项目签后面是分支签（点开切分支），右边是没提交的改动计数（点开 Git 面板）；操作失败弹提示条，「让 Agent 处理」把话写进输入框。新对话的输入框上有「工作树」开关，开着时第一轮在 `plume/session-*` 分支的工作树里跑，这样的对话里分支签换成工作树签：说出领先落后，菜单里合并到基分支（合完可以顺手归档这个对话）、从基分支同步、冲突交给这个对话解决、放弃同步；侧栏行首有 ⑂；删除确认框说出会留下什么；删除、归档时收回目录，取消归档、目录不在时检出回来；建不成时输入框上一直有提醒；设置里「工作树」一节；经服务 `session.worktree` 让别的插件开出的会话也进工作树（`plume.spawn-session` 卡片上的工作树开关用它） | 工作区变成仓库后，输入框上方出现分支签和改动计数；点改动计数开出 Git 面板，列出没提交的文件。单测在 `packages/builtin/git/test`（工作树的建、收回、检出回来、合并、同步、自动清理、合并后归档、经服务登记的会话都对着真的 git 仓库）；`PLUME_SMOKE_ONLY=spawn-session` 打开卡片上的工作树开关，新会话第一轮换进自己的工作树 |
| `plume.scheduled` | `ctx.serve` + `ctx.dataDir` + `ctx.sessions.launch` + `ctx.effect` + `ui.remote` + `ui.page` + `ui.pageBadge` + `ui.openPage` + `ui.openSession` + `ui.composerAbove` + `ui.useSession` + `ui.useProjects` | 定时任务的列表存在插件数据目录的 `tasks.json`；「定时任务」页面排在侧栏的去处里，经 `ui.remote()` 建、改、删、开关任务；逻辑入口每分钟看一次（启动 5 秒后先看一次），到点的开新会话发提示词，等第一轮结束判失败（出错、打转、用满步数），成没成都记下这次；「立即运行一次」不管到没到点；卡片上有运行状态、「打开上次会话」、失败原因；没人看见的失败在输入框上方说一句（查看、知道了），侧栏那一行挂数目 | 点「立即运行一次」开出会话、出现「打开上次会话」并能打开；假模型失败时输入框上方出现提示、侧栏挂上数目，「查看」回到页面、卡片上写着原因、数目清掉；打开任务后显示下次运行，存进插件的数据目录。单测在 `plugins/scheduled/test` |
| `plume.screenshot` | `ui.screen` + `ui.screenOverlay` + `ui.pinnedShot` + `ui.composerItem` + `ui.settingsSection` + `ctx.serve` | 截图浮层（框选、点选窗口、放大镜取色、`@plume/ui` 的标注器）、钉图、下载；设置存在插件数据目录；窗口列表由逻辑入口用 `osascript` 查 | 不进冒烟（浮层和钉图窗口会弹在开发者的屏幕上），手动验证：设置里出现「截图」一节；点「立即截屏」浮层亮出并画上定格的屏幕；拖出选区后有工具条；「置顶在桌面」开出和选区一样大的钉图窗口，能关掉 |
| `plume.memory` | `model.context` + `ctx.tools.register` + `ctx.sessions` + `ctx.model.complete` + `ctx.serve` + `ui.remote` + `ui.settingsSection`（`page: "personalization"`、`"session-models"`） | 用户记忆和项目记忆（`learn` 记下的教训、后台从旧会话总结的 MEMORY.md）存在插件数据目录，按段插进系统提示词，每个会话冻结一份；项目记忆关掉时对模型藏起 `learn`；后台总结默认关，开了以后最近在用的项目空闲满 5 分钟时跑，同一项目一天最多跑一次 | 不在冒烟里；单测在 `plugins/memory/test`（教训读写和合并、提示词格式、候选会话筛选、总结的写入规则） |
| `plume.subagents`（内置） | `ctx.sessions`（start / wait / report / steer / onStopped / models）+ 工具与钩子 + `ctx.tools.names` + `ctx.appDataDir` + `ui.remote` + `ui.composerAbove` + `ui.turnFooter` + `ui.toolCard` + `ui.toolLine` + `ui.agentDelivery` + `ui.Conversation` + `ui.Markdown` + `ui.settingsSection`（`page: "agents"`）+ `ui.ModelSelect` + `ui.useProjects` | `task` 登记后台任务立即返回 ID，每个父会话最多 4 个，多的排队；`task` 带 `resume` 复用原会话和身份，`stop_subagent` 停单个；结果通过受限运行句柄回报。定义文件在 `~/.plume/agents` 和 `<项目>/.plume/agents`，设置 › 智能体里新建、编辑、复制、删除、开关、选模型；派发时记下指令和工具的快照。模型偏好、关掉的种类、任务与最终报告存在插件目录，对话归宿主。面板有头像切换器、任务卡、回报和附件插话，失败后只准备续跑草稿；活动条随任务出现和退场 | 验证父会话先结束后被结果唤起、审批仍在主输入框上方、停止不复活、排队和续跑、任务消息来源、回报去重、附件和模型选择；宿主测试在 `packages/core/agent/test`，插件测试在 `packages/builtin/subagents/test` |
| `plume.side-chat`（内置） | `ctx.sessions`（建子会话、跑一轮、停、删）+ `ctx.tools.register` + `prompt.submit` + `model.context` + `tool.execute` + `ctx.commands`（`handled`）+ `ctx.serve` + `ui.remote` + `ui.panel`（`multiple`）+ `ui.useSession` + `ui.Conversation`（`tasks`）+ `ui.queueAction` | 「侧边聊天」面板一个标签一段侧边聊天：交给主会话的事在转录和输入框之间画回执条；每问一句附上主会话上次之后的新内容，更早的用 `read_main_chat` 翻；身份、准则换成侧边聊天的，工具只留读主会话、交出去、控制主会话、读写文件、跑命令、查网页；关标签就删掉那段；`/btw 问题` 另开一段问这句话；排队条上排着的消息经「更多 › 在侧边聊天中打开」拿到最早那段侧边聊天去问（还没有就新开一格），附件跟着走 | `/btw` 问的话不进主对话，新开一格侧边聊天，回答画在那里；侧边聊天的请求里有主对话的内容、没有 `task`。单测在 `packages/builtin/side-chat/test` |
| `plume.ask-user`（内置） | `ctx.tools.register`（`run.request`）+ `ui.requestCard` + `ui.toolLine` | `ask_user`：模型停下来问人一个它自己答不了的问题；选项带说明和推荐、单选或多选、自己写、跳过（有默认项时采用它）；提问卡压在输入框上方，回答随 `run.request` 交回、按问题再核一遍；没人答 30 分钟后按没有答案收场 | 新对话里假模型调 `ask_user`，提问卡有标题、推荐、倒计时、「跳过将采用」，运行行说「等待你的回答」，按 1 选第一项确认后模型拿到那一项。单测在 `packages/builtin/ask-user/test` |
| `plume.plan`（内置） | `tool.execute`（拦截、`readOnly`）+ `ctx.tools.register`（`run.request`）+ `prompt.submit` + `model.context` + `step.end` + `context.compact` + `ctx.commands`（`handled`）+ `ctx.serve` + `ctx.provide`（`session.plan`）+ `ui.remote` + `ui.composerItem` + `ui.requestCard` + `ui.panel` + `ui.environmentSection` + `ui.toolLine` | 计划模式：按会话的开关（输入框开关、`/plan`），开着时每次调用都带 `readOnly`（连同拒绝时给模型的话），本体据此拒绝写、改文件的工具（定义上 `kind` 是 `create`、`modify`），命令进只读沙箱、不许提权，子会话受父会话管；`submit_plan` 交 Markdown 计划，完全访问也弹给人，计划卡上拒绝、修改、接受（带评论作注意事项）、接受并开启自动模式，批准就地关掉开关；开着时提示词多一段，漏交计划提醒一次；「计划」面板读计划、划线评论、切换批准过的几份；环境卡片里「计划」一节列出批准过的每一份，点了在面板里打开；压缩时批准的计划接在摘要后面；经服务 `session.plan` 告诉别的插件一个会话照着做的那份计划（交给新会话的归新会话） | 开着时改文件被拒、命令写不进去；交计划弹计划卡，接受后同一轮接着改，修改意见回给模型重交，拒绝后停下。单测在 `packages/builtin/plan/test` |
| `plume.terminal` | `ctx.serve` + `ui.remote` + `ui.panel`；`dependencies` 里的 node-pty 随 `dist/` 一起装 | shell 跑在 agent 进程，比面板活得长；「终端」面板一个标签一个 shell，xterm 经 `ui.remote()` 连上，attach 先回放再接着推输出 | 在终端面板里跑一条命令，输出画回了 xterm、shell 起在会话的工作目录；⌃` 收起、再打开 |
| `plume.browser`（内置） | `ctx.pages`（含 `chromeLogins`）+ `ctx.tools.register`（`run.ask`、结果带 `images`）+ `ctx.sessions`（`onDeleted`、`list`）+ `ctx.dataDir` + `ctx.serve` + `ui.remote` + `ui.panel`（`multiple`、`keepAlive`、`detachable`）+ `ui.openPanel` / `ui.closePanel`（`tab`、`background`）+ `ui.draftInSession` + `ui.linkOpener` + `ui.settingsSection` + `ui.toolLine`；随包的 `skills/browser` | 「浏览器」面板一个标签一页：地址栏兼搜索框（也开本机的 `.html`）、书签、缩放、视口尺寸、检查元素和框选区域（选中的连同要求和截图放进输入框）、开发者工具，能弹到独立窗口；只给最近看过的三个会话和 agent 正在用浏览器的会话挂着页面；`browser_open`（先问一句，也开本地 `.html`）、`browser_act`、`browser_tabs`、`browser_viewport`、`browser_screenshot` 操作同一页，面板上画 agent 的光标；回复里的网址右键、`.html` 文件签能开进内置浏览器，设置里可让点网址默认开在这里、从 Chrome 同步登录状态；工具调用期间页面的对话框由宿主替它答、写进结果；页面开的新窗口成后台标签，跳去非网页地址的给「在系统浏览器中打开」；各会话的标签分开，会话删了一起关；设置存在插件数据目录的 `browser.json` | 冒烟里从开始页开浏览器标签、地址栏打开本机的一页，标签写着页面标题；假模型经 `browser_act` 读到按钮那一行、点它时 confirm 被取消并写进结果、点链接后等到新的一页，`browser_screenshot` 的结果带着图，面板上有光标；地址栏打开磁盘上的 `.html`；标签弹到独立窗口、页面在那边接上，收回后回到主窗口；右键回复里的网址在内置浏览器开出新标签；经菜单关掉标签后页面没了 |
| `plume.todo` | `ctx.tools.register` + `model.context` + `step.end` + `ui.conversationCard` | `todo_write` 工具（整表替换，同一时刻最多一项在做，清单放 details 的 `checklist`，即宿主认的 `ChecklistDetails`）；单独调一次时结果末尾说一句（`run.calls`）；回答完清单还有一项在做时问一次（清单收尾），只补勾清单的那次以 `terminate` 结束这一轮、转录里不画；20 步没更新清单时问一句进度；转录里不另画卡片，经 `ui.toolLine` 登记说法，本体按工具定义上的 `category: "checklist"` 把调用并进一段活、说成「更新清单 1/2 · 在做的那一项」；清单卡片跟着会话，标题行是在做哪一步、勾到第几项，在做的那一步按这一轮在跑、被停下、失败、收了尾画不同的记号，旁边是暂停、重试这一步、继续的按钮，全勾完自己收走 | 模型收到的工具里有 todo_write；这一轮收了尾第二项没勾上，清单卡片浮在转录右上角、标题行是「停在 · 把 hello 改成 hi」；打开面板区后卡片回到输入框正上方；转录里没有 todo 的卡片 |
| `plume.usage` | `ctx.model.usage` + `ctx.serve` + `ui.remote` + `ui.settingsSection`（`group: "data"`、`detail`） | 设置 › 数据里「存储」上面的「使用统计」：每次计费的调用按区间、供应商、搜索筛选，五格指标、按模型或供应商拆的堆叠柱状图和系列列表、Token 构成和耗时构成两张环图、缓存未命中卡片、一年的热力图、自动刷新、导出 CSV；图表、模型品牌标和样式都是插件自己的 | 装上后设置导航里出现「使用统计」，读出前面几轮的花销、今天的调用画成柱子 |
| `plume.image` | `ctx.tools.register`（`run.ask`、进度、结果带 `images`）+ `ctx.model.findImageModel` / `image` + `ctx.media` + `model.context` + `ctx.sessions`（`list`、`messages`、`onDeleted`）+ `ctx.serve` + `ui.remote` + `ui.toolCard` + `ui.toolLine` + `ui.page` + `ui.mediaUrl` / `openImage` / `saveImage` / `copyImage` / `draftInSession` / `revealToolCall` | `image_generate` 出图、改图，对话里的卡片边画边显示；侧栏「画廊」按天汇总全部对话画的图，看来历、改图、跳回对话 | 冒烟的 `gallery` 段装上它；工具、来历、进度估计和画廊布局的单元测试在 `plugins/image/test/` |

另外，冒烟时检查 edit 的审批卡正文里有这次改动的 diff，权限签默认是「帮我批准」、菜单里有三档，切到「请求批准」后 edit 弹出审批卡。

## 8. 不做的事

- **替换模型调用或循环**：不开放，这是产品的边界。
- **更多钩子**：每加一个钩子，先要有一个真实插件需要它。
- **项目级插件**：不加载项目目录里的插件（`.plume/plugins`）。仓库是别人也能改的，插件又能做任何事（见第 4 节「信任」），要加载得先有信任机制（像项目钩子那样先审核再生效）和按会话或按项目启用；有真实需求时再做。
- **插件隔离**：插件和 agent 同进程，插件崩溃会带走 agent 进程。窗口不受影响，会提示 agent 进程退出；自动重启以后再做。
