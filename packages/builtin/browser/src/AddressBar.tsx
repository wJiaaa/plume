/**
 * 地址栏，也是搜索框。打的是网址还是要搜的字由 address.ts 判断；这里是看得见的那一半：回车之前就说清会做哪一样，
 * 再列出和打的字对得上的书签。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton, Input, Text, useI18n } from "@plume/ui";
import { ArrowUpRight, Bookmark, CornerDownLeft, Globe, Search } from "@plume/ui/icons";
import type { Bookmark as BookmarkEntry, BrowserSettings } from "./api.ts";
import { omnibox, searchUrl } from "./address.ts";
import { MESSAGES } from "./messages.ts";

interface Choice {
	kind: "open" | "search" | "bookmark";
	url: string;
	label: string;
	detail?: string;
}

/** 标题或地址里有打的字的书签，去掉已经排在最上面的那一个。 */
function matchingBookmarks(query: string, bookmarks: BookmarkEntry[], taken: string): Choice[] {
	const needle = query.toLowerCase();
	return bookmarks
		.filter((entry) => entry.url !== taken && (entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)))
		.slice(0, 4)
		.map((entry) => ({ kind: "bookmark" as const, url: entry.url, label: entry.title || entry.url, detail: entry.url }));
}

export function AddressBar({
	url,
	settings,
	onOpen,
	onOutside,
	onError,
}: {
	/** 这一页的地址；`about:blank` 显示成空的。 */
	url: string;
	settings: BrowserSettings;
	onOpen: (url: string) => void;
	/** 交给系统的浏览器：打了字时是回车会开的那一页，没打字（null）是这一页。 */
	onOutside: (typed: string | null) => void;
	onError: (message: string) => void;
}) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const settled = url === "about:blank" ? "" : url;
	const [value, setValue] = useState(settled);
	const [focused, setFocused] = useState(false);
	// 这一行字是人打的还是页面的：没动过的地址栏没什么可建议的。
	const [typed, setTyped] = useState(false);
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const listId = useRef(`plume-browser-omnibox-${Math.random().toString(36).slice(2, 8)}`).current;
	// 刚回车的那个地址，等页面报回来之前一直显示它：不然跳转期间闪回上一页的地址，跳转失败时还停在那里。
	const pending = useRef<string | null>(null);

	// 页面的地址为准，除了正在改的时候：页面加载完、agent 换了页都会推来新地址，写进正在打的字里就把人的话截走了。
	useEffect(() => {
		if (focused && typed) return;
		if (pending.current) {
			if (pending.current !== settled) return;
			pending.current = null;
		}
		setValue(settled);
		setTyped(false);
	}, [settled, focused, typed]);

	const target = useMemo(() => {
		if (!value.trim()) return null;
		try {
			return omnibox(value, settings);
		} catch {
			return null;
		}
	}, [value, settings]);

	const engine = settings.searchEngine === "custom" ? text.settings.custom : text.engines[settings.searchEngine];
	const choices = useMemo<Choice[]>(() => {
		if (!typed || !value.trim()) return [];
		const searching = (query: string): Choice => ({ kind: "search", url: searchUrl(query, settings), label: query, detail: text.address.searchWith(engine) });
		// 打的像网址时搜索也留着一行：猜错了还有退路。
		const head: Choice[] = !target
			? []
			: target.kind === "search"
				? [searching(target.query)]
				: [{ kind: "open", url: target.url, label: target.url, detail: text.address.openUrl }, searching(target.query)];
		return [...head, ...matchingBookmarks(value.trim(), settings.bookmarks, head[0]?.url ?? "")];
	}, [typed, value, target, settings, engine, text]);

	const open = focused && choices.length > 0;
	const draft = typed && target ? target.url : null;
	// 夹住而不是归零：再打一个字，方向键选中的那一行不跳。
	const index = Math.min(active, choices.length - 1);

	const go = (next: string) => {
		let resolved: string;
		try {
			resolved = omnibox(next, settings).url;
		} catch {
			onError(text.address.notWeb);
			return;
		}
		pending.current = resolved;
		setValue(resolved === "about:blank" ? "" : resolved);
		setTyped(false);
		input.current?.blur();
		onOpen(resolved);
	};

	return (
		<Text size="detail" className="plume-browser-omnibox" data-browser-omnibox="">
			<span aria-hidden="true" className="plume-browser-omnibox-icon">
				{target?.kind === "search" ? <Search size={12} /> : <Globe size={12} />}
			</span>
			<Input
				ref={input}
				role="combobox"
				aria-label={text.address.label}
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={open ? `${listId}-${index}` : undefined}
				value={value}
				spellCheck={false}
				placeholder={text.address.placeholder(engine)}
				onChange={(event) => {
					setValue(event.target.value);
					setTyped(true);
					setActive(0);
				}}
				// 一进来就全选：下一个键换掉整个地址，而不是接在后面。
				onFocus={(event) => {
					setFocused(true);
					event.currentTarget.select();
				}}
				onBlur={() => {
					setFocused(false);
					setTyped(false);
					if (!pending.current) setValue(settled);
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						if (!open) return;
						event.preventDefault();
						setActive((current) => (Math.min(current, choices.length - 1) + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
						return;
					}
					if (event.key === "Enter" && !event.nativeEvent.isComposing) {
						event.preventDefault();
						const choice = open ? choices[index] : undefined;
						go(choice ? choice.url : value);
						return;
					}
					// Esc 把地址栏交还给页面，不留半截地址。
					if (event.key === "Escape") {
						setValue(settled);
						setTyped(false);
						input.current?.blur();
					}
				}}
				className="plume-browser-omnibox-input"
			/>
			{/* 一直在，没东西可开时变灰：时有时无的按钮读起来像被拿掉了。按下时焦点留在地址栏，不然失焦先把打的字换回了页面地址。 */}
			<span className="plume-browser-omnibox-outside" onMouseDown={(event) => event.preventDefault()}>
				<IconButton
					size="xs"
					label={text.address.openOutside}
					icon={<ArrowUpRight size={12} />}
					disabled={!draft && !settled}
					onClick={() => onOutside(draft)}
					data-omnibox-outside=""
				/>
			</span>
			{open && (
				// 不透明，不用毛玻璃：底下是 `<webview>`，它画在这份文档之外，`backdrop-filter` 什么也糊不到。
				<div id={listId} role="listbox" aria-label={text.address.suggestions} data-omnibox-list="" className="plume-browser-omnibox-list">
					{choices.map((choice, position) => (
						<div
							key={`${choice.kind}-${choice.url}`}
							id={`${listId}-${position}`}
							role="option"
							// 焦点一直在地址栏，经 aria-activedescendant 指到这里；选项本身仍要能聚焦才算合格的选项。
							tabIndex={-1}
							aria-selected={position === index}
							data-omnibox-choice={choice.kind}
							data-active={position === index ? "" : undefined}
							onMouseDown={(event) => event.preventDefault()}
							onMouseEnter={() => setActive(position)}
							onClick={() => {
								setValue(choice.label);
								go(choice.url);
							}}
							className="plume-browser-omnibox-choice"
						>
							<Text tone="faint" className="plume-browser-omnibox-choice-icon">
								{choice.kind === "search" ? <Search size={13} /> : choice.kind === "bookmark" ? <Bookmark size={13} /> : <Globe size={13} />}
							</Text>
							{/* 上下两行而不是左右两列：窄面板里「用必应搜索」会把打的字挤成省略号，打的字是不能被截掉的那一半。 */}
							<span className="plume-browser-omnibox-choice-text">
								<Text as="span" size="detail" className="plume-browser-truncate" data-omnibox-label="">
									{choice.label}
								</Text>
								{choice.detail && (
									<Text as="span" size="caption" tone="faint" className="plume-browser-truncate" data-omnibox-detail="">
										{choice.detail}
									</Text>
								)}
							</span>
							{position === index && (
								<Text tone="faint">
									<CornerDownLeft size={12} />
								</Text>
							)}
						</div>
					))}
				</div>
			)}
		</Text>
	);
}
