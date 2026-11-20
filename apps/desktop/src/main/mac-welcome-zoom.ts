import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { MAIN_TOOLBAR_HEIGHT } from "../shared/window-chrome.ts";

/** 每块截图的字段数，和 mac-welcome-zoom.m 的 PlumeTile 同序：截图区域 4 个、起点位置 4 个、tx sx ty sy、flags。 */
const TILE_FIELDS = 13;

/**
 * 在页面里跑：把整页切成几块，说明窗口宽高各变 dw、dh 时每块怎么挪，原生层照着摆截图（见 mac-welcome-zoom.m 开头）。
 *
 * 只认单屏欢迎页这一种形状：
 * - 活动栏、侧栏这几列：上面的内容贴着上边，下面的（底部按钮、圆角）贴着下边，中间找一行空白拉开；侧栏列表滚动时在滚动区底下截断，
 *   变矮时裁掉、变高时空出来，和真实的滚动区一样。
 * - 对话这一侧：欢迎区横向居中（左右两条空白各分一半），纵向按 Welcome.tsx 顶上留白的 40dvh 跟着窗口高度的 0.4 挪；
 *   卡片上沿不动，右边、下边（卡片描边）贴着窗口右下。
 * - 顶行（卡片上沿以上）单独一条：左边的按钮不动，右边的（面板按钮）贴着窗口右边，中间找一段空白拉开。
 * 能拉的只有纯色的空白：字、图标、按钮、圆角、描边都不能落在拉伸的那一条里，找不到这样的空白就不做（返回 null）。
 * 同时把每个内容元素预计挪到哪记在页面上，终点画好后由 `transitionSettled` 核对。
 */
function transitionLayout(): number[] | null {
	type Box = { x0: number; y0: number; x1: number; y1: number; el: Element; blocks: "both" | "x" | "y" };
	const page = document.querySelector<HTMLElement>('[data-screen="empty"]');
	const first = page?.querySelector<HTMLElement>("[data-welcome-first]");
	const pane = page?.closest<HTMLElement>("[data-panel-layout]");
	const frame = document.querySelector<HTMLElement>("[data-frame]");
	if (!page || !first || !pane || !frame || page.closest("[inert], [data-split-pane], [data-panel-shown]") || document.querySelector('[aria-modal="true"]'))
		return null;
	const W = innerWidth;
	const H = innerHeight;
	const spacer = first.previousElementSibling;
	const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
	if (first.getBoundingClientRect().width + 1 < parseFloat(getComputedStyle(first).maxWidth) || !spacer || spacer.getBoundingClientRect().height < rem + 1)
		return null;
	for (let el: Element | null = first; el && el !== pane; el = el.parentElement) {
		if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) return null;
	}

	const boxes: Box[] = [];
	const scrollers: { box: Box; el: Element }[] = [];
	const media = new Set(["svg", "img", "canvas", "video", "input", "textarea", "iframe", "webview"]);
	const walk = (el: Element, clip: { x0: number; y0: number; x1: number; y1: number }) => {
		const style = getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return;
		const r = el.getBoundingClientRect();
		const own = { x0: Math.max(r.left, clip.x0), y0: Math.max(r.top, clip.y0), x1: Math.min(r.right, clip.x1), y1: Math.min(r.bottom, clip.y1) };
		const shown = own.x1 > own.x0 && own.y1 > own.y0;
		const tag = el.tagName.toLowerCase();
		if (shown && (media.has(tag) || tag === "button" || style.backgroundImage !== "none")) boxes.push({ ...own, el, blocks: "both" });
		if (media.has(tag)) return;
		if (shown) {
			// 算出来的底色透明时是 alpha 为 0 的颜色（以 ", 0)" 结尾）。
			const painted = !style.backgroundColor.endsWith(", 0)");
			const bordered = (["Top", "Right", "Bottom", "Left"] as const).some(
				(side) => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none",
			);
			const shadow = style.boxShadow !== "none" ? 24 : 0;
			if (painted || bordered || shadow) {
				// 有底色、描边的块：中间一片纯色可以拉，四条边连同圆角不能。左右两条边只挡横向拉伸，上下两条只挡纵向。
				const radius = Math.max(
					...(["TopLeft", "TopRight", "BottomLeft", "BottomRight"] as const).map((corner) => parseFloat(style[`border${corner}Radius`]) || 0),
					parseFloat(style.borderLeftWidth) || 0,
					parseFloat(style.borderTopWidth) || 0,
				);
				const reach = radius + 1 + shadow;
				if (r.left >= clip.x0 - 0.5) boxes.push({ x0: r.left - shadow - 1, x1: r.left + reach, y0: own.y0, y1: own.y1, el, blocks: "x" });
				if (r.right <= clip.x1 + 0.5) boxes.push({ x0: r.right - reach, x1: r.right + shadow + 1, y0: own.y0, y1: own.y1, el, blocks: "x" });
				if (r.top >= clip.y0 - 0.5) boxes.push({ x0: own.x0, x1: own.x1, y0: r.top - shadow - 1, y1: r.top + reach, el, blocks: "y" });
				if (r.bottom <= clip.y1 + 0.5) boxes.push({ x0: own.x0, x1: own.x1, y0: r.bottom - reach, y1: r.bottom + shadow + 1, el, blocks: "y" });
			}
		}
		for (const node of el.childNodes) {
			if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			for (const rect of range.getClientRects()) {
				const box = {
					x0: Math.max(rect.left, clip.x0),
					y0: Math.max(rect.top, clip.y0),
					x1: Math.min(rect.right, clip.x1),
					y1: Math.min(rect.bottom, clip.y1),
				};
				if (box.x1 > box.x0 && box.y1 > box.y0) boxes.push({ ...box, el, blocks: "both" });
			}
		}
		const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
		if (clips && /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1 && shown)
			scrollers.push({ box: { ...own, el, blocks: "both" }, el });
		const inner = clips ? own : clip;
		if (inner.x1 <= inner.x0 || inner.y1 <= inner.y0) return;
		for (const child of el.children) walk(child, inner);
	};
	walk(document.body, { x0: 0, y0: 0, x1: W, y1: H });

	const welcome = boxes.filter((box) => box.el !== page && page.contains(box.el));
	if (welcome.length === 0) return null;
	const group = {
		x0: Math.min(...welcome.map((box) => box.x0)),
		y0: Math.min(...welcome.map((box) => box.y0)),
		x1: Math.max(...welcome.map((box) => box.x1)),
		y1: Math.max(...welcome.map((box) => box.y1)),
	};
	/** [from, to] 里没被挡住的最宽的一段，往里收到整像素；没有就是 null。 */
	const widest = (blockers: [number, number][], from: number, to: number): [number, number] | null => {
		let best: [number, number] | null = null;
		let cursor = from;
		for (const [start, end] of blockers.filter(([start, end]) => end > from && start < to).sort((p, q) => p[0] - q[0])) {
			if (start > cursor && (!best || start - cursor > best[1] - best[0])) best = [cursor, start];
			cursor = Math.max(cursor, end);
		}
		if (to > cursor && (!best || to - cursor > best[1] - best[0])) best = [cursor, to];
		if (!best) return null;
		const start = Math.ceil(best[0] + 0.5);
		const end = Math.floor(best[1] - 0.5);
		return end - start >= 1 ? [start, end] : null;
	};
	const along = (axis: "x" | "y", within: (box: Box) => boolean) =>
		boxes
			.filter((box) => box.blocks !== (axis === "x" ? "y" : "x") && within(box))
			.map((box): [number, number] => (axis === "x" ? [box.x0, box.x1] : [box.y0, box.y1]));

	const P = pane.getBoundingClientRect();
	// 顶行（卡片上沿以上）单独切：面板按钮贴着窗口右边，不能挡住欢迎区两侧的空白。
	const top = Math.round(frame.getBoundingClientRect().top);
	const body = along("x", (box) => box.y1 > top);
	const left = widest(body, P.left, group.x0);
	const right = widest(body, group.x1, P.right);
	if (!left || !right) return null;
	const [a, b] = left;
	const [c, d] = right;
	const chatY = along("y", (box) => box.x1 > a);
	const above = widest(chatY, top, group.y0);
	const bar = widest(
		along("x", (box) => box.y0 < top && box.x1 > a),
		a,
		W,
	);
	const below = widest(chatY, group.y1, H);
	if (!above || !below || !bar) return null;

	const tiles: number[] = [];
	type Rect = [number, number, number, number];
	const tile = (image: Rect, at: Rect, tx: number, sx: number, ty: number, sy: number, flags: number) => {
		if (at[2] > 0 && (at[3] > 0 || flags & 2)) tiles.push(...image, ...at, tx, sx, ty, sy, flags);
	};
	// 左边几列：活动栏一列，侧栏连同对话卡片左边那一小截一列。
	const edge = Math.round(frame.getBoundingClientRect().left);
	const bands: { x0: number; x1: number; cut: number }[] = [];
	const spans: [number, number][] =
		edge > 0 && edge < a
			? [
					[0, edge],
					[edge, a],
				]
			: [[0, a]];
	for (const [x0, x1] of spans) {
		const blockers = along("y", (box) => box.x1 > x0 && box.x0 < x1);
		const scrolled = scrollers.filter(({ box }) => box.x1 > x0 && box.x0 < x1 && box.y1 > box.y0);
		let cut: number;
		let filler: [number, number] | null;
		if (scrolled.length > 0) {
			cut = Math.round(Math.max(...scrolled.map(({ box }) => box.y1)));
			filler = widest(blockers, cut, H) ?? widest(blockers, 0, H);
		} else {
			filler = widest(blockers, 0, H);
			cut = filler ? Math.floor((filler[0] + filler[1]) / 2) : 0;
		}
		if (!filler) return null;
		const row = Math.floor((filler[0] + filler[1]) / 2);
		const width = x1 - x0;
		tile([x0, 0, width, cut], [x0, 0, width, cut], 0, 0, 0, 1, 1);
		tile([x0, row, width, 1], [x0, cut, width, 0], 0, 0, 0, 1, 2);
		tile([x0, cut, width, H - cut], [x0, cut, width, H - cut], 0, 0, 1, 0, 0);
		bands.push({ x0, x1, cut });
	}
	const columns: Rect[] = [
		[a, b, 0, 0.5],
		[b, c, 0.5, 0],
		[c, d, 0.5, 0.5],
		[d, W, 1, 0],
	];
	for (const [x0, x1, tx, sx] of [
		[a, bar[0], 0, 0],
		[bar[0], bar[1], 0, 1],
		[bar[1], W, 1, 0],
	] as Rect[])
		tile([x0, 0, x1 - x0, top], [x0, 0, x1 - x0, top], tx, sx, 0, 0, 0);
	const rows: Rect[] = [
		[top, above[0], 0, 0],
		[above[0], above[1], 0, 0.4],
		[above[1], below[0], 0.4, 0],
		[below[0], below[1], 0.4, 0.6],
		[below[1], H, 1, 0],
	];
	for (const [x0, x1, tx, sx] of columns) for (const [y0, y1, ty, sy] of rows) tile([x0, y0, x1 - x0, y1 - y0], [x0, y0, x1 - x0, y1 - y0], tx, sx, ty, sy, 0);

	// 每个内容元素预计挪多少；落在滚动区里的（会被裁）不核对。
	const items: [Element, number, number, number, number, number, number][] = [];
	const seen = new Set<Element>();
	for (const box of boxes) {
		if (box.blocks !== "both" || seen.has(box.el) || scrollers.some(({ el }) => el.contains(box.el))) continue;
		seen.add(box.el);
		const cx = (box.x0 + box.x1) / 2;
		const cy = (box.y0 + box.y1) / 2;
		const band = bands.find((entry) => cx >= entry.x0 && cx < entry.x1);
		const tx = cx < a ? 0 : cy < top ? (cx < bar[0] ? 0 : cx < bar[1] ? NaN : 1) : cx < b ? 0 : cx < c ? 0.5 : cx < d ? NaN : 1;
		const ty = band ? (cy >= band.cut ? 1 : 0) : cy < above[0] ? 0 : cy < above[1] ? NaN : cy < below[0] ? 0.4 : cy < below[1] ? NaN : 1;
		if (Number.isNaN(tx) || Number.isNaN(ty)) continue;
		const rect = box.el.getBoundingClientRect();
		items.push([box.el, rect.x, rect.y, rect.width, rect.height, tx, ty]);
	}
	(window as unknown as { plumeTransition: unknown }).plumeTransition = { W, H, items };
	return tiles;
}

/** 在页面里跑：终点尺寸画好两帧后，核对 `transitionLayout` 记下的每个元素是不是挪到了预料的位置。 */
function transitionSettled(): Promise<boolean> {
	type Item = [Element, number, number, number, number, number, number];
	return new Promise((done) =>
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const state = (window as unknown as { plumeTransition?: { W: number; H: number; items: Item[] } }).plumeTransition;
				if (!state) return done(false);
				const dw = innerWidth - state.W;
				const dh = innerHeight - state.H;
				done(
					state.items.every(([el, x, y, width, height, tx, ty]) => {
						const rect = el.getBoundingClientRect();
						return (
							el.isConnected &&
							Math.abs(rect.x - x - tx * dw) <= 1 &&
							Math.abs(rect.y - y - ty * dh) <= 1 &&
							Math.abs(rect.width - width) <= 1 &&
							Math.abs(rect.height - height) <= 1
						);
					}),
				);
			}),
		),
	);
}

export function watchWelcomeZoom(window: BrowserWindow): void {
	const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
	const lib = koffi.load(join(import.meta.dirname.replace(/\.asar\//, ".asar.unpacked/"), "mac-welcome-zoom.dylib"));
	const deliver = lib.func("void plume_prepare_zoom(uint32_t, void *, double *, uint32_t)");
	const settled = lib.func("void plume_page_settled(uint32_t, bool)");
	const unwatch = lib.func("void plume_unwatch_zoom(void)");
	const snapshotSignature = koffi.pointer(koffi.proto("void", ["uint32_t"]));
	const settleSignature = koffi.pointer(koffi.proto("void", ["uint32_t", "double", "double", "int"]));
	let fullScreen = window.isFullScreen();
	window.on("enter-full-screen", () => (fullScreen = true));
	window.on("leave-full-screen", () => (fullScreen = false));
	// 原生那边在按下顶行、绿色按钮时来要截图；什么时候用、过没过期都由它判断。
	const snapshot = koffi.register(async (request: number) => {
		let delivered = false;
		try {
			const zoom = window.webContents.getZoomFactor();
			const tiles: unknown = await window.webContents.executeJavaScript(`(${transitionLayout.toString()})()`);
			if (!Array.isArray(tiles) || tiles.length === 0 || tiles.length % TILE_FIELDS !== 0 || !tiles.every(Number.isFinite)) return;
			const image = await window.webContents.capturePage();
			if (image.isEmpty()) return;
			const points = (tiles as number[]).map((value, index) => (index % TILE_FIELDS < 8 ? value * zoom : value));
			deliver(request, image.getNativeHandle().readBigUInt64LE(), points, points.length / TILE_FIELDS);
			delivered = true;
		} catch {
			// 页面可能正在关掉或重新加载；没有截图就照常缩放。
		} finally {
			if (!delivered) deliver(request, null, null, 0);
		}
	}, snapshotSignature);
	// 主窗口藏着跳到终点尺寸后来问：等页面按这个尺寸（进出全屏时还有全屏状态）画好，核对位置，告诉原生层能不能直接换回来。
	const settle = koffi.register(async (request: number, width: number, height: number, mode: number) => {
		let matched = false;
		try {
			const deadline = Date.now() + 1000;
			for (;;) {
				const [contentWidth = 0, contentHeight = 0] = window.getContentSize();
				if (Math.abs(contentWidth - width) < 1 && Math.abs(contentHeight - height) < 1 && (mode < 0 || fullScreen === (mode === 1))) break;
				if (Date.now() > deadline) return;
				await new Promise((done) => setTimeout(done, 16));
			}
			matched = (await window.webContents.executeJavaScript(`(${transitionSettled.toString()})()`)) === true;
			await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
		} catch {
			// 页面没画出来也要交回去，原生那边淡出过渡窗口。
		} finally {
			settled(request, matched);
		}
	}, settleSignature);
	lib.func("plume_watch_zoom", "void", ["void *", "double", snapshotSignature, settleSignature])(
		window.getNativeWindowHandle().readBigUInt64LE(),
		MAIN_TOOLBAR_HEIGHT,
		snapshot,
		settle,
	);
	window.once("closed", () => {
		unwatch();
		koffi.unregister(snapshot);
		koffi.unregister(settle);
	});
}
