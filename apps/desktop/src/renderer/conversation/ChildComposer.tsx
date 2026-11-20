/** 每个会话保留自己的输入状态；隐藏时由 Activity 卸下编辑器的副作用，不把异步结果交给下一份草稿。 */

import type { CommandExpansion, DocumentText, Message, OutgoingMessage, SessionView } from "@plume/contract";
import type { ConversationProps, SessionChoice } from "@plume/contract/ui";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useI18n } from "@plume/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { childDraft, EMPTY_CHILD_DRAFT, setChildDraft, subscribeChildDrafts, takeChildQuoteFocus, type ChildDraft } from "./child-drafts.ts";
import type { PickedFile } from "../composer/attachments/picked.ts";
import { ComposerSend, ComposerShell } from "../composer/index.ts";
import { ContextMeter } from "../composer/ContextMeter.tsx";
import { QuoteChip } from "../composer/QuoteChip.tsx";
import { useComposerAttachments } from "../composer/useComposerAttachments.tsx";
import { useMentions } from "../composer/useMentions.tsx";
import { SessionReferences } from "../composer/SessionReferences.tsx";
import { withSessionReferences } from "../composer/session-references.ts";
import { modelsAgent } from "../models/store.ts";
import { parseInvocation, resolveCommand } from "../composer/commands.ts";
import { useCommands } from "../composer/useCommands.tsx";
import { useInputHistory } from "../composer/useInputHistory.ts";
import { ModelBadge, ModelTrigger, EffortTrigger } from "../models/index.ts";
import { effectiveModel, type ComposerSession } from "../models/session.ts";
import { useModels } from "../models/store.ts";
import { ComposerItems, localized } from "../plugins.tsx";
import { useLiveSession } from "../session-live.ts";
import { notify } from "../toast/index.ts";
import { childComposerState } from "./child-composer-state.ts";
import { withQuotes } from "./quote.ts";

export type ReadComposerDocument = (name: string, data: Uint8Array) => Promise<DocumentText | null>;

export function ChildComposer({
	composer,
	active,
	running,
	loading,
	documentText,
	messages,
	sessionId,
	cwd,
	project,
	view,
	onOpenSettings,
	onOpening,
}: {
	composer: NonNullable<ConversationProps["composer"]>;
	/** 输入框发给的那个会话，已经建了才有：右下角的用量、模型和档位量的是它。 */
	view?: SessionView;
	onOpenSettings: () => void;
	/** 发第一句（会话还没建）的开始和结束：这期间会话建好、视图还没读回来，外面不把它当加载。 */
	onOpening: (on: boolean) => void;
	sessionId?: string;
	cwd?: string;
	project?: string;
	active: boolean;
	running: boolean;
	loading: boolean;
	documentText: ReadComposerDocument;
	/** 这个会话的消息：↑ ↓ 翻人说过的话。 */
	messages: readonly Message[];
}) {
	const { t, resolvedLocale } = useI18n();
	const draftKey = composer.draftKey;
	const saved = useSyncExternalStore(subscribeChildDrafts, () => childDraft(draftKey));
	const [localDraft, setLocalDraft] = useState(EMPTY_CHILD_DRAFT);
	const draft = draftKey ? saved : localDraft;
	const currentDraft = useRef(draft);
	currentDraft.current = draft;
	const readDraft = () => (draftKey ? childDraft(draftKey) : currentDraft.current);
	const changeDraft = (change: (current: ChildDraft) => ChildDraft) => {
		const next = change(readDraft());
		currentDraft.current = next;
		if (draftKey) setChildDraft(draftKey, next);
		else setLocalDraft(next);
	};
	const value = draft.text;
	const setText = (change: string | ((current: string) => string)) => {
		changeDraft((current) => ({ ...current, text: typeof change === "function" ? change(current.text) : change }));
	};
	// 会话还没建时人先选的模型、档位：`model` 为 undefined 是没动过（用 `blank.model`），空串是选了「跟随主会话」。
	// 发出第一句后也不清：会话建好、视图还没读回来那几帧这里仍画着它，清了模型名会先跳回默认再换成会话上的。
	const [choice, setChoice] = useState<SessionChoice>({});
	const blank = !view && !loading && composer.model === "choose" ? composer.blank : undefined;
	const pending = useRef(false);
	const editor = useRef<EditorView | null>(null);
	const attachments = useComposerAttachments({
		setText,
		editor,
		documentText,
		notify: (text) => notify(text, "warn"),
		state: { attachments: draft.attachments, setAttachments: (files) => changeDraft((current) => ({ ...current, attachments: files })) },
	});
	const files = Boolean(composer.sendMessage);
	const history = useInputHistory({
		messages,
		attachments: attachments.attachments.length + (draft.sessionRefs?.length ?? 0),
		onPick: (text, picked, references) => {
			changeDraft((current) => ({ ...current, text, sessionRefs: references }));
			// 纯文字的输入框收不了附件，只放回字。
			if (files) attachments.restore(picked);
		},
		editor,
		resetKey: "",
		value,
	});
	const state = childComposerState({
		active,
		running,
		loading,
		disabled: composer.disabled === true,
		steer: composer.mode === "steer",
		stoppable: Boolean(composer.stop),
		hasContent: Boolean(value.trim()) || draft.quotes.length > 0 || Boolean(draft.sessionRefs?.length) || (files && attachments.attachments.length > 0),
	});
	const mentions = useMentions({
		editor,
		agent: modelsAgent(),
		cwd,
		sessionId,
		target: { project },
		onSession: (ref) =>
			changeDraft((current) => ({
				...current,
				sessionRefs: [...new Map([...(current.sessionRefs ?? []), ref].map((item) => [item.id, item])).values()],
			})),
	});
	// 命令说的是这个会话，会话建好（第一句发出去）以后才有菜单。不开菜单的输入框也认 `/compact`：压缩这个会话，不当一句话发出去。
	const menu = composer.commands === true && sessionId !== undefined;
	const commands = useCommands({
		editor,
		...(cwd ? { cwd } : {}),
		...(sessionId ? { sessionId } : {}),
		list: async (context) => {
			const entries = await modelsAgent().listCommands(context);
			return menu ? entries : entries.filter((entry) => entry.name === "compact");
		},
		onSubmit: () => void send(),
		onError: (message) => notify(message, "error"),
		product: false,
	});
	const editable = useRef(new Compartment());
	const extensions = useMemo(
		() => [
			editable.current.of([EditorState.readOnly.of(state.readOnly), EditorView.editable.of(!state.readOnly)]),
			...(files ? [attachments.extension] : []),
			...(menu ? [commands.extension] : []),
			history.extension,
			mentions.extension,
		],
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 只读与否经下面的 effect 重配 compartment；attachments.extension、commands.extension、history.extension 只建一次
		[files, menu],
	);
	useEffect(() => {
		editor.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(state.readOnly), EditorView.editable.of(!state.readOnly)]) });
	}, [state.readOnly]);
	useEffect(() => {
		if (!active || loading || !draftKey || !editor.current || !takeChildQuoteFocus(draftKey)) return;
		editor.current.dispatch({ selection: { anchor: editor.current.state.doc.length } });
		editor.current.contentDOM.focus({ preventScroll: true });
	}, [active, loading, draftKey, draft.quotes, draft.text]);

	/**
	 * 行首是一条认得的命令时交给插件展开：自己办掉了的清空输入框、什么都不发（null）；展开成话的照它发。
	 * 展开期间草稿改了的作废（null），不误发。不是命令就是 undefined，原文照发。
	 */
	const runCommand = async (kept: ChildDraft): Promise<CommandExpansion | null | undefined> => {
		const invocation = parseInvocation(kept.text.trim());
		if (!invocation) return undefined;
		const command = resolveCommand(await commands.fresh(), invocation.name);
		if (!command?.plugin) return undefined;
		if (command.name === "compact" && (kept.attachments.length || kept.quotes.length || kept.sessionRefs?.length)) throw new Error(t("command.noFiles"));
		const result = await modelsAgent().expandCommand(command.plugin, command.name, invocation.rest, {
			...(cwd ? { cwd } : {}),
			...(sessionId ? { sessionId } : {}),
		});
		if (readDraft() !== kept) return null;
		if ("handled" in result) {
			attachments.clear();
			changeDraft(() => EMPTY_CHILD_DRAFT);
			return null;
		}
		return result;
	};
	/** `later`：⌘回车。会话在跑时排到这一轮之后（插件给了 `queue` 时），不插进去。 */
	const send = async (later = false) => {
		if (!state.canSend || pending.current) return;
		pending.current = true;
		const kept = readDraft();
		let command: CommandExpansion | null | undefined;
		try {
			command = await runCommand(kept);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			pending.current = false;
			return;
		}
		if (command === null) {
			pending.current = false;
			return;
		}
		// 发给模型的是展开后的话，引文接在它后面；气泡上是人打的原文。
		const text = withQuotes(command?.text ?? kept.text.trim(), kept.quotes);
		const body = files ? attachments.outgoing(text) : { content: [{ type: "text" as const, text }] };
		const message = withSessionReferences(
			command?.displayText === undefined ? body : { ...body, displayText: withQuotes(command.displayText, kept.quotes) },
			kept.sessionRefs ?? [],
		);
		const chosen = blank ? blankChoice(blank, choice) : undefined;
		// 照主输入框：在跑时打的话插进这一轮；⌘回车的、命令没声明插话的排到这一轮之后。
		const queued = running && composer.queue !== undefined && (later || (command !== undefined && command.deliver !== "steer"));
		/*
		 * 照主输入框：插话、排队先清空（它一推进队里就上了排队条，等回音再清的话那几帧同一句两份），
		 * 平常的发送等发出去再清。先清的话从按下到会话跑起来那一两帧里输入框是空的，发送键先暗一下再换成停止键。
		 */
		const early = running;
		const opening = !sessionId;
		if (opening) onOpening(true);
		if (early) {
			attachments.clear();
			changeDraft(() => EMPTY_CHILD_DRAFT);
		}
		try {
			if (queued) await composer.queue!(message);
			else await deliver(message, chosen);
			// 发送期间人又改过的，留给下一句。
			if (!early && readDraft() === kept) {
				attachments.clear();
				changeDraft(() => EMPTY_CHILD_DRAFT);
			}
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			// 没先清的，草稿原样还在。
			if (!early) return;
			// 闭包属于这份会话；切换面板以后失败，也只还给原来的草稿。
			if (files) {
				attachments.restore(readDraft().attachments);
				attachments.takeBack(kept.text, kept.attachments);
			} else if (kept.text) setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${kept.text}` : kept.text));
			changeDraft((current) => ({
				...current,
				quotes: [...kept.quotes, ...current.quotes],
				sessionRefs: [...(kept.sessionRefs ?? []), ...(current.sessionRefs ?? [])],
			}));
		} finally {
			pending.current = false;
			if (opening) onOpening(false);
		}
	};
	const deliver = async (message: OutgoingMessage, chosen: SessionChoice | undefined) => {
		if (composer.sendMessage) await composer.sendMessage(message, chosen);
		else await composer.send(message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n"), chosen);
	};
	return (
		<div className="plume-composer-dock shrink-0" data-compact="">
			<div className="plume-composer-tray relative" aria-disabled={state.disabled || undefined}>
				{menu && commands.menu}
				{mentions.menu}
				<div
					inert={state.disabled}
					className={state.disabled ? "opacity-45" : ""}
					onPasteCapture={(event) => {
						if (state.readOnly) {
							event.preventDefault();
							event.stopPropagation();
						}
					}}
				>
					<ComposerShell
						value={value}
						onChange={(next) => {
							setText(next);
							if (files) attachments.reconcile(next);
						}}
						onSubmit={() => void send()}
						{...(composer.mode === "steer" && composer.queue ? { onSubmitLater: () => void send(true) } : {})}
						placeholder={composer.placeholder === undefined ? t("composer.plumePlaceholder") : localized(composer.placeholder, resolvedLocale)}
						extensions={extensions}
						editorRef={editor}
						// 两张菜单不会同时开：`@` 开着就说它，否则说 `/` 那张。
						combobox={menu && !mentions.combobox.open ? commands.combobox : mentions.combobox}
						historyPosition={history.position}
						{...(files && !state.readOnly ? { onFiles: (picked: PickedFile[]) => void attachments.addFiles(picked) } : {})}
						top={
							<>
								{draft.sessionRefs?.length ? (
									<div className="plume-composer-attachments">
										<SessionReferences
											references={draft.sessionRefs}
											onRemove={(id) => changeDraft((current) => ({ ...current, sessionRefs: current.sessionRefs?.filter((ref) => ref.id !== id) }))}
										/>
									</div>
								) : null}
								{draft.quotes.length > 0 && (
									<div className="plume-composer-attachments">
										<QuoteChip
											quotes={draft.quotes}
											onRemove={(id) => changeDraft((current) => ({ ...current, quotes: current.quotes.filter((quote) => quote.id !== id) }))}
										/>
									</div>
								)}
								{files && attachments.tray}
							</>
						}
						left={files && attachments.addButton}
						right={
							<>
								{composer.footer}
								{view && <ChildModels view={view} composer={composer} running={running} onOpenSettings={onOpenSettings} />}
								{blank && <BlankModels blank={blank} choice={choice} onChoice={setChoice} onOpenSettings={onOpenSettings} />}
								<ComposerSend running={state.stop} disabled={!state.canSend} onSend={() => void send()} onStop={() => composer.stop?.()} />
							</>
						}
					/>
				</div>
			</div>
			{files && active && !state.readOnly && attachments.menu}
		</div>
	);
}

/**
 * 子会话输入框右下角，发送按钮左边：插件的 end 格子、上下文用量、模型和思考档位，和主输入框同一套，量的是这个子会话。
 * 子会话没选模型、档位时 agent 进程用父会话的（`packages/core/agent/src/agent.ts` 的 `modelOf`），这里也照这样算，画的就是下一轮实际会用的。
 * 插件的独立会话没有父会话可跟，菜单和主输入框一样，没选的用默认模型。
 */
function ChildModels({
	view,
	composer,
	running,
	onOpenSettings,
}: {
	view: SessionView;
	composer: NonNullable<ConversationProps["composer"]>;
	running: boolean;
	onOpenSettings: () => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const parent = useLiveSession(view.summary.parentId)?.summary;
	const own = view.summary;
	const chosen = own.model ?? parent?.model;
	const thinking = own.thinking ?? parent?.thinking;
	const models = useModels();
	const model = effectiveModel(models, chosen);
	const parentName = effectiveModel(models, parent?.model)?.name;
	const session = { id: own.id, said: view.messages.length > 0, ...(chosen ? { model: chosen } : {}), ...(thinking ? { thinking } : {}) };
	const onError = (message: string) => notify(message, "error");
	return (
		<>
			<ComposerItems
				side="end"
				sessionId={own.id}
				running={running}
				{...(model ? { model: { id: model.id, name: model.name, contextWindow: model.contextWindow } } : {})}
			/>
			<ContextMeter view={view} contextWindow={model?.contextWindow} />
			{composer.model === "show" && (
				<ModelBadge
					{...(chosen ? { model: chosen } : {})}
					{...(thinking ? { thinking } : {})}
					{...(composer.modelTip ? { tip: localized(composer.modelTip, resolvedLocale) } : {})}
				/>
			)}
			{composer.model === "choose" && (
				<ChooseModels
					session={session}
					{...(own.model ? { own: own.model } : {})}
					{...(own.parentId ? { parentId: own.parentId } : {})}
					{...(parentName ? { parentName } : {})}
					onFollow={(next) =>
						void modelsAgent()
							.setSessionModel(own.id, next || undefined)
							.catch((cause: unknown) => onError(t("modelMenu.switchFailed", { reason: cause instanceof Error ? cause.message : String(cause) })))
					}
					onError={onError}
					onOpenSettings={onOpenSettings}
				/>
			)}
		</>
	);
}

/** 会话建好后用的模型：人动过就是选的（空串是跟随父会话），没动过是插件给的 `blank.model`。 */
function blankChoice(blank: NonNullable<NonNullable<ConversationProps["composer"]>["blank"]>, choice: SessionChoice): SessionChoice {
	const model = choice.model === undefined ? blank.model : choice.model || undefined;
	return { ...(model ? { model } : {}), ...(choice.thinking ? { thinking: choice.thinking } : {}) };
}

/**
 * 会话还没建（第一句还没发）时的模型和思考档位：选的先记在输入框里（`choice`），发第一句时交给插件建会话。
 * 没选的照会话建好后的算法（`ChildModels`）跟着 `blank.parentId` 那个会话。没有会话可量，不画用量格子。
 */
function BlankModels({
	blank,
	choice,
	onChoice,
	onOpenSettings,
}: {
	blank: NonNullable<NonNullable<ConversationProps["composer"]>["blank"]>;
	choice: SessionChoice;
	onChoice: (change: (current: SessionChoice) => SessionChoice) => void;
	onOpenSettings: () => void;
}) {
	const parent = useLiveSession(blank.parentId)?.summary;
	const own = blankChoice(blank, choice);
	const chosen = own.model ?? parent?.model;
	const thinking = own.thinking ?? parent?.thinking;
	const parentName = effectiveModel(useModels(), parent?.model)?.name;
	const pick = (model: string) => onChoice((current) => ({ ...current, model }));
	const session: ComposerSession = {
		id: null,
		said: false,
		...(chosen ? { model: chosen } : {}),
		...(thinking ? { thinking } : {}),
		setModel: pick,
		setThinking: (next) => onChoice((current) => ({ ...current, thinking: next })),
	};
	return (
		<ChooseModels
			session={session}
			{...(own.model ? { own: own.model } : {})}
			{...(blank.parentId ? { parentId: blank.parentId } : {})}
			{...(parentName ? { parentName } : {})}
			onFollow={pick}
			onError={(message) => notify(message, "error")}
			onOpenSettings={onOpenSettings}
		/>
	);
}

/** 能换的模型和档位。子会话（有 `parentId`）的模型菜单最前面是「跟随主会话」，选中交给 `onFollow`（空串是跟随）；独立会话的菜单直接改 `session`。 */
function ChooseModels({
	session,
	own,
	parentId,
	parentName,
	onFollow,
	onError,
	onOpenSettings,
}: {
	session: ComposerSession;
	/** 子会话自己选的模型；没有是跟随父会话。 */
	own?: string;
	parentId?: string;
	parentName?: string;
	onFollow: (next: string) => void;
	onError: (message: string) => void;
	onOpenSettings: () => void;
}) {
	const { t } = useI18n();
	return (
		<div className="flex min-w-0 items-center gap-0.5">
			<ModelTrigger
				session={session}
				onError={onError}
				onOpenSettings={onOpenSettings}
				{...(parentId
					? {
							...(own ? {} : { inheriting: t("composer.followParent") }),
							selection: {
								value: own ?? "",
								inheritLabel: t("composer.followParent"),
								...(parentName ? { inheritDetail: parentName } : {}),
								onChange: onFollow,
							},
						}
					: {})}
			/>
			<EffortTrigger session={session} onError={onError} />
		</div>
	);
}
