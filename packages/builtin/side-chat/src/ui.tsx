/**
 * 侧边聊天插件的界面入口：「侧边聊天」面板，一个标签一段侧边聊天，能开好几个。
 *
 * 标签和侧边聊天的对应由逻辑入口持久保存；新开的标签认领这个会话旁边还没有标签认领的、最新的那段，
 * 没有就空着，第一句发出去时再开一段。恢复标签或换窗口时，按同一个 tab 接回原会话。
 * 关标签就是删掉那段侧边聊天，说过话的先问一句；勾了「不再询问」关过一次以后就不问了。
 *
 * 主输入框排队条的「更多」菜单里加一项「在侧边聊天中打开」：这句话先拿到侧边聊天问，不占用正在跑的这一轮。
 */

import type { PanelProps, Remote, SessionChoice, UiContext, UiPlugin } from "@plume/contract/ui";
import type { OutgoingMessage } from "@plume/contract";
import { ChoiceMark, Confirm, PanelEmpty, Text, useI18n } from "@plume/ui";
import { MessageSquarePlus, MessagesSquare } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { SideChatApi } from "./api.ts";
import { dispatchCard } from "./DispatchCard.tsx";
import { MESSAGES } from "./messages.ts";
import sideChatCss from "./side-chat.css";

const PANEL = "chat";
const NAME = "plume.side-chat";

/** 卡片的布局类：宿主不加载插件的样式表，自己挂一份；按插件名认那个元素，重新加载时换内容不叠加。 */
function mountStyles(): void {
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${NAME}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = NAME;
		document.head.append(style);
	}
	style.textContent = sideChatCss;
}

let ui: UiContext;
let api: Remote<SideChatApi>;

function SideChatPanel({ session, tab, setTitle, onClose }: PanelProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const parentId = session?.summary.id;
	const [sideId, setSideId] = useState<string | undefined>(undefined);
	const sideIdRef = useRef(sideId);
	sideIdRef.current = sideId;
	const closing = useRef(false);
	const side = ui.useSession(sideId);
	const [asking, setAsking] = useState<((sure: boolean) => void) | undefined>(undefined);
	// 还没开的这段要用的模型：第一句之前输入框里先画它，人没动过就照它开。
	const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (sideId) return;
		let current = true;
		void api.model().then(
			(value) => {
				if (current) setDefaultModel(value);
			},
			(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
		);
		return () => {
			current = false;
		};
	}, [sideId]);

	// 只恢复绑定，不在挂载时新建；卸载不能删除绑定或子会话。
	useEffect(() => {
		if (!parentId) return;
		let current = true;
		closing.current = false;
		void api.bind(tab, parentId).then(
			(id) => {
				if (current && !closing.current) setSideId(id);
			},
			(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
		);
		return () => {
			current = false;
		};
	}, [parentId, tab]);

	const title = side?.summary.title;
	useEffect(() => setTitle(title || undefined), [title, setTitle]);

	// 关标签：说过话的先问一句，确认了就删掉这段。人在确认框里点的结果经 `asking` 交回。
	const said = side ? side.messages.length > 0 : Boolean(sideId);
	const saidRef = useRef(said);
	saidRef.current = said;
	const send = async (question: string | OutgoingMessage, choice?: SessionChoice) => {
		if (!parentId || closing.current) return;
		const id = await api.open(tab, parentId, choice);
		if (closing.current) return;
		setSideId(id);
		await api.ask(id, question);
	};
	useEffect(
		() =>
			onClose(async () => {
				const id = parentId ? await api.bind(tab, parentId) : undefined;
				if (id && (id !== sideIdRef.current || saidRef.current) && !skipCloseQuestion()) {
					const sure = await new Promise<boolean>((resolve) => setAsking(() => resolve));
					setAsking(undefined);
					if (!sure) return false;
				}
				closing.current = true;
				try {
					await api.close(tab);
					setSideId(undefined);
					return true;
				} catch (error) {
					closing.current = false;
					throw error;
				}
			}),
		[onClose, tab, parentId],
	);

	if (!parentId)
		return (
			<PanelEmpty icon={MessagesSquare} title={text.title}>
				{text.noSession}
			</PanelEmpty>
		);
	return (
		<div style={{ height: "100%", minHeight: 0 }}>
			<ui.Conversation
				{...(sideId ? { sessionId: sideId } : {})}
				reask
				empty={
					<PanelEmpty icon={MessagesSquare} title={text.title}>
						{text.empty}
					</PanelEmpty>
				}
				composer={{
					draftKey: tab,
					model: "choose",
					blank: { parentId, ...(defaultModel ? { model: defaultModel } : {}) },
					placeholder: (locale) => MESSAGES[locale].placeholder,
					send,
					sendMessage: send,
					stop: () => {
						const id = sideIdRef.current;
						if (id) void api.stop(id);
					},
				}}
			/>
			{asking && <CloseQuestion answer={asking} />}
		</div>
	);
}

/** 勾过「不再询问」并且真关掉了一次之后记在这里：以后说过话的标签也直接关。 */
const SKIP_CLOSE_QUESTION = "plume.side-chat.closeWithoutAsking";

function skipCloseQuestion(): boolean {
	try {
		return localStorage.getItem(SKIP_CLOSE_QUESTION) === "1";
	} catch {
		return false;
	}
}

function CloseQuestion({ answer }: { answer: (sure: boolean) => void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [dontAskAgain, setDontAskAgain] = useState(false);
	return (
		<Confirm
			title={text.closeTitle}
			detail={text.closeDetail}
			confirmLabel={text.closeConfirm}
			onConfirm={() => {
				// 只在真关了的时候记：勾上又点了取消，等于这次没答应。
				if (dontAskAgain) {
					try {
						localStorage.setItem(SKIP_CLOSE_QUESTION, "1");
					} catch {
						/* 存不下就下次照样问。 */
					}
				}
				answer(true);
			}}
			onCancel={() => answer(false)}
		>
			<Text as="label" size="label" className="plume-side-dont-ask">
				<input type="checkbox" className="plume-side-hidden-input" checked={dontAskAgain} onChange={(event) => setDontAskAgain(event.target.checked)} />
				<ChoiceMark checked={dontAskAgain} kind="checkbox" />
				{text.dontAskAgain}
			</Text>
		</Confirm>
	);
}

/** 设置 › 智能体 › 会话里的一行：新的侧边聊天用哪个模型。名字和说明由宿主画，这里只画右边的下拉。 */
function ModelSetting() {
	const text = MESSAGES[useI18n().resolvedLocale];
	const defaults = ui.useModelDefaults();
	const [model, setModel] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(true);
	useEffect(() => {
		let alive = true;
		void api
			.model()
			.then(
				(value: string | undefined) => {
					if (alive) setModel(value);
				},
				(error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"),
			)
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, []);
	const inherited = defaults.sessionModel ?? defaults.defaultModel;
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={model ?? ""}
			disabled={busy}
			inheritLabel={text.followMain}
			{...(inherited ? { inheritedModelId: inherited } : {})}
			inheritedSource={text.followMainShort}
			inheritDetail={text.modelDetail}
			onChange={(next) => {
				const previous = model;
				setModel(next || undefined);
				void api.setModel(next || undefined).catch((error: unknown) => {
					setModel(previous);
					ui.notify(error instanceof Error ? error.message : String(error), "error");
				});
			}}
		/>
	);
}

export default {
	name: NAME,
	apply(context) {
		ui = context;
		api = context.remote<SideChatApi>();
		mountStyles();
		context.toolCard("dispatch_task", dispatchCard(context, api));
		context.panel(PANEL, SideChatPanel, {
			title: (locale) => MESSAGES[locale].title,
			description: (locale) => MESSAGES[locale].description,
			icon: MessagesSquare,
			shortcut: "Alt+CommandOrControl+S",
			multiple: true,
			restore: true,
			detachable: true,
			// 侧边聊天挂在一个会话旁边，新对话还没发消息时开不了。
			available: ({ session }) => session,
		});
		context.settingsSection("model", ModelSetting, {
			title: (locale) => MESSAGES[locale].modelTitle,
			detail: (locale) => MESSAGES[locale].modelDetail,
			page: "session-models",
		});
		context.queueAction({
			label: (locale) => MESSAGES[locale].queueSideChat,
			icon: MessageSquarePlus,
			// 问最早那一段（面板开着时人看到的那格）；还没有就新开一格。面板先打开，问的那句好在那边先画上。
			async run(message, sessionId) {
				const tab = (await api.firstTab(sessionId)) ?? crypto.randomUUID();
				const sideId = await api.open(tab, sessionId);
				ui.openPanel(PANEL, sessionId, { tab });
				void api.ask(sideId, message).catch((error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"));
			},
		});
		context.quoteAction({
			label: (locale) => MESSAGES[locale].quoteAskSide,
			run: (quote, sessionId) => context.quoteInPanel(PANEL, sessionId, quote),
		});
	},
} satisfies UiPlugin;
