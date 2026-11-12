/**
 * plume.commands 的逻辑入口，跑在 agent 进程：把磁盘上的 Markdown 命令供给输入框的 `/` 菜单，发送前展开成要发的话；
 * 设置页经 `ctx.serve` 列个人或某个项目的命令、新建、打开、删除。
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Plugin, SlashCommand } from "@plume/contract";
import type { CommandRow, CommandsApi, CommandsView } from "./api.ts";
import { expandTemplate } from "./expand.ts";
import { commandSources, type DiskCommand, loadCommands, personalDir, projectDir } from "./loader.ts";
import { MESSAGES } from "./messages.ts";

/** 打开命令管理的那条命令，和设置里那一节的 id（界面入口的 `settingsSection`）。 */
const MANAGE = "commands";
const SETTINGS_SECTION = "commands";

/** 新建时的名字：只能是一段，命名空间靠子目录。 */
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 用系统的默认程序打开，目录在文件管理器里打开。Windows 上交给 explorer，不经 cmd 的 `start`：文件名里的 `&` 会被它当成
 * 命令分隔符。explorer 打开成功也报退出码 1，所以那边只看起没起得来。
 */
function openWith(path: string): Promise<void> {
	const [command, args] = process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["explorer.exe", [path]] : ["xdg-open", [path]];
	return new Promise((resolve, reject) =>
		execFile(command as string, args as string[], (error) =>
			error && (process.platform !== "win32" || typeof error.code !== "number") ? reject(error) : resolve(),
		),
	);
}

export default {
	name: "plume.commands",
	apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
		const sourceOf = (command: DiskCommand) => {
			const messages = text();
			if (command.origin === "claude") return command.scope === "workspace" ? messages.claudeProject : messages.claudePersonal;
			return command.scope === "workspace" ? messages.project : messages.personal;
		};

		ctx.commands.provide({
			/*
			 * `/commands` 排在最前：同名的命令文件被它遮住（宿主按名字去重，先列的赢），和别的内置命令一样，名字是这条命令的。
			 */
			async list({ cwd }) {
				const { commands } = await loadCommands(commandSources(ctx.appDataDir, cwd));
				return [
					{ name: MANAGE, description: text().manageCommand },
					...commands.map((command): SlashCommand => ({
						name: command.name,
						description: command.description,
						source: sourceOf(command),
						...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
					})),
				];
			},
			// 不另给 displayText：气泡里画的就是发给模型的全文，对话里看得到模型实际收到了什么。
			// `followUp` 不用带过去：会话正忙时输入框本来就把话排到这一轮后面。
			async expand(name, rest, { cwd }) {
				// 打开设置里的命令管理，不发消息；带了话不吞掉，留在输入框里。
				if (name === MANAGE) {
					if (rest) throw new Error(text().manageNoArgs);
					return { handled: true, openSettings: SETTINGS_SECTION };
				}
				const command = (await loadCommands(commandSources(ctx.appDataDir, cwd))).commands.find((candidate) => candidate.name === name);
				if (!command) throw new Error(text().readFailed(`/${name}`));
				return { text: expandTemplate(command.content, rest), ...(command.deliver === "steer" ? { deliver: "steer" as const } : {}) };
			},
		});

		/**
		 * 设置页顶上选着的项目。界面传来的 `cwd` 只用来拼出那几个命令目录去读、去建，不是绝对路径就当没选项目。
		 */
		const projectOf = (cwd: unknown): string | undefined => (typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined);
		const listed = async (cwd: unknown): Promise<{ view: CommandsView; files: Set<string> }> => {
			const project = projectOf(cwd);
			const { commands, diagnostics } = await loadCommands(commandSources(ctx.appDataDir, project));
			const rows = commands.map((command): CommandRow => ({
				name: command.name,
				description: command.description,
				path: command.path,
				origin: command.origin,
				scope: command.scope,
				...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
			}));
			return {
				view: { commands: rows, diagnostics, dir: personalDir(ctx.appDataDir), ...(project ? { projectDir: projectDir(project) } : {}) },
				files: new Set([...commands.map((command) => command.path), ...diagnostics.map((item) => item.path)]),
			};
		};
		/** 只认读到过的文件：界面传来的路径不能指到别处去。 */
		const known = async (path: unknown, cwd: unknown) => {
			if (typeof path !== "string" || !(await listed(cwd)).files.has(path)) throw new Error(text().notALoadedCommand);
			return path;
		};
		/** 个人或项目的命令目录；要项目的却没选项目时报错。 */
		const dirOf = (scope: unknown, cwd: unknown): string => {
			if (scope !== "workspace") return personalDir(ctx.appDataDir);
			const project = projectOf(cwd);
			if (!project) throw new Error(text().scopeNeedsProject);
			return projectDir(project);
		};

		ctx.serve({
			list: async (cwd) => (await listed(cwd)).view,
			async create(name, scope, cwd) {
				const messages = text();
				if (typeof name !== "string" || !FILE_NAME.test(name)) throw new Error(messages.nameInvalid);
				const dir = dirOf(scope, cwd);
				await mkdir(dir, { recursive: true });
				const file = join(dir, `${name}.md`);
				try {
					await writeFile(file, messages.template(name), { flag: "wx" });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(messages.nameTaken(name), { cause: error });
					throw error;
				}
				await openWith(file);
				return file;
			},
			open: async (path, cwd) => openWith(await known(path, cwd)),
			async reveal(scope, cwd) {
				const dir = dirOf(scope, cwd);
				await mkdir(dir, { recursive: true });
				await openWith(dir);
			},
			async remove(path, cwd) {
				const file = await known(path, cwd);
				// 移到系统的废纸篓（回收站），不直接删：命令是人写的，删错了还能拿回来。
				await ctx.trash(file);
			},
		} satisfies CommandsApi);
	},
} satisfies Plugin;
