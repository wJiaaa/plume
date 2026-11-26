# AGENTS.md

这是一个 Plume 插件。写法、约束和自检清单见 skill `plume-plugin`：`.claude/skills/plume-plugin/SKILL.md`（SDK 里也有一份：`node_modules/@plumeai/plugin-sdk/skill/`，随 Plume 更新）。动手前先读它；只依赖 skill 里列的公开接口。

## 命令

`plume-plugin` 随 Plume 应用发，Plume 启动过一次就有 `~/.plume/bin/plume-plugin`（Windows 的 cmd、PowerShell 里用同目录的 `plume-plugin.cmd`，Git Bash 里用 `plume-plugin`）；不用装 Node 和 npm。

| 命令 | 作用 |
| --- | --- |
| `~/.plume/bin/plume-plugin check [--strict-style]` | 类型检查，加上插件规则（只引用公开接口、不写产品 Tailwind 类、CSS 不污染全局、界面文字不写死中文；加 `--strict-style` 额外按 Plume 设计系统严查样式），再跑 `test/` 下的测试 |
| `~/.plume/bin/plume-plugin test` | 只跑 `test/*.test.ts`（Node 自带的 node:test，用 `@plumeai/plugin-sdk/testing` 跑插件） |
| `~/.plume/bin/plume-plugin build` | 打出 `dist/index.mjs`（和 `dist/ui.mjs`） |
| `~/.plume/bin/plume-plugin install` | 把 `package.json`、`README.md`、`dist/` 复制进 `~/.plume/local-plugins/<目录名>/`，Plume 开着的话当场加载 |
| `~/.plume/bin/plume-plugin dev` | 构建、装上，之后一改源码就重新构建、装上 |
| `~/.plume/bin/plume-plugin pack` | 构建，打出 `release/<目录名>/`（只含发给插件的文件），交给别人在插件市场「从本地上传」 |
| `~/.plume/bin/plume-plugin link` | `node_modules` 里指向 SDK 的链接坏了（Plume 挪了位置、npm 删了链接）时重建 |

工具、钩子的行为写进 `test/` 的测试里验证，插件规则只管写法。出了问题看 `~/.plume/logs/plume.log`：`ctx.log`、`console`、加载失败、界面入口的报错都在这里。用 npm 装了包以后 `check` 会自己把 SDK 链回来。

文档、注释用中文；代码标识符用英文。界面上给人看的文字中英两份，写在 `src/messages.ts`。
