# AGENTS.md

架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)，插件系统的设计见 [agent-extension.md](agent-extension.md)，已有的产品功能按模块记在 [docs/features](docs/features/README.md)（改了功能同步更新对应那份）。

市场插件不在这个仓库，在插件仓库 plume-plugins 里。两个仓库互不引用（`.dependency-cruiser.cjs` 的 `no-plugin-repo` 拦着）：插件仓库经 npm 上的 `@plumeai/plugin-sdk` 写插件（这里的 `packages/sdk/plugin-sdk`，推 `sdk-v*` tag 时由 `.github/workflows/package.yml` 发版，不随推 `v*` tag 自动发），这里的构建、检查、测试不碰插件仓库。应用的插件市场在网上（插件仓库发到 GitHub Pages，`apps/desktop/src/main/market-remote.ts`），开发版和装好的应用只用这一个（要联网），共用 `~/.plume` 里装好的插件；冒烟缺省也用它，改了插件接口、线上那批插件跟不上时，用 `pnpm market:local` 拿这里的 SDK 构建插件仓库、打出本地市场给冒烟用（见下面的命令表）。插件还没发布的改动，和任何插件作者一样用 `plume-plugin dev` / `install` 或插件市场的「从本地上传」装进本机（`~/.plume/local-plugins/`），见 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)。安装包不带市场插件。`pnpm market:local` 要用插件仓库，设 `PLUME_PLUGINS_DIR=<插件仓库>/plugins` 或直接给插件仓库的路径，`pnpm check` 不碰它。

## 规范

动手前先读 [spec/safety.md](spec/safety.md)（任何任务都生效的红线：密钥、本体与插件、依赖方向、公共接口、样式……），再按 [spec/index.md](spec/index.md) 选读命中的 rule；计划、实现、交付的流程见 [spec/loop.md](spec/loop.md)。spec 的结构和维护方式见 [spec/README.md](spec/README.md)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | 类型检查 + lint + 格式 + 测试（各包的，加上 `pnpm test:root`：`scripts/test/` 和工具评测的单测） + 样式、文案、插件、链接、约定检查 + 依赖方向（提交前必须通过；pre-push 钩子会跑） |
| `pnpm --filter <包名> test` | 只跑一个包的测试，开发中途用，交付前仍跑 `pnpm check`。各包都用 vitest，只跑一个文件时在后面加文件名（`pnpm --filter <包名> test <文件名>`） |
| `pnpm check:styles` | 只跑样式检查（`scripts/check-styles.mjs`），九条规则见 [spec/tech/styling.md](spec/tech/styling.md) |
| `pnpm check:plugins` | 只跑插件检查（`scripts/check-plugins.mjs`）：插件只引用公开接口；skill 跟得上插件接口；本体不按名字认插件、插件的工具和段，内置插件之间也不按名字互相认（名单在 `scripts/check-core-names.mjs`，规则见 [spec/domain/plugin-primitives.md](spec/domain/plugin-primitives.md)） |
| `pnpm check:links` | 只查 Markdown 里的相对链接都指向存在的文件（`scripts/check-links.mjs`） |
| `pnpm check:conventions` | 只查几条能机械判断的约定（`scripts/check-conventions.mjs`）：包放在 `packages/<组>/<包>`（contract 除外）；`@plume/contract` 转出的类型（消息类型、`CallContext`）在定义它们的包以外一律从 `@plume/contract` 引；下面「约定」里的术语不写成别名（名单在脚本里）；`packages/core/{agent,loop,sandbox,workspace}/src` 的 TypeScript 文件不超过 800 行（`packages/core/agent/src/host.ts` 例外） |
| `pnpm arch` | 只查依赖方向（dependency-cruiser，规则在 `.dependency-cruiser.cjs`）；已有的循环登记在 `.dependency-cruiser-known-violations.json`，清掉一处后 `pnpm arch:baseline` 重新生成 |
| `pnpm lint` / `pnpm lint:fix` | oxlint（`.oxlintrc.json`），警告也算失败 / 能自动修的修掉 |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt（`.oxfmtrc.json`：tab 缩进、行宽 160，JSON 两个空格，不排 Markdown 和 `packages/core/llm`）全仓排版 / 只查不改 |
| `pnpm knip` | 没人用的导出、依赖和文件（`knip.jsonc`；pre-push 钩子会跑） |
| `pnpm smoke` | 构建一次，把冒烟分成二十来段、每段起一个真实 Electron 并行跑（同时 4 段，`PLUME_SMOKE_JOBS` 可改；两段环境卡片大半在等定时器，不占名额；每段一份自己的数据目录，互不影响；读写系统剪贴板的几段错开），最后列出每段过没过，没过的给出只重跑它们的命令；`PLUME_SMOKE_ONLY=a,b` 只跑这几段，段名就是 `smoke.ts` 里 `PLUME_SMOKE_ONLY === "…"` 的那些分支（写错了会列出能跑的）；`PLUME_SMOKE_ONLY=changed` 按改动挑段（相对 `PLUME_SMOKE_BASE`，缺省 HEAD，即还没提交的改动；挑法见 `scripts/smoke-changed.mjs`），先列出挑了哪几段、为什么。各段验什么见 [docs/smoke.md](docs/smoke.md)（加段、改了一段的覆盖面时同步那份）；截图和数据放在 `.smoke/<时间戳>/<段名>/`（只跑一段时直接放在 `.smoke/<时间戳>/`），每段的日志是其中的 `smoke.log`；过了的段删掉装进去的插件和数据目录，`.smoke/` 下只留最近 10 次运行；多个会话可以同时跑，不用等别人跑完：构建排队、一次一个（几秒，锁是 `.smoke/.build.lock`，持有的进程没了自动失效），构建完把产物快照到这次运行的 `app/` 下、从快照启动，别的会话再构建也动不到它，跑完删掉快照；各段要用的市场插件缺省从线上市场装（要联网），设 `PLUME_SMOKE_MARKET=<市场目录>`（`pnpm market:local` 打出来的）时改从冒烟在 127.0.0.1 上起的静态服务装、跑完关掉（经 `PLUME_SMOKE_MARKET_URL` 告诉应用，只在冒烟时认，`pnpm dev` 和装好的应用不认）；只跑一段时可设 `PLUME_SMOKE_OUT=<截图路径>` 自己指定；Windows 上也能跑：`plume-plugin` 经 `cmd.exe` 起，终端和钩子那几步用 PowerShell 的写法，超时时连进程树一起结束（`apps/desktop/scripts/stop-process.mjs`）；输出 `PLUME_SMOKE {...}` |
| `pnpm market:local [<插件仓库>] [--out <目录>] [-- <命令>...]` | 拿这个工作树的插件 SDK 构建插件仓库（缺省取 `PLUME_PLUGINS_DIR` 的上一级），打出只含本机平台的市场目录（缺省 `.smoke/market`），再 `PLUME_SMOKE_MARKET=<目录> pnpm smoke` 让冒烟装这一份；带 `-- <命令>` 时不打市场，换上本地 SDK 在插件仓库里跑这条命令（如 `-- pnpm check`）。做法是在插件仓库的 `pnpm-workspace.yaml` 临时加 `overrides` 指向 `npm pack` 出来的 SDK、重装依赖，不管成没成最后都还原 `pnpm-workspace.yaml`、`pnpm-lock.yaml` 并按原锁文件重装（这两个文件动手前得是干净的）；只按路径调插件仓库的命令，不引用它的文件（`scripts/local-market.mjs`） |
| `pnpm dev` | 构建内置插件，再启动开发模式；市场插件从线上市场装，装好的插件和装好的应用共用 |
| `pnpm build:plugins` | 构建 `packages/builtin/` 下的内置插件（用插件 SDK 的构建） |
| `pnpm plugin init <目录>` | 从插件 SDK 的模板新建一个插件（`packages/sdk/plugin-sdk`）；新的市场插件在插件仓库里用它的 `pnpm plugin init plugins/<目录名>` |
| `pnpm package` | 打安装包到 `apps/desktop/release/`：macOS 上打 dmg 和给自动更新用的 zip（arm64 + x64；钥匙串里有 `apps/desktop/scripts/make-signing-cert.sh` 生成的 `Plume Code Signing` 证书就用它签，没有就 ad-hoc），Windows 上打 nsis 安装程序（x64 + arm64），一次打两个架构，打完由 `apps/desktop/scripts/check-native-arch.mjs` 核对内置插件、插件 SDK 里原生模块和 ripgrep 的架构，对不上就失败；`pnpm install` 会多装 darwin、win32 的 x64、arm64 原生包，插件构建时都带上、打包时按目标裁掉别的；electron-builder，Electron 按目标下载；只构建内置插件，内置插件和插件 SDK 放进资源目录，市场插件不随应用发，打包前按架构下载 ripgrep 一起放进去，要能连 GitHub；开发时 `node apps/desktop/scripts/fetch-ripgrep.mjs` 下一份本机的，grep 工具也用上它；CI 见 `.github/workflows/package.yml`（手动触发或推 `v*` tag，macOS 用 secrets 里的证书签名，最后算出 `SHA256SUMS`；推 tag 时连同安装包发成这个仓库的 GitHub Release，正文取 `CHANGELOG.md` 里这一版那一节） |
| `pnpm dump:session [<id 或前缀>]` | 只读打开会话库（`PLUME_HOME`，缺省 `~/.plume`），不带参数列出所有会话，带了就把那条会话的记录一行一条 JSON 倒出来 |
| `pnpm audit:sessions [--json]` / `pnpm audit:prune` | 量本机真实会话：花销、重复调用检测、回合怎么结束、缓存未命中、压缩的耗时和丢失、会话互发消息（`scripts/session-audit.ts`）；裁剪工具结果能省多少。改循环、截断、停止条件、压缩前后各跑一次 `--json` 对照（同一台机器、同一批会话） |
| `pnpm probe:prune <模型 id>` | 真实模型上查 grep 截断后 agent 还能不能把事做完，模型和 key 从环境变量给（见文件头），在临时数据目录里跑、不碰 `~/.plume`；花钱 |
| `pnpm tool-eval` | 编辑格式评测（`test/tool-eval/run.ts`），同目录的 `*-eval.ts` 是各项工具能力的评测，用法在各自文件头；模型和 key 取 `PLUME_HOME` 的设置，调真实模型、花钱，结果写到 `test/tool-eval/results/`（不进仓库） |
| `pnpm catalog:update` | 从 pi.dev 拉模型目录，重写随应用发的快照 `packages/core/llm/src/catalog/model-catalog.json`（`scripts/update-model-catalog.ts`）；应用运行时自己拉最新的，快照只在首次启动和离线时用，发版前刷一次；要联网 |
| `pnpm release <patch\|minor\|major\|x.y.z> [--no-push]` | 发版：把 `apps/desktop/package.json` 和其余非插件包的版本号改齐（`scripts/versions.mjs` 按目录算；插件的版本归插件自己），用 git-cliff（`cliff.toml`）在 `CHANGELOG.md` 里生成这一版的提交列表，提交 `chore(release): vX`，打 tag（说明是 `scripts/changelog-section.mjs` 读出的那一节），推送（这一节还没有手写的中英两段文案时停在推送前，同 `--no-push`；手推 `v*` tag 时 pre-push 钩子也查，`scripts/check-release-notes.mjs`）；要在远端的默认分支上、工作区干净、和远端一致。生成的列表是原料：发出去的文案手写成 `<!-- plume:notes en -->`、`<!-- plume:notes zh-CN -->` 两段，英文在前，两种语言各写一遍、不直译，写给用的人（先说他遇到的现象，再说现在怎样），关于页和更新对话框按界面语言只显示其中一段 |
| `git tag sdk-vX.Y.Z vX.Y.Z && git push origin sdk-vX.Y.Z` | 发插件 SDK 到 npm：`pnpm release` 不发 SDK，推 `v*` tag 也不发，要发时在已经发了 Release 的那一版上另推 `sdk-v*` tag，由 `.github/workflows/package.yml` 的 `sdk` 只跑这一个 job（不打包），用 npm 的 trusted publishing（登记的是 `package.yml`，所以不拆成单独的文件）。发之前核对 tag 和 `packages/sdk/plugin-sdk/package.json` 的版本号一致、应用 `vX.Y.Z` 的 Release 已经在了，不对就失败：SDK 的类型来自宿主，先于宿主发布，插件就会用上用户手里的 Plume 没有的接口。SDK 版本号随 `pnpm release` 和应用一起改，所以只能发某一版应用对应的 SDK。本机也能发：`pnpm publish:sdk [--dry-run]`（同一份脚本 `packages/sdk/plugin-sdk/scripts/publish.mjs`，用 `npm login` 的账号，npm 上已有这个版本就跳过） |

Git 钩子由 lefthook 管（`lefthook.yml`，`pnpm install` 时装上）：pre-commit 对暂存的文件先排版再跑 lint（改过的自动重新暂存；用 `git commit -- <路径>` 提交时改过就拦下，原样再提交一次），并跑样式、文案、插件、链接、约定检查，commit-msg 查提交信息（见 [spec/tech/commits.md](spec/tech/commits.md)），pre-push 跑 `pnpm check` 和 `pnpm knip`，推 `v*` tag 时还查发版文案。

改动插件宿主时在 `packages/core/agent/test/` 里补测试（`src/testing.ts` 有假模型服务），改动循环时在 `packages/core/loop/test/` 里补测试；改动进程、协议、界面或插件时跑 `pnpm smoke`。`packages/core/llm` 的类型声明在类型检查时生成到 `dist/`。

## 约定

- 项目尚未上线，不需要兼容旧数据：改动数据格式、存储结构或配置时直接改，不写迁移、兼容读取或回退逻辑。
- 文档、注释用中文；代码标识符用英文。
- 不确定的、待做的、要讨论的写进本地的 `notes/`（不进仓库），不写进代码注释和仓库里的文档。
- 写插件用 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)，只靠它和公开接口（`@plume/contract` 的类型、`@plume/ui`、`@plume/styles`），不读宿主的实现；skill 不够用就补 skill，插件要的能力宿主没有就按 spec 改宿主，不在插件里绕过。改了插件接口（`PluginContext`、`UiContext`、钩子）同步 skill。
- 插件名用小写加点分段，Plume 自己提供的插件（内置的和市场里的）都以 `plume.` 开头；内置插件放在 `packages/builtin/`，随应用发；其余插件都放在插件仓库的 `plugins/`，经插件市场安装；插件目录名只用小写字母、数字和连字符（它也是 `plume-plugin://` 的主机名）。
- 经 `@plume/rpc` 暴露的方法（`AgentService`、插件 `ctx.serve` 的接口）参数个数写死：不用可选参数和剩余参数，可能不传的写成 `x: T | undefined`。运行时把 `CallContext` 接在实际传来的参数后面，少传一个它就落进那个参数里；要响应取消的方法最后一个参数接它。`Remote<T>` 在类型上拦着，参数个数没写死的方法在代理上调不了。
- 界面样式只用 token（`packages/client/styles/src/theme.css`），能用 `@plume/ui` 组件的不自己拼类名；规则见 [spec/tech/styling.md](spec/tech/styling.md)、[spec/tech/tokens.md](spec/tech/tokens.md)、[spec/tech/components.md](spec/tech/components.md)，由 `pnpm check:styles` 检查。
- 术语固定：钩子、层（洋葱的一层）、逻辑入口、界面入口、工具卡片、审批卡。
- Node ≥ 24，pnpm workspace。
