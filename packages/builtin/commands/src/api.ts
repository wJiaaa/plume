/** 逻辑入口经 `ctx.serve` 开给设置页的接口，两个入口共用。 */

import type { CommandDiagnostic, CommandOrigin, CommandScope } from "./loader.ts";

export interface CommandRow {
	name: string;
	description: string;
	argumentHint?: string;
	path: string;
	origin: CommandOrigin;
	/** `workspace` 是项目里的（`<项目>/.plume/commands`、`<项目>/.claude/commands`），`user` 是个人的。 */
	scope: CommandScope;
}

export interface CommandsView {
	/** 个人的命令，看着某个项目时连项目的一起：同名时谁盖了谁要四个目录一起排才说得清。 */
	commands: CommandRow[];
	diagnostics: CommandDiagnostic[];
	/** 个人命令目录，新建个人命令放在这里。 */
	dir: string;
	/** 看着某个项目时，项目命令目录（`<项目>/.plume/commands`）。 */
	projectDir?: string;
}

export interface CommandsApi {
	/** `cwd` 是设置页顶上选着的项目，null 是只看个人的。 */
	list(cwd: string | null): Promise<CommandsView>;
	/**
	 * 在个人目录或项目目录里新建 `<name>.md`，写好模板；返回新文件的路径，界面经 `ui.openPath` 用编辑器打开。名字不合规矩、
	 * 已经有了、选了项目却没给项目时报错（给人看的话）。
	 */
	create(name: string, scope: CommandScope, cwd: string | null): Promise<string>;
	/** 个人或项目的命令目录，界面经 `ui.openPath` 打开；没有就先建。 */
	folder(scope: CommandScope, cwd: string | null): Promise<string>;
	/** 把一个已经读到的命令文件移到废纸篓。 */
	remove(path: string, cwd: string | null): Promise<void>;
}
