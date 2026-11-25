/**
 * 选择卡：回复末尾的 `choices` 围栏画成的卡片（`ui.codeBlock`）。点一项就当人的消息发出去，卡片换成只写着答案的样子；
 * 右上角关闭是不采用，什么都不发。人直接打字回答了也是不采用，卡片一样拿掉。见 choices.ts。
 */

import type { CodeBlockProps, Remote, UiContext } from "@plume/contract/ui";
import { Button, IconButton, Text, useI18n } from "@plume/ui";
import { X } from "@plume/ui/icons";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { type AskUserApi, cardKey, DISMISSED } from "./api.ts";
import { type Choice, type Choices, outcomeOf, readChoices } from "./choices.ts";
import { MESSAGES } from "./messages.ts";

/** 停着、也没有排着的了，过这么久才算那句话没进会话：一轮收尾时先出队、下一轮再开始，中间有一下两样都没有。 */
const SETTLE_MS = 1000;

type Host = Pick<UiContext, "useSession" | "useSessionStore" | "notify">;

export function ChoiceBlock(props: CodeBlockProps & { host: Host; api: Remote<AskUserApi> }) {
	const choices = useMemo(() => readChoices(props.code), [props.code]);
	// 还在写的 JSON 不露出来，写完才画。
	if (!choices) return props.streaming ? null : <>{props.fallback}</>;
	return <ChoiceCard {...props} choices={choices} />;
}

function ChoiceCard({
	choices,
	sessionId,
	messageId,
	blockId,
	streaming,
	send,
	host,
	api,
}: CodeBlockProps & { choices: Choices; host: Host; api: Remote<AskUserApi> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const session = host.useSession(sessionId);
	const dismissed = host.useSessionStore<string>(DISMISSED, sessionId);
	const [picking, setPicking] = useState<Choice>();
	const [failed, setFailed] = useState(false);
	const messages = session?.messages;
	const queue = session?.queue;
	const outcome = useMemo(() => (messages && queue && !streaming ? outcomeOf(choices, messages, queue) : "open"), [choices, messages, queue, streaming]);
	const running = session?.summary.running === true;
	const queued = queue !== undefined && queue.length > 0;

	/*
	 * 点下去到那句话落进会话之间有一段空当（过发送前的钩子），这期间靠 `picking` 画成已选，按钮不会再露出来。
	 * 这一轮跑完、也没有排着的了，那句话还没进会话（被钩子拦下、从排队条上撤回），就放开让人再选。
	 */
	const ran = useRef(false);
	useEffect(() => {
		if (!picking) ran.current = false;
		else if (running) ran.current = true;
		else if (ran.current && !queued) {
			const timer = setTimeout(() => setPicking(undefined), SETTLE_MS);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [picking, running, queued]);

	const key = cardKey(messageId, blockId);
	if (!session || dismissed === undefined || dismissed === key || outcome === "passed") return null;
	const picked = outcome === "open" ? picking : outcome;

	function pick(choice: Choice, event: MouseEvent<HTMLButtonElement>) {
		if (!send || picking) return;
		setPicking(choice);
		setFailed(false);
		// 必须在这次点击里同步调用。第三参让气泡里的字原样存下，`outcomeOf` 按它认选了哪一项。没发出去的原因由宿主弹提示条。
		send(choice.send, event, choice.send).catch(() => {
			setPicking(undefined);
			setFailed(true);
		});
	}

	function close() {
		void api.dismiss(sessionId, key).catch((error: unknown) => host.notify(error instanceof Error ? error.message : String(error), "error"));
	}

	return (
		<section className="plume-choice" aria-label={choices.question} data-choice-card={picked ? "answered" : "open"}>
			{choices.summary && (
				<Text as="p" size="detail" tone="muted" className="plume-choice-summary">
					{choices.summary}
				</Text>
			)}
			<Text as="p" size="label" weight="medium" className={choices.summary ? "plume-choice-words" : "plume-choice-words plume-choice-summary"}>
				{choices.question}
			</Text>
			{picked ? (
				<Text as="p" size="label" tone="muted" className="plume-choice-answer" data-choice-answer="">
					{picked.label}
				</Text>
			) : (
				<>
					<div className="plume-choice-actions">
						{choices.options.map((choice) => (
							<Button
								key={choice.send}
								variant={choice.recommended ? "primary" : "soft"}
								className={choice.recommended ? "plume-choice-option" : "plume-choice-option plume-choice-plain"}
								disabled={!send}
								onClick={(event) => pick(choice, event)}
								data-choice-option=""
							>
								{choice.label}
							</Button>
						))}
					</div>
					{failed && (
						<Text as="p" size="caption" tone="danger" role="alert">
							{text.choiceFailed}
						</Text>
					)}
					{send && (
						<span className="plume-choice-close">
							<IconButton label={text.choiceClose} icon={<X size={16} />} tipSide="top" onClick={close} data-choice-close="" />
						</span>
					)}
				</>
			)}
		</section>
	);
}
