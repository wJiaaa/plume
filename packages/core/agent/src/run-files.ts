/**
 * 替模型读这台机器时本体守的线，和插件拿到的工作区能力：`ToolRun.files`（读边界、问人）、`ctx.resources`（资源地址）、`ctx.workspace`（项目文件清单）。
 *
 * 读边界原来在读文件的插件里，别的插件要读用户的文件得经它的服务、或者自己再判一遍，于是有了两套答案、两种批准的记账方式；
 * 本体自己的文件面板又是第三套。现在判定在 `@plume/workspace`，这里把它接到过闸上：卡片画什么、人拒绝了怎么告诉模型。
 * 循环（`tool-run.ts`）不认识这些，只经 `ToolScope.files` 把它们挂到 `run` 上，和 `commands.ts` 的跑命令一样。
 */

import { basename } from "node:path";
import type {
	ApprovalContent,
	ApprovalDecision,
	InstalledPlugin,
	Message,
	PluginResources,
	PluginWorkspace,
	RunFiles,
	SessionSummary,
	ShellInfo,
} from "@plume/contract";
import {
	ArtifactStore,
	artifactResource,
	authorizeCommandReads,
	gitListedFiles,
	pluginResource,
	type ReadRequest,
	type ReadScope,
	readOnly,
	readTarget,
	ResourceRouter,
	scratchResource,
	sessionResource,
} from "@plume/workspace";
import { DECLINED } from "./declined.ts";
import { text } from "./i18n.ts";

/** 造一次调用的 `files` 要的东西，循环（`tool-run.ts`）按这次调用给。 */
export interface CallFiles {
	sessionId: string;
	/** 这次调用的工作目录：相对路径按它解析，读它里面的不问。 */
	cwd: string;
	/** 这个会话的临时目录（`scratch://`）。 */
	scratchDir: string;
	/** 同一个项目的其他源码目录（`ToolRun.projectRoots`）。 */
	projectRoots?: readonly string[];
	/** 人拖进来的文件（`ToolRun.allowedPaths`）。 */
	allowedPaths?: readonly string[];
	signal: AbortSignal;
	/** 这次调用的 shell（`ToolRun.shell`）：一行命令按它的语法拆。 */
	shell(): Promise<ShellInfo>;
	/** 经过闸问一次（`ToolRun.ask` 那一条路）。不给就是没人可问（只在直接造它的测试里）。 */
	ask?(content: ApprovalContent): Promise<ApprovalDecision>;
	/** 调用答完以后再用就抛错。 */
	alive(what: string): void;
}

/** 每个 agent 一份：资源地址的路由（本体自己的四个 scheme 加上插件登记的）、被折叠的大输出、数据目录。 */
export class Workspace {
	private readonly router = new ResourceRouter();
	private readonly artifacts = new ArtifactStore();

	/**
	 * @param dataDir Plume 的数据目录：各会话的临时目录在它的 `scratch/` 下（读都不问），隔离视图建在它下面。
	 * @param sessions `session://` 读别的会话用。
	 * @param plugins `plugin://` 读插件的说明用：现在启用着的插件。
	 */
	constructor(
		private readonly dataDir: string,
		sessions: { list(): Promise<SessionSummary[]>; messages(sessionId: string): Promise<Message[]> },
		plugins: () => InstalledPlugin[],
	) {
		for (const handler of [scratchResource, artifactResource(this.artifacts), sessionResource(sessions), pluginResource(plugins)])
			this.router.register(handler);
	}

	/** 插件的 `ctx.resources`。登记的 scheme 停用时撤下由宿主做（`host.ts`）。 */
	readonly resources: PluginResources = {
		register: (handler) => this.router.register(readOnly(handler)),
		list: () => this.router.schemes(),
		keepArtifact: (sessionId, tool, content) => this.artifacts.keep(sessionId, tool, content),
	};

	/** 插件的 `ctx.workspace`。 */
	readonly workspace: PluginWorkspace = {
		files: (root) => gitListedFiles(String(root), this.dataDir),
	};

	/** 会话删掉了：它被折叠的大输出跟着丢掉。 */
	forget(sessionId: string): void {
		this.artifacts.forget(sessionId);
	}

	/** 一次调用的 `ToolRun.files`。 */
	files(call: CallFiles): RunFiles {
		const scope = (shell?: ReadScope["shell"]): ReadScope => ({
			cwd: call.cwd,
			dataDir: this.dataDir,
			...(call.allowedPaths?.length ? { allowedPaths: new Set(call.allowedPaths) } : {}),
			...(call.projectRoots ? { projectRoots: call.projectRoots } : {}),
			...(shell ? { shell } : {}),
			confirm: (request) => confirm(call, request),
		});
		return {
			read: async (target, options) => {
				call.alive("ToolRun.files.read");
				return readTarget(
					scope(),
					{ router: this.router, scope: { cwd: call.cwd, sessionId: call.sessionId, scratchDir: call.scratchDir, signal: call.signal } },
					target,
					options?.directory === true,
				);
			},
			readCommand: async (command) => {
				call.alive("ToolRun.files.readCommand");
				const refused = await authorizeCommandReads(scope(await call.shell()), String(command));
				return refused === null ? { ok: true } : { ok: false, message: refused };
			},
		};
	}
}

/**
 * 把一次要问的读弹给人：经过闸（`ToolRun.ask` 那一条路），完全访问、「以后不再问」照常放行。
 * 标题只给文件名（整条绝对路径会折成两行），正文给那条路径（卡片上是等宽字体），`reason` 说批准意味着什么，不复述标题。
 */
async function confirm(call: CallFiles, request: ReadRequest): Promise<{ ok: true } | { ok: false; message: string }> {
	// 没有问人的入口时拒绝而不是放行：没人可问，就是没人同意过。
	// i18n-exempt：交给模型的结果。
	if (!call.ask) return { ok: false, message: `${request.reason}需要用户批准，而这个会话没有可以询问的人：${request.shown}` };
	const name = basename(request.absolute) || request.shown;
	const secret = request.scope === "file";
	const decision = await call.ask({
		kind: "view",
		title: secret ? text("files.readSecret", { name }) : text("files.readOutside", { name }),
		detail: request.absolute,
		reason: secret ? text("files.readSecretScope") : text("files.readTreeScope", { grant: request.grant }),
		subject: request.subject,
	});
	if (decision === "once" || decision === "always") return { ok: true };
	// i18n-exempt：交给模型的结果。
	return { ok: false, message: `用户拒绝了这次读取：${request.shown}。${DECLINED}` };
}
