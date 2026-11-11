/**
 * 侧边聊天里一次 `dispatch_task`、而人没点名交给主会话时画成的卡片：这件事交给谁做，人来选。
 *
 * 交给主会话是排进它的队列（`handToParent`，和人在主输入框里排的同一条队），开新会话经逻辑入口的 `launch` 开在主会话
 * 所在的项目里、记着从这张卡开出来（`spawnedFrom`），在这里做是替人对侧边聊天说一句「就在这里做」——它手上有那条指令，
 * 接着做就是。选过以后缩成一行；开新会话的那一行点了过去。
 *
 * 参数还在写、或者被点名直接派了的，都是普通的工具行（`fallback`）。
 */

import type { Remote, ToolCardProps, UiContext } from "@plume/contract/ui";
import { Button, Text, useI18n } from "@plume/ui";
import { Forward, MessageCircle, SquarePen } from "@plume/ui/icons";
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
	main: <Forward size={13} strokeWidth={1.8} aria-hidden />,
	here: <MessageCircle size={13} strokeWidth={1.8} aria-hidden />,
};

export function dispatchCard(ui: UiContext, api: Remote<SideChatApi>) {
	return function DispatchCard({ call, status, result, sessionId, handToParent, fallback }: ToolCardProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const details = status === "done" ? result?.details : undefined;
		const choice = useSyncExternalStore(subscribe, () => chosen.get(call.id));
		const [started, setStarted] = useState<string | undefined>(undefined);
		const [busy, setBusy] = useState<Choice | "new" | null>(null);
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

		if (started)
			return (
				<div data-side-dispatch="new" data-side-dispatch-call={call.id}>
					<button type="button" className="plume-side-dispatch-open plume-side-dispatch-chosen" onClick={() => ui.openSession(started)}>
						<SquarePen size={13} strokeWidth={1.8} aria-hidden />
						<Text size="detail">{text.dispatchedNew}</Text>
						<Text size="detail" tone="faint">
							{details.title}
						</Text>
					</button>
				</div>
			);
		if (choice)
			return (
				<div data-side-dispatch={choice} data-side-dispatch-call={call.id} className="plume-side-dispatch-chosen">
					{CHOSEN_ICON[choice]}
					<Text size="detail">{choice === "main" ? text.dispatchedMain : text.dispatchHere}</Text>
					<Text size="detail" tone="faint">
						{details.title}
					</Text>
				</div>
			);

		const act = async (next: Choice | "new") => {
			if (busy) return;
			setBusy(next);
			try {
				if (next === "new") {
					setStarted(await api.launch(sessionId, call.id));
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
			<section data-side-dispatch="pending" data-side-dispatch-call={call.id} aria-label={details.title} className="plume-side-dispatch">
				<p className="plume-side-dispatch-title">
					<Forward size={14} strokeWidth={1.7} aria-hidden />
					<Text size="label" weight="medium">
						{details.title}
					</Text>
				</p>
				<Text as="p" size="caption" tone="muted" className="plume-side-dispatch-instruction" data-plume-tip={details.instruction}>
					{details.instruction}
				</Text>
				<div className="plume-side-dispatch-actions">
					<Button
						size="sm"
						variant="primary"
						loading={busy === "main"}
						disabled={busy !== null}
						label={text.dispatchToMainTip}
						onClick={() => void act("main")}
						data-side-dispatch-action="main"
					>
						{text.dispatchToMain}
					</Button>
					<Button
						size="sm"
						variant="soft"
						loading={busy === "new"}
						disabled={busy !== null}
						label={text.dispatchNewTip}
						onClick={() => void act("new")}
						data-side-dispatch-action="new"
					>
						{text.dispatchNew}
					</Button>
					<Button
						size="sm"
						variant="soft"
						loading={busy === "here"}
						disabled={busy !== null}
						label={text.dispatchHereTip}
						onClick={() => void act("here")}
						data-side-dispatch-action="here"
					>
						{text.dispatchHere}
					</Button>
				</div>
			</section>
		);
	};
}
