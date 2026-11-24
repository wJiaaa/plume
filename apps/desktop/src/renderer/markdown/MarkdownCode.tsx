/**
 * 回复里的围栏代码块：默认自动换行，配色过的代码占左列，右上角只放复制（可执行命令还有在终端运行），不单占标题行。
 *
 * 和 `@plume/ui` 的 `CodeBlock` 不是一回事：那个画工具输出这种原样的文本，这个画模型写的代码，要配色，
 * 还要在输出时跟着正文一起淡入。
 */

import type { Language } from "@codemirror/language";
import { IconButton, translate, useCopied } from "@plume/ui";
import { Check, Copy, Play } from "@plume/ui/icons";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useFileScope } from "../files/scope.ts";
import { runInTerminal } from "../files/open-terminal.ts";
import { loadedFenceLanguage, loadFenceLanguage, sharedHighlightStyle, tokenize, tokenizeGrowing, type Grown, type Token } from "./highlight.ts";
import { useFade } from "./FadeText.tsx";
import { useGrowingWidth } from "./growing-width.ts";
import { useRememberedBlock } from "./remembered-layout.ts";
import { commandFrom, isShellFence } from "./shell-command.ts";

/**
 * 超过这么多字符就不高亮了。
 *
 * 见下面 `tokens` 里的注释——这个数是照着「一帧以内跑得完」量出来的。
 */
const HIGHLIGHT_LIMIT = 60_000;

export function MarkdownCode({ lang, code, fade = false, layoutPath = "" }: { lang: string; code: string; fade?: boolean; layoutPath?: string }) {
	const { copied, mark } = useCopied();
	const box = useRef<HTMLDivElement>(null);
	useGrowingWidth(box, code, fade);
	const layoutStyle = useRememberedBlock(box, layoutPath, !fade);
	const [loaded, setLoaded] = useState<{ lang: string; language: Language | null } | null>(null);
	const language = loadedFenceLanguage(lang) ?? (loaded?.lang === lang ? loaded.language : null);
	/** 命令交给这个会话的终端：块画在哪个会话里，就在哪个会话旁边开终端、在那里执行。 */
	const scope = useFileScope();
	const command = scope && isShellFence(lang.toLowerCase()) ? commandFrom(code) : "";

	/*
	 * 语法按语言现取，配色随内容重算。
	 *
	 * 语法是动态 import 的——只出现过 TypeScript 的会话不该为 Python、SQL 的解析器买单。还在加载时
	 * 按纯文本画，这也正是一段还在输出、围栏没收口的代码的样子。
	 */
	useEffect(() => {
		if (loadedFenceLanguage(lang) !== undefined) return;
		let cancelled = false;
		void loadFenceLanguage(lang).then((result) => {
			if (!cancelled) setLoaded({ lang, language: result });
		});
		return () => {
			cancelled = true;
		};
	}, [lang]);

	/** 正在输出时上一次的解析结果，下一帧只解析长出来的那一截，见 `tokenizeGrowing`。 */
	const grown = useRef<Grown | undefined>(undefined);

	const tokens = useMemo(() => {
		if (!language) return null;
		/*
		 * 太长的块不高亮，直接给纯文本。
		 *
		 * `tokenize` 是同步的，而它前面没有任何上限。一个会话里有一条用户消息 233KB、1087 行，
		 * 整段是一个代码围栏——打开那个会话时主线程被占死 **2.3 秒**，鼠标转圈，而那个会话一共只有
		 * 34 条消息。相比之下 382 条消息、25MB 的会话只卡 195ms：贵的从来不是条数或文件大小，是
		 * 单块文本的长度。
		 *
		 * 60KB 这个数是量出来的，不是拍的：低于它的块都在一帧以内跑完；而真正会越过它的
		 * 内容——整个文件粘进来、几千行日志——本来也不是拿来逐行读的，少了配色不影响它被翻阅和复制。
		 *
		 * `return null` 走的是这个组件本来就有的降级路径（半截围栏在流式输出中途也走它），所以文本
		 * 一个字都不会少，只是没有配色。
		 */
		if (code.length > HIGHLIGHT_LIMIT) return null;
		try {
			if (!fade) {
				grown.current = undefined;
				return tokenize(code, language, sharedHighlightStyle());
			}
			grown.current = tokenizeGrowing(code, language, sharedHighlightStyle(), grown.current);
			return grown.current.tokens;
		} catch {
			// 输出到一半的围栏解析出错，不能因此丢了字。
			return null;
		}
	}, [code, language, fade]);

	// 正在输出的代码块，新来的字和正文一样淡入，见 `FadeText`。不在输出的块不记出现时刻。
	const { settled, group, alpha } = useFade(code, fade ? Array.from(code).length : 0);

	return (
		<div ref={box} className="markdown-code" style={layoutStyle} data-markdown-measured={layoutStyle ? "" : undefined}>
			<div className="markdown-code-head">
				{scope && command && (
					<IconButton
						size="sm"
						label={translate("codeBlock.runInTerminal")}
						icon={<Play size={14} strokeWidth={1.9} />}
						onClick={() => void runInTerminal(scope.sessionId, command)}
					/>
				)}
				<IconButton
					size="sm"
					label={translate("common.copy")}
					icon={copied ? <Check size={14} strokeWidth={2} className="text-ok" /> : <Copy size={14} strokeWidth={1.9} />}
					onClick={() => {
						void navigator.clipboard.writeText(code).then(() => mark(true));
					}}
				/>
			</div>
			<pre>
				{fade ? (
					fading(tokens ?? [{ text: code, className: "" }], { settled, group, alpha })
				) : (
					<code>
						{tokens
							? tokens.map((token, index) =>
									token.className ? (
										<span key={index} className={token.className}>
											{token.text}
										</span>
									) : (
										token.text
									),
								)
							: code}
					</code>
				)}
			</pre>
		</div>
	);
}

/** 正在输出的代码按这么多行一段画；写完的段不再重画。 */
const CHUNK_LINES = 24;

/**
 * 正在输出的代码：淡完的字按 token 配色成段画，还在淡的字按 `FadeText` 的分组，一组一个 span。
 *
 * 按行切成段，每段是一个块级元素，整段都淡完了就交给 `SettledChunk`，内容不变它就不重画。不切的话
 * 整块代码是同一个行内排版：每帧长一个字，几百行、几千个 span 全部重排一遍。量过：300 行的块按
 * 每秒 150 字输出，切段之前三分之一以上的帧超过 16ms。切开之后浏览器只重排最后一段。
 *
 * 段放在 `pre` 底下、每段自己再套一个 `code`，和写完之后整块的 `<pre><code>` 一行一行排得一样：
 * 行高由 `pre` 的字号撑着。段放进 `code` 里面的话，每行矮 3px，写完换回整块那一刻，三百行的块
 * 一下子长高近一千像素。
 *
 * 淡入的 span 按组头的序号作 key，套在 token 外面而不是里面。配色是整块重算的，`cons` 长成 `const`
 * 时 token 的边界和类名都会变；淡入挂在 token 上的话会跟着 token 被重建，从头再来。套在外面，
 * 被重建的只是里面上色的那几层，动画不受影响。
 */
type Fade = ReturnType<typeof useFade>;

function fading(tokens: Token[], fade: Fade): ReactNode[] {
	const { settled } = fade;
	const out: ReactNode[] = [];
	let chunk: Token[] = [];
	let start = 0;
	let at = 0;
	let lines = 0;
	const flush = () => {
		if (chunk.length === 0) return;
		// `at` 这时是这一段的末尾：它之前的字都淡完了，这一段就不会再变。
		out.push(
			at <= settled ? (
				<SettledChunk key={`s${start}`} tokens={chunk} />
			) : (
				<span key={`f${start}`} className="markdown-code-chunk">
					<code>{live(chunk, start, fade)}</code>
				</span>
			),
		);
		chunk = [];
		start = at;
		lines = 0;
	};
	for (const token of tokens) {
		// 一个 token 可以跨行（块注释、模板字符串），在换行处切开，段才能按行分。
		const parts = token.text.split("\n");
		parts.forEach((part, index) => {
			const text = index < parts.length - 1 ? `${part}\n` : part;
			if (!text) return;
			chunk.push({ text, className: token.className });
			at += Array.from(text).length;
			if (index < parts.length - 1 && ++lines === CHUNK_LINES) flush();
		});
	}
	flush();
	return out;
}

/** 一段里还有字在淡：淡完的部分成段，其余一组一个 span，里面再按 token 上色。 */
function live(tokens: Token[], start: number, { settled, group, alpha }: Fade): ReactNode[] {
	const out: ReactNode[] = [];
	let open: { head: number; pieces: ReactNode[] } | null = null;
	const close = () => {
		if (open) {
			out.push(
				<span key={open.head} className="markdown-fade" style={{ opacity: alpha(open.head) }}>
					{open.pieces}
				</span>,
			);
		}
		open = null;
	};
	let at = start;
	tokens.forEach((token, index) => {
		const chars = Array.from(token.text);
		const done = Math.max(0, Math.min(chars.length, settled - at));
		if (done > 0) {
			const text = chars.slice(0, done).join("");
			out.push(
				token.className ? (
					<span key={`t${index}`} className={token.className}>
						{text}
					</span>
				) : (
					text
				),
			);
		}
		for (let offset = done; offset < chars.length;) {
			const head = group(at + offset);
			let end = offset + 1;
			while (end < chars.length && group(at + end) === head) end++;
			if (open?.head !== head) {
				close();
				open = { head, pieces: [] };
			}
			const text = chars.slice(offset, end).join("");
			open.pieces.push(
				token.className ? (
					<span key={index} className={token.className}>
						{text}
					</span>
				) : (
					text
				),
			);
			offset = end;
		}
		at += chars.length;
	});
	close();
	return out;
}

const SettledChunk = memo(
	function SettledChunk({ tokens }: { tokens: Token[] }) {
		return (
			<span className="markdown-code-chunk">
				<code>
					{tokens.map((token, index) =>
						token.className ? (
							<span key={index} className={token.className}>
								{token.text}
							</span>
						) : (
							token.text
						),
					)}
				</code>
			</span>
		);
	},
	(a, b) =>
		a.tokens.length === b.tokens.length &&
		a.tokens.every((token, index) => token.text === b.tokens[index]!.text && token.className === b.tokens[index]!.className),
);
