// 测试用的 stdio MCP 服务：一个只读的 echo、一个会改东西的 shout，报自己进程号的 pid、答完就退出的 exit，
// 中途要人填表的 ask（text 是 bad 时要一张认不出的表），一段要 name 参数的 prompt greet，两个资源（分两段文本的构建日志、
// 只有二进制的图标）；启动时往 stderr 打一行带密钥的日志。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.stderr.write(`starting with token ${process.env.ECHO_TOKEN ?? ""}\n`);
if (process.env.ECHO_CRASH) process.exit(3);
const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
const text = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const none = { type: "object", properties: {} };
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: "echo", description: "Echo the text back.", inputSchema: text, annotations: { readOnlyHint: true } },
		{ name: "shout", description: "Shout the text.", inputSchema: text },
		{ name: "pid", description: "Report the server's process id.", inputSchema: none, annotations: { readOnlyHint: true } },
		{ name: "exit", description: "Answer, then exit the process.", inputSchema: none },
		{ name: "ask", description: "Ask the person for details.", inputSchema: text },
		// ECHO_MANY：再多报一批工具，工具表大到要改成按需搜索。
		...Array.from({ length: Number(process.env.ECHO_MANY ?? 0) }, (_, index) => ({
			name: `extra_${index}`,
			description: `Extra tool number ${index}. `.repeat(10),
			inputSchema: text,
		})),
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const value = String(request.params.arguments?.text ?? "");
	if (request.params.name === "echo" && value === "documents" && process.env.ECHO_DOCUMENTS) {
		return {
			content: [
				{ type: "text", text: "MCP document fixtures" },
				...["sample.docx", "sample.xlsx", "sample.sqlite"].map((name) => ({
					type: "resource",
					resource: { uri: `resource://documents/${name}`, blob: readFileSync(join(process.env.ECHO_DOCUMENTS, name)).toString("base64") },
				})),
			],
		};
	}
	if (request.params.name === "echo") return { content: [{ type: "text", text: `echo: ${value}` }] };
	if (request.params.name === "pid") return { content: [{ type: "text", text: String(process.pid) }] };
	if (request.params.name === "ask") {
		const requestedSchema =
			value === "bad"
				? { type: "object", properties: { nested: { type: "object" } } }
				: {
						type: "object",
						properties: { name: { type: "string", minLength: 2 }, age: { type: "integer", minimum: 0 }, plan: { type: "string", enum: ["free", "pro"] } },
						required: ["name"],
					};
		try {
			const answer = await server.elicitInput({ message: `Tell me about ${value}`, requestedSchema });
			return { content: [{ type: "text", text: JSON.stringify(answer) }] };
		} catch (error) {
			return { content: [{ type: "text", text: `elicit failed: ${error.message}` }], isError: true };
		}
	}
	if (request.params.name === "exit") {
		setTimeout(() => process.exit(0), 20);
		return { content: [{ type: "text", text: "bye" }] };
	}
	return { content: [{ type: "text", text: value.toUpperCase() }], structuredContent: { loud: value.toUpperCase() } };
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
	prompts: [{ name: "greet", description: "Greet someone.", arguments: [{ name: "name", required: true }] }],
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
	messages: [{ role: "user", content: { type: "text", text: `Say hello to ${request.params.arguments?.name ?? "nobody"}.` } }],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: [
		{ uri: "file:///var/log/build.log", name: "build log" },
		{ uri: "icon://logo", name: "logo", mimeType: "image/png" },
	],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const { uri } = request.params;
	if (uri === "file:///var/log/build.log")
		return {
			contents: [
				{ uri, text: "step 1 ok" },
				{ uri, text: "step 2 failed" },
			],
		};
	if (uri === "icon://logo") return { contents: [{ uri, blob: "iVBORw0KGgo=", mimeType: "image/png" }] };
	throw new Error(`no resource ${uri}`);
});
await server.connect(new StdioServerTransport());
