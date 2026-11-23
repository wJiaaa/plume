import { createContext, type CSSProperties, type RefObject, useContext, useLayoutEffect, useMemo } from "react";

interface Layout {
	text: string;
	signature: string;
	sizes: Map<string, { width: number; height: number }>;
}

// 键是消息里的文本块，只借现有会话缓存的寿命：删除消息或淘汰视图后可一起回收，不另存会话或 DOM。
const remembered = new WeakMap<object, Layout>();
export const MarkdownLayout = createContext<Layout | null>(null);

/** 只复用同一文本块、同一排版条件下量过的尺寸。没有真尺寸时正常布局，不能拿估算高度恢复阅读位置。 */
export function useRememberedMarkdown(ref: RefObject<HTMLDivElement | null>, owner: object | undefined, text: string, live: boolean): Layout | null {
	const layout = useMemo(() => {
		if (!owner || live) return null;
		const last = remembered.get(owner);
		if (last?.text === text) return last;
		const next: Layout = { text, signature: "", sizes: new Map() };
		remembered.set(owner, next);
		return next;
	}, [owner, text, live]);
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root || !layout) return;
		const validate = () => {
			const style = getComputedStyle(root);
			const signature = [
				root.clientWidth,
				style.fontFamily,
				style.fontSize,
				style.lineHeight,
				style.letterSpacing,
				...["--plume-code-font", "--plume-code-size", "--plume-code-line-height", "--plume-code-tracking"].map((name) => style.getPropertyValue(name)),
			].join("|");
			if (layout.signature && layout.signature !== signature) {
				layout.sizes.clear();
				for (const node of root.querySelectorAll<HTMLElement>("[data-markdown-measured]")) reset(node);
			}
			layout.signature = signature;
		};
		// 子块先带着记忆挂上，验证只需量外框；条件变了就在首次绘制前撤掉，按真实内容重新排。
		validate();
		const observer = new ResizeObserver(validate);
		observer.observe(root);
		return () => observer.disconnect();
	}, [ref, layout]);
	return layout;
}

/** 只给已有独立排版边界的代码框和表格框用；换行或流式时不跳过，确保每次长高都参与跟随底部。 */
export function useRememberedBlock(ref: RefObject<HTMLDivElement | null>, path: string, enabled: boolean): CSSProperties | undefined {
	const layout = useContext(MarkdownLayout);
	const size = enabled ? layout?.sizes.get(path) : undefined;
	useLayoutEffect(() => {
		const box = ref.current;
		if (!box || !layout || !enabled) return;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			// contentRect 是浏览器已经排好的内容框，不为每个代码块各强制排一次整页。
			const { width, height } = entry.contentRect;
			if (width <= 0 || height <= 0) return;
			layout.sizes.set(path, { width, height });
			box.dataset.markdownMeasured = "";
			box.style.contentVisibility = "auto";
			box.style.containIntrinsicSize = `auto ${width}px auto ${height}px`;
		});
		observer.observe(box);
		return () => {
			observer.disconnect();
			reset(box);
		};
	}, [ref, layout, path, enabled]);
	return size ? { contentVisibility: "auto", containIntrinsicSize: `auto ${size.width}px auto ${size.height}px` } : undefined;
}

function reset(box: HTMLElement): void {
	box.style.contentVisibility = "";
	box.style.containIntrinsicSize = "";
	delete box.dataset.markdownMeasured;
}
