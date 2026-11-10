# 提交

管提交信息怎么写、改动怎么拆成提交。格式用 conventional commits，scope 是 Plume 的目录。什么时候能提交见 [`safety.md`](../safety.md) 第 7 条：未经要求不 commit。

## 开发准则

### 格式

```
<type>(<scope>): <中文主题>

<为什么这次改动是必要的；改了什么行为；踩过什么坑>
```

- 主题一行，整行（含 `type(scope): `）不超过 100 个字符；然后空一行，再写正文。
- 主题和正文用中文；代码标识符、路径、命令照原样写。
- 正文的行不强制折行：贴进来的输出、路径、堆栈折了就坏了。

### type

| type | 用于 |
|---|---|
| `feat` | 新功能、新插件、新界面、新的插件接口 |
| `fix` | 修好一个能观察到的问题 |
| `perf` | 只为变快、变省 |
| `refactor` | 行为不变的结构调整：拆文件、挪位置、合并重复实现 |
| `docs` | 只改文档、spec、skill |
| `test` | 只改测试、冒烟 |
| `chore` | 杂项：初始化、脚本、配置 |
| `ci`、`build` | 打包、构建配置 |
| `revert` | 撤销某个提交 |

### scope

按改动主要落在哪个目录取：

| scope | 目录 |
|---|---|
| `core` | `packages/core/`、`packages/builtin/`（agent 进程里的本体和内置插件），以及主要为它们改的 `packages/contract/`、`packages/infra/` |
| `electron` | `apps/desktop/src/main/`、`apps/desktop/src/preload/`、打包配置 |
| `desktop` | `apps/desktop/src/renderer/` |
| `ui` | `packages/client/`（`@plume/ui`、`@plume/styles`） |
| `plugins` | 插件仓库 plume-plugins 里经市场安装的插件 |
| `release`、`deps` | 发版；依赖升级 |

同时横跨好几个包、说不出主要落在哪的（比如插件 SDK 连带 contract、ui、检查脚本），不写 scope：`feat: …`。

### 主题写什么

- 写人能观察到的结果，不写改了哪个文件：`fix(desktop): 归档当前会话后右侧换成新对话，不再停在归档的会话上`，不写 `fix(desktop): 改 app.tsx 的 session 处理`。
- 修问题的主题常写成「X 不再 Y」「X 时 Y」：`fix(plugins): 对话在工作树里时 Git 分支签不再出现，以免切走工作树的分支`。
- 新插件写它让人能做什么：`feat(plugins): 新增浏览器插件，人和 Agent 在对话旁边操作同一个网页`，插件名、工具名放进正文。
- 不写「修复若干问题」「优化」「调整」这种看不出做了什么的话；不用冒号或顿号堆成清单，堆起来的说明本该拆成几个提交，或者放进正文。

### 正文写什么

- 先说为什么：原来哪里不对、缺了什么。
- 改了行为就说改了什么行为；有取舍、踩过坑（试过不行的做法、量出来的数字）写进来，下一个人不用再踩一遍。
- 有已知没过的检查、没验证的地方，如实写上。
- 不复述 diff：哪些文件改了，`git show` 看得到。

### 怎么拆

- 一个提交做一件事。工作区里堆了好几样功能时，按功能拆：本体和接口在前，用到它们的插件在后，冒烟和文档可以各成一个。
- 顺手改的格式、改名和真正的改动分开提交，评审时分得清。
- 只提交自己这次的改动；工作区里别的会话正在改的文件不 add、不 stash、不覆盖。
- 共用的大文件（`app.tsx`、`agent.ts`、`@plume/contract`）同时装着几样功能时，可以整个文件跟着主要那一笔走，但最后一个提交必须过 `pnpm check`。

## 检查点

- commit-msg 钩子（[`lefthook.yml`](../../lefthook.yml)，`pnpm install` 时由根目录的 `prepare` 装上）跑 [`scripts/check-commit-msg.mjs`](../../scripts/check-commit-msg.mjs)：type 不在名单里、标题超过 100 个字符、标题和正文之间没空行时拦下；scope 不在名单里只提醒。type、scope 的名单以脚本为准，改名单时同步上面两张表。临时跳过用 `git commit --no-verify`。
- pre-commit 会替暂存的文件排版、跑 `oxlint --fix`。只提交自己的几个文件时用 `git commit -- <路径>`；这种提交方式下钩子改过文件会拦下一次（改动进不了暂存区，见 [`scripts/check-only-commit.mjs`](../../scripts/check-only-commit.mjs)），工作区已经修好，原样再提交一次。
- 钩子只查形状：正文说没说为什么、`git diff --cached --stat` 里是不是只有这件事的文件，自己对一遍。
- 提交前 `pnpm check` 全过（见 [`loop.md`](../loop.md)「交付」）。

## 事实来源

- 检查：`scripts/check-commit-msg.mjs`（type 名单、标题不超过 100 个字符、不查正文行长）。
- 例子：`git log` 里现有的提交。
