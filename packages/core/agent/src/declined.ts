/**
 * 用户拒绝之后给模型的话：别原样重试，也别换个工具达到同样效果。本体的每一种拒绝都跟着这一句，插件经 `ToolRun.rejection` 拿到同一句，
 * 模型在哪看到都认得出。
 *
 * 单放一处：循环（`tool-run.ts`）、跑命令（`commands.ts`）、读文件（`run-files.ts`）都用它，后两者又挂在宿主上，放进循环里就绕成了圈。
 */
export const DECLINED =
	"Do not retry it unchanged or get the same effect another way — another tool, a shell command, a script. Change your approach; if the task cannot go on without it, say so.";

/** 人在审批卡上拒绝了一次调用：替没写 `asks` 的工具问的、工具自己经 `run.ask` 问的（`ToolRun.rejection`）都交回这一句。 */
// i18n-exempt：工具结果是发给模型的，不随界面语言变。
export const REJECTED = `The user rejected this call. ${DECLINED}`;
