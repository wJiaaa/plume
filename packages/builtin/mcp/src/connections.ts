/**
 * 每台 MCP 服务一格：连着、正在连、断了在重连、连不上、要登录、缺值、关着。一台慢的、坏的不拖住别的，也不拖住会话：
 * 连接都在后台走，连上了才把它的工具登记进工具表，彻底连不上、关了、改了启动方式就撤下。
 *
 * 连着的服务半路断了自己重连（间隔从 0.5 秒翻倍到 30 秒，最多 8 次），这期间工具留在工具表里，调用等它一会儿；
 * 连上之后稳定了 30 秒才把次数清零，起来就崩的服务不会无限重启。「每个会话一份」的服务，共用的那一格只用来列工具、
 * 给设置页看状态，真正的调用在第一次用到时为那个会话另起一份，会话删掉、配置改了就关。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Locale, PluginSecrets, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	ElicitRequestSchema,
	ErrorCode,
	McpError,
	type Progress,
	PromptListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { launchKey, type ServerConfig } from "./config.ts";
import { Forms } from "./elicitation.ts";
import { formFields, UnsupportedFormError } from "./form.ts";
import { MESSAGES } from "./messages.ts";
import { BackgroundOAuthProvider, login, type LoginReason, McpNeedsLogin, OAuthStore, usesOAuth } from "./oauth.ts";
import { missingFor, resolveServer } from "./placeholders.ts";
import { listPrompts, type PromptEntry, promptText } from "./prompts.ts";
import { listResources, type McpResources, type ResourceListing, resourceText } from "./resources.ts";
import { stdioEnv, TreeKillingStdioTransport } from "./stdio.ts";
import type { McpTool } from "./search.ts";
import { mcpResult, normalizeInputSchema, qualifiedToolName, sanitize } from "./tools.ts";
import { looksSecret } from "./vars.ts";
import type { Documents } from "./documents.ts";

/** 第一次跑 `npx`、`uvx` 要先下载，冷启动常常要一两分钟。 */
const CONNECT_TIMEOUT_MS = 120_000;
/** 一次调用既没有结果也没有进度多久算超时。报着进度的不限总时长：要它停的是人，人有停止按钮。 */
const CALL_TIMEOUT_MS = 5 * 60_000;
/** 断了在重连时，调用最多等它这么久。 */
const RECONNECT_WAIT_MS = 15_000;
const RECONNECT = { baseMs: 500, maxMs: 30_000, attempts: 8, stableMs: 30_000 };
const PAGES = 50;
const STDERR_LINES = 20;
const STDERR_LINE_CHARS = 500;
/** 进度最多这么密地推给界面：有的服务器每处理一行就报一次。 */
const PROGRESS_EVERY_MS = 200;

export type ServerState = "connecting" | "connected" | "reconnecting" | "failed" | "needs-login" | "missing" | "disabled";

export interface ServerStatus {
	state: ServerState;
	tools: { name: string; description: string }[];
	/** 连不上、断了的原因（服务器或 SDK 的原话）。 */
	error?: string;
	/** stdio 服务 stderr 的最后几行：起不来、半路崩掉时，原因多半写在这里。像密钥的值换成了 `[secret]`。 */
	stderr?: string;
	/** 在重连：这是第几次，一共几次。 */
	attempt?: { at: number; of: number };
	/** 还缺值的 `${NAME}` 空位。 */
	missing?: string[];
	/** 为什么要登录。 */
	loginReason?: LoginReason;
}

interface RawTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

interface Slot {
	server: ServerConfig;
	key: string;
	state: ServerState;
	/** 每次（重）连加一：旧连接迟到的回调认得出自己过期了。 */
	generation: number;
	client?: Client;
	transport?: Transport;
	tools: RawTool[];
	prompts: PromptEntry[];
	error?: string;
	stderr: string[];
	missing: string[];
	loginReason?: LoginReason;
	/** 连着的这一次断过几回了；稳定连满 `stableMs` 才清零。 */
	attempt: number;
	connectedAt: number;
	timer?: ReturnType<typeof setTimeout>;
	/** 等它连上的调用；状态一变就叫醒。 */
	waiters: Set<() => void>;
	/** 正在调这台服务的工具调用：服务中途要人填表时，经它问人。 */
	runs: Set<ToolRun>;
	unregister: (() => void)[];
}

export interface ConnectionsHost {
	register(tool: ToolDefinition): () => void;
	warn(message: string): void;
	/** 插件数据目录：OAuth 令牌存在这里。 */
	dataDir: string;
	/** 加密 OAuth 令牌。 */
	secrets: PluginSecrets;
	documents?: Documents;
	/** 界面语言：表单在等人时那句状态按它说。 */
	locale?: () => Locale;
}

export interface ConnectionsOptions {
	reconnect?: Partial<typeof RECONNECT>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function newSlot(server: ServerConfig): Slot {
	return {
		server,
		key: launchKey(server),
		state: "connecting",
		generation: 0,
		tools: [],
		prompts: [],
		stderr: [],
		missing: [],
		attempt: 0,
		connectedAt: 0,
		waiters: new Set(),
		runs: new Set(),
		unregister: [],
	};
}

export class Connections implements McpResources {
	/** 共用的那一格，按服务 id。 */
	private readonly slots = new Map<string, Slot>();
	/** 每个会话一份的：服务 id → 会话 id → 那一格。 */
	private readonly perSession = new Map<string, Map<string, Slot>>();
	private registered: McpTool[] = [];
	private closed = false;
	private readonly host: ConnectionsHost;
	private readonly policy: typeof RECONNECT;
	readonly oauth: OAuthStore;
	/** 服务中途要人填的表，卡片的回答经它交回。 */
	readonly forms: Forms;

	constructor(host: ConnectionsHost, options: ConnectionsOptions = {}) {
		this.host = host;
		this.forms = new Forms(() => (host.locale ? MESSAGES[host.locale()].formWaiting : undefined));
		this.policy = { ...RECONNECT, ...options.reconnect };
		this.oauth = new OAuthStore(host.dataDir, host.secrets);
	}

	/**
	 * 按配置对一遍：没了的、关掉的断开；新加的、改了启动方式的重连，给了 `retry` 时上次没连上的（连不上、要登录、缺值）
	 * 也重来；只改了名字或开关的重新登记工具（名字在工具名里）。连接在后台走，这里不等。
	 */
	sync(servers: readonly ServerConfig[], { retry }: { retry: boolean }): void {
		if (this.closed) return;
		const wanted = new Map(servers.filter((server) => server.enabled).map((server) => [server.id, server]));
		for (const [id, slot] of this.slots) {
			if (wanted.has(id)) continue;
			void this.stop(slot);
			this.slots.delete(id);
		}
		for (const id of this.perSession.keys()) {
			const server = wanted.get(id);
			if (!server?.perSession) this.closeSessions(id);
			else this.closeSessions(id, (slot) => slot.key !== launchKey(server));
		}
		let reregister = false;
		for (const server of wanted.values()) {
			const slot = this.slots.get(server.id);
			const key = launchKey(server);
			if (!slot) {
				const fresh = newSlot(server);
				this.slots.set(server.id, fresh);
				void this.start(fresh);
				continue;
			}
			const relabeled = slot.server.name !== server.name || slot.server.trustReadOnly !== server.trustReadOnly || slot.server.pinned !== server.pinned;
			slot.server = server;
			if (slot.key !== key || (retry && (slot.state === "failed" || slot.state === "needs-login" || slot.state === "missing"))) {
				slot.key = key;
				void this.restart(slot);
			} else if (relabeled) reregister = true;
		}
		if (reregister) this.registerTools();
	}

	/** 手动重连一台：关掉、立刻重连；每个会话一份的那些也关掉，下次用到时重起。 */
	async reconnect(id: string): Promise<void> {
		const slot = this.slots.get(id);
		this.closeSessions(id);
		if (slot && !this.closed) await this.restart(slot);
	}

	status(server: ServerConfig): ServerStatus {
		const slot = this.slots.get(server.id);
		if (!server.enabled || !slot) return { state: "disabled", tools: [] };
		const stderr = slot.stderr.join("\n").trim();
		const live = slot.state === "connected" || slot.state === "reconnecting";
		return {
			state: slot.state,
			tools: live ? slot.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })) : [],
			...(slot.error && slot.state !== "connected" ? { error: slot.error } : {}),
			...((slot.state === "failed" || slot.state === "reconnecting") && stderr ? { stderr } : {}),
			...(slot.state === "reconnecting" ? { attempt: { at: slot.attempt, of: this.policy.attempts } } : {}),
			...(slot.state === "missing" ? { missing: slot.missing } : {}),
			...(slot.state === "needs-login" && slot.loginReason ? { loginReason: slot.loginReason } : {}),
		};
	}

	/** 现在登记着的全部 MCP 工具（连着的、在重连的服务的），按服务的先后。 */
	tools(): McpTool[] {
		return this.registered;
	}

	/** 连着的服务各自的 prompt。 */
	prompts(): { server: ServerConfig; prompts: PromptEntry[] }[] {
		return [...this.slots.values()]
			.filter((slot) => slot.state === "connected" && slot.prompts.length > 0)
			.map((slot) => ({ server: slot.server, prompts: slot.prompts }));
	}

	/** 取一段填好参数的 prompt，换成文字。 */
	async getPrompt(id: string, prompt: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
		const slot = this.slots.get(id);
		const client = slot?.client;
		// i18n-exempt：调用方换成给人看的话。
		if (!slot || slot.state !== "connected" || !client) throw new Error(`MCP server is not connected`);
		const result = await client.getPrompt({ name: prompt, arguments: args }, { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
		return promptText(result.messages);
	}

	/**
	 * 连着的服务各自声明的资源，给 `mcp://`；`server` 是工具名里的那一段。一台列不出来就当它没有：一台出错不该让别的服务的
	 * 资源也看不见。每次现列、不缓存，`resources/list_changed` 也就不用管。
	 */
	async resources(): Promise<(ResourceListing & { server: string })[]> {
		const connected = [...this.slots.values()].filter((slot) => slot.state === "connected" && slot.client);
		const listed = await Promise.all(
			connected.map(async (slot) =>
				(await listResources(slot.client!, CONNECT_TIMEOUT_MS).catch(() => [])).map((resource) => ({ server: sanitize(slot.server.name), ...resource })),
			),
		);
		return listed.flat();
	}

	/** 读一个资源。每个会话一份的服务读这个会话自己的那一格，和调它的工具一样；正在连、在重连的等它一会儿。 */
	// i18n-exempt：报错交给模型。
	async readResource(server: string, uri: string, sessionId: string, signal?: AbortSignal): Promise<string> {
		const shared = [...this.slots.values()].find((slot) => sanitize(slot.server.name) === server);
		if (!shared) throw new Error(`没有叫“${server}”的 MCP 服务器。`);
		const slot = this.slotFor(shared, sessionId);
		await this.ready(slot, signal ?? new AbortController().signal);
		const client = slot.client;
		if (slot.state !== "connected" || !client) throw new Error(`MCP 服务器“${server}”没有连上。`);
		const result = await client.readResource({ uri }, { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
		return resourceText(uri, result.contents ?? []);
	}

	/** 用 OAuth 的服务现在有没有令牌。 */
	async signedIn(server: ServerConfig): Promise<boolean> {
		if (!usesOAuth(server)) return false;
		const env = await commandEnv();
		if (missingFor(server, env).length > 0) return false;
		return this.oauth.signedIn(resolveServer(server, env));
	}

	/** 登录（见 oauth.ts 的 `login`）：交出授权页的地址，等人授权完，成功后重连。 */
	async *login(server: ServerConfig, signal: AbortSignal): AsyncGenerator<string, void> {
		const resolved = resolveServer(server, await commandEnv());
		if (!usesOAuth(resolved)) return;
		yield* login(this.oauth, resolved, signal);
		await this.reconnect(server.id);
	}

	/** 退出登录：扔掉令牌，断开重连（于是变成「需要登录」）。 */
	async logout(server: ServerConfig): Promise<void> {
		const resolved = resolveServer(server, await commandEnv());
		if (!usesOAuth(resolved)) return;
		await this.oauth.forget(resolved);
		await this.reconnect(server.id);
	}

	/** 删掉一台服务时，连它注册来的客户端一起扔。 */
	async forgetLogin(server: ServerConfig): Promise<void> {
		const env = await commandEnv();
		if (!usesOAuth(server) || missingFor(server, env).length > 0) return;
		const resolved = resolveServer(server, env);
		if (usesOAuth(resolved)) await this.oauth.drop(resolved);
	}

	/** 会话删掉了：为它另起的那些连接关掉。 */
	closeSession(sessionId: string): void {
		for (const id of this.perSession.keys()) this.closeSessions(id, (_slot, session) => session === sessionId);
	}

	async closeAll(): Promise<void> {
		this.closed = true;
		const slots = [...this.slots.values(), ...[...this.perSession.values()].flatMap((sessions) => [...sessions.values()])];
		this.slots.clear();
		this.perSession.clear();
		await Promise.all(slots.map((slot) => this.stop(slot)));
	}

	private closeSessions(id: string, match: (slot: Slot, sessionId: string) => boolean = () => true): void {
		const sessions = this.perSession.get(id);
		if (!sessions) return;
		for (const [sessionId, slot] of sessions) {
			if (!match(slot, sessionId)) continue;
			sessions.delete(sessionId);
			void this.stop(slot);
		}
		if (sessions.size === 0) this.perSession.delete(id);
	}

	/** 这个会话调这台服务用哪一格：共用的，或者为这个会话另起的（第一次用到时起，坏了再用时重来）。 */
	private slotFor(shared: Slot, sessionId: string): Slot {
		if (!shared.server.perSession) return shared;
		const sessions = this.perSession.get(shared.server.id) ?? new Map<string, Slot>();
		this.perSession.set(shared.server.id, sessions);
		let slot = sessions.get(sessionId);
		if (!slot) {
			slot = newSlot(shared.server);
			sessions.set(sessionId, slot);
			void this.start(slot);
		} else if (slot.state === "failed") {
			slot.server = shared.server;
			void this.restart(slot);
		}
		return slot;
	}

	private settle(slot: Slot, state: ServerState): void {
		slot.state = state;
		for (const wake of [...slot.waiters]) wake();
	}

	/** 正在连、在重连的，等它有个结果：第一次连等到连接超时，重连最多等 `RECONNECT_WAIT_MS`。 */
	private async ready(slot: Slot, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + (slot.state === "connecting" ? CONNECT_TIMEOUT_MS : RECONNECT_WAIT_MS);
		while ((slot.state === "connecting" || slot.state === "reconnecting") && Date.now() < deadline && !signal.aborted) {
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					slot.waiters.delete(done);
					resolve();
				};
				const timer = setTimeout(done, deadline - Date.now());
				signal.addEventListener("abort", done);
				slot.waiters.add(done);
			});
		}
	}

	private async restart(slot: Slot): Promise<void> {
		// 重启的这一会儿算「连接中」，不让界面闪一下「已启用」。
		await this.stop(slot, "connecting");
		if (this.closed) return;
		await this.start(slot);
	}

	private async stop(slot: Slot, next: ServerState = "disabled"): Promise<void> {
		slot.generation++;
		clearTimeout(slot.timer);
		const { client, transport } = slot;
		const hadTools = slot.unregister.length > 0;
		slot.client = undefined;
		slot.transport = undefined;
		slot.tools = [];
		slot.prompts = [];
		slot.attempt = 0;
		this.settle(slot, next);
		if (hadTools) this.registerTools();
		// 关掉 client 会连带关掉 transport（stdio 的子进程跟着结束）；还没连上的只有 transport。
		await (client ?? transport)?.close().catch(() => {});
	}

	/** 断了：没到次数就隔一会儿再连，工具留着；到了次数就算连不上，撤下工具。 */
	private retry(slot: Slot, error: string): void {
		slot.attempt++;
		slot.error = error;
		const shared = this.slots.get(slot.server.id) === slot;
		if (slot.attempt > this.policy.attempts) {
			slot.attempt = 0;
			this.settle(slot, "failed");
			if (shared) this.registerTools();
			return;
		}
		this.settle(slot, "reconnecting");
		const generation = ++slot.generation;
		const delay = Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** (slot.attempt - 1));
		slot.timer = setTimeout(() => {
			if (!this.closed && slot.generation === generation) void this.start(slot);
		}, delay);
	}

	private async start(slot: Slot): Promise<void> {
		const generation = ++slot.generation;
		const stale = () => this.closed || slot.generation !== generation;
		const declared = slot.server;
		const shared = () => this.slots.get(declared.id) === slot;
		this.settle(slot, slot.attempt > 0 ? "reconnecting" : "connecting");
		if (slot.attempt === 0) slot.error = undefined;
		slot.stderr = [];
		slot.missing = [];
		slot.loginReason = undefined;
		try {
			const env = await commandEnv();
			if (stale()) return;
			const missing = missingFor(declared, env);
			if (missing.length > 0) {
				slot.missing = missing;
				slot.attempt = 0;
				this.settle(slot, "missing");
				if (shared()) this.registerTools();
				return;
			}
			const server = resolveServer(declared, env);
			const transport = await this.transportFor(server, slot);
			if (stale()) {
				await transport.close().catch(() => {});
				return;
			}
			slot.transport = transport;
			const client = new Client({ name: "plume", version: "0.1.0" }, { capabilities: { elicitation: { form: {} } } });
			client.setRequestHandler(ElicitRequestSchema, async (request) => {
				const params = request.params;
				// i18n-exempt：以下是回给服务的协议错误。
				if (params.mode === "url") throw new McpError(ErrorCode.InvalidParams, "URL-mode elicitation is not supported");
				let fields;
				try {
					fields = formFields(params.requestedSchema);
				} catch (error) {
					if (error instanceof UnsupportedFormError) throw new McpError(ErrorCode.InvalidParams, `Unsupported elicitation schema: ${error.message}`);
					throw error;
				}
				const [run, ...others] = slot.runs;
				if (!run || others.length > 0) return { action: "decline" };
				return this.forms.ask(run, declared, params.message, fields);
			});
			client.onclose = () => {
				if (stale() || slot.state !== "connected") return;
				slot.client = undefined;
				slot.transport = undefined;
				if (Date.now() - slot.connectedAt >= this.policy.stableMs) slot.attempt = 0;
				// i18n-exempt：和服务器的原话一样直接显示。
				this.retry(slot, "The server closed the connection.");
			};
			await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
			if (stale()) {
				await client.close().catch(() => {});
				return;
			}
			slot.client = client;
			const capabilities = client.getServerCapabilities();
			if (capabilities?.tools?.listChanged) {
				client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
					void listTools(client).then(
						(tools) => {
							if (stale() || slot.state !== "connected") return;
							slot.tools = tools;
							if (shared()) this.registerTools();
						},
						// i18n-exempt：日志。
						(error: unknown) => this.host.warn(`${declared.name} 的工具表变了，重新列出时出错：${message(error)}`),
					);
				});
			}
			if (capabilities?.prompts?.listChanged) {
				client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
					void listPrompts(client, CONNECT_TIMEOUT_MS).then(
						(prompts) => {
							if (!stale()) slot.prompts = prompts;
						},
						() => {},
					);
				});
			}
			slot.tools = await listTools(client);
			// prompt 列不出来不算连不上：工具照样能用。
			slot.prompts = await listPrompts(client, CONNECT_TIMEOUT_MS).catch(() => []);
			if (stale()) return;
			slot.error = undefined;
			slot.connectedAt = Date.now();
			this.settle(slot, "connected");
			if (shared()) this.registerTools();
		} catch (error) {
			if (stale()) return;
			const { transport } = slot;
			slot.transport = undefined;
			slot.client = undefined;
			await transport?.close().catch(() => {});
			if (stale()) return;
			if (error instanceof McpNeedsLogin || error instanceof UnauthorizedError) {
				slot.loginReason = error instanceof McpNeedsLogin ? error.reason : "expired";
				slot.error = message(error);
				slot.attempt = 0;
				this.settle(slot, "needs-login");
				if (shared()) this.registerTools();
				return;
			}
			if (slot.attempt > 0) {
				this.retry(slot, message(error));
				return;
			}
			slot.error = message(error);
			this.settle(slot, "failed");
		}
	}

	private async transportFor(server: ServerConfig, slot: Slot): Promise<Transport> {
		if (server.transport === "stdio") {
			const stdio = new TreeKillingStdioTransport({
				command: server.command,
				args: server.args ?? [],
				env: stdioEnv(await commandEnv(), server.env),
				stderr: "pipe",
			});
			// 服务器把自己的配置连同密钥一起打到 stderr 上并不少见；这段文字要进设置页。
			const secrets = Object.entries(server.env ?? {})
				.filter(([name, value]) => looksSecret(name) && value.length >= 6)
				.map(([, value]) => value);
			let partial = "";
			stdio.stderr?.on("data", (chunk: Buffer | string) => {
				let text = partial + String(chunk);
				for (const secret of secrets) text = text.split(secret).join("[secret]");
				const lines = text.split(/\r?\n/);
				partial = (lines.pop() ?? "").slice(0, STDERR_LINE_CHARS);
				for (const line of lines) if (line.trim()) slot.stderr.push(line.slice(0, STDERR_LINE_CHARS));
				if (slot.stderr.length > STDERR_LINES) slot.stderr.splice(0, slot.stderr.length - STDERR_LINES);
			});
			return stdio;
		}
		const url = new URL(server.url);
		const requestInit = { headers: server.headers ?? {} };
		const oauth = usesOAuth(server) ? await BackgroundOAuthProvider.for(this.oauth, server) : undefined;
		const auth = oauth ? { authProvider: oauth, fetch: oauth.fetch } : {};
		return server.transport === "sse"
			? new SSEClientTransport(url, { requestInit, ...auth })
			: new StreamableHTTPClientTransport(url, { requestInit, ...auth });
	}

	/**
	 * 按服务的先后重新登记全部工具：名字跨服务去重（清洗后撞上的换成带哈希的那个），所以一台变了整张表重来。
	 * 工具不握着某一条连接，执行时再定用哪一格、向它要现在的 client。
	 */
	private registerTools(): void {
		const taken = new Set<string>();
		const registered: McpTool[] = [];
		for (const slot of this.slots.values()) {
			for (const unregister of slot.unregister.splice(0)) unregister();
			if (slot.state !== "connected" && slot.state !== "reconnecting") continue;
			for (const raw of slot.tools) {
				const name = qualifiedToolName(slot.server.name, raw.name, taken);
				taken.add(name);
				const definition = this.toolFor(slot, raw, name);
				slot.unregister.push(this.host.register(definition));
				registered.push({
					name,
					server: { id: slot.server.id, name: slot.server.name },
					tool: raw.name,
					description: definition.description,
					parameters: definition.parameters,
					readOnly: definition.mutating === false,
					pinned: slot.server.pinned === true,
					execute: definition.execute,
				});
			}
		}
		this.registered = registered;
	}

	private toolFor(shared: Slot, raw: RawTool, name: string): ToolDefinition {
		/*
		 * 注解是服务器自己说的，规范明说不可信，所以只往谨慎的方向起作用：自称只读又自称破坏的按破坏算；`readOnlyHint` 单凭
		 * 它不免审批，人在设置里打开这台服务的「信任只读声明」之后，「帮我批准」下才不再逐次问。只读还决定能不能和相邻的
		 * 只读调用同时跑：说错的代价是两个调用同时跑，不是越权。
		 */
		const destructive = raw.annotations?.destructiveHint === true;
		const readOnly = raw.annotations?.readOnlyHint === true && !destructive;
		return {
			name,
			// i18n-exempt：写给模型的工具说明。
			description: raw.description ?? `${raw.name} (from MCP server ${shared.server.name})`,
			parameters: normalizeInputSchema(raw.inputSchema),
			mutating: !readOnly,
			asks: true,
			category: "mcp",
			// i18n-exempt：导出会话成 Markdown 时的一行，导出是英文的。
			describe: () => `${name.split("__")[1]}: ${name.split("__")[2]}`,
			execute: (args, run) => this.call(shared, raw, name, readOnly, args, run),
		};
	}

	private async call(shared: Slot, raw: RawTool, name: string, readOnly: boolean, args: Record<string, unknown>, run: ToolRun): Promise<ToolOutput> {
		const server = shared.server;
		const trusted = readOnly && server.trustReadOnly === true && (await run.permissionMode()) !== "ask";
		if (!trusted) {
			const decision = await run.ask({
				kind: "mcp",
				title: `${server.name} → ${raw.name}`,
				detail: JSON.stringify(args, null, 2).slice(0, 2000),
				subject: name,
			});
			// i18n-exempt：以下都是交给模型的结果。
			if (decision === "reject") return { output: run.rejection, isError: true };
		}
		const slot = this.slotFor(shared, run.sessionId);
		await this.ready(slot, run.signal);
		const client = slot.client;
		if (slot.state !== "connected" || !client) {
			const why =
				slot.state === "connecting" || slot.state === "reconnecting"
					? "is still reconnecting"
					: slot.state === "needs-login"
						? "needs the user to sign in (Marketplace › Connectors)"
						: "is not connected";
			return { output: `MCP call failed: "${server.name}" ${why}.${explain(slot)}`, isError: true };
		}
		let shown = 0;
		// 给了 `onprogress`，SDK 才在请求里带 progressToken，服务器的进度通知才会来，超时才会被它重置。
		const onprogress = (progress: Progress) => {
			const now = Date.now();
			if (now - shown < PROGRESS_EVERY_MS) return;
			shown = now;
			const amount = progress.total !== undefined ? `${progress.progress}/${progress.total}` : String(progress.progress);
			run.progress(`${progress.message ? `${amount} · ${progress.message}` : amount}\n`);
		};
		slot.runs.add(run);
		try {
			const response = await client.callTool({ name: raw.name, arguments: args }, undefined, {
				signal: run.signal,
				timeout: CALL_TIMEOUT_MS,
				resetTimeoutOnProgress: true,
				onprogress,
			});
			// 大图和太长的全文存进这个会话的临时目录：随会话删掉，read 读它不用问人。
			run.signal.throwIfAborted();
			const result = mcpResult(
				response,
				run.scratchDir,
				(uri, mime, blob) => this.host.documents?.save(run.sessionId, uri, mime, blob) ?? null,
				run.tools().find((tool) => tool.kind === "view")?.name,
			);
			return {
				output: result.output,
				...(result.images.length > 0 ? { images: result.images } : {}),
				...(result.shown.length > 0 ? { shownImages: result.shown } : {}),
				...(response.isError === true ? { isError: true } : {}),
				details: {
					server: server.name,
					tool: raw.name,
					...(result.documents ? { documents: result.documents } : {}),
				},
			};
		} catch (error) {
			if (error instanceof McpError && error.code === ErrorCode.RequestTimeout && !run.signal.aborted) {
				return {
					output: `MCP call timed out: "${server.name}" sent neither a result nor progress for ${CALL_TIMEOUT_MS / 60_000} minutes, so the call was cancelled.${explain(slot)}`,
					isError: true,
				};
			}
			return { output: `MCP call failed: ${message(error)}${explain(slot)}`, isError: true };
		} finally {
			slot.runs.delete(run);
		}
	}
}

/** 调用失败时补在后面的话：服务断了的话，带上它 stderr 的最后几行。 */
function explain(slot: Slot): string {
	if (slot.state === "connected" || slot.stderr.length === 0) return "";
	return `\n\nThe server's last stderr output:\n${slot.stderr.slice(-5).join("\n")}`;
}

async function listTools(client: Client): Promise<RawTool[]> {
	const tools: RawTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < PAGES; page++) {
		const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
		tools.push(...(listed.tools as RawTool[]));
		cursor = listed.nextCursor;
		if (!cursor) break;
	}
	return tools;
}

const ENV_MARK = "__PLUME_MCP_ENV__";
const ENV_TIMEOUT_MS = 5000;
let loginEnv: Promise<Record<string, string>> | undefined;

/**
 * 起 stdio 服务、填 `${NAME}` 空位用的环境。从图标启动的应用只从 launchd 拿到 `/usr/bin:/bin:/usr/sbin:/sbin`，`npx`、`uvx`
 * 找不到，`~/.zshrc` 里导出的令牌也看不到；所以第一次用时问一遍用户的登录 shell（`-l -i`，登录文件和 `~/.zshrc` 都读）
 * 它会给终端什么环境，之后一直用这一份。本进程是从终端启动的，或者问不到时，用继承来的环境。Windows 上也用继承来的：
 * 那边没有登录 shell，PATH 由注册表给全。
 */
function commandEnv(): Promise<Record<string, string>> {
	return (loginEnv ??= (async () => {
		const inherited = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
		const shell = process.env.SHELL;
		const term = process.env.TERM;
		if (process.platform === "win32" || (term && term !== "dumb") || process.env.TERM_PROGRAM || !shell || !existsSync(shell)) return inherited;
		const stdout = await new Promise<string>((resolve) => {
			execFile(
				shell,
				["-l", "-i", "-c", `printf ${ENV_MARK}; /usr/bin/env -0; printf ${ENV_MARK}`],
				{ timeout: ENV_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: inherited },
				(_error, out) => resolve(String(out ?? "")),
			);
		});
		const answer = stdout.split(ENV_MARK)[1];
		if (!answer) return inherited;
		const env: Record<string, string> = {};
		for (const pair of answer.split("\0")) {
			const at = pair.indexOf("=");
			if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
		}
		// 描述 shell 自己的那几个不要：它们是那次询问的，不是用户的。
		for (const key of ["SHLVL", "PWD", "OLDPWD", "_"]) delete env[key];
		return env.PATH ? { ...inherited, ...env } : inherited;
	})());
}
