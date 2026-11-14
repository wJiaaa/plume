# 工具卡片和审批卡

管对话里一次工具调用的展示：工具卡片（调用了什么、进行到哪、输出）、等待确认时输入框上方的审批卡，以及插件经界面入口替换工具卡片。登记规则和接口的完整说明见 [`agent-extension.md`](../../agent-extension.md) 第 5 节。

## 开发准则

### 结构

- 一次调用 = 工具卡片；等待确认时卡片只标「等待确认」，审批卡压在输入框正上方（`ApprovalOverlay`），摆放和排队归产品；审批卡只有产品的那一张，插件换不掉。插件换了工具卡片，审批照样能用。
- 通用卡片是一行流水行（`conversation/ToolCard.tsx`，骨架是 `FlowRow`）：图标、一句做了什么（`call-words.ts` 的 `describeOne`：按工具经 `ui.toolLine` 登记的说——模型写的说明（`note`）、动作和对象、读文件和列目录的路径（`file`），没给动作的按工具定义上声明的种类（`ToolDefinition.kind`）说；什么都没登记就说工具名。基本工具也由 plume.tools 登记，本体不认工具名）、行尾记号（写了几行、失败、已停止、`+N -M`）、展开箭头；点开是命令、参数、输出，或者 diff。diff 和 `+N -M` 只按结果 `details` 里的通用声明 `FileDiffDetails`（`@plume/contract`）画，不认是哪个工具交的。
- 运行中只有一种说法：字上扫光。失败是红色的 ×，人按的停是中性的「已停止」记号，不是失败。参数还在写、没开跑的调用不能展开。
- 转录按回合分块（`grouping.ts` → `turn-blocks.ts`）：读、跑命令、改文件连着做的几次调用合成一段活（`WorkStep`），跑着时说正在跑的那一次，停了说总的「读取文件 3 个、修改文件 1 个」，点开是挂在竖线上的每一次；推理默认不画（设置 › 常规 › 显示思考过程）。跑完的一轮照原样摊着，不收起（`TurnWork`）。
- 工具按定义上声明的种类（`ToolDefinition.kind`，界面经 `AgentService.listTools()` 和 `tools` 事件拿到工具表）和经 `ui.toolLine` 登记的 `group` 归类（`conversation/tool-lines.ts`，归类在 `tool-category.ts`），默认的说法、图标、运行行跟着种类；种类只在工具定义上写一处，`ui.toolLine` 不再写；本体只有按种类的表，没有按工具名的表。
- 插件登记了卡片的工具不合并：每次调用单独一行，整张卡照插件画的样子摆（`PluginToolCard`）；`fallback` 是上面那一行。登记时 `inline`（`true` 或逐次判断的函数）说了并进的那几次照常按归类合成一段活（`ownsToolRow`）。
- 转录底下的运行行（`RunningRow`）：一句在做什么、跑了多久、本轮 token、此刻速度；有调用在等确认时换成「等待你的批准」。

### 文件交付卡

- 内置插件 `plume.delivery` 经 `ui.turnFooter` 画在最新结束的回复下方，新一轮开始撤下。按实际快照合并本轮净变化，不累计工具调用的增删数；默认三文件，其余展开，保留展开过渡和箭头动效。
- 报告是本轮需求、回复、命令结果和差异的记录；审核打开差异面板，不调用模型。文件行支持悬停预览、键盘焦点预览和文件右键菜单。
- 全部文件都能撤销时才显示整轮撤销，单文件不可撤销时解释原因。确认后在服务端重新校验文件、项目边界和修改链，命令观测的变更不能自动撤销，不覆盖后续编辑。
- `ui.FileDiff`、`ui.FilePreview`、`ui.useFileMenu` 复用产品渲染和菜单；报告由插件读取后交给预览，不放宽宿主文件读取边界。

### 审批卡

- 标题栏：标题（`Edit hello.txt`、`Run shell command`）、类型小标签（执行命令 / 写入文件 / 修改文件 / 读取文件，插件的工具写工具名）、倒计时（「4:59 后失效」，`expiresAt`）、后面还排着几张（+N）、收起箭头；整条标题栏都能点着收起。外框是 `@plume/ui` 的 `ApprovalFrame`，插件的提问卡（`plume.ask-user`）也用它；自己画外框的插件卡（计划、MCP 表单）标题行放 `ApprovalExpiry`。
- 正文：理由（有的话）和 `detail`（命令原文、unified diff 文本、插件工具的 JSON 参数）。
- 底部三个按钮：拒绝（最左）、以后不再问、允许一次（`primary`）；提权请求和没有 `subject` 的请求只有拒绝、允许一次。
- 输入框工具栏左边是权限签：「请求批准」/「帮我批准」/「完全访问」（红色），点开是菜单，切到完全访问要在对话框里确认一次。签上是这个会话实际按的那一档：项目配置收紧了就是项目那档（`SessionSummary.projectPermission`，本体算好的，渲染进程不自己读项目配置），菜单改的仍是本机设置。

### 插件的卡片

- 只用 `@plume/ui` 组件、`@plume/styles` 的类名组合、`var(--plume-*)`；插件的 `className` 里不写 Tailwind 类（扫不到，`pnpm check:styles` 会报）。
- `details` 认不出（旧版本存下的、失败的）时渲染 `fallback`。渲染出错由宿主的错误边界兜住，让给下一个注册者，组件里不用自己 try/catch。
- 允许、拒绝交给审批卡，不在工具卡片里重复做。

### 边界态

- 长摘要：一行化开，悬停自己滚着读（`ScrollText`）；输出最高 420px、diff 最高 `max-h-72` 后滚动。
- 空输出：展开后只有命令和参数两节；执行中没有输出时写「等待输出…」。
- agent 进程退出、上一轮被中断：没有结果也不在运行时按失败显示。
- 只挂最近 20 轮（按轮计，`WINDOW_TURNS`），更早的点「显示更早的 N 轮」才挂上；往上翻了不再跟着底部，有「回到最新」。

## 检查点

- 冒烟依赖的属性不变：外层的 `data-tool`、`data-status`，合成一段活的 `data-plume-step`、`data-plume-run`，审批卡的 `data-approval-card`（提问卡里的 `data-ask-form`、`data-ask-option`、`data-ask-action`），权限签的 `data-permission-chip`、`data-permission-source`（菜单里项目要求的说明 `data-permission-project`），todo 卡片的 `data-todo-list`、`.plume-todo-row`。冒烟先点开那一段活，再查里面的卡片。
- 新卡片在浅色和深色下各看一眼：`pnpm smoke` 的截图包含 todo 卡片、edit 的审批卡（正文是 diff）和提问卡（`smoke-question.png`、`smoke-question-dark.png`）。

## 事实来源

- `apps/desktop/src/renderer/conversation/`：`Transcript.tsx`、`ToolCard.tsx`、`WorkStep.tsx`、`TurnWork.tsx`、`rows.tsx`、`ThinkingBlock.tsx`、`RunningRow.tsx`，分组规则在 `grouping.ts`、`turn-blocks.ts`（测试在 `apps/desktop/test/conversation-shape.test.ts`）
- `apps/desktop/src/renderer/plugins.tsx`
- `apps/desktop/src/renderer/conversation/ApprovalOverlay.tsx`、`apps/desktop/src/renderer/composer/PermissionPicker.tsx`、`packages/builtin/todo/src/ui.tsx`
- `packages/contract/src/ui.ts`（`ToolCardProps`）、`packages/contract/src/service.ts`（`ApprovalRequest`、`ApprovalDecision`、`PermissionMode`）
