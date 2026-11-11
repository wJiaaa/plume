/**
 * 子智能体的定义从哪来、怎么改：内置的几种（`agents.ts`），加上个人的 `~/.plume/agents/*.md` 和项目的 `<项目>/.plume/agents/*.md`。
 * 同名时项目的赢个人的、个人的赢内置的：写一份同名的就是改掉内置的那一种，删掉它内置的原样回来。
 *
 * 文件是开头一段元数据（`name`、`description`、`tools`、`model`、`avatar`、`output`、`schemaMode`、`maxTurns`）加正文（换掉身份那一段的指令）。
 * 设置页改的时候只改表单管的那几行，别的键、注释原样留着：人手写进去的东西不该因为在界面里改了一句用途就没了。
 *
 * 每次改都带着读到时的修订号（内容的哈希）：编辑器开着的时候人在外面改了文件，存的时候报出来，而不是盖掉。
 */

import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BUILTIN_AGENTS, type AgentDefinition } from "./agents.ts";
import type { Messages } from "./messages.ts";
import type { JsonSchema } from "./yield.ts";

type AgentScope = "builtin" | "user" | "project";

/** 名单里的一种：最终生效的那份定义，和它从哪来。 */
export interface AgentRecord {
	/** 文件路径的哈希，内置的按名字算；路径不出逻辑入口。 */
	id: string;
	scope: AgentScope;
	definition: AgentDefinition;
	/** 盖住了同名的内置定义。 */
	customized: boolean;
	/** 读到时内容的哈希，改和删都要带着它。 */
	revision: string;
}

/** 设置页编辑器里那几格。 */
export interface AgentDraft {
	name: string;
	description: string;
	prompt: string;
	tools: string[] | "*";
	/** `形状-颜色`；不给就不动文件里原有的那一行。 */
	avatar?: string;
}

export interface AgentSave {
	/** 改哪一份；新建、复制时不给。 */
	id?: string;
	/** 从哪一份复制。 */
	copyFrom?: string;
	revision?: string;
	scope: "user" | "project";
	draft: AgentDraft;
}

interface Located {
	record: AgentRecord;
	/** 内置的没有文件。 */
	path?: string;
	raw: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** 只认形状，不认名单：名单归界面，这里只挡掉写不进一行、或者明显不是这个意思的东西。 */
const AVATAR = /^[a-z]{2,16}-[a-z]{2,16}$/;
const MAX_PROMPT = 200_000;
const MAX_DESCRIPTION = 2000;

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Windows 上别的进程开着目标文件时 rename 的回答。 */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `rename`，在 Windows 上等别的进程放开目标文件：杀毒、索引程序刚看到文件写出时会开着它一会儿，这时 rename 报
 * EPERM、EBUSY、EACCES。只在那边等：macOS、Linux 上同样的码是权限问题，等也不会变。一共试 8 次，每次多等 20ms，
 * 合计半秒多，够小文件被放开。
 */
async function renameWithRetry(from: string, to: string, attempts = 8, stepMs = 20): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as { code?: string } | null)?.code ?? "";
			if (attempt >= attempts || process.platform !== "win32" || !HELD_OPEN.has(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, stepMs * attempt));
		}
	}
}
const within = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export class AgentDefinitions {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly home: string;
	private readonly text: () => Messages;
	private readonly trash: (path: string) => Promise<void>;

	/**
	 * `home` 是 Plume 自己的目录（`ctx.appDataDir`）；`text` 给出当前语言的文案，报错是给人看的；
	 * `trash` 把文件移到系统的废纸篓（回收站），插件里是 `ctx.trash`。
	 */
	constructor(home: string, text: () => Messages, trash: (path: string) => Promise<void>) {
		this.home = home;
		this.text = text;
		this.trash = trash;
	}

	private directory(scope: "user" | "project", cwd: string | null): string {
		if (scope !== "user" && scope !== "project") throw new Error(this.text().defScope);
		if (scope === "project" && !cwd) throw new Error(this.text().defNeedProject);
		return scope === "user" ? join(this.home, "agents") : join(cwd ?? "", ".plume", "agents");
	}

	/** 这个目录下生效的名单，按名字排好；`cwd` 为空时只有内置和个人的。 */
	async list(cwd: string | null): Promise<AgentRecord[]> {
		return (await this.located(cwd)).map(({ record }) => record);
	}

	private async located(cwd: string | null): Promise<Located[]> {
		const winners = new Map<string, Located>();
		for (const agent of BUILTIN_AGENTS) {
			const raw = JSON.stringify(agent);
			winners.set(agent.name, {
				record: { id: hash(`builtin:${agent.name}`), scope: "builtin", definition: agent, customized: false, revision: hash(raw) },
				raw: "",
			});
		}
		const layers: ["user" | "project", string][] = [["user", this.directory("user", null)]];
		if (cwd) layers.push(["project", this.directory("project", cwd)]);
		for (const [scope, dir] of layers) {
			// 同一层里同名的两份，排在前面的文件赢；后面那份多半是复制出来忘了改名的。
			const seen = new Set<string>();
			for (const path of await markdownFiles(dir)) {
				const raw = await readFile(path, "utf8").catch(() => null);
				if (raw === null) continue;
				const definition = parseAgent(raw, path, scope === "project" ? "workspace" : "user");
				if (!definition || seen.has(definition.name)) continue;
				seen.add(definition.name);
				winners.set(definition.name, {
					record: { id: hash(path), scope, definition, customized: BUILTIN_AGENTS.some((agent) => agent.name === definition.name), revision: hash(raw) },
					path,
					raw,
				});
			}
		}
		return [...winners.values()].sort((a, b) => a.record.definition.name.localeCompare(b.record.definition.name));
	}

	async read(cwd: string | null, id: string): Promise<AgentRecord> {
		const found = (await this.located(cwd)).find(({ record }) => record.id === id);
		if (!found) throw new Error(this.text().defChanged);
		return found.record;
	}

	/** 一次只改一份：两次保存挨得近时第二次读到的是第一次写完以后的。 */
	private serialize<T>(action: () => Promise<T>): Promise<T> {
		const pending = this.tail.then(action, action);
		this.tail = pending.then(
			() => undefined,
			() => undefined,
		);
		return pending;
	}

	/** 新建、复制或改一份。`tools` 是现在能挑的工具名。改内置的总是存成个人的一份。 */
	save(cwd: string | null, input: AgentSave, tools: readonly string[]): Promise<void> {
		return this.serialize(async () => {
			const text = this.text();
			if (!input || typeof input !== "object") throw new Error(text.defIncomplete);
			const located = await this.located(cwd);
			const current = input.id ? located.find(({ record }) => record.id === input.id) : undefined;
			const template = input.copyFrom ? located.find(({ record }) => record.id === input.copyFrom) : current;
			if (input.copyFrom && !template) throw new Error(text.defTemplateChanged);
			if (input.id && (!current || current.record.revision !== input.revision)) throw new Error(text.defModified);
			const allowed = template?.record.definition.tools;
			validateDraft(input.draft, [...tools, ...(Array.isArray(allowed) ? allowed : [])], current?.record.definition, text);
			if (!current && located.some(({ record }) => record.definition.name === input.draft.name)) throw new Error(text.defNameTaken);
			const builtin = current?.record.scope === "builtin";
			if (current && !builtin && input.scope !== current.record.scope) throw new Error(text.defCopyToMove);
			const scope = builtin ? "user" : ((current?.record.scope as "user" | "project" | undefined) ?? input.scope);
			const directory = this.directory(scope, cwd);
			// 原来那个文件，而不是 `<名字>.md`：手写的定义文件名不一定和名字一样。
			const original = current && !builtin ? current.path : undefined;
			const path = original ?? join(directory, `${input.draft.name}.md`);
			await this.guard(path, scope, cwd);
			const raw = renderAgent(input.draft, template?.raw || undefined, template?.record.scope === "builtin" ? template.record.definition : undefined, text);
			const temporary = join(directory, `.${randomUUID()}.tmp`);
			await writeFile(temporary, raw, { flag: "wx", mode: 0o600 });
			try {
				await this.guard(path, scope, cwd);
				if (original) {
					if (hash(await readFile(path, "utf8")) !== current?.record.revision) throw new Error(text.defModified);
					await renameWithRetry(temporary, path);
				} else await link(temporary, path);
			} finally {
				await unlink(temporary).catch((error: unknown) => {
					if (!missing(error)) throw error;
				});
			}
		});
	}

	/** 把一份定义的文件移到系统的废纸篓（回收站）：是人写的东西，删错了还能拿回来。内置的删不了。 */
	remove(cwd: string | null, id: string, revision: string): Promise<void> {
		return this.serialize(async () => {
			const text = this.text();
			const found = (await this.located(cwd)).find(({ record }) => record.id === id);
			if (!found?.path || found.record.scope === "builtin" || revision !== found.record.revision) throw new Error(text.defCannotRemove);
			const scope = found.record.scope;
			await this.guard(found.path, scope, cwd);
			if (hash(await readFile(found.path, "utf8")) !== revision) throw new Error(text.defModified);
			await this.trash(found.path);
		});
	}

	/** 路径就在那一层的目录里，一路上没有符号链接：不然写一个定义就能写到目录外面去。 */
	private async guard(path: string, scope: "user" | "project", cwd: string | null): Promise<void> {
		const text = this.text();
		const root = resolve(scope === "user" ? this.home : (cwd ?? ""));
		const directory = this.directory(scope, cwd);
		if (!within(directory, path) || dirname(path) !== directory) throw new Error(text.defOutside);
		// mkdir 之前先看每一层：一个符号链接就能让它把目录建到外面去。
		for (const item of scope === "user" ? [root, directory, path] : [root, join(root, ".plume"), directory, path]) {
			try {
				if ((await lstat(item)).isSymbolicLink()) throw new Error(text.defSymlink);
			} catch (error) {
				if (!missing(error)) throw error;
			}
		}
		await mkdir(directory, { recursive: true });
		if (!within(await realpath(root), await realpath(directory))) throw new Error(text.defOutside);
	}
}

async function markdownFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md" && !entry.name.startsWith("."))
		.map((entry) => join(dir, entry.name))
		.sort();
}

function validateDraft(value: AgentDraft, tools: readonly string[], existing: AgentDefinition | undefined, text: Messages): void {
	if (!value || typeof value.name !== "string" || typeof value.description !== "string" || typeof value.prompt !== "string")
		throw new Error(text.defIncomplete);
	if (existing ? value.name !== existing.name : !NAME.test(value.name)) throw new Error(text.defBadName);
	if (!value.description.trim() || !value.prompt.trim()) throw new Error(text.defNeedFields);
	if (value.prompt.length > MAX_PROMPT || value.description.length > MAX_DESCRIPTION) throw new Error(text.defTooLong);
	if (value.tools !== "*" && (!Array.isArray(value.tools) || value.tools.some((name) => typeof name !== "string"))) throw new Error(text.defBadTools);
	if (value.avatar !== undefined && (typeof value.avatar !== "string" || !AVATAR.test(value.avatar))) throw new Error(text.defBadAvatar);
	const previous = existing?.tools === "*" ? [] : (existing?.tools ?? []);
	if (value.tools !== "*" && value.tools.some((name) => !tools.includes(name) && !previous.includes(name))) throw new Error(text.defUnknownTool);
}

// ---- 文件格式 ----

type Value = string | string[];

/** 开头一段的一个顶层键：它那一行，加上跟在后面属于它的缩进行、`- ` 列表行。键为空的是注释、空行。 */
interface Entry {
	key: string;
	lines: string[];
}

/** 拆成开头一段和正文。没有开头一段时 `front` 为空；有 `---` 却没收尾时 `unclosed`，整个文件都当正文。 */
function split(raw: string): { front: string[] | null; body: string; unclosed?: true } {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return { front: null, body: text };
	const match = /\n---(?:\n|$)/.exec(text.slice(3));
	if (!match) return { front: null, body: text, unclosed: true };
	const end = 3 + match.index;
	return {
		front: text
			.slice(4, end)
			.split("\n")
			.filter((line, index, all) => !(index === all.length - 1 && line === "")),
		body: text.slice(end + match[0].length),
	};
}

function entries(front: readonly string[]): Entry[] {
	const result: Entry[] = [];
	for (const line of front) {
		const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1];
		const last = result.at(-1);
		if (key) result.push({ key, lines: [line] });
		else if (last?.key && (/^\s/.test(line) || line.startsWith("- ") || line === "-")) last.lines.push(line);
		else result.push({ key: "", lines: [line] });
	}
	return result;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	return value.replace(/\s+#.*$/, "").trim();
}

/** 一个键的值：标量（带不带引号、`|` `>` 块）或字符串列表（`[a, b]` 或一行一个 `- a`）。别的写法读不出时为空。 */
function valueOf(entry: Entry): Value | undefined {
	const [first = "", ...rest] = entry.lines;
	const inline = first.slice(first.indexOf(":") + 1).trim();
	if (inline.startsWith("[")) {
		const inner = inline
			.replace(/\s+#.*$/, "")
			.replace(/^\[/, "")
			.replace(/\]$/, "");
		return inner
			.split(",")
			.map((part) => unquote(part.trim()))
			.filter((part) => part !== "");
	}
	if (inline === "" && rest.some((line) => /^\s*-(\s|$)/.test(line))) {
		return rest.flatMap((line) => {
			const item = /^\s*-\s*(.*)$/.exec(line)?.[1];
			return item === undefined ? [] : [unquote(item.trim())].filter((part) => part !== "");
		});
	}
	if (/^[|>][+-]?$/.test(inline)) {
		const indent = Math.min(...rest.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
		const lines = rest.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
		return (inline.startsWith("|") ? lines.join("\n") : lines.join(" ").replace(/\s+/g, " ")).trim();
	}
	// 跨行的普通标量：接上的几行用空格连起来。
	const continued = rest.map((line) => line.trim()).filter(Boolean);
	return unquote([inline, ...continued].join(" ").trim());
}

/**
 * `output` 是嵌套的一整份结构，上面那几样写法装不下，只有它交给 YAML 解析器；读不出对象的当没写，免得一处笔误让这一种
 * 交不了差。
 */
function schemaOf(entry: Entry | undefined): JsonSchema | undefined {
	if (!entry) return undefined;
	try {
		const value: unknown = (parseYaml(entry.lines.join("\n")) as Record<string, unknown> | null)?.[entry.key];
		return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 读一个定义文件；读不出名字时为空。没写 `tools` 的是全部工具。`schema-mode` 和 `schemaMode`、`max-turns` 和 `maxTurns` 各是同一个键，
 * 两个都写时前者赢。`maxTurns` 不是正整数的当没写：写错一个数不该让它每一步都停下来。
 */
export function parseAgent(raw: string, path: string, source: AgentDefinition["source"]): AgentDefinition | undefined {
	const { front, body } = split(raw);
	const values = new Map<string, Value | undefined>();
	const list = entries(front ?? []);
	for (const entry of list) if (entry.key) values.set(entry.key, valueOf(entry));
	const string = (key: string) => {
		const value = values.get(key);
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};
	const name = string("name") ?? basename(path, extname(path));
	if (!name) return undefined;
	const tools = values.get("tools");
	const model = string("model");
	const avatar = string("avatar");
	const output = schemaOf(list.find((entry) => entry.key === "output"));
	const mode = string("schema-mode") ?? string("schemaMode");
	const turns = string("max-turns") ?? string("maxTurns");
	return {
		name,
		description: string("description") ?? name,
		prompt: body.trim(),
		tools: Array.isArray(tools) ? tools : "*",
		...(model ? { model } : {}),
		...(avatar ? { avatar } : {}),
		...(output ? { output } : {}),
		...(mode === "strict" || mode === "permissive" ? { schemaMode: mode } : {}),
		...(turns && /^[1-9]\d*$/.test(turns) ? { maxTurns: Number(turns) } : {}),
		source,
	};
}

/** 能不加引号写的：不以 YAML 的记号开头、不含冒号和 `#`、首尾没有空白，也不会被读成布尔、数字或空值。 */
function scalar(value: string): string {
	const plain =
		value !== "" &&
		value === value.trim() &&
		!value.includes("\n") &&
		/^[^-?:,[\]{}#&*!|>\x27\x22%@\x60]/.test(value) &&
		!/[:#]/.test(value) &&
		!/^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*)?\.?\d+(?:e[-+]?\d+)?)$/i.test(value);
	return plain ? value : JSON.stringify(value);
}

function toolsText(tools: string[] | "*"): string {
	const quoted = (tool: string) => (/^[A-Za-z0-9_.-]+$/.test(tool) ? tool : JSON.stringify(tool));
	return tools === "*" ? JSON.stringify("*") : `[${tools.map(quoted).join(", ")}]`;
}

/**
 * 写出一份定义：从原文件（或复制的那份）的开头一段改起，只换表单管的几个键，别的原样留着。
 * 从内置的复制、改内置的时，内置那份的模型、脸和输出结构跟着走：改一下指令，不该顺手把它变成另一个人，也不该让它
 * 从此交不回原来那种对象。
 */
export function renderAgent(draft: AgentDraft, raw: string | undefined, builtin: AgentDefinition | undefined, text: Messages): string {
	const parts = raw ? split(raw) : { front: [] as string[], body: "" };
	if (raw && !parts.front) throw new Error(text.defBadFront);
	const list = entries(parts.front ?? []);
	/** 换掉一个键：给的是一行的值，或者（嵌套的结构）已经写好的几行。 */
	const set = (key: string, value: string | string[]) => {
		const lines = typeof value === "string" ? [`${key}: ${value}`] : value;
		const at = list.findIndex((entry) => entry.key === key);
		if (at >= 0) list[at] = { key, lines };
		else list.push({ key, lines });
	};
	if (builtin?.model) set("model", scalar(builtin.model));
	if (builtin?.output) set("output", stringifyYaml({ output: builtin.output }).trimEnd().split("\n"));
	if (builtin?.schemaMode) set("schemaMode", scalar(builtin.schemaMode));
	if (builtin?.avatar) set("avatar", scalar(builtin.avatar));
	set("name", scalar(draft.name));
	set("description", scalar(draft.description));
	set("tools", toolsText(draft.tools));
	if (draft.avatar) set("avatar", scalar(draft.avatar));
	return `---\n${list.flatMap((entry) => entry.lines).join("\n")}\n---\n${draft.prompt}\n`;
}
