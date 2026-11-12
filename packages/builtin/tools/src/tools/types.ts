/**
 * 本体工具内部的形状：工具拿到会话的环境，返回给模型的内容和给卡片的 `details`。
 *
 * 和 `ToolDefinition` 分开写：工具直接拿到按会话记的状态（读过哪些文件）、跑命令的入口（`ToolRun.exec`）、这一次的 shell，
 * 测试里直接调也不用造一整个 `ToolRun`。`toDefinition` 把它换成工具表里的样子。
 */

import type { ApprovalContent, ApprovalDecision, BackgroundChannel, ShellInfo, ToolDefinition, ToolKind, ToolOutput, ToolRun } from "@plume/contract";
import type { ResourceRouter } from "../resources/router.ts";

type ToolContent = { type: "text"; text: string };

export interface ToolResult {
	/** 模型看到的。 */
	content: ToolContent[];
	/** 跟在 `content` 后面一起交给模型的图（read 读图片）。 */
	images?: NonNullable<ToolOutput["images"]>;
	/** 卡片画的，不发给模型。 */
	details?: unknown;
	isError?: boolean;
	/** 这条结果之后再没人要读：没搜到、空目录（见 `ToolOutput.uneventful`）。 */
	uneventful?: boolean;
}

export interface ToolContext {
	/** 会话的工作目录，绝对路径。 */
	cwd: string;
	/** 直接工具测试可不给；没有私有目录时不记录快照。 */
	dataDir?: string;
	sessionId?: string;
	/** 会话的临时目录（`ToolRun.scratchDir`）；直接工具测试可不给，不给就没有 `scratch://`。 */
	scratchDir?: string;
	/** 同一脉的会话（子会话、分叉、建议开出的新会话）的临时目录（`ToolRun.scratchDirs`），写不用问人；不给时只算 `scratchDir`，见 `scratchDirsOf`。 */
	scratchDirs?: readonly string[];
	/** 资源地址（`scratch://` 之类，见 `resources/`）；不给时地址都按普通路径读。 */
	resources?: ResourceRouter;
	signal?: AbortSignal;
	/** 按会话记的状态（读过哪些文件之类），会话结束前一直在。 */
	state: Map<string, unknown>;
	/** 问人要不要做这件事；不给就是没人可问。 */
	requestApproval?: (request: ApprovalContent) => Promise<ApprovalDecision>;
	/** 这一轮明确交给它看的工作区外的文件（拖进来的附件）。 */
	allowedPaths?: ReadonlySet<string>;
	/** 同一个项目的其他源码目录，读它们不用问。 */
	projectRoots?: readonly string[];
	/** 命令照哪个 shell 写（`ToolRun.shell()`，会话宣布的那一档）；不给时按这台机器的默认 shell 读（测试里直接调）。 */
	shell?: Pick<ShellInfo, "kind">;
	/** 跑命令（`ToolRun.exec`）：沙箱档由本体按权限模式定。不给就跑不了命令。 */
	exec?: ToolRun["exec"];
	/** 申请这次调用的命令跑在更宽的一档（`ToolRun.escalate`）：本体弹提权卡、只认人答。不给就不能提权。 */
	escalate?: ToolRun["escalate"];
	/** 这个会话现在有哪些工具：改道只建议真有的；不给就是不改道。 */
	toolNames?: ReadonlySet<string>;
	/** 执行中的输出，一段一段推给界面（追加，不是整份替换）。 */
	onProgress?: (chunk: string) => void;
	/** 后台结果送回会话的渠道（`ToolRun.background`）；子会话和直接调工具的测试没有，后台任务只能让模型自己读。 */
	background?: () => BackgroundChannel;
}

export interface Tool<TArgs = Record<string, unknown>> {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** 模型常写错的参数名，宿主在执行前换成规范名，见 `ToolDefinition.aliases`。 */
	aliases?: ToolDefinition["aliases"];
	/** 会改动工作区：相邻的调用不和它同时跑。 */
	mutating?: boolean;
	/** mutating 的工具里，这一次调用能证明什么都不改：可以和相邻的只读调用同时跑。 */
	readsOnly?(args: Record<string, unknown>): boolean;
	/** 导出会话成 Markdown 时这一次调用写成的一行，见 `ToolDefinition.describe`。 */
	describe?(args: Record<string, unknown>): string | undefined;
	/** 做的是哪种活，见 `ToolDefinition.kind`。 */
	kind?: ToolKind;
	execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具执行时插件给它的东西：按会话记的状态。 */
export interface ToolEnv {
	dataDir?: string;
	resources?: ResourceRouter;
	state(sessionId: string): Map<string, unknown>;
}

/** 文件工具和公开读取授权服务使用同一份会话环境，批准入口及状态不能另起一份。 */
export function toolContext(run: ToolRun, env: ToolEnv): ToolContext {
	return {
		cwd: run.cwd,
		projectRoots: run.projectRoots,
		...(run.allowedPaths ? { allowedPaths: new Set(run.allowedPaths) } : {}),
		sessionId: run.sessionId,
		scratchDir: run.scratchDir,
		...(run.scratchDirs ? { scratchDirs: run.scratchDirs } : {}),
		...(env.resources ? { resources: env.resources } : {}),
		...(env.dataDir ? { dataDir: env.dataDir } : {}),
		signal: run.signal,
		state: env.state(run.sessionId),
		requestApproval: (content: ApprovalContent): Promise<ApprovalDecision> => run.ask(content),
		exec: (command, options) => run.exec(command, options),
		escalate: (request) => run.escalate(request),
		toolNames: new Set(run.tools().map((entry) => entry.name)),
		onProgress: run.progress,
		...(run.background ? { background: () => run.background!() } : {}),
	};
}

/** 换成工具表里的样子。会改动工作区的工具自己在 execute 里经 `run.ask` 问（`asks`）。 */
export function toDefinition<TArgs>(tool: Tool<TArgs>, env: ToolEnv): ToolDefinition {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.aliases ? { aliases: tool.aliases } : {}),
		...(tool.mutating ? { mutating: true } : {}),
		...(tool.readsOnly ? { readsOnly: tool.readsOnly } : {}),
		...(tool.describe ? { describe: tool.describe } : {}),
		...(tool.kind ? { kind: tool.kind } : {}),
		asks: true,
		async execute(args, run: ToolRun): Promise<ToolOutput> {
			// 跑命令的（bash、monitor）会改动工作区，要知道命令照哪个 shell 写；只读的工具在进程里读文件，用不着。
			const shell = tool.mutating ? await run.shell() : undefined;
			const result = await tool.execute(args as TArgs, { ...toolContext(run, env), ...(shell ? { shell } : {}) });
			return {
				output: result.content.map((part) => part.text).join("\n"),
				...(result.images?.length ? { images: result.images } : {}),
				...(result.isError ? { isError: true } : {}),
				...(result.details === undefined ? {} : { details: result.details }),
				...(result.uneventful ? { uneventful: true } : {}),
			};
		},
	};
}
