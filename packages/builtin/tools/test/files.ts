/**
 * 测试里直接调工具时的 `ToolRun.files`、`ctx.workspace.files`、`ctx.resources`（代替宿主给的）：就是本体 `run-files.ts` 的实现，
 * 不经插件宿主。读边界的判定、卡片和拒绝的说法由本体定，在 `packages/core/workspace/test/`、`packages/core/agent/test/run-files.test.ts` 里测。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginResources, ResourceHandler, ShellInfo } from "@plume/contract";
import { Workspace } from "../../../core/agent/src/run-files.ts";
import type { ToolContext } from "../src/tools/types.ts";

/** 没给 `dataDir` 时本体用的数据目录：隔离视图建在它下面，不能落到真实的 ~/.plume。 */
const DATA_DIR = join(tmpdir(), "plume-tools-test-data");

type Input = Omit<ToolContext, "files" | "projectFiles" | "resources"> &
	Partial<Pick<ToolContext, "files" | "projectFiles" | "resources">> & {
		/** 这一轮人拖进来的文件（`ToolRun.allowedPaths`）。 */
		allowedPaths?: readonly string[];
		/** 同一个项目的其他源码目录（`ToolRun.projectRoots`）。 */
		projectRoots?: readonly string[];
		/** 别的插件登记的 scheme（技能插件的 `skill://` 那种）。 */
		handlers?: readonly ResourceHandler[];
	};

/**
 * 补上本体给的那几样。问人用 `requestApproval`（宿主上两者是同一个过闸），不给就是没人可问。
 * 换了 `requestApproval`、`cwd` 之类时重新调一次：已有的 `files` 不算数，按这次给的重造。
 */
export function withFiles(ctx: Input): ToolContext & { resources: PluginResources } {
	const { allowedPaths, projectRoots, handlers = [], files: _files, projectFiles: _projectFiles, resources: _resources, ...rest } = ctx;
	const workspace = new Workspace(rest.dataDir ?? DATA_DIR, { list: async () => [], messages: async () => [] }, () => []);
	for (const handler of handlers) workspace.resources.register(handler);
	const ask = rest.requestApproval;
	return {
		...rest,
		resources: workspace.resources,
		files: workspace.files({
			sessionId: rest.sessionId ?? "test",
			cwd: rest.cwd,
			scratchDir: rest.scratchDir ?? join(rest.dataDir ?? DATA_DIR, "scratch", "test"),
			...(projectRoots ? { projectRoots } : {}),
			...(allowedPaths ? { allowedPaths } : {}),
			signal: rest.signal ?? new AbortController().signal,
			// 不给 shell 时本体按这台机器的默认 shell 拆命令。
			shell: async () => rest.shell as ShellInfo,
			...(ask ? { ask } : {}),
			alive: () => {},
		}),
		projectFiles: (root) => workspace.workspace.files(root),
	};
}
