/**
 * 侧边聊天插件的界面入口：「侧边聊天」面板，一个标签一段侧边聊天，能开好几个。
 *
 * 标签和侧边聊天的对应由逻辑入口持久保存；新开的标签认领这个会话旁边还没有标签认领的、最新的那段，
 * 没有就空着，第一句发出去时再开一段。恢复标签或换窗口时，按同一个 tab 接回原会话。
 * 关标签就是删掉那段侧边聊天，说过话的先问一句；勾了「不再询问」关过一次以后就不问了。
 * 人没看着的那一格回复完了，标签上亮一个未读点，切过去就灭。
 *
 * 主输入框排队条的「更多」菜单里加一项「在侧边聊天中打开」：这句话先拿到侧边聊天问，不占用正在跑的这一轮。
 *
 * 输入框和主输入框一样：`/` 弹命令菜单；侧边聊天在跑时回车插进这一轮、⌘回车排到这一轮之后，还没读到的画在回执条里。
 */

import type { ChildTasksProps, PanelProps, Remote, UiContext, UiPlugin } from "@plume/contract/ui";
import type { OutgoingMessage } from "@plume/contract";
import { ChoiceMark, Confirm, PanelEmpty, Text, useI18n } from "@plume/ui";
import { Activity, History, MessageSquarePlus, MessagesSquare } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { SideChatApi, SideChatSettings, WaitingEntry } from "./api.ts";
import { isSentToSession } from "./controls.ts";
import { dispatchCard } from "./DispatchCard.tsx";
import { MESSAGES } from "./messages.ts";
import { TaskStrip, type Waiting } from "./TaskStrip.tsx";
import sideChatCss from "./side-chat.css";

const PANEL = "chat";
const NAME = "plume.side-chat";
/** 转录一行里搜的词只露个开头。 */
const SUBJECT_CHARS = 40;

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

const fail = (error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error");

/** 排着的话变了（这里排进去、拿掉的）：开着的回执条重新问一遍。逻辑入口那边的变化跟着会话的运行状态、消息条数来。 */
const waitingChanged = new Set<() => void>();
const refreshWaiting = () => {
	for (const refresh of waitingChanged) refresh();
};

function useWaiting(sideId: string): WaitingEntry[] {
	const side = ui.useSession(sideId);
	const [entries, setEntries] = useState<WaitingEntry[]>([]);
	const [asked, setAsked] = useState(0);
	useEffect(() => {
		const refresh = () => setAsked((count) => count + 1);
		waitingChanged.add(refresh);
		return () => {
			waitingChanged.delete(refresh);
		};
	}, []);
	const running = side?.summary.running;
	const said = side?.messages.length;
	useEffect(() => {
		let current = true;
		void api.waiting(sideId).then((found) => {
			if (current) setEntries(found);
		}, fail);
		return () => {
			current = false;
		};
	}, [sideId, running, said, asked]);
	return entries;
}

/** 回执条：交给主会话的那几件，接着这段侧边聊天里还没被读到的话。 */
function Strip(props: ChildTasksProps) {
	const entries = useWaiting(props.sessionId);
	const running = ui.useSession(props.sessionId)?.summary.running === true;
	const { putBack } = props;
	const waiting: Waiting = {
		entries,
		running,
		sendNow: (id) => void api.sendNow(props.sessionId, id).catch(fail).finally(refreshWaiting),
		remove: (id) => void api.unqueue(props.sessionId, id).catch(fail).finally(refreshWaiting),
		...(putBack
			? {
					withdraw: (id: string) =>
						void api
							.unqueue(props.sessionId, id)
							.then((text) => {
								if (text !== undefined) putBack(text);
							}, fail)
							.finally(refreshWaiting),
				}
			: {}),
	};
	return <TaskStrip {...props} waiting={waiting} />;
}

function SideChatPanel({ session, tab, shown, setTitle, setUnread, onClose }: PanelProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const parentId = session?.summary.id;
	const [sideId, setSideId] = useState<string | undefined>(undefined);
	const sideIdRef = useRef(sideId);
	sideIdRef.current = sideId;
	const closing = useRef(false);
	const side = ui.useSession(sideId);
	const [asking, setAsking] = useState<((sure: boolean) => void) | undefined>(undefined);

	// 打开就接上这个标签的那段，没有就新建：和主会话一样，第一句之前会话就在，命令、模型菜单都按它来。卸载不能删除绑定或子会话。
	useEffect(() => {
		if (!parentId) return;
		let current = true;
		closing.current = false;
		void api.open(tab, parentId).then(
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

	// 人没看着这一格时回复完了（后台标签、面板收起），标签上点个未读点；看到了就清掉。
	const running = side?.summary.running ?? false;
	const wasRunning = useRef(running);
	useEffect(() => {
		if (wasRunning.current && !running && !shown) setUnread(true);
		wasRunning.current = running;
	}, [running, shown, setUnread]);
	useEffect(() => {
		if (shown) setUnread(false);
	}, [shown, setUnread]);

	// 关标签：说过话的先问一句，确认了就删掉这段。人在确认框里点的结果经 `asking` 交回。
	const said = side ? side.messages.length > 0 : Boolean(sideId);
	const saidRef = useRef(said);
	saidRef.current = said;
	const send = async (question: string | OutgoingMessage) => {
		if (!parentId || closing.current) return;
		const id = await api.open(tab, parentId);
		if (closing.current) return;
		setSideId(id);
		// 在跑时打的话插进这一轮；已经停了的由逻辑入口照常发。
		if (running) await api.steer(id, question);
		else await api.ask(id, question);
		refreshWaiting();
	};
	const queue = async (question: OutgoingMessage) => {
		const id = sideIdRef.current;
		if (!id || closing.current) return;
		await api.queue(id, question);
		refreshWaiting();
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
				tasks={Strip}
				empty={
					<PanelEmpty icon={MessagesSquare} title={text.title}>
						{text.empty}
					</PanelEmpty>
				}
				composer={{
					draftKey: tab,
					model: "choose",
					placeholder: (locale) => MESSAGES[locale].placeholder,
					send,
					sendMessage: send,
					mode: "steer",
					queue,
					commands: true,
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
	const [settings, set] = ui.useSettings<SideChatSettings>();
	const inherited = defaults.sessionModel ?? defaults.defaultModel;
	return (
		<ui.ModelSelect
			ariaLabel={text.modelTitle}
			value={settings?.model ?? ""}
			disabled={settings === undefined}
			inheritLabel={text.followMain}
			{...(inherited ? { inheritedModelId: inherited } : {})}
			inheritedSource={text.followMainShort}
			inheritDetail={text.modelDetail}
			onChange={(next) =>
				void set({ model: next || undefined }).catch((error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error"))
			}
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
		// 转录里那一行：「翻看主会话 关键词」「暂停主会话」，不露工具名。
		context.toolLine("read_main_chat", {
			verb: (locale) => MESSAGES[locale].readMainChat,
			subject: (args) => (typeof args.query === "string" && args.query.trim() ? args.query.trim().slice(0, SUBJECT_CHARS) : undefined),
			icon: History,
		});
		context.toolLine("control_main", {
			verb: (locale) => MESSAGES[locale].controlMain,
			verbFor({ args }, locale) {
				const text = MESSAGES[locale];
				if (args.action === "pause") return args.discardPlan === true ? text.controlMainPauseDiscard : text.controlMainPause;
				if (args.action === "resume") return text.controlMainResume;
				if (args.action === "status") return text.controlMainStatus;
				return undefined;
			},
			icon: Activity,
		});
		context.toolLine("send_to_session", {
			verb: (locale) => MESSAGES[locale].sendToSession,
			subject: (args, details) => {
				if (isSentToSession(details)) return details.title.slice(0, SUBJECT_CHARS);
				return typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim().slice(0, SUBJECT_CHARS) : undefined;
			},
			icon: MessagesSquare,
		});
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
				void api.ask(sideId, message).then(refreshWaiting, fail);
			},
		});
		context.quoteAction({
			label: (locale) => MESSAGES[locale].quoteAskSide,
			run: (quote, sessionId) => context.quoteInPanel(PANEL, sessionId, quote),
		});
	},
} satisfies UiPlugin;
