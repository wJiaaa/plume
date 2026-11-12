/** 每个会话保留自己的输入状态；隐藏时由 Activity 卸下编辑器的副作用，不把异步结果交给下一份草稿。 */

import type { DocumentText, Message, SessionView } from "@plume/contract";
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
import { parseInvocation } from "../composer/commands.ts";
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
}: {
	composer: NonNullable<ConversationProps["composer"]>;
	/** 输入框发给的那个会话，已经建了才有：右下角的用量、模型和档位量的是它。 */
	view?: SessionView;
	onOpenSettings: () => void;
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
	const [sending, setSending] = useState(false);
	// 会话还没建时人先选的模型、档位：`model` 为 undefined 是没动过（用 `blank.model`），空串是选了「跟随主会话」。
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
		sending,
		disabled: composer.disabled === true,
		steer: composer.mode === "steer",
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
	const editable = useRef(new Compartment());
	const extensions = useMemo(
		() => [
			editable.current.of([EditorState.readOnly.of(state.readOnly), EditorView.editable.of(!state.readOnly)]),
			...(files ? [attachments.extension] : []),
			history.extension,
			mentions.extension,
		],
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 只读与否经下面的 effect 重配 compartment；attachments.extension、history.extension 只建一次
		[files],
	);
	useEffect(() => {
		editor.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(state.readOnly), EditorView.editable.of(!state.readOnly)]) });
	}, [state.readOnly]);
	useEffect(() => {
		if (!active || loading || !draftKey || !editor.current || !takeChildQuoteFocus(draftKey)) return;
		editor.current.dispatch({ selection: { anchor: editor.current.state.doc.length } });
		editor.current.contentDOM.focus({ preventScroll: true });
	}, [active, loading, draftKey, draft.quotes, draft.text]);

	const send = async () => {
		if (!state.canSend || pending.current) return;
		const kept = readDraft();
		const text = withQuotes(kept.text.trim(), kept.quotes);
		const message = withSessionReferences(files ? attachments.outgoing(text) : { content: [{ type: "text", text }] }, kept.sessionRefs ?? []);
		const chosen = blank ? blankChoice(blank, choice) : undefined;
		pending.current = true;
		setSending(true);
		attachments.clear();
		changeDraft(() => EMPTY_CHILD_DRAFT);
		try {
			const invocation = parseInvocation(kept.text.trim());
			if (invocation?.name === "compact") {
				if (kept.attachments.length || kept.quotes.length || kept.sessionRefs?.length) throw new Error(t("command.noFiles"));
				const entries = await modelsAgent().listCommands({ cwd, sessionId });
				const command = entries.find((entry) => entry.name === "compact");
				if (command) await modelsAgent().expandCommand(command.plugin, command.name, invocation.rest, { cwd, sessionId });
				else await composer.send(text, chosen);
			} else if (composer.sendMessage) await composer.sendMessage(message, chosen);
			else await composer.send(message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n"), chosen);
			if (chosen) setChoice({});
		} catch (error) {
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
			notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			pending.current = false;
			setSending(false);
		}
	};
	return (
		<div className="plume-composer-dock shrink-0" data-compact="">
			<div className="plume-composer-tray relative" aria-disabled={state.disabled || undefined}>
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
						placeholder={composer.placeholder === undefined ? t("composer.plumePlaceholder") : localized(composer.placeholder, resolvedLocale)}
						extensions={extensions}
						editorRef={editor}
						combobox={mentions.combobox}
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
