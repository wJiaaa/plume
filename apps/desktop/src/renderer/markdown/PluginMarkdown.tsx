/** 插件的正文沿用产品渲染器；显式指定会话时，文件签也使用那一场对话的边界。 */
import type { MarkdownProps } from "@plume/contract/ui";
import { Fragment, useMemo, type ReactNode } from "react";
import { FileScope, touchedPaths } from "../files/scope.ts";
import { useLiveSession } from "../session-live.ts";
import { type Inline, parseInline } from "./inline.ts";
import { Markdown } from "./Markdown.tsx";

export function PluginMarkdown({ sessionId, inline, ...props }: MarkdownProps) {
	const view = useLiveSession(sessionId);
	const scope = useMemo(
		() => (view ? { sessionId: view.summary.id, cwd: view.summary.cwd, touched: touchedPaths(view.messages) } : null),
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- view 每拍都是新对象，按它的几个字段记住
		[view?.summary.id, view?.summary.cwd, view?.messages],
	);
	if (inline) return <InlineMarks text={props.text} className={props.className} />;
	return sessionId ? (
		<FileScope.Provider value={scope}>
			<Markdown {...props} />
		</FileScope.Provider>
	) : (
		<Markdown {...props} />
	);
}

/** 一句短话里的行内记号（`MarkdownProps.inline`）：链接、图片、公式、HTML 标签只留字，这里没有值得跳过去的地方。 */
function InlineMarks({ text, className }: { text: string; className?: string }) {
	const tokens = useMemo(() => parseInline(text), [text]);
	return <span className={className}>{marks(tokens)}</span>;
}

function marks(tokens: Inline[]): ReactNode[] {
	return tokens.map((token, index) => <Fragment key={index}>{mark(token)}</Fragment>);
}

function mark(token: Inline): ReactNode {
	switch (token.kind) {
		case "text":
			return token.text;
		// 一句话里的几个记号自带样子，不跟着正文的代码外观走：在哪个插件的卡片里都是同一副样子。
		case "code":
			return <code className="rounded-sm bg-card-hover px-1 py-px font-mono text-code text-ink">{token.text}</code>;
		case "strong":
			return <strong className="font-semibold text-ink">{marks(token.children)}</strong>;
		case "em":
			return <em>{marks(token.children)}</em>;
		case "del":
			return <del>{marks(token.children)}</del>;
		case "link":
		case "tag":
			return marks(token.children);
		case "break":
			return <br />;
		case "math":
			return token.tex;
		case "image":
			return token.alt;
	}
}
