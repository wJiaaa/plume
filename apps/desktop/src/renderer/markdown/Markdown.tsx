/**
 * 回复里的 Markdown。
 *
 * 手写，而不是 `marked` 加 `dangerouslySetInnerHTML`：模型的输出不可信，拼成 React 元素意味着每一段字
 * 进来时都经过 React 的转义。
 *
 * 这个文件只管画。哪几行是表格、哪几个字符是强调，在 `blocks.ts` 和 `inline.ts` 里决定，那里能测。
 *
 * 图片由本体显示，失败保留链接；正文代码块可交给插件，未注册或失败时显示源码。链接见 `MarkdownLink.tsx`。
 */

import { Disclosure, OverlayScrollbar, translate } from "@plume/ui";
import { Fragment, memo, type ReactNode, useMemo, useRef, useSyncExternalStore } from "react";

import type { Block, ListItem } from "./blocks.ts";
import { parseMarkdown, parseMarkdownChunks } from "./blocks.ts";
import { BlockScan, FadeIn, FadeScope, FadeText } from "./FadeText.tsx";
import { type Inline, parseInline } from "./inline.ts";
import { filePathInCode } from "./file-link.ts";
import { MarkdownCode } from "./MarkdownCode.tsx";
import { ImageDocument, MarkdownImage } from "./MarkdownImage.tsx";
import { ReplyCode, ReplyCodeScope } from "./ReplyCode.tsx";
import { Link } from "./MarkdownLink.tsx";
import { MarkdownTable } from "./MarkdownTable.tsx";
import { mathReady, onMathReady, renderMath } from "./math.ts";
import { isMermaid, MermaidBlock } from "./MermaidBlock.tsx";
import { groupTokens, HUGE_BLOCK } from "./slice.ts";
import { completeTailHeld } from "./stream-tail.ts";
import { stripEmoji } from "./strip-emoji.ts";
import { useSmoothText } from "./useSmoothText.ts";

/**
 * 正文按 props memo，解析另按文本缓存；回复元信息只用于代码块扩展。
 *
 * 解析是画一份对话最贵的那一半，而它常常因为和文字无关的原因被重做：拖侧栏的边会让读布局的组件全都
 * 重画，一路传到这里，一次拖动就把几百 KB 的 Markdown 重新解析几十遍。窗格变宽不改变消息的任何东西，
 * 一层浅比较就说清了。
 */
export const Markdown = memo(function Markdown({
	text,
	className = "",
	streaming = false,
	reply,
	baseDir,
	sessionId,
	localImages = false,
	remoteImages = false,
}: {
	/** 文档自己的目录和读取会话；图片不能借当前会话跨目录读取。 */
	baseDir?: string;
	sessionId?: string;
	localImages?: boolean;
	remoteImages?: boolean;
	reply?: { messageId: string; part: number; complete: boolean; streaming: boolean };
	text: string;
	className?: string;
	/**
	 * 这段字还在一个字一个字地进来。
	 *
	 * 开着时做三件事：出字按平滑的节奏走（见 `useSmoothText`），新字淡入（见 `FadeText`），最后
	 * 一段没写完的标记先补上（见 `completeTail`）。只由画正在输出的那条回复的地方打开；关掉之后
	 * 先把剩下的字放完、淡完，再画原文本身。
	 */
	streaming?: boolean;
}) {
	// 写完之后还要演完：没放出来的字放完、最后一个字淡完，`active` 才落下。见 `useSmoothText`。
	const { text: shown, active, recent } = useSmoothText(text, streaming);
	// 围栏里的原文是插件的数据，不能清理字符；系统表情只在下面画普通文字时拿掉。
	const { text: clean, heldImage } = useMemo(() => (active ? completeTailHeld(shown) : { text: shown, heldImage: false }), [shown, active]);
	const doc = useMemo(
		() => ({ baseDir, sessionId, localImages, remoteImages, streaming: streaming || active }),
		[baseDir, sessionId, localImages, remoteImages, streaming, active],
	);

	/*
	 * 新挂上的一段字按位置分辨哪些字是刚放出来的（见 `FadeText`）：`clean` 从 `from` 起是最近淡入时长内
	 * 放出来的。改同一个对象，不换引用，否则每个 `FadeText` 每帧都跟着重画。补尾巴、去表情让 `clean`
	 * 和放出来的原文差几个字，边界也就差几个字——肉眼看不出。
	 */
	const scope = useRef({ from: Number.POSITIVE_INFINITY }).current;
	scope.from = active ? Math.max(0, clean.length - recent) : Number.POSITIVE_INFINITY;
	const blocks = useMemo(() => {
		// 每一块的原文在 `clean` 里从哪开始：块的原文就是源文的一段，依次找过去。
		let cursor = 0;
		return parseMarkdownChunks(clean).map(({ block, raw }, index) => {
			const found = clean.indexOf(raw, cursor);
			const start = found < 0 ? cursor : found;
			cursor = start + raw.length;
			return <BlockView key={index} block={block} raw={raw} start={start} fade={active} />;
		});
	}, [clean, active]);

	/*
	 * `min-w-0`：这里常是 flex 子项，而内容不全能缩。flex 子项默认 `min-width: auto`，一段带着 40 个字符
	 * 不断开的哈希的代码块会把它撑宽，`pre` 自己的横滚永远轮不到，宽度一路顶到所有祖先。
	 */
	// 按字段记住：流式时这里每帧都重画，换一个新对象会让每个读它的代码块跟着重画，BlockView 的 memo 拦不住 context。
	const messageId = reply?.messageId;
	const part = reply?.part;
	const complete = reply?.complete;
	const replyStreaming = reply ? reply.streaming || active : undefined;
	const replyScope = useMemo(
		() =>
			messageId === undefined || part === undefined || complete === undefined || replyStreaming === undefined
				? null
				: { messageId, part, complete, streaming: replyStreaming },
		[messageId, part, complete, replyStreaming],
	);
	return (
		<ReplyCodeScope.Provider value={replyScope}>
			<ImageDocument.Provider value={doc}>
				<FadeScope.Provider value={scope}>
					<div className={`markdown min-w-0 ${className}`}>
						{blocks}
						{heldImage && localImages && <MarkdownImage src={null} alt="" fallback={null} />}
					</div>
				</FadeScope.Provider>
			</ImageDocument.Provider>
		</ReplyCodeScope.Provider>
	);
});

/**
 * 一个顶层块，原文没变就不重画。
 *
 * 流式输出时整条消息每帧都要重新解析，这本身不贵；贵的是随后把前面所有块——每个链接、每张表、
 * 每个代码块——再对一遍。原文相同的块画出来必然相同，所以只比原文：一条长回复写到后面，每帧重画的
 * 只有正在写的那一块。
 *
 * `fade` 在整条回复写完时一起关掉，所有块各重画一次，淡入用的 span 换回纯文本。
 */
const BlockView = memo(
	function BlockView({ block, raw, start, fade }: { block: Block; raw: string; start: number; fade: boolean }) {
		// 每画一次从头找：块里的每段字按文档顺序在原文里找自己的位置，见 `FadeText`。
		const scan = { raw, start, cursor: 0 };
		// 有意每次新建：cursor 在这一次渲染里往前走，下一次要从头找。
		// oxlint-disable-next-line react/jsx-no-constructed-context-values
		return <BlockScan.Provider value={scan}>{renderBlock(block, fade, String(start))}</BlockScan.Provider>;
	},
	(before, after) => before.raw === after.raw && before.start === after.start && before.fade === after.fade,
);

function renderBlocks(source: string, fade = false, path = ""): ReactNode {
	return parseMarkdown(source).map((block, index) => <Fragment key={index}>{renderBlock(block, fade, `${path}:${index}`)}</Fragment>);
}

/** `fade`：这块字还在输出，新字淡入。见 `FadeText`。 */
function renderBlock(block: Block, fade = false, path = ""): ReactNode {
	switch (block.kind) {
		case "heading": {
			const Tag = `h${Math.min(block.level, 4)}` as "h1" | "h2" | "h3" | "h4";
			return <Tag style={block.align ? { textAlign: block.align } : undefined}>{inline(block.text, fade)}</Tag>;
		}
		/*
		 * 一个 `<div align="center">` 和它里面的东西。`text-align` 会继承，所以不用往子元素里推：
		 * 盒子上一条声明就管住里面的每一样，和浏览器里同样三行的表现一致。
		 */
		case "html":
			return (
				<div className="markdown-html" style={block.align ? { textAlign: block.align } : undefined}>
					{block.children.map((child, index) => (
						<Fragment key={index}>{renderBlock(child, fade, `${path}:${index}`)}</Fragment>
					))}
				</div>
			);
		case "paragraph":
			// 大到会把浏览器按住不放的那种，切开画；正常的一段走原路，一行代码都不多跑。
			if (block.text.length > HUGE_BLOCK) return <HugeParagraph text={block.text} />;
			return <p>{inline(block.text, fade)}</p>;
		case "code": {
			const code = <MarkdownCode lang={block.lang} code={block.code} fade={fade} />;
			const fallback = isMermaid(block.lang) ? <MermaidBlock code={block.code} fallback={code} /> : code;
			return <ReplyCode language={block.lang} code={block.code} open={block.open === true} path={path} fallback={code} unregistered={fallback} />;
		}
		case "rule":
			return <hr />;
		case "quote":
			return <blockquote>{renderBlocks(block.text, fade, path)}</blockquote>;
		case "math":
			return <MathBlock tex={block.tex} />;
		case "details":
			return <Details summary={block.summary ?? translate("common.details")} blocks={block.children} fade={fade} path={path} />;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag>
					{block.items.map((item, index) => (
						<Item key={index} item={item} fade={fade} path={`${path}:${index}`} />
					))}
				</Tag>
			);
		}
		case "table":
			return <MarkdownTable block={block} inline={fade ? fadingInline : inline} />;
		default:
			return null;
	}
}

/**
 * 一段大到画不动的正文。
 *
 * 一条 12 MB、最长一行 1.3 MB 的消息装进一个 `<p>`，Chromium 要给一千多万个字符算换行，45 秒还没画完，
 * 整个窗口按住不动。切成小片、每片挂 `content-visibility: auto` 之后是 17 毫秒：屏幕外的片浏览器根本
 * 不去布局。内容一个字不少地留在 DOM 里——能选、能复制、页内查找找得到。
 *
 * 片必须是块级的：`content-visibility` 在 `inline-block` 上无效。块级元素之间复制时会多一个换行，所以
 * `groupTokens` 尽量只在原本就有换行的地方开新片。
 */
function HugeParagraph({ text }: { text: string }) {
	const groups = useMemo(() => groupTokens(parseInline(text)), [text]);
	return (
		<div className="markdown-huge">
			{groups.map((group, index) => (
				<p key={index} className="markdown-huge-slice">
					{renderTokens(group)}
				</p>
			))}
		</div>
	);
}

function Item({ item, fade, path }: { item: ListItem; fade: boolean; path: string }) {
	const body = (
		<>
			{inline(item.text, fade)}
			{item.children.map((child, index) => (
				<Fragment key={index}>{renderBlock(child, fade, `${path}:${index}`)}</Fragment>
			))}
		</>
	);

	if (item.checked === undefined) return <li>{body}</li>;
	return (
		<li className="markdown-task" data-done={item.checked}>
			{/* 画出来的，不是 <input>：它反映作者写了什么，不是一个控件。 */}
			<span aria-hidden className="markdown-task-box">
				{item.checked && (
					<svg viewBox="0 0 12 12" fill="none" aria-hidden>
						<path d="M2.5 6.2 4.8 8.5 9.5 3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				)}
			</span>
			<span>{body}</span>
		</li>
	);
}

/** `<details>`，按应用里其他能折起来的段那样折，而不是浏览器的样子。 */
function Details({ summary, blocks, fade, path }: { summary: string; blocks: Block[]; fade: boolean; path: string }) {
	return (
		<Disclosure variant="framed" title={inline(summary, fade)}>
			{blocks.map((child, index) => (
				<Fragment key={index}>{renderBlock(child, fade, `${path}:${index}`)}</Fragment>
			))}
		</Disclosure>
	);
}

/** KaTeX 到了就重画；到之前公式按源码显示（见 `math.ts`）。 */
const useMathReady = () => useSyncExternalStore(onMathReady, mathReady, mathReady);

function MathBlock({ tex }: { tex: string }) {
	// 宽公式横着滚而不是折行，滑块和代码块的一样（见 `MarkdownCode`）。
	const viewport = useRef<HTMLDivElement>(null);
	useMathReady();
	const html = renderMath(tex, true);
	// 解析不了的 TeX 按写下的样子显示；一个红色错误框帮不了谁读它。
	if (!html) return <pre className="markdown-math-raw">{tex}</pre>;
	return (
		<div className="markdown-math-frame plume-hscroll-own">
			{/* KaTeX 自己的输出，由它转义过的解析树生成。 */}
			<div ref={viewport} className="markdown-math-block" dangerouslySetInnerHTML={{ __html: html }} />
			<OverlayScrollbar viewport={viewport} orientation="horizontal" />
		</div>
	);
}

// 是组件而不是 `renderToken` 的一个分支，这样它能订阅 KaTeX 的到达。
function InlineMath({ tex, fade }: { tex: string; fade: boolean }) {
	useMathReady();
	const html = renderMath(tex, false);
	if (!html) return `$${tex}$`;
	// KaTeX 自己的输出，由它转义过的解析树生成。
	return fade ? (
		<FadeIn as="span" className="markdown-math" dangerouslySetInnerHTML={{ __html: html }} />
	) : (
		<span className="markdown-math" dangerouslySetInnerHTML={{ __html: html }} />
	);
}

function inline(text: string, fade = false): ReactNode[] {
	return renderTokens(parseInline(text), fade);
}

/** 表格拿到的是一个函数；给它一个固定的，免得每次重画都是新的身份。 */
const fadingInline = (text: string) => inline(text, true);

function renderTokens(tokens: Inline[], fade = false): ReactNode[] {
	return tokens.map((token, index) => <Fragment key={index}>{renderToken(token, fade)}</Fragment>);
}

function renderToken(token: Inline, fade: boolean): ReactNode {
	switch (token.kind) {
		case "text": {
			// 系统表情只从普通文字里拿掉：行内代码、链接地址是原样的数据。
			const text = stripEmoji(token.text);
			return fade ? <FadeText text={text} /> : text;
		}
		case "code": {
			// 行内代码写完才出现（见 `completeTail`），整枚一起淡入。
			const code = fade ? <FadeIn as="code">{token.text}</FadeIn> : <code>{token.text}</code>;
			// 模型常把路径写成 `path/to/file.ts:42`；解析不到本机路径、或找遍了也没有这个文件时，`Link` 原样还给这枚代码。
			const path = filePathInCode(token.text);
			return path ? (
				<Link href={path} guessed>
					{code}
				</Link>
			) : (
				code
			);
		}
		case "break":
			return <br />;
		case "strong":
			return <strong>{renderTokens(token.children, fade)}</strong>;
		case "em":
			return <em>{renderTokens(token.children, fade)}</em>;
		case "del":
			return <del>{renderTokens(token.children, fade)}</del>;
		case "tag": {
			const Tag = token.name;
			return <Tag>{renderTokens(token.children, fade)}</Tag>;
		}
		case "math":
			return <InlineMath tex={token.tex} fade={fade} />;
		case "link":
			return <Link href={token.href}>{renderTokens(token.children, fade)}</Link>;
		case "image":
			return (
				<MarkdownImage
					src={token.src}
					alt={token.alt}
					width={token.width}
					height={token.height}
					fallback={<Link href={token.src}>{token.alt || token.src}</Link>}
				/>
			);
		default:
			return null;
	}
}
