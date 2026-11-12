# 插件原语

管本体（`packages/core`、`packages/contract`、`packages/client`、`apps/desktop/src`）给插件什么、怎么给：本体只给原语，功能由插件用原语拼出来；本体按插件的声明和接口的形状办事，不按名字认具体插件。给 `@plume/contract` 加插件接口、在本体里为插件的东西分支、加钩子／服务／界面扩展点之前读。每个接口怎么用见 [`agent-extension.md`](../../agent-extension.md) 和 skill [`plume-plugin`](../../skills/plume-plugin/SKILL.md)，这里只写准入规则。

## 开发准则

### 原语清单

新需求先拆成下面这些原语的组合，拆得出来就不加接口。

逻辑侧（逻辑入口的 `ctx`、工具的 `run`）：

| 原语 | 是什么 | 接口 |
| --- | --- | --- |
| 钩子与工具 | 在循环的固定时机插入行为；给模型加能力 | `ctx.hook`（`prompt.submit`、`model.context`、`tool.execute`、`tool.approve`、`step.end`、`context.compact`、`session.rewind`），`ctx.tools.register` |
| 等人 | 一次工具调用停下来，等人给一份数据（提问、计划、表单）；不是审批，权限模式管不着 | `run.request`，界面 `ui.requestCard` 按 `kind` 画 |
| 过闸 | 会改动的调用放不放行；哪些要问、权限模式的含义、提权只认人答（或代管插件转达）是本体的 | `run.ask`、`ToolExecution.ask`、钩子 `tool.approve`，界面 `ui.approvalCard` |
| 会话 | 建子会话或独立会话并发起一轮，开新的顶层会话，读会话，观察会话的运行（默认只看和自己有关的会话，看全部要声明）；会话是哪一种 | `ctx.sessions`，`ctx.sessions.observe` 和 `Plugin.observe: "all"`，钩子输入和 `ToolRun` 上的 `session`（`SessionScope.kind`） |
| 代管 | 插件开一个顶层会话并代管它：往里转话（和人同一条队、不插话），替人答它和它下面的子会话弹着的卡（审批、提权、等人，不含「以后不再问」）；只能动自己代管的，人随时在会话菜单里停止代管，那时弹着的卡只能人答 | `ctx.sessions.launch({ steward: true })`、`ctx.sessions.post` / `respond` / `answer`，`SessionScope.steward`；卡和回复经 `ctx.sessions.observe` 读；停止代管是 `AgentService.revokeSteward` |
| 送达 | 调用答完以后才有的结果送回会话（子会话交回、后台命令、新会话交回） | `ToolRun.background()`、`ctx.sessions.report`、`LaunchedSession.reportBack`，形状都是 `DeliveryInput`；那一行由交它的插件经 `ui.agentDelivery` 画 |
| 本体能力 | 本体替插件做、插件换不掉的事：挂在 `ctx`（工具调用里是 `run`）上，不借服务的壳。能被插件换掉的话，界面和文档对它的保证就不再成立 | `ctx.secrets`（加解密插件的密钥，钥匙由本体按插件名派生）、`ctx.fetch`、`ctx.media`、`ctx.trash` |
| 服务 | 插件之间按名字配合，装一个同名的就换掉实现；只留给插件之间，本体给的能力不做成服务 | `ctx.provide`，用的一方写进 `inject` 再 `ctx.use` |

界面侧（界面入口的 `ui`）：

| 原语 | 是什么 | 例子 |
| --- | --- | --- |
| 槽位 | 位置是本体的，插件往里放内容 | `ui.panel`、`ui.page`、`ui.composerItem`、`ui.conversationCard`、`ui.settingsSection`、`ui.replyAction` |
| 接手者 | 某一类东西由谁画、谁打开，按工具名、`kind`、扩展名登记，没人登记时本体有通用的 | `ui.toolCard`、`ui.toolLine`、`ui.requestCard`、`ui.agentDelivery`、`ui.documentViewer`、`ui.linkOpener` |
| 导航 | 人点了按钮以后去哪 | `ui.openPanel`、`ui.openPage`、`ui.openSettings`、`ui.openSession`、`ui.draftInSession` |
| 数据 | 界面拿数据只有三个来源 | 工具结果的 `details`（随会话保存）、本体的实时状态（`ui.useSession`、`ui.contextBreakdown`）、插件自己的逻辑入口（`ctx.serve` / `ui.remote()`） |
| 服务 | 插件的界面入口之间按名字配合，本体只记账、不用它 | `ui.provide`，用的一方 `ui.useService`；类型在 `UiServices` |

新的界面需求先归进这五类，归不进去才加方法。

### 什么时候可以给 `@plume/contract` 加东西

- **先有真实插件要用。** 要加的那个插件写得出来、没有它就做不成，才加；「以后可能有人要」不算（[`safety.md`](../safety.md) 第 2、8 条）。
- **接口说的是能力，不带插件名。** 名字、注释、字段说的是「子会话交给父会话的任务」，不是「侧边聊天的回执」；字段里不出现某个插件定的数据形状，插件自己的数据放 `details`、`payload`，本体不读。
- **不借已有类型加标志位表达另一种东西。** 一个类型加了标志位、再关掉原来的语义，等于两种东西挤在一个类型里，每个经过它的地方都要分辨。反例：
  - 审批的 `userOnly`：提问、计划、表单借审批卡，关掉审批语义，答案走旁路，`tool.approve` 的每一层都收到不是审批的请求。现在是单独的原语「等人」。
  - 送达的 `kind: "job" | "session" | "wakeup"`：后台命令、新会话交回、定时唤醒各占一个值，本体按值分支画。现在本体只认通用字段，那一行由交它的插件画。
  - 侧边聊天借排队消息（`origin: "child"`）把活交给主会话，本体随后为它长出回执条、`HandedTask`、`mainChat`。现在留下的 `QueuedMessage.origin`、`UserMessage.fromPlugin` 只是来处标注（安全边界，模型据此知道这不是用户的话），交过去的事走到哪是通用的 `ChildTask`，画成什么样归建子会话的插件。
- **本体认形状和声明，不认名字。** 本体要对某类工具、段、结果区别对待时，让插件声明：`ToolDefinition` 的 `describe`、`exportResult`、`forwards`、`kind`、`category`，`PromptSection.category`，`ToolOutput` 的 `uneventful`、`instructions`，`details` 里 `@plume/contract` 定的形状（`ChecklistDetails`、`BackgroundJobDetails`、`FileChangeDetails`、`FileViewDetails`），界面的 `ui.toolLine`（`file`、`note`、`command`、`job`、`apart`、`group`）。读文件、跑命令这些基本工具也一样，由 plume.tools 声明。同一件事只声明一处：工具做的是哪种活（`kind`：读、列、找、搜、写、改、跑命令、长跑的命令、后台任务）写在工具定义上，本体（重复检测）、界面（经 `AgentService.listTools()` 和 `tools` 事件拿到工具表：转录、审批卡、文件签）、别的插件（`ctx.tools.list()`、`run.tools()`）都读这一份，`ui.toolLine` 不再写一遍；是不是记进度清单（`category: "checklist"`）也一样，转录、别的插件都从工具表里认。本体代码里不写插件名、插件的工具名、段名、标签名；内置插件同样不认别的插件（[`safety.md`](../safety.md) 第 2 条，见下面「插件之间怎么互相用」）。插件要的范围比默认大时也靠声明，不按名字放行：看全部会话的运行观察写 `Plugin.observe: "all"`，内置插件（plume.diagnostics、plume.tools）和市场插件写的是同一个字段。

### 已定的例外

下面这些不算违规，也不能拿来类推出新的例外；要加新的，先改这一节、说出理由。

- **只有一个插件在用、但按能力命名的接口。** `ToolRun.parent` / `ParentSession`、`AgentService` 的 `queueTask` / `retryTask` / `dismissTask`、`ToolCardProps.handToParent`、`ui.queueAction`、`ui.quoteAction` 现在只有侧边聊天用。可以留，条件是：名字、注释、类型说的是能力（「子会话够得着它的父会话」「排队消息的菜单项」），不提用它的插件；本体不知道是谁在用；换一个插件来用不用改接口。哪一条不满足，就回到上一节按违规处理。
- **代管先由测试插件验证。** 真实需求是插件仓库里的 plume.im（它的 README 写着缺「创建或映射 Plume 会话」），但这一轮只做了本体接口，plume.im 还没接上；接口由测试插件 `packages/testing/steward-probe`（不随应用发，冒烟 `steward` 段装它）和 `packages/core/agent/test/session-steward.test.ts` 验证。plume.im 接上时发现不够用，按上一节改接口，不在插件里绕。

### 插件之间怎么互相用

- **逻辑侧走服务。** 一方 `ctx.provide(名字, 实现)`，另一方把名字写进 `inject`、`ctx.use(名字)`；类型写在 `@plume/contract` 的 `Services` 里。依赖的是服务名，不是插件名。插件不按名字找另一个插件，不认另一个插件的工具名、段名、面板 id、`details` 里它自己定的形状；内置插件之间也一样，内置插件不认市场插件。
- **按声明认别的插件的东西。** 要对别的插件的某一类工具、段、结果区别对待，按上一节那些声明认：收窄工具表时留下 `category: "web"` 的、只给只读的子智能体 `kind` 是读、列、找、搜的，计划模式拒绝 `kind` 是写、改的，子会话换身份时换掉 `category: "identity"` 的段，压缩不剪 `instructions` 的结果、按 `details.fileView` 认出被后来的读顶替掉的旧读（不认读文件工具的参数和它自己的 `details`），找起后台任务的那次调用认 `details.job`。
- **提示词里点名别的插件的工具，按类别现找。** 「用 `todo_write` 记下步骤」「拿不准就用 `ask_user` 问」「用 `read` 读这个文件」这种话写死名字，那个插件被换掉或停用时就是错的。按类别、种类在 `ctx.tools.list()`（工具里 `run.tools()`）找它这会儿叫什么，`model.context` 里再和这一轮的 `input.tools` 对一下，找到了点名，找不到就换一种不靠它的说法；意思不变，不为去掉名字把话说含糊。现有的类别：`checklist`（记进度清单）、`question`（停下来问人）、`web`（只读地查网页）、`mcp`；种类见 `ToolKind`。缺一类时按上面四条准入加一个值，不加插件名。只关乎怎么用某件工具的话（参数怎么给、什么时候不该用）写进那件工具自己的说明，由提供它的插件说。
- **自己的事自己说。** 只跟某个插件的能力有关的提示词（压缩后计划还在、清单怎么记），由那个插件经自己的钩子说（计划模式经 `context.compact` 把批准的计划接进压缩头），不让另一个插件替它记着。
- **界面侧也走服务，但先看是不是接手者或槽位。** 本体自己也要用的，做成接手者：本体给一个组件或入口，插件按种类登记，本体和别的插件都经本体用（`ui.documentViewer` 登记、`ui.DocumentPreview` 使用；`ui.linkOpener`、`ui.terminalOpener` 由本体的入口调）。许多插件各放一份、由一个插件画出来的，是槽位（`ui.environmentSection` 由宿主记账、包错误边界，画环境卡片的插件经 `ui.useEnvironmentSections` 拿）。只在「一个插件提供、另一个插件直接拿来调」、本体不用它时走界面侧服务：一方 `ui.provide(名字, 实现)`，另一方在组件里 `ui.useService(名字)`；类型写在 `@plume/contract/ui` 的 `UiServices` 里，服务名说能力（`background.jobs.view`：plume.diagnostics 提供打开后台任务，plume.tools 画的后台命令那一行点了用它）。和逻辑侧不同的地方：没有 `inject` 和加载先后，没人提供时拿到 `undefined`，用的一方不给那个入口；后提供的生效（界面入口按先内置、再装上的顺序加载，装上的就换掉内置的），撤下恢复前一个；提供方换了用的一方跟着重画；拿到的是提供方那一份，宿主不包。不为一对插件再加一事一接口。

## 检查点

- `pnpm check:plugins`（[`scripts/check-plugins.mjs`](../../scripts/check-plugins.mjs) 的规则 4、5、6，名单和匹配方式在 [`scripts/check-core-names.mjs`](../../scripts/check-core-names.mjs)）：
  - 本体代码里不出现插件名：内置插件名从源码读，市场插件名登记在脚本里；以插件名打头的面板 id 也算。注释不查。
  - 本体代码里不按名字认插件的工具、段名、送达标签：名单登记在脚本里，plume.tools 的基本工具和 plume.prompt 的段名也在名单里。提示词字面量里用反引号括着的名字（`` `task` ``）也算。
  - 内置插件的源码（不含测试）和它带给模型的技能（`skills/**/*.md`）里不出现别的内置插件、市场插件的插件名，和登记在它们名下的工具名、段名、标签；自己的不算。
  - 正当的命中登记进脚本的 `ALLOWED`，写明理由；不放宽规则。
- 检查查不到的，评审时对一遍：
  - 新接口的名字、注释、类型里有没有某个插件的名字或数据形状。
  - 有没有在已有类型上加标志位来表达另一种东西。
  - 本体有没有按全小写的单词比较插件的东西（检查只在比较、`case`、集合里查这类词，`identity`、`skills` 这些段名不查），有没有按插件的标签解析结果文字。
  - 内置插件有没有按段名（`identity`、`guidelines` 这类和日常用词撞的不在名单里）换别的插件的段，有没有读别的插件 `details` 里它自己定的字段（字段名不在名单里）。
  - 名单里没登记的名字检查也查不到：新插件、新工具、新段名要登记进 `scripts/check-core-names.mjs`。
  - 加接口时那个真实插件是哪一个。

## 事实来源

- 接口：`packages/contract/src/plugin.ts`（`PluginContext`、`ToolRun`、`ToolDefinition`、`PromptSection`、`Services`）、`packages/contract/src/ui.ts`（`UiContext`）、`packages/contract/src/service.ts`（`AgentService`、`QueuedMessage`、`ChildTask`）
- 检查：`scripts/check-core-names.mjs`、`scripts/test/check-core-names.test.ts`
- 按类别找别的插件的工具的例子：plume.plan（`packages/builtin/plan/src/index.ts` 的 `toolOf`）、plume.subagents、plume.browser
- 按结果里的声明认别的插件的结果的例子：plume.compaction（`stale-results.ts` 认 `FileViewDetails`，`task-context.ts` 认 `ChecklistDetails`）、plume.delivery（`record.ts` 认 `FileChangeDetails`）、plume.diagnostics（`entries.ts` 认 `BackgroundJobDetails`）
- 按种类找别的插件的工具的例子：plume.subagents（`packages/builtin/subagents/src/agents.ts` 的 `builtinAgents`）、plume.side-chat（`profile.ts` 的 `KINDS`）、plume.prompt（`system.ts` 的 `writersAsk`）、plume.compaction（`head.ts` 的 `KindOf`）、plume.mcp、plume.web（结果里叫模型去读全文时点名的那件）
