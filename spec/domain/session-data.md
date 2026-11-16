# 会话的数据

管和会话有关的数据跟着会话走：会话删掉时，和它有关的数据一律删掉，只有使用统计留着。删法有好几种：侧栏、设置里单删，删除全部归档，按日期清除，插件删自己建的会话（`ctx.sessions.delete`）；规矩都一样。新存一样按会话记的东西、改删除的流程之前读。

## 开发准则

- **删会话就删它的数据。** 按会话记的东西，不管放在哪（本体的库和文件、插件 `dataDir` 里的库和文件、界面的 localStorage、只在内存里的），存的时候就写好删除。各管各的那份：
  - 本体在 `deleteTree` 里删：会话库的行（`records`、`drafts`、`queue`、`media_refs` 随 `sessions` 那一行级联删）、临时目录、排队、待送达、后台任务、唤醒、改动快照（`ChangeStore.forget`）、没有别的会话再用的图（`store.delete` 交回的名字）。
  - 插件存图（`ctx.media.save`）时带上会话 id，图跟着那个会话删；不带的算插件自己的，一直留着。
  - 插件在 `ctx.sessions.onDeleted` 里删自己记的，按父会话记的连同删（子智能体的任务按 `parent` 删，侧边聊天的标签按主会话删）。会话的工作树和分支也一样：没提交的改动、没合并的提交都不留，删除确认框事先写明。
  - 界面在 `app/sessions.ts` 的 `forgetSessions` 里删；重新拉整份会话列表（`refresh`）时，不在列表里的也照样清。
- **唯一的例外是使用统计。** 花销表（会话库的 `spend`）删会话时不动，统计页的数不因为删了会话而变。人自己导出到别处的文件不归应用管。
- **子会话跟着父会话删。** 子智能体、侧边聊天这些挂在父会话下的会话和它们的数据，删父会话时一起删，父会话归档了也一样。
- **正在跑的也删。** 删除不跳过正在跑的会话：`deleteTree` 先停下它和子会话正在跑的那一轮、后台任务，再删；批量删除（删除全部归档、按日期清除）也一样，不留「正在跑、没删」的。删掉以后才回来的结果不写回任何地方、不送达。
- **几个会话共用的数据删到没人用为止。** 按内容存、几个会话共用一份的，最后一个用它的会话删掉时删。图按 `media_refs`（哪个会话用到哪张）记，写消息时登记，分叉、复制照样登记。
- **加载时补删。** 删会话时没在跑的（插件停用着、删到一半退出）会漏掉 `onDeleted`，所以按会话存的东西加载时对着现有会话（`ctx.sessions.list()` / `get`）再清一遍；加载之后才记下的不清，免得列表稍旧时删掉刚建的。本体启动时同样清图、临时目录、改动快照。

## 检查点

- 新加的持久化数据里有会话 id（键、列、文件名、目录名）的，评审时对一遍：删除写在哪，删父会话时它的子会话那份删不删。
- 测试删会话以后查不到它的数据：本体在 `packages/core/agent/test/`，插件在自己的 `test/`（假宿主删会话时要和真的一样连子会话、先停那一轮，见 `packages/builtin/subagents/test/task.test.ts` 的 `deleteSession`），界面在 `apps/desktop/test/`。
- 冒烟 `conversations` 段最后删掉开着面板的会话，验 localStorage 里不再留它的面板标签、开合和侧栏收起记录（见 [docs/smoke.md](../../docs/smoke.md)）。

## 事实来源

- 本体：`packages/core/agent/src/agent.ts` 的 `deleteTree`、`deleteArchivedSessions`、`clearSessions`；`packages/core/agent/src/session-db.ts` 的 `delete`（外键级联）；`packages/core/agent/src/host.ts` 的 `sessionDeleted`（发 `onDeleted`）
- 图：`packages/core/agent/src/media.ts` 的 `mediaNames`、`removeImages`、`sweepImages`；会话库的 `holdMedia`、`mediaInUse`
- 插件的例子：`packages/builtin/subagents/src/store.ts`（`deleteByParent`）、`packages/builtin/diagnostics/src/store.ts`（`keepOnly`）、`packages/builtin/mcp/src/index.ts`（连接、文档、延迟加载的记录）、`packages/builtin/plan/src/index.ts`、`packages/builtin/prompt/src/presets.ts`、`packages/builtin/side-chat/src/bindings.ts`（`forget`、`keepOnly`）、`packages/builtin/git/src/worktree/serve.ts`（`discardWorktree`）
- 界面：`apps/desktop/src/renderer/app/sessions.ts` 的 `forgetSessions`、`refresh`；`forgetPanels`、`forgetThreadFolds`、`forgetLocatedPaths`
