# 工具

提供 read、write、edit、ls、glob、grep、bash、bash_output、monitor；文件改动前询问用户，写文件经本体的 `run.files.change`（写边界、写前复核、改动快照都在本体），命令经本体的 `run.exec` 在权限模式对应的沙箱里运行（提权经 `run.escalate`）。read 读 PNG、JPEG、GIF、WebP 图片时原样把图交给模型（最大 5 MB，不缩放；BMP 交不出去，照实说）。

## 资源地址

read、ls 除了文件路径，还认 `scheme://路径`（末尾可带 `:10-40` 只要这几行，光写 `scheme://` 列出里面有什么）；地址清单经 `model.context` 写进系统提示词的 `resources` 段。地址和读边界归本体（`run.files.read`、`ctx.resources`），本体自带四种：

- `scratch://`：会话的临时目录（宿主给的 `run.scratchDir`，会话删掉时一起删）。唯一可写的地址，write 经 `run.files.write` 写、edit 改它指的那个文件；临时目录里指向外面的软链读写都拒。用绝对路径读写这个目录也不问人。
- `artifact://<id>`：被剪掉的大块输出，按会话存在内存里（最多 30 份），重开应用后就没有了。
- `session://<id>`：另一次会话的转录，一条消息一行，工具调用只留名字；`session://` 列出最近的会话（不含当前的、归档的和子会话）。
- `plugin://<插件名>`：插件的 README，没有就给 `package.json` 里的版本和说明；`plugin://<插件名>/<路径>` 读它目录里的文件。

后三种的内容不是这个项目写的，read 把它包进 `<resource origin="…">`。别的插件经 `ctx.resources.register(handler)` 加只读的 scheme（技能插件的 `skill://`）。

## 改动记录

edit、write 经本体的 `run.files.change` 写文件，可能改文件的 bash 命令（判不出只读的）带 `recordChanges` 跑：快照、命令前后的对比、撤销和它们的门闩都在本体（`@plume/workspace`），这次调用改了哪些文件由本体记在结果上（`ToolResultMessage.changes`），交付卡、撤回据它认；这个插件不存快照、不提供服务。只读的命令不观测：它不写文件，对比却要起好几个 git、还挡着撤销。后台命令到起它的那次调用答完还没结束的，`bash_output` 读它时经 `run.files.includeChanges` 把记下的算进那次结果。工具结果里的 `details`（diff、命令输出）只给卡片画，不带快照标识和原文。

## 后台任务和完整输出

bash 的完整输出写进会话临时目录的 `tool-output/<uuid>.log`（只新建、权限 `0600`）；给模型的那一份截过时，结果末尾给出日志路径，截断标记里的行号就是日志的行号，`read` 按 `offset` / `char_offset` 读得到省略的部分。`details.outputPath` 记着路径；没有临时目录或建不出来时不写日志，命令照跑。

`run_in_background` 起的、超过默认等待转到后台的、命令退出后留下的进程都是这个会话的后台任务。顶层会话里任务自己结束时，退出状态和模型上次读之后的输出经宿主的 `ToolRun.background` 渠道送给模型（`<background_job>`，对话里画一行「后台命令完成」），送出那一刻模型已经读过、或任务被 `bash_output` 停掉的不送；结果里因此叫模型别轮询。人按停后，停下以前起的任务照跑，只是不再叫醒会话。子会话没有渠道，结果叫模型自己用 `bash_output` 读。

每个后台任务都经 `ToolRun.track` 登记进本体：本体据此算会话闲没闲（顶层会话里没结束、渠道还有效的任务在，会话就不算闲；`monitor` 登记成 `wakes`，不算；普通后台命令打印出本机带端口的地址时经 `stand()` 标成挂着的服务，也不再算，见 `serving.ts`），删会话、退出应用、子 Agent 那一段跑完时停掉它们，经 `ctx.sessions.jobs` 列给运行诊断；停的时候调回这里，和 `bash_output` 停它走同一条路。定时唤醒（`schedule_wakeup`、`cron_create`）经 `ToolRun.schedule` 交给本体调度，这里只定参数、上限和到点送进去的那段话。

对话里那一行是本插件的界面入口（`src/ui.tsx`）经 `ui.agentDelivery` 画的：后台命令结束、monitor 送来一批、定时唤醒到点各一种，命令、退出码、cron 放在送达的 `details` 里（`src/delivery.ts`），宿主不读；后台命令那几份标 `inline`，插在一段活中间时并进那段活。点后台命令那一行经界面侧服务 `background.jobs.view`（`ui.useService`）交给提供它的插件（运行诊断）打开任务输出，没人提供就不给点。

monitor 跑命令的那一套（审批、沙箱、日志、任务表）全用 bash 的，只是边跑边把新输出的行分批送给模型（`<monitor_events>`）：第一行之后等 1 秒凑齐、同一个 monitor 两批至少隔 10 秒、每批留最新 4000 字、单行截到 1000 字，去掉颜色、`\r` 重画的行只留最后一次；满 `max_events` 行（默认 100，至多 1000）或 `idle_timeout` 毫秒没输出（默认 10 分钟，至多 1 小时）自己停，最后一批写明原因；人按停时跟着停，`bash_output` 加 `kill: true` 停掉它。子会话不列这个工具。
