import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolRun } from "@plume/contract";
import type { SearchKeys } from "../src/api.ts";
import { htmlToText } from "../src/html-text.ts";
import { registerDefaultSearchProviders } from "../src/search/defaults.ts";
import { parseResults } from "../src/search/duckduckgo.ts";
import { createSearchRegistry, SearchError } from "../src/search/index.ts";
import { settingsFile, viewOf } from "../src/settings.ts";
import { webFetchTool } from "../src/web-fetch.ts";
import { webSearchTool } from "../src/web-search.ts";

const noFetch = (async () => {
	throw new Error("no network in tests");
}) as unknown as typeof fetch;

function registryWith(keys: SearchKeys, fetchImpl: typeof fetch = noFetch) {
	const registry = createSearchRegistry();
	registerDefaultSearchProviders(registry, () => keys, fetchImpl);
	return registry;
}

const codeOf = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return error instanceof SearchError ? error.code : String(error);
	}
	return "no error";
};

test("选后端：什么都没配用速答，唯一的 key 胜过默认，两把 key 没选时报歧义", () => {
	assert.equal(registryWith({}).select(null).id, "ddg-instant");
	assert.equal(registryWith({ brave: "k" }).select(null).id, "brave");
	assert.equal(
		codeOf(() => registryWith({ brave: "k", exa: "k" }).select(null)),
		"SEARCH_PROVIDER_AMBIGUOUS",
	);
	// 指定的优先，免配置的被点名也能用。
	assert.equal(registryWith({ brave: "k", exa: "k" }).select("exa").id, "exa");
	assert.equal(registryWith({}).select("duckduckgo").id, "duckduckgo");
	assert.equal(
		codeOf(() => registryWith({}).select("tavily")),
		"SEARCH_PROVIDER_UNAVAILABLE",
	);
	assert.equal(
		codeOf(() => registryWith({}).select("bing")),
		"SEARCH_PROVIDER_MISSING",
	);
	// 只有空白的 key 不算填了。
	assert.equal(registryWith({ tavily: "  " }).select(null).id, "ddg-instant");
});

test("注册：同名和第二个默认都拦下", () => {
	const registry = registryWith({});
	const extra = { id: "x", name: "x", available: () => true, keyless: "default" as const, search: async () => ({ sources: [], truncated: false }) };
	assert.equal(
		codeOf(() => registry.register(extra)),
		"SEARCH_DUPLICATE_DEFAULT",
	);
	assert.equal(
		codeOf(() => registry.register({ ...extra, id: "exa", keyless: undefined })),
		"SEARCH_DUPLICATE_PROVIDER",
	);
});

test("DuckDuckGo：拆掉跳转外壳、解实体，丢掉打不开的链接但摘要不错位", () => {
	const html = `
		<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; <b>A</b></a>
		<a class="result__snippet" href="#">First &lt;snippet&gt;</a>
		<a rel="nofollow" class="result__a" href="javascript:void(0)">Broken</a>
		<a class="result__snippet" href="#">Broken snippet</a>
		<a rel="nofollow" class="result__a" href="https://example.org/b">B</a>
		<a class="result__snippet" href="#">Second   snippet</a>`;
	assert.deepEqual(parseResults(html), [
		{ url: "https://example.com/a?x=1", title: "Example & A", snippet: "First <snippet>" },
		{ url: "https://example.org/b", title: "B", snippet: "Second snippet" },
	]);
});

test("htmlToText：表格成行、列表留层次、代码留换行、脚本丢掉、正文里的 < 不当标签", () => {
	const html = `<html><head><style>p{}</style><script>alert(1)</script></head><body>
		<h2>Title</h2><p>a &lt; b and 1<2 stays</p>
		<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>
		<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>
		<pre>line 1
  line 2</pre></body></html>`;
	assert.equal(
		htmlToText(html),
		[
			"## Title",
			"",
			"a < b and 1<2 stays",
			"",
			"- one",
			"",
			"  - nested",
			"",
			"- two",
			"",
			"| k | v |",
			"| --- | --- |",
			"| a | 1 |",
			"",
			"```",
			"line 1",
			"  line 2",
			"```",
		].join("\n"),
	);
});

/** 起一个本机 HTTP 服务，跑完关掉。 */
async function withServer(handler: Parameters<typeof createServer>[1], run: (base: string) => Promise<void>) {
	const server: Server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

const run: ToolRun = {
	sessionId: "s1",
	toolCallId: "call",
	cwd: "/",
	scratchDir: "/scratch/s1",
	signal: new AbortController().signal,
	progress: () => {},
	ask: async () => "once",
	permissionMode: async () => "ask",
	tools: () => [],
	calls: [],
};

test("web_fetch：同源跳转跟过去并把网页转成文字，跨源跳转拒绝", async () => {
	await withServer(
		(req, res) => {
			if (req.url === "/same") res.writeHead(302, { location: "/page" }).end();
			else if (req.url === "/away") res.writeHead(302, { location: "http://localhost:1/elsewhere" }).end();
			else if (req.url === "/page") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Hi</h1><p>there</p>");
			else res.writeHead(404).end();
		},
		async (base) => {
			const tool = webFetchTool();
			const ok = await tool.execute({ url: `${base}/same` }, run);
			assert.equal(ok.isError, undefined);
			assert.equal(ok.output, `<fetched url="${base}/page" content-type="text/html; charset=utf-8">\n# Hi\n\nthere\n</fetched>`);

			const away = await tool.execute({ url: `${base}/away` }, run);
			assert.equal(away.isError, true);
			assert.match(away.output, /^Refused a redirect that leaves the original origin \(http:\/\/127\.0\.0\.1:\d+ → http:\/\/localhost:1\)/);
		},
	);
});

test("web_fetch：正文超过上限时整份存进会话临时目录，结果里给出路径", async () => {
	const scratchDir = await mkdtemp(join(tmpdir(), "plume-web-scratch-"));
	const body = `${"a".repeat(40_000)}TAIL_AFTER_CUT`;
	try {
		await withServer(
			(_req, res) => res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(body),
			async (base) => {
				const result = await webFetchTool().execute({ url: `${base}/big` }, { ...run, scratchDir });
				const saved = (result.details as { outputPath?: string }).outputPath!;
				assert.ok(saved.startsWith(join(scratchDir, "tool-output")));
				assert.equal(await readFile(saved, "utf8"), body);
				assert.equal((await stat(saved)).mode & 0o777, 0o600);
				assert.ok(result.output.endsWith(`[full text: ${saved} (${body.length} characters) — read or grep it for the part after the cut]`));
				assert.ok(!result.output.includes("TAIL_AFTER_CUT"));
				assert.ok(result.output.length <= 37_400);
			},
		);
	} finally {
		await rm(scratchDir, { recursive: true, force: true });
	}
});

test("web_fetch：拒绝非 http 协议和带账号密码的地址", async () => {
	const tool = webFetchTool(async () => []);
	assert.match((await tool.execute({ url: "file:///etc/passwd" }, run)).output, /^Refused: /);
	assert.match((await tool.execute({ url: "http://u:p@example.com/" }, run)).output, /^Refused: /);
});

test("web_search：按 <search> 格式输出，配置错误时说出 code", async () => {
	const fakeFetch = (async () =>
		new Response(
			JSON.stringify({ results: [{ url: "https://a.example/x", title: "A", content: "snippet a" }, { url: "https://b.example/" }], answer: "the answer" }),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		)) as unknown as typeof fetch;
	const tool = webSearchTool(registryWith({ tavily: "k" }, fakeFetch), async () => null);
	const result = await tool.execute({ pattern: "  hello " }, run);
	assert.equal(
		result.output,
		`<search query="hello">\nthe answer\n\n1. A\n   https://a.example/x\n   snippet a\n2. b.example\n   https://b.example/\n</search>`,
	);

	const ambiguous = webSearchTool(registryWith({ tavily: "k", exa: "k" }, fakeFetch), async () => null);
	const failed = await ambiguous.execute({ query: "x" }, run);
	assert.equal(failed.isError, true);
	assert.match(failed.output, /SEARCH_PROVIDER_AMBIGUOUS/);
});

test("设置文件：0600 写入，界面那份只说填没填", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-web-"));
	try {
		const file = join(dir, "search.json");
		const settings = settingsFile(file);
		const saved = await settings.update((current) => ({ ...current, provider: "brave", keys: { brave: " secret " } }));
		assert.deepEqual(saved, { provider: "brave", keys: { brave: "secret" } });
		assert.equal((await stat(file)).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), saved);
		assert.deepEqual(viewOf(saved), { provider: "brave", keys: { tavily: false, deepseek: false, brave: true, exa: false } });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
