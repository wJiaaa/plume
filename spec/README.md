# Plume spec

`spec/` 是本项目的长期约定入口，用来回答：

- 这类需求在 Plume 里应该怎么做。
- 改动前应该读取哪些项目规则。
- 交付前应该按哪些规则自查。

这里不记录一次性任务方案。一次性事实放在源码、注释、包的 README 或 `docs/` 里；进程、目录、插件机制的说明见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 和 [`agent-extension.md`](../agent-extension.md)。

## 目录

- `safety.md`：任何任务先读的红线。
- `index.md`：按需求、业务对象和文件路径选择 rule。
- `loop.md`：计划、实现、交付检查流程。
- `scenario/`：界面和交互形态（工具卡片、表单页……）。
- `domain/`：业务对象和链路（会话、插件……）。暂时没有 rule。
- `tech/`：设计 token、样式、组件等技术面。

## 怎么加载

1. 先读 `safety.md`。
2. 根据需求、涉及文件和 diff，按 `index.md` 选择命中的 rule。
3. 做计划、实现或交付检查时，读 `loop.md` 对应章节。
4. 只读命中的 rule；没有命中的目录不要全量加载。

一次任务可以同时命中多类 rule。例如“给某个工具加一张插件卡片”通常要读：

- `scenario/tool-card.md`
- `tech/components.md`
- `tech/styling.md`

## 怎么分层

- `scenario/` 看需求形态：卡片、表单、对话、窗口外壳……
- `domain/` 看业务对象：会话、插件、工具调用……
- `tech/` 看技术机制：token、样式写法、基础组件、进程通信、构建……

优先读取最具体的 rule。改动公共组件、`@plume/styles`、theme.css 这类有影响面的东西时，再补对应 `tech/` rule。

## 怎么维护

- 新增、删除、重命名 rule 时同步 `index.md`。
- 新 rule 只放 `scenario/`、`domain/`、`tech/`。
- rule 只写长期有效、可复用、可检查的约定；能写成检查的写进 `pnpm check`（如 `scripts/check-styles.mjs`），rule 里指过去。
- rule 和代码对不上时以代码为准，并顺手改 rule。
- 每个 rule 用同一个结构：一段说明它管什么，然后「开发准则」「检查点」「事实来源」。
