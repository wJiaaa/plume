# 项目开发红线（任何任务都先读这一页）

> 只放任何任务都生效的开发约束。具体需求再按 [`index.md`](./index.md) 进入对应 rule。

1. **密钥** —— API key 只在主进程和 agent 进程里用，不进渲染进程、日志、截图和提交；供应商的 key 加密存在 `~/.plume/credentials.json`，钥匙 `vault.key` 就在旁边；插件的密钥经本体给的 `ctx.secrets` 加密后写在插件自己的配置里，不明文落盘，钥匙由同一个 `vault.key` 按插件名派生（各插件的密文互相解不开）；`~/.plume/settings.json` 里还有 Magpie 网关的明文 key，仓库根目录旧的 `model.json`（已被 git 忽略）是明文；这几样都不提交、不打印。冒烟和测试不碰系统钥匙串。
2. **本体与插件** —— 本体（`packages/core`、`apps/desktop`）只守会话不坏的那几条线：模型调用、agent 循环（每个工具调用都有结果、步数上限、停止、重试、截断续写和空回复催促、重复检测、在固定时机调钩子）、哪些调用要问人、权限模式的含义（完全访问放行，提权只认人在卡上答、或代管这个会话的插件经答卡接口转达，钩子、权限模式、「以后不再问」都不算；每个权限模式下命令跑在哪一档沙箱、外层要求只读时拦下写、改文件的工具，工具经 `run.exec`、`run.escalate` 用，`packages/core/sandbox`）和审批卡、会话存储、插件宿主、界面骨架。其余能力（工具、帮我批准的风险规则、系统提示词、压缩）做成**内置插件**：放在 `packages/builtin/`，名字以 `plume.` 开头，随应用发，不能停用、卸载，可以被别的插件替换（服务）或在外层接管（钩子）。会话列表和会话窗由本体统一维护，插件通过工具卡片、会话卡片等局部扩展点接入，不接管完整列表或会话渲染。普通 Markdown 的链接、图片、表格等基础阅读能力属于本体，默认可用；生图、图库等可选能力做插件。新增钩子、服务或界面扩展点前，先要有一个真实插件需要它。内置插件不依赖、不认识市场插件；市场插件要用内置插件的能力经服务（`inject`）。内置功能的主路径必须用到的能力做成内置插件、经服务提供，门槛是「几乎人人要用，且主路径离不开」（例：Git 和工作树是 `plume.git`，建议新会话经服务 `session.worktree` 开工作树）。
3. **共享类型** —— 所有共享类型放 `packages/contract`（`@plume/contract`、`@plume/contract/ui`），实现包只导出函数和类。插件只 `import type` `@plume/contract`，运行时的一切从 `ctx` / `ui` 上拿；界面入口还可以用共享的 `react`、`@plume/ui`、`@plume/styles`。Plume 自己写的插件（`plume.` 开头）同样只走这条路，不引用宿主的实现；`pnpm check:plugins` 会查。
4. **依赖方向** —— `apps/` 放产品，`packages/` 放共享类型和库，市场插件放在旁边插件仓库 plume-plugins 的 `plugins/`，`packages/` 按 `packages/<组>/<包>` 分组（`contract` 除外，新包放哪见 `packages/README.md`）；`packages/` 不依赖 `apps/`。`packages/infra/rpc` 跑在三个进程里，不引用 Node、Electron 的模块和第三方依赖。`packages/core/llm` 是自成一体的模型调用包，保持它自己的写法（不受仓库的 lint、格式和 knip 检查），见它的 README。
5. **公共接口** —— `@plume/contract`、`@plume/ui`、`@plume/styles` 经 import map 给插件用，是公开接口：改导出前先 `rg` 全部引用（产品、插件仓库的 `plugins/`），只加不改语义。插件 SDK（`@plumeai/plugin-sdk`）的类型声明就是从这几个包生成、发给仓库外插件作者的那一份。插件接口（`PluginContext`、`UiContext`、钩子及其输入输出）有变化时，同一次改动里同步 skill [`skills/plume-plugin`](../skills/plume-plugin/SKILL.md)。
6. **样式** —— 颜色、字号、圆角、阴影、动效只用 token，规则见 [`tech/styling.md`](./tech/styling.md)；`pnpm check` 里的样式检查不能绕过，例外登记在检查脚本里并写明原因。
7. **Git 与运行** —— 不做破坏性操作，不覆盖别人正在改的文件；未经要求不 commit。`pnpm dev` 这类长期运行的命令只在任务需要时起，验证用 `pnpm check` 和 `pnpm smoke`。
8. **简单优先** —— 不为未出现的需求新增抽象、配置、兜底、兼容层或扩展点；能用现有直接路径解决时，不引入更复杂的结构。
