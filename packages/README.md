# 包

`apps/` 放产品（现在只有桌面版 `apps/desktop`），`packages/` 放共享类型、产品用到的库和随应用发的内置插件，经插件市场安装的插件在旁边的插件仓库 plume-plugins 的 `plugins/` 下。

`packages/contract`（`@plume/contract`）单独一层：所有共享类型都放在这里，各组都依赖它。其余包分两层：`packages/<组>/<包>`。每个包只属于一个组；包名是 `@plume/<包目录名>`，不带组名，挪组不影响 import。

## contract

跨包、跨进程的约定都写成类型放进 `contract`，只有类型，没有运行时代码：

- `src/plugin.ts`：插件逻辑入口的 API；`src/ui.ts`：界面入口的 API（`@plume/contract/ui`）；
- `src/service.ts`：AgentService、它推送的事件和视图、插件状态；
- `src/app.ts`：agent 和装配它的应用之间的约定：待加载的插件、日志。
- `src/changes.ts`：文件变更快照的汇总与撤销服务，逻辑入口和界面入口共用的 diff 形状。

`src/index.ts` 只做统一导出，使用方从 `@plume/contract` 引用，不直接引用某个文件。新类型按用途放进对应文件，放不进去的再加文件。

实现包只导出函数和类，签名里用到的共享类型从 `contract` 来。留在实现包里的只有它自己的东西：函数自身的参数和返回类型（如 `AgentOptions`）、组件 props、测试辅助类型、包内部类型。应用内部进程之间的约定（如 `apps/desktop/src/shared/protocol.ts`）只在一个应用里用，留在应用里。

## 分组

| 组 | 放什么 | 包 |
| --- | --- | --- |
| `core/` | 产品本体中跑在 agent 进程的部分：会话、循环、插件宿主、模型调用 | `agent`（`@plume/agent`）、`llm`（`@plume/llm`） |
| `infra/` | 和产品无关的通用基础设施：换个产品也能用，不认识 agent、会话、插件 | `rpc`（`@plume/rpc`）、`platform`（`@plume/platform`，本机的 shell）、`document-text`（`@plume/document-text`，从 PDF、Office 文档里抽字） |
| `builtin/` | 内置插件：随应用发、不能停用，写法和市场插件一样，只用公开接口 | `tools`（`@plume/tools`，插件名 plume.tools）、`sandbox`（`@plume/sandbox`，plume.sandbox，提供服务 `sandbox`）、`approval`（`@plume/approval`，plume.approval，钩子 `tool.approve` 上的帮我批准的风险规则）、`ask-user`（`@plume/ask-user`，plume.ask-user，`ask_user` 工具和提问卡）、`prompt`（`@plume/prompt`，plume.prompt）、`compaction`（`@plume/compaction`，plume.compaction）、`delivery`（`@plume/delivery`，plume.delivery，文件交付卡、报告、审核）、`documents`（`@plume/documents`，plume.documents，文件面板和插件共用的只读文档预览） |
| `client/` | 渲染进程共享的库：产品界面和插件界面入口都会用到 | `styles`（`@plume/styles`，设计 token `theme.css` 和共用的类名组合）、`ui`（`@plume/ui`，基础组件，类名来自 `styles`） |
| `sdk/` | 给插件作者的开发工具：随应用发到资源目录，不跑在 Plume 的进程里 | `plugin-sdk`（`@plumeai/plugin-sdk`，类型声明、`plume-plugin` 命令、插件模板） |

## 新包放哪

- 不懂 agent 业务的通用库（进程通信、原子写文件、路径工具之类）放 `infra/`。其余按「Plume：将来要做的」里的归属来分：归属「产品本体」的放 `core/`（agent 进程侧）或 `client/`（渲染进程侧）；归属插件的放插件仓库的 `plugins/`，一个插件一个目录；其中随应用发、不能停用的内置插件放 `builtin/`。
- 一组里的包多到需要再细分时，按能力系列拆出新组（比如 `mcp/`、`shell/`），并更新本表。

## 依赖方向

- `apps/` 可以依赖 `packages/`；`packages/` 不能依赖 `apps/`。
- `infra/` 不依赖其他组和 `contract`。
- `core/` 不依赖 `client/` 和任何插件：循环不认识任何具体插件，插件由应用传给 `createAgent`。
- `contract` 只 `import type`：消息类型来自 `core/llm`（定义留在那里，由 `contract` 转出），`CallContext` 来自 `infra/rpc`。使用方一律从 `contract` 引用。
- 插件只 `import type` `@plume/contract`；界面入口可以用 `react`、`@plume/ui` 和 `@plume/styles`。市场插件和 `builtin/*` 经 `sdk/plugin-sdk` 拿这些类型，不直接依赖它们；`infra/` 的库可以声明在 `devDependencies` 里打包进去。
- `core/` 不依赖 `builtin/`：内置插件由应用当插件传给 agent（`core/agent` 的端到端测试带上它们的源码，只在测试里）。
- `sdk/plugin-sdk` 只在开发时依赖 `contract`、`client/*`、`infra/rpc`、`core/llm`（从它们生成类型声明），发出去的包里没有这些包的运行时代码。
- `infra/rpc` 跑在三个进程里，不引用 Node、Electron 的模块和第三方依赖。
- `core/llm` 自成一体，保持它自己的写法，不受仓库的 lint、格式和 knip 检查，见它的 README。
