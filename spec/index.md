# 项目 spec 路由

`index.md` 是选择 rule 的路由表。先读 [`safety.md`](./safety.md)；计划、实现、交付检查再读 [`loop.md`](./loop.md) 对应章节。

## 怎么判断命中

- 看需求形态，命中 `scenario/`。
- 看业务对象或业务链路，命中 `domain/`。
- 看改动文件、技术机制和公共影响面，命中 `tech/`。
- `files` 列命中的 rule 必须读取；`⚠️` 表示关键实现面，命中后动手前先读。
- 一次任务可以命中多个 rule；只读命中的，不全量加载。

新增、删除、重命名 rule 时必须同步本表。

## 需求场景（scenario/）—— 做这类需求时读

| rule | 何时读（when） | 触发文件（files） |
|---|---|---|
| [tool-card](./scenario/tool-card.md) | 转录里的工具调用和过程行（合并、收起、思考、运行行）、审批卡、插件的界面入口、通用卡片、工具输出和 diff 的展示 | `apps/desktop/src/renderer/plugins.tsx`、插件仓库的 `plugins/*/src/ui.tsx`、`apps/desktop/src/renderer/conversation/**`（转录：`Transcript`、`ToolCard`、`WorkStep`、`TurnWork`……），`apps/desktop/src/renderer/conversation/ApprovalOverlay.tsx`、`apps/desktop/src/renderer/composer/PermissionPicker.tsx` |
| [form-page](./scenario/form-page.md) | 设置页这类表单：输入框、下拉、开关、提交、取消、错误提示 | `apps/desktop/src/renderer/settings/**`、`apps/desktop/src/renderer/app.tsx` 里的 `SettingsScreen` |

## 业务域（domain/）—— 命中业务对象或业务链路时读

暂时没有 rule。会话、插件宿主、钩子的设计目前在 [`agent-extension.md`](../agent-extension.md)。

写插件（插件仓库的 `plugins/**`）或改插件接口（`packages/contract/src/plugin.ts`、`packages/contract/src/ui.ts`）时，必须读 skill [`plume-plugin`](../skills/plume-plugin/SKILL.md)；改了接口同步它，`pnpm check:plugins` 会查。

## 技术事实（tech/）—— 命中技术面或文件时读

| rule | 何时读（when） | 触发文件（files） |
|---|---|---|
| [tokens](./tech/tokens.md) ⚠️ | 颜色、字号、圆角、尺寸、阴影、动效的取值和用途；加新 token；皮肤 | `packages/client/styles/src/theme.css`、`packages/contract/src/ui.ts`（`SkinToken`） |
| [styling](./tech/styling.md) ⚠️ | 写样式、类名、Tailwind、行内 style、全局样式、样式检查的规则和例外 | `packages/client/styles/**`、`apps/desktop/src/renderer/styles.css`、`scripts/check-styles.mjs`、任何 `className` / `style` 的改动 |
| [commits](./tech/commits.md) | 写提交信息、把工作区的改动拆成几个提交 | `git commit` |
| [components](./tech/components.md) ⚠️ | 基础组件（按钮、图标按钮、输入框、卡片、代码块）、`@plume/styles` 的类名组合、加新的公共组件 | `packages/client/ui/**`、`packages/client/styles/src/index.ts` |
