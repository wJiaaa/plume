/**
 * 侧边聊天里一次 `dispatch_task`、而人没点名交给主会话时画成的卡片：这件事交给谁做，人来选。
 *
 * 交给主会话是排进它的队列（`handToParent`，和人在主输入框里排的同一条队），开新会话经逻辑入口的 `launch` 开在主会话
 * 所在的项目里、记着从这张卡开出来（`spawnedFrom`），在这里做是替人对侧边聊天说一句「就在这里做」——它手上有那条指令，
 * 接着做就是。选过以后缩成一行过程行（`FlowRow`）；开新会话的那一行和建议新会话开始以后的那一行一个样：在跑时扫光、没跑完标红，点了过去。
 *
 * 卡片的外框、标题行和说明是 `@plume/styles` 的 `proposal`，和主对话里的建议新会话卡同一副骨架。底下不是一排按钮，是一列去处：
 * 一行一个、整行点了就交出去；只有开新会话要选模型和思考档位，它们就放在那一行的右端，一眼看得出只管新会话。
 * 模型和档位从默认的起步，没动过就不交，开出来的会话用默认的。
 *
 * 参数还在写、或者被点名直接派了的，都是普通的工具行（`fallback`）。
 */

import type { ThinkingLevel } from "@plume/contract";
import type { Remote, ToolCardProps, UiContext } from "@plume/contract/ui";
import { proposal } from "@plume/styles";
import { ActionSpinner, FlowRow, Text, useI18n } from "@plume/ui";
import { ChevronRight, Forward, MessageCircle, SquarePen } from "@plume/ui/icons";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { SideChatApi } from "./api.ts";
import { isDispatchSuggestion } from "./controls.ts";
import { MESSAGES } from "./messages.ts";

type Choice = "main" | "here";

/**
 * 人在卡片上选过什么，按调用记。只在这个窗口的内存里：交给主会话、在这里做之后卡片收起来就够了，那件事在主会话
 * 或这里的记录里照样看得到。开新会话的那张不靠它：从会话列表里认得出来（`started`）。
 */
const chosen = new Map<string, Choice>();
const listeners = new Set<() => void>();
function choose(callId: string, choice: Choice | null): void {
	if (choice) chosen.set(callId, choice);
	else chosen.delete(callId);
	for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const CHOSEN_ICON: Record<Choice, ReactNode> = {
	main: <Forward size={13} strokeWidth={1.8} />,
	here: <MessageCircle size={13} strokeWidth={1.8} />,
};

export function dispatchCard(ui: UiContext, api: Remote<SideChatApi>) {
	return function DispatchCard({ call, status, result, sessionId, handToParent, fallback }: ToolCardProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const details = status === "done" ? result?.details : undefined;
		const choice = useSyncExternalStore(subscribe, () => chosen.get(call.id));
		const [started, setStarted] = useState<string | undefined>(undefined);
		const [busy, setBusy] = useState<Choice | "new" | null>(null);
		const [model, setModel] = useState("");
		const [thinking, setThinking] = useState<ThinkingLevel>();
		const ready = isDispatchSuggestion(details) && sessionId !== undefined && handToParent !== undefined;

		// 开新会话那一行要认得出这张卡开过的会话：重开面板、换窗口回来也一样。
		useEffect(() => {
			if (!ready) return;
			let alive = true;
			void api.started(sessionId, call.id).then(
				(id) => {
					if (alive) setStarted(id);
				},
				() => undefined,
			);
			return () => {
				alive = false;
			};
		}, [ready, sessionId, call.id]);

		if (!ready) return <>{fallback}</>;

		if (started) return <Started ui={ui} callId={call.id} title={details.title} startedId={started} />;
		if (choice)
			return (
				<div data-side-dispatch={choice} data-side-dispatch-call={call.id}>
					<FlowRow
						icon={CHOSEN_ICON[choice]}
						title={<span className="plume-side-plain">{choice === "main" ? text.dispatchedMain : text.dispatchHere}</span>}
						summary={details.title}
					/>
				</div>
			);

		const act = async (next: Choice | "new") => {
			if (busy) return;
			setBusy(next);
			try {
				if (next === "new") {
					setStarted(await api.launch(sessionId, call.id, { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }));
					return;
				}
				// 先记下，卡片当场收起；没成再退回去。
				choose(call.id, next);
				if (next === "main") await handToParent(details.instruction);
				else await api.ask(sessionId, text.dispatchHereMessage(details.title));
			} catch (error) {
				if (next !== "new") choose(call.id, null);
				const reason = error instanceof Error ? error.message : String(error);
				ui.notify(next === "main" ? text.dispatchFailed(reason) : reason, "error");
			} finally {
				setBusy(null);
			}
		};

		return (
			<section data-side-dispatch="pending" data-side-dispatch-call={call.id} aria-label={details.title} className={proposal.frame}>
				<p className={proposal.head}>
					<Forward size={14} strokeWidth={1.7} aria-hidden className={proposal.icon} />
					<Text size="label" weight="medium">
						{details.title}
					</Text>
				</p>
				<Text as="p" size="caption" tone="muted" className={proposal.summary} data-plume-tip={details.instruction}>
					{details.instruction}
				</Text>
				<div className="plume-side-dests">
					<Destination
						action="main"
						icon={<Forward size={15} strokeWidth={1.8} />}
						label={text.dispatchToMain}
						tip={text.dispatchToMainTip}
						busy={busy}
						onPick={() => void act("main")}
					/>
					<Destination
						action="new"
						icon={<SquarePen size={15} strokeWidth={1.8} />}
						label={text.dispatchNew}
						tip={text.dispatchNewTip}
						busy={busy}
						onPick={() => void act("new")}
					>
						<div className="plume-side-dest-model">
							<ui.ModelControls
								model={model}
								{...(thinking ? { thinking } : {})}
								onModelChange={setModel}
								onThinkingChange={setThinking}
								disabled={busy !== null}
							/>
						</div>
					</Destination>
					<Destination
						action="here"
						icon={<MessageCircle size={15} strokeWidth={1.8} />}
						label={text.dispatchHere}
						tip={text.dispatchHereTip}
						busy={busy}
						onPick={() => void act("here")}
					/>
				</div>
			</section>
		);
	};
}

/**
 * 一个去处：整行是一颗按钮（点击区经 `::after` 铺满整行），行尾悬停时出一个 ›。给了 `children`（开新会话那行的模型和档位）就放在行尾，
 * 浮在点击区上面，点它们是选，不是交出去。正在交的那行图标换成转圈，交的时候几行都按不动。
 */
function Destination({
	action,
	icon,
	label,
	tip,
	busy,
	onPick,
	children,
}: {
	action: Choice | "new";
	icon: ReactNode;
	label: string;
	tip: string;
	busy: Choice | "new" | null;
	onPick(): void;
	children?: ReactNode;
}) {
	const mine = busy === action;
	return (
		<div className="plume-side-dest" data-busy={mine || undefined}>
			<button
				type="button"
				className="plume-side-dest-pick"
				disabled={busy !== null}
				aria-busy={mine || undefined}
				data-plume-tip={tip}
				onClick={onPick}
				data-side-dispatch-action={action}
			>
				{mine ? <ActionSpinner size={15} /> : icon}
				<Text size="label">{label}</Text>
			</button>
			{children ?? <ChevronRight size={14} strokeWidth={2} aria-hidden className="plume-side-dest-go" />}
		</div>
	);
}

/**
 * 卡片开出来的会话那一行：在跑时摘要扫光，没跑完（出错、跑到上限、卡住）在行尾标红，点了过去。
 * 跑完、没跑完是侧栏行首那个记号，人打开看过就清掉，这里跟着退回只写标题。
 */
function Started({ ui, callId, title, startedId }: { ui: UiContext; callId: string; title: string; startedId: string }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const running = ui.useSession(startedId)?.summary.running === true;
	const activity = ui.useSessionActivity(startedId);
	const failed = !running && activity === "failed";
	return (
		<div data-side-dispatch="new" data-side-dispatch-call={callId}>
			<FlowRow
				icon={<SquarePen size={13} strokeWidth={1.8} />}
				title={<span className="plume-side-plain">{text.dispatchedNew}</span>}
				summary={title}
				running={running}
				trailing={
					<>
						{failed && <span className="plume-side-failed">{text.dispatchedFailed}</span>}
						{/* 点了是去那个会话，不是就地展开：箭头自己画。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => void ui.openSession(startedId)}
				label={failed ? `${title} · ${text.dispatchedFailed}` : title}
			/>
		</div>
	);
}
