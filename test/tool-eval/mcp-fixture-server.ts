/**
 * 一台假的 stdio MCP 服务器：报出 `mcp-fixture.ts` 里某一台的工具，每次调用往记录文件追加一行 JSON（服务器 id、工具、参数），
 * 回一句 ok。不碰任何真服务。
 *
 *   node mcp-fixture-server.ts <服务器 id> <记录文件>
 *
 * 用 plume.mcp 自己依赖的那份 SDK：评测目录不在任何包里，裸写包名解析不到，所以从插件的 package.json 起解析。
 */

import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fixtureServer } from "./mcp-fixture.ts";

const require = createRequire(join(import.meta.dirname, "../../packages/builtin/mcp/package.json"));
const { Server } = require("@modelcontextprotocol/sdk/server/index.js") as typeof import("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js") as typeof import("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js") as typeof import("@modelcontextprotocol/sdk/types.js");

const [id = "", log = ""] = process.argv.slice(2);
const fixture = fixtureServer(id);
if (!fixture || !log) {
	process.stderr.write(`用法：mcp-fixture-server.ts <服务器 id> <记录文件>（没有 ${id}）\n`);
	process.exit(2);
}

const server = new Server({ name: fixture.id, version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: fixture.tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	appendFileSync(log, `${JSON.stringify({ server: fixture.id, tool: request.params.name, args: request.params.arguments ?? {} })}\n`);
	return { content: [{ type: "text", text: `ok: ${fixture.name} ${request.params.name}` }] };
});
await server.connect(new StdioServerTransport());
