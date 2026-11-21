import { randomUUID } from "node:crypto";
import type {
	AgentEvent,
	AssistantMessage,
	Hiccup,
	HookTrace,
	Log,
	Message,
	ModelCompletion,
	ModelContext,
	SessionObservation,
	UserMessage,
} from "@plume/contract";
import { streamAssistant } from "@plume/llm";
import { comparePrefix, payloadSegments } from "@plume/llm/prefix-fingerprint";
import type { ModelConfig, ProviderConfig, RequestOptions } from "@plume/llm/types";
import {
	estimateContext,
	foldRetry,
	historyFor,
	preparePrompt,
	replaceRepeats,
	sessionScope,
	settleHiccups,
	settlePrompt,
	streamTurn,
	validSections,
	withEnvironment,
	withSteeringNote,
	type ContextRecord,
	type SentRequest,
} from "@plume/loop";
import { contextShell, settleShell } from "../commands.ts";
import type { PluginHost } from "../host.ts";
import { text } from "../i18n.ts";
import { restoreImages } from "../media.ts";
import type { ModelSettings } from "../model-settings.ts";
import { lookup, personalizationOf, resolveModel, stripForeignHandles, thinkingFor, type StoredSettings } from "../models.ts";
import { projectRootsFor } from "../project-roots.ts";
import type { Projects } from "../projects.ts";
import { withProjectLayer } from "../project-config.ts";
import type { SessionDb } from "../session-db.ts";
import { estimateParts, type InputParts } from "../usage-record.ts";
import type { Session } from "./session.ts";

export interface ModelRequestsDeps {
	retryPolicy: RequestOptions["retryPolicy"] | undefined;
	modelSettings: Pick<ModelSettings, "read" | "retryPolicy">;
	readSessionSettings(session: Session): Promise<StoredSettings>;
	modelOf(session: Session): string | undefined;
	thinkingOf(session: Session): Session["summary"]["thinking"];
	projects: Pick<Projects, "list">;
	scratchDir(sessionId: string): string;
	messagesOf(session: Session): Promise<Message[]>;
	recordOf(session: Session): Promise<ContextRecord>;
	host: {
		run(
			name: "model.context",
			input: ModelContext,
			inner: (input: ModelContext) => Promise<ModelContext>,
			options: { settle(value: ModelContext): ModelContext; trace(trace: HookTrace): void },
		): Promise<ModelContext>;
		toolSpecs(): ReturnType<PluginHost["toolSpecs"]>;
		tool(name: string): ReturnType<PluginHost["tool"]>;
	};
	mediaDir: string;
	store: Pick<SessionDb, "saveContext" | "spend" | "draft">;
	find(sessionId: string): Session;
	observe(sessionId: string, event: SessionObservation["event"], timestamp?: number): void;
	emit(event: AgentEvent): void;
	/** 回边：占用模块后建，在 `createAgent` 里接上。 */
	setDraft(session: Session, draft: AssistantMessage | undefined): void;
	/** 回边：占用模块后建，在 `createAgent` 里接上。 */
	observeDraft(session: Session, id: string, draft: AssistantMessage | undefined): void;
	log: Log;
}

export interface ModelRequests {
	buildContext(session: Session): Promise<ModelContext>;
	completeOnce(request: ModelCompletion): Promise<string>;
	request(session: Session, context: ModelContext, signal: AbortSignal): Promise<AssistantMessage | "switched">;
	partsOf(message: AssistantMessage): InputParts | undefined;
}

/** 回复里的正文，几段接在一起。 */
function replyText(reply: AssistantMessage): string {
	return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function createModelRequests(deps: ModelRequestsDeps): ModelRequests {
	const {
		retryPolicy,
		modelSettings,
		readSessionSettings,
		modelOf,
		thinkingOf,
		projects,
		scratchDir,
		messagesOf,
		recordOf,
		host,
		mediaDir,
		store,
		find,
		observe,
		emit,
		setDraft,
		observeDraft,
		log,
	} = deps;

	/** 主请求发出时估的各部分 token，回复落进会话时带去记账（`SpendNote`）。 */
	const requestParts = new WeakMap<AssistantMessage, InputParts>();

	/** 重试预算在每次等待前同步取它（`RetryPolicySource` 是函数）：设置页改了，正在重试的请求从下一次等待起就用新值。 */
	function retryPolicyFor(session?: Session): RequestOptions["retryPolicy"] {
		return retryPolicy ?? (() => withProjectLayer({ providers: [], retryPolicy: modelSettings.retryPolicy() }, session?.projectLayer ?? {}).retryPolicy);
	}

	/**
	 * 经 model.context 组出这一次请求的上下文。消息是副本，插件怎么改都不影响会话里存的。
	 * 本体只给历史和工具表，系统提示词是空的：各段由内置插件 plume.prompt 在最外层补上。
	 */
	async function buildContext(session: Session): Promise<ModelContext> {
		const settings = await readSessionSettings(session);
		const record = await recordOf(session);
		const { model } = resolveModel(settings, modelOf(session));
		const input: ModelContext = {
			sessionId: session.summary.id,
			session: sessionScope(session.summary),
			...(session.summary.parentId === undefined ? {} : { parentId: session.summary.parentId }),
			...(session.summary.owner === undefined ? {} : { owner: session.summary.owner }),
			cwd: session.summary.cwd,
			projectRoots: projectRootsFor(projects.list(), session.summary.cwd, session.summary.project),
			scratchDir: scratchDir(session.summary.id),
			model: { id: model.id, name: model.name },
			permissionMode: settings.permissionMode ?? "auto",
			shell: contextShell(settings.permissionMode ?? "auto"),
			personalization: personalizationOf(settings),
			systemPrompt: "",
			sections: [],
			// 压缩过的话是摘要加之后的原文，被剪过的结果换成一行（见 `historyFor`），重复的结果换成「这是第 N 次」。
			messages: structuredClone(replaceRepeats(historyFor(await messagesOf(session), record), session.repetition.replaced)),
			tools: host.toolSpecs(),
		};
		await restoreImages(mediaDir, input.messages);
		/*
		 * 冻结、日期、插话说明包在整条钩子链外面（见 `prompt/`）：插件的层不管挂在哪、对段和工具表做了什么，都改不坏前缀缓存。
		 * 增量、日期和插话说明在钩子链之前加：它们按「跟在本体给的历史里哪一条后面」定位，插件往里插了消息就对不上了。
		 */
		const prompt = preparePrompt(record.prompt, input.messages);
		input.messages = withEnvironment(withSteeringNote(prompt.messages));
		let trace: HookTrace | undefined;
		const hooked = await host.run("model.context", input, async (context) => context, {
			settle: (context: ModelContext) => settleShell(settlePrompt(context)),
			trace: (value) => (trace = value),
		});
		if (typeof hooked?.systemPrompt !== "string" || !validSections(hooked.sections) || !Array.isArray(hooked.messages) || !Array.isArray(hooked.tools)) {
			throw new Error(text("session.contextIncomplete"));
		}
		const { frozen, ...sent } = prompt.settle(hooked.sections, hooked.messages, hooked.tools);
		if (frozen !== record.prompt) {
			record.prompt = frozen;
			store.saveContext(session.summary.id, record);
		}
		const context = settlePrompt({ ...hooked, ...sent });
		if (trace) contextTraces.set(context, trace);
		return context;
	}
	/** 组出这份上下文时 model.context 经过的层：发请求时随它记进运行观察（压缩拿去用、没发出去的不记）。 */
	const contextTraces = new WeakMap<ModelContext, HookTrace>();

	/**
	 * 插件的一次性调用（`ctx.model.complete`）：不带工具、不思考，只要最后那段字。替会话做的用那个会话的模型、花销记在它名下，
	 * 否则用默认模型。不写进会话，所以不经 `model.context`：那些层改的是会话发出去的请求。
	 * `fork` 的那种照上一次主请求原样发，见 `forkOnce`。
	 */
	async function completeOnce(request: ModelCompletion): Promise<string> {
		const { systemPrompt, prompt, messages = [], sessionId, model: chosen, maxTokens, signal, onRetry } = request;
		const session = sessionId === undefined ? undefined : find(sessionId);
		const settings = session ? await readSessionSettings(session) : await modelSettings.read();
		// 插件点名的模型不在了就报错：悄悄换成默认模型，人在设置里选的那个就白选了，花销也记错了地方。
		if (chosen !== undefined && !lookup(settings, chosen)) throw new Error(text("model.unavailable", { model: chosen }));
		const { provider, model } = resolveModel(settings, chosen ?? (session && modelOf(session)));
		const asked = structuredClone([...messages, { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } satisfies UserMessage]);
		// 历史里挪进媒体目录的图读回来：发出去的是一张空图的话，服务商整个拒收。
		await restoreImages(mediaDir, asked);
		const retried = onRetry ? { onRetry: ({ delayMs }: { delayMs: number }) => onRetry({ delayMs }) } : {};
		if (request.fork === true) {
			if (!session) throw new Error(text("model.forkNoRequest"));
			return forkOnce(session, provider, model, asked, signal, retried, request.requireComplete === true);
		}
		const requestId = randomUUID();
		if (session)
			observe(session.summary.id, { type: "request", id: requestId, provider: provider.name, model: model.id, systemPrompt, messages: asked, tools: [] });
		const stream = streamAssistant(
			provider,
			model,
			{ systemPrompt, messages: asked, tools: [] },
			{ ...(signal ? { signal } : {}), maxTokens: maxTokens ?? model.maxOutputTokens, thinking: "off", retryPolicy: retryPolicyFor(session), ...retried },
		);
		return replyText(await settleOnce(session, requestId, stream, signal, request.requireComplete === true));
	}

	/**
	 * 一次性调用的收尾：读完流，回复记进观察和花销；人停了、出错了、要说完（`requireComplete`）却没说完都抛错。
	 * `before` 在停止检查之后、出错检查之前：分叉对不上时请求根本没发出去，要说的是这个，不是「出错了」。
	 */
	async function settleOnce(
		session: Session | undefined,
		requestId: string,
		stream: ReturnType<typeof streamAssistant>,
		signal: AbortSignal | undefined,
		requireComplete: boolean,
		before?: () => void,
	): Promise<AssistantMessage> {
		let next = await stream.next();
		while (!next.done) next = await stream.next();
		const reply = next.value;
		if (session) observe(session.summary.id, { type: "response", id: requestId, reply });
		store.spend(session?.summary.id ?? null, reply);
		signal?.throwIfAborted();
		before?.();
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || text("model.failed"));
		if (requireComplete && reply.stopReason !== "stop") throw new Error(text("model.incomplete"));
		return reply;
	}

	/**
	 * 从上一次主请求分叉的一次调用：系统提示词、工具表、思考档位、缓存键、输出上限照那一次原样，消息是调用方给的（这个会话下一次要发的
	 * 历史加一条指令）。前缀和那一次逐字节相同，缓存照常命中。请求体出门前切段和那一次比：那一次不是这一次的前缀就当场中止，
	 * 不发一份「以为在分叉、其实对不上」的请求——那样整段历史按原价重读，比不分叉还贵。
	 */
	async function forkOnce(
		session: Session,
		provider: ProviderConfig,
		model: ModelConfig,
		messages: Message[],
		signal: AbortSignal | undefined,
		retried: Pick<RequestOptions, "onRetry">,
		requireComplete: boolean,
	): Promise<string> {
		const sent = session.sent;
		if (!sent || sent.model !== model.id) throw new Error(text("model.forkNoRequest"));
		const mismatch = new AbortController();
		let changed: string | undefined;
		const requestId = randomUUID();
		observe(session.summary.id, {
			type: "request",
			id: requestId,
			provider: provider.name,
			model: model.id,
			systemPrompt: sent.systemPrompt,
			messages,
			tools: sent.tools,
		});
		const stream = streamAssistant(
			provider,
			model,
			{ systemPrompt: sent.systemPrompt, messages: stripForeignHandles(messages, provider, model), tools: sent.tools },
			{
				signal: signal ? AbortSignal.any([signal, mismatch.signal]) : mismatch.signal,
				maxTokens: sent.maxTokens,
				cacheKey: sent.cacheKey,
				thinking: sent.thinking,
				retryPolicy: retryPolicyFor(session),
				...retried,
				onPayload: (body) => {
					if (!sent.segments) return;
					const prefix = comparePrefix(sent.segments, payloadSegments(body));
					if (!prefix.change) return;
					changed = prefix.change.segment;
					// 在出门之前：拿到一个已经中止的信号，请求就不会发出去。
					mismatch.abort();
				},
			},
		);
		const reply = await settleOnce(session, requestId, stream, signal, requireComplete, () => {
			if (changed === undefined) return;
			log("agent", "warn", `会话 ${session.summary.id} 的分叉请求和上一次主请求的前缀在 ${changed} 处对不上，没有发出去`);
			throw new Error(text("model.forkMismatch", { segment: changed }));
		});
		// 说了不要调工具还是调了：这次回复不是要的那段字。
		if (reply.content.some((block) => block.type === "toolCall")) throw new Error(text("model.forkToolCall"));
		return replyText(reply);
	}

	/** 发一次请求：每次都重新读设置，会话中途换的模型从下一个请求起生效。 */
	async function request(session: Session, context: ModelContext, signal: AbortSignal): Promise<AssistantMessage | "switched"> {
		const { provider, model } = resolveModel(await readSessionSettings(session), modelOf(session));
		const sessionId = session.summary.id;
		const hiccups = (next: Hiccup[]) => {
			session.hiccups = next;
			emit({ type: "hiccups", sessionId, hiccups: next });
		};
		const at = () => session.messages?.length ?? 0;
		// 同一个位置上一次失败的回复没写进会话（拒收、超长以后重发）：那条「放弃了」不再算数。
		const redone = session.hiccups.filter((hiccup) => !(hiccup.outcome === "gave_up" && hiccup.at === at()));
		if (redone.length !== session.hiccups.length) hiccups(redone);
		// 分段估算跟着会话落盘（`ContextRecord.estimate`）：重开应用后、下一次请求前点开读数，照样分段。
		const record = await recordOf(session);
		record.estimate = estimateContext(context, (tool) => host.tool(tool)?.definition.category);
		store.saveContext(sessionId, record);
		const previous = session.sent?.segments;
		// 记下这次请求的请求头，压缩从它分叉（`SentRequest`）；请求体的分段指纹在出门前补上。
		const sent: SentRequest = {
			model: model.id,
			systemPrompt: context.systemPrompt,
			tools: context.tools,
			thinking: thinkingFor(model, thinkingOf(session)),
			maxTokens: model.maxOutputTokens,
			cacheKey: sessionId,
			at: Date.now(),
		};
		session.sent = sent;
		const requestId = randomUUID();
		const input = { systemPrompt: context.systemPrompt, messages: stripForeignHandles(context.messages, provider, model), tools: context.tools };
		const traced = contextTraces.get(context);
		if (traced) observe(sessionId, { type: "hooks", requestId, ...traced }, sent.at);
		observe(sessionId, { type: "request", id: requestId, provider: provider.name, model: model.id, ...input }, sent.at);
		let reply: Awaited<ReturnType<typeof streamTurn>>;
		try {
			reply = await streamTurn({
				provider,
				model,
				context: input,
				options: {
					signal,
					maxTokens: sent.maxTokens,
					cacheKey: sent.cacheKey,
					thinking: sent.thinking,
					retryPolicy: retryPolicyFor(session),
					onPayload: (body) => {
						sent.segments = payloadSegments(body);
					},
				},
				draft: (draft) => {
					setDraft(session, draft);
					// 放手、抛错时 streamTurn 先清掉界面的草稿；观察者的作废按收场的方式在下面说，排在 response 之后。
					if (draft) observeDraft(session, requestId, draft);
				},
				// 边流边落盘：进程中途没了，下次打开时已经收到的字作为停下的回复还在。
				keep: (partial) => store.draft(sessionId, partial),
				retry: (info) => {
					// 重试从头再写：观察者已经看过的那截作废，之后同一次请求的快照从空的起。
					observeDraft(session, requestId, undefined);
					hiccups(foldRetry(session.hiccups, info, Date.now(), at()));
				},
				settled: (info) => hiccups(settleHiccups(session.hiccups, info, at())),
				onSwitch: (listener) => {
					const listeners = (session.switching ??= new Set());
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			});
		} catch (error) {
			observeDraft(session, requestId, undefined);
			throw error;
		}
		if ("switched" in reply) {
			if (reply.reply) observe(sessionId, { type: "response", id: requestId, reply: reply.reply });
			observeDraft(session, requestId, undefined);
			return "switched";
		}
		// 和上一次主请求比前缀从哪变了：缓存未命中的归因证据，随回复存下。重开应用后的第一次没得比。
		if (previous && sent.segments) reply.prefix = comparePrefix(previous, sent.segments);
		requestParts.set(reply, estimateParts(context));
		observe(sessionId, { type: "response", id: requestId, reply });
		return reply;
	}

	return { buildContext, completeOnce, request, partsOf: (message) => requestParts.get(message) };
}
