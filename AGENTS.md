# AGENTS.md

架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)，插件系统的设计见 [agent-extension.md](agent-extension.md)，已有的产品功能按模块记在 [docs/features](docs/features/README.md)（改了功能同步更新对应那份）。

## 动手前

1. 读 [spec/safety.md](spec/safety.md)：任何任务都生效的红线（密钥、本体与插件、依赖方向、公共接口、样式……）。
2. 按 [spec/index.md](spec/index.md) 选读命中的 rule，没命中的不读。
3. 计划、实现、交付按 [spec/loop.md](spec/loop.md)。spec 的结构和维护方式见 [spec/README.md](spec/README.md)。

## 两个仓库

- 市场插件不在这个仓库，在插件仓库 plume-plugins 里。两个仓库互不引用（`.dependency-cruiser.cjs` 的 `no-plugin-repo` 拦着），这里的构建、检查、测试不碰插件仓库。
- 插件仓库经 npm 上的 `@plumeai/plugin-sdk` 写插件，即这里的 `packages/sdk/plugin-sdk`；它不随应用的 `v*` tag 自动发，怎么发见 [docs/release.md](docs/release.md)。
- 插件市场在网上（插件仓库发到 GitHub Pages，`apps/desktop/src/main/market-remote.ts`）。开发版、装好的应用、冒烟缺省都只用这一个，要联网，共用 `~/.plume` 里装好的插件。安装包不带市场插件。
- 改了插件接口、线上那批插件跟不上时，用 `pnpm market:local` 拿这里的 SDK 构建插件仓库、打出本地市场给冒烟用，见 [docs/smoke.md](docs/smoke.md)「怎么跑」。
- 插件还没发布的改动，和任何插件作者一样用 `plume-plugin dev` / `install` 或插件市场的「从本地上传」装进本机（`~/.plume/local-plugins/`），见 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | 类型检查、lint、格式、各包测试和 `pnpm test:root`（`scripts/test/` 和工具评测的单测）、样式 / 文案 / 插件 / 链接 / 约定检查、依赖方向。提交前必须全过，pre-push 钩子会跑 |
| `pnpm --filter <包名> test [<文件名>]` | 只跑一个包（或其中一个文件）的测试，各包都用 vitest。开发中途用，交付前仍跑 `pnpm check` |
| `pnpm check:styles` | 样式检查（`scripts/check-styles.mjs`），规则见 [spec/tech/styling.md](spec/tech/styling.md) |
| `pnpm check:plugins` | 插件只引用公开接口；skill 跟得上插件接口；本体和内置插件不按名字认插件、插件的工具和段（名单在 `scripts/check-core-names.mjs`，规则见 [spec/domain/plugin-primitives.md](spec/domain/plugin-primitives.md)） |
| `pnpm check:links` | Markdown 里的相对链接都指向存在的文件 |
| `pnpm check:conventions` | 能机械判断的几条约定：包的位置、`@plume/contract` 转出的类型从 contract 引、术语不写成别名、核心源文件不超过 800 行。逐条说明和例外在 `scripts/check-conventions.mjs` 文件头 |
| `pnpm arch` | 依赖方向（dependency-cruiser，`.dependency-cruiser.cjs`）。已有的循环登记在 `.dependency-cruiser-known-violations.json`，清掉一处后 `pnpm arch:baseline` 重新生成 |
| `pnpm lint` / `pnpm lint:fix` | oxlint（`.oxlintrc.json`），警告也算失败 / 能自动修的修掉 |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt（`.oxfmtrc.json`：tab 缩进、行宽 160，JSON 两个空格，不排 Markdown 和 `packages/core/llm`）排版 / 只查不改 |
| `pnpm knip` | 没人用的导出、依赖和文件（`knip.jsonc`），pre-push 钩子会跑 |
| `pnpm smoke` | 分段起真实 Electron 并行跑冒烟。`PLUME_SMOKE_ONLY=changed` 只跑改动碰到的段，`PLUME_SMOKE_ONLY=a,b` 只跑指定段；产物在 `.smoke/<时间戳>/<段名>/`；多个会话可以同时跑。怎么跑见 [docs/smoke.md](docs/smoke.md)「怎么跑」，各段验什么见同一份（加段、改了一段的覆盖面时同步） |
| `pnpm market:local` | 用这个工作树的 SDK 构建插件仓库、打本地市场给冒烟用，见 [docs/smoke.md](docs/smoke.md)「本地市场」 |
| `pnpm dev` | 构建内置插件，再启动开发模式；市场插件从线上市场装 |
| `pnpm build:plugins` | 构建 `packages/builtin/` 下的内置插件（用插件 SDK 的构建） |
| `pnpm plugin init <目录>` | 从插件 SDK 的模板新建一个插件；新的市场插件在插件仓库里用 `pnpm plugin init plugins/<目录名>` |
| `pnpm dump:session [<id 或前缀>]` | 只读打开会话库（`PLUME_HOME`，缺省 `~/.plume`）：不带参数列出所有会话，带了就把那条会话的记录一行一条 JSON 倒出来 |
| `pnpm audit:sessions [--json]` / `pnpm audit:prune` | 量本机真实会话（`scripts/session-audit.ts`）：花销、重复调用检测、回合怎么结束、缓存未命中、压缩的耗时和丢失、会话互发消息；裁剪工具结果能省多少。改循环、截断、停止条件、压缩时，前后各跑一次 `--json` 对照（同一台机器、同一批会话） |
| `pnpm probe:prune <模型 id>` | 真实模型上查 grep 截断后 agent 还能不能把事做完。模型和 key 从环境变量给（见文件头），在临时数据目录里跑、不碰 `~/.plume`；**花钱** |
| `pnpm tool-eval` | 编辑格式评测（`test/tool-eval/run.ts`），同目录的 `*-eval.ts` 是各项工具能力的评测，用法在各自文件头。模型和 key 取 `PLUME_HOME` 的设置，结果写到 `test/tool-eval/results/`（不进仓库）；**花钱** |
| `pnpm catalog:update` | 从 pi.dev 拉模型目录，重写随应用发的快照 `packages/core/llm/src/catalog/model-catalog.json`。应用运行时自己拉最新的，快照只在首次启动和离线时用；发版前刷一次，要联网 |
| `pnpm package` | 打 macOS / Windows 安装包到 `apps/desktop/release/`，见 [docs/release.md](docs/release.md) |
| `pnpm release <patch\|minor\|major\|x.y.z> [--no-push]` | 发版：改版本号、生成 CHANGELOG、提交、打 tag、推送。推送前要手写中英两段发版文案，见 [docs/release.md](docs/release.md) |
| `git tag sdk-vX.Y.Z vX.Y.Z && git push origin sdk-vX.Y.Z` | 发插件 SDK 到 npm（`pnpm release` 不发），前提和本机发法见 [docs/release.md](docs/release.md) |

Git 钩子由 lefthook 管（`lefthook.yml`，`pnpm install` 时装上）：

- pre-commit：对暂存的文件先排版再跑 lint，改过的自动重新暂存（用 `git commit -- <路径>` 提交时改过就拦下，原样再提交一次）；再跑样式、文案、插件、链接、约定检查。
- commit-msg：查提交信息，见 [spec/tech/commits.md](spec/tech/commits.md)。
- pre-push：跑 `pnpm check` 和 `pnpm knip`；推 `v*` tag 时还查发版文案。

## 测试放哪

- 改动插件宿主或循环时补测试。只测 `@plume/loop` 自己纯函数的放 `packages/core/loop/test/`；要跑一整轮的（用 `PluginHost`、内置插件或 `src/testing.ts` 的假模型服务）放 `packages/core/agent/test/`，循环的 `loop-parity`、`repetition-parity` 都在那里。
- 改动进程、协议、界面或插件时跑 `pnpm smoke`。
- `packages/core/llm` 的类型声明在类型检查时生成到 `dist/`。

## 约定

- 项目尚未上线，不需要兼容旧数据：改动数据格式、存储结构或配置时直接改，不写迁移、兼容读取或回退逻辑。
- 文档、注释用中文；代码标识符用英文。
- 不确定的、待做的、要讨论的写进本地的 `notes/`（不进仓库），不写进代码注释和仓库里的文档。
- 写插件用 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)，只靠它和公开接口，不读宿主的实现（能引用什么见 [spec/safety.md](spec/safety.md) 第 3 条）。skill 不够用就补 skill；插件要的能力宿主没有，就按 spec 改宿主，不在插件里绕过。
- 插件名用小写加点分段，Plume 自己提供的插件（内置的和市场里的）都以 `plume.` 开头。内置插件放在 `packages/builtin/`，随应用发；其余插件都放在插件仓库的 `plugins/`，经插件市场安装。插件目录名只用小写字母、数字和连字符（它也是 `plume-plugin://` 的主机名）。
- 经 `@plume/rpc` 暴露的方法（`AgentService`、插件 `ctx.serve` 的接口）参数个数写死：不用可选参数和剩余参数，可能不传的写成 `x: T | undefined`。原因：运行时把 `CallContext` 接在实际传来的参数后面，少传一个它就落进那个参数里。要响应取消的方法，最后一个参数接它。`Remote<T>` 在类型上拦着，参数个数没写死的方法在代理上调不了。
- 术语固定：钩子、层（洋葱的一层）、逻辑入口、界面入口、工具卡片、审批卡。
- Node ≥ 24，pnpm workspace。
