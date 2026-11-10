# 开发循环

> 计划、实现、交付检查时使用。具体 rule 从 [`index.md`](./index.md) 选择，常驻红线见 [`safety.md`](./safety.md)。

## 计划

动手前确认：

- 需求的目标和验收方式。
- 本体还是插件：按 [`safety.md`](./safety.md) 第 2 条定。
- 命中的 scenario、domain、tech rule。
- 可复用的来源：`@plume/ui` 组件、`@plume/styles` 的类名组合、已有 token、已有钩子和工具。

出现以下信号时，先写出简短计划再动手：

- 跨进程（主进程、agent 进程、渲染进程）或跨三个以上的包。
- 改动 `@plume/contract`、`@plume/ui`、`@plume/styles`、theme.css 这类公开接口或 `index.md` 里标 ⚠️ 的 rule 文件。
- 要新增钩子、界面扩展点、token 或公共组件。

## 实现

- 改公开接口、常量、配置前先 `rg` 全部引用。
- 先复用现有组件、类名组合和 token；照着别处做一个东西时，换的是深度，不是整段类名（见 [`tech/tokens.md`](./tech/tokens.md)「深度」）。
- 改样式时不要顺手改掉功能：改版后少了一样能点的东西，按回归处理。
- 边界态：空数据、长文本（路径、命令、输出）、加载中、禁用、失败、agent 进程退出、窄窗口、浅色和深色。

## 交付

- `pnpm check`：类型检查、lint、格式、测试、样式、文案、插件、链接检查和依赖方向，必须全过。
- 改了进程、协议、界面或插件：开发中用 `PLUME_SMOKE_ONLY=changed pnpm smoke` 只跑改动碰到的段，交付前跑一次完整的 `pnpm smoke`（别的会话正在跑也直接跑，不用等；只是构建排队几秒），并打开这次运行的 `.smoke/<时间戳>/<段名>/` 里的截图（主流程 `main/` 里有审批卡、结束时、面板）看一眼。有段没过时，修完用它最后给出的 `PLUME_SMOKE_ONLY=…` 只重跑那几段，不必整轮重来。截图跟随系统深浅色；只能看到一种时，在报告里说明另一种没看。
- 改动文件对照 [`index.md`](./index.md) 的 files 列，回读命中的 rule，确认没有违背。

要求提交时，提交信息和怎么拆按 [`tech/commits.md`](./tech/commits.md)。

交付报告写清：改动文件和原因、回读的 rule、验证结果、没验证的项和原因。

本次产生长期规则时，写入最窄的 rule 并同步 `index.md`；能写成检查的，写进 `pnpm check`。
