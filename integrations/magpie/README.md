# Plume 的 Magpie Agent 插件

把 Plume 放进 [Magpie](https://usemagpie.ai) 的 Agent 页：在 Plume 那一行选一个 Magpie 的模型，
Plume 的新一轮就走 Magpie 的网关，用量记在 Plume 名下。

```sh
magpie plugin add ./integrations/magpie
```

也可以在 Magpie 应用的「设置 → 插件」里添加这个文件夹。Magpie 用 `~/.plume` 目录判断 Plume 装没装，开过一次 Plume 就有。

## Magpie 写了什么

选中模型后，Magpie 原地改 `~/.plume/settings.json` 里的这几个键，其他设置不动：

```json
{
  "defaultModel": "magpie/cliproxyapi/gpt-6-luna",
  "magpie": {
    "baseUrl": "http://127.0.0.1:3425",
    "apiKey": "magpie-plume",
    "models": [{ "id": "cliproxyapi/gpt-6-luna", "name": "GPT-6 Luna", "context": 1000000, "output": 128000, "images": true, "efforts": ["low", "medium", "high"] }]
  }
}
```

Plume 读设置时把 `magpie` 块合成一个名为「Magpie」的供应商，排在你自己的供应商后面
（`packages/core/agent/src/magpie.ts`）。它不写进 `providers`，开关全由 Magpie 管：

- 在 Magpie 里选回 Plume 原来的模型，或关掉开关，这几个键恢复原值，原本没有的删掉
  （删空的 `magpie` 会留成 `{}`，Plume 当它不存在）。
- 在 Plume 的模型设置里改或删这个供应商会被拒绝，提示去 Magpie 里操作。
- 档位：Magpie 的 `none` 对应 Plume 的「关闭」，其余同名；Magpie 不知道档位时用默认几档。
  不知道上下文和输出上限时，按新建模型的默认值（200000、32000）。

## 什么时候生效

Plume 每次用到模型设置都重新读这个文件，所以 Magpie 改完，下一轮就用新模型；在 Plume 里改别的设置，
也不会把 Magpie 写的键冲掉。界面上的模型列表是启动时取的，要在列表里看到 Magpie 的模型，重启 Plume。

## 资源库：技能、全局指令和 MCP

插件声明了三种资源的接收位置，模型是否走 Magpie 不影响资源库：

| 资源 | Magpie 写到哪里 | Plume 何时读取 |
| --- | --- | --- |
| 技能 | `~/.plume/skills/` | 和自己放在那里的技能一样，由内置的技能插件发现 |
| 全局指令 | `~/.plume/magpie/AGENTS.md` | 每轮读取，和设置 › 个性化里的全局指令一起生效 |
| MCP | `~/.plume/magpie/mcp.json` | MCP 插件启动时读取，修改后重启 Plume |

在 Magpie 资源库中选择 Plume，即可分发这些资源。需要支持 `agent.library` 的 Magpie 版本；旧版本请先更新。

MCP 文件使用 Claude 格式的 `mcpServers` 对象，支持 stdio、HTTP 和 SSE，以及命令、参数、环境变量、地址和请求头里的 `${NAME}` 空位（从登录 shell 的环境变量里取）。Plume 给这些服务的 id 加 `magpie__` 前缀，「插件市场 › 连接器」里标明「由 Magpie 管理」：名称、开关、启动方式、变量和删除都锁住，在 Magpie 中修改，缺少的密钥也在 Magpie 中填写；连接状态、工具列表、重连和 OAuth 登录仍可在 Plume 中查看或操作。

Plume 不把分发的指令和 MCP 配置另存进自己的设置，所以在 Magpie 中撤回后不会留下副本。已有手动配置保留；名称和已有服务重名（不分大小写）时保留自己的服务并记录警告，因为名称就是工具名里的那一段。格式损坏或无效的 MCP 条目会记录警告并跳过，原文件不被改写。

这些位置基于默认的 `~/.plume`。使用自定义 `PLUME_HOME` 时，需把插件的 `dir`、`config` 和 `library` 路径一起改为对应的绝对路径。
