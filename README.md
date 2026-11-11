# Plume

Plume 是一个 coding agent 桌面应用（Electron），是 [Lyra](https://github.com/kittors/Lyra) 的插件化版本：产品本体只保留模型调用、agent 循环、会话、审批卡和界面骨架，其余能力——工具、沙箱、系统提示词、上下文压缩、Git、MCP……——都做成插件，经钩子、工具注册和界面扩展点接入。

- **内置插件**随应用发，不能停用，但可以被别的插件替换或在外层接管（`packages/builtin/`）。
- **市场插件**（终端、浏览器、子 Agent、侧边聊天、定时任务、计划模式等）在插件仓库 [plume-plugins](https://github.com/wJiaaa/plume-plugins) 里，经应用内的插件市场安装。
- 任何人都可以用插件 SDK [`@plumeai/plugin-sdk`](packages/sdk/plugin-sdk) 写自己的插件。

## 安装

从 [Releases](https://github.com/wJiaaa/plume/releases) 下载安装包：

- macOS：dmg（arm64、x64）
- Windows：nsis 安装程序（x64、arm64）

暂不提供 Linux 安装包。应用会自动检查新版本，也可以在设置 › 关于里手动检查。

## 开发

需要 Node ≥ 24 和 pnpm。

```sh
pnpm install
pnpm dev      # 构建内置插件并启动开发模式
pnpm check    # 类型检查、lint、格式、测试和各项检查，提交前必须通过
pnpm smoke    # 起真实 Electron 跑冒烟（要联网）
pnpm package  # 打安装包到 apps/desktop/release/
```

开发版和装好的应用共用 `~/.plume` 里的数据和插件，插件市场用线上的那一份。完整的命令说明和约定见 [AGENTS.md](AGENTS.md)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/desktop` | Electron 外壳、产品界面、冒烟验证 |
| `packages/contract` | 所有共享类型，包括插件 API |
| `packages/core` | agent 进程里的本体：会话、循环、插件宿主（`agent`），模型调用（`llm`） |
| `packages/infra` | 和产品无关的基础设施：跨进程 RPC、本机 shell、文档抽字 |
| `packages/client` | 设计 token（`styles`）和基础组件（`ui`），产品和插件界面共用 |
| `packages/builtin` | 内置插件 |
| `packages/sdk/plugin-sdk` | 插件 SDK 和 `plume-plugin` 命令 |
| `integrations/magpie` | 给 Magpie 用的 Agent 插件 |

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：进程、目录、agent 的一轮怎么跑、插件怎么加载
- [agent-extension.md](agent-extension.md)：插件系统的设计
- [docs/features](docs/features/README.md)：已有的产品功能，按模块记
- [skills/plume-plugin](skills/plume-plugin/SKILL.md)：写插件的指南
- [spec](spec/README.md)：开发规范
- [CHANGELOG.md](CHANGELOG.md)：更新日志
