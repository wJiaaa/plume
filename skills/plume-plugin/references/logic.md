# 逻辑入口

跑在 agent 进程，和 agent 循环同一个进程：能用 Node 的一切，也能拖垮整个 agent 进程（死循环、未处理的崩溃会让 agent 进程退出，窗口提示「agent 进程已退出」）。类型从 `@plume/contract` 来。

```ts
import type { Plugin } from "@plume/contract";

export default {
	name: "example.my-thing",
	apply(ctx) {
		// 在这里注册；可以是 async。抛错 = 插件 failed，已做的注册全部撤销，不影响别的插件。
	},
} satisfies Plugin;
```

## ctx

| 成员 | 用途 |
| --- | --- |
| `ctx.name` | 插件名 |
| `ctx.fetch(url, init?)` | 逻辑入口的标准 Fetch HTTP(S) 请求，桌面版走 Chromium 系统代理；禁止 URL 凭据、自动重定向和共享浏览器 cookie。init.signal 或插件停用会取消，请插件自己设置超时和响应大小上限；认证头只在逻辑入口使用，不把请求对象传到界面 |
| `ctx.trash(path)` | 把文件或目录移到系统的废纸篓（Windows 上是回收站），删人写的东西时用它而不是直接删，删错了还能拿回来；宿主没有这个能力（agent 不在桌面应用里跑）或插件已停用时抛错。界面上的叫法按平台写：macOS「废纸篓」，Windows「回收站 / Recycle Bin」 |
| `ctx.dataDir` | 插件私有的数据目录，加载前已创建。插件自己的文件都放这里 |
| `ctx.appDataDir` | Plume 自己的数据目录（设置、会话、插件都在这里）。给模型用的工具不要写这里：写得到设置，就改得了自己的权限 |
| `ctx.tools.register(tool)` | 注册工具，停用时自动注销；返回的函数提前撤下它（工具来自会断开的外部服务时用） |
| `ctx.tools.names()` | 现在登记着的工具名（各插件的，同名只算一个，停用的不算），给「让人挑工具」的设置用 |
| `ctx.tools.list()` | 同 `run.tools()`：生效的工具、注册它的插件、它声明的类别（`category`）。在钩子里按类别找别的插件的工具（「记清单的那件叫什么」）时用，见「按类别找工具」 |
| `ctx.hook(name, layer, { order })` | 往钩子里加一层，停用时自动移除 |
| `ctx.effect(dispose)` | 登记清理（定时器、子进程、监听），停用时执行，后登记的先执行 |
| `ctx.serve(api)` | 把一个对象开给自己的界面入口；一个插件只能开一个，停用时收回 |
| `ctx.log` | `info` / `warn` / `error`，自动带插件名 |
| `ctx.locale()` | 当前界面语言 `"zh-CN"` 或 `"en"`，给人看的文字按它选 |
| `ctx.notice(sessionId, text, level?)` | 在界面上弹一条提示条，`level` 是 `"info"`（默认）、`"warn"`、`"error"`；不管那个会话是不是正开着 |
| `ctx.model.complete({ systemPrompt, prompt, messages?, sessionId?, maxTokens, signal, requireComplete? })` | 调一次模型做一件小事（写提交说明、起标题、写压缩摘要），回一段字；不带工具、不思考、不写进会话、不经 `model.context`。`messages` 是接在 `prompt` 前面的一段对话；给了 `sessionId` 用那个会话现在的模型、花销记在它名下，不给用默认模型；给了 `model`（`SessionModel.id`，人在设置里选的）就用它，优先于会话的模型，不在目录里时抛错、不悄悄换成别的。没配模型、服务商报错时抛错，message 是给人看的话。`onRetry({ delayMs })` 在等一会儿再试时调。`fork: true`（必须给 `sessionId`）从这个会话上一次发出去的主请求分叉：系统提示词、工具表、思考档位、缓存键照那一次，`messages` 给下一次要发的历史（`context.compact` 的 `request.messages`），末尾接上 `prompt`，缓存照常命中；那一次不是这一次的前缀、没发过主请求、换了模型、回复里调了工具时抛错。结果将覆盖持久化内容时传 `requireComplete: true`，只有 `stopReason === "stop"` 才返回文字；截断、工具调用等非正常完成抛错，调用方保留原内容与处理游标。主请求分叉也遵守该选项，失败回复仍计入用量 |
| `ctx.model.usage()` | 只读的花销：每次计费的模型调用（回复、压缩摘要、插件的 `complete`）按小时、供应商、模型合好（`requests`，最早的在前），带供应商 id 到现在名字的对照（`providerNames`，删掉的供应商不在里面）和已归档的顶层会话 id（`archived`）。会话里一步步发的请求（不含压缩摘要、分叉、`complete`）每格还带：计费 token 按来源分摊的十类（`parts`：系统提示词、项目说明与记忆、技能与智能体、工具定义、用户消息、注入内容、助手消息、工具结果，输出的思考和回复，加起来是这些请求的账单数）、发请求的会话（`sessions`，子会话记成顶层会话，已删的不在，跨格数会话要去重）、轮次、计时（`timedReplies`、`modelMs`、`generateMs`、`thinkingMs`，等首字 = `modelMs − generateMs`）、工具次数、出错和毫秒，以及缓存未命中（`cacheMiss`：和同一会话上一次请求比本该读到却没读到的 token、按当时费率多花的钱、没费率的 token，`byCause` 按原因分：工具定义、系统提示词、改写消息、服务商没读到、分不清、压缩、撤回、换模型）。删会话不影响这些数；读会话库失败时抛错。给画使用统计的插件用，经 `ctx.serve` 转给界面入口 |
| `ctx.model.findImageModel(name?, sessionId?)` / `ctx.model.image({ model, prompt, images?, aspectRatio?, quality?, count?, background?, signal?, onRetry? })` | 生图：按名字（模型名、模型 id、`供应商/模型`）在模型设置里标成生图的模型里找一个，不给名字用设置 › 智能体里选的默认生图模型；替某个会话找时传 `sessionId`（工具里是 `run.sessionId`），默认生图模型按那个会话所在项目的 `.plume/config.json` 取，没有这个会话时抛错；找不到时说明是一个都没有、不认识还是对不上好几个；`image` 用它出图（有输入图就是改图），key 不出宿主。服务商报错不抛，交回 `{ ok: false, failure }`（`hint` 说是额度、密钥还是内容被拒）；`signal` 取消时抛错 |
| `ctx.media.save({ data, mimeType })` / `read(name)` / `nameOf(path)` | 会话媒体目录：存一张图（png、jpeg、webp、gif、bmp，按内容命名，同一张只存一份）交回名字和路径；按名字读回 base64；一个路径要是这个目录里的图，交回它的名字。工具结果里的图宿主会自己挪进这里，名字记在 `ImageContent.media` 上；界面入口经 `ui.mediaUrl(name)` 显示 |
| `ctx.sessions.list()` / `ctx.sessions.get(sessionId)` / `ctx.sessions.messages(sessionId)` | 读会话：全部会话的摘要（含归档的、子会话，最近活动的在前；有 `kind`、`cwd`、`project`、`updatedAt`、`running`、`background`（它派出去的后台运行还没都回来，或交回的结果还没送进会话），子会话还有 `parentId`、`owner`）；只要一个会话的摘要用 `get`（没有这个会话时是 `undefined`），钩子和工具里直接看输入的 `session`，不用为找自己那条去 `list()`。`kind` 是 `"top"`（侧栏里的会话）、`"child"`（插件的子会话）或 `"standalone"`（插件的独立会话），由本体按 `parentId`、`owner` 算出，判断「是不是人的那段对话」只看它。一个会话存下的全部消息（原文，不受压缩影响；没有这个会话时抛错）。给的是副本，改了不影响会话 |
| `ctx.sessions.compact(sessionId, { instructions }?)` | 现在就压缩这个会话（`/compact` 用它）：照常经 `context.compact`（`force` 为真、带 `manual`），转录里画一行 `/compact` 和进度、结果。开始了就返回 `{ done }`，`done` 压完时给出 `{ ok: true, before, after }` 或 `{ ok: false, code, error? }`；会话正在跑、正在压、没有可用模型、没有这个会话时抛错，message 是给人看的话 |
| `ctx.sessions.setTitle(sessionId, title, { automatic }?)` | 改会话的标题（侧栏和标题栏上那行字），给起标题的插件用；宿主默认取第一条消息的开头。空白压成一个空格、最长 80 个字，空串不起作用；没有这个会话时抛错。自动总结传 `automatic: true`，用户手动命名过就不覆盖；不传仍是显式设置标题 |
| `ctx.sessions.onDeleted(listener)` | 会话被删掉时调 `listener(sessionId)`：按会话记的东西该清了、按会话起的进程该停了。停用时自动撤下 |
| `ctx.sessions.onContextReset(listener)` | 会话成功压缩或实际裁剪、撤回、重新载入历史，以及模型或工作目录切换后通知 `listener(sessionId)`；用于作废插件按会话冻结的上下文快照，下次请求再读。失败的压缩不通知；每次拿到的是会话 id，不是历史正文。返回提前取消订阅的函数，插件停用时自动撤下；监听异常只记日志，不改变会话操作 |
| `ctx.sessions.setArchived(sessionId, archived)` | 归档、取消归档一个会话，和侧栏上的归档按钮一样，`onArchived` 照常通知各插件。只在人点了插件界面上的按钮时调（工作树合回去之后的「归档这个对话」），不拿来替人收拾侧栏；子会话跟着父会话，传子会话、没有这个会话时抛错 |
| `ctx.sessions.onArchived(listener)` | 会话归档、取消归档时调 `listener(sessionId, archived)`：按会话占着的东西该收起、该放回了（`plume.git` 收回对话的工作树目录、检出回来）。状态没变不调；停用时自动撤下 |
| `ctx.sessions.onEnded(listener)` | 会话在这次运行里不再活着时调 `listener(sessionId, reason)`，`reason` 是 `deleted`、`archived`、`moved`（换到工作目录不同的项目）或 `quit`（退出应用），子会话跟着父会话各调一次。删除、归档、换项目时不等监听；退出时等这一轮停稳后再调，最多等 2 秒就接着退出，收尾要快。监听抛错只记日志；停用时自动撤下（`plume.hooks` 的 SessionEnd） |
| `ctx.sessions.create({ parentId?, title, model?, thinking?, project?, cwd? })` / `send(id, message, { signal })` / `stop(id)` / `delete(id)` | 插件自己的会话（给 `parentId` 是子会话，不给是独立会话，见「子会话」「独立会话」）：建、发一句并等结束、停、删。message 可为字符串或 `SessionMessage`（完整内容与附件；派发任务带 `origin: "parent"`），只能动自己建的 |
| `ctx.sessions.start(id, message)` / `wait(runId)` / `report(runId, text, { frame?, delivery? })` | 后台运行立即交回 `{ id, sessionId }`；等待该次结束后，把结果送给它的真实父会话。父忙时安全步骤边界读入，闲时唤起；停止、过期、重复的结果返回 false，不能任意向会话发消息。`frame`（`{ head, tail?() }`）：同一次送达里本插件带 `frame` 的几份合成一段，`head` 写一次，接着各份正文，最后是最后一份的 `tail()`（送出那一刻才取，比如「还在等谁」）。`delivery`（`DeliveryInput`：`{ id, title, status, incomplete?, inline?, details? }`，`details` 是你自己的数据、要能存成 JSON）写进送达消息，宿主只留这几个字段、记下是哪个插件交的，界面把这一次送达里本插件的几份交给本插件经 `ui.agentDelivery` 登记的组件画成一行，没登记就按 `title` 画默认的一行；不给就只有模型看得到 |
| `ctx.sessions.steer(id, message)` / `onStopped(listener)` | 给正在运行的自有子会话插话，空闲时拒绝；明确停止会话时通知插件，清理尚未启动的排队工作，监听随插件卸载 |
| `ctx.sessions.launch({ project?, cwd?, message, model?, thinking?, spawnedFrom?, title? })` | 开一个新的顶层会话并发出第一句话（`model`、`thinking` 不给用默认模型、默认推理强度；不认识的模型、档位抛错），返回 `{ session, done, idle, reportBack }`（`done` 是第一轮为什么结束，`idle` 在它第一次真闲下来时兑现成 `{ stop?, reply }`（最近一轮的收场、最后一段回复），`reportBack(text, delivery)` 把结果作为一条运行时送达交回 `spawnedFrom` 那个会话一次（`delivery` 和 `report` 的同一个形状，宿主填上新会话的 id，默认画成「来自新会话」一行、点了过去），来处删了、归档了返回 false；`spawnedFrom.toolCallId` 不是你的工具在那个会话里的调用、或你的插件停用了时抛错）；会话进侧栏、不记在插件名下，人能接着聊，插件之后不能再往里发（`steward: true` 开出来的由你代管，见下一行）。只能开新的，碰不到已有会话。见下文「开新会话」 |
| `ctx.sessions.post(sessionId, message)` / `ctx.sessions.respond(sessionId, toolCallId, "once" \| "reject")` / `ctx.sessions.answer(sessionId, toolCallId, value)` | 只对你经 `launch({ …, steward: true })` 开出、人还没停止代管的会话：`post` 往里转一句话（排进和人同一条队，闲着当场开一轮，返回 `{ started }`）；`respond`、`answer` 替人答它弹着的那张卡（审批卡含提权用 `respond`，等人给数据的卡用 `answer` 交数据、`respond(…, "reject")` 不答），答上了返回 true，卡已经不在、不是这一张返回 false。不是你代管的、人停止了代管、你停用了时抛错。见下文「代管会话」 |
| `ctx.sessions.models()` | 无凭据的模型目录：`id`、`name`、`contextWindow`、`thinking`；用于插件选择子会话模型，密钥不出宿主 |
| `ctx.pages` | 驱动界面入口画的网页（`<webview>`）：`attach` 认下、`load`、`go`、`evaluate`、`input`、`insertText`、`capture`、`setZoom`、`emulate`、`devtools`、`answerDialogs`、`chromeLogins`，`onEvent` 收页面的事件。见下文「网页」 |
| `ctx.commands.provide(provider)` | 给输入框的 `/` 菜单供命令（见下面「`/` 命令」），停用时撤下 |
| `ctx.plugins.list()` | 现在启用着、加载好了的插件：`name`、`dir`（插件目录）、`builtin`。给要读别的插件随包文件的插件用（技能插件读各插件的 `skills/`）；每次调都是当时的样子 |
| `ctx.plugins.onChange(listener)` | 插件装上、卸下、启用、停用以后叫一次（这时 `list()` 已经是新的），停用时撤下。读别的插件随包文件、又要当场跟上的插件用（MCP 插件读各插件的 `.mcp.json`，装上就连） |
| `ctx.provide(name, service)` | 提供一项服务给别的插件用（见下面「服务」），停用时撤下 |
| `ctx.use(name)` | 用一项别的插件提供的服务，只能用 `inject` 里写了的（见下面「服务」） |

## 工具

```ts
ctx.tools.register({
	name: "my_tool",                 // 模型看到的名字；和内置插件 plume.tools 的 read、write、edit、ls、glob、grep、bash 或别的插件重名时，后登记的生效（覆盖），它撤下后前一个恢复
	description: "…",                // 写给模型看的
	parameters: { type: "object", properties: { /* JSON Schema */ }, required: [] },
	mutating: false,                 // 会改工作区（写文件、执行命令）就写 true：不和相邻的调用同时跑，宿主在执行前把参数拿给用户看、问一次
	describe: (args) => `Search ${String(args.query ?? "")}`, // 可选：导出会话成 Markdown 时这次调用写成的一行（英文）；不给就写工具名。界面上的说法用界面入口的 ui.toolLine
	// 下面三个也只在有需要时给，宿主不认工具名，只认这些声明：
	// exportResult: (result) => conclusion,   // 导出时结果里要引在这一行下面的那段（子智能体交回的结论）；不给就不引
	// forwards: (args) => ({ name, args }),    // 这次调用是替另一个工具调的（按需加载时的总入口）：导出时这一行按被调的写
	// category: "mcp",                         // 这是哪一类工具："mcp"、"checklist"、"question"、"web"，见「按类别找工具」
	async execute(args, run) {
		// args 是模型给的，没校验过：先自己校验，不对就返回 isError
		// run.sessionId、run.cwd：哪个会话、工作目录；run.session.kind：是不是侧栏里的会话（见「钩子」开头的 session）；run.signal：用户停止这一轮时中止；run.progress(chunk)：执行中的输出推给界面
		return { output: "交给模型的结果", details: { /* 给卡片用 */ } };
	},
});
```

想自己决定问什么（给出 diff、命令原文、只在参数校验完以后问），写 `asks: true`，在 `execute` 里调 `run.ask({ kind, title, detail, subject?, reason?, escalation? })`：宿主不再在执行前替你问，`run.ask` 返回 `"once"`、`"always"` 或 `"reject"`。要不要真弹给人由钩子 `tool.approve` 定（见下面）：内置插件 plume.approval 让完全访问、外层设了 `approved`、答过「以后不再问」（`subject` 对得上）的直接得到 `"once"`，`escalation`（申请更宽的沙箱）总是问人。等这张卡时对话末尾、侧栏悬停和系统通知说「等待你的批准」。弹给人的卡没人答会过期：等 5 分钟，到时 `run.ask` 得到 `"reject"`（和人点拒绝、停下这一轮一样）。问的是人的决定而不是放不放行（回答问题、批准计划、填表）时不用 `run.ask`，用下面的 `run.request`：完全访问、层的放行都不替人答。

要人给一份数据而不是批准一次操作（回答问题、批准一份计划、填一张表）时调 `run.request({ kind, title, payload?, waiting? })`，不用写 `asks`。它不是权限：不经钩子 `tool.approve`，完全访问、「以后不再问」都不替人答，总是弹给人；和审批同排一队、同占输入框上方那一格，子会话问时卡片压在上级会话的输入框上方、写明是谁在问。`payload` 是卡片要画的数据（问题、计划文本、表单字段），要能结构化克隆，不用序列化成字符串；卡片由界面入口按 `kind` 登记（`ui.requestCard`，见 ui.md），没登记时产品画一张只能「不答」的通用卡。返回 `{ answered: true, value }`，或 `{ answered: false, reason }`：`"declined"` 人点了不答，`"expired"` 等了 30 分钟没人答，`"stopped"` 这一轮停了（会话删了也算）。`value` 来自渲染进程，不可信：用之前按 `payload` 再核一遍（界面里的检查拦得住手误，拦不住一个不照着问题答的客户端），核不过就当没回答。`waiting` 不给时宿主说「等待你的回答」。例子是 `plume.ask-user`、`plan` 和 `mcp` 插件的表单。

```ts
const reply = await run.request({ kind: "ask_user", title: "需要你的意见", payload: question });
const answer = reply.answered ? checkReply(question, reply.value) : undefined; // 核不过、没答都是 undefined
```

`run.projectRoots` 是宿主从会话所属项目推导出的源文件夹（只授予读取）；工作目录已移入独立工作树时为空，插件不能据此放宽写入权限。`run.allowedPaths` 是人在这个会话里（子会话连同它的上级会话）拖进来的文件的绝对路径，取自用户消息的附件，没有附件时不给：只授予读取这几个文件本身，不能据此改它们，也不能扩大到所在目录。

`run` 上还有：`run.scratchDir` 是这个会话的临时目录（`<数据目录>/scratch/<会话 id>`，宿主不预先建、谁先写谁 `mkdir`，会话删掉时连目录一起删）：只为得出这次答案而写的文件放这里——太大不值得交给模型的图、截断前的全文、只看一次的日志；read 读它不用问人，模型也能经 `scratch://` 地址读写它；`run.scratchDirs` 是和这个会话同一脉的会话（沿子会话、分叉、建议开出的新会话的来处连在一起的，两头都算）的临时目录，含 `run.scratchDir`，宿主每次调用现算：它们互相交接草稿（子智能体把报告写进父会话的临时目录，分叉接着改来源里的那份），往这些里写不用问人，别的会话的临时目录写不进（读哪个会话的临时目录都不问）；`run.permissionMode()` 读设置里现在的权限模式（`"ask"` 请求批准、`"auto"` 帮我批准（默认）或 `"full"` 完全访问）；`run.tools()` 是工具表里生效的工具、注册它们的插件和它们声明的类别（`{ name, plugin, category? }`）；`run.calls` 是这一步回复里的全部调用（含这一次，按回复里的顺序），要知道这一步是不是只做了这一件事时看它；`run.readOnly` 为真时外层要求这次调用不改动工作区（计划模式），跑命令的工具只在只读沙箱里跑；`run.background?.()` 给一条把后台结果送回这个会话的渠道（只有顶层会话有，子会话里是 `undefined`，见下面）；`run.letter?.(to, letter)` 给另一个顶层会话寄信（也只有顶层会话有、只在这次调用里能用，见下面）；`run.archiveAfterTurn?.()` 要求这一轮完成后归档这次调用所在的会话（也只有顶层会话有，见下面）。`mutating` 的工具能证明某次调用什么都不改（只读的命令）时，写 `readsOnly(args)` 返回 `true`，那次调用就和相邻的只读调用同时跑。
`run.toolCallId` 是这次调用的 id（和工具结果的 `toolCallId` 同一个，从这次调用开出去的会话记进 `spawnedFrom`）；`run.parent` 只在这次调用所在的会话是你自己建的子会话时才有，见「子会话」；`run.scratchDir` 是这个会话的临时目录（`<数据目录>/scratch/<会话 id>`，宿主不预先建、谁先写谁 `mkdir`，会话删掉时连目录一起删）：只为得出这次答案而写的文件放这里——太大不值得交给模型的图、截断前的全文、只看一次的日志；read 读它不用问人，模型也能经 `scratch://` 地址读写它；`run.scratchDirs` 是和这个会话同一脉的会话（沿子会话、分叉、建议开出的新会话的来处连在一起的，两头都算）的临时目录，含 `run.scratchDir`，宿主每次调用现算：它们互相交接草稿（子智能体把报告写进父会话的临时目录，分叉接着改来源里的那份），往这些里写不用问人，别的会话的临时目录写不进（读哪个会话的临时目录都不问）；`run.permissionMode()` 读设置里现在的权限模式（`"ask"` 请求批准、`"auto"` 帮我批准（默认）或 `"full"` 完全访问）；`run.tools()` 是工具表里生效的工具、注册它们的插件和它们声明的类别（`{ name, plugin, category? }`）；`run.calls` 是这一步回复里的全部调用（含这一次，按回复里的顺序），要知道这一步是不是只做了这一件事时看它；`run.readOnly` 为真时外层要求这次调用不改动工作区（计划模式），跑命令的工具只在只读沙箱里跑。`mutating` 的工具能证明某次调用什么都不改（只读的命令）时，写 `readsOnly(args)` 返回 `true`，那次调用就和相邻的只读调用同时跑。

- `output` 发给模型；`details` 存进会话、不发给模型，给工具卡片和插件自己用。会话重新打开时卡片还能从 `details` 画出来。
- 要让模型看图（截图）时带上 `images: [{ data, mimeType }]`：`data` 是 base64、不带 `data:` 前缀，`mimeType` 是 png、jpeg、webp、gif、bmp 之一，跟在 `output` 后面交给模型（bmp 模型不收：照样存下、画给人看，发请求时换成一句 `[unsupported image: image/bmp]`）；大图由本体存进会话的媒体目录。格式不对的整个结果判失败。
- 图太大、不值得每轮重发给模型时（几百 KB 以上），把它写进 `run.scratchDir`，`output` 里给一句说明和路径（模型要看就 read），图本身放进结果的 `shownImages: [{ data, mimeType }]`：这是只给人看的图，本体照 `images` 挪进媒体目录，通用卡片把它画在 `images` 后面（`details` 归你，本体不看里面）（MCP 插件对 200 KiB 以上的图就这样做）。
- 出错返回 `{ output: "原因", isError: true }`；抛错也会变成交给模型的错误结果。
- 结果带上 `terminate: "done"` 或 `"stalled"`：这一步的结果都写进会话以后，这一轮就以完成或卡住结束，不再把结果交给模型（一步里有几个都带了，有 `stalled` 就按 `stalled`）。工具和 `tool.execute` 的层都能设。
- 结果带上 `uneventful: true`（没搜到、空目录）：以后不会再有人要读，压缩剪枝时它发给模型的正文换成一句「无结果」，卡片照旧是原文。
- 结果带上 `instructions: true`（载入的技能正文这类要照着做的说明，不是一次观察）：压缩时原样留着，不按大小剪，也不当作被后来的结果顶替的旧观察清掉。例子是 `plume.skills`。
- 长时间的操作接上 `run.signal`，用户点停止时能停下。
- 调用答完以后还在后台接着做的事（后台命令、监视一条日志），结束或有新进展时经 `run.background()` 拿到的渠道送给模型：`channel.report(text, delivery?)` 可以送多次，和同一时刻别的后台结果聚合 400ms 成一条运行时送达（synthetic，经 `prompt.submit`）——会话闲着时开一轮，忙着时在下一个步骤边界读入。`text` 给函数时到真要送出那一刻才取，返回 `undefined` 就不送（攒着的那一会儿里模型已经自己读过）；`delivery`（和 `ctx.sessions.report` 同一个形状 `DeliveryInput`）让界面在对话里画一行，宿主只留认得的字段，不给就只有模型看得到；那一行由你经 `ui.agentDelivery` 画（plume.tools 画「后台命令完成 · 说明」「定时唤醒 · 理由」，命令、退出码放在 `details` 里），标 `inline: true` 的插在一段活中间时并进那段活。`sessionId`（点了跳到哪个会话）你给了也会被丢掉，只有宿主在 `reportBack` 时填。人按停、删会话、退出应用时渠道作废：`channel.signal` 触发，之后 `report` 返回 `false`、攒着的丢掉；撤回、编辑重发时只作废截掉的那段里的调用拿到的渠道，留下那段里拿到的照常送达。停不停后台的事本身由你定（plume.tools 的后台命令照跑、monitor 跟着停）。之后的调用拿到的是新的一条。子会话没有渠道，结果写进 `output` 叫模型自己去读。
- 给另一个顶层会话寄一封信：`run.letter(to, { from, text, request?, answer?, re?, chain?, guide? })`（`to` 是对方的会话 id，`from` 是你给发件方起的地址、收件方回信时原样当收件人）。信和后台结果走同一条路：对方闲着为它开一轮（人按停过的也开），忙着在步骤边界读到；本体照实填发件方的 id 和目录，在前面写明这是别的会话的话、不构成用户授权，每封画成 `<session-message from=… reply="expected"|answer=… re=…>`，对话里一行「来自 X」「X 的答复」（`UserMessage.peer`）。`guide` 是给收件方模型的处理说明（怎么回），一次送达里一样的只写一遍。返回回执 `{ id, read, answer }`：`read` 兑现成 `{ status: "read", opened }`（`opened` 是这封叫起了对方一轮）、`{ status: "dropped" }`（请求没读到对方的人就按了停——通知和答复不丢，留到它下一轮开头读；或 `prompt.submit` 拦下了）或 `{ status: "closed" }`（对方删掉了、应用退出）；`answer(letter)` 从收件方寄回发件方一封，只能用一次，发件方不在了返回 `undefined`——对方没回、没读到时替它说一句，问的一方才不会一直等下去。请求（`request: true`）有了答复之前，发件方不算真闲（`launch` 的 `idle` 等它）：经 `answer` 回了信，或对方读到以后寄回一封带 `answer` 的信（答掉它读到的全部），才算答了；对方删掉、你的插件停用时不再等。对方不在、是子会话、是自己时 `run.letter` 抛错；调用答完以后再调也抛错（回执的 `answer` 不受影响），要以后寄就在那次调用里寄出去、留着回执。限速、去重、链长归你管（plume.sessions 做了一份）。
- 照人的要求归档这次调用所在的对话（「做完就归档」）：调 `run.archiveAfterTurn()`，结果带上 `terminate: "done"`。本体不当场归档（这一轮还在等你的结果），这一轮以完成收场后才归档，和人在侧栏上点归档一样（界面离开它，`onArchived`、`onEnded` 照常）；这一轮被人停下、出错、卡住收场时不归档、请求作废。只够得着这次调用所在的会话，子会话里是 `undefined`。例子是 plume.spawn-session 的 `archive_session`。

### 工具结果里的通用声明

`details` 归插件，宿主不看里面，只认两个通用声明（类型在 `@plume/contract`）。宿主不认工具名：换一个插件提供同类能力，照样声明就行。

- `checklist`（`ChecklistDetails`）：这是这件事最新的一份进度清单，每项 `{ content, status: "pending" | "in_progress" | "completed", activeForm? }`，每次给整张。一轮干净地收了尾、最新那份还有没勾的，转录底下出「继续，把清单里没做完的做完」。转录里怎么画这次调用另在界面入口经 `ui.toolLine` 的 `checklist: true` 说（见 ui.md）。例子是 `plume.todo`。
- `job`（`BackgroundJobDetails`）：这次调用在后台起了一个任务 `{ id, command? }`。之后查它输出的那几行（`bash_output`）说的是起它那次调用写的说明。例子是 `plume.tools` 的后台 `bash` 和 `monitor`。

```ts
return { output: "Task list updated (1/3 done)", details: { checklist: todos } satisfies ChecklistDetails };
```

## 钩子

每一层的形状是 `(input, next) => Promise<output>`，像洋葱一样套起来：

- 调 `next(input)` 交给里一层（可以先改 `input`），拿到结果后还可以再改。
- 不调 `next`、直接返回：拦下，里层和工具都不执行。
- `order` 小的在外层，默认 0，相同时按注册先后。
- 某一层抛错，整个钩子失败，不会跳过这一层继续执行（审批、脱敏被跳过就等于放行、泄露）。所以别吞错，也别在不确定时放行。

每个钩子的输入和工具的 `run` 都带着 `session`：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，本体照会话摘要填（同名字段的意思同 `SessionSummary`）。按会话种类做事（只给侧栏里的会话加工具、子会话里藏起某个工具、认出自己的子会话）看它就够：

```ts
ctx.hook("model.context", async (input, next) => {
	if (input.session.kind !== "top") return next({ ...input, tools: input.tools.filter((tool) => tool.name !== "my_tool") });
	return next(input);
});
```

### `tool.execute`

每个工具调用经过一次。最里层是执行工具。一步里相邻的只读调用（`mutating` 为假）同时跑，所以同一个层可能同时处理好几个调用：按 `call.id` 区分，别把这次调用的状态放进会被下一个调用覆盖的变量里；几个调用同时 `ask` 时审批卡排队，一次弹一张。

| 输入字段 | 说明 |
| --- | --- |
| `sessionId`、`cwd` | 哪个会话、工作目录 |
| `session` | 调用所在的会话：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，见上面 |
| `call` | `{ id, name, args }`：模型发起的调用 |
| `tool` | `{ name, mutating, plugin }`：被调的工具，`plugin` 是注册它的插件 |
| `approved` | 外层已经放行的理由；设了它本体就不再问人，也不经 `tool.approve`（提权和层自己问的除外；`run.request` 不是审批，不受它管） |
| `readOnly` | 外层要求这次调用不改动工作区，交给工具的 `run.readOnly`：plume.tools 的 bash 不按权限模式选沙箱，一律在只读沙箱里跑，给不了只读沙箱时不跑。只能收紧，里层不去掉它 |
| `signal` | 用户停止这一轮时中止 |
| `ask(reason)` | 弹审批卡等用户决定，卡上是这次调用的参数和 `reason`，只能答这一次；返回是否允许，用户停止这一轮时得到 `false`。完全访问下本体直接允许，其余经过钩子 `tool.approve`（`byLayer` 为真） |
| `progress(chunk)` | 执行中的输出推给界面 |

输出是工具结果 `{ output, images?, isError?, details?, terminate?, uneventful?, instructions? }`。

已有的层（`plume.lsp` 在 edit、write 的结果后面附上文件的错误，`plume.hooks`、`plume.plan`、`plume.skills` 等）都用默认的 order 0，按加载顺序叠。要看交给模型的最终结果（比如把结果里的密钥换掉）就用很小的 order（如 -100）套在最外层，里面任何一层的输出都经过它。

审批在所有层里面：写了 `asks` 的工具（plume.tools 的 write、edit、bash）校验完参数再经 `run.ask` 问，其余 `mutating` 工具在执行前按参数问，问的时候经过钩子 `tool.approve`。用户拒绝就不执行。所以任何一层都在审批之前，想预先放行就设 `approved`，想拦截就直接返回、不调 `next`；想按工具或参数改审批的规矩，写在 `tool.approve` 里。
- 想改交给模型的最终结果：放到最外面（比 -100 更小或相同位置之外）。
- 只关心某个工具：先判断 `input.call.name`，不是就原样 `return next(input)`。

### `model.context`

每次调模型前经过一次。最里层原样返回。输入输出都是 `{ sessionId, session, parentId?, owner?, cwd, projectRoots, scratchDir, permissionMode, systemPrompt, sections, messages, tools }`（`session` 见「钩子」开头；`parentId`、`owner` 同 `session` 里的同名字段：插件的子会话两个都有，插件的独立会话只有 `owner`，侧栏里的会话都不带；按「是不是侧栏里的会话」藏工具时看 `session.kind`，不用每次去 `ctx.sessions.list()`；`scratchDir` 同 `run.scratchDir`，`projectRoots` 同 `run.projectRoots`；`permissionMode` 是这个会话现在的权限模式，含项目覆盖，取值同 `run.permissionMode()`，Windows 上受约束的命令跑 PowerShell、完全访问跑 Git Bash，plume.prompt 按它在环境里点名 shell；外层要求这一轮的命令都只读时设 `readOnly: true`，宿主不给，计划模式插件在 plume.prompt 外面（order -1001）设上，plume.prompt 就按只读那档点名 shell），只作用于这一次请求，会话里存的不变。

系统提示词按段给在 `sections` 里（`{ id, text, category?, files? }[]`，`systemPrompt` 就是它们用空行连起来）。本体的段依次是 `identity`、`guidelines`、`boundaries`、`environment`、`tone`（设置里的语气，不是「专业严谨」时才有）、`userInstructions`（设置里写了全局指令时才有）、`projectInstructions`（项目里有 PLUME.md / AGENTS.md / CLAUDE.md 时才有）、`workspace`（工作目录和会话的临时目录），plume.tools 再加一段 `resources`（资源地址的清单）。加自己的说明就加一段，段名用自己的。段名是提供它的插件自己的：要换掉或补充别的插件的某一类段（身份、准则），按段上的 `category` 找，不认段名：

```ts
// 加一段
ctx.hook("model.context", (input, next) => next({ ...input, sections: [...input.sections, { id: "todo", text: HINT }] }));
// 换掉身份那一段（plume.prompt 的 identity 段标着 category: "identity"）
ctx.hook("model.context", (input, next) =>
	next({ ...input, sections: input.sections.map((section) => (section.category === "identity" ? { ...section, text: "You are …" } : section)) }),
);
```

`systemPrompt` 只读：宿主在每一层交接时按 `sections` 重拼，直接改它不作数。

系统提示词在会话里冻结：plume.prompt 在最外层把里层交回的段和这个会话冻结的那份比对，发出去的始终是冻结的那份，服务商的前缀缓存才接得上。某段中途变了（项目指令改了、自己的段换了内容、加了或去掉一段），改动作为一条增量消息（synthetic 的用户消息，`promptUpdate` 列着改了哪几段）接在下一轮开头，模型从那里读到新的；一轮中间的几步不比。压缩以后（或撤回到第一条消息）按那时的段重新冻结。所以段的内容要只随该变的东西变：每次请求都不一样的东西（时间、计数）放进段里，每一轮都会多出一条增量。工具表也按会话冻结：`ctx.tools.register` 和撤下、插件装卸带来的变化（包括里层经 `model.context` 改的 `tools`）在下一轮开头才发给模型，原有工具的顺序不变、新的接在后面；一轮中间撤下的工具还留在表里，模型调它会拿到「没有这个工具」。

段上标 `category`，宿主按它分段统计，不认段名，不标的算系统提示词：

- `memory`：插件记下、每轮带上的记忆（用户的、项目的）。上下文用量算进「记忆」一段，使用统计的 Token 构成算进「指令和记忆」。
- `skills`：技能目录。上下文用量算进「技能」一段，Token 构成算进「技能与智能体」。
- `catalog`：别的按需取用的能力目录（可以派的智能体名单、没放进工具表的工具目录）。上下文用量算系统提示词，Token 构成算进「技能与智能体」。
- `identity`：agent 是谁的那一段（plume.prompt 的 `identity`）。子会话要换一个身份（子智能体、侧边聊天）时换掉它。宿主算系统提示词。
- `guidelines`：做事的通用准则（plume.prompt 的 `guidelines`）。要换一套准则或往里补几条时按它找。宿主算系统提示词。

#### 按类别找工具

工具也一样标类别，在 `ctx.tools.register` 的定义上写 `category`。宿主和别的插件按类别认，不认工具名：

- `mcp`：MCP 服务的工具（连同按需搜索、调用它们的总入口）。上下文用量把它们的定义单独算成「MCP 工具」一段。
- `checklist`：记进度清单的工具，结果的 `details` 带 `ChecklistDetails`（`plume.todo` 的 `todo_write`）。
- `question`：停下来问人一个问题、等人回答的工具（经 `run.request`；`plume.ask-user` 的 `ask_user`）。
- `web`：只读地查网页的工具（搜索网页、把网址读成文字，`plume.web` 的两件）。

插件的提示词要点名别的插件的工具（「用它记下步骤」「拿不准就用它问人」）时，不写死名字：按类别在 `ctx.tools.list()`（工具里用 `run.tools()`）找它这会儿叫什么，`model.context` 里再和这一轮的 `input.tools` 对一下，找不到就换一种不靠那件工具的说法。那个插件被换掉、停用时提示词照样是对的：

```ts
ctx.hook("model.context", (input, next) => {
	const checklist = ctx.tools.list().find((tool) => tool.category === "checklist" && input.tools.some((given) => given.name === tool.name))?.name;
	const note = checklist ? `Track steps of three or more with \`${checklist}\`.` : "";
	return next(note ? { ...input, sections: [...input.sections, { id: "my-note", text: note }] } : input);
});
```

段里有内容是从文件读来的，就在段上带 `files: [{ path, chars }]`（`path` 绝对路径，`chars` 是那一截在 `text` 里的字数，连同包着它的标签）：`projectInstructions` 段和标了 `category: "memory"` 的段的来源会按文件列在上下文用量的「记忆文件」里，人点了在文件面板里打开，文件在会话目录外（插件数据目录里的记忆、工作目录上层的指令）也能只读看，只认这次请求标出的这几个路径；别的段带了不显示。plume.prompt 给每份项目指令标了来源；自己出 `projectMemory` 段的插件也该标。改了某段 `text` 的层要么跟着改 `files`，要么去掉它（`{ id, text }` 新建的段本来就没有）。

```ts
const text = `<project_memory>\n${body}\n</project_memory>`;
next({ ...input, sections: [...input.sections, { id: "projectMemory", text, category: "memory", files: [{ path: join(dir, "notes.md"), chars: text.length }] }] });
```

在这里去掉某个工具只是让模型看不到它；要禁止执行，在 `tool.execute` 里拦。

### `step.end`

每一步收尾时经过一次：回复和它要的工具的结果都已写进会话。回复出错、用户按了停的那一步不经过。

| 输入字段 | 说明 |
| --- | --- |
| `sessionId`、`cwd` | 哪个会话、工作目录 |
| `session` | 所在的会话：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，见「钩子」开头 |
| `step` | 这一轮的第几步，从 1 数；是 1 时就是新的一轮，按轮计数的状态在这里清零 |
| `stepsLeft` | 后面还能跑几步；是 0 时要接着做，这一轮也会以「用满步数」结束 |
| `reply` | 这一步的回复（`stopReason` 是 `"length"` 时是撞上了输出上限） |
| `toolResults` | 这一步工具的结果；回复没调工具时是空的 |
| `progress` | 可选 `{ reported, reminder }`：插件经 `next({ ...input, progress })` 指定这一工具步是否已汇报、久未汇报时对模型说什么。不给时本体把非空正文视为汇报；不影响工具执行或停止权限 |
| `awaiting` | 可选 `{ nudge }`：外层插件经 `next({ ...input, awaiting })` 说这个会话还在等它派出去的后台工作、结论要等它们回来。里层见到它就别逼模型交结论：`plume.todo` 收尾不追问清单，本体空回复时催的是 `nudge` 这句（不是「请给出回答」）。子智能体插件在它的子代理没回来时给 |
| `signal` | 用户停止这一轮时中止 |

输入是副本，改了不影响会话。输出是这一步之后怎么走：

- `{ continue: true, say? }`：接着做。`say` 是以用户身份对模型说的一句话，会话里标成 synthetic，界面不画成人的消息。
- `{ continue: false, reason?, error? }`：结束这一轮。`reason` 不给是完成，也可以是 `"error"`（`error` 是给人看的原因）或 `"stalled"`。

已有的层：`plume.todo` 在 order -10（在 `plume.hooks` 的 Stop 外面，Stop 看到的是真正的回答）：回答完清单还有一项在做时问一次，清单没做完却 20 步没更新时问一句进度。

最里层是本体的自然结论：有工具结果就继续，连续 20 次工具请求未汇报时提醒当前在做什么、下一步做什么，并要求同一回复接着调用工具；没有的，撞上输出上限时最多续写三次，第四次仍截断才停下；没有正文时最多催三次，再次空回复以出错结束，否则 `{ continue: false }`；同一个调用反复得到同样结果时，`say` 里带一句换思路的提醒。汇报计数在每轮开始时重置，汇报或提醒过就清零；已有重复提醒的工具步也计数，到了 20 次时两句可在同一步出现，重复提醒在前、进度提醒在后。清单插件只提供当前步的判定与文案，不另数请求次数。不调 `next` 就整个换掉它。插件只能让循环多做、给结束换个原因，规则是：

- 有工具结果时 `continue: false` 不起作用（结果总得交给模型），`say` 照说。
- 本来要结束时要接着做，必须给 `say`，否则按结束处理。
- 先 `await next(input)` 看自然结论和里层的意见，再决定要不要改；不关心的原样返回。
- 这个钩子抛错时，循环按自然结论走，并在界面上提示出错的插件；交回认不得的结论（调了 `next` 却没 `return`、`say` 不是一句话、`reason` 不是上面两种）也一样按自然结论走并提示。它只能让循环多做，退回默认不会放过什么。

```ts
// 换掉本体的续写：撞上输出上限就停下，不接着写。
ctx.hook("step.end", async (input, next) => {
	if (input.toolResults.length === 0 && input.reply.stopReason === "length") return { continue: false };
	return next(input);
});
```

### `prompt.submit`

每一轮开始时经过一次：人发来的这条消息（或「继续」按钮替人说的那句）还没写进会话，模型也还没调。

| 输入字段 | 说明 |
| --- | --- |
| `sessionId`、`cwd` | 哪个会话、工作目录 |
| `session` | 所在的会话：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，见「钩子」开头 |
| `text` | 这条消息的文字；发的是 `/` 命令时是展开后的那段 |
| `attachments` | 附件的名字，按顺序 |
| `synthetic` | 是界面替人说的话（「继续」按钮） |
| `fresh` | 会话里在它之前一条消息都还没有：会话的第一轮 |
| `launched` | 这句是插件发的，不是人在输入框里发的：经 `ctx.sessions.launch` 开出来的会话的第一句，或代管插件经 `ctx.sessions.post` 转进来的话 |
| `signal` | 用户停止这一轮时中止 |

输出：

- `{ block: true, reason }`：拦下。这条消息不写进会话，这一轮不跑，`reason` 弹成提示条（给人看的话，按 `ctx.locale()` 写）。
- `{ block: false, context?, cwd? }`：放行。`context` 跟在这条消息后面以用户身份写进会话，标成 synthetic，界面不画成人的消息，模型看得到；写给模型的话不用随界面语言变。`cwd` 让这个会话从这一轮起改在那个目录里跑（子会话跟着，界面上的分支签、面板、文件都换过去）：`plume.git` 在会话第一轮（`fresh`）开出工作树后用它。只对一轮开头那条消息生效，插话、后台回报和子会话的不算；不是已有目录的绝对路径时不换、记日志。

最里层是 `{ block: false }`。先 `await next(input)` 再决定：里层拦了就原样返回；放行而你也要补上下文时，把里层的 `context` 和你的接在一起。这一层抛错时这一轮以出错结束，消息不写进会话。

```ts
// 消息里像是贴了私钥时拦下；否则提醒模型今天是周几。
ctx.hook("prompt.submit", async (input, next) => {
	if (input.text.includes("-----BEGIN PRIVATE KEY-----")) return { block: true, reason: "消息里有私钥，没有发出去" };
	const verdict = await next(input);
	if (verdict.block) return verdict;
	const today = `Today is ${new Date().toLocaleDateString("en", { weekday: "long" })}.`;
	return { block: false, context: verdict.context ? `${verdict.context}\n\n${today}` : today };
});
```

### `context.compact`

每次发请求前经过一次（组好上下文、过完 `model.context` 以后），问要不要把较早的历史换成一份摘要；服务商说超长时再经过一次，这时 `force` 为真；人敲 `/compact`（`ctx.sessions.compact`）时 `force` 为真、另有 `manual`；一轮干净收尾、人还没开口时也问一次（`idle`，宿主为它再经一遍 `model.context` 组出下一轮开头的那份请求）。

| 输入字段 | 说明 |
| --- | --- |
| `sessionId`、`cwd` | 哪个会话、工作目录 |
| `session` | 所在的会话：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，见「钩子」开头 |
| `model` | `{ id, name, contextWindow, maxOutputTokens, tierLines? }`：这个会话现在用的模型；`tierLines` 是价格分档线（输入越过就整次按高一档计），从低到高 |
| `history` | 现在发给模型的历史（插件改之前的那份），副本。压缩过的，前面是上一次换上的那几条（摘要和一句确认，或按条丢弃时的一条说明），之后是边界以后的原文；剪过的工具结果是剪过的那份 |
| `previous` | 上一次压缩的 `{ head }`：上一次换上的那几条占了 `history` 开头几条，新的 `keep` 要大于它；没压缩过没有。上一份摘要就在 `history` 开头 |
| `rewrittenAt` | 历史上一次被改写（压缩、只剪枝）的时刻，之前（含）落定的回复的用量不能拿来量现在有多满；没改写过没有 |
| `request` | 这一次真正要发出去的 `{ systemPrompt, messages, tools }`，量有多满用它；只读，别改 |
| `force` | 服务商说超长了，或人敲了 `/compact`：不管量出来多满都该压 |
| `manual` | 人敲的 `/compact`：`{ instructions }` 是命令后面的话（希望摘要保留的内容，可以是空串） |
| `idle` | 一轮收尾以后问的：只在能从主请求分叉时值得压，否则留给下一轮开头 |
| `lineage` | 这个会话上一次发出去的主请求 `{ model, at, cacheHotMs? }`：有它，摘要可以经 `ctx.model.complete({ fork: true })` 从那次请求分叉、吃到缓存；没发过、超长恢复时没有 |
| `signal` | 用户停止这一轮时中止 |
| `progress(event)` | 走到哪一步了（定下要压、开始写摘要时先报一次 `summarizing`，界面显示「正在生成摘要」）：`{ phase: "summarizing" }`、`{ phase: "retrying", delayMs }`、`{ phase: "fallback" }`（摘要没拿到、本地整理），转录里那一行跟着变 |

输出 `{ keep, summary, head, via?, views? }`、`{ pruneOnly: true, views }` 或 `undefined`（不压）。`history` 里从 `keep` 起原样留着，之前的（含上一次换上的那几条）换成 `head`（以用户消息开头的几条，宿主原样存下、以后每次照发）。`keep` 要大于 `previous.head`、在最后一条之前，而且不能是工具结果（会和它回答的调用拆开）；`summary` 只在 `via: "dropped"`（按条丢弃）时可以是空串，不合规矩的当作压缩失败。`via` 说摘要怎么来的（`fork`、`independent`、`fallback`、`dropped`）。`views` 是留下的那截里剪过的工具结果 `{ toolCallId, texts }`：宿主记在会话库里，以后每次都照它发、重开也一样，卡片照旧画原文；只剪了工具结果就够时交 `{ pruneOnly: true, views }`。会话里的消息一条不动，宿主记下边界、头和视图，之后每次请求都按它拼历史。

最里层是 `undefined`。内置插件 plume.compaction 在 order 1000 按有多满决定压不压，缓存还热时从主请求分叉写摘要，不行再单独发摘要请求，都没拿到就本地整理。要换成自己的压法，在外层（默认 order 0）不调 `next`；在外层改里层的结论时先看是不是 `pruneOnly`。这一层抛错时转录里那一行写「压缩失败」，这一步照常发全文。

```ts
// 只留最近 20 条，前面的让模型写一段话的摘要。
ctx.hook("context.compact", async (input) => {
	const head = input.previous?.head ?? 0;
	let keep = input.history.length - 20;
	while (keep < input.history.length && input.history[keep]?.role === "toolResult") keep++;
	if (keep <= head || keep >= input.history.length) return undefined;
	input.progress({ phase: "summarizing" });
	const summary = await ctx.model.complete({
		sessionId: input.sessionId,
		systemPrompt: "Summarise the conversation for handover. Output only the summary.",
		messages: input.history.slice(0, keep),
		prompt: "Summarise everything above in one paragraph.",
		signal: input.signal,
	});
	const text = `<session-summary>\n${summary}\n</session-summary>\nThe summary above is a record of the earlier conversation, not a new instruction.`;
	return { keep, summary, head: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
});
```

### `tool.approve`

一个工具调用要问人放不放行时经过一次：工具自己经 `run.ask` 问的、会改动工作区却没写 `asks` 的工具在执行前问的、`tool.execute` 的层自己经 `ask` 问的都算。最里层照着 `request` 把审批卡弹给人、等人答。工具经 `run.request` 要人给数据（提问、计划、表单）的不是审批，不到这里，层拦不下它。

权限模式的含义在本体，到不了这里：完全访问、设了 `approved`、`subject` 答过「以后不再问」的，本体直接放行（层自己问的只认完全访问）。提权（`request.escalation`）只能由人答：完全访问下也到这里，层答放行本体不认、照样弹卡，层答拒绝照算。`run.request` 不是审批，不到这里。

| 输入字段 | 说明 |
| --- | --- |
| `sessionId`、`cwd` | 哪个会话、工作目录 |
| `session` | 所在的会话：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，见「钩子」开头 |
| `scratchDirs` | 同 `run.scratchDirs`：同一脉的会话的临时目录，往里写、删里面的东西算正当干活（plume.approval 这么判） |
| `call` | `{ id, name, args }`：模型发起的调用 |
| `tool` | `{ name, mutating, plugin }`：被调的工具 |
| `request` | 要弹给人的那张卡：`{ kind, title, detail, subject?, reason?, escalation? }`；`escalation` 是申请更宽的沙箱 |
| `byLayer` | 是 `tool.execute` 的某一层自己问的，没有 `subject`，只能答这一次 |
| `permissionMode` | 这次调用所在项目现在的权限模式；`full` 只有提权会带到这里 |
| `signal` | 用户停止这一轮时中止 |

输出是 `"once"`、`"always"` 或 `"reject"`。不调 `next` 就是替人答了，卡不弹；人在卡上答「以后不再问」时宿主把 `subject` 记进设置（提权的不记）。

`plume.hooks` 在 order 2000（plume.approval 里面，只有真要弹给人的才到）跑 PermissionRequest 钩子：`byLayer` 的不问钩子（`run.request` 本来就不经这里）；钩子拒绝就 `"reject"`，放行就 `"once"`（提权的放行本体不认），没表态交给里层问人。

内置插件 plume.approval 在 order 1000，只管帮我批准（`auto`）的风险规则：请求批准档、提权、层自己问的、没有 `subject` 的交给里层；其余按风险规则判：本体的 bash、write、edit 看不出风险的直接放行，命中规则的把理由写进 `request.reason`（按界面语言）交给里层，读项目外、插件的工具一律交给里层；其余交给里层。要放行自己的工具或改严、放宽规则，在外层（默认 order 0）判断，不关心的原样 `return next(input)`；要整个换掉风险规则，在外层不调 `next`。这一层抛错时这次调用以出错结束，不会当作放行。

```ts
// 读 .env 一律拒，不弹卡。
ctx.hook("tool.approve", async (input, next) => (/\.env\b/.test(JSON.stringify(input.call.args)) ? "reject" : next(input)));
```

### `session.rewind`

人撤回一条消息、或者编辑重发时，要截掉从这条人发的消息起的那段对话。截断由宿主做；这个钩子问的是那段里插件自己记着的改动（文件等）能不能、要不要一起退回到截断点之前。先以 `restore: false` 问一次，只演算，界面拿结论问人「连文件一起，还是只动对话」；人选了连文件一起，宿主在截断前以 `restore: true` 再问一次。只动对话时不问。

| 输入字段 | 说明 |
| --- | --- |
| `sessionId`、`cwd` | 哪个会话、工作目录 |
| `session` | 所在的会话：`{ id, kind, parentId?, owner?, spawnedFrom?, project?, steward? }`，见「钩子」开头 |
| `messages` | 要截掉的那段：从被撤回、编辑的那条人发的消息起到最后，副本 |
| `restore` | `true` 是真的写回去，`false` 只演算 |

输出是 `{ files, unrecorded }`：`files` 每项 `{ path, added, removed, problem }`，`problem` 为 `null` 的能安全退回，否则是 `"command"`（改动来自命令）、`"interleaved"`（中途被别处改过）、`"outside"`（不在项目内）、`"modified"`（之后被改过）；`unrecorded` 说有改动没记下来、退回的不会完整。最里层答 `{ files: [], unrecorded: false }`，每一层把自己的结论并进 `next` 的结论里。有一个文件的 `problem` 不为空或 `unrecorded` 为真，界面就只给「只动对话」。

`restore: true` 时要全有或全无：重新校验（从人看到演算到按下确认，文件可能又被改过），有一个不能安全退回就一个都不写，写到一半失败把写了的退回原样再抛错。抛错时宿主不截对话，错误的 message 原样弹给人（按界面语言写），不包成「插件出错」。被人或别的会话改过的文件不覆盖、不合并，留给人。

内置插件 plume.delivery 在这一层退回截掉那段里文件工具记下了快照的改动（经服务 `file.changes`）：新建的文件删掉，改过的写回原样。

```ts
// 记着自己生成过的文件：撤回时一并列出，选了就删掉。
ctx.hook("session.rewind", async (input, next) => {
	const inner = await next(input);
	const mine = generatedIn(input.messages); // 自己的记录，读的是工具结果里自己写下的 details
	if (input.restore) await removeAll(mine); // 全有或全无，不行就抛错
	return { files: [...inner.files, ...mine.map((path) => ({ path, added: 0, removed: 0, problem: null }))], unrecorded: inner.unrecorded };
});
```

## `/` 命令

输入框里敲 `/` 弹出菜单，本体只带一条 `/clear`（开新对话）；别的命令由插件经 `ctx.commands.provide` 供。宿主每次打开菜单、每次发送命令前都现问一遍，命令的来源（文件、配置）改了不用重载插件。

```ts
ctx.commands.provide({
	// cwd：下一轮在哪个目录里跑（不属于任何项目的新聊天为空）；sessionId：输入框所在的会话（新对话为空）。
	async list({ cwd }) {
		return [{ name: "review", description: "审一遍改动", argumentHint: "<文件>", source: "个人" }];
	},
	// rest 是名字后面的原文（去掉首尾空白）。返回发给模型的 text；displayText 不给时气泡里画 text。
	// deliver: "steer"：会话正忙时插进正在跑的这一轮（做完手上这一步就读到），不给就和平常一样排到这一轮后面。
	async expand(name, rest, { cwd }) {
		return { text: `审一下 ${rest || "当前的改动"}，先说结论。` };
	},
});
```

- `name` 是小写字母、数字、连字符，可以用 `:` 分段（`git:commit`）；不合规矩的条目跳过并记日志。`description`、`source` 是菜单里给人看的话，按 `ctx.locale()` 写。
- 几个插件给了同名命令时先加载的那个生效；和本体的 `/clear` 同名的不出现在菜单里。
- `list` 抛错时只是这个插件的命令不出现；`expand` 抛错时消息不发，错误的 message 弹给人看，草稿留在输入框里。
- 展开后的消息照常经过 `prompt.submit`，`text` 是展开后的那段。
- 会话正忙时，展开后的话默认排到这一轮后面；返回 `deliver: "steer"` 的插进正在跑的那一轮，模型做完手上这一步、下一次请求前读到，发给模型时带一句「这是在任务进行中说的」的说明。这一轮已经在收尾、没有循环来取时排进队尾。空闲时都是开新的一轮。
- 命令不发消息、插件自己办掉（`/btw` 把话问到侧边聊天里）时，`expand` 返回 `{ handled: true, openPanel?: "面板 id", openSettings?: "设置分区 id" }`：输入框清空，当前对话里什么都不留；给了 `openPanel` 就打开自己注册的那个面板，能开好几个标签的新开一个；给了 `openSettings` 就打开自己注册的、`page: "nav"` 的那节设置（`plume.commands` 的 `/commands` 打开命令管理）。

## 子会话

侧边聊天、子 Agent 这类「不是主会话的另一段对话」，就是挂在某个会话下面的子会话：和用户的会话同一个循环、审批、存储和事件，不另存一套对话。

```ts
// 工具里派一个子会话，跟着这一轮停（signal）。
const child = await ctx.sessions.create({ parentId: run.sessionId, title: "找入口" });
const stop = await ctx.sessions.send(child.id, "入口在哪？", { signal: run.signal });
const reply = (await ctx.sessions.messages(child.id)).findLast((message) => message.role === "assistant");
```

- 工作目录、项目随父会话；没另选模型时用父会话的模型和思考档位。子会话不进侧栏，不能再挂子会话，父会话删掉时一起删（`onDeleted` 每个都会收到）。
- `send` 的这句话照常经 `prompt.submit`；默认是人的气泡，派发任务传带 `origin: "parent"` 的 `SessionMessage`。正在跑时抛错，运行中插话用 `steer`，宿主等工具结果完整后再交给模型。`signal` 中止、`stop` 都让这一轮以 `aborted` 结束。
- 后台用 `start`，它只等运行登记，不等回答；工具先交回子会话 id，后台用 `wait(run.id)` 等结果、`report(run.id, text)` 交给父会话。每次续跑是新的运行句柄，不能按子会话 id 重复交差。所有异步错误都要处理；不要用轮询或直接改会话库模拟送达。
- 父轮正常结束不取消后台，明确停止父会话会取消后台及待送达结果，不连带停止独立 `send` 的侧边聊天。插件停用、父会话删除或应用退出也会取消。插件自己的排队名额和未启动项经 `onStopped`、`onDeleted`、`ctx.effect` 清理。
- 续跑复用原子会话，重建该种类的提示词与工具限制后再次 `start`；别创建新会话丢掉上下文。种类、排队状态和模型偏好由插件存到 `ctx.dataDir`，宿主不识别这些业务字段。
- 子会话用什么提示词、哪些工具，经 `model.context`、`tool.execute` 按 `sessionId` 认出自己的会话来改（建的时候记下 id；重启后从 `list()` 里按 `owner` 找回）。各钩子的输入和 `run` 直接带着 `session`（`kind`、`parentId`、`owner`），只想分清子会话和顶层会话时看它就够。隐藏不等于禁用：藏起的工具在 `tool.execute` 里再拦一次。
- 子会话要人批准时，审批卡压在主输入框上方，卡上写着子会话的标题；界面入口用 `ui.Conversation` 画它、`ui.useSession` 读它（见 ui.md）。
- 子会话够得着它的父会话，只此一个：你自己建的子会话里，你自己注册的工具的那次调用拿得到 `run.parent`（别的插件的工具、别人的子会话、顶层会话里都是 `undefined`）。只在这次调用里用：调用答完以后再调它的方法就抛错。

```ts
async execute(args, run) {
	if (!run.parent) return { output: "This tool only works in a side chat.", isError: true };
	const { started } = await run.parent.enqueue(String(args.instruction)); // 排进父会话的队列，和人排的同一条；闲着当场开跑
	await run.parent.stop({ discardPlan: true }); // 停下；discardPlan 时删掉交过来的任务、记一句旧清单作废
	await run.parent.carryOn("继续，从中断的地方接着做。"); // 闲着时以界面的名义说一句，不等那一轮
	run.parent.status(); // { state: "running" | "background" | "idle", queued }
}
```

  排进去的话标着 `origin: "child"`、`fromPlugin` 是你的插件名（界面上是「来自<你的显示名>」）、前面带一句来处说明，不算人的授权，审批照常。人在卡片上点的「交给主会话」用 `ToolCardProps.handToParent`（见 ui.md）。

## 独立会话

插件自己的页面要一个一直在的助手（主机页右边的运维助手）时，`create` 不给 `parentId`，建一个不挂在任何会话下的独立会话。它也记在你的插件名下（`owner`），同一个循环、审批、存储，只有你能经 `send` / `steer` / `stop` / `delete` 动它。

```ts
const assistant = await ctx.sessions.create({ title: "运维助手" }); // 不给 project、cwd：放在不属于项目的聊天目录里
const stop = await ctx.sessions.send(assistant.id, text);
```

- `project`（项目 id）或 `cwd`（已有目录的绝对路径）二选一；都不给就放在聊天目录里。没另选模型时用默认模型。子会话不能给这两项（随父会话）。
- 它不进侧栏、搜索、托盘、`@` 引用和已归档列表，不能归档、下面不能挂子会话，不发系统通知；人只在你的界面里经 `ui.Conversation` 看到它（见 ui.md）。
- 它不是顶层会话：工具调用里没有 `run.background`、`run.letter`、`run.archiveAfterTurn`、`run.parent`，`start` 抛错（后台运行只给子会话），`prompt.submit` 给的 `cwd` 不换它的目录，别的会话寄信也寄不到它。
- 插件停用、卸载都不删它；下次启用时从 `list()` 里按 `owner === ctx.name`、没有 `parentId` 找回自己的。要它没了就 `delete`；人在设置 › 数据里按时间清理记录时也会一起清掉，所以拿着的 id 用前确认它还在。
- 它用什么提示词、哪些工具，和子会话一样经 `model.context`、`tool.execute` 按 `sessionId` 认出来改。

## 开新会话

插件不能往已有的会话里发话，只有一个例外：开一个**新的**会话、把第一句话发出去（定时任务到点了、人点了「在新会话里执行」）。

```ts
const { session, done, idle } = await ctx.sessions.launch({ project: task.project, message: task.prompt });
const stop = await done; // 第一轮为什么结束：done、error、stalled、max_turns、aborted（人按了停止）……
await idle; // 第一次真闲下来：它派出去的子 Agent、后台命令都回来了，问出去的请求都有了答复，结果唤起的几轮也做完了
```

- 新会话和人在侧栏新建的一样：进侧栏、没有 `owner`、模型不给就用默认模型。开出来就是人的会话：人能接着聊，插件之后不能再 `send`、`stop`、`delete` 它，`done` 只管第一轮；「这次跑完了没有」看 `idle`（定时任务据此判断能不能开下一次）。
- 第一句话照常经 `prompt.submit`，画成人的气泡；被拦下时这一轮按 `done` 收场，会话留着。
- `project` 给了就用项目的目录；不在项目里时 `cwd` 要是已有目录的绝对路径，两样都不给是不属于任何项目的聊天。`spawnedFrom: { sessionId, toolCallId? }` 记下是从哪个会话开出来的（写进摘要），那个会话要在、不能是子会话。不对时抛错，message 是给人看的话。
- 什么时候开由插件定，但开出来的每个会话都是实打实的一轮模型调用：只在到点了、人点了按钮时开，不在渲染、循环里开。界面上要把人带过去，用 `ui.openSession(session.id)`（人点了按钮时）。

## 代管会话

要把一个会话接到 Plume 之外（外面的人经你的插件发消息、看回复、答审批），开会话时带上 `steward: true`：这个会话由你代管，之后你能接着往里说话、替人答卡。

```ts
const { session } = await ctx.sessions.launch({ cwd, message: first, steward: true });
await ctx.sessions.post(session.id, "外面的人又说了一句"); // 排进队；闲着就开一轮，忙着排着，不插话
ctx.sessions.observe(({ sessionId, event }) => {
	if (sessionId !== session.id) return;
	if (event.type === "approval" && event.approval) forward(event.approval); // 弹着的卡（审批或等人给数据）
	if (event.type === "response") forwardReply(event.reply); // 模型的一段回复
});
// 外面的人答了：
await ctx.sessions.respond(session.id, approval.toolCallId, "once"); // 审批卡（含提权）：once 或 reject
await ctx.sessions.answer(session.id, request.toolCallId, { answer: "先备份" }); // 等人给数据的卡：值由那个工具核
```

- 会话还是人的顶层会话：进侧栏，人能接着聊，标题旁写着「由 你的显示名 代管」；权限照这个会话的设置，不因话是你转来的而变。钩子里 `session.steward` 是代管它的插件。
- 转来的话画成人的气泡、标着「你的显示名 转来」，模型读到的前面有一句本体写的来处说明（插件从 Plume 之外转来、发送者 Plume 没核实）；`prompt.submit` 的 `launched` 为 true。
- 卡只答弹着的那一张（`approval` 事件里的那张），人在桌面上照样能点，谁先到算谁的。「以后不再问」不给插件。你答的那次调用底下写「由 你的显示名 代答」，模型读到的结果里也写明是你转达的。外面答的人是不是该答的人，由你确认，本体不核。
- 人在会话菜单里点「停止代管」以后，`post`、`respond`、`answer` 都抛错，你转来还排着的话一起拿掉；插件停用后也抛错。只能动自己代管的会话，不能事后认领人已有的会话。
- 例子是仓库里的测试插件 `packages/testing/steward-probe`（面板代替外面的人）。

## 服务：插件给插件用的一组方法

一个插件提供实现，别的插件按名字用；依赖的是服务名，不是某个插件，所以谁提供都行，能整个换掉。

```ts
// 提供的一方
export default {
	name: "example.speaker",
	apply(ctx) {
		ctx.provide("echo", { say: (text: string) => `echo: ${text}` });
	},
} satisfies Plugin;

// 用的一方：把服务名写进 inject
export default {
	name: "example.listener",
	inject: ["echo"],
	apply(ctx) {
		const echo = ctx.use("echo");
		ctx.tools.register({ /* … */ async execute() { return { output: echo.say("hi") }; } });
	},
} satisfies Plugin;
```

- 服务的接口是 `@plume/contract` 里的 `Services`。自己定义的服务用声明合并加一项：`declare module "@plume/contract" { interface Services { echo: { say(text: string): string } } }`。
- `inject` 里的服务都有插件提供了才调 `apply`；缺的时候插件是「等待」状态（「插件市场」里它的详情页写着在等哪项服务），补上了自动加载。
- 同一项服务只有一个生效的提供方：非内置的优先于内置的（这就是替换 Plume 自带的实现），同是非内置的先加载的那个生效，别的记一条警告。
- 生效的提供方换了、停了、卸了，用它的插件先停用（`effect` 照常执行），再按现在的提供方重新 `apply`；所以 `ctx.use` 拿到的在这次加载里一直可以用。
- `ctx.use` 给的是宿主包过的一份：只有方法，冻住了，改不了提供方的对象。要改服务的行为，整个替换它，不要往上面挂东西。

Plume 自带的服务：

| 服务 | 提供方 | 接口 |
| --- | --- | --- |
| `sandbox` | 内置插件 plume.sandbox（macOS 用 seatbelt，Windows 用受限令牌；Linux 没有后端） | `run(command, { cwd, mode?, shellMode?, env? })` 用用户的 shell 起一条命令，返回 `SandboxProcess`（`onOutput`、`onExit`、`onError`、`kill`）；`mode` 是 `"read-only"`、`"workspace-write"`、`"danger-full-access"`，不给就不进沙箱，给不了那样的沙箱时抛错；`shellMode` 是按哪一档选 shell（会话宣布的模式，不给按 `mode`），只在 Windows 上有区别：受约束的跑 PowerShell、完全访问跑 Git Bash，提权的命令传更宽的 `mode`、原来的 `shellMode`。`looksDenied(output)`：输出像不像被沙箱拒了。plume.tools 的 bash 用它；换一种沙箱（容器、远程机器）就提供一个自己的 `sandbox` |
| `resources` | 内置插件 plume.tools（它的 read、ls 认这些地址，write、edit 认 `scratch://`） | 资源地址 `scheme://路径[:行-行]`，类型在 `@plume/contract` 的 `ResourceHandler` 等。`register(handler)` 加一个只读的 scheme（`describe` 写进系统提示词的地址清单，`resolve` 读一个地址、找不到时抛错，错误信息直接交给模型；可选 `list` 给 `read scheme://` 列目录、`locate` 给 ls 一个磁盘位置），返回撤下的函数，用 `ctx.effect` 撤；内容不是你写的（第三方文档、外部服务）时给 `origin`，read 把它包进 `<resource origin="…">`。路径的越界（`..`、软链出去）由 scheme 自己挡。`keepArtifact(sessionId, tool, content)` 存一大块原文换回 `artifact://<id>`（按内容算，同一段每次同一个地址；按会话在内存里，最多 30 份）。plume.tools 自己有 `scratch://`（唯一可写）、`artifact://`、`session://`（别的会话的转录）、`plugin://`（插件的 README 和目录里的文件），技能插件加了 `skill://` |
| `file.read` | 内置插件 plume.tools | `authorize(run, path)` 与文件工具共用读取授权，返回 `{ ok: true, absolute }` 或 `{ ok: false, message }`。消费方声明 `inject: ["file.read"]`，用当前工具的 `ToolRun` 调用，成功后实际读取必须使用返回的 `absolute`；详见下文 |
| `project.files` | 内置插件 plume.tools（它的 glob、grep 也用这一份） | `list(root)`：`root` 之下 git 认为该看的文件（已跟踪的加上未跟踪且没被忽略的），绝对路径；不在 git 仓库里时是 null，自己走目录。问 git 时不执行仓库能控制的程序，插件要列项目文件就用它，不要自己跑 `git ls-files` |
| `session.worktree` | 内置插件 plume.git | `available(cwd)`：这个目录在不在 git 仓库里，在才开得出工作树。`requestFor({ sessionId, toolCallId })`：从这次工具调用开出来的会话（`ctx.sessions.launch` 的 `spawnedFrom`）第一轮开始时在它自己的工作树和分支里跑；先登记再 `launch`，返回的函数撤销登记，只在 `launch` 抛错时调（开出来以后由第一轮取走，撤了会和它抢）。建、收回、合并回去都归 plume.git |
| `secrets` | 内置插件 plume.secrets（AES-256-GCM，钥匙在它的数据目录） | 插件要存的密钥（令牌、密码、请求头里的凭据）不要明文写进配置：`seal(value)` 加密成带 `plume-sealed:v1:` 前缀的文本，写回你自己的配置；`unseal(sealed)` 解回来，不是密文或钥匙打不开时是 null（当成没填、让人重新填），钥匙文件读不出来时抛错（这时别把空值写回去盖掉密文）；`isSealed(value)` 分出手写的明文和密文。只加解密、不替你存，删配置就是删密钥。挡的是配置被同步、拷走时带出明文，挡不住同一用户的程序 |

### 文件读取授权

`Services["file.read"]` 只决定能不能读，不读取文件、不授予写权限，也不把文件记作“模型已读过”。插件先校验自己的参数，再调用服务；拒绝时把 `message` 作为错误结果交回，不能改用其他路径或工具读取。

```ts
const access = await ctx.use("file.read").authorize(run, path);
if (!access.ok) return { output: access.message, isError: true };
const content = await readFile(access.absolute, "utf8");
```

服务解析相对路径和符号链接，复用工作目录、项目源文件夹、临时目录、人拖进来的文件（`run.allowedPaths`）及会话已有的批准记录；源目录内指向外部的链接按实际目标判断。工作区外或密钥文件照现有审批规则处理，项目里的密钥也不因项目授权直接放行。普通不存在路径可能返回 `ok: true`，读取错误仍由调用方处理；密钥路径即使不存在也会经过审批。不要自行把 `run.projectRoots` 当成写入白名单，也不要用授权结果绕过文件工具的读前检查。

### 文件变更服务

内置插件 `plume.tools` 提供 `file.changes`。消费方声明 `inject: ["file.changes"]` 后，经 `ctx.use("file.changes")` 调用：

- `collect(sessionId, cwd, ids)`：`ids` 来自本轮工具结果 `details` 里的改动记录（`@plume/contract` 的 `FileChangeDetails`：`changeId` / `changeIds`，记不全时 `changeWarning` 是给人看的话；按这个形状认，不认是哪个工具交的），返回按文件合并的净变化、diff、能否撤销和警告；修改后又恢复原文的不列出。
- `undo(sessionId, cwd, ids, path?)`：指定文件或整轮撤销。它重新读取快照，不接收界面提供的原文；检查当前内容、连续修改链和项目边界，命令观测的改动不能自动撤销。界面必须先确认，显示状态不是写入许可，最终以执行时复查为准。

快照由工具在实际写入处记录，保存在工具插件的私有目录；插件不要从工作区当前 Git diff 猜本轮修改。`plume.delivery` 消费此服务，按会话原始消息生成交付报告，报告不调用模型。

## 网页

浏览器这类插件自己画网页：界面入口在面板里放一个 `<webview>`，页面怎么走、读什么、点哪里都由逻辑入口经 `ctx.pages` 驱动。宿主只管主进程才做得到的事，不认识地址栏、标签、书签这些。

- **认下一页**：`<webview>` 挂上（`did-attach`）以后，界面入口读 `getWebContentsId()`，经 `ui.remote()` 交给逻辑入口，逻辑入口调 `ctx.pages.attach(id, contentsId)`；`id` 是插件自己起的页面名（浏览器用面板标签的 id）。之后的方法都按这个 `id` 找页面，只找得到自己认下的。一个 `<webview>` 只能认作一页；它被卸掉（标签关了、组件卸了）就收到 `detached`，页面没了。同一个 `id` 再认另一个 `<webview>` 时换成新的（标签弹到独立窗口、接回来时就是这样），旧的不再算、卸掉时不报 `detached`。
- **宿主管着的**：主窗口和弹出去的面板窗口能挂 `<webview>`（面板 `detachable` 时弹出去的那边画一个新的，按地址重新加载、重新 `attach`）；页面一律沙箱、不开 Node、不带 preload，存在单独的一份浏览数据（`persist:plume-web`）里；只放 http、https 和 `about:blank`，跳去别的协议的被拦下，报 `blocked`；页面要开新窗口不开，报 `popup`（插件自己决定开成一个标签还是不管），脚本按尺寸开的小窗（第三方登录、支付）例外：宿主开成挂在 Plume 窗口上的小窗口、和开它的页面连着，报 `popup` 时带 `window: true`，插件不用再开、也驱动不了它；页面要的权限（摄像头、通知……）一律拒。
- **事件**：`ctx.pages.onEvent(listener)` 收自己全部页面的事件，每条带着页面此刻的 `state`（地址、标题、加载中、能不能前进后退、缩放）：`attached`、`detached`、`navigation`（主框架开始换文档）、`dom-ready`、`loading`、`navigated`、`title`、`failed`、`gone`（页面进程没了）、`blocked`、`popup`、`dialog`。认下之前就发生的（第一跳）在认下时补发。停用时自动撤下。
- **读页面、找元素**：`evaluate(id, code, { isolated: true })` 在插件自己的隔离 world 里跑——和页面共用 DOM，页面的脚本看不到它记下的东西，换文档时一起丢掉；不给 `isolated` 是在页面自己的 world 里跑（要读页面的全局变量时）。页面卡住时 `evaluate` 不会自己超时，自己加时限。
- **点按、输入**：`input(id, event)` 发原生的指针、滚轮、按键事件，坐标是页面视口里的像素（CSS 像素乘上缩放）；`insertText` 往有焦点的输入框里打字；之前先 `focus`。
- **对话框**：`answerDialogs(id, true | false)` 之后，这一页的 alert、confirm、离开页面提示由宿主直接答（alert 总是确定），答了什么经 `dialog` 事件报回来，连同之前就开着、没人答的那一个；`null` 交回系统对话框。只在 agent 操作网页期间接管：人自己浏览时页面照旧弹给人。
- **从 Chrome 同步登录状态**：`chromeLogins("status" | "on" | "off")` 把本机 Chrome 的 cookie 单向同步进网页的分区（只有 macOS），各插件共用一份。`on` 由宿主弹系统对话框请人确认，人不同意时交回的仍是关着；`off` 删掉同步进来的。交回 `ChromeLoginSync`：开没开、`problem`（`no-access` 要人到完全磁盘访问权限里打开 Plume，`keychain-denied` 再调一次 `on` 重试）、Chrome 用户名、条数、上次同步时间，没有 cookie 的值。
- **截图**：`capture(id, { rect?, points? })` 交回 PNG 的 data URL，页面没设背景的地方垫成白的；`rect` 截视口里的一块（CSS 像素乘缩放）；`points: true` 按屏幕缩放比缩回点，给模型看的图用它（高分屏上不白占一倍的上下文）。截出来交给模型时去掉 `data:` 前缀放进工具结果的 `images`。
- **缩放、视口**：`setZoom(id, factor)`（0.25–3），`emulate(id, { width, height, scale })` 仿真一个视口、`scale` 是缩小到面板里的比例，`null` 撤掉。页面进程停了的时候这两样不生效，等 `dom-ready` 再设一次。
- 不在桌面应用的主窗口里（测试、命令行）时，`ctx.pages` 的方法抛错。完整的例子是 `browser` 插件。

### 隐藏页面检查

`ctx.pages.inspect(url, { width?, from?, screenshot?, measure? })` 不需要 `attach`：宿主在独立临时沙箱加载 HTTP(S) URL，返回 `{ exceptions, errors, width, height, screenshot?, shotTop?, shotHeight? }`。截图为 PNG base64，一次最多 2160px，`from` 指定起点；`width` 默认 720、范围 320–1600。`measure` 是返回内容高度的表达式，不传时用文档滚动高度。

检查不共享浏览器登录，禁用设备权限、下载、弹窗、页面导航，最长 12 秒后销毁。加载、测量或截图失败时抛错，插件不能将未完成检查当成通过。页面内容、文件服务、主题和状态归插件，宿主只负责 Electron 加载与截图。`plugins/preview` 是检查后发布及沙箱 iframe 工具卡片的示例。


## serve：给自己的界面开接口

界面入口拿不到 agent 进程里的东西。不随会话保存的实时数据和操作（终端的 shell、插件自己存的数据），由逻辑入口用 `ctx.serve(api)` 开出来，界面入口用 `ui.remote()` 调（见 ui.md）。

- 接口类型写在 `src/api.ts`，两个入口共用。
- 参数和返回值要能结构化克隆（不能传函数、类实例）。
- 运行时会在参数末尾追加一个 `CallContext`（`{ signal }`）。要响应取消的方法，参数个数写死，最后一个参数接它；界面那边调用时不传。
- 返回异步迭代器（`async *method(…)`）的方法，每个 `yield` 推给界面；界面取消时 `signal` 中止，迭代器提前结束、`finally` 收尾。生成器卡在某个 `await` 上时要等它下一次 `yield` 才结束，所以长时间的等待自己接上 `signal`。

```ts
// src/api.ts
import type { CallContext } from "@plume/contract";
export interface MyApi {
	list(): Item[];
	watch(call: CallContext): AsyncGenerator<Item[], void>;
}

// src/index.ts
const api: MyApi = { list: () => store.list(), async *watch(call) { /* yield 直到 call.signal 中止 */ } };
ctx.serve(api);
```

## 原生依赖

`node-pty` 这类原生模块写进 `package.json` 的 `dependencies`。在用到时才 `require`，不在 `apply` 里、也不在文件顶上静态导入：加载失败（架构不对、系统库太旧）时只影响那一个功能，不会让整个插件 failed。例子见 `plugins/terminal/src/index.ts`。

## 测试

插件自己的纯逻辑（判断、存储、解析）可以在插件目录里写测试（如 `plugins/terminal` 用 vitest，`package.json` 里加 `test` 脚本）；`pnpm check` 会跑各包的 `test`。

## 只读运行观察和后台任务

`ctx.sessions.observe(listener)` 订阅 `SessionObservation`：实际模型请求和响应、工具开始、审批、重试、通知、运行状态、一轮收场（`turnEnd`，带 `stop`：完成、出错、被停下、用满步数、原地打转，退出应用时停下的是 `interrupted`）与撤回。每个观察者拿独立副本，异常只记日志，不能拦截或改变执行；订阅在插件停用时撤下。事件不提供供应商配置、请求头或密钥。`at` 是观察时已有的消息数，持久化者在 `rewound` 时删掉 `at >= count` 的观察，在 `onDeleted` 时清理整段会话。诊断记录不是新的上下文，不应再注入模型。

内置 `plume.tools` 提供 `background.jobs`，消费方声明 `inject: ["background.jobs"]`：

- `list(sessionId)` 只返回该会话的任务元数据，包括已结束的任务；表跟随当前进程，历史命令仍在会话消息里。
- `output(sessionId, jobId)` 读取日志末尾至多 256 KiB，返回 `text`、`done`、`truncated` 和可选 `error`，不消耗模型未读输出、不抑制送达。
- `stop(sessionId, jobId, force)` 只停止该会话持有的进程句柄，不能传 pid；强制结束前界面应显示命令并确认。

`plume.tools` 还提供 `session.wakeups`（`inject: ["session.wakeups"]`）：模型经 `schedule_wakeup`、`cron_create` 给会话安排、还没触发的定时唤醒。`list(sessionId)` 按下一次触发排好返回 `SessionWakeup[]`（`id`、`kind`、`prompt`、`reason?`、`cron?`、`recurring`、`nextAt`、`expiresAt?`、`fired`），`cancel(sessionId, id)` 取消一个、没有时答 false。唤醒只活在内存里，到点经后台送达（`delivery.kind: "wakeup"`）进会话，人按停、删会话或退出应用时一起取消；撤回、编辑重发只取消截掉的那段里建的。
