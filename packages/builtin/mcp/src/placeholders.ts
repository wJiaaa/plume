/**
 * 配置里的 `${NAME}` 空位：命令、参数、环境变量的值、地址、请求头里都可以写（典型的是 `Authorization: Bearer ${TOKEN}`），
 * 连接时填上。值先从这台服务自己的 `env` 拿（人在设置页填的），再从登录 shell 的环境拿；都没有就不启动，
 * 状态是「还缺什么」，设置页让人填。这样配置文件本身可以不写密钥。
 */

import type { ServerConfig } from "./config.ts";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 整个值就是一个空位（`GITHUB_TOKEN: "${GITHUB_TOKEN}"`）：它本身不算填了值。 */
export function isPlaceholder(value: string): boolean {
	return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

function placeholdersOf(server: ServerConfig): string[] {
	const texts =
		server.transport === "stdio"
			? [server.command, ...(server.args ?? []), ...Object.values(server.env ?? {})]
			: [server.url, ...Object.values(server.headers ?? {})];
	const found: string[] = [];
	for (const text of texts) for (const match of text.matchAll(PLACEHOLDER)) if (match[1] && !found.includes(match[1])) found.push(match[1]);
	return found;
}

function valueFor(server: ServerConfig, name: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const own = server.env?.[name];
	if (own !== undefined && own !== "" && !isPlaceholder(own)) return own;
	const inherited = environment[name];
	return inherited !== undefined && inherited !== "" ? inherited : undefined;
}

/** 还没有值的空位。 */
export function missingFor(server: ServerConfig, environment: Readonly<Record<string, string | undefined>>): string[] {
	return placeholdersOf(server).filter((name) => valueFor(server, name, environment) === undefined);
}

/** 填好空位的配置，用来真正连接；先用 `missingFor` 确认都有值。http 的 `env` 只是取值处，不随请求发出，填完就去掉。 */
export function resolveServer(server: ServerConfig, environment: Readonly<Record<string, string | undefined>>): ServerConfig {
	const fill = (text: string) => text.replace(PLACEHOLDER, (_whole, name: string) => valueFor(server, name, environment) ?? "");
	if (server.transport === "stdio") {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(server.env ?? {})) env[key] = fill(value);
		return { ...server, command: fill(server.command), args: (server.args ?? []).map(fill), env };
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(server.headers ?? {})) headers[key] = fill(value);
	const { env: _values, ...rest } = server;
	return { ...rest, url: fill(server.url), headers };
}
