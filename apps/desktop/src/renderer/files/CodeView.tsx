/**
 * 文件面板里只读的代码视图：行号、配色、选中复制、查找（⌘F）、换行，从回复里的链接跳过来时滚到那几行并亮一下。
 *
 * 不能改、不存盘：面板是拿来看 agent 碰过的文件的，改文件是 agent 的事。
 */

import { defaultKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { OverlayScrollbar } from "@plume/ui";
import { useEffect, useRef, useState } from "react";

import { loadLanguageFor, sharedHighlightStyle } from "../markdown/highlight.ts";
import type { OpenFile } from "./open-file.ts";
import { revealHighlight, revealLines } from "./reveal-lines.ts";
import { labelSearchPanel, searchPhrases } from "./search-chrome.ts";

export function CodeView({ path, text, wrap, reveal }: { path: string; text: string; wrap: boolean; reveal?: OpenFile["reveal"] }) {
	const host = useRef<HTMLDivElement>(null);
	/*
	 * 滚动的是 CodeMirror 自己的 `.cm-scroller`，视图建好才有。放进 state 让滑块在它出现后再挂上；
	 * 同时给滑块一个 ref，它们按 ref 读。
	 */
	const [scroller, setScroller] = useState<HTMLElement | null>(null);
	const scrollerRef = useRef<HTMLElement | null>(null);
	scrollerRef.current = scroller;
	const view = useRef<EditorView | null>(null);
	const language = useRef(new Compartment());
	const wrapping = useRef(new Compartment());
	/** 视图里现在的文字，同一个文件重读回来一样时不动它。 */
	const seeded = useRef(text);
	/** 已经跳过的那一次（`reveal.at`），重渲染不再跳。 */
	const revealed = useRef(0);

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		seeded.current = text;
		const state = EditorState.create({
			doc: text,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightActiveLine(),
				drawSelection(),
				rectangularSelection(),
				foldGutter(),
				bracketMatching(),
				highlightSelectionMatches(),
				revealHighlight,
				search({ top: true }),
				EditorState.phrases.of(searchPhrases()),
				syntaxHighlighting(sharedHighlightStyle()),
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				// 不可编辑的内容默认拿不到焦点，拿不到焦点就收不到复制的快捷键。
				EditorView.contentAttributes.of({ tabindex: "0" }),
				wrapping.current.of(wrap ? EditorView.lineWrapping : []),
				language.current.of([]),
				keymap.of([
					// 再按一次收起，和打开它的是同一个键。
					{ key: "Mod-f", preventDefault: true, run: (view) => (searchPanelOpen(view.state) ? closeSearchPanel(view) : openSearchPanel(view)) },
					...defaultKeymap,
					...searchKeymap,
					...foldKeymap,
				]),
				editorTheme(),
			],
		});
		const instance = new EditorView({ state, parent: element });
		view.current = instance;
		revealed.current = 0;
		// 查找框第一次打开时才建，所以盯着它出现，而不是只跑一次。
		const panels = new MutationObserver(() => labelSearchPanel(element));
		panels.observe(element, { childList: true, subtree: true });
		setScroller(instance.scrollDOM);

		let live = true;
		void loadLanguageFor(path)
			?.then((extension) => {
				// 语法还在加载时文件可能已经换了或关了。
				if (live) instance.dispatch({ effects: language.current.reconfigure(extension) });
			})
			.catch(() => {});

		return () => {
			live = false;
			panels.disconnect();
			instance.destroy();
			view.current = null;
			setScroller(null);
		};
		// 只按路径重建：同一个文件重读回来由下面换掉文字，滚动位置不丢；换行是重新配置，不重建。
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [path]);

	useEffect(() => {
		view.current?.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
	}, [wrap]);

	useEffect(() => {
		const instance = view.current;
		if (!instance || text === seeded.current) return;
		seeded.current = text;
		instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: text } });
	}, [text]);

	useEffect(() => {
		const instance = view.current;
		if (!instance || !reveal || reveal.at === revealed.current) return;
		revealed.current = reveal.at;
		revealLines(instance, reveal);
	}, [path, reveal]);

	return (
		// `relative`：滑块对着这一块定位，而不是整个窗口。
		<div className="plume-scroll-host relative flex min-h-0 flex-1">
			<div ref={host} className="file-code min-h-0 min-w-0 flex-1 overflow-hidden" />
			{scroller && (
				<>
					<OverlayScrollbar viewport={scrollerRef} orientation="vertical" />
					<OverlayScrollbar viewport={scrollerRef} orientation="horizontal" />
				</>
			)}
		</div>
	);
}

/**
 * 编辑器画的每一块（行号槽、选区、查找框、折叠占位）都换成产品自己的 token，不是界面里一块配色不同的方框。
 *
 * 写在 CodeMirror 的主题里而不是 `files.css`：它的基础样式不在任何层里，分层的规则怎么写都压不过。
 * 主题吐出的是真的 CSS，`var()` 照样生效，换主题跟着变，不用重建。
 */
function editorTheme(): Extension {
	return EditorView.theme({
		"&": { backgroundColor: "var(--plume-code-bg)", color: "var(--plume-code-fg)", height: "100%" },
		".cm-content": {
			fontFamily: "var(--plume-font-mono)",
			fontSize: "var(--plume-code-size)",
			letterSpacing: "var(--plume-code-tracking)",
			/*
			 * 不写 `minWidth: 100%`：`.cm-scroller` 是一排 flex，行号槽和这一块并排，100% 是整条的宽，内容盒就永远比
			 * 放它的地方宽出一个行号槽，底下挂一条只能推几十像素的横向滑块。CodeMirror 自己给这一块设了 `flex-grow`，
			 * 当前行的底色照样铺到右边。
			 */
			padding: "6px 0 40px",
			caretColor: "var(--plume-ink)",
		},
		".cm-scroller": { overflow: "auto", lineHeight: "var(--plume-code-line-height)" },
		"&.cm-focused": { outline: "none" },
		/*
		 * 行号槽不透明：不换行时长行从它底下滚过去，透明的话两层字叠在一起。底色比代码面偏一档，接缝不成一道条纹。
		 */
		".cm-gutters": {
			backgroundColor: "color-mix(in srgb, var(--plume-code-fg) 3%, var(--plume-code-bg))",
			color: "color-mix(in srgb, var(--plume-code-fg) 55%, var(--plume-code-bg))",
			border: "none",
			fontFamily: "var(--plume-font-mono)",
			fontSize: "calc(var(--plume-code-size) - 1px)",
		},
		// 和 `.cm-activeLine` 叠出来一样深，两边读成同一条带。
		".cm-activeLineGutter": {
			backgroundColor: "color-mix(in srgb, var(--plume-code-fg) 8%, var(--plume-code-bg))",
			color: "var(--plume-code-fg)",
		},
		".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--plume-code-fg) 5%, transparent)" },
		".cm-selectionBackground, ::selection": {
			backgroundColor: "color-mix(in srgb, var(--plume-accent) 22%, transparent) !important",
		},
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--plume-ink)" },
		".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--plume-accent) 18%, transparent)", outline: "none" },
		".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--plume-accent) 12%, transparent)" },
		/*
		 * 查找框浮在代码右上角，不把代码往下推：它是叫出来用的工具，不是一条常驻的工具栏，也不占文件的高度。
		 * 卡片的底色、圆角、阴影由 `plume-menu-card` 给（见 `search-chrome.ts`），和菜单、浮层是同一种面。
		 *
		 * 右边让出滑块的轨道；左边也钉住，窄面板里宽卡片才不会从另一边挂出去。
		 */
		".cm-panels": {
			position: "absolute",
			top: "8px",
			right: "20px",
			left: "8px",
			display: "flex",
			justifyContent: "flex-end",
			zIndex: 5,
			backgroundColor: "transparent",
			color: "var(--plume-ink)",
			border: "none",
		},
		".cm-panels.cm-panels-top": { borderBottom: "none" },
		/* 宽度定死不按内容：会换行的 flex 行按内容量出来的是排成一行的宽，最后一个按钮和关闭角之间空出一截。 */
		".cm-panel.cm-search": {
			transformOrigin: "top right",
			width: "440px",
			maxWidth: "100%",
			padding: "6px 26px 6px 7px",
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			gap: "3px",
		},
		/*
		 * 输入框有上限、不铺满：宽面板里一个一千多像素的框只为打一个词，按钮被甩到另一头。用上限而不是基准宽：
		 * 窄面板里 flex 先换行再收缩，基准宽会让输入框各占一行，框变高而不是变窄。
		 */
		".cm-panel.cm-search input[name=search]": { order: 1, flex: "1 1 36px", minWidth: "36px", maxWidth: "236px" },
		".cm-panel.cm-search [name=next], .cm-panel.cm-search [name=prev], .cm-panel.cm-search [name=select]": { order: 3 },
		".cm-textfield": {
			backgroundColor: "var(--plume-input)",
			color: "var(--plume-ink)",
			border: "1px solid var(--plume-line)",
			borderRadius: "var(--plume-radius-item)",
			padding: "0 8px",
			height: "24px",
			fontSize: "inherit",
			fontFamily: "inherit",
			outline: "none",
		},
		".cm-textfield:focus": { borderColor: "var(--plume-ink-faint)" },
		/*
		 * 按钮和选项都是图标格子：平时没有边框，指针下铺一层底色，和界面别处的图标按钮一样。
		 * 选项是包着复选框的 label，复选框铺满格子、看不见，状态由格子自己的颜色表示。
		 */
		".cm-panel.cm-search button[name], .cm-panel.cm-search label": {
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "20px",
			height: "20px",
			padding: 0,
			border: "none",
			borderRadius: "var(--plume-radius-item)",
			background: "transparent",
			color: "var(--plume-ink-faint)",
			transition: "background-color var(--plume-t-quick) var(--plume-e-out), color var(--plume-t-quick) var(--plume-e-out)",
		},
		".cm-panel.cm-search label": { order: 2 },
		".cm-panel.cm-search button[name]:hover, .cm-panel.cm-search label:hover": { background: "var(--plume-card-hover)", color: "var(--plume-ink)" },
		".cm-panel.cm-search button[name]:active, .cm-panel.cm-search label:active": { background: "var(--plume-elevated)" },
		".cm-panel.cm-search label input[type=checkbox]": { position: "absolute", width: "100%", height: "100%", margin: 0, opacity: 0 },
		".cm-panel.cm-search label:has(:checked)": { background: "var(--plume-card-hover)", color: "var(--plume-accent)" },
		// 关闭在卡片的角上，不在排布里。
		".cm-panel.cm-search button[name=close]": { position: "absolute", top: "4px", right: "4px" },
		".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--plume-accent) 24%, transparent)" },
		".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--plume-accent) 42%, transparent)" },
		".cm-foldPlaceholder": {
			backgroundColor: "var(--plume-card)",
			border: "none",
			color: "var(--plume-ink-muted)",
			padding: "0 6px",
			borderRadius: "var(--plume-radius-item)",
		},
		/*
		 * 从回复里的链接跳过来的那几行：先停在高亮上让眼睛落过去，再淡回底色，见 `reveal-lines.ts`。
		 *
		 * 停留写死而不取 `--plume-t-*`：那是动效的长短，减少动效时被压到几乎为零，停留跟着没了就等于没亮。淡出取 token，
		 * 减少动效时停够了直接消失。两个类压过 `.cm-activeLine`：被跳到的那一行同时也是光标所在行。
		 */
		".cm-line.cm-file-reveal": {
			backgroundColor: "color-mix(in srgb, var(--plume-accent) 18%, transparent)",
			animation: "file-reveal calc(var(--plume-t-slow) * 2) var(--plume-e-out) 1400ms forwards",
		},
	});
}
