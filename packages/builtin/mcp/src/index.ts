/**
 * plume.mcp 的逻辑入口，跑在 agent 进程：按插件数据目录里的 `servers.json` 连上每台开着的 MCP 服务，把它们的工具以
 * `mcp__<服务>__<工具>` 登记进工具表，每次调用前经审批问人；工具多了改成按需搜索（`mcp_search`、`mcp_call`），
 * 服务的 prompt 进 `/` 菜单，服务声明的资源经资源地址 `mcp://` 给 read 读（`resources.ts`），服务中途要人填的表经那次调用的审批问人（`elicitation.ts`）。设置页经 `ctx.serve` 列服务和状态、
 * 添加、编辑、开关、重连、填值、登录；表单卡经它交回填的值。Magpie 资源库分发的服务从数据目录的 `magpie/mcp.json`
 * 一起读进来，只读：状态、重连、登录照常，改动在 Magpie 里做。
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, SlashCommand } from "@plume/contract";
import type { McpApi, McpView, ServerView, VarView } from "./api.ts";
import { applyDraft, checkDraft, readMagpieServers, readServers, type ServerConfig, withValues, writeServers } from "./config.ts";
import { Connections } from "./connections.ts";
import { Documents } from "./documents.ts";
import { LoginError, usesOAuth } from "./oauth.ts";
import { MESSAGES } from "./messages.ts";
import { argumentHint, bindArguments, commandSegment, type PromptEntry } from "./prompts.ts";
import { mcpResource } from "./resources.ts";
import { openServers, sealServers } from "./sealed.ts";
import { callTool, DEFER_TOKENS, deferredSection, MCP_CALL, MCP_SEARCH, searchTool, toolTokens } from "./search.ts";
import { ENV_NAME, looksSecret } from "./vars.ts";

/** 重连时等多久就先交回界面：连得慢的，界面看到「连接中」接着自己问。 */
const RECONNECT_WAIT_MS = 15_000;

function viewOf(vars: Record<string, string> | undefined): VarView[] {
	return Object.entries(vars ?? {}).map(([name, value]) =>
		looksSecret(name) ? { name, secret: true, filled: value !== "" } : { name, value, secret: false, filled: value !== "" },
	);
}

/**
 * 交给系统的默认浏览器。Windows 上不经 cmd 的 `start`：网址里的 `&` 会被它当成命令分隔符，登录地址的后半截被当成命令跑；
 * `url.dll` 的 FileProtocolHandler 把整条网址原样交给系统的默认浏览器。
 */
function openUrl(url: string): Promise<void> {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	return new Promise((resolve, reject) => execFile(command as string, args as string[], (error) => (error ? reject(error) : resolve())));
}

/** Magpie 资源库把 MCP 服务写在 Plume 数据目录下的这个文件里；设了 `PLUME_HOME` 时整个数据目录在那里。 */
function magpieFile(): string {
	return join(process.env.PLUME_HOME || join(homedir(), ".plume"), "magpie", "mcp.json");
}

/** `/` 菜单里的 prompt 命令：`mcp:<服务>:<prompt>`，折过以后撞名的加编号。 */
function promptCommands(entries: { server: ServerConfig; prompts: PromptEntry[] }[]): { name: string; server: ServerConfig; entry: PromptEntry }[] {
	const taken = new Set<string>();
	const out: { name: string; server: ServerConfig; entry: PromptEntry }[] = [];
	for (const { server, prompts } of entries) {
		const prefix = `mcp:${commandSegment(server.name) || "server"}`;
		prompts.forEach((entry, index) => {
			const base = `${prefix}:${commandSegment(entry.prompt) || String(index + 1)}`;
			let name = base;
			for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
			taken.add(name);
			out.push({ name, server, entry });
		});
	}
	return out;
}

export default {
	name: "plume.mcp",
	inject: ["resources", "secrets"],
	apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
		const file = join(ctx.dataDir, "servers.json");
		const secrets = ctx.use("secrets");
		const documents = new Documents(join(ctx.dataDir, "documents"));
		const connections = new Connections({
			register: (tool) => ctx.tools.register(tool),
			warn: (message) => ctx.log.warn(message),
			dataDir: ctx.dataDir,
			secrets,
			documents,
			locale: () => ctx.locale(),
		});
		ctx.effect(() => connections.closeAll());
		ctx.effect(ctx.use("resources").register(mcpResource(connections)));

		/** 已经改成按需搜索的会话：改过去就不改回来，免得工具表在会话中途来回变。 */
		const deferred = new Set<string>();
		ctx.sessions.onDeleted((sessionId) => {
			deferred.delete(sessionId);
			connections.closeSession(sessionId);
			documents.remove(sessionId);
		});

		ctx.tools.register(searchTool(() => connections.tools().filter((tool) => !tool.pinned)));
		ctx.tools.register(callTool(() => connections.tools()));

		ctx.hook("model.context", async (input, next) => {
			const movable = connections.tools().filter((tool) => !tool.pinned);
			if (movable.length > 0 && (deferred.has(input.sessionId) || toolTokens(movable) >= DEFER_TOKENS)) {
				deferred.add(input.sessionId);
				const hidden = new Set(movable.map((tool) => tool.name));
				return next({
					...input,
					tools: input.tools.filter((tool) => !hidden.has(tool.name)),
					sections: [...input.sections, { id: "mcpDeferred", text: deferredSection(movable) }],
				});
			}
			return next({ ...input, tools: input.tools.filter((tool) => tool.name !== MCP_SEARCH && tool.name !== MCP_CALL) });
		});

		ctx.commands.provide({
			list() {
				const messages = text();
				return promptCommands(connections.prompts()).map(({ name, server, entry }): SlashCommand => {
					const hint = argumentHint(entry);
					return { name, description: entry.description, source: messages.promptSource(server.name), ...(hint ? { argumentHint: hint } : {}) };
				});
			},
			async expand(name, rest) {
				const messages = text();
				const found = promptCommands(connections.prompts()).find((command) => command.name === name);
				if (!found) throw new Error(messages.promptGone(name));
				const bound = bindArguments(found.entry, rest);
				if (!bound.ok) throw new Error(messages.promptMissing(bound.missing));
				const prompt = await connections.getPrompt(found.server.id, found.entry.prompt, bound.args).catch((error: unknown) => {
					throw new Error(messages.promptFailed(error instanceof Error ? error.message : String(error)));
				});
				return { text: prompt, displayText: rest ? `/${name} ${rest}` : `/${name}` };
			},
		});

		/**
		 * 配置每次现读：人也可以直接改 `servers.json`，设置页刷新一下就照新的连。`servers` 是全部（自己的在前，
		 * Magpie 分发的在后），`own` 是 `servers.json` 里的，改配置只写它。
		 */
		const read = async () => {
			const result = await readServers(file);
			if (result.error) ctx.log.warn(`${file} 读不懂：${result.error}`);
			const own = await openServers(result.servers, secrets);
			const magpie = await readMagpieServers(magpieFile(), own, ctx.log);
			return { ...result, own, servers: [...own, ...(magpie ?? [])], magpieRead: magpie !== null };
		};
		/** `retry`：上次没连上的也重来。只在改了配置时给：设置页连着问状态时每问一次就重启一遍，连不上的会一直在重连。 */
		const view = async (retry = false): Promise<McpView> => {
			const { servers, error } = await read();
			connections.sync(servers, { retry });
			return {
				servers: await Promise.all(
					servers.map(async (server): Promise<ServerView> => ({
						id: server.id,
						name: server.name,
						transport: server.transport,
						...(server.transport === "stdio" ? { command: server.command, ...(server.args ? { args: server.args } : {}) } : { url: server.url }),
						vars: viewOf(server.transport === "stdio" ? server.env : server.headers),
						values: server.transport === "stdio" ? [] : viewOf(server.env),
						enabled: server.enabled,
						trustReadOnly: server.trustReadOnly === true,
						pinned: server.pinned === true,
						perSession: server.perSession === true,
						managed: server.managedBy === "magpie",
						oauth: usesOAuth(server),
						signedIn: await connections.signedIn(server).catch(() => false),
						status: connections.status(server),
					})),
				),
				file,
				...(error ? { error } : {}),
			};
		};
		/** 改配置：文件读不懂时拒绝，免得把写坏了的那份冲掉。`edit` 改的是自己的那些，`all` 连 Magpie 分发的一起，查重名用。 */
		const change = async (edit: (own: ServerConfig[], all: readonly ServerConfig[]) => ServerConfig[]): Promise<McpView> => {
			const { own, servers, error, magpieRead } = await read();
			if (error) throw new Error(text().fileBroken);
			const next = edit(own, servers);
			await writeServers(file, await sealServers(next, secrets));
			// 存设置时顺带清一遍：已经不在的服务（删掉的、Magpie 撤回的），登录一起忘掉。登录不经过这里写，
			// 所以按服务在不在判断。Magpie 的文件这次读不懂时不清：它分发的服务只是暂时看不见，不是撤回了。
			if (magpieRead) {
				const kept = [...next, ...servers.filter((server) => server.managedBy === "magpie")];
				await connections.oauth.keepOnly(kept).catch((error: unknown) => ctx.log.warn(`清理已删除服务的登录失败：${String(error)}`));
			}
			return view(true);
		};
		const known = (servers: readonly ServerConfig[], id: unknown) => {
			const server = typeof id === "string" ? servers.find((candidate) => candidate.id === id) : undefined;
			if (!server) throw new Error(text().notFound);
			return server;
		};
		/** 要改配置的那台：Magpie 分发的在 Magpie 里改，这里拒绝。 */
		const editable = (servers: readonly ServerConfig[], all: readonly ServerConfig[], id: unknown) => {
			if (typeof id === "string" && all.some((server) => server.id === id && server.managedBy === "magpie")) throw new Error(text().magpieManaged);
			return known(servers, id);
		};

		// 启动时在后台连，不让 apply 等服务器：一台冷启动要一两分钟的不该拖住插件加载。
		void read().then(
			({ servers }) => connections.sync(servers, { retry: false }),
			(error: unknown) => ctx.log.warn(`读 MCP 配置失败，先不连：${String(error)}`),
		);

		ctx.serve({
			async *readDocument(session, id, call) {
				try {
					yield* documents.read(session, id, call.signal);
				} catch {
					call.signal.throwIfAborted();
					throw new Error(text().documentReadFailed);
				}
			},
			list: () => view(),
			async save(id, raw) {
				const messages = text();
				const draft = checkDraft(raw);
				if (typeof draft === "string") throw new Error(messages.draftProblem[draft]);
				return change((servers, all) => {
					const previous = id === null ? undefined : editable(servers, all, id);
					const name = draft.name.trim();
					// 名字在工具名里（`mcp__名字__工具`），重名的两台会抢同一个前缀。
					if (all.some((server) => server.id !== previous?.id && server.name.trim().toLowerCase() === name.toLowerCase()))
						throw new Error(messages.nameTaken(name));
					const next = applyDraft(draft, previous?.id ?? `mcp-${Date.now().toString(36)}`, previous);
					return previous ? servers.map((server) => (server === previous ? next : server)) : [...servers, next];
				});
			},
			async remove(id) {
				const { own, servers } = await read();
				const target = editable(own, servers, id);
				await connections.forgetLogin(target).catch(() => {});
				return change((servers) => servers.filter((server) => server.id !== target.id));
			},
			setEnabled: (id, enabled) =>
				change((servers, all) => {
					const target = editable(servers, all, id);
					return servers.map((server) => (server === target ? { ...server, enabled: enabled === true } : server));
				}),
			async reconnect(id) {
				known((await read()).servers, id);
				await Promise.race([connections.reconnect(id), new Promise((resolve) => setTimeout(resolve, RECONNECT_WAIT_MS))]);
				return view();
			},
			fill(id, values) {
				if (!Array.isArray(values) || !values.every((item) => typeof item?.name === "string" && ENV_NAME.test(item.name) && typeof item.value === "string"))
					throw new Error(text().draftProblem.badVar);
				return change((servers, all) => {
					const target = editable(servers, all, id);
					return servers.map((server) => (server === target ? withValues(server, values) : server));
				});
			},
			async login(id) {
				const target = known((await read()).servers, id);
				try {
					await connections.login(target, openUrl);
				} catch (error) {
					if (error instanceof LoginError) throw new Error(text().loginProblem[error.code](error.detail), { cause: error });
					throw error;
				}
				return view();
			},
			async logout(id) {
				await connections.logout(known((await read()).servers, id));
				return view();
			},
			async answerForm(form, answer) {
				const problem = connections.forms.answer(form, answer);
				if (problem === "gone") throw new Error(text().formGone);
				if (problem === "invalid") throw new Error(text().formInvalid);
			},
		} satisfies McpApi);
	},
} satisfies Plugin;
