/**
 * 用户拒绝之后给模型的话：别原样重试，也别换个工具达到同样效果。和 plume.tools 的拒绝文案用的是同一句，模型在哪看到都认得出。
 *
 * 单放一处：循环（`tool-run.ts`）、跑命令（`commands.ts`）、读文件（`run-files.ts`）都用它，后两者又挂在宿主上，放进循环里就绕成了圈。
 */
export const DECLINED =
	"Do not retry it unchanged or get the same effect another way — another tool, a shell command, a script. Change your approach; if the task cannot go on without it, say so.";
