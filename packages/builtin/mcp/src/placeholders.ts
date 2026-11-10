/**
 * 配置里的 `${NAME}` 空位：命令、参数、环境变量的值、地址、请求头里都可以写（典型的是 `Authorization: Bearer ${TOKEN}`），
 * 连接时填上。值先从这台服务自己的 `env` 拿（人在设置页填的），再从登录 shell 的环境拿；都没有就不启动，
 * 状态是「还缺什么」，设置页让人填。这样配置文件本身可以不写密钥。
 *
 * `${NAME:-默认值}`（Claude 的 `.mcp.json` 同一种写法）是可选的：没有值时用默认值，不算缺。一个环境变量或请求头里的空位
 * 全都落空（值和默认值都是空的）时整条不发：可选的令牌没填，就不带 `Authorization: Bearer ` 这种半截的请求头，
 * 也不给进程一个空的环境变量。
 */

import type { ServerConfig } from "./config.ts";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** 整个值就是一个空位（`GITHUB_TOKEN: "${GITHUB_TOKEN}"`）：它本身不算填了值。 */
export function isPlaceholder(value: string): boolean {
	return /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(value.trim());
}

/** 值里带着空位：它是声明，不是填好的值。 */
export function hasPlaceholder(value: string): boolean {
	return new RegExp(PLACEHOLDER.source).test(value);
}

/** 配置里的一个空位；同名的出现几次都算一个，有一处不带默认值就是必填。 */
export interface Placeholder {
	name: string;
	optional: boolean;
}

export function placeholdersOf(server: ServerConfig): Placeholder[] {
	const texts =
		server.transport === "stdio"
			? [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})]
			: [server.url, ...Object.values(server.headers ?? {})];
	const found = new Map<string, boolean>();
	for (const text of texts)
		for (const match of text.matchAll(PLACEHOLDER)) {
			const name = match[1] as string;
			found.set(name, (found.get(name) ?? true) && match[2] !== undefined);
		}
	return [...found].map(([name, optional]) => ({ name, optional }));
}

function valueFor(server: ServerConfig, name: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const own = server.env?.[name];
	// stdio 的 `env` 既是声明也是取值处：值里还带着空位的（`MODE: "${MODE:-}x"`）是声明，不是人填的值。
	if (own !== undefined && own !== "" && !hasPlaceholder(own)) return own;
	const inherited = environment[name];
	return inherited !== undefined && inherited !== "" ? inherited : undefined;
}

/** 还没有值的空位。 */
export function missingFor(server: ServerConfig, environment: Readonly<Record<string, string | undefined>>): string[] {
	return placeholdersOf(server)
		.filter(({ name, optional }) => !optional && valueFor(server, name, environment) === undefined)
		.map(({ name }) => name);
}

/** 填好空位的配置，用来真正连接；先用 `missingFor` 确认都有值。http 的 `env` 只是取值处，不随请求发出，填完就去掉。 */
export function resolveServer(server: ServerConfig, environment: Readonly<Record<string, string | undefined>>): ServerConfig {
	const fill = (text: string) =>
		text.replace(PLACEHOLDER, (_whole, name: string, fallback: string | undefined) => valueFor(server, name, environment) ?? fallback ?? "");
	/** 环境变量、请求头：里面的空位全落空的整条不要。 */
	const entries = (vars: Record<string, string> | undefined) => {
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(vars ?? {})) {
			const slots = [...value.matchAll(PLACEHOLDER)];
			if (slots.length > 0 && slots.every((slot) => fill(slot[0]) === "")) continue;
			out[key] = fill(value);
		}
		return out;
	};
	if (server.transport === "stdio") return { ...server, command: fill(server.command), args: (server.args ?? []).map(fill), env: entries(server.env) };
	const headers = entries(server.headers);
	const { env: _values, ...rest } = server;
	return { ...rest, url: fill(server.url), headers };
}
