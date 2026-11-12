/**
 * 从磁盘读命令：一个命令就是一个 Markdown 文件，正文是要 Agent 做的事，开头可以有一段 frontmatter。
 *
 * 四个目录，同名时先出现的赢：项目的先于个人的（你所在的仓库比家目录更具体），Plume 的先于 Claude 的
 * （给 Plume 写的命令可以有意盖住别处的同名命令）。不缓存：每次打开菜单、每次发送都现读，改完文件马上生效。
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export type CommandScope = "workspace" | "user";
export type CommandOrigin = "plume" | "claude";

export interface DiskCommand {
	/** `git/commit.md` 叫 `git:commit`。 */
	name: string;
	description: string;
	/** 去掉 frontmatter 的正文。 */
	content: string;
	path: string;
	scope: CommandScope;
	origin: CommandOrigin;
	argumentHint?: string;
	/** 会话正忙时怎么送：`steer` 插进正在跑的这一轮，`followUp` 排到这一轮后面；不写（`prompt`）也是排在后面。 */
	deliver?: "steer" | "followUp";
}

/** 读的时候发现的问题，设置页里给人看。i18n-exempt：文件路径加一句说明，按界面语言在界面上另配标题。 */
export interface CommandDiagnostic {
	path: string;
	problem: "unclosed" | "badName" | "shadowed" | "unreadable" | "badDeliver";
	/** `badName` 是读到的名字，`shadowed` 是赢了的那个文件，`badDeliver` 是读到的投递方式。 */
	detail?: string;
}

export interface CommandSource {
	dir: string;
	scope: CommandScope;
	origin: CommandOrigin;
}

/** 名字：小写字母、数字、连字符，`:` 分段。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const MAX_DESCRIPTION = 200;
/** frontmatter `deliver` 认的值。`prompt` 是默认，写不写都一样。 */
const DELIVERIES = new Set(["prompt", "steer", "followUp"]);
/** 往下最多找三层子目录。 */
const MAX_DEPTH = 3;

function claudeHome(): string {
	return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** 个人命令目录：Plume 自己的数据目录（`ctx.appDataDir`）下的 `commands/`。 */
export function personalDir(appDataDir: string): string {
	return join(appDataDir, "commands");
}

/** 项目里新建的命令放在这里。只写 Plume 自己的目录，不往 `.claude` 里写。 */
export function projectDir(cwd: string): string {
	return join(cwd, ".plume", "commands");
}

export function commandSources(appDataDir: string, cwd: string | undefined): CommandSource[] {
	const sources: CommandSource[] = [];
	if (cwd) sources.push({ dir: projectDir(cwd), scope: "workspace", origin: "plume" });
	sources.push({ dir: personalDir(appDataDir), scope: "user", origin: "plume" });
	if (cwd) sources.push({ dir: join(cwd, ".claude", "commands"), scope: "workspace", origin: "claude" });
	sources.push({ dir: join(claudeHome(), "commands"), scope: "user", origin: "claude" });
	return sources;
}

export async function loadCommands(sources: CommandSource[]): Promise<{ commands: DiskCommand[]; diagnostics: CommandDiagnostic[] }> {
	const commands: DiskCommand[] = [];
	const diagnostics: CommandDiagnostic[] = [];
	/** 名字 → 赢了它的文件，被盖住的那条能说出是谁盖的。 */
	const seen = new Map<string, string>();
	for (const source of sources) {
		for (const file of await walk(source.dir, MAX_DEPTH)) {
			const raw = await readFile(file, "utf8").catch(() => null);
			if (raw === null) {
				diagnostics.push({ path: file, problem: "unreadable" });
				continue;
			}
			const parsed = parseFrontmatter(raw);
			if (parsed.unclosed) diagnostics.push({ path: file, problem: "unclosed" });
			const { body, frontmatter } = parsed;
			const name = frontmatter.name?.trim() || nameFrom(source.dir, file);
			if (!NAME_PATTERN.test(name)) {
				diagnostics.push({ path: file, problem: "badName", detail: name });
				continue;
			}
			// 说明不是必须的：命令是人自己挑的，缺一行说明不该让它用不成，正文第一行顶上。
			const described = frontmatter.description?.trim() || firstLine(body);
			const description = described.length > MAX_DESCRIPTION ? `${described.slice(0, MAX_DESCRIPTION - 1)}…` : described;
			const winner = seen.get(name);
			if (winner) {
				diagnostics.push({ path: file, problem: "shadowed", detail: winner });
				continue;
			}
			seen.set(name, file);
			// 两种写法都认，连字符的那种是文档里的写法、和 Claude Code 通用，两个都写时它说了算。
			const hint = (frontmatter["argument-hint"] ?? frontmatter.argumentHint)?.trim();
			/*
			 * 写错了的投递方式照样按默认发，但要在设置页里说出来：静默退回默认的话，一条写着 `deliver: steering` 的命令
			 * 永远插不进正在跑的那一轮，写的人却以为它会。
			 */
			const rawDeliver = (frontmatter.deliver ?? frontmatter.delivery)?.trim();
			if (rawDeliver && !DELIVERIES.has(rawDeliver)) diagnostics.push({ path: file, problem: "badDeliver", detail: rawDeliver });
			const deliver = rawDeliver === "steer" || rawDeliver === "followUp" ? rawDeliver : undefined;
			commands.push({
				name,
				description,
				content: body.trim(),
				path: file,
				scope: source.scope,
				origin: source.origin,
				...(hint ? { argumentHint: hint } : {}),
				...(deliver ? { deliver } : {}),
			});
		}
	}
	commands.sort((a, b) => a.name.localeCompare(b.name));
	return { commands, diagnostics };
}

/**
 * 读开头的 frontmatter。命令只用得到几个单行的键（`name`、`description`、`argument-hint`、`deliver`），所以只认顶层的
 * `键: 值`（值可以带引号，也可以是 `|`、`>` 开头的多行块）；列表、嵌套这些别的工具的键跳过不读。
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string; unclosed?: true } {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: text, unclosed: true };
	const lines = text.slice(4, end).split("\n");
	const frontmatter: Record<string, string> = {};
	for (let index = 0; index < lines.length; index++) {
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index] ?? "");
		if (!match?.[1]) continue;
		const value = (match[2] ?? "").trim();
		if (value === "|" || value === ">" || value === "|-" || value === ">-") {
			const block: string[] = [];
			while (index + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[index + 1] ?? "")) block.push((lines[++index] ?? "").trim());
			frontmatter[match[1]] = value.startsWith("|") ? block.join("\n").trim() : block.join(" ").replace(/\s+/g, " ").trim();
		} else frontmatter[match[1]] = unquote(value);
	}
	return {
		frontmatter,
		body: text
			.slice(end + 4)
			.replace(/^[^\n]*\n?/, "")
			.replace(/^\n+/, ""),
	};
}

function nameFrom(dir: string, file: string): string {
	return relative(dir, file).replace(/\.md$/i, "").split(sep).join(":").toLowerCase();
}

/** 正文里第一行有字的，去掉开头的标题记号。 */
function firstLine(body: string): string {
	for (const line of body.split("\n")) {
		const text = line.replace(/^#+\s*/, "").trim();
		if (text) return text;
	}
	return "";
}

/** 目录下的全部 `.md`，按路径排；目录不在就是空的。点开头的是编辑器留下的，不算。 */
async function walk(dir: string, depth: number): Promise<string[]> {
	if (depth <= 0) return [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return [];
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(path, depth - 1)));
		else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(path);
	}
	return files.sort();
}

// 放在文件最后：里面成对出现的引号字符会让文案检查的扫描错位，把后面的注释当成字符串。
function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	// 行尾井号后面的注释不是值的一部分。
	return value.replace(/\s+#.*$/, "");
}
