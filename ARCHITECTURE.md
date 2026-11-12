# Plume 架构

Plume 是一个 coding agent 桌面应用（Electron）。模型调用、agent 循环、会话、审批卡和界面骨架是产品本体；基本工具（read、write、edit、ls、glob、grep、bash）、沙箱、帮我批准的风险规则、系统提示词、压缩是随应用发的内置插件（`packages/builtin/`）；循环里依赖它的能力——新工具、工具结果、发给模型的上下文——经**钩子**和**工具注册**开放给插件，对话里配套的**工具卡片**、对话旁边面板区里的**面板**也由插件画（审批卡由产品摆在输入框上方，插件可经 `ui.approvalCard` 给自己的工具换一张）。内置插件随应用发、不能停用；其余插件放在插件仓库 plume-plugins 的 `plugins/`，经插件市场安装（`apps/desktop/src/main/market-remote.ts`）。

完整设计（可变与不可变的边界、开放哪些界面、钩子语义）见 [agent-extension.md](agent-extension.md)。本文只说代码在哪、怎么连起来。

## 进程

```
渲染进程  apps/desktop/src/renderer      产品界面（React + Tailwind）；加载插件的界面入口 dist/ui.mjs
   │ MessagePort · @plume/rpc            AgentService：会话、发送、停止、回应审批、订阅事件
agent 进程  utilityProcess               apps/desktop/src/main/agent-process.ts → createAgent()
   │                                     会话 · 循环 · @plume/llm · 插件宿主 · 插件的逻辑入口 dist/index.mjs
   │ parentPort · @plume/rpc             agent 进程给插件状态、关闭；插件经 ctx.pages 驱动网页、主进程推回页面事件
主进程  apps/desktop/src/main            窗口 · 启动 agent 进程 · 转交 MessagePort
                                         选文件夹 · 插件市场（装、卸、更新） · plume-plugin:// 和 plume-host:// 协议
                                         应用自己的更新（查 GitHub release、下载、校验、换上，update/）
                                         插件画的网页（主窗口、面板窗口的 <webview>：加固、拦非网页地址、对话框、截图，web-pages.ts）
```

插件和 agent 同进程：插件死循环或崩溃只带走 agent 进程，窗口会提示「agent 进程已退出」。

## 目录

`apps/` 放产品，现在只有桌面版；`packages/` 放共享类型和产品用到的库，除 `contract` 外按 `packages/<组>/<包>` 分组（分组规则见 [packages/README.md](packages/README.md)）；市场插件在旁边的插件仓库 plume-plugins 的 `plugins/` 下。

| 目录 | 跑在哪 | 职责 |
| --- | --- | --- |
| `apps/desktop`（`@plume/desktop`） | 主进程、agent 进程入口、渲染进程 | Electron 外壳、产品界面、冒烟验证 |
| `packages/contract`（`@plume/contract`） | 只有类型 | 所有共享类型：插件 API（`@plume/contract` 逻辑入口、`@plume/contract/ui` 界面入口）、AgentService 及事件和视图、agent 与应用之间的约定 |
| `packages/core/agent`（`@plume/agent`） | agent 进程 | `agent.ts` 会话、AgentService；`loop.ts` 循环的一轮；`stream-turn.ts` 一次请求（草稿、重试）；`tool-run.ts` 一步里的工具和审批；`commands.ts` 权限模式对应哪一档沙箱、提权、只读（工具经 `run.exec`、`run.escalate`、`run.shell` 用，系统提示词经 `ModelContext.shell`）；`background.ts` 后台结果的送达（子会话交回、工具的渠道、会话间的信）；`jobs.ts` 工具登记的后台任务（`run.track`）、`wakeups.ts` 和 `cron.ts` 约好的唤醒（`run.schedule`），会话闲没闲把这三样都算上；`recovery.ts` 截断续写和空回复催促；`repetition.ts` 重复调用检测；`hiccups.ts` 连接岔子的记录；`compaction.ts` 压缩的账（摘要、头和边界怎么拼回历史，剪枝视图，拒收后剪成一行的结果）；`session-compaction.ts` 一次压缩（问钩子、记账、转录里的压缩行，`/compact`、一轮收尾后的 idle 压缩）；`host.ts` 插件宿主；`testing.ts` 假模型服务 |
| `packages/core/llm`（`@plume/llm`） | agent 进程 | 模型调用，自成一体的包 |
| `packages/core/sandbox`（`@plume/sandbox`） | agent 进程（Windows runner 是应用经 `ELECTRON_RUN_AS_NODE` 起的单独进程） | 在这台机器给得了的约束里跑 shell 命令：macOS seatbelt，Windows 受限令牌（runner 打成主进程旁边的入口 `out/main/sandbox-runner.js`，agent 进程经 `useSandboxRunner` 告诉它，koffi 是应用的生产依赖），登录 shell 的环境（`login-path.ts`）；只认命令、目录、档位，不认会话和循环 |
| `packages/infra/rpc`（`@plume/rpc`） | 三个进程 | 双向 RPC：流式返回、取消；`serve` / `remote` 把对象暴露到通道上 |
| `packages/infra/platform`（`@plume/platform`） | agent 进程 | 本机的 shell、把一行命令拆开的扫描器、按行比较两段文本 |
| `packages/infra/document-text`（`@plume/document-text`） | agent 进程 | 从 PDF、Office 文档里抽字 |
| `packages/client/styles`（`@plume/styles`） | 渲染进程 | 设计 token `theme.css`（`--plume-*` 变量：颜色由种子推出、字号七档、圆角、动效，以及 Tailwind 映射）；共用的 Tailwind 类名组合（按钮、卡片、输入框、代码、文字） |
| `packages/client/ui`（`@plume/ui`） | 渲染进程 | 基础组件 Button、IconButton、Input、Textarea、Card、CodeBlock、DiffView，类名来自 `@plume/styles`；产品和插件卡片共用 |
| `packages/sdk/plugin-sdk`（`@plumeai/plugin-sdk`） | 插件作者的机器上 | 插件 SDK：从 `contract`、`ui`、`styles` 的源码生成类型声明（`@plume/ui` 只开放 `plugin-api.json` 里的名字）、`plume-plugin` 命令（init / check / build / install / dev / link）、插件模板，以及插件包的格式（`@plumeai/plugin-sdk/manifest`：什么目录算插件、发哪些文件、`package.json` 的说明怎么读，主进程和插件仓库发市场都引它）。随应用发（资源目录里整理好的一份，自带 esbuild、TypeScript，见 `scripts/stage.mjs`），主进程生成 `~/.plume/bin/plume-plugin` 用应用的二进制跑它，不经 npm。仓库里的插件也只经它拿类型、经它构建 |
| `packages/builtin/*` | agent 进程、渲染进程 | 内置插件 tools（read、write、edit、ls、glob、grep、bash、bash_output、monitor，服务 `file.changes` 保存快照和安全撤销、`project.files` 列出项目里该看的文件）、delivery（最新轮交付卡、审核面板）、approval（钩子 `tool.approve` 上按帮我批准的风险规则放行）、ask-user（`ask_user` 工具和提问卡）、prompt（系统提示词、日期、打断说明）、compaction（上下文压缩、`recall`、`/compact`）、todo（`todo_write` 和跟着会话的清单卡片）、skills（技能目录、`skill` 工具，随包带 `plume-plugin` 技能）、commands（`/` 命令，读 `.plume/commands`、`.claude/commands` 里的 Markdown）、web（`web_search`、`web_fetch`）、status（输入框里的上下文用量圆环）、title（智能标题，开关在设置 › 常规）、spawn-session（`spawn_session` 的建议卡片、环境卡片里「建议的新会话」、卡片上的工作树开关、开始后把第一轮的回复交回；`archive_session` 在这一轮收场后归档这个对话）、git（分支签、改动计数、Git 面板、对话自己的工作树，服务 `session.worktree`）、mcp（连 MCP 服务、把工具交给 agent，设置页「MCP」，也读 Magpie 资源库分发的服务和插件随包带的 `.mcp.json`；像密钥的值和 OAuth 令牌经 `ctx.secrets` 加密存）、documents（文件面板和插件经 `ui.DocumentPreview` 共用的只读表格、SQLite 和 Word 预览）、diagnostics（运行诊断：后台任务、运行记录、调用轨迹，往环境卡片里放后台任务、定时唤醒、压缩记录三节）、environment（会话环境：标题栏的「环境」开关和环境卡片这个容器，自己画打开方式、子会话、引用三节，别的插件经 `ui.environmentSection` 往里放节）、browser（「浏览器」面板和 `browser_*` 工具，设置里从 Chrome 同步登录状态）、side-chat（「侧边聊天」面板和 `/btw`，侧边聊天是挂在会话下的子会话；`dispatch_task`、`control_main` 经 `ToolRun.parent` 把活排进主会话、停下或接着做）、subagents（`task` 工具把活交给子会话里的子 Agent，「子 Agent」面板看过程；种类全关掉时对模型藏起 `task`）、plan（计划模式：按会话的开关和 `/plan`，开着时不改文件、命令进只读沙箱，`submit_plan` 交计划给人批准，「在新会话里执行」经 `launch` 开新会话）：随应用发（打包时放进资源目录的 `builtin/`）、不能停用，能经服务或外层钩子换掉；和 `plugins/` 下的一样只用公开接口 |
| 插件仓库的 `plugins/*` | agent 进程、渲染进程 | 市场插件 terminal（shell 用 node-pty 跑在 agent 进程，比面板活得长；「终端」面板用 xterm 经 `ui.remote()` 连上）、browser（「浏览器」面板一个标签一页 `<webview>`，挂上后交给逻辑入口，人点的和 `browser_*` 工具都经 `ctx.pages` 驱动同一页；面板 `keepAlive`，最近看过的几个会话的页面挂着；能弹到独立窗口；本地 `.html` 由逻辑入口的本机小服务给）、scheduled（定时任务的列表存在插件数据目录的 `tasks.json`，「定时任务」页面经 `ui.remote()` 读写；逻辑入口每分钟看一次，到点的经 `ctx.sessions.launch` 开新会话发提示词，失败在输入框上方和侧栏的数目上告诉人）、hooks（按 Claude Code 的约定跑用户配的钩子命令）、index（`symbol` 工具查定义位置，设置页「索引库」）、sessions（`list_sessions`、`read_session` 读别的会话，`ask_session`、`reply_session`、`notify_session` 经 `ToolRun.letter` 给别的顶层会话寄信；限速、链长的账在插件里，请求的配对和代答在本体） |
| `integrations/magpie` | Magpie 里 | 给 Magpie 用的 Agent 插件：在 Magpie 里给 Plume 选模型，写进 Plume 的设置文件；资源库的技能写进 `~/.plume/skills`，全局指令写进 `~/.plume/magpie/AGENTS.md`（plume.prompt 每轮读），MCP 写进 `~/.plume/magpie/mcp.json`（plume.mcp 和自己的服务一起读，只读） |

依赖方向：`desktop → agent、ui、styles、rpc、plugin-sdk`（只引 `manifest`，打进主进程）；`ui → styles`；`agent → llm`；所有包的共享类型都来自 `contract`；`agent` 不依赖任何具体插件；`packages/` 不依赖 `apps/`。插件只 `import type` `@plume/contract`，界面入口运行时用共享的 `react`、`@plume/ui`、`@plume/styles`；插件仓库里 `plugins/*` 的这些类型来自 `plugin-sdk`（tsconfig 继承 `@plumeai/plugin-sdk/tsconfig.json`），不直接依赖 `contract`、`ui`。

## agent 的一轮

1. 用户消息先经钩子 `prompt.submit`（最里层放行）：插件拦下时这条不写进会话、这一轮不跑，原因弹成提示条；放行时可以带一段上下文，以 `synthetic` 的用户消息跟在它后面写进会话。输入框里敲 `/` 弹出命令菜单：本体只有 `/clear`（开新对话），别的命令由插件经 `ctx.commands.provide` 供，发送前经 `AgentService.expandCommand` 展开成要发的话（`renderer/composer/`）。然后用户消息写进会话。会话都在一个 SQLite 库 `<数据目录>/sessions/sessions.db` 里（`packages/core/agent/src/session-db.ts`，用 Node 自带的 `node:sqlite`）：每个会话一行摘要，消息只往后追加，一条消息和它带来的摘要变化在同一个事务里写完；撤回、编辑重发从尾巴上截掉一段（`AgentService.revertMessage` / `editMessage`，事件 `rewound`），分叉把前面一段拷进新会话（`forkSession`），花销都不跟着动；每次计费的调用（回复、压缩摘要、插件的 `ctx.model.complete`）另记一行花销（`spend`），删会话不动它；会话里一步步发的请求还记下计费 token 按来源分摊的各部分、计时、之前的轮次和工具，以及和上一次主请求比出的缓存未命中和原因（`usage-record.ts`，前缀从哪变了看 `@plume/llm/prefix-fingerprint`，存在回复的 `prefix` 上）；使用统计插件 `plume.usage` 经 `ctx.model.usage` 读它，画在设置 › 数据里；结构版本不对或打不开时 agent 进程启动失败、日志里报出路径和原因，不重建、不迁移；删会话后立刻归还空间。
2. 组上下文：系统提示词 + 历史消息副本 + 工具表，经钩子 `model.context`。系统提示词由内置插件 plume.prompt（`packages/builtin/prompt`，`model.context` 最外层）按段组：身份、准则、边界、环境（平台、shell、是不是 git 仓库、模型）、项目指令（工作目录到仓库根，每层按 PLUME.md / AGENTS.md / CLAUDE.md / .agent/AGENTS.md / .agents/AGENTS.md 的顺序取第一份非空文件；非 Git 目录只读本层，最多 10 层、每份 100 KiB）、工作目录，每次请求按磁盘现状组一份；插件按段名加、换、删。发出去的系统提示词在会话里冻结（为了服务商的前缀缓存）：里层交回的段和冻结的那份不一样时，改动作为一条增量消息接在这一轮开头，压缩以后重新冻结；工具表同样按会话冻结，一轮里原样发，插件装卸带来的变化在下一轮开头换上（原有的保持顺序，新的接在后面）。今天的日期不进系统提示词，跟在第一条用户消息（压缩后是摘要）和之后每个新日期的第一条真人消息后面（`<env>`，只在拼请求时加；人在压缩后再开口时它不挪位置）。出错则这一轮结束，界面显示提示。压缩过的会话，历史是最新那份摘要加边界之后的原文；压缩记录和被剪成一行的结果存在会话库里这个会话那一行上，消息不动。组好以后经钩子 `context.compact` 问要不要压：内置插件 plume.compaction（`packages/builtin/compaction`）在快到窗口 90% 时压一次（先剪过大、被覆盖的工具结果，不够再把较早的那段写成结构化摘要：缓存还热时经 `ModelCompletion.fork` 从主请求分叉，不行单独请求，都不行本地整理；最近的约 12% 窗口、至少 4 条原样留着），本体记下头、边界和剪枝视图，再组一次。一轮干净收尾、缓存还热时也问一次（`idle`），人一开口就让位；人敲 `/compact` 经 `ctx.sessions.compact` 现在就压。每一次压缩是转录里的一行（`CompactionRun`，存在会话库里）。
3. 调模型，草稿每 50ms 推一次给界面，同时边流边写进会话库（第一段字立刻写，之后每 80ms 或攒够 8KB 一批，只写新增的文字和思考）：进程中途没了，下次打开时已经收到的部分作为停下的回复（`stopReason: "aborted"`）写进会话；要重试时记一条连接岔子（`hiccups` 事件，界面画成「正在重试 / 已恢复」那一行）；服务商拒收时把过大的工具结果剪成一行再发一次，说超长时强制压缩一次再发，恢复成功的话失败那条不写进会话；回复写进会话；一轮最多 200 步。回复出错或被停下时，它开了头的工具调用补一条不执行的结果；工具参数撞上输出上限时判失败让它拆小，连着四次就以出错停下。
4. 处理工具调用，每个都经钩子 `tool.execute`：相邻的只读调用（`mutating` 为假，或能证明只读的 bash 命令）同时跑，会改动的单独跑，结果按调用顺序写进会话；最里层先审批、再执行工具表里的工具。审批排在所有钩子层里面：写了 `asks` 的工具（plume.tools 的 write、edit、bash）校验完参数再经 `run.ask` 问，其余 mutating 工具在执行前按参数问，能证明只读的命令不问；权限模式的含义在本体（`tool-run.ts` 的 `approve`）：完全访问、外层设了 `approved`、答过「以后不再问」的直接放行，提权只认人在卡上答或代管这个会话的插件转达（权限模式 `permissionMode` 和名单 `alwaysAllow` 存在设置文件里）；其余经钩子 `tool.approve`，内置插件 plume.approval（`packages/builtin/approval`）在帮我批准下放行风险规则看不出风险的，其余由最里层弹给人。界面在输入框正上方画审批卡（`ApprovalOverlay.tsx`：拒绝、以后不再问、允许一次），工具卡片只标「等待确认」；同时要问的排队、一次一张，卡上写后面还排着几张；没人答时 5 分钟后按拒绝收场，卡上有倒计时；工具经 `run.request` 要人给答案（提问、计划、表单）不是审批，不经 `tool.approve`、权限模式管不着，只和审批同排一队、同占这一格，等 30 分钟。工具在内置插件 plume.tools（`packages/builtin/tools`）。bash 经 `run.exec`（本体，`packages/core/agent/src/commands.ts` 选档、`packages/core/sandbox` 起进程）用用户的 bash / zsh 跑，环境向登录 shell 要一份（`login-path.ts`），没给时限的命令过了 120 秒转成会话的后台任务（经 `run.track` 登记进本体：`bash_output` 读、停，删会话和退出应用时本体停掉，没结束的任务在时会话不算闲；顶层会话里任务自己结束时，结果经 `ToolRun.background` 的渠道和子会话交回的结果走同一条送达，`monitor` 边跑边分批送新输出；完整输出写进会话临时目录的 `tool-output/`），无歧义的 `cat` / `ls` / `rg` 当场改用 read / ls / grep；请求批准下 bash 跑在只读沙箱里，帮我批准下只能写项目目录和临时目录（给不了沙箱就报错），被沙箱拒绝时模型可以申请提权重试一次，提权经 `run.escalate` 总是问人、只管这一次（本体的 `commands.ts`；给模型的提示在 plume.tools 的 `escalation.ts`）。插件在 `tool.execute` 外层设 `approved` 预先放行或直接拦截，在 `tool.approve` 外层替人答（提权只能替人拒绝）。任何一层出错，这次调用以错误结果交给模型，这一轮继续。
5. 结果（含 `details`，不发给模型）写进会话。用户停止时，没执行的调用补一条「没有执行」的结果，标上 `details.cancelled`，界面画成「已停止」。
6. 收尾经钩子 `step.end`，最里层是本体的自然结论：有工具结果就回到第 2 步；没有的，撞上输出上限的以用户身份说一句 `synthetic` 的「接着写」（连着三次还撞就停下提示），没有正文的催一句（三次后以出错结束），否则结束。同一个工具、同样的参数、同样的结果，第 3 次起发给模型的换成「这是第 N 次」（会话和卡片里仍是原文），那一步收尾时提醒一句换思路，第 10 次以「卡住」结束；人发来新消息时从头数。插件包在自然结论外面，可以改写或不调 `next` 整个换掉它，但只能让它多做或给结束换个原因，拦不下本来要跑的那一步；钩子出错时按自然结论走。
7. 正在跑时人又发了一句，agent 进程把它排进这个会话的队（存在会话库里，`queue.ts`），界面画在输入框上方，这一轮以完成结束时自动发下一条；「现在就发」带 `interrupt`：本体停下这一轮、等它收完尾再拿这条开新的一轮，发给模型时给这条套上「打断」的前后说明（只在拼请求时加，会话里是原话）。同一条队还排子会话交来的事（`origin: "child"`）和代管插件转来的话：插件经 `ctx.sessions.launch({ steward: true })` 开出的会话摘要里记着 `steward`，这个插件之后能经 `ctx.sessions.post` 往里转话（`origin: "plugin"`，前面带本体写的来处说明）、经 `respond` / `answer` 替人答弹着的卡（和人点卡同一个 settle，先到的算，结果记 `answeredBy`），只认自己代管的顶层会话；人在会话菜单「停止代管」（`AgentService.revokeSteward`）后都抛错（`agent.ts` 的 `postToSession`、`settleAsSteward`）。
8. 一轮结束的原因（完成、停止、出错、用满步数、卡住、退出应用时被中断）记在 `SessionSummary.stop`，随摘要存进会话库；界面据此在转录末尾给「已暂停 · 继续」这类入口，「继续」发的是一条 `synthetic` 消息，不画成人的气泡。

## 插件

插件是 `~/.plume/plugins/`（从插件市场装的）、`~/.plume/local-plugins/`（本地上传的）下的一个目录：

- `dist/index.mjs`：逻辑入口，跑在 agent 进程，默认导出 `{ name, apply(ctx) }`；注册都记在插件名下，停用或 apply 失败时整体撤销。
- `dist/ui.mjs`（可选）：界面入口，跑在渲染进程，默认导出 `{ name, apply(ui) }`，name 必须相同；要 agent 进程里的东西，经 `ui.remote()` → `AgentService.callPlugin` 调自己逻辑入口 `ctx.serve` 开的对象。

`ctx`、`ui` 的成员和用法见写插件的 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)。

加载顺序：先内置的，再本地上传的和市场装的，同名的只认先找到的；工具重名时后登记的生效（插件能覆盖 plume.tools 的 read、write、edit、ls、glob、grep、bash），它撤下后前一个恢复。钩子各层只按 `order` 排，小的在外层。`<数据目录>/plugins.json` 里写 `{ "disabled": ["插件名"] }` 关掉插件，「插件市场」里插件详情页的开关写的就是它。界面只加载 agent 进程报告为 active 的插件的界面入口；卡片渲染出错让给下一个注册者，最后用通用卡片。

插件市场（`apps/desktop/src/main/market.ts`，界面在 `renderer/market/`，侧栏那一行叫「插件市场」）：页上分插件、技能、连接器三类，技能和连接器两类由 `plume.skills`、`plume.mcp` 经 `ui.settingsSection` 的 `page: "extensions-skills"`、`"extensions-connectors"` 画；插件那一类的目录在网上（`market-remote.ts`）：插件仓库 plume-plugins 的 CI 把插件按平台打包、发到 GitHub Pages，应用读它的 `marketplace.json`（格式见插件仓库的 `docs/distribution.md`；开发版、装好的应用和冒烟都用这一个；只认 https，本机 http 留给测试起的服务），每条的说明取自插件的 `package.json`（`description`、`author`、`keywords`、`homepage`，`plume.displayName`、`plume.category`），图标和 `README.md` 放在 `assets/<名字>/` 下、安装前就能看。安装下载这台机器那份包、核对大小和 SHA-256，解进暂存目录再换进数据目录的 `plugins/<目录名>`（冒烟验证装进 `.smoke/` 里），agent 进程当场加载；卸载当场撤下。「从本地上传」和 `plume-plugin install`/`dev` 装进 `local-plugins/<目录名>`，能卸、不跟市场更新；同名时按内置、`PLUME_PLUGIN_PATHS`、本地上传、市场装的顺序只认第一份，被压住的原样留着，前面的卸掉它就接着生效。更新按版本号比（插件仓库发布时保证同一版本内容不变）；目录五分钟内不重读，连不上时用上次读到的、界面提示原因；自动更新默认开，启动后一会儿、此后每半小时、每次读市场时各对一遍，有会话在跑一轮或在等后台的事时（agent 进程的 `busy`：派出去的后台运行、没结束的后台任务、没触发的唤醒，开发服务器这种不退出的也算）不换、每分钟再看一次，人点的「更新」不等；开关存在数据目录的 `market.json`。插件运行中装上、开关、卸下时，agent 进程推一条 `plugins` 事件，界面按它增减各插件的界面入口。

写一个插件：用 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)，在插件仓库里 `pnpm plugin init plugins/<目录名>` 从 SDK 的模板生成；插件只引用公开接口（`pnpm check:plugins` 会查）。构建是 SDK 的 `lib/build.mjs`（`scripts/build-plugins.mjs` 逐个调它，仓库外是 `plume-plugin build`）：逻辑入口的依赖全部打进 `dist/index.mjs`，`package.json` 的 `dependencies`（打不进去的原生模块）连同实际安装的运行依赖闭包复制进 `dist/node_modules`（同名冲突嵌套隔离，只留 Plume 发包的平台、架构（darwin、win32 的 arm64、x64，加上构建机）的包与预编译文件，内置插件打安装包时由 `apps/desktop/scripts/stage-resources.mjs`、市场插件发布时由插件仓库的 `scripts/build-dist.mjs` 再按目标裁成一份；Windows 上 agent 进程把用户插件目录里的 `.node` 按内容复制到数据目录的 `native-cache/` 再加载（`apps/desktop/src/main/native-cache.ts`），插件目录不被锁住，Plume 开着也能更新、卸载）；界面入口把 `react`、`@plume/ui`、`@plume/styles` 留给 import map，`.css` 按文字打进去。

## 运行诊断与环境卡片

内置插件 `plume.diagnostics` 提供任务面板和调用轨迹，并经公开的 `ui.environmentSection` 往环境卡片里放后台任务、定时唤醒、压缩记录三节；环境卡片本身（标题栏开关、卡片、分节菜单）是内置插件 `plume.environment`，两者不互相点名，只经宿主的分节注册表配合。后台任务、唤醒的数据来自本体：工具经 `run.track`、`run.schedule` 登记，诊断经 `ctx.sessions` 的 `jobs`、`jobOutput`、`stopJob`、`wakeups`、`cancelWakeup` 按会话读、停、取消；读尾部输出调回登记它的工具，不消费模型未读输出。宿主通过 `ctx.sessions.observe` 提供独立副本的只读观察，观察者异常不改变执行，已删除会话的迟到事件不再转交。插件将观察存在私有 `diagnostics.db`，撤回截断、删除清理；会话消息与工具结果仍从公开视图读取。请求观察带着实际发出的整段历史，插件把系统提示词、工具表和每条消息按内容指纹在会话内只存一份，请求只记指纹，库随会话长度线性增长；轨迹列表只拿到条数和系统提示词，打开某次请求的详情时才拼回它的消息和工具表。环境卡片里的几节和开关的圆点（各节的 `attention`）只读任务与唤醒，不读观察。界面经 `ui.sessionMenuItem`、`ui.environmentSection` 接入入口，经界面侧服务 `background.jobs.view`（`ui.provide`）让 plume.tools 画的后台命令那一行点开任务面板，面板使用既有注册方式。

## 数据

项目登记和项目顺序保存在 `projects.json`：`path` 是新会话的主目录，`folders` 是全部源文件夹，`sessionOrder` 是该项目的手动会话顺序。会话保留创建时的工作目录；宿主只在目录仍属于记录的项目时授予额外源目录读取权限，独立工作树不会读回原项目。侧栏按 `spawnedFrom` / `forkedFrom` 在同组中嵌套后续会话；置顶、归档和项目移动仍各自按会话处理。悬停统计从会话库的消息和花销账本按需读取，不加载完整历史。

模型设置存在 `~/.plume/settings.json`（0600），只有 agent 进程读写，每次用到都重新读；供应商的 API key 不写进它，加密（AES-256-GCM）存在数据目录的 `credentials.json`，钥匙是同目录的 `vault.key`，两个都是 0600（`packages/core/agent/src/vault.ts`）；插件的 `ctx.secrets` 也用这把钥匙，按插件名派生子钥（HKDF），各插件的密文互相解不开，密文由插件写回自己的配置；读设置时填回供应商上，手写进 `settings.json` 的 key 照样能用、下次保存时挪走；Magpie 写的网关 key 仍在 `settings.json` 的 `magpie` 块里。冒烟验证用 `.smoke/` 里的一份。格式是若干供应商（协议、地址、key、模型列表）加一个默认模型，读写和挑模型的规则在 `packages/core/agent/src/models.ts`：会话选了模型且还可用就用它，否则用默认模型，默认模型失效时落到第一个可用的。会话设置分全局和项目两层：当前工作目录的 `cwd/.plume/config.json` 覆盖全局，只读这一处、不向上找；对象深合并，数组和标量整体替换，再经过同一套校验。项目层不接受 `providers`、`apiKey`、`credentials`、`githubToken`、`mcpServers` 或 `magpie`，`hooks` 不合入，也不自动启用钩子；配置无效时使用全局设置并提示位置，不回显文件原文。

路径固定是为了 Magpie：它的 Agent 插件（`integrations/magpie`）往这个文件写顶层的 `magpie` 块和 `defaultModel`，读入时合成一个「Magpie」供应商排在最后，写盘时拿掉，在 Plume 里改不了（`packages/core/agent/src/magpie.ts`）。

模型目录（上下文、能力、价格的参考值，见 `@plume/llm/model-catalog`）缓存在 `~/.plume/model-catalog.json`：agent 进程启动时先读缓存，再每小时同步一次（`packages/core/agent/src/model-catalog-sync.ts`），界面经 `modelCatalog(版本)` 取，版本没变不传整份；冒烟验证不同步。导出、导入供应商的文件由主进程弹系统对话框选路径（`plume:providers:save-path` / `open-path`），读写文件的是 agent 进程；导出的文件带 key，权限只给本人。

数据目录是 `~/.plume`，设了 `PLUME_HOME` 就换到那里（见 `apps/desktop/src/main/home.ts`），这时 Electron 的 userData 也跟着放进它的 `chromium/`：模型设置 `settings.json`、`sessions/`（会话库，各会话排着的话也在里面）、`session-media/`、各会话的临时目录 `scratch/<会话 id>/`（随会话删掉）、`projects.json`、`workspaces/`、插件市场装的 `plugins/<目录名>/` 和 `market.json`、本地上传的 `local-plugins/<目录名>/`、插件私有目录 `plugin-data/<插件名>/`、`plugins.json`、外观、界面语言和窗口位置。开发版和装好的应用整个共用这个目录，插件也是同一份。

外观设置（主题、配色、会话背景）由主进程存在数据目录的 `appearance.json`，只记用户改过的字段；背景图复制在 `backgrounds/`。主进程开窗前按它设好 `nativeTheme`，渲染进程启动时经预加载脚本同步取一次，把配色写成 `--plume-*` 种子（见 `apps/desktop/src/main/appearance.ts`、`renderer/appearance-settings.ts`）。

会话列表、欢迎页和会话窗由本体维护：侧栏使用 `renderer/sidebar/ProjectList.tsx`，对话使用 `renderer/conversation/Transcript.tsx` 与本体输入框。插件通过工具卡片、会话卡片、输入框格子和面板接入，工具卡片的内容与交互仍由对应工具插件提供。
