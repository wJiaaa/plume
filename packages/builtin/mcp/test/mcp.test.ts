import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { HumanAnswer, HumanRequestInput, PluginContext, PluginSecrets, ToolDefinition, ToolRun } from "@plume/contract";
import type { McpApi } from "../src/api.ts";
import { applyDraft, checkDraft, readMagpieServers, readPluginServers, readServers, type ServerConfig, withValues, writeServers } from "../src/config.ts";
import { Connections, type ConnectionsOptions } from "../src/connections.ts";
import { checkFormValues, FORM_KIND, formFields, readFormRequest, UnsupportedFormError } from "../src/form.ts";
import { missingFor, placeholdersOf, resolveServer } from "../src/placeholders.ts";
import { bindArguments, commandSegment, splitArguments } from "../src/prompts.ts";
import { callTool, deferredSection, findTool, type McpTool, rank, searchTool } from "../src/search.ts";
import { mcpResource } from "../src/resources.ts";
import { mcpResult, normalizeInputSchema, qualifiedToolName, RESULT_CHARS } from "../src/tools.ts";
import { openServers, openStates, sealServers, sealStates } from "../src/sealed.ts";
import { looksSecret } from "../src/vars.ts";
import { OAuthStore } from "../src/oauth.ts";
import mcpPlugin from "../src/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

/** `ctx.secrets` 的替身：前缀和真的一样，内容只做 base64，测的是插件有没有把该加密的交给它。 */
const SEALED = "plume-sealed:v1:";
const fakeSecrets: PluginSecrets = {
	seal: async (value) => SEALED + Buffer.from(value).toString("base64"),
	unseal: async (sealed) =>
		sealed.startsWith(`${SEALED}lost`) ? null : sealed.startsWith(SEALED) ? Buffer.from(sealed.slice(SEALED.length), "base64").toString() : null,
	isSealed: (value) => value.startsWith(SEALED),
};

test("像密钥的名字按词认，不按子串", () => {
	for (const name of ["GITHUB_TOKEN", "APIKEY", "Authorization", "X-Api-Key", "DATABASE_URL", "PGPASSWORD"]) assert.equal(looksSecret(name), true, name);
	for (const name of ["PATH", "API_BASE_URL", "DEBUG", "Accept"]) assert.equal(looksSecret(name), false, name);
});

test("草稿：逐个字段核对；编辑时没给值的变量留着原来的，换了种类不带过去", () => {
	assert.equal(checkDraft({ name: " ", transport: "stdio", command: "npx" }), "badName");
	assert.equal(checkDraft({ name: "a", transport: "stdio", command: "" }), "badCommand");
	assert.equal(checkDraft({ name: "a", transport: "http", url: "ftp://x" }), "badUrl");
	assert.equal(checkDraft({ name: "a", transport: "stdio", command: "npx", vars: [{ name: "1BAD" }] }), "badVar");
	const previous: ServerConfig = {
		id: "s1",
		name: "gh",
		transport: "stdio",
		command: "npx",
		env: { GITHUB_TOKEN: "secret-value", DEBUG: "1" },
		enabled: false,
	};
	const draft = checkDraft({
		name: " gh ",
		transport: "stdio",
		command: "npx",
		args: ["-y", "server"],
		vars: [{ name: "GITHUB_TOKEN" }, { name: "DEBUG", value: "2" }],
	});
	assert.ok(typeof draft === "object");
	assert.deepEqual(applyDraft(draft, "s1", previous), {
		id: "s1",
		name: "gh",
		enabled: false,
		transport: "stdio",
		command: "npx",
		args: ["-y", "server"],
		env: { GITHUB_TOKEN: "secret-value", DEBUG: "2" },
	});
	const remote = checkDraft({ name: "gh", transport: "http", url: "https://example.com/mcp", vars: [{ name: "GITHUB_TOKEN" }] });
	assert.ok(typeof remote === "object");
	assert.deepEqual(applyDraft(remote, "s1", previous), {
		id: "s1",
		name: "gh",
		enabled: false,
		transport: "http",
		url: "https://example.com/mcp",
		headers: { GITHUB_TOKEN: "" },
	});
	// 远程服务改地址时，填过的空位值留着；三个开关照草稿来。
	const http: ServerConfig = {
		id: "h1",
		name: "linear",
		transport: "http",
		url: "https://a/mcp",
		headers: { Authorization: "Bearer ${TOKEN}" },
		env: { TOKEN: "t-1" },
		enabled: true,
	};
	const moved = checkDraft({ name: "linear", transport: "http", url: "https://b/mcp", vars: [{ name: "Authorization" }], pinned: true, perSession: true });
	assert.ok(typeof moved === "object");
	assert.deepEqual(applyDraft(moved, "h1", http), {
		id: "h1",
		name: "linear",
		enabled: true,
		pinned: true,
		perSession: true,
		transport: "http",
		url: "https://b/mcp",
		headers: { Authorization: "Bearer ${TOKEN}" },
		env: { TOKEN: "t-1" },
	});
	assert.deepEqual(withValues(http, [{ name: "TOKEN", value: "" }]), {
		id: "h1",
		name: "linear",
		transport: "http",
		url: "https://a/mcp",
		headers: { Authorization: "Bearer ${TOKEN}" },
		enabled: true,
	});
});

test("插件带来的服务：读插件目录的 .mcp.json，人改过的开关和填的值盖在上面，重名和坏文件跳过", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-plugins-"));
	try {
		const github = join(dir, "github");
		const broken = join(dir, "broken");
		const plain = join(dir, "plain");
		for (const plugin of [github, broken, plain]) await mkdir(plugin);
		await writeFile(join(github, "package.json"), JSON.stringify({ plume: { displayName: "GitHub 连接器" } }));
		await writeFile(
			join(github, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
					remote: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
					Own: { command: "node" },
				},
			}),
		);
		await writeFile(join(broken, ".mcp.json"), "{broken");
		const warnings: string[] = [];
		const log = { warn: (message: string) => void warnings.push(message) };
		const own: ServerConfig = { id: "mcp-own", name: "own", transport: "stdio", command: "own", enabled: true };
		const plugins = [
			{ name: "plume.github", dir: github },
			{ name: "plume.broken", dir: broken },
			{ name: "plume.plain", dir: plain },
		];
		const states = { "plugin__plume.github__github": { enabled: false, env: { GITHUB_TOKEN: "ghp_x" } } };
		const servers = await readPluginServers(plugins, [own], states, log);
		assert.deepEqual(
			servers.map((server) => [server.id, server.transport, server.enabled, server.managedBy, server.plugin]),
			[
				["plugin__plume.github__github", "stdio", false, "plugin", "GitHub 连接器"],
				["plugin__plume.github__remote", "http", true, "plugin", "GitHub 连接器"],
			],
		);
		assert.deepEqual(servers[0]?.env, { GITHUB_TOKEN: "ghp_x" });
		assert.equal(missingFor(servers[0] as ServerConfig, {}).length, 0);
		assert.deepEqual(missingFor(servers[1] as ServerConfig, {}), ["TOKEN"]);
		// 和自己的重名一条，坏文件一条；没有 .mcp.json 的插件不提。
		assert.equal(warnings.length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("插件服务上人改过的存进 servers.json 的 plugins，密钥加密，读回来解开", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-states-"));
	try {
		const file = join(dir, "servers.json");
		const secrets = fakeSecrets;
		const states = { "plugin__plume.github__github": { enabled: true, env: { GITHUB_TOKEN: "ghp_secret", REGION: "eu" } } };
		await writeServers(file, [], await sealStates(states, secrets));
		const raw = await readFile(file, "utf8");
		assert.ok(!raw.includes("ghp_secret"));
		assert.ok(raw.includes('"REGION": "eu"'));
		const read = await readServers(file);
		assert.deepEqual(await openStates(read.plugins, secrets), states);
		await writeServers(file, [], {});
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { servers: [] });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Magpie 分发的服务：三种传输照 Claude 格式转换，坏条目和重名跳过，读不懂的文件不转述原文", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-magpie-"));
	try {
		const file = join(dir, "mcp.json");
		const warnings: string[] = [];
		const log = { warn: (message: string) => void warnings.push(message) };
		const own: ServerConfig = { id: "mcp-own", name: "GitHub", transport: "stdio", command: "gh-mcp", enabled: true };
		assert.deepEqual(await readMagpieServers(file, [own], log), []);
		assert.equal(warnings.length, 0);
		await writeFile(
			file,
			"\uFEFF" +
				JSON.stringify({
					mcpServers: {
						local: { command: "node", args: ["server.js", "${TOKEN}"], env: { TOKEN: "${TOKEN}" } },
						remote: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
						events: { type: "sse", url: "https://example.invalid/sse", disabled: true },
						github: { command: "node" },
						bad: { type: "websocket", url: "wss://example.invalid" },
						badArgs: { command: "node", args: [42] },
					},
				}),
		);
		const servers = (await readMagpieServers(file, [own], log)) ?? [];
		assert.deepEqual(
			servers.map((server) => [server.id, server.transport, server.enabled, server.managedBy]),
			[
				["magpie__local", "stdio", true, "magpie"],
				["magpie__remote", "http", true, "magpie"],
				["magpie__events", "sse", false, "magpie"],
			],
		);
		assert.deepEqual(servers[0], { ...servers[0], args: ["server.js", "${TOKEN}"], env: { TOKEN: "${TOKEN}" } });
		assert.equal(servers[1]?.transport !== "stdio" && servers[1]?.headers?.Authorization, "Bearer ${TOKEN}");
		assert.equal(warnings.length, 3);
		await writeFile(file, '{"secret":"do-not-log",broken');
		assert.equal(await readMagpieServers(file, [own], log), null);
		assert.ok(warnings.every((message) => !message.includes("do-not-log")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("空位：先取服务自己的值，再取环境；整个值是空位的不算有值；远程服务的取值处不随请求带走", () => {
	const stdio: ServerConfig = {
		id: "s",
		name: "s",
		transport: "stdio",
		command: "${BIN}",
		args: ["--token=${TOKEN}"],
		env: { TOKEN: "${TOKEN}", MODE: "x" },
		enabled: true,
	};
	assert.deepEqual(missingFor(stdio, { BIN: "npx" }), ["TOKEN"]);
	const filled = withValues(stdio, [{ name: "TOKEN", value: "abc" }]);
	assert.deepEqual(missingFor(filled, { BIN: "npx" }), []);
	assert.deepEqual(resolveServer(filled, { BIN: "npx" }), { ...filled, command: "npx", args: ["--token=abc"], env: { TOKEN: "abc", MODE: "x" } });
	const http: ServerConfig = {
		id: "h",
		name: "h",
		transport: "http",
		url: "https://x/${PATH_PART}",
		headers: { Authorization: "Bearer ${TOKEN}" },
		env: { TOKEN: "t" },
		enabled: true,
	};
	assert.deepEqual(resolveServer(http, { PATH_PART: "mcp" }), {
		id: "h",
		name: "h",
		transport: "http",
		url: "https://x/mcp",
		headers: { Authorization: "Bearer t" },
		enabled: true,
	});
});

test("可选空位 ${NAME:-默认值}：不算缺；没值用默认值；空位全落空的环境变量和请求头整条不发", () => {
	const stdio: ServerConfig = {
		id: "s",
		name: "s",
		transport: "stdio",
		command: "npx",
		args: ["--region=${REGION:-us}"],
		env: { JIRA_URL: "${JIRA_URL:-}", MODE: "${MODE:-}x", TOKEN: "${TOKEN}" },
		enabled: true,
	};
	assert.deepEqual(placeholdersOf(stdio), [
		{ name: "REGION", optional: true },
		{ name: "JIRA_URL", optional: true },
		{ name: "MODE", optional: true },
		{ name: "TOKEN", optional: false },
	]);
	assert.deepEqual(missingFor(stdio, {}), ["TOKEN"]);
	assert.deepEqual(resolveServer(stdio, { TOKEN: "t" }), { ...stdio, args: ["--region=us"], env: { TOKEN: "t" } });
	assert.deepEqual(resolveServer(stdio, { TOKEN: "t", JIRA_URL: "https://j", REGION: "eu" }).env, { JIRA_URL: "https://j", TOKEN: "t" });
	assert.deepEqual(resolveServer(stdio, { TOKEN: "t", MODE: "a" }).env, { MODE: "ax", TOKEN: "t" });
	// 同一个名字有一处是必填，就是必填。
	assert.deepEqual(placeholdersOf({ ...stdio, args: ["${TOKEN:-}"], env: { TOKEN: "${TOKEN}" } }), [{ name: "TOKEN", optional: false }]);
	const http: ServerConfig = { id: "h", name: "h", transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${HF_TOKEN:-}" }, enabled: true };
	assert.deepEqual(missingFor(http, {}), []);
	assert.deepEqual(resolveServer(http, {}), { ...http, headers: {} });
	assert.deepEqual(resolveServer({ ...http, env: { HF_TOKEN: "hf_x" } }, {}), { ...http, headers: { Authorization: "Bearer hf_x" } });
});

test("prompt 命令：名字折成小写连字符；只有一个参数时整段给它，否则按名字、按位置给，缺必填的报出来", () => {
	assert.equal(commandSegment("Code Review!"), "code-review");
	assert.equal(commandSegment("审查"), "");
	assert.deepEqual(splitArguments(`a "b c" ''`), ["a", "b c", ""]);
	const one = { arguments: [{ name: "text", required: true }] };
	assert.deepEqual(bindArguments(one, "整段 话"), { ok: true, args: { text: "整段 话" } });
	const two = { arguments: [{ name: "repo", required: true }, { name: "focus" }] };
	assert.deepEqual(bindArguments(two, "focus=tests plume more words"), { ok: true, args: { focus: "tests", repo: "plume more words" } });
	assert.deepEqual(bindArguments(two, ""), { ok: false, missing: ["repo"] });
});

function fakeTool(server: string, tool: string, description: string, pinned = false): McpTool {
	return {
		name: `mcp__${server}__${tool}`,
		server: { id: server, name: server },
		tool,
		description,
		parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
		readOnly: false,
		pinned,
		execute: async (args) => ({ output: `ran ${tool} ${JSON.stringify(args)}` }),
	};
}

test("按需搜索：工具名里的词最重；mcp_call 按几种写法找到工具，参数缺必填的不调", async () => {
	const tools = [
		fakeTool("linear", "create_issue", "Create an issue."),
		fakeTool("linear", "list_projects", "List projects."),
		fakeTool("github", "create_pull_request", "Open a pull request about an issue."),
	];
	assert.deepEqual(
		rank(tools, "create issue").map((tool) => tool.name),
		["mcp__linear__create_issue", "mcp__github__create_pull_request"],
	);
	assert.equal(findTool(tools, "linear:create_issue")?.name, "mcp__linear__create_issue");
	assert.equal(findTool(tools, "list_projects")?.name, "mcp__linear__list_projects");
	const call = callTool(() => tools);
	const run = fakeRun([]);
	// 总入口转调真正的那个工具：导出会话时这一行按被调的写；两个入口都算 MCP 工具。
	assert.deepEqual(call.forwards?.({ tool: "mcp__linear__create_issue", arguments: { title: "x" } }), {
		name: "mcp__linear__create_issue",
		args: { title: "x" },
	});
	assert.deepEqual(call.forwards?.({ tool: "mcp__linear__create_issue", arguments: "{}" }), { name: "mcp__linear__create_issue", args: {} });
	assert.equal(call.forwards?.({}), undefined);
	assert.equal(call.category, "mcp");
	assert.equal(searchTool(() => tools).category, "mcp");
	assert.deepEqual(await call.execute({ tool: "mcp__linear__create_issue", arguments: '{"title":"x"}' }, run), { output: 'ran create_issue {"title":"x"}' });
	assert.match((await call.execute({ tool: "mcp__linear__create_issue", arguments: {} }, run)).output, /required arguments are missing \(title\)/);
	assert.match((await call.execute({ tool: "mcp__linear__nope" }, run)).output, /^No tool named "mcp__linear__nope"\. Closest: /);
	assert.match(deferredSection(tools), /- MCP server linear \(2 tools\): create_issue, list_projects\n- MCP server github \(1 tools\): create_pull_request$/);
});

test("工具名：放得下又没改过字的原样，否则截短加哈希，同一个工具每次一样", () => {
	assert.equal(qualifiedToolName("github", "search_code"), "mcp__github__search_code");
	const dotted = qualifiedToolName("github", "repo.search");
	assert.match(dotted, /^mcp__github__repo_search_[0-9a-f]{8}$/);
	assert.equal(qualifiedToolName("github", "repo.search"), dotted);
	const long = qualifiedToolName("server", "x".repeat(80));
	assert.equal(long.length, 64);
	assert.notEqual(qualifiedToolName("a", "b", new Set(["mcp__a__b"])), "mcp__a__b");
});

test("参数 Schema 不是 object 的换成任意参数；array 补上 items", () => {
	assert.deepEqual(normalizeInputSchema(undefined), { type: "object", properties: {}, additionalProperties: true });
	assert.deepEqual(normalizeInputSchema({ type: "object", properties: { list: { type: "array" } } }), {
		type: "object",
		properties: { list: { type: "array", items: {} } },
	});
});

test("结果换成文字：结构化结果和正文不重复，音频写一句说明，太长的截掉中间", () => {
	const text = (response: Parameters<typeof mcpResult>[0]) => mcpResult(response).output;
	assert.equal(text({ content: [{ type: "text", text: '{"b":1,"a":2}' }], structuredContent: { a: 2, b: 1 } }), '{"b":1,"a":2}');
	assert.equal(text({ content: [], structuredContent: { a: 1 } }), 'structuredContent: {"a":1}');
	assert.equal(text({ content: [] }), "(the server returned no content)");
	assert.equal(
		text({ content: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }] }),
		"[audio (audio/wav, 1 KiB) omitted: Plume does not pass audio to the model]",
	);
	const long = text({ content: [{ type: "text", text: "x".repeat(RESULT_CHARS * 2) }] });
	assert.equal([...long].length, RESULT_CHARS);
	assert.match(long, /characters omitted by Plume/);
});

test("太长的结果交给 spill 存下，截短的那份给出地址；告诉读文件的工具、存不下时让它要少一点", () => {
	const full = "y".repeat(RESULT_CHARS * 2);
	const saved = { address: "artifact://a0123456789ab", path: "/tmp/a0123456789ab.txt", characters: [...full].length };
	const calls: string[] = [];
	const result = mcpResult({ content: [{ type: "text", text: full }] }, undefined, undefined, "read", (tool, content) => {
		calls.push(tool);
		assert.equal(content, full);
		return saved;
	});
	assert.deepEqual(calls, ["mcp"]);
	assert.deepEqual(result.spill, saved);
	assert.match(result.output, /the full result is saved at artifact:\/\/a0123456789ab — `read` it with offset/);

	// 没给 spill、或它存不下：截断照常，提示改成向工具要少一点。
	const bare = mcpResult({ content: [{ type: "text", text: full }] });
	assert.equal(bare.spill, undefined);
	assert.match(bare.output, /ask the tool for less/);
	const failing = mcpResult({ content: [{ type: "text", text: full }] }, undefined, undefined, "read", () => {
		throw new Error("磁盘满了");
	});
	assert.equal(failing.spill, undefined);
	assert.match(failing.output, /ask the tool for less/);
});

/** 这么多字节的图，base64。 */
const imageOf = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

test("小图直接交给模型；200 KiB 以上存进临时目录给路径、记在给人看的那份里；超过 5 MB 只说一声", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-test-"));
	try {
		const small = imageOf(1023);
		const inline = mcpResult(
			{
				content: [
					{ type: "text", text: "hi" },
					{ type: "image", data: small, mimeType: "image/png" },
				],
			},
			dir,
		);
		assert.equal(inline.output, "hi");
		assert.deepEqual(inline.images, [{ data: small, mimeType: "image/png" }]);
		assert.deepEqual(inline.shown, []);
		// 只回了一张图也不说「没有内容」。
		assert.equal(mcpResult({ content: [{ type: "image", data: small, mimeType: "image/png" }] }, dir).output, "");

		const big = imageOf(300 * 1024);
		// 读文件的工具叫什么按工具表里 `kind: "view"` 的那个现查，连接器不认名字。
		const parked = mcpResult({ content: [{ type: "image", data: big, mimeType: "image/jpeg" }] }, dir, undefined, "view_file");
		assert.deepEqual(parked.images, []);
		assert.deepEqual(parked.shown, [{ data: big, mimeType: "image/jpeg" }]);
		const [saved] = await readdir(join(dir, "mcp-images"));
		assert.ok(saved && saved.endsWith(".jpeg"));
		const path = join(dir, "mcp-images", saved);
		assert.equal(
			parked.output,
			`[image (image/jpeg, 300 KiB) not attached inline to save context; it is shown to the user and saved at ${path} — \`view_file\` that path if you need to look at it]`,
		);
		// 工具表里没有读文件的工具时只说去打开那个文件。
		assert.match(mcpResult({ content: [{ type: "image", data: big, mimeType: "image/jpeg" }] }, dir).output, /— open that file if you need to look at it\]$/);
		assert.deepEqual(await readFile(path), Buffer.from(big, "base64"));

		// 没有临时目录（设置页探测）时不存，照样给人看。
		const nowhere = mcpResult({ content: [{ type: "image", data: big, mimeType: "image/png" }] });
		assert.match(nowhere.output, /it is shown to the user\]$/);
		assert.equal(nowhere.shown.length, 1);

		const huge = mcpResult({ content: [{ type: "image", data: imageOf(6 * 1024 * 1024), mimeType: "image/png" }] }, dir);
		assert.equal(huge.output, "[image (image/png, 6.0 MB) omitted: over the 5 MB limit]");
		assert.deepEqual([huge.images, huge.shown], [[], []]);

		// 模型那边不收的格式只说一声。
		assert.match(mcpResult({ content: [{ type: "image", data: small, mimeType: "image/svg+xml" }] }).output, /only PNG, JPEG, GIF and WebP/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("嵌入资源里的 image/* 按图的规则，别的二进制写一句说明", () => {
	const small = imageOf(1023);
	const image = mcpResult({ content: [{ type: "resource", resource: { uri: "file:///a.png", mimeType: "image/png", blob: small } }] });
	assert.deepEqual(image.images, [{ data: small, mimeType: "image/png" }]);
	const binary = mcpResult({ content: [{ type: "resource", resource: { uri: "file:///a.bin", mimeType: "application/zip", blob: small } }] });
	assert.equal(binary.output, "[resource file:///a.bin (application/zip, 1 KiB) is binary and not shown]");
	assert.deepEqual(binary.images, []);
});

function fakeRun(asked: string[], sessionId = "s"): ToolRun {
	return {
		sessionId,
		session: { id: sessionId, kind: "top" },
		toolCallId: "call",
		cwd: "/",
		scratchDir: join(tmpdir(), "plume-mcp-test-scratch", sessionId),
		signal: new AbortController().signal,
		progress() {},
		async ask(content) {
			asked.push(content.title);
			return "once";
		},
		rejection: "人拒绝了",
		request: async () => ({ answered: false, reason: "declined" }),
		permissionMode: async () => "auto",
		shell: async () => ({ kind: "posix", label: "zsh", sandbox: "workspace-write" }),
		exec: async () => {
			throw new Error("MCP 工具不跑命令");
		},
		escalate: async () => ({ granted: false, message: "MCP 工具不跑命令" }),
		track: () => {
			throw new Error("MCP 工具不起后台任务");
		},
		files: {
			read: async () => ({ ok: false, message: "MCP 工具不读文件" }),
			readCommand: async () => ({ ok: false, message: "MCP 工具不跑命令" }),
			resolve: (path) => path,
			change: async () => {
				throw new Error("MCP 工具不写文件");
			},
			write: async () => ({ ok: false, message: "MCP 工具不写文件" }),
			spill: () => {
				throw new Error("MCP 工具不存原文");
			},
			includeChanges: () => {},
		},
		tools: () => [],
		calls: [],
	};
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("等太久了");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withConnections(
	body: (connections: Connections, tools: Map<string, ToolDefinition>) => Promise<void>,
	options?: ConnectionsOptions,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-test-"));
	const tools = new Map<string, ToolDefinition>();
	const connections = new Connections(
		{
			register(tool) {
				tools.set(tool.name, tool);
				return () => void tools.delete(tool.name);
			},
			warn() {},
			dataDir: dir,
			secrets: fakeSecrets,
		},
		options,
	);
	try {
		await body(connections, tools);
	} finally {
		await connections.closeAll();
		await rm(dir, { recursive: true, force: true });
	}
}

const ECHO_TOOLS = ["echo", "shout", "pid", "exit", "ask"];

test("连上真的 stdio 服务：登记工具、调用前问人、信任只读后不问、关掉后撤下；起不来时带着 stderr，密钥打码", () =>
	withConnections(async (connections, tools) => {
		const server: ServerConfig = {
			id: "e1",
			name: "echo",
			transport: "stdio",
			command: process.execPath,
			args: [FIXTURE],
			env: { ECHO_TOKEN: "sekrit-123" },
			enabled: true,
		};
		connections.sync([server], { retry: false });
		assert.equal(connections.status(server).state, "connecting");
		await until(() => connections.status(server).state !== "connecting");
		assert.equal(connections.status(server).state, "connected", connections.status(server).error);
		assert.deepEqual(
			[...tools.keys()],
			ECHO_TOOLS.map((tool) => `mcp__echo__${tool}`),
		);
		assert.equal(tools.get("mcp__echo__echo")?.mutating, false);
		assert.equal(tools.get("mcp__echo__shout")?.mutating, true);
		// 上下文用量按类别把它们算进「MCP 工具」；导出会话时写成「服务: 工具」。
		assert.equal(tools.get("mcp__echo__echo")?.category, "mcp");
		assert.equal(tools.get("mcp__echo__shout")?.describe?.({ text: "hi" }), "echo: shout");

		const asked: string[] = [];
		const shout = await tools.get("mcp__echo__shout")?.execute({ text: "hi" }, fakeRun(asked));
		assert.deepEqual(shout, { output: 'HI\n\nstructuredContent: {"loud":"HI"}', details: { server: "echo", tool: "shout" } });
		assert.deepEqual(asked, ["echo → shout"]);

		// 改名、信任只读不重连，只重新登记；信任以后只读的工具在「帮我批准」下不再问。
		const trusted = { ...server, name: "loud", trustReadOnly: true };
		connections.sync([trusted], { retry: false });
		assert.deepEqual(
			[...tools.keys()],
			ECHO_TOOLS.map((tool) => `mcp__loud__${tool}`),
		);
		const echo = await tools.get("mcp__loud__echo")?.execute({ text: "hi" }, fakeRun(asked));
		assert.equal(echo?.output, "echo: hi");
		assert.deepEqual(asked, ["echo → shout"]);

		connections.sync([{ ...trusted, enabled: false }], { retry: false });
		assert.equal(tools.size, 0);
		assert.equal(connections.status({ ...trusted, enabled: false }).state, "disabled");

		const crashing: ServerConfig = { ...server, id: "e2", env: { ECHO_TOKEN: "sekrit-123", ECHO_CRASH: "1" } };
		connections.sync([crashing], { retry: false });
		await until(() => connections.status(crashing).state !== "connecting");
		const status = connections.status(crashing);
		assert.equal(status.state, "failed");
		assert.ok(status.error);
		assert.equal(status.stderr, "starting with token [secret]");
	}));

test("断了自己重连，工具留着、调用等它；prompt 能取；每个会话一份的各起一个进程；缺值时不启动，填上就连", () =>
	withConnections(
		async (connections, tools) => {
			const server: ServerConfig = { id: "e1", name: "echo", transport: "stdio", command: process.execPath, args: [FIXTURE], enabled: true };
			connections.sync([server], { retry: false });
			await until(() => connections.status(server).state === "connected");
			assert.equal(await connections.getPrompt("e1", "greet", { name: "Ann" }), "Say hello to Ann.");
			assert.deepEqual(
				connections.prompts().map(({ prompts }) => prompts.map((prompt) => prompt.prompt)),
				[["greet"]],
			);

			assert.equal((await tools.get("mcp__echo__exit")?.execute({}, fakeRun([])))?.output, "bye");
			await until(() => connections.status(server).state === "reconnecting");
			assert.equal(tools.size, ECHO_TOOLS.length);
			// 重连期间的调用等它连上。
			assert.equal((await tools.get("mcp__echo__echo")?.execute({ text: "again" }, fakeRun([])))?.output, "echo: again");
			assert.equal(connections.status(server).state, "connected");

			connections.sync([{ ...server, perSession: true }], { retry: false });
			const pid = async (session: string) => (await tools.get("mcp__echo__pid")?.execute({}, fakeRun([], session)))?.output;
			const a = await pid("a");
			assert.equal(await pid("a"), a);
			assert.notEqual(await pid("b"), a);
			connections.closeSession("a");
			assert.notEqual(await pid("a"), a);

			const keyed: ServerConfig = {
				id: "e2",
				name: "keyed",
				transport: "stdio",
				command: process.execPath,
				args: [FIXTURE],
				env: { ECHO_TOKEN: "${PLUME_MCP_TEST_UNSET}" },
				enabled: true,
			};
			connections.sync([server, keyed], { retry: false });
			await until(() => connections.status(keyed).state !== "connecting");
			assert.deepEqual(connections.status(keyed), { state: "missing", tools: [], missing: ["PLUME_MCP_TEST_UNSET"] });
			connections.sync([server, withValues(keyed, [{ name: "PLUME_MCP_TEST_UNSET", value: "v" }])], { retry: true });
			await until(() => connections.status(keyed).state !== "connecting");
			assert.equal(connections.status(keyed).state, "connected");
		},
		{ reconnect: { baseMs: 50 } },
	));

test("资源：mcp:// 列出连着的服务声明的，服务段和工具名一致；带空段的 uri 原样读，文本段拼起来，二进制和不认识的服务报给模型", () =>
	withConnections(async (connections) => {
		const server: ServerConfig = { id: "e1", name: "my echo", transport: "stdio", command: process.execPath, args: [FIXTURE], enabled: true };
		connections.sync([server], { retry: false });
		await until(() => connections.status(server).state === "connected");
		const handler = mcpResource(connections);
		const scope = { sessionId: "s", cwd: "/", scratchDir: "/tmp" };
		assert.deepEqual(await handler.list?.(scope), [
			{ value: "mcp://my_echo/file:///var/log/build.log", description: "build log" },
			{ value: "mcp://my_echo/icon://logo", description: "logo" },
		]);
		const address = (path: string) => ({ scheme: "mcp", path, segments: path.split("/").filter(Boolean), raw: `mcp://${path}` });
		const log = await handler.resolve(address("my_echo/file:///var/log/build.log"), scope);
		assert.equal(log.content, "step 1 ok\n\nstep 2 failed");
		assert.equal(log.origin, "MCP 服务器 my_echo");
		await assert.rejects(handler.resolve(address("my_echo/icon://logo"), scope), /二进制/);
		await assert.rejects(handler.resolve(address("other/x"), scope), /没有叫“other”的 MCP 服务器/);
		await assert.rejects(handler.resolve(address("my_echo"), scope), /mcp:\/\/<服务器>\/<资源>/);
	}));

test("表单：读平铺的 Schema，选项两种写法；嵌套的认不出；提交前按字段核对", () => {
	const fields = formFields({
		type: "object",
		properties: {
			name: { type: "string", title: "Name", minLength: 2 },
			size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
			tone: { type: "string", oneOf: [{ const: "warm", title: "Warm" }] },
			mail: { type: "string", format: "email" },
			count: { type: "integer", minimum: 1 },
			ok: { type: "boolean", default: true },
		},
		required: ["name", "count"],
	});
	assert.deepEqual(
		fields.map((field) => [field.name, field.type, field.required]),
		[
			["name", "string", true],
			["size", "string", false],
			["tone", "string", false],
			["mail", "string", false],
			["count", "integer", true],
			["ok", "boolean", false],
		],
	);
	assert.deepEqual(fields[1]?.options, [
		{ value: "s", label: "Small" },
		{ value: "m", label: "Medium" },
	]);
	assert.deepEqual(fields[2]?.options, [{ value: "warm", label: "Warm" }]);
	assert.throws(() => formFields({ type: "object", properties: { deep: { type: "object" } } }), UnsupportedFormError);

	assert.deepEqual(checkFormValues(fields, { name: "A", size: "x", mail: "nope", count: 1.5 }), {
		ok: false,
		problems: { name: "minLength", size: "option", mail: "format", count: "type" },
	});
	assert.deepEqual(checkFormValues(fields, { name: "Ann", count: 2, ok: false, extra: "dropped" }), { ok: true, values: { name: "Ann", count: 2, ok: false } });
	assert.equal(readFormRequest({ fields: [] }), null);
});

test("服务中途要人填表：恰好一个调用在跑时经它的 run.request 问人；交回的值按表再核，对不上的当没做决定；不给、认不出的表都回给服务", () =>
	withConnections(async (connections, tools) => {
		const server: ServerConfig = { id: "e1", name: "echo", transport: "stdio", command: process.execPath, args: [FIXTURE], enabled: true };
		connections.sync([server], { retry: false });
		await until(() => connections.status(server).state !== "connecting");
		assert.equal(connections.status(server).state, "connected", connections.status(server).error);

		const formRun = (reply: HumanAnswer, seen: HumanRequestInput[] = []): ToolRun => ({
			...fakeRun([]),
			async request(input) {
				seen.push(input);
				const request = readFormRequest(input.payload);
				assert.ok(request);
				assert.equal(request.message, "Tell me about you");
				return reply as HumanAnswer<never>;
			},
		});
		const ask = async (run: ToolRun) => (await tools.get("mcp__echo__ask")?.execute({ text: "you" }, run))?.output;

		const seen: HumanRequestInput[] = [];
		assert.equal(
			await ask(formRun({ answered: true, value: { action: "accept", values: { name: "Ann", age: 3, plan: "pro" } } }, seen)),
			JSON.stringify({ action: "accept", content: { name: "Ann", age: 3, plan: "pro" } }),
		);
		assert.deepEqual(
			seen.map(({ kind, title }) => ({ kind, title })),
			[{ kind: FORM_KIND, title: "echo" }],
		);
		// 渲染进程交来的不可信：类型对不上的值不交给服务。
		assert.equal(await ask(formRun({ answered: true, value: { action: "accept", values: { name: "Ann", age: "3" } } })), JSON.stringify({ action: "cancel" }));
		assert.equal(await ask(formRun({ answered: true, value: { action: "decline" } })), JSON.stringify({ action: "decline" }));
		// 卡上「取消」、停下这一轮、到时没人答：当作没做决定。
		for (const reason of ["declined", "stopped", "expired"] as const)
			assert.equal(await ask(formRun({ answered: false, reason })), JSON.stringify({ action: "cancel" }), reason);

		const bad = await tools.get("mcp__echo__ask")?.execute(
			{ text: "bad" },
			{
				...fakeRun([]),
				request: async () => assert.fail("认不出的表不该问人"),
			},
		);
		// 嵌套的表 SDK 在协议这层就拒了（错误码 -32603）；它认得、我们画不出的那些由 `formFields` 拒（InvalidParams）。
		assert.match(String(bad?.output), /^elicit failed: MCP error/);
	}));

test("设置页同时存两张卡片：一个接一个写，两处改动都留下；写完不留临时文件", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-save-"));
	let api: McpApi | undefined;
	const ctx = {
		dataDir: dir,
		// Magpie 的文件在 Plume 数据目录下找，指到空目录，不读跑测试那个人的。
		appDataDir: dir,
		locale: () => "zh-CN",
		secrets: fakeSecrets,
		resources: { register: () => () => {} },
		log: { warn: () => {}, info: () => {}, error: () => {} },
		effect: () => {},
		sessions: { onDeleted: () => {} },
		tools: { register: () => () => {} },
		hook: () => {},
		commands: { provide: () => {} },
		plugins: { list: () => [], onChange: () => {} },
		serve: (served: McpApi) => {
			api = served;
		},
	} as unknown as PluginContext;
	const file = join(dir, "servers.json");
	const disabled = (id: string): ServerConfig => ({ id, name: id, transport: "stdio", command: "plume-test-no-such-command", enabled: false });
	try {
		await writeServers(file, [disabled("a"), disabled("b")], {});
		await mcpPlugin.apply(ctx);
		const draft = (name: string) => ({ name, transport: "stdio" as const, command: "plume-test-no-such-command", vars: [] });
		await Promise.all([api!.save("a", draft("a2")), api!.save("b", draft("b2"))]);
		const { servers } = await readServers(file);
		assert.deepEqual(
			servers.map((server) => [server.id, server.name, server.enabled]),
			[
				["a", "a2", false],
				["b", "b2", false],
			],
		);
		assert.deepEqual(
			(await readdir(dir)).filter((name) => name.endsWith(".tmp")),
			[],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("存配置时只留还在的服务的登录：删掉的、撤回的令牌文件一起清掉", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-oauth-"));
	try {
		const store = new OAuthStore(dir, fakeSecrets);
		const server = (id: string): ServerConfig => ({ id, name: id, transport: "http", url: `https://example.invalid/${id}`, enabled: true });
		for (const id of ["mcp-kept", "mcp-gone", "magpie__withdrawn"])
			await store.update(server(id) as never, (record) => ({ ...record, tokens: { access_token: id, token_type: "Bearer" } }));
		const files = await readdir(join(dir, "oauth"));
		assert.equal(files.length, 3);
		for (const name of files) assert.ok((await readFile(join(dir, "oauth", name), "utf8")).startsWith(SEALED), "令牌文件整份加密");
		await store.keepOnly([{ id: "mcp-kept" }]);
		assert.equal((await readdir(join(dir, "oauth"))).length, 1);
		assert.equal((await store.read(server("mcp-kept") as never)).tokens?.access_token, "mcp-kept");
		assert.equal((await store.read(server("mcp-gone") as never)).tokens, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("写盘时像密钥的值加密，空位、不像密钥的、已经加密的原样；读回来解开，解不开的当成没填", async () => {
	const servers: ServerConfig[] = [
		{
			id: "a",
			name: "a",
			enabled: true,
			transport: "stdio",
			command: "npx",
			env: { GITHUB_TOKEN: "ghp_x", DEBUG: "1", API_KEY: "${API_KEY}", PGPASSWORD: "" },
		},
		{ id: "b", name: "b", enabled: true, transport: "http", url: "https://x", headers: { Authorization: "Bearer t0k", Accept: "json" }, env: { TOKEN: "abc" } },
	];
	const sealed = await sealServers(servers, fakeSecrets);
	const a = sealed[0]!;
	const b = sealed[1]!;
	assert.ok(a.transport === "stdio" && b.transport === "http");
	assert.ok(fakeSecrets.isSealed(a.env!.GITHUB_TOKEN!));
	assert.deepEqual({ ...a.env, GITHUB_TOKEN: "" }, { GITHUB_TOKEN: "", DEBUG: "1", API_KEY: "${API_KEY}", PGPASSWORD: "" });
	assert.ok(fakeSecrets.isSealed(b.headers!.Authorization!) && fakeSecrets.isSealed(b.env!.TOKEN!));
	assert.equal(b.headers!.Accept, "json");
	assert.ok(!JSON.stringify(sealed).includes("ghp_x") && !JSON.stringify(sealed).includes("t0k"));
	assert.deepEqual(await sealServers(sealed, fakeSecrets), sealed, "已经是密文的不再套一层");
	assert.deepEqual(await openServers(sealed, fakeSecrets), servers);
	const lost = await openServers([{ ...servers[0]!, env: { GITHUB_TOKEN: `${SEALED}lost`, DEBUG: "1" } } as ServerConfig], fakeSecrets);
	assert.deepEqual(lost[0]!.transport === "stdio" && lost[0]!.env, { GITHUB_TOKEN: "", DEBUG: "1" });
});
