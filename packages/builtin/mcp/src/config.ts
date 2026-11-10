/**
 * MCP 服务的配置：存在插件数据目录的 `servers.json`，设置页经逻辑入口改它。
 *
 * 环境变量和请求头里常有密钥，所以界面只拿得到不像密钥的值；像密钥的只告诉它「填了」，改的时候不填就是留着原来的
 * （`VarDraft.value` 为 undefined）。密钥只在 agent 进程里用，写进文件时经服务 `secrets` 加密，
 * 读出来时解开（`sealed.ts`）。
 */

import { readFile, writeFile } from "node:fs/promises";
import { ENV_NAME, HEADER_NAME } from "./vars.ts";

interface ServerBase {
	id: string;
	/** 给人看的名字，也是工具名里的那一段：`mcp__<名字>__<工具>`。 */
	name: string;
	enabled: boolean;
	/** 人说过信任它对工具的只读声明：「帮我批准」下，它标了 `readOnlyHint` 的工具不再逐次确认。 */
	trustReadOnly?: boolean;
	/** 常驻：MCP 工具多到改成按需搜索时，这台的工具仍然每轮都放在工具表里。 */
	pinned?: boolean;
	/** 每个会话各起一份，不和别的会话共用连接：给把状态存在进程里的服务（浏览器、数据库会话）。 */
	perSession?: boolean;
	/** Magpie 资源库分发的：读自 `magpie/mcp.json`，不写进 `servers.json`，在 Plume 里只能看状态、重连、登录。 */
	managedBy?: "magpie";
}

interface StdioServer extends ServerBase {
	transport: "stdio";
	command: string;
	args?: string[];
	/** 启动时额外的环境变量，盖在登录 shell 的环境上面；也是 `${NAME}` 空位的取值处。 */
	env?: Record<string, string>;
}

export interface HttpServer extends ServerBase {
	transport: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
	/** `${NAME}` 空位的取值处（人在设置页填的令牌）：不是进程环境，也不随请求发出，只用来填地址和请求头里的空位。 */
	env?: Record<string, string>;
}

export type ServerConfig = StdioServer | HttpServer;

/** 设置页交来的一个变量；`value` 不给是保留原来的值（像密钥的那些界面拿不到原值）。 */
export interface VarDraft {
	name: string;
	value?: string;
}

export interface ServerDraft {
	name: string;
	transport: ServerConfig["transport"];
	command?: string;
	args?: string[];
	url?: string;
	/** stdio 是环境变量，http、sse 是请求头。 */
	vars: VarDraft[];
	trustReadOnly?: boolean;
	pinned?: boolean;
	perSession?: boolean;
}

/** 三个开关：不影响连接，只影响工具怎么登记、怎么用。 */
const FLAGS = ["trustReadOnly", "pinned", "perSession"] as const;

function flagsOf(raw: Record<string, unknown>): Pick<ServerBase, (typeof FLAGS)[number]> {
	return Object.fromEntries(FLAGS.filter((flag) => raw[flag] === true).map((flag) => [flag, true]));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function strings(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 文件里的一条：手改坏了的跳过，不让一条坏的拖垮别的。 */
function readServer(raw: unknown): ServerConfig | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || !raw.name.trim()) return null;
	const base = { id: raw.id, name: raw.name, enabled: raw.enabled !== false, ...flagsOf(raw) };
	if (raw.transport === "stdio") {
		if (typeof raw.command !== "string" || !raw.command.trim()) return null;
		const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [];
		const env = strings(raw.env);
		return { ...base, transport: "stdio", command: raw.command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) };
	}
	if (raw.transport === "http" || raw.transport === "sse") {
		if (typeof raw.url !== "string" || !raw.url.trim()) return null;
		const headers = strings(raw.headers);
		const env = strings(raw.env);
		return { ...base, transport: raw.transport, url: raw.url, ...(headers ? { headers } : {}), ...(env ? { env } : {}) };
	}
	return null;
}

export async function readServers(file: string): Promise<{ servers: ServerConfig[]; error?: string }> {
	const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
	if (raw === null) return { servers: [] };
	try {
		const parsed = JSON.parse(raw) as { servers?: unknown };
		const list = Array.isArray(parsed.servers) ? parsed.servers : [];
		return { servers: list.map(readServer).filter((server): server is ServerConfig => server !== null) };
	} catch (error) {
		// i18n-exempt：解析器的原话，界面另配标题。
		return { servers: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Magpie 资源库分发的服务：`<Plume 数据目录>/magpie/mcp.json`，Claude 格式的 `mcpServers` 对象，由 Magpie 写、撤回时删。
 * 每次和 `servers.json` 一起现读，不抄进 `servers.json`，所以撤回后不留副本。id 是 `magpie__<名字>`；
 * 名字在工具名里，和已有的服务重名（不分大小写）的跳过，保留人自己加的那台。坏条目跳过、留一句诊断，
 * 不把认不出的传输方式猜成 HTTP；整份读不懂时只说文件坏了，不转述解析器的话：原文里可能有令牌。
 * 文件在却读不了、读不懂时返回 null（没有文件是 []）：调用方据此不把这时缺席的服务当成已撤回。
 */
export async function readMagpieServers(file: string, own: readonly ServerConfig[], log: { warn(message: string): void }): Promise<ServerConfig[] | null> {
	let unreadable = false;
	const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") {
			unreadable = true;
			log.warn(`无法读取 ${file}`);
		}
		return null;
	});
	if (raw === null) return unreadable ? null : [];
	let entries: [string, unknown][];
	try {
		const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) throw new Error("invalid");
		entries = Object.entries(parsed.mcpServers ?? {});
	} catch {
		log.warn(`${file} 不是有效的 MCP 配置，只用 Plume 自己的服务`);
		return null;
	}
	const out: ServerConfig[] = [];
	for (const [name, config] of entries) {
		const server = isRecord(config) && name.trim() ? magpieServer(name, config) : null;
		if (!server) {
			log.warn(`Magpie 的 MCP 条目 ${name} 格式无效，已跳过`);
			continue;
		}
		const taken = [...own, ...out].some((other) => other.id === server.id || other.name.trim().toLowerCase() === name.trim().toLowerCase());
		if (taken) {
			log.warn(`Magpie 的 MCP 条目 ${name} 和已有的服务重名，保留已有的`);
			continue;
		}
		out.push(server);
	}
	return out;
}

/** Claude 格式的一条：有 `command`（或 `type: "stdio"`）是本地进程，否则要有 `url`，`type` 只认 http、sse。 */
function magpieServer(name: string, config: Record<string, unknown>): ServerConfig | null {
	const { type, command, args, url, disabled } = config;
	if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") return null;
	if (disabled !== undefined && typeof disabled !== "boolean") return null;
	const allStrings = (value: unknown) => value === undefined || (isRecord(value) && Object.values(value).every((item) => typeof item === "string"));
	if (!allStrings(config.env) || !allStrings(config.headers)) return null;
	if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) return null;
	const base = { id: `magpie__${name}`, name, enabled: disabled !== true, managedBy: "magpie" as const };
	const env = strings(config.env);
	if (type === "stdio" || (type === undefined && command !== undefined)) {
		if (typeof command !== "string" || !command.trim()) return null;
		const list = (args as string[] | undefined) ?? [];
		return { ...base, transport: "stdio", command, ...(list.length > 0 ? { args: list } : {}), ...(env ? { env } : {}) };
	}
	if (command !== undefined || typeof url !== "string" || !url.trim()) return null;
	const headers = strings(config.headers);
	return { ...base, transport: type === "sse" ? "sse" : "http", url, ...(headers ? { headers } : {}) };
}

export async function writeServers(file: string, servers: readonly ServerConfig[]): Promise<void> {
	await writeFile(file, `${JSON.stringify({ servers }, null, "\t")}\n`, { mode: 0o600 });
}

/** 按草稿生成新的配置；`previous` 是在编辑的那一条，没改的密钥从它那里拿。 */
export function applyDraft(draft: ServerDraft, id: string, previous: ServerConfig | undefined): ServerConfig {
	// 换了种类（本地进程和远程互换）时旧的变量不算数：环境变量和请求头不是一回事。
	const sameKind = previous !== undefined && (previous.transport === "stdio") === (draft.transport === "stdio");
	const old = sameKind ? ((previous.transport === "stdio" ? previous.env : previous.headers) ?? {}) : {};
	const vars: Record<string, string> = {};
	for (const item of draft.vars) vars[item.name] = item.value ?? old[item.name] ?? "";
	const base = { id, name: draft.name.trim(), enabled: previous?.enabled ?? true, ...flagsOf({ ...draft }) };
	const filled = Object.keys(vars).length > 0;
	if (draft.transport === "stdio") {
		const args = (draft.args ?? []).filter(Boolean);
		return { ...base, transport: "stdio", command: (draft.command ?? "").trim(), ...(args.length > 0 ? { args } : {}), ...(filled ? { env: vars } : {}) };
	}
	// 远程服务填过的空位值跟着留下：改地址、改请求头不该让人把令牌再填一遍。
	const values = sameKind && previous.transport !== "stdio" ? previous.env : undefined;
	return { ...base, transport: draft.transport, url: (draft.url ?? "").trim(), ...(filled ? { headers: vars } : {}), ...(values ? { env: values } : {}) };
}

/** 设置页交来的草稿：渲染进程传来的东西，逐个字段核对。不对时返回给人看的原因键。 */
export function checkDraft(raw: unknown): ServerDraft | "invalid" | "badName" | "badCommand" | "badUrl" | "badVar" {
	if (!isRecord(raw) || typeof raw.name !== "string") return "invalid";
	if (!raw.name.trim()) return "badName";
	const transport = raw.transport;
	if (transport !== "stdio" && transport !== "http" && transport !== "sse") return "invalid";
	const vars: VarDraft[] = [];
	for (const item of Array.isArray(raw.vars) ? raw.vars : []) {
		if (!isRecord(item) || typeof item.name !== "string") return "invalid";
		if (!(transport === "stdio" ? ENV_NAME : HEADER_NAME).test(item.name)) return "badVar";
		if (item.value !== undefined && typeof item.value !== "string") return "invalid";
		vars.push({ name: item.name, ...(typeof item.value === "string" ? { value: item.value } : {}) });
	}
	const trust = flagsOf(raw);
	if (transport === "stdio") {
		if (typeof raw.command !== "string" || !raw.command.trim()) return "badCommand";
		const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [];
		return { name: raw.name, transport, command: raw.command, args, vars, ...trust };
	}
	if (typeof raw.url !== "string" || !/^https?:\/\/\S+$/.test(raw.url.trim())) return "badUrl";
	return { name: raw.name, transport, url: raw.url, vars, ...trust };
}

/** 启动方式：变了才要重连。名字、三个开关这类不影响连接的，只要重新登记工具。 */
export function launchKey(server: ServerConfig): string {
	return server.transport === "stdio"
		? JSON.stringify([server.transport, server.command, server.args ?? [], server.env ?? {}])
		: JSON.stringify([server.transport, server.url, server.headers ?? {}, server.env ?? {}]);
}

/** 把人填的空位值记进 `env`；空的是清掉。 */
export function withValues(server: ServerConfig, values: readonly { name: string; value: string }[]): ServerConfig {
	const env = { ...server.env };
	for (const { name, value } of values) {
		if (value) env[name] = value;
		else delete env[name];
	}
	const { env: _old, ...rest } = server;
	return Object.keys(env).length > 0 ? ({ ...rest, env } as ServerConfig) : (rest as ServerConfig);
}
