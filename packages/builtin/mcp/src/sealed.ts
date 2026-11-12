/**
 * `servers.json` 里的密钥：像密钥的变量值写盘前经 `ctx.secrets` 加密、留在原处，读出来时解开。
 * 手写进文件的明文照样能用，下次存配置时加密。插件带来的服务上人填的值（`plugins`）同样处理。
 */

import type { PluginSecrets } from "@plume/contract";
import type { PluginServerState, ServerConfig } from "./config.ts";
import { isPlaceholder } from "./placeholders.ts";
import { looksSecret } from "./vars.ts";

/** 一台服务里装着变量的几处（stdio 的环境变量，http、sse 的请求头和空位的取值处），每个值换一遍。 */
async function mapVars(server: ServerConfig, map: (name: string, value: string) => Promise<string>): Promise<ServerConfig> {
	const each = async (vars: Record<string, string> | undefined) =>
		vars && Object.fromEntries(await Promise.all(Object.entries(vars).map(async ([name, value]) => [name, await map(name, value)] as const)));
	const env = await each(server.env);
	if (server.transport === "stdio") return { ...server, ...(env ? { env } : {}) };
	const headers = await each(server.headers);
	return { ...server, ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
}

/**
 * 写盘前把像密钥的值加密。只是空位（`${TOKEN}`）的不加密：它不是密钥，留着给人看得懂。
 * 判断「像不像」和界面藏不藏原值是同一条规则，界面看得到的值文件里也是明文。
 */
const seal = (secrets: PluginSecrets) => async (name: string, value: string) =>
	looksSecret(name) && value !== "" && !isPlaceholder(value) && !secrets.isSealed(value) ? secrets.seal(value) : value;

/**
 * 读出来以后把密文解开，换回原值；解不开（钥匙换过）的当成没填，人在设置页重新填。
 * 钥匙文件读不出来时 `unseal` 抛错，这里不接：带着空值的配置一旦写回去，原来的密文就没了。
 */
const open = (secrets: PluginSecrets) => async (_name: string, value: string) => (secrets.isSealed(value) ? ((await secrets.unseal(value)) ?? "") : value);

export function sealServers(servers: readonly ServerConfig[], secrets: PluginSecrets): Promise<ServerConfig[]> {
	return Promise.all(servers.map((server) => mapVars(server, seal(secrets))));
}

export function openServers(servers: readonly ServerConfig[], secrets: PluginSecrets): Promise<ServerConfig[]> {
	return Promise.all(servers.map((server) => mapVars(server, open(secrets))));
}

/** 插件带来的服务上人填的值，加密、解开同上。 */
async function mapStates(
	states: Readonly<Record<string, PluginServerState>>,
	map: (name: string, value: string) => Promise<string>,
): Promise<Record<string, PluginServerState>> {
	const entries = await Promise.all(
		Object.entries(states).map(async ([id, state]) => {
			const env =
				state.env && Object.fromEntries(await Promise.all(Object.entries(state.env).map(async ([name, value]) => [name, await map(name, value)] as const)));
			return [id, { ...state, ...(env ? { env } : {}) }] as const;
		}),
	);
	return Object.fromEntries(entries);
}

export function sealStates(states: Readonly<Record<string, PluginServerState>>, secrets: PluginSecrets): Promise<Record<string, PluginServerState>> {
	return mapStates(states, seal(secrets));
}

export function openStates(states: Readonly<Record<string, PluginServerState>>, secrets: PluginSecrets): Promise<Record<string, PluginServerState>> {
	return mapStates(states, open(secrets));
}
