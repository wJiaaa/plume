import type { CodeBlockProps } from "@plume/contract/ui";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { Transcript } from "../conversation/view-state.ts";
import { CodeBlockSlot } from "../plugins.tsx";

/** 只有助手正文显式提供；用户消息、思考、文件及插件自己的 Markdown 不继承发送能力。 */
export const ReplyCodeScope = createContext<{ messageId: string; part: number; complete: boolean; streaming: boolean } | null>(null);

const usedEvents = new WeakSet<Event>();

export function ReplyCode({
	language,
	code,
	open,
	path,
	fallback,
	unregistered,
}: {
	language: string;
	code: string;
	open: boolean;
	path: string;
	fallback: ReactNode;
	unregistered: ReactNode;
}) {
	const reply = useContext(ReplyCodeScope);
	const transcript = useContext(Transcript);
	const complete = Boolean(reply?.complete && !reply.streaming && !open);
	const identity = `${transcript?.sessionId}:${reply?.messageId}:${reply?.part}:${path}`;
	const current = useRef({ identity, complete, send: transcript?.send });
	current.current = { identity, complete, send: transcript?.send };
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	if (!reply || !transcript) return <>{unregistered}</>;
	const send: NonNullable<CodeBlockProps["send"]> = async (text, event) => {
		const source = event.nativeEvent;
		// 模型只能描述控件；真正的用户事件才可发消息，不能在渲染、计时器或卸载后的闭包里调用。
		if (
			!mounted.current ||
			current.current.identity !== identity ||
			!current.current.complete ||
			!current.current.send ||
			!(source instanceof Event) ||
			!source.isTrusted ||
			!navigator.userActivation.isActive ||
			!["click", "submit"].includes(source.type) ||
			!event.currentTarget ||
			usedEvents.has(source)
		)
			throw new Error("Code block submission requires a user action");
		if (typeof text !== "string" || !text.trim() || text.length > 32_000) throw new Error("Invalid code block message");
		usedEvents.add(source);
		await current.current.send(text);
	};
	return (
		<CodeBlockSlot
			language={language}
			code={code}
			sessionId={transcript.sessionId}
			messageId={reply.messageId}
			blockId={`${reply.part}:${path}`}
			streaming={reply.streaming}
			complete={complete}
			fallback={fallback}
			unregistered={unregistered}
			{...(complete && transcript.send ? { send } : {})}
		/>
	);
}
