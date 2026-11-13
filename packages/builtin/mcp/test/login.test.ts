/**
 * 设置页的「登录」：逻辑入口先交回授权页的地址（界面经 `ui.openExternal` 打开），再等浏览器跳回来换令牌。
 * 本机起一台假的 MCP 服务兼授权服务器（元数据、动态注册、换令牌），浏览器那一步由测试自己访问回调地址代替。
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CallContext, PluginContext, PluginSecrets } from "@plume/contract";
import type { McpApi, McpView } from "../src/api.ts";
import { writeServers } from "../src/config.ts";
import mcpPlugin from "../src/index.ts";
import { MESSAGES } from "../src/messages.ts";

const secrets: PluginSecrets = {
	seal: async (value) => `sealed:${value}`,
	unseal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice("sealed:".length) : null),
	isSealed: (value) => value.startsWith("sealed:"),
};

const TOKEN = "token-from-fake-server";

async function body(req: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of req) text += String(chunk);
	return text;
}

/** 假服务：没带令牌的 MCP 请求答 401；带对了令牌的按最小的 MCP 答（initialize、列表都答空）。 */
async function fakeServer(): Promise<{ origin: string; close: () => Promise<void> }> {
	let origin = "";
	const server: Server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", origin);
			const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
			if (url.pathname === "/mcp") {
				if (req.headers.authorization !== `Bearer ${TOKEN}`) {
					await body(req);
					res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
					return;
				}
				if (req.method !== "POST") return void res.writeHead(405).end();
				const message = JSON.parse(await body(req)) as { id?: number; method: string };
				if (message.id === undefined) return void res.writeHead(202).end();
				const result =
					message.method === "initialize"
						? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } }
						: message.method.endsWith("/list")
							? { [message.method.split("/")[0]!]: [] }
							: {};
				return json(200, { jsonrpc: "2.0", id: message.id, result });
			}
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
			if (url.pathname === "/.well-known/oauth-authorization-server")
				return json(200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			if (url.pathname === "/register") return json(201, { ...JSON.parse(await body(req)), client_id: "plume-test" });
			if (url.pathname === "/token") {
				await body(req);
				return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 });
			}
			res.writeHead(404).end();
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	return {
		origin,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** 装上插件，拿到它经 `ctx.serve` 开出来的接口；`servers.json` 里只有一台指向假服务的 http 服务。 */
async function served(t: { after: (fn: () => Promise<void>) => void }): Promise<{ api: McpApi; origin: string }> {
	const fake = await fakeServer();
	const dir = await mkdtemp(join(tmpdir(), "plume-mcp-login-"));
	const effects: (() => void | Promise<void>)[] = [];
	let api: McpApi | undefined;
	const ctx = {
		dataDir: dir,
		appDataDir: dir,
		locale: () => "zh-CN",
		secrets,
		resources: { register: () => () => {} },
		log: { warn: () => {}, info: () => {}, error: () => {} },
		effect: (fn: () => void | Promise<void>) => void effects.push(fn),
		sessions: { onDeleted: () => {} },
		tools: { register: () => () => {} },
		hook: () => {},
		commands: { provide: () => {} },
		plugins: { list: () => [], onChange: () => {} },
		serve: (value: McpApi) => {
			api = value;
		},
	} as unknown as PluginContext;
	await writeServers(join(dir, "servers.json"), [{ id: "remote", name: "remote", transport: "http", url: `${fake.origin}/mcp`, enabled: true }], {});
	await mcpPlugin.apply(ctx);
	t.after(async () => {
		for (const fn of effects) await fn();
		await fake.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { api: api!, origin: fake.origin };
}

/** 授权页地址里浏览器授权完要跳回去的那一处。 */
function callbackOf(authorization: string, query: Record<string, string>): string {
	const url = new URL(authorization);
	const back = new URL(url.searchParams.get("redirect_uri")!);
	back.searchParams.set("state", url.searchParams.get("state")!);
	for (const [name, value] of Object.entries(query)) back.searchParams.set(name, value);
	return back.href;
}

const call = (controller = new AbortController()): CallContext => ({ signal: controller.signal });

test("登录先交回授权页的地址、不自己开浏览器；跳回来带着授权码就换成令牌，交回登录后的视图", async (t) => {
	const { api, origin } = await served(t);
	const login = api.login("remote", call());
	const first = await login.next();
	assert.equal(first.done, false);
	const authorization = String(first.value);
	assert.ok(authorization.startsWith(`${origin}/authorize?`), authorization);
	assert.match(new URL(authorization).searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
	const rest = login.next();
	assert.equal((await fetch(callbackOf(authorization, { code: "abc" }))).status, 200);
	const last = await rest;
	assert.equal(last.done, true);
	const view = last.value as McpView;
	assert.equal(view.servers[0]?.signedIn, true);
	assert.equal(view.servers[0]?.status.state, "connected");
});

test("界面取消时立刻放弃：不等到超时，回调端口跟着关掉", async (t) => {
	const { api } = await served(t);
	const controller = new AbortController();
	const login = api.login("remote", call(controller));
	const authorization = String((await login.next()).value);
	const cancelled = assert.rejects(login.next(), (error: Error) => error.name === "AbortError");
	controller.abort();
	await cancelled;
	await assert.rejects(fetch(callbackOf(authorization, { code: "late" })));
	assert.equal((await api.list()).servers[0]?.signedIn, false);
});

test("授权服务器拒绝时交回给人看的话；同一台再点一次登录，前一趟作废、新的一趟照常交出地址", async (t) => {
	const { api } = await served(t);
	const text = MESSAGES["zh-CN"];

	const denied = api.login("remote", call());
	const authorization = String((await denied.next()).value);
	const refused = assert.rejects(denied.next(), { message: text.loginProblem.denied("不给") });
	await fetch(callbackOf(authorization, { error: "access_denied", error_description: "不给" }));
	await refused;

	const before = api.login("remote", call());
	await before.next();
	const dropped = assert.rejects(before.next(), { message: text.loginProblem.replaced() });
	const again = api.login("remote", call());
	const next = again.next();
	await dropped;
	const second = await next;
	assert.equal(second.done, false);
	await again.return(undefined as never);
});
