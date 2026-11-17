# Plume 的 Magpie Agent 插件

把 Plume 放进 [Magpie](https://usemagpie.ai) 的 Agent 页：在 Plume 那一行选一个 Magpie 的模型，
Plume 的新一轮就走 Magpie 的网关，用量记在 Plume 名下。

先在 Plume 的插件市场装上「Magpie」插件（`plume.magpie`），再把这个文件夹加进 Magpie：

```sh
magpie plugin add ./integrations/magpie
```

也可以在 Magpie 应用的「设置 → 插件」里添加这个文件夹。Magpie 用 `~/.plume/plugin-data/plume.magpie` 目录判断 Plume 装没装：
装上 `plume.magpie` 才有这个目录，没装时 Magpie 不列出 Plume。

## Magpie 写了什么

选中模型后，Magpie 原地改 `~/.plume/plugin-data/plume.magpie/credentials.json` 里的这几个键，其他键不动：

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

文件里有网关的明文 key：`plume.magpie` 启用时先建好只给本人读写（0600）的空文件，Magpie 原地改、不改权限。
Plume 的读文件、执行命令把它当密钥文件，替模型读它前先问人。

`plume.magpie` 把 `magpie` 块变成一个名为「Magpie」的供应商，排在你自己的供应商后面；它不写进 Plume 的 `settings.json`，
不进导出的供应商文件，在 Plume 里的修改也写回 `magpie` 块：

- 在 Plume 的模型设置里可以重命名、启停、修改连接和密钥、拉取或增删改模型，也可以删除这个供应商（移除 `magpie` 块）。
  修改会保存，下一轮生效；Magpie 再次同步时会覆盖连接、密钥和模型列表。修改密钥会改变 Magpie 对接管状态的判断。
- 默认模型：Magpie 改了 `defaultModel`，`plume.magpie` 就把它设成 Plume 的默认模型，并记下原来的那个。在 Magpie 里选回原来的模型
  或关掉开关，这几个键恢复原值（原本没有的删掉，删空的 `magpie` 留成 `{}`，当它不存在）；这时 Plume 的默认模型还是 Magpie 设的那个，
  就换回原来的，人在 Plume 里另选过就不动。
- 档位：Magpie 的 `none` 对应 Plume 的「关闭」，其余同名；Magpie 不知道档位时用默认几档。
  不知道上下文和输出上限时，按新建模型的默认值（200000、32000）。
- 价格：Magpie 带的价格不是 Plume 认的形状，花销按 Plume 的模型目录里同名模型的参考价算，目录里没有的不记金额。

## 什么时候生效

`plume.magpie` 盯着这个文件，Magpie 改完，下一轮就用新模型。界面上的模型列表是打开时取的，
要在列表里看到 Magpie 新给的模型，重启 Plume。

## 资源库：技能、全局指令和 MCP

插件声明了三种资源的接收位置，模型是否走 Magpie 不影响资源库。全局指令和 MCP 由 Plume 插件市场里的「Magpie」插件（`plume.magpie`）交给 Plume，要先在 Plume 的插件市场装上它：

| 资源 | Magpie 写到哪里 | Plume 何时读取 |
| --- | --- | --- |
| 技能 | `~/.plume/skills/` | 和自己放在那里的技能一样，由内置的技能插件发现 |
| 全局指令 | `~/.plume/plugin-data/plume.magpie/AGENTS.md` | `plume.magpie` 每轮读取，作为单独一段放在项目指令前面 |
| MCP | `~/.plume/plugin-data/plume.magpie/mcp.json` | `plume.magpie` 读取后登记给内置的 MCP 插件，文件改了当场重连 |

在 Magpie 资源库中选择 Plume，即可分发这些资源。需要支持 `agent.library` 的 Magpie 版本；旧版本请先更新。

MCP 文件使用 Claude 格式的 `mcpServers` 对象，支持 stdio、HTTP 和 SSE，以及命令、参数、环境变量、地址和请求头里的 `${NAME}` 空位（从登录 shell 的环境变量里取）。「插件市场 › 连接器」里标明「由 Magpie 管理」：名称、开关、启动方式、变量和删除都锁住，在 Magpie 中修改，缺少的密钥也在 Magpie 中填写；连接状态、工具列表、重连和 OAuth 登录仍可在 Plume 中查看或操作。

Plume 不把分发的指令和 MCP 配置另存进自己的设置，所以在 Magpie 中撤回、或停用 `plume.magpie` 后不会留下副本。已有手动配置保留；名称和已有服务重名（不分大小写）时保留自己的服务并记录警告，因为名称就是工具名里的那一段。格式损坏或无效的 MCP 条目会记录警告并跳过，原文件不被改写。

这些位置基于默认的 `~/.plume`。使用自定义 `PLUME_HOME` 时，需把插件的 `dir`、`config` 和 `library` 路径一起改为 `<PLUME_HOME>/plugin-data/plume.magpie/` 下对应的绝对路径。
