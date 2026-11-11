# AGENTS.md

架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)，插件系统的设计见 [agent-extension.md](agent-extension.md)，已有的产品功能按模块记在 [docs/features](docs/features/README.md)（改了功能同步更新对应那份）。

市场插件不在这个仓库，在插件仓库 plume-plugins 里。两个仓库互不引用（`.dependency-cruiser.cjs` 的 `no-plugin-repo` 拦着）：插件仓库经 npm 上的 `@plumeai/plugin-sdk` 写插件（这里的 `packages/sdk/plugin-sdk`，推 `v*` tag 时由 `.github/workflows/package.yml` 发版），这里的构建、检查、测试不碰插件仓库。应用的插件市场在网上（插件仓库发到 GitHub Pages，`apps/desktop/src/main/market-remote.ts`）；开发和冒烟也从它装市场插件（要联网）。要试插件仓库里还没发布的改动，在插件仓库 `pnpm market` 起本机市场，这边设它打印的 `PLUME_MARKET_URL` 再 `pnpm dev` / `pnpm smoke`，和装线上的走同一条路。安装包不带市场插件。工具评测和 `pnpm audit:interface` 要用插件仓库里的源码，设 `PLUME_PLUGINS_DIR=<插件仓库>/plugins` 才能跑，`pnpm check` 不碰它们。

## 规范

动手前先读 [spec/safety.md](spec/safety.md)（任何任务都生效的红线：密钥、本体与插件、依赖方向、公共接口、样式……），再按 [spec/index.md](spec/index.md) 选读命中的 rule；计划、实现、交付的流程见 [spec/loop.md](spec/loop.md)。spec 的结构和维护方式见 [spec/README.md](spec/README.md)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | 类型检查 + lint + 格式 + 测试（各包的，加上 `pnpm test:root`：`scripts/test/` 和工具评测的单测） + 样式、文案、插件、链接检查 + 依赖方向（提交前必须通过；pre-push 钩子会跑） |
| `pnpm check:styles` | 只跑样式检查（`scripts/check-styles.mjs`），九条规则见 [spec/tech/styling.md](spec/tech/styling.md) |
| `pnpm check:plugins` | 只跑插件检查（`scripts/check-plugins.mjs`）：插件只引用公开接口；skill 跟得上插件接口 |
| `pnpm check:links` | 只查 Markdown 里的相对链接都指向存在的文件（`scripts/check-links.mjs`） |
| `pnpm arch` | 只查依赖方向（dependency-cruiser，规则在 `.dependency-cruiser.cjs`）；已有的循环登记在 `.dependency-cruiser-known-violations.json`，清掉一处后 `pnpm arch:baseline` 重新生成 |
| `pnpm lint` / `pnpm lint:fix` | oxlint（`.oxlintrc.json`），警告也算失败 / 能自动修的修掉 |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt（`.oxfmtrc.json`：tab 缩进、行宽 160，JSON 两个空格，不排 Markdown 和 `packages/core/llm`）全仓排版 / 只查不改 |
| `pnpm knip` | 没人用的导出、依赖和文件（`knip.jsonc`；pre-push 钩子会跑） |
| `pnpm smoke` | 构建一次，把冒烟分成二十来段、每段起一个真实 Electron 并行跑（同时 4 段，`PLUME_SMOKE_JOBS` 可改；两段环境卡片大半在等定时器，不占名额；每段一份自己的数据目录，互不影响；读写系统剪贴板的几段错开），最后列出每段过没过，没过的给出只重跑它们的命令；`PLUME_SMOKE_ONLY=a,b` 只跑这几段，段名就是 `smoke.ts` 里 `PLUME_SMOKE_ONLY === "…"` 的那些分支（写错了会列出能跑的）；`PLUME_SMOKE_ONLY=changed` 按改动挑段（相对 `PLUME_SMOKE_BASE`，缺省 HEAD，即还没提交的改动；挑法见 `scripts/smoke-changed.mjs`），先列出挑了哪几段、为什么。主流程（段名 `main`）用真实 Electron 经界面跑一轮 agent（模型换成本地假服务），在设置 › 常规里关掉智能标题总结，装上终端、定时任务两个插件（市场界面的安装、详情、筛选、停用启用、创建插件是单独的 `market` 段），覆盖输入框上方的审批卡（正文是 edit 的 diff）和面板，装浏览器插件在地址栏打开本机的一页、让假模型经 `browser_act` 读页面、点会弹 confirm 的按钮、点链接换页、经 `browser_screenshot` 截图，地址栏打开磁盘上的 `.html`，标签弹到独立窗口再收回，右键回复里的网址开进内置浏览器，再看内置 Git 插件的分支签和 Git 面板、用 `plume-plugin` 装上子 Agent 和侧边聊天插件（不重启当场加载）看子 Agent 的审批卡、子 Agent 面板、`/btw` 和排队消息经「更多」拿到侧边聊天，侧边聊天里编辑重问最后一句、把一件事交给忙着的主会话看回执条（排着时撤回回到输入框、停下后「立即执行」、随主会话停下、移除；`PLUME_SMOKE_ONLY=queue` 只跑这一段）、装下一步建议插件看输入框灰字，看模型左边内置的上下文用量（`PLUME_SMOKE_ONLY=memory-files` 只跑点「记忆文件」在文件面板里打开会话目录外的指令文件），在回复里点开文件：带行号的文件签停在那一行、悬停出口条、右键菜单、同名的几份让人挑、文件面板里 ⌘F 的查找框，图片、PDF、音视频在文件面板里显示（`PLUME_SMOKE_ONLY=open-file` 只跑这一段），`PLUME_SMOKE_ONLY=input-menu` 只跑输入框的右键菜单（剪切、复制、粘贴、全选），`PLUME_SMOKE_ONLY=update` 只跑应用更新的界面（「检查更新…」到关于页、自动检查间隔、侧栏的更新圆点、更新对话框的进度、失败和下好后的按钮，不联网），`PLUME_SMOKE_ONLY=peers` 只跑会话互发消息（装上 plume.sessions，一个对话 `ask_session` 问另一个，对方为它开一轮、`reply_session` 回，两边各有一行「来自 …」「… 的答复」，箭头跳到对方），`PLUME_SMOKE_ONLY=spawn-session` 只跑建议新会话（工作区先做成自己的仓库，假模型调 `spawn_session` 要求交回，对话里画出建议卡片、收着的环境开关挂圆点，打开卡片上的工作树开关、把卡片上的思考档位改成「高」再点「开始」，开出记着来处、用这一档的新会话、第一轮换进自己的工作树，它跑完第一轮后原对话多一行「来自新会话」并被叫起，卡片缩成一行、点了过去）、装使用统计插件看设置 › 数据里的使用统计（`PLUME_SMOKE_ONLY=usage` 只跑一轮带工具调用的对话和使用统计的 Token 构成、耗时构成、缓存未命中），装 IM 机器人看它的设置画在插件详情里、从使用统计的详情跳到它的设置页；市场筛选「已安装」只列装上的插件，切到「技能」「连接器」两类看技能插件（带项目选择）和 MCP 插件画的那一节，在详情页停用再启用；点「创建插件」：从本地上传选的不是插件时有提示，「新建插件」开的新对话的输入框里是 `/plume-plugin`；让假模型起一条后台命令，看它结束后对话里的「后台命令完成」那一行和被叫醒的那一轮（`PLUME_SMOKE_ONLY=background-job` 只跑这一段）；进设置 › 智能体看子智能体名单、编辑器和选脸弹层；从最后那条回复分叉、在分叉里编辑重发再撤回，写到一半按停后经「重试」原样重问，请求被放弃时不出现「重试」，让假模型新建一个文件后撤回那一问、连文件一起退回，文件之后被人改过时只能撤回对话、文件原样留着（`PLUME_SMOKE_ONLY=session-menu` 只跑会话菜单和这一段）；会话菜单「新窗口」开出独立窗口，看贴顶的标题栏、置顶、文件交给主窗口、回到主窗口和归档后窗口关掉（`PLUME_SMOKE_ONLY=session-window` 只跑这一段，完整流程里改用终端面板验证交接）；最后验证本体会话列表的项目折叠、置顶和会话窗的项目草稿、消息排队与发送（一轮收尾时自动发出的那句出现前，上一条回复已整段画出），再验证多源文件夹、主文件夹切换、悬停卡、后续会话嵌套、拖动排序持久化和项目名吸顶（`PLUME_SMOKE_ONLY=conversations` 只跑这一段）；`PLUME_SMOKE_ONLY=environment` 单独跑环境卡片（一分多钟）：假模型起一条后台本地服务、一个监视和两次定时唤醒，看收着的开关上的圆点和计数、卡片里的端口签和唤醒、取消一项、任务面板里的服务地址，等一项到点看对话里「定时唤醒」那一行，会话摘要是单独的 `environment-summary` 段（装上市场插件 plume.summary，说三句话后静下来一分钟，卡片里出现摘要，设置 › 智能体里有它选模型的那一行），两段并行，各一分多钟；`PLUME_SMOKE_ONLY=desktop-compat` 单独跑桌面兼容（约一分钟）：四种缩放比（经 DevTools 模拟）× 窗口大小 × 明暗主题下顶行各控件、红绿灯、带子都对在行的中线上，面板开关、标签和「添加面板」点得到；窗口变窄时面板区改成上下排，不丢面板、不重建面板内容、不改写存下的宽度和标签，拉宽回来原样；125% 下侧栏边缘落在小数像素上时标题栏和面板区的图标还在同一列设备像素上；设置页章节列表滑动时设置列一次到最终宽度、只平移；`PLUME_SMOKE_ONLY=hooks` 单独跑钩子插件：工作区里放一条没信任的项目钩子，看输入框上方的待审核提示、「去审核」到设置页信任它，设置 › 命令列出内置命令、同样切到这个项目、列出项目里的命令，再让它拦下一次 bash，看回复底下的「钩子」按钮和运行记录；截图和数据放在 `.smoke/<时间戳>/<段名>/`（只跑一段时直接放在 `.smoke/<时间戳>/`），每段的日志是其中的 `smoke.log`；过了的段删掉装进去的插件和数据目录，`.smoke/` 下只留最近 10 次运行；多个会话可以同时跑，不用等别人跑完：构建排队、一次一个（几秒，锁是 `.smoke/.build.lock`，持有的进程没了自动失效），构建完把产物快照到这次运行的 `app/` 下、从快照启动，别的会话再构建也动不到它，跑完删掉快照；各段要用的市场插件从线上市场装（要联网），设了 `PLUME_MARKET_URL` 就从它装（比如插件仓库 `pnpm market` 起的本机市场）；只跑一段时可设 `PLUME_SMOKE_OUT=<截图路径>` 自己指定；Windows 上也能跑：`plume-plugin` 经 `cmd.exe` 起，终端和钩子那几步用 PowerShell 的写法，超时时连进程树一起结束（`apps/desktop/scripts/stop-process.mjs`）；输出 `PLUME_SMOKE {...}` |
| `pnpm dev` | 构建内置插件，再启动开发模式；市场插件从线上市场装，设了 `PLUME_MARKET_URL` 就从它装 |
| `pnpm build:plugins` | 构建 `packages/builtin/` 下的内置插件（用插件 SDK 的构建） |
| `pnpm plugin init <目录>` | 从插件 SDK 的模板新建一个插件（`packages/sdk/plugin-sdk`）；新的市场插件在插件仓库里用它的 `pnpm plugin init plugins/<目录名>` |
| `pnpm package` | 打安装包到 `apps/desktop/release/`：macOS 上打 dmg 和给自动更新用的 zip（arm64 + x64；钥匙串里有 `apps/desktop/scripts/make-signing-cert.sh` 生成的 `Plume Code Signing` 证书就用它签，没有就 ad-hoc），Windows 上打 nsis 安装程序（x64 + arm64），一次打两个架构，打完由 `apps/desktop/scripts/check-native-arch.mjs` 核对内置插件、插件 SDK 里原生模块和 ripgrep 的架构，对不上就失败；`pnpm install` 会多装 darwin、win32 的 x64、arm64 原生包，插件构建时都带上、打包时按目标裁掉别的；electron-builder，Electron 按目标下载；只构建内置插件，内置插件和插件 SDK 放进资源目录，市场插件不随应用发，打包前按架构下载 ripgrep 一起放进去，要能连 GitHub；开发时 `node apps/desktop/scripts/fetch-ripgrep.mjs` 下一份本机的，grep 工具也用上它；CI 见 `.github/workflows/package.yml`（手动触发或推 `v*` tag，macOS 用 secrets 里的证书签名，最后算出 `SHA256SUMS`；推 tag 时连同安装包发成这个仓库的 GitHub Release，正文取 `CHANGELOG.md` 里这一版那一节） |
| `pnpm dump:session [<id 或前缀>]` | 只读打开会话库（`PLUME_HOME`，缺省 `~/.plume`），不带参数列出所有会话，带了就把那条会话的记录一行一条 JSON 倒出来 |
| `pnpm audit:sessions [--json]` / `pnpm audit:prune` / `pnpm audit:interface` | 量本机真实会话：花销、重复调用检测、回合怎么结束、缓存未命中、压缩的耗时和丢失、会话互发消息（`scripts/session-audit.ts`）；裁剪工具结果能省多少；界面块和 `preview` 怎么被用、错在哪。改循环、截断、停止条件、压缩前后各跑一次 `--json` 对照（同一台机器、同一批会话） |
| `pnpm probe:prune <模型 id>` | 真实模型上查 grep 截断后 agent 还能不能把事做完，模型和 key 从环境变量给（见文件头），在临时数据目录里跑、不碰 `~/.plume`；花钱 |
| `pnpm tool-eval` | 编辑格式评测（`test/tool-eval/run.ts`），同目录的 `*-eval.ts` 是各项工具能力的评测，用法在各自文件头；模型和 key 取 `PLUME_HOME` 的设置，调真实模型、花钱，结果写到 `test/tool-eval/results/`（不进仓库） |
| `pnpm release <patch\|minor\|major\|x.y.z> [--no-push]` | 发版：把 `apps/desktop/package.json` 和其余非插件包的版本号改齐（`scripts/versions.mjs` 按目录算；插件的版本归插件自己），用 git-cliff（`cliff.toml`）在 `CHANGELOG.md` 里生成这一版的提交列表，提交 `chore(release): vX`，打 tag（说明是 `scripts/changelog-section.mjs` 读出的那一节），推送；要在远端的默认分支上、工作区干净、和远端一致。生成的列表是原料：发出去的文案手写成 `<!-- plume:notes en -->`、`<!-- plume:notes zh-CN -->` 两段，英文在前，两种语言各写一遍、不直译，写给用的人（先说他遇到的现象，再说现在怎样），关于页和更新对话框按界面语言只显示其中一段 |

Git 钩子由 lefthook 管（`lefthook.yml`，`pnpm install` 时装上）：pre-commit 对暂存的文件先排版再跑 lint（改过的自动重新暂存；用 `git commit -- <路径>` 提交时改过就拦下，原样再提交一次），并跑样式、文案、插件、链接检查，commit-msg 查提交信息（见 [spec/tech/commits.md](spec/tech/commits.md)），pre-push 跑 `pnpm check` 和 `pnpm knip`。

改动插件宿主或循环时，在 `packages/core/agent/test/` 里补测试（`src/testing.ts` 有假模型服务）；改动进程、协议、界面或插件时跑 `pnpm smoke`。`packages/core/llm` 的类型声明在类型检查时生成到 `dist/`。

## 约定

- 项目尚未上线，不需要兼容旧数据：改动数据格式、存储结构或配置时直接改，不写迁移、兼容读取或回退逻辑。
- 文档、注释用中文；代码标识符用英文。
- 不确定的、待做的、要讨论的写进本地的 `notes/`（不进仓库），不写进代码注释和仓库里的文档。
- 写插件用 skill [skills/plume-plugin](skills/plume-plugin/SKILL.md)，只靠它和公开接口（`@plume/contract` 的类型、`@plume/ui`、`@plume/styles`），不读宿主的实现；skill 不够用就补 skill，插件要的能力宿主没有就按 spec 改宿主，不在插件里绕过。改了插件接口（`PluginContext`、`UiContext`、钩子）同步 skill。
- 插件名用小写加点分段，Plume 自己提供的插件（内置的和市场里的）都以 `plume.` 开头；内置插件放在 `packages/builtin/`，随应用发；其余插件都放在插件仓库的 `plugins/`，经插件市场安装；插件目录名只用小写字母、数字和连字符（它也是 `plume-plugin://` 的主机名）。
- 经 `@plume/rpc` 暴露、需要响应取消的方法，参数个数写死，最后一个参数接 `CallContext`（运行时追加）。
- 界面样式只用 token（`packages/client/styles/src/theme.css`），能用 `@plume/ui` 组件的不自己拼类名；规则见 [spec/tech/styling.md](spec/tech/styling.md)、[spec/tech/tokens.md](spec/tech/tokens.md)、[spec/tech/components.md](spec/tech/components.md)，由 `pnpm check:styles` 检查。
- 术语固定：钩子、层（洋葱的一层）、逻辑入口、界面入口、工具卡片、审批卡。
- Node ≥ 24，pnpm workspace。
