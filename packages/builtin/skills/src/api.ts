/**
 * 逻辑入口经 `ctx.serve` 开给「插件市场 › 技能」的接口，两个入口共用。
 *
 * 每个方法最后都带 `cwd`：界面上选的项目目录，null 是只看个人的。项目里的技能只在选了那个项目时读得到，
 * 认路径（开关、打开、删除……）也按同一份列表认，界面传来的路径不能指到列表外面去。
 */

import type { ChangeHunk } from "@plume/contract";
import type { SkillDiagnostic } from "./loader.ts";

export interface SkillRow {
	name: string;
	description: string;
	path: string;
	/** 从哪个目录读来的，界面按它分组。 */
	root: string;
	/** 项目里的（`.plume/skills`、`.claude/skills`、`.agents/skills`）。 */
	project?: true;
	/** 别的插件带来的：那个插件给人看的名字。它随插件装卸，界面不给删。 */
	plugin?: string;
	manualOnly: boolean;
	enabled: boolean;
}

export interface SkillsView {
	/** 选中项目的技能（选了时）、个人的技能（`~/.plume/skills` 和 `~/.agents/skills` 里的）和别的插件带来的，项目的在前。 */
	skills: SkillRow[];
	diagnostics: SkillDiagnostic[];
	/** 个人技能目录（`~/.plume/skills`），「打开个人技能目录」开的是它。 */
	dir: string;
}

export interface SkillsApi {
	list(cwd: string | null): Promise<SkillsView>;
	/** 开、关一批已经读到的技能（一组一起拨时一次写完）。关掉的不进技能目录、`skill` 工具和 `/` 菜单。 */
	setEnabled(paths: string[], enabled: boolean, cwd: string | null): Promise<void>;
	/** 用系统默认的编辑器打开一个已经读到的 `SKILL.md`。 */
	open(path: string, cwd: string | null): Promise<void>;
	/** 在访达里打开个人技能目录，没有就先建。 */
	reveal(): Promise<void>;
	/** 把一个已经读到的技能的整个目录移到废纸篓。插件带来的不删，报错。 */
	remove(path: string, cwd: string | null): Promise<void>;
	/** 两个同名技能的 `SKILL.md` 差在哪：赢的在前，「+」是改用输的那个会多出来的。 */
	diff(winner: string, loser: string, cwd: string | null): Promise<{ hunks: ChangeHunk[]; added: number; removed: number }>;
	/** 同名时让 `path` 这个赢；返回偏好写在了哪个文件里，人以后找得到、改得回来。 */
	prefer(name: string, path: string, cwd: string | null): Promise<{ wroteTo: string }>;
}
