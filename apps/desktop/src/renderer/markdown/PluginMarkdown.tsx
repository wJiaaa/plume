/** 插件的正文沿用产品渲染器；显式指定会话时，文件签也使用那一场对话的边界。 */
import type { MarkdownProps } from "@plume/contract/ui";
import type { Message } from "@plume/contract";
import { Fragment, useMemo, type ReactNode } from "react";
import { FileScope, useFileScopeValue } from "../files/scope.ts";
import { useLiveSession } from "../session-live.ts";
import { type Inline, parseInline } from "./inline.ts";
import { Markdown } from "./Markdown.tsx";

export function PluginMarkdown({ sessionId, inline, variant, className, ...rest }: MarkdownProps) {
	const view = useLiveSession(sessionId);
	const files = useFileScopeValue(view?.summary.id ?? "", view?.summary.cwd ?? "", view?.messages ?? NO_MESSAGES);
	const scope = view ? files : null;
	if (inline) return <InlineMarks text={rest.text} className={className} />;
	// 排版归本体：插件只说要哪一种，类名和样子在 `markdown.css` 的 `.markdown-document`。
	const props = { ...rest, className: variant === "document" ? `${className ?? ""} markdown-document` : (className ?? "") };
	return sessionId ? (
		<FileScope.Provider value={scope}>
			<Markdown {...props} />
		</FileScope.Provider>
	) : (
		<Markdown {...props} />
	);
}

/** 还没读到会话时的那一份：身份不变，碰过的文件不跟着每次重画重算。 */
const NO_MESSAGES: readonly Message[] = [];

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
