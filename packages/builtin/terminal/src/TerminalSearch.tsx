// color-exempt：xterm 的查找高亮只认 #RRGGBB，用不了 CSS 变量；琥珀色在浅深两种主题下各一组，匹配到的字还读得清
/**
 * 在终端的回滚里查找：⌘F，Mac 以外是 Ctrl+Shift+F（见 keys.ts）。
 *
 * 五千行构建日志原来只能滚着找。这里搜 xterm 存着的内容，标出所有匹配并计数；回车、Shift+回车前后跳，
 * Esc 关掉并把键盘还给 shell。浮在终端角上压着输出，不在顶上占一行：占一行的话每次开关都把每一行往下推，
 * shell 跟着重排。
 */

import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { IconButton, Text, useI18n } from "@plume/ui";
import { ChevronDown, ChevronUp, X } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import { MESSAGES } from "./messages.ts";

/**
 * 高亮的颜色。xterm 只认 `#RRGGBB`，用不了 CSS 变量；两种主题都是琥珀色，深色字下面浅、浅色字下面深，
 * 匹配到的字还读得清。
 */
function decorations(): NonNullable<ISearchOptions["decorations"]> {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? { matchBackground: "#5c4813", matchOverviewRuler: "#a8862c", activeMatchBackground: "#a8740a", activeMatchColorOverviewRuler: "#e0a526" }
		: { matchBackground: "#fde9a8", matchOverviewRuler: "#e0b84a", activeMatchBackground: "#f7c04a", activeMatchColorOverviewRuler: "#c98a00" };
}

export function TerminalSearch({
	search,
	request,
	onClose,
}: {
	search: SearchAddon;
	/** 每按一次 ⌘F 加一，条开着时再按一次回到输入框。 */
	request: number;
	onClose(): void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<{ index: number; count: number } | null>(null);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, [request]);

	useEffect(() => {
		const off = search.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount }));
		return () => {
			off.dispose();
			search.clearDecorations();
		};
	}, [search]);

	// 边打边搜，从眼前那个匹配开始，不跳过它。
	useEffect(() => {
		if (!query) {
			search.clearDecorations();
			setResults(null);
			return;
		}
		search.findNext(query, { incremental: true, decorations: decorations() });
	}, [query, search]);

	const step = (back: boolean) => {
		if (!query) return;
		if (back) search.findPrevious(query, { decorations: decorations() });
		else search.findNext(query, { decorations: decorations() });
	};

	const none = query.length > 0 && results !== null && results.count === 0;

	// 输入框继承外层 Text 的字号。
	return (
		<Text as="div" data-terminal-search className="plume-menu-card terminal-search">
			<input
				ref={input}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					} else if (event.key === "Enter") {
						event.preventDefault();
						step(event.shiftKey);
					}
				}}
				placeholder={text.findPlaceholder}
				aria-label={text.findPlaceholder}
				spellCheck={false}
				className="terminal-search-input"
				data-none={none || undefined}
			/>
			<Text size="detail" tone="faint" numeric className="terminal-search-count">
				{none ? text.findNone : results && results.count > 0 ? `${results.index + 1}/${results.count}` : ""}
			</Text>
			<IconButton size="sm" label={text.previous} icon={<ChevronUp size={15} />} disabled={!query || none} onClick={() => step(true)} />
			<IconButton size="sm" label={text.next} icon={<ChevronDown size={15} />} disabled={!query || none} onClick={() => step(false)} />
			<IconButton size="sm" label={text.close} icon={<X size={15} />} onClick={onClose} />
		</Text>
	);
}
