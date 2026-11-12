/**
 * 一页网页：面板区的一个标签就是一页，标签 id 就是页面 id。
 *
 * 面板声明了 keepAlive：换会话、去设置页时这一格藏起来但不卸掉。`<webview>` 只在最近看过的几个会话里挂着，见
 * `LOADED_SESSIONS`；别的睡着，逻辑入口要它（`held`）或人回来时按它记着的地址重新挂上。逻辑入口那边没有这一页
 * （从开始页新开的空标签、agent 进程重启过）就记一页空白的；那一页已经关掉过的，这一格自己退下。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PanelProps, Remote, UiContext } from "@plume/contract/ui";
import { ActionSpinner, Button, IconButton, Input, MenuBody, MenuItem, MenuSeparator, PanelEmpty, Popover, Text, useI18n, usePopover } from "@plume/ui";
import {
	AppWindow,
	ArrowLeft,
	ArrowRight,
	Bookmark,
	Check,
	ChevronLeft,
	ChevronRight,
	CodeXml,
	Ellipsis,
	ExternalLink,
	Globe,
	Minus,
	MousePointer2,
	Plus,
	RotateCw,
	Scan,
	TriangleAlert,
	WifiOff,
	X,
} from "@plume/ui/icons";
import type { BrowserApi, PageSelection, Viewport } from "./api.ts";
import { validViewport, ZOOM } from "./address.ts";
import { AddressBar } from "./AddressBar.tsx";
import { MESSAGES } from "./messages.ts";
import { PageView } from "./PageView.tsx";
import { SelectionCard } from "./SelectionCard.tsx";
import type { BrowserStore } from "./store.ts";

export const PANEL = "browser";

/** 没有 `<title>` 的页面，Chromium 报上来的标题就是地址本身——空白页于是写着「about:blank」。 */
function pageTitle(page: { url: string; title: string } | undefined, fallback: string): string {
	if (!page || page.url === "about:blank" || !page.title || page.title === "about:blank") return fallback;
	return page.title;
}

export function browserPanel(ui: UiContext, api: Remote<BrowserApi>, store: BrowserStore) {
	return function BrowserPanel({ tab, session, shown, setTitle, onClose }: PanelProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const { pages, loaded, settings, recent } = useSyncExternalStore(store.subscribe, store.get);
		const page = pages.find((entry) => entry.id === tab);
		const sessionId = session?.summary.id;
		// 后台标签也拿得到所属会话；只有真正显示时才更新最近访问顺序。
		useEffect(() => {
			if (sessionId && shown) store.visit(sessionId);
		}, [sessionId, shown]);
		const awake = !!page && (shown || page.held || page.sessionId === null || recent.includes(page.sessionId));
		const fail = (error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error");

		// 逻辑入口没有这一页就记一页空白的；关掉过的，这一格退下。
		const missing = loaded && !page;
		useEffect(() => {
			if (!missing) return;
			void api.ensure(tab, sessionId ?? null).then((kept) => {
				if (!kept) ui.closePanel(PANEL, sessionId, tab);
			}, fail);
			// sessionId 只决定新记的那一页归谁，换了不重来。
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [missing, tab]);
		// 新对话发出第一句、成了会话：新对话里开的页跟过去。
		useEffect(() => {
			if (page && page.sessionId === null && sessionId) void api.adopt(tab, sessionId).catch(fail);
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [page?.sessionId, sessionId, tab]);
		// 人切到了这一页：agent 不给 tabId 时操作的就是它。
		useEffect(() => {
			if (shown && page) void api.select(tab).catch(() => {});
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- 只认这一页在不在，不跟着页面的每次变化重选
		}, [shown, !!page, tab]);
		const title = pageTitle(page, text.newTab);
		useEffect(() => setTitle(title), [setTitle, title]);
		useEffect(
			() =>
				onClose(async () => {
					await api.close(tab);
					return true;
				}),
			[onClose, tab],
		);

		const [selection, setSelection] = useState<PageSelection | null>(null);
		const [inspecting, setInspecting] = useState(false);
		const inspection = useRef(0);
		// 换了一页，选取作罢；选到的那一块也不再是这一页上的东西。
		useEffect(() => {
			setSelection(null);
			setInspecting(false);
			return () => {
				// oxlint-disable-next-line react-hooks/exhaustive-deps -- inspection 是作废计数，清理时加一正是要它的最新值
				inspection.current++;
				void api.cancelInspect(tab).catch(() => {});
			};
		}, [tab, page?.url]);
		const inspect = async (mode: "element" | "region") => {
			const generation = ++inspection.current;
			setInspecting(true);
			try {
				const result = await api.inspect(tab, mode);
				if (generation === inspection.current) setSelection(result);
			} catch (error) {
				fail(error);
			} finally {
				if (generation === inspection.current) setInspecting(false);
			}
		};

		const options = usePopover();
		const [menu, setMenu] = useState<"actions" | "bookmarks" | "viewport">("actions");
		const [width, setWidth] = useState("1440");
		const [height, setHeight] = useState("900");
		const blank = !page || page.url === "about:blank";
		const command = (name: "back" | "forward" | "reload" | "devtools") => void api.command(tab, name).catch(fail);
		const open = (url: string) => void api.open(url, sessionId ?? null).catch(fail);
		const outside = (url: string | null) =>
			void (async () => {
				const target = await api.outside(url ? null : tab, url);
				await ("file" in target ? ui.openPath(target.file) : ui.openExternal(target.url));
			})().catch(() => ui.notify(text.nothingOutside, "error"));
		const zoom = (factor: number) => void api.zoom(tab, Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(factor * 100) / 100))).catch(fail);
		const viewport = (next: Viewport | null) => void api.viewport(tab, next).catch(fail);
		const saved = !!page && settings.bookmarks.some((entry) => entry.url === page.url);
		const mark = () => {
			if (!page) return;
			const list = settings.bookmarks;
			void store
				.saveSettings({ bookmarks: saved ? list.filter((entry) => entry.url !== page.url) : [...list, { url: page.url, title: page.title || page.url }] })
				.catch(fail);
		};
		const presets: { label: string; viewport: Viewport | null }[] = [
			{ label: text.fitWindow, viewport: null },
			{ label: text.phonePreset, viewport: { width: 390, height: 844 } },
			{ label: text.tabletPreset, viewport: { width: 768, height: 1024 } },
			{ label: text.desktopPreset, viewport: { width: 1440, height: 900 } },
		];
		const digits = (value: string) => /^\d{0,4}$/.test(value);

		return (
			<div className="plume-browser-panel" data-browser-panel="">
				<div className="plume-browser-toolbar" data-browser-toolbar="">
					<IconButton size="sm" label={text.back} icon={<ArrowLeft size={13} />} disabled={!page?.canGoBack} onClick={() => command("back")} />
					<IconButton size="sm" label={text.forward} icon={<ArrowRight size={13} />} disabled={!page?.canGoForward} onClick={() => command("forward")} />
					<IconButton
						size="sm"
						label={text.reload}
						// 加载中刷新图标换成转圈：输入地址回车后、点链接后，页面出来之前一眼看得出在加载。
						icon={page?.loading ? <ActionSpinner size={13} /> : <RotateCw size={13} />}
						disabled={!page}
						onClick={() => command("reload")}
					/>
					<AddressBar
						url={page?.url ?? "about:blank"}
						settings={settings}
						onOpen={(url) => void api.navigate(tab, url).catch(fail)}
						onOutside={outside}
						onError={(message) => ui.notify(message, "error")}
					/>
					<IconButton
						label={text.menu}
						menu={options.open}
						active={inspecting}
						icon={<Ellipsis size={16} />}
						onClick={(event) => {
							setMenu("actions");
							options.toggle(event);
						}}
					/>
				</div>
				{inspecting && (
					<div role="status" className="plume-browser-status">
						<Text size="caption" tone="muted">
							{text.pickOnPage}
						</Text>
						<IconButton size="sm" label={text.exitInspect} icon={<X size={12} />} onClick={() => void api.cancelInspect(tab)} />
					</div>
				)}
				<div className="plume-browser-stage">
					{page && awake && <PageView api={api} page={page} />}
					{/* 标题就够了：地址栏就在正上方，再说一句它怎么用是在解释一个不需要解释的东西。 */}
					{blank && (
						<div className="plume-browser-cover" data-browser-empty="">
							<PanelEmpty icon={Globe} title={text.openPage} />
						</div>
					)}
					{/*
					 * 正在加载：还什么都没画出来的（新标签里输了地址、刚开的页）在页面区正中转圈，盖住那片白；已经有一页在、正换去下一页的
					 * 不挡着它，只在顶上浮一个小的。没打开的由下面的失败盖层说。
					 */}
					{page?.loading &&
						!page.failure &&
						(page.arriving ? (
							<div role="status" aria-label={text.loading} className="plume-browser-cover plume-browser-loading" data-browser-loading="page">
								<ActionSpinner size={20} />
							</div>
						) : (
							<div role="status" aria-label={text.loading} className="plume-browser-loading-chip" data-browser-loading="chip">
								<ActionSpinner size={14} />
							</div>
						))}
					{/* 盖在页面上而不是插在它上面：插一行字会把页面挤矮，页面进程已经停了的时候改尺寸会出事。 */}
					{page?.failure && (
						<div className="plume-browser-cover" data-browser-failure={page.failure.kind}>
							{page.failure.kind === "blocked" ? (
								// 重新加载只会再被拦一次；系统浏览器认得这类地址，会问要不要打开对应的客户端。
								<PanelEmpty icon={AppWindow} title={text.blockedTitle}>
									<span className="plume-browser-block">{text.blockedReason}</span>
									<span className="plume-browser-block plume-browser-break">{page.failure.detail}</span>
									<span className="plume-browser-block plume-browser-action">
										<Button icon={<ExternalLink size={13} />} onClick={() => page.failure?.kind === "blocked" && outside(page.failure.url)}>
											{text.openInSystem}
										</Button>
									</span>
								</PanelEmpty>
							) : (
								<PanelEmpty
									icon={page.failure.kind === "crash" ? TriangleAlert : WifiOff}
									title={page.failure.kind === "crash" ? text.pageStopped : text.loadFailed}
								>
									<span className="plume-browser-block plume-browser-break">{page.failure.detail}</span>
									<span className="plume-browser-block plume-browser-action">
										<Button icon={<RotateCw size={13} />} onClick={() => command("reload")}>
											{text.reloadPage}
										</Button>
									</span>
								</PanelEmpty>
							)}
						</div>
					)}
				</div>
				{selection && (
					<SelectionCard
						selection={selection}
						onClose={() => setSelection(null)}
						onSend={(draft) => {
							// 截图作为附件跟上：模型看得到选中的那一块长什么样。
							const shot = selection.screenshot;
							void ui.draftInSession(undefined, {
								text: draft,
								images: shot.startsWith("data:image/png;base64,") ? [{ data: shot.slice(shot.indexOf(",") + 1), mimeType: "image/png" }] : [],
							});
							setSelection(null);
						}}
					/>
				)}
				{options.open && (
					<Popover
						anchor={options.anchor}
						onClose={options.close}
						placement="bottom"
						width="default"
						maxHeight={340}
						label={text.menu}
						header={
							menu !== "actions" && (
								<button type="button" onClick={() => setMenu("actions")} className="plume-browser-menu-back">
									<ChevronLeft size={13} aria-hidden="true" />
									<Text size="detail">{menu === "bookmarks" ? text.bookmarks : text.viewport}</Text>
								</button>
							)
						}
						footer={
							menu === "viewport" &&
							page && (
								<form
									className="plume-browser-viewport-form"
									onSubmit={(event) => {
										event.preventDefault();
										const next = { width: Number(width), height: Number(height) };
										if (!validViewport(next)) return;
										viewport(next);
										options.close();
									}}
								>
									<Text size="detail" className="plume-browser-viewport-field">
										<Input
											aria-label={text.viewportWidth}
											type="text"
											inputMode="numeric"
											required
											value={width}
											onChange={(event) => digits(event.target.value) && setWidth(event.target.value)}
										/>
									</Text>
									<Text size="detail" tone="muted">
										×
									</Text>
									<Text size="detail" className="plume-browser-viewport-field">
										<Input
											aria-label={text.viewportHeight}
											type="text"
											inputMode="numeric"
											required
											value={height}
											onChange={(event) => digits(event.target.value) && setHeight(event.target.value)}
										/>
									</Text>
									<Button type="submit" variant="subtle" size="sm" label={text.apply} icon={<Check size={13} strokeWidth={2.2} aria-hidden="true" />} />
								</form>
							)
						}
					>
						<MenuBody>
							{menu === "actions" && (
								<>
									<MenuItem
										icon={<Plus size={14} />}
										onClick={() => {
											open("about:blank");
											options.close();
										}}
									>
										{text.newTab}
									</MenuItem>
									<MenuItem
										icon={<X size={14} />}
										onClick={() => {
											ui.closePanel(PANEL, sessionId, tab);
											options.close();
										}}
									>
										{text.closeTab}
									</MenuItem>
									<MenuItem
										icon={<Bookmark size={14} fill={saved ? "currentColor" : "none"} />}
										disabled={blank}
										onClick={() => {
											mark();
											options.close();
										}}
									>
										{saved ? text.unbookmark : text.bookmark}
									</MenuItem>
									<MenuItem icon={<Bookmark size={14} />} trailing={<ChevronRight size={13} />} onClick={() => setMenu("bookmarks")}>
										{text.bookmarks}
									</MenuItem>
									<MenuSeparator />
									<MenuItem
										icon={<MousePointer2 size={14} />}
										disabled={blank}
										onClick={() => {
											options.close();
											if (inspecting) void api.cancelInspect(tab);
											else void inspect("element");
										}}
									>
										{inspecting ? text.exitInspect : text.inspectElement}
									</MenuItem>
									<MenuItem
										icon={<Scan size={14} />}
										disabled={blank}
										onClick={() => {
											options.close();
											void inspect("region");
										}}
									>
										{text.selectRegion}
									</MenuItem>
									<MenuItem
										icon={<CodeXml size={14} />}
										disabled={blank}
										onClick={() => {
											command("devtools");
											options.close();
										}}
									>
										{text.devtools}
									</MenuItem>
									<MenuSeparator />
									<div className="plume-browser-zoom">
										<Text size="label" tone="muted" className="plume-browser-grow">
											{text.zoomLabel}
										</Text>
										<IconButton
											size="sm"
											label={text.zoomOut}
											icon={<Minus size={13} />}
											disabled={!page || page.zoom <= ZOOM.min}
											onClick={() => page && zoom(page.zoom - 0.25)}
										/>
										<Button
											size="xs"
											variant="subtle"
											ariaLabel={text.zoomReset}
											label={text.zoomReset}
											disabled={!page}
											onClick={() => zoom(1)}
											className="plume-browser-zoom-value"
										>
											<Text size="detail" numeric>
												{Math.round((page?.zoom ?? 1) * 100)}%
											</Text>
										</Button>
										<IconButton
											size="sm"
											label={text.zoomIn}
											icon={<Plus size={13} />}
											disabled={!page || page.zoom >= ZOOM.max}
											onClick={() => page && zoom(page.zoom + 0.25)}
										/>
									</div>
									<MenuItem
										icon={<Scan size={14} />}
										disabled={!page}
										hint={page?.viewport ? `${page.viewport.width} × ${page.viewport.height}` : text.fit}
										trailing={<ChevronRight size={13} />}
										onClick={() => {
											setWidth(String(page?.viewport?.width ?? 1440));
											setHeight(String(page?.viewport?.height ?? 900));
											setMenu("viewport");
										}}
									>
										{text.viewport}
									</MenuItem>
								</>
							)}
							{menu === "viewport" &&
								page &&
								presets.map((preset) => (
									<MenuItem
										key={preset.label}
										selected={page.viewport?.width === preset.viewport?.width && page.viewport?.height === preset.viewport?.height}
										onClick={() => {
											viewport(preset.viewport);
											options.close();
										}}
									>
										{preset.label}
									</MenuItem>
								))}
							{menu === "bookmarks" &&
								(settings.bookmarks.length > 0 ? (
									settings.bookmarks.map((entry) => (
										<MenuItem
											key={entry.url}
											detail={entry.url}
											onClick={() => {
												open(entry.url);
												options.close();
											}}
										>
											{entry.title}
										</MenuItem>
									))
								) : (
									<Text as="p" size="detail" tone="faint" className="plume-browser-menu-empty">
										{text.noBookmarks}
									</Text>
								))}
						</MenuBody>
					</Popover>
				)}
			</div>
		);
	};
}
