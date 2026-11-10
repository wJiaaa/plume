/**
 * MCP 服务声明的资源经资源地址 `mcp://` 给模型读（服务 `resources`，见 `@plume/contract` 的 resources.ts）。
 *
 * MCP 有 tools 和 resources 两半：一台提供「当前值班表」「昨天的构建日志」的服务，工具能调，资源也该读得到。
 * `mcp://` 列出连着的服务声明的资源，`mcp://<服务>/<资源 uri>` 读其中一个；`<服务>` 是工具名 `mcp__<服务>__<工具>` 里的那一段。
 * 内容是别人的进程给的，带 origin：read 把它包进 `<resource origin>`，模型当数据读，不当指令。
 */

import type { Resource, ResourceEntry, ResourceHandler } from "@plume/contract";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface ResourceListing {
	uri: string;
	name?: string;
	description?: string;
}

/** 读资源要的那一点：列出全部、按服务段和 uri 读一个。 */
export interface McpResources {
	resources(): Promise<(ResourceListing & { server: string })[]>;
	readResource(server: string, uri: string, sessionId: string, signal?: AbortSignal): Promise<string>;
}

const PAGES = 50;

/** 一台服务声明的资源。没声明 resources 能力的（协议里它是可选的）就是没有。 */
export async function listResources(client: Client, timeout: number): Promise<ResourceListing[]> {
	if (!client.getServerCapabilities()?.resources) return [];
	const out: ResourceListing[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < PAGES; page++) {
		const listed = await client.listResources(cursor ? { cursor } : undefined, { timeout });
		for (const resource of listed.resources) {
			out.push({
				uri: String(resource.uri),
				...(resource.name ? { name: resource.name } : {}),
				...(resource.description ? { description: resource.description } : {}),
			});
		}
		cursor = listed.nextCursor;
		if (!cursor) break;
	}
	return out;
}

/**
 * 一个资源可以有几段内容（协议允许），文本段都拼起来：只挑第一段会悄悄丢掉后面的，「只读到一部分」最难被发现。
 * 二进制段跳过：它进不了文本上下文，塞 base64 进去只会烧掉 token。
 */
// i18n-exempt：报错交给模型。
export function resourceText(uri: string, contents: readonly unknown[]): string {
	const parts = contents.flatMap((part) => (typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
	if (parts.length === 0) throw new Error(`${uri} 没有可读的文本内容（可能是二进制资源）。`);
	return parts.join("\n\n");
}

// i18n-exempt：这个函数里的字都是交给模型的（系统提示词的地址说明、read 的结果和报错）。
export function mcpResource(mcp: McpResources): ResourceHandler {
	const usage = "地址是 `mcp://<服务器>/<资源>`。`mcp://` 可以列出有哪些。";
	return {
		scheme: "mcp",
		describe: "`mcp://` 列出 MCP 服务器声明的资源；`mcp://<服务器>/<资源>` 读其中一个",
		async resolve(url, scope): Promise<Resource> {
			const [server] = url.segments;
			if (!server) throw new Error(usage);
			// uri 从 `path` 上切，不能用 `segments` 拼：MCP 的 uri 常是 `file:///var/log/x` 这种带空段的，拼回来就坏了，
			// 服务只会答「没有这个资源」，看起来像资源不存在。
			const uri = url.path.slice(url.path.indexOf(server) + server.length + 1);
			if (!uri) throw new Error(usage);
			const content = await mcp.readResource(server, uri, scope.sessionId, scope.signal).catch((error: unknown) => {
				throw new Error(`读不到 ${uri}：${error instanceof Error ? error.message : String(error)}`);
			});
			return {
				url: url.raw,
				content,
				contentType: "text/plain",
				label: `MCP 服务器“${server}”提供的 ${uri}`,
				origin: `MCP 服务器 ${server}`,
				meta: { server, uri },
			};
		},
		async list(): Promise<ResourceEntry[]> {
			const all = await mcp.resources().catch(() => []);
			return all.map((resource) => ({
				value: `mcp://${resource.server}/${resource.uri}`,
				...((resource.name ?? resource.description) ? { description: resource.name ?? resource.description } : {}),
			}));
		},
	};
}
