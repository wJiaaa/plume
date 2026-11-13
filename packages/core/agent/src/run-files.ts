/**
 * 替模型读、写这台机器时本体守的线，和插件拿到的工作区能力：`ToolRun.files`（读边界、问人，写边界、改动快照）、`ToolRun.exec` 带
 * `recordChanges` 时的命令观测、`ctx.resources`（资源地址）、`ctx.workspace`（项目文件清单）、`ctx.changes`（改动汇总和撤销），
 * 和撤回、编辑重发时连文件一起退（`revert`）。
 *
 * 读边界、写边界、改动快照原来在读写文件的插件里，别的插件要读写用户的文件得经它的服务、或者自己再判一遍；撤回时连文件退又靠
 * 第三个插件去解析工具结果里约定的字段。现在判定和快照在 `@plume/workspace`，这里把它们接到过闸、调用结果和会话上：卡片画什么、
 * 人拒绝了怎么告诉模型，这次调用改了哪些文件（`ToolOutput.changes`）。循环（`tool-run.ts`）不认识这些，只经 `ToolScope.files`
 * 把它们挂到 `run` 上，和 `commands.ts` 的跑命令一样。
 */

import { realpath } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
	ApprovalContent,
	ApprovalDecision,
	FileChanges,
	FileStamp,
	InstalledPlugin,
	Message,
	PluginChanges,
	PluginResources,
	PluginWorkspace,
	RevertPlan,
	RunFiles,
	SandboxProcess,
	SessionSummary,
	ShellInfo,
	ToolRun,
} from "@plume/contract";
import { withinOrIs } from "@plume/platform";
import {
	ArtifactStore,
	artifactResource,
	authorizeCommandReads,
	ChangeLock,
	ChangeStore,
	type ChangeWords,
	CommandChanges,
	type CommandObservation,
	gitListedFiles,
	pluginResource,
	type ReadRequest,
	type ReadScope,
	readOnly,
	readTarget,
	ResourceRouter,
	scratchResource,
	sessionResource,
	TextFiles,
	toAbsolute,
	withPluginView,
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
	/** 同一脉的会话的临时目录（`ToolRun.scratchDirs`），写进去不受「不写 Plume 的数据目录」限制；不给时只算 `scratchDir`。 */
	scratchDirs?: readonly string[];
	/** 外层要求这次调用不改动工作区（`ToolExecution.readOnly`）：`change`、`write` 一律拒绝。 */
	readOnly?: boolean;
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

/** 一次调用的文件能力：挂到 `run` 上的 `files`，包一层 `exec` 观测命令，调用收场时交出这次改了哪些文件。 */
export interface CallFileAccess {
	files: RunFiles;
	/** 包住这次调用的 `ToolRun.exec`：带 `recordChanges` 的命令由本体观测。 */
	exec(exec: ToolRun["exec"]): ToolRun["exec"];
	/** 这次调用到现在记下的改动（`ToolOutput.changes`）；什么都没改、没观测时是 undefined。 */
	recorded(): Promise<FileChanges | undefined>;
}

// i18n-exempt：交给模型的工具结果。
const READ_ONLY = "Not changed: this conversation may not change files right now.";

/** 改动记录给人看的话，按现在的界面语言。 */
function changeWords(): ChangeWords {
	return {
		undoBusy: text("changes.undoBusy"),
		undoRunning: text("changes.undoRunning"),
		undoEmpty: text("changes.undoEmpty"),
		undoInvalid: text("changes.undoInvalid"),
		undoCommand: text("changes.undoCommand"),
		undoInterleaved: text("changes.undoInterleaved"),
		undoOutside: text("changes.undoOutside"),
		undoModified: text("changes.undoModified"),
		undoFailed: text("changes.undoFailed"),
		changeMissing: text("changes.missing"),
		changeSaveFailed: text("changes.saveFailed"),
		changeWarning: (reason) => text("changes.warning", { reason }),
		changeLargeFile: text("changes.largeFile"),
		changeBinary: text("changes.binary"),
		changeSecret: text("changes.secret"),
		changeManyBefore: text("changes.manyBefore"),
		changeManyAfter: text("changes.manyAfter"),
		changeLargeBefore: text("changes.largeBefore"),
		changeLargeAfter: text("changes.largeAfter"),
		changeBackground: text("changes.background"),
		changeObserveFailed: text("changes.observeFailed"),
	};
}

/**
 * 每个 agent 一份：资源地址的路由（本体自己的四个 scheme 加上插件登记的）、被折叠的大输出、数据目录，改动快照和撤销的门闩
 * （一个 agent 一把：项目可以嵌套，文件可以经硬链接共享，按文件锁挡不住）。
 */
export class Workspace {
	private readonly router = new ResourceRouter();
	private readonly artifacts = new ArtifactStore();
	private readonly lock = new ChangeLock(changeWords);
	private readonly store: ChangeStore;
	private readonly textFiles: TextFiles;
	private readonly commands: CommandChanges;
	/** 经 `exec` 观测着的进程（连同它们留下的进程）：之后的调用经 `includeChanges` 把它们记下的算进来。 */
	private readonly observed = new WeakMap<SandboxProcess, CommandObservation>();

	/**
	 * @param dataDir Plume 的数据目录：各会话的临时目录在它的 `scratch/` 下（读都不问），隔离视图、改动快照在它下面，文件工具不写它。
	 * @param sessions `session://` 读别的会话用；`ctx.changes` 按它找会话的工作目录，撤销按它看哪些会话还在跑。
	 * @param plugins `plugin://` 读插件的说明用：现在启用着的插件。
	 */
	constructor(
		private readonly dataDir: string,
		private readonly sessions: { list(): Promise<SessionSummary[]>; messages(sessionId: string): Promise<Message[]> },
		plugins: () => InstalledPlugin[],
	) {
		for (const handler of [scratchResource, artifactResource(this.artifacts), sessionResource(sessions), pluginResource(plugins)])
			this.router.register(handler);
		// 同一个或嵌套的项目里还有会话在跑一轮时不撤销：它可能正要改这些文件。
		const running = async () => (await sessions.list()).filter((session) => session.running).map((session) => session.cwd);
		this.store = new ChangeStore(dataDir, this.lock, changeWords, running);
		this.textFiles = new TextFiles(this.store, this.lock, changeWords);
		this.commands = new CommandChanges(dataDir, this.store, this.lock, changeWords);
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
		git: (root, work) => withPluginView(String(root), this.dataDir, work),
	};

	/** 插件的 `ctx.changes`：工作目录用会话自己的。 */
	readonly changes: PluginChanges = {
		collect: async (sessionId, ids) => this.store.collect(String(sessionId), await this.cwdOf(sessionId), Array.isArray(ids) ? ids : []),
		undo: async (sessionId, ids, path) =>
			this.store.undo(String(sessionId), await this.cwdOf(sessionId), Array.isArray(ids) ? ids : [], typeof path === "string" ? path : undefined),
	};

	private async cwdOf(sessionId: string): Promise<string> {
		const found = (await this.sessions.list()).find((session) => session.id === sessionId);
		if (!found) throw new Error(text("session.notFound", { id: String(sessionId) }));
		return found.cwd;
	}

	/** 会话删掉了：它被折叠的大输出跟着丢掉，改动快照删掉（之后迟到的记录也不再落盘）。 */
	forget(sessionId: string): Promise<void> {
		this.artifacts.forget(sessionId);
		return this.store.forget(sessionId);
	}

	/** 发一问期间占着门闩，撤销不能同时开始；撤销进行中返回 undefined，这一问该拦下。 */
	beginPrompt(): (() => void) | undefined {
		return this.lock.beginPrompt();
	}

	/**
	 * 撤回、编辑重发截掉 `messages`（从那条人发的消息起到最后）时那段改过的文件：只演算，或者真的退回到截断点之前。
	 *
	 * 认的是结果上本体记下的 `ToolResultMessage.changes`，不认是哪个工具交的。全有或全无：有改动没记下来（命令影响的文件太多没记全、
	 * 命令还在后台跑、快照读不出来），或者一个文件不能安全退回（来自命令、中途被别处改过、不在项目内、之后被人或别的会话改过），
	 * 就一个文件都不写。只退回一部分，代码停在一个从没存在过的中间状态，比不退更糟；被别人改过的文件不覆盖、不合并，留给人。
	 * 截掉的那段里新建的文件退回时删掉。`restore` 时退不回去抛错，message 给人看。
	 */
	async revert(sessionId: string, cwd: string, messages: readonly Message[], restore: boolean): Promise<RevertPlan> {
		const { ids, warnings } = recordedChanges(messages);
		const summary = ids.length ? await this.store.collect(sessionId, cwd, ids) : { files: [], warnings: [] };
		// 不能退回又说不出是哪一类的（快照读不出来），也算没记全。
		const unrecorded = warnings.length > 0 || summary.warnings.length > 0 || summary.files.some((file) => !file.canUndo && !file.undoProblem);
		const files = summary.files.map((file) => ({
			path: file.path,
			added: file.added,
			removed: file.removed,
			problem: file.canUndo ? null : (file.undoProblem ?? null),
		}));
		if (!restore) return { files, unrecorded };
		if (unrecorded) throw new Error(text("changes.unrecorded"));
		// 不拿刚才演算的结论直接写：撤销写之前按快照把每个文件再查一遍，有一个不对就都不写，写到一半失败把写了的退回去。
		if (files.length) await this.store.undo(sessionId, cwd, ids);
		return { files, unrecorded };
	}

	/** 一次调用的 `ToolRun.files`、包过的 `exec` 和这次调用记下的改动。 */
	call(call: CallFiles): CallFileAccess {
		const scope = (shell?: ReadScope["shell"]): ReadScope => ({
			cwd: call.cwd,
			dataDir: this.dataDir,
			...(call.allowedPaths?.length ? { allowedPaths: new Set(call.allowedPaths) } : {}),
			...(call.projectRoots ? { projectRoots: call.projectRoots } : {}),
			...(shell ? { shell } : {}),
			confirm: (request) => confirm(call, request),
		});
		const resourceScope = { cwd: call.cwd, sessionId: call.sessionId, scratchDir: call.scratchDir, signal: call.signal };
		const changeScope = {
			cwd: call.cwd,
			scratchDirs: call.scratchDirs ?? [call.scratchDir],
			dataDir: this.dataDir,
			sessionId: call.sessionId,
			signal: call.signal,
		};
		const ids = new Set<string>();
		const paths = new Set<string>();
		/** 这次调用要算进来的命令：自己起的，和经 `includeChanges` 指明的。 */
		const commands = new Set<CommandObservation>();
		const files: RunFiles = {
			read: async (target, options) => {
				call.alive("ToolRun.files.read");
				return readTarget(scope(), { router: this.router, scope: resourceScope }, target, options?.directory === true);
			},
			readCommand: async (command) => {
				call.alive("ToolRun.files.readCommand");
				const refused = await authorizeCommandReads(scope(await call.shell()), String(command));
				return refused === null ? { ok: true } : { ok: false, message: refused };
			},
			resolve: (path) => toAbsolute(call.cwd, String(path)),
			change: async <T>(path: string, edit: Parameters<RunFiles["change"]>[1]) => {
				call.alive("ToolRun.files.change");
				if (call.readOnly) throw new Error(READ_ONLY);
				const input = String(path);
				let written: FileStamp | undefined;
				const done = await this.textFiles.change(changeScope, input, async (file) => {
					const answer = await edit({ path: file.path, text: file.before, stamp: file.stamp });
					if (answer?.text !== undefined) {
						// i18n-exempt：给插件作者的报错，作为工具结果交给模型。
						if (typeof answer.text !== "string") throw new Error("ToolRun.files.change 的 edit 交回的 text 必须是字符串");
						const result = await file.write(answer.text);
						written = result.stamp;
						if (result.changeId) {
							ids.add(result.changeId);
							// 照调用里写的路径记（不追链接），和读文件结果的 `FileViewDetails.path` 对得上。
							paths.add(toAbsolute(call.cwd, input));
						}
					}
					return { value: answer?.value as T, path: file.path };
				});
				return { value: done.value, path: done.path, ...(written ? { written } : {}) };
			},
			write: async (address, content) => {
				call.alive("ToolRun.files.write");
				if (call.readOnly) return { ok: false, message: READ_ONLY };
				const target = String(address);
				// i18n-exempt：交给模型的工具结果。
				if (!this.router.canResolve(target)) return { ok: false, message: `“${target}”不是一个地址。` };
				try {
					await this.router.write(target, String(content), resourceScope);
					const located = await this.router.locate(target, resourceScope).catch(() => null);
					return { ok: true, ...(located ? { path: located } : {}) };
				} catch (error) {
					return { ok: false, message: error instanceof Error ? error.message : String(error) };
				}
			},
			includeChanges: (process) => {
				call.alive("ToolRun.files.includeChanges");
				const observation = process && typeof process === "object" ? this.observed.get(process) : undefined;
				if (observation?.sessionId === call.sessionId) commands.add(observation);
			},
		};
		return {
			files,
			exec: (exec) => async (command, options) => {
				const { recordChanges, ...rest } = options ?? {};
				if (recordChanges !== true) return exec(command, options);
				call.alive("ToolRun.exec");
				const observation = await this.commands.begin({ sessionId: call.sessionId, cwd: rest.cwd ?? call.cwd });
				let process: Awaited<ReturnType<ToolRun["exec"]>>;
				try {
					process = await exec(command, rest);
				} catch (error) {
					observation.abandon();
					throw error;
				}
				const adopt = (owned: SandboxProcess) => this.observed.set(owned, observation);
				adopt(process);
				observation.watch(process, adopt);
				commands.add(observation);
				return process;
			},
			recorded: async () => {
				const all = { ids: new Set(ids), paths: new Set(paths), warnings: new Set<string>() };
				const real = commands.size ? await realpath(call.cwd).catch(() => call.cwd) : call.cwd;
				for (const observation of commands) {
					const record = await observation.read();
					for (const id of record.ids) all.ids.add(id);
					// 命令改的按真实路径记下；工作目录在链接后面时写成工作目录下的路径，和调用里写的路径对得上。
					for (const path of record.paths) all.paths.add(withinOrIs(real, path) ? join(call.cwd, relative(real, path)) : path);
					if (record.warning) all.warnings.add(record.warning);
				}
				if (!all.ids.size && !all.warnings.size) return undefined;
				return { ids: [...all.ids], paths: [...all.paths], ...(all.warnings.size ? { warning: [...all.warnings].join("\n") } : {}) };
			},
		};
	}
}

/** 一段消息里结果上记着的改动：快照标识，和有改动没记全时的说明。 */
function recordedChanges(messages: readonly Message[]): { ids: string[]; warnings: string[] } {
	const ids = new Set<string>();
	const warnings: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.changes) continue;
		for (const id of message.changes.ids) ids.add(id);
		if (message.changes.warning) warnings.push(message.changes.warning);
	}
	return { ids: [...ids], warnings };
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
