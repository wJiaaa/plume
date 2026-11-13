/**
 * 测试里直接调工具时的 `ToolRun.files`、`ToolRun.exec` 的改动观测、`ctx.workspace.files`、`ctx.resources`（代替宿主给的）：就是本体
 * `run-files.ts` 的实现，不经插件宿主。读写边界的判定、改动快照、卡片和拒绝的说法由本体定，在 `packages/core/workspace/test/`、
 * `packages/core/agent/test/run-files.test.ts` 里测。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileChanges, PluginChanges, PluginResources, ResourceHandler, SessionSummary, ShellInfo } from "@plume/contract";
import { Workspace } from "../../../core/agent/src/run-files.ts";
import type { ToolContext } from "../src/tools/types.ts";

/** 没给 `dataDir` 时本体用的数据目录：隔离视图建在它下面，不能落到真实的 ~/.plume。 */
const DATA_DIR = join(tmpdir(), "plume-tools-test-data");

type Input = Omit<ToolContext, "files" | "projectFiles" | "resources"> &
	Partial<Pick<ToolContext, "files" | "projectFiles" | "resources">> & {
		/** Plume 的数据目录：改动快照记在它下面，文件工具不写它。 */
		dataDir?: string;
		sessionId?: string;
		/** 同一脉的会话的临时目录（`ToolRun.scratchDirs`）。 */
		scratchDirs?: readonly string[];
		/** 这一轮人拖进来的文件（`ToolRun.allowedPaths`）。 */
		allowedPaths?: readonly string[];
		/** 同一个项目的其他源码目录（`ToolRun.projectRoots`）。 */
		projectRoots?: readonly string[];
		/** 别的插件登记的 scheme（技能插件的 `skill://` 那种）。 */
		handlers?: readonly ResourceHandler[];
	};

/** 补上的那几样，外加测试要看的：到现在记下的改动（宿主记在工具结果上的 `ToolOutput.changes`）和这个会话的 `ctx.changes`。 */
export type TestContext = ToolContext & {
	resources: PluginResources;
	recorded(): Promise<FileChanges | undefined>;
	changes: PluginChanges;
	sessionId: string;
	/** 同一个本体（同一把门闩、同一份观测着的进程）上的下一次调用，`state` 也是同一份。 */
	nextCall(): TestContext;
};

/**
 * 补上本体给的那几样。问人用 `requestApproval`（宿主上两者是同一个过闸），不给就是没人可问。
 * 换了 `requestApproval`、`cwd` 之类时重新调一次：已有的 `files` 不算数，按这次给的重造。
 * 之后再给 `exec` 赋值也会包上本体的改动观测，和宿主给工具的 `run.exec` 一样。
 */
export function withFiles(ctx: Input): TestContext {
	const {
		allowedPaths,
		projectRoots,
		handlers = [],
		files: _files,
		projectFiles: _projectFiles,
		resources: _resources,
		dataDir = DATA_DIR,
		sessionId = "test",
		scratchDirs,
		exec,
		...rest
	} = ctx;
	const session = { id: sessionId, cwd: rest.cwd, running: false } as SessionSummary;
	const workspace = new Workspace(dataDir, { list: async () => [session], messages: async () => [] }, () => []);
	for (const handler of handlers) workspace.resources.register(handler);
	return callOn(workspace, {
		...rest,
		dataDir,
		sessionId,
		...(scratchDirs ? { scratchDirs } : {}),
		...(allowedPaths ? { allowedPaths } : {}),
		...(projectRoots ? { projectRoots } : {}),
		...(exec ? { exec } : {}),
	});
}

function callOn(
	workspace: Workspace,
	input: Omit<Input, "handlers" | "files" | "projectFiles" | "resources"> & { dataDir: string; sessionId: string },
): TestContext {
	const { allowedPaths, projectRoots, dataDir, sessionId, scratchDirs, exec, ...rest } = input;
	const ask = rest.requestApproval;
	const scratchDir = rest.scratchDir ?? join(dataDir, "scratch", "test");
	const access = workspace.call({
		sessionId,
		cwd: rest.cwd,
		scratchDir,
		...(scratchDirs ? { scratchDirs } : {}),
		...(projectRoots ? { projectRoots } : {}),
		...(allowedPaths ? { allowedPaths } : {}),
		signal: rest.signal ?? new AbortController().signal,
		// 不给 shell 时本体按这台机器的默认 shell 拆命令。
		shell: async () => rest.shell as ShellInfo,
		...(ask ? { ask } : {}),
		alive: () => {},
	});
	const out = {
		...rest,
		sessionId,
		resources: workspace.resources,
		files: access.files,
		projectFiles: (root: string) => workspace.workspace.files(root),
		recorded: () => access.recorded(),
		changes: workspace.changes,
		nextCall: () => callOn(workspace, { ...input, exec: raw }),
	} as TestContext;
	let raw: ToolContext["exec"], wrapped: ToolContext["exec"];
	Object.defineProperty(out, "exec", {
		enumerable: true,
		get: () => wrapped,
		set: (next: ToolContext["exec"]) => {
			raw = next;
			wrapped = next ? access.exec(next) : undefined;
		},
	});
	out.exec = exec;
	return out;
}
