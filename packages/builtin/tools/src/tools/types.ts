/**
 * 本体工具内部的形状：工具拿到会话的环境，返回给模型的内容和给卡片的 `details`。
 *
 * 和 `ToolDefinition` 分开写：工具直接拿到按会话记的状态（读过哪些文件）、跑命令的沙箱、这一次的沙箱模式，
 * 测试里直接调也不用造一整个 `ToolRun`。`toDefinition` 把它换成工具表里的样子。
 */

import type {
	ApprovalContent,
	ApprovalDecision,
	BackgroundChannel,
	PermissionMode,
	SandboxMode,
	SandboxService,
	ToolDefinition,
	ToolOutput,
	ToolRun,
} from "@plume/contract";
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
	/** 命令跑在哪个沙箱模式里；不给就是不进沙箱（测试里直接调）。 */
	sandboxMode?: SandboxMode;
	/** 跑命令用的服务 `sandbox`。 */
	sandbox?: SandboxService;
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
	/** 会改动工作区：相邻的调用不和它同时跑。 */
	mutating?: boolean;
	/** mutating 的工具里，这一次调用能证明什么都不改：可以和相邻的只读调用同时跑。 */
	readsOnly?(args: Record<string, unknown>): boolean;
	execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

/** 工具执行时插件给它的东西：按会话记的状态、跑命令的沙箱。 */
export interface ToolEnv {
	dataDir?: string;
	resources?: ResourceRouter;
	state(sessionId: string): Map<string, unknown>;
	sandbox: SandboxService;
}

/**
 * 每个权限模式下命令跑在哪个沙箱模式里：权限模式不只是问几次，也是命令碰得到哪些文件。
 * 请求批准只读，什么都不经人同意就写不了；帮我批准能写项目目录和临时目录，项目随便改，`~/.ssh` 碰不到；完全访问不设沙箱。
 * 三个模式都写全：新加一个模式时 TypeScript 会指到这张表，不会因为没查到就悄悄落到最宽的那个。
 */
const SANDBOX_BY_PERMISSION: Record<PermissionMode, SandboxMode> = {
	ask: "read-only",
	auto: "workspace-write",
	full: "danger-full-access",
};

/** 文件工具和公开读取授权服务使用同一份会话环境，批准入口及状态不能另起一份。 */
export function toolContext(run: ToolRun, env: ToolEnv): ToolContext {
	return {
		cwd: run.cwd,
		projectRoots: run.projectRoots,
		...(run.allowedPaths ? { allowedPaths: new Set(run.allowedPaths) } : {}),
		sessionId: run.sessionId,
		scratchDir: run.scratchDir,
		...(env.resources ? { resources: env.resources } : {}),
		...(env.dataDir ? { dataDir: env.dataDir } : {}),
		signal: run.signal,
		state: env.state(run.sessionId),
		requestApproval: (content: ApprovalContent): Promise<ApprovalDecision> => run.ask(content),
		sandbox: env.sandbox,
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
		...(tool.mutating ? { mutating: true } : {}),
		...(tool.readsOnly ? { readsOnly: tool.readsOnly } : {}),
		asks: true,
		async execute(args, run: ToolRun): Promise<ToolOutput> {
			// 沙箱只管跑命令的那个（bash），它会改动工作区；只读的工具在进程里读文件，不用它。
			// 外层要求不改工作区（计划模式）时不看权限模式，一律只读：给不了只读沙箱时 sandbox 服务抛错，命令不跑。
			const sandboxMode: SandboxMode | undefined = !tool.mutating ? undefined : run.readOnly ? "read-only" : SANDBOX_BY_PERMISSION[await run.permissionMode()];
			const result = await tool.execute(args as TArgs, {
				...toolContext(run, env),
				...(sandboxMode ? { sandboxMode } : {}),
			});
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
