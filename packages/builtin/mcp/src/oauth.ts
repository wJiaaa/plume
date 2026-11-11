/**
 * 远程 MCP 服务的 OAuth 登录。没在请求头里写 `Authorization` 的 http、sse 服务按 OAuth 处理：服务说要鉴权（401）时，
 * 状态变成「需要登录」，人在设置页点「登录」，浏览器里授权，令牌存进插件数据目录（每台一个文件，权限 0600，
 * 整份经服务 `secrets` 加密），之后连接时带上、过期了用刷新令牌换新的。令牌只在 agent 进程里，不进界面。
 *
 * 后台连接用的 `BackgroundOAuthProvider` 从不开浏览器：要人做的事（第一次授权、刷新失效、要更大的权限）一律抛
 * `McpNeedsLogin`，等人点「登录」走 `login`。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretsService } from "@plume/contract";
import { type HttpServer, type ServerConfig, writePrivate } from "./config.ts";

interface OAuthRecord {
	/** 记录对应的服务地址：地址改了，旧的令牌不带过去。 */
	serverUrl: string;
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	discovery?: OAuthDiscoveryState;
	/** 服务说权限不够（403 insufficient_scope）时要的范围，下次登录一起要。 */
	stepUpScope?: string;
	expiresAt?: number;
}

/** 为什么要登录：设置页按它说一句话。 */
export type LoginReason = "never" | "expired" | "scope" | "issuer";

export class McpNeedsLogin extends Error {
	readonly reason: LoginReason;
	constructor(server: string, reason: LoginReason) {
		// i18n-exempt：给日志和模型看的原因，设置页按 `reason` 另说。
		super(`MCP server "${server}" needs you to sign in (${reason}). Sign in under Marketplace › Connectors.`);
		this.name = "McpNeedsLogin";
		this.reason = reason;
	}
}

const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** 离过期不到这么久就先换新：调用中途过期，要多等一个来回才知道。 */
const REFRESH_AHEAD_MS = 60_000;

export function usesOAuth(server: ServerConfig): server is HttpServer {
	if (server.transport === "stdio") return false;
	return !Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function clientMetadata(redirectUrl: string, scope?: string): OAuthClientMetadata {
	return {
		client_name: "Plume",
		redirect_uris: [redirectUrl],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...(scope ? { scope } : {}),
	};
}

function mergeScopes(...lists: (string | undefined)[]): string | undefined {
	const all = [...new Set(lists.flatMap((list) => list?.split(/\s+/).filter(Boolean) ?? []))];
	return all.length ? all.join(" ") : undefined;
}

function withTokens(record: OAuthRecord, tokens: OAuthTokens): OAuthRecord {
	const { expiresAt: _old, ...rest } = record;
	return { ...rest, tokens, ...(typeof tokens.expires_in === "number" ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}) };
}

function sameUrl(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return a === b;
	}
}

/** 一台服务的令牌文件，内容是整条记录加密后的文本。只有这个插件读写，同一个文件的改动排着队来。 */
export class OAuthStore {
	private readonly dir: string;
	private readonly secrets: SecretsService;
	private readonly queue = new Map<string, Promise<unknown>>();

	constructor(dataDir: string, secrets: SecretsService) {
		this.dir = join(dataDir, "oauth");
		this.secrets = secrets;
	}

	private name(id: string): string {
		return `${createHash("sha256").update(id).digest("hex").slice(0, 16)}.json`;
	}

	private file(server: HttpServer): string {
		return join(this.dir, this.name(server.id));
	}

	/**
	 * 解不开（钥匙换过）、读不懂的当成没登录过。钥匙文件读不出来时 `unseal` 抛错，这里不接：`update` 拿着空记录写回去
	 * 就把还能解开的令牌盖掉了。
	 */
	async read(server: HttpServer): Promise<OAuthRecord> {
		const sealed = await readFile(this.file(server), "utf8").catch(() => null);
		const raw = sealed === null ? null : await this.secrets.unseal(sealed.trim());
		try {
			const parsed = raw ? (JSON.parse(raw) as OAuthRecord) : null;
			return parsed && parsed.serverUrl === server.url ? parsed : { serverUrl: server.url };
		} catch {
			return { serverUrl: server.url };
		}
	}

	update(server: HttpServer, change: (record: OAuthRecord) => OAuthRecord | null): Promise<void> {
		const file = this.file(server);
		const run = (this.queue.get(file) ?? Promise.resolve()).then(async () => {
			const next = change(await this.read(server));
			if (!next) {
				await rm(file, { force: true });
				return;
			}
			await mkdir(this.dir, { recursive: true, mode: 0o700 });
			await writePrivate(file, await this.secrets.seal(JSON.stringify(next)));
		});
		this.queue.set(
			file,
			run.catch(() => {}),
		);
		return run;
	}

	/** 退出登录：令牌扔掉，注册来的客户端留着，下次登录不用再注册一遍。 */
	forget(server: HttpServer): Promise<void> {
		return this.update(server, ({ client, serverUrl }) => (client ? { serverUrl, client } : null));
	}

	/** 删掉这台服务时连客户端一起扔。 */
	drop(server: HttpServer): Promise<void> {
		return this.update(server, () => null);
	}

	/** 只留这些服务的登录，别的令牌文件删掉。文件名是 id 的哈希，所以按名字比；排着队的写入等它写完再删。 */
	async keepOnly(servers: readonly Pick<ServerConfig, "id">[]): Promise<void> {
		const keep = new Set(servers.map((server) => this.name(server.id)));
		const names = await readdir(this.dir).catch(() => [] as string[]);
		await Promise.all(
			names
				.filter((name) => name.endsWith(".json") && !keep.has(name))
				.map(async (name) => {
					const file = join(this.dir, name);
					await this.queue.get(file);
					await rm(file, { force: true });
				}),
		);
	}

	async signedIn(server: ServerConfig): Promise<boolean> {
		if (!usesOAuth(server)) return false;
		const record = await this.read(server);
		return Boolean(record.tokens) && !record.stepUpScope;
	}
}

/** 同一个刷新令牌只拿去换一次：并发的几次请求一起过期时，轮换式的刷新令牌用第二次就作废了。 */
const refreshing = new Map<string, Promise<Response>>();

/** 后台连接用：只用存下的令牌，需要人的时候抛 `McpNeedsLogin`。 */
export class BackgroundOAuthProvider implements OAuthClientProvider {
	private steppingUp = false;
	private lapsed = false;
	private ahead: Promise<void> | undefined;
	private readonly store: OAuthStore;
	private readonly server: HttpServer;
	private record: OAuthRecord;

	private constructor(store: OAuthStore, server: HttpServer, record: OAuthRecord) {
		this.store = store;
		this.server = server;
		this.record = record;
	}

	static async for(store: OAuthStore, server: HttpServer): Promise<BackgroundOAuthProvider> {
		return new BackgroundOAuthProvider(store, server, await store.read(server));
	}

	get redirectUrl(): string {
		const registered = this.record.client && "redirect_uris" in this.record.client ? this.record.client.redirect_uris[0] : undefined;
		return registered ? String(registered) : `http://127.0.0.1${CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return clientMetadata(this.redirectUrl);
	}

	clientInformation(): OAuthClientInformationMixed {
		const client = this.record.client;
		if (!client) throw this.needsLogin("never");
		// 授权服务器换了，在旧的那里注册的客户端在新的那里不认。
		const issuer = typeof client.issuer === "string" ? client.issuer : undefined;
		const current = this.record.discovery?.authorizationServerUrl;
		if (issuer && current && !sameUrl(issuer, current)) throw this.needsLogin("issuer");
		return client;
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		await this.reread();
		if (!this.ahead && this.dueForRefresh()) {
			this.ahead = auth(this, { serverUrl: this.server.url, fetchFn: this.fetch })
				.then(() => {})
				.catch(() => {})
				.finally(() => {
					this.ahead = undefined;
				});
			await this.ahead;
			await this.reread();
		}
		const tokens = this.record.tokens;
		if (!tokens) return undefined;
		// 要更大的权限时刷新令牌换不来：藏起来，SDK 才会走授权，进而抛「需要登录」。
		if (this.steppingUp || this.record.stepUpScope) {
			const { refresh_token: _spent, ...rest } = tokens;
			return rest;
		}
		return tokens;
	}

	/** 另一条连接（每个会话一份的）可能刚换了令牌，每次都从文件读。 */
	private async reread(): Promise<void> {
		this.record = { ...(await this.store.read(this.server)), ...(this.record.discovery ? { discovery: this.record.discovery } : {}) };
	}

	private dueForRefresh(): boolean {
		const { tokens, expiresAt, stepUpScope } = this.record;
		if (!tokens?.refresh_token || expiresAt === undefined || this.steppingUp || stepUpScope) return false;
		const ahead = typeof tokens.expires_in === "number" ? Math.min(REFRESH_AHEAD_MS, (tokens.expires_in * 1000) / 2) : REFRESH_AHEAD_MS;
		return expiresAt - Date.now() < ahead;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.record = withTokens(this.record, tokens);
		await this.store.update(this.server, (record) => withTokens(record, tokens));
	}

	redirectToAuthorization(): never {
		throw this.needsLogin(this.steppingUp || this.record.stepUpScope ? "scope" : this.record.tokens || this.lapsed ? "expired" : "never");
	}

	saveCodeVerifier(): void {}

	codeVerifier(): never {
		throw this.needsLogin("never");
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "verifier") return;
		if ((scope === "all" || scope === "tokens") && this.record.tokens) this.lapsed = true;
		// 只扔掉自己用过的那份：另一条连接可能已经换来了新的。
		const used = this.record.tokens?.refresh_token;
		const drop = (record: OAuthRecord): OAuthRecord => {
			if (scope === "all") return { serverUrl: record.serverUrl };
			if (scope === "tokens" && record.tokens?.refresh_token !== used) return record;
			const { [scope]: _gone, ...rest } = record;
			return rest;
		};
		this.record = drop(this.record);
		await this.store.update(this.server, drop);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.record.discovery;
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		if (!state.authorizationServerMetadata && !state.resourceMetadata) {
			// i18n-exempt：和服务器、SDK 的原话一样直接显示在设置页上。
			throw new Error(
				`MCP server "${this.server.name}" requires authentication (401) but offers no OAuth metadata. If it wants an API key, add an Authorization header.`,
			);
		}
		this.record = { ...this.record, discovery: state };
		await this.store.update(this.server, (record) => ({ ...record, discovery: state }));
	}

	readonly fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
		const response = await this.refreshOnce(url, init);
		if (response.status === 403) {
			const { error, scope } = extractWWWAuthenticateParams(response);
			if (error === "insufficient_scope") {
				this.steppingUp = true;
				const wanted = mergeScopes(this.record.stepUpScope, scope);
				if (wanted) {
					this.record = { ...this.record, stepUpScope: wanted };
					await this.store.update(this.server, (record) => ({ ...record, stepUpScope: mergeScopes(record.stepUpScope, wanted) }));
				}
			}
		}
		return response;
	};

	private async refreshOnce(url: string | URL, init?: RequestInit): Promise<Response> {
		const body = init?.body;
		const grant = body instanceof URLSearchParams && body.get("grant_type") === "refresh_token" ? body.get("refresh_token") : null;
		if (!grant) return fetch(url, init);
		const running = refreshing.get(grant);
		if (running) return (await running).clone();
		const request = fetch(url, init);
		refreshing.set(grant, request);
		try {
			return (await request).clone();
		} finally {
			setTimeout(() => refreshing.delete(grant), 5_000).unref?.();
		}
	}

	private needsLogin(reason: LoginReason): McpNeedsLogin {
		return new McpNeedsLogin(this.server.name, reason);
	}
}

/** 登录时出的、要给人看的错：设置页按 `code` 说话，`detail` 是授权服务器的原话。 */
export class LoginError extends Error {
	readonly code: "timeout" | "denied" | "noCode" | "badUrl" | "noMetadata";
	readonly detail: string;
	constructor(code: LoginError["code"], detail = "") {
		super(`${code}${detail ? `: ${detail}` : ""}`);
		this.name = "LoginError";
		this.code = code;
		this.detail = detail;
	}
}

const loggingIn = new Map<string, Promise<void>>();

/**
 * 在浏览器里登录：本机起一个回调地址，开授权页，等授权服务器带着授权码跳回来，换成令牌存下。
 * 同一台服务同时只走一趟：人连点两下「登录」不开两个页面。
 */
export function login(store: OAuthStore, server: HttpServer, open: (url: string) => Promise<void>): Promise<void> {
	const existing = loggingIn.get(server.id);
	if (existing) return existing;
	const run = loginOnce(store, server, open).finally(() => loggingIn.delete(server.id));
	loggingIn.set(server.id, run);
	return run;
}

async function loginOnce(store: OAuthStore, server: HttpServer, open: (url: string) => Promise<void>): Promise<void> {
	const challenge = await challengeOf(server);
	// 上次发现的授权服务器可能已经换了：重新发现。
	await store.update(server, ({ discovery: _stale, ...rest }) => rest);
	const before = await store.read(server);
	const scope = mergeScopes(challenge.scope, before.stepUpScope, before.tokens?.scope);
	// 注册过的客户端绑着当时的回调端口：先试那个端口，被占了就换一个、重新注册。
	const registered = loopbackPort(before.client);
	const callback = await listen(registered ?? 0).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EADDRINUSE" || registered === undefined) throw error;
		return listen(0);
	});
	try {
		if (registered !== undefined && callback.port !== registered) await store.update(server, ({ client: _old, ...rest }) => rest);
		const provider = new LoginProvider(store, server, await store.read(server), `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`, scope, open);
		const request = {
			serverUrl: server.url,
			...(scope ? { scope } : {}),
			...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
		};
		if ((await auth(provider, request)) === "AUTHORIZED") return;
		const code = await callback.code(provider.expectedState, LOGIN_TIMEOUT_MS);
		await auth(provider, { ...request, authorizationCode: code });
	} finally {
		callback.close();
	}
}

/** 先不带令牌敲一下门，看它在 `WWW-Authenticate` 里说要哪份元数据、什么范围。 */
async function challengeOf(server: HttpServer): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 15_000);
	try {
		const response =
			server.transport === "sse"
				? await fetch(server.url, { headers: { accept: "text/event-stream" }, signal: abort.signal })
				: await fetch(server.url, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 0,
							method: "initialize",
							params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plume", version: "0.1.0" } },
						}),
						signal: abort.signal,
					});
		await response.body?.cancel().catch(() => {});
		if (response.status !== 401 && response.status !== 403) return {};
		const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
		return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
}

function loopbackPort(client: OAuthClientInformationMixed | undefined): number | undefined {
	const uri = client && "redirect_uris" in client ? client.redirect_uris[0] : undefined;
	if (!uri) return undefined;
	try {
		const url = new URL(String(uri));
		return url.hostname === "127.0.0.1" && url.port ? Number(url.port) : undefined;
	} catch {
		return undefined;
	}
}

interface Callback {
	port: number;
	code(state: string, timeoutMs: number): Promise<string>;
	close(): void;
}

function listen(port: number): Promise<Callback> {
	let deliver: ((query: URLSearchParams) => void) | undefined;
	const arrived: URLSearchParams[] = [];
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404).end();
			return;
		}
		const failed = url.searchParams.has("error");
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		// i18n-exempt：浏览器里的回执页，不知道界面语言，两种都写。
		res.end(
			page(
				failed
					? "登录没有完成，回到 Plume 再试一次。<br>Sign-in did not finish. Go back to Plume and try again."
					: "登录完成，可以关掉这一页了。<br>Signed in. You can close this tab.",
			),
		);
		if (deliver) deliver(url.searchParams);
		else arrived.push(url.searchParams);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : port,
				code: (state, timeoutMs) =>
					new Promise<string>((done, fail) => {
						const timer = setTimeout(() => fail(new LoginError("timeout")), timeoutMs);
						deliver = (query) => {
							// 别的页面、旧的登录跳回来的不算。
							if (query.get("state") !== state) return;
							clearTimeout(timer);
							const error = query.get("error");
							const code = query.get("code");
							if (error) fail(new LoginError("denied", query.get("error_description") ?? error));
							else if (!code) fail(new LoginError("noCode"));
							else done(code);
						};
						for (const query of arrived.splice(0)) deliver(query);
					}),
				close: () => {
					server.closeAllConnections?.();
					server.close();
				},
			});
		});
	});
}

function page(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>Plume</title><body style="font:15px system-ui;margin:4rem;text-align:center">${message}</body>`;
}

class LoginProvider implements OAuthClientProvider {
	readonly expectedState = randomBytes(24).toString("base64url");
	private verifier = "";
	private readonly store: OAuthStore;
	private readonly server: HttpServer;
	private record: OAuthRecord;
	private readonly redirect: string;
	private readonly scope: string | undefined;
	private readonly open: (url: string) => Promise<void>;

	constructor(store: OAuthStore, server: HttpServer, record: OAuthRecord, redirect: string, scope: string | undefined, open: (url: string) => Promise<void>) {
		this.store = store;
		this.server = server;
		this.record = record;
		this.redirect = redirect;
		this.scope = scope;
		this.open = open;
	}

	get redirectUrl(): string {
		return this.redirect;
	}

	get clientMetadata(): OAuthClientMetadata {
		return clientMetadata(this.redirect, this.scope);
	}

	state(): string {
		return this.expectedState;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.record.client;
	}

	async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
		this.record = { ...this.record, client };
		await this.store.update(this.server, (record) => ({ ...record, client }));
	}

	/** 登录就是要一份新的：不拿旧令牌去试。 */
	tokens(): OAuthTokens | undefined {
		return undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.store.update(this.server, ({ stepUpScope: _granted, ...record }) => withTokens(record, tokens));
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new LoginError("badUrl", url.protocol);
		await this.open(url.href);
	}

	saveCodeVerifier(verifier: string): void {
		this.verifier = verifier;
	}

	codeVerifier(): string {
		return this.verifier;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "verifier") return;
		const drop = (record: OAuthRecord): OAuthRecord => {
			if (scope === "all") return { serverUrl: record.serverUrl };
			const { [scope]: _gone, ...rest } = record;
			return rest;
		};
		this.record = drop(this.record);
		await this.store.update(this.server, drop);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.record.discovery;
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		if (!state.authorizationServerMetadata && !state.resourceMetadata) throw new LoginError("noMetadata");
		this.record = { ...this.record, discovery: state };
		await this.store.update(this.server, (record) => ({ ...record, discovery: state }));
	}
}
