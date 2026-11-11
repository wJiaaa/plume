import type { CommandEntry } from "@plume/contract";

/**
 * 输入框里的 `/命令`：认出行首的命令、给菜单排序、按名字找命令、算光标处在不在补全。都是纯函数，不碰编辑器。
 *
 * 命令有两种：产品自己的动作（`/clear` 开新对话，不发给模型），和插件经 `ctx.commands` 供的——发送前交给那个插件
 * 展开成一段话再发。
 */

/** 产品自己做的那几件事。 */
type CommandAction = "clear";

/** `/` 菜单里的一行。 */
export interface MenuCommand {
	name: string;
	description: string;
	argumentHint?: string;
	/** 菜单最右边那一栏。 */
	source?: string;
	/** 产品自己的动作；没有的是插件供的，展开交给 `plugin`。 */
	action?: CommandAction;
	plugin?: string;
}

/** 一行字读出来的命令。 */
export interface Invocation {
	name: string;
	/** 名字后面的原文，去掉首尾空白。 */
	rest: string;
}

/**
 * 读出 `/name rest`；不是命令就是 null。只认整段字开头的斜杠：句子里的斜杠是路径、分数、正则，当成命令会和打字作对。
 */
export function parseInvocation(text: string): Invocation | null {
	const compact = /^@compact(?:\s+([\s\S]*))?$/i.exec(text);
	if (compact) return { name: "compact", rest: (compact[1] ?? "").trim() };
	if (!text.startsWith("/")) return null;
	const match = /^([a-z0-9:_-]+)(?:\s+([\s\S]*))?$/i.exec(text.slice(1));
	if (!match?.[1]) return null;
	return { name: match[1].toLowerCase(), rest: (match[2] ?? "").trim() };
}

/**
 * 按打了的字给命令排序：名字相等、名字开头、`:` 分出的某一段开头、名字里有、说明里有，依次靠后，同一档按名字排。
 * 说明里的词能找到叫不出名字的命令，但排在名字匹配的后面。什么都没打时原样返回。
 */
export function rankCommands<T extends { name: string; description: string }>(commands: T[], term: string): T[] {
	const needle = term.trim().toLowerCase();
	if (!needle) return commands;
	const scored: { command: T; rank: number }[] = [];
	for (const command of commands) {
		const name = command.name.toLowerCase();
		const rank =
			name === needle
				? 0
				: name.startsWith(needle)
					? 1
					: name.split(":").some((segment) => segment.startsWith(needle))
						? 2
						: name.includes(needle)
							? 3
							: command.description.toLowerCase().includes(needle)
								? 4
								: -1;
		if (rank >= 0) scored.push({ command, rank });
	}
	return scored.sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name)).map((entry) => entry.command);
}

/**
 * 按名字找命令：先找名字相等的，再找**唯一**一条末段相等的（`/commit` 找到 `git:commit`）。
 * 菜单里末段能匹配上，回车却找不到，读起来就是命令坏了；两条都对得上（`git:commit`、`svn:commit`）时不猜，原文照发。
 */
export function resolveCommand<T extends { name: string }>(commands: T[], name: string): T | undefined {
	const wanted = name.toLowerCase();
	const exact = commands.find((command) => command.name.toLowerCase() === wanted);
	if (exact) return exact;
	if (wanted.includes(":")) return undefined;
	const byTail = commands.filter((command) => {
		const segments = command.name.toLowerCase().split(":");
		return segments.length > 1 && segments.at(-1) === wanted;
	});
	return byTail.length === 1 ? byTail[0] : undefined;
}

/** 产品自己的命令：`/` 菜单和插件的 `ui.listCommands` 都从这里取，名单只有一份。 */
export function productCommands(t: (key: "command.clear") => string): MenuCommand[] {
	return [{ name: "clear", description: t("command.clear"), action: "clear" }];
}

/** 菜单的全部条目：产品自己的在前，插件的在后；同名的留前面那条。 */
export function menuCommands(builtins: MenuCommand[], provided: CommandEntry[]): MenuCommand[] {
	const seen = new Set<string>();
	return [...builtins, ...provided].filter((entry) => {
		const name = entry.name.toLowerCase();
		if (seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

export interface CommandDecoration {
	/** `/name` 那一段。 */
	start: number;
	end: number;
	/** 还没写参数时画在后面的灰字。 */
	hint?: string;
}

/** 只有认得出的行首命令才画成命令；句子里提到的 `/xxx` 是普通的字。 */
export function commandDecoration(text: string, entries: MenuCommand[]): CommandDecoration | undefined {
	const start = text.length - text.trimStart().length;
	const invocation = parseInvocation(text.trimStart());
	if (!invocation) return undefined;
	const entry = resolveCommand(entries, invocation.name);
	if (!entry) return undefined;
	return { start, end: start + invocation.name.length + 1, ...(!invocation.rest && entry.argumentHint ? { hint: entry.argumentHint } : {}) };
}

export interface CommandCompletion {
	/** `/` 后面已经打了的字。 */
	term: string;
	/** `/` 的位置。 */
	start: number;
	end: number;
}

/**
 * 光标处在不在补全命令：光标前是行首或空白后面的 `/xxx`，光标后是空白或字尾，没有选中一段。
 * 句中的 `/` 也弹菜单（选了的命令要挪到开头才算数），行内代码里的不弹：反引号是在写文档，不是在要补全。
 */
export function commandCompletion(text: string, start: number, end: number): CommandCompletion | null {
	if (start !== end || (start < text.length && !/\s/.test(text[start] ?? ""))) return null;
	const before = text.slice(0, start);
	const match = /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/.exec(before);
	if (!match) return null;
	if ((before.match(/`/g)?.length ?? 0) % 2) return null;
	const term = match[1] ?? "";
	return { term, start: start - term.length - 1, end };
}
