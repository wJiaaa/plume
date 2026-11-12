import type { DocumentPreviewProps, Remote, UiPlugin } from "@plume/contract/ui";
import { Button, Scroller, Sideways, Text, useI18n } from "@plume/ui";
import { Database, Table2 } from "@plume/ui/icons";
import type { SlideHandle } from "@aiden0z/pptx-renderer";
import { useEffect, useMemo, useRef, useState } from "react";
import { DATABASES, MAX_BYTES, PRESENTATIONS, WORDS, WORKBOOKS, type DocumentsApi, type Sheets } from "./api.ts";
import css from "./documents.css";
import { MESSAGES } from "./messages.ts";

const extensionOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

function Viewer({ name, identity, readBytes, api }: DocumentPreviewProps & { api: Remote<DocumentsApi> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [data, setData] = useState<Sheets | null>(null);
	const [document, setDocument] = useState<string | null>(null);
	const [error, setError] = useState("");
	const word = WORDS.includes(extensionOf(name));
	useEffect(() => {
		const controller = new AbortController();
		let parse: ReturnType<typeof api.sheets> | undefined;
		setData(null);
		setDocument(null);
		setError("");
		void (async () => {
			try {
				const bytes = await readBytes(controller.signal);
				controller.signal.throwIfAborted();
				if (bytes.byteLength > MAX_BYTES) throw new Error(text.tooLarge);
				if (word) {
					const { renderAsync } = await import("docx-preview");
					controller.signal.throwIfAborted();
					const isolated = window.document.implementation.createHTMLDocument();
					await renderAsync(new Uint8Array(bytes).buffer, isolated.body, isolated.head, {
						className: "plume-docx",
						inWrapper: true,
						renderHeaders: true,
						renderFooters: true,
						renderFootnotes: true,
						renderEndnotes: true,
						breakPages: true,
						ignoreWidth: false,
						ignoreHeight: false,
						experimental: true,
						useBase64URL: true,
					});
					if (!controller.signal.aborted) {
						// 文档自带样式只进入无脚本的独立文档，不能覆盖产品 UI 或访问外部资源。
						setDocument(
							`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'"><style>body{margin:0}.plume-docx-wrapper{padding:16px 0 24px!important;background:transparent!important;min-width:max-content}</style>${isolated.head.innerHTML}</head><body>${isolated.body.innerHTML}</body></html>`,
						);
					}
				} else {
					parse = api.sheets(bytes, DATABASES.includes(extensionOf(name)));
					const next = await parse;
					if (!controller.signal.aborted) setData(next);
				}
			} catch (cause) {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		return () => {
			controller.abort();
			parse?.cancel();
		};
	}, [api, identity, name, readBytes, word, text]);
	if (error)
		return (
			<div className="documents-centred" role="alert">
				<Text tone="muted">
					{text.unreadable}
					{error}
				</Text>
			</div>
		);
	if (document)
		return (
			<iframe
				className="documents-word"
				title={name}
				sandbox=""
				srcDoc={document}
				onLoad={(event) => {
					event.currentTarget.dataset.documentReady = "";
				}}
				data-document-word=""
			/>
		);
	if (data) return <Grid data={data} />;
	return (
		<div className="documents-centred" role="status">
			<Text tone="faint">{text.loading}</Text>
		</div>
	);
}

/**
 * 演示文稿逐页画在面板里，宽度随面板缩放；页面快滚进视口时才画，大文稿不一次性占满内存。
 * 不用渲染库自带的 PptxViewer：它对外链直接 `window.open`，主窗口里会开出 Electron 新窗口。这里外部媒体一律不取，
 * 文字链接和形状链接都只在人点击时经 `open` 交给系统浏览器。
 */
function Slides({ identity, readBytes, open }: DocumentPreviewProps & { open(url: string): void }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const viewport = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const root = list.current;
		const scroller = viewport.current;
		if (!root || !scroller) return;
		const controller = new AbortController();
		const handles: SlideHandle[] = [];
		let observer: IntersectionObserver | undefined;
		let resize: ResizeObserver | undefined;
		setReady(false);
		setError("");
		// 文字链接是带 target=_blank 的 <a>：捕获阶段拦下，免得形状自己的点击处理先把事件吞掉。
		const follow = (event: MouseEvent) => {
			const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
			if (!(link instanceof HTMLAnchorElement)) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.type === "click") open(link.href);
		};
		root.addEventListener("click", follow, true);
		root.addEventListener("auxclick", follow, true);
		void (async () => {
			try {
				const bytes = await readBytes(controller.signal);
				controller.signal.throwIfAborted();
				if (bytes.byteLength > MAX_BYTES) throw new Error(text.tooLarge);
				const { buildPresentation, parseZipLazyMedia, renderSlide, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
				const files = await parseZipLazyMedia(new Uint8Array(bytes).buffer, RECOMMENDED_ZIP_LIMITS);
				controller.signal.throwIfAborted();
				const presentation = buildPresentation(files, { lazySlides: true });
				if (!presentation.slides.length) throw new Error(text.noSlides);
				let scale = 1;
				const frames = presentation.slides.map((_, index) => {
					const frame = window.document.createElement("div");
					frame.className = "documents-slide";
					frame.dataset.documentSlide = String(index + 1);
					frame.setAttribute("aria-label", text.slide.replace("{n}", String(index + 1)));
					root.append(frame);
					return frame;
				});
				const fit = () => {
					// 页框的内宽（不含边框）就是这一页该画的宽度。
					scale = Math.max(frames[0]?.clientWidth ?? 0, 1) / presentation.width;
					for (const frame of frames) {
						frame.style.height = `${presentation.height * scale}px`;
						(frame.firstElementChild as HTMLElement | null)?.style.setProperty("transform", `scale(${scale})`);
					}
				};
				observer = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (!entry.isIntersecting) continue;
							const frame = entry.target as HTMLDivElement;
							observer?.unobserve(frame);
							const index = frames.indexOf(frame);
							try {
								const handle = renderSlide(presentation, presentation.slides[index]!, {
									externalMedia: "block",
									pdfjs: false,
									onNavigate: (target) => {
										if (target.slideIndex !== undefined) frames[target.slideIndex]?.scrollIntoView({ block: "start" });
										else if (target.url) open(target.url);
									},
								});
								handles.push(handle);
								handle.element.style.transformOrigin = "top left";
								handle.element.style.transform = `scale(${scale})`;
								frame.append(handle.element);
							} catch (cause) {
								frame.dataset.documentSlideError = "";
								frame.textContent = text.slideFailed.replace("{n}", String(index + 1)) + (cause instanceof Error ? cause.message : String(cause));
							}
						}
					},
					{ root: scroller, rootMargin: "100% 0px" },
				);
				for (const frame of frames) observer.observe(frame);
				resize = new ResizeObserver(fit);
				resize.observe(root);
				setReady(true);
			} catch (cause) {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		return () => {
			controller.abort();
			observer?.disconnect();
			resize?.disconnect();
			for (const handle of handles) handle.dispose();
			root.removeEventListener("click", follow, true);
			root.removeEventListener("auxclick", follow, true);
			root.replaceChildren();
		};
	}, [identity, readBytes, open, text]);
	return (
		<>
			{error ? (
				<div className="documents-centred" role="alert">
					<Text tone="muted">
						{text.unreadable}
						{error}
					</Text>
				</div>
			) : (
				!ready && (
					<div className="documents-centred" role="status">
						<Text tone="faint">{text.loading}</Text>
					</div>
				)
			)}
			{/* 读完之前也挂着：页框要先排进去；藏起来时宽度是 0，显出来时 ResizeObserver 再按宽度排一次。 */}
			<div className="documents-deck" hidden={!ready || Boolean(error)}>
				<Scroller className="documents-scroll" scrollRef={viewport}>
					<div ref={list} className="documents-slides" data-document-slides="" />
				</Scroller>
			</div>
		</>
	);
}

function Grid({ data }: { data: Sheets }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [active, setActive] = useState(0);
	const track = useRef<HTMLDivElement>(null);
	const sheet = data.sheets[active];
	const alignment = useMemo(
		() =>
			sheet?.columns.map((_, column) => {
				const sample = sheet.rows
					.slice(0, 30)
					.map((row) => row[column] ?? "")
					.filter(Boolean);
				return sample.length > 0 && sample.every((value) => /^-?[\d,]+(\.\d+)?%?$/.test(value)) ? "right" : "left";
			}) ?? [],
		[sheet],
	);
	if (!sheet)
		return (
			<div className="documents-centred">
				<Text tone="muted">{data.kind === "tables" ? text.noTables : text.noSheets}</Text>
			</div>
		);
	return (
		<div className="documents-grid" data-document-sheet="">
			<Scroller className="documents-scroll">
				<Text as="div" size="detail">
					<table className="documents-table">
						<thead>
							<tr>
								<th className="documents-corner" aria-label="#" />
								{sheet.columns.map((column, index) => (
									<th key={index} scope="col" className="documents-head">
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{sheet.rows.map((row, index) => (
								<tr key={index}>
									<th scope="row" className="documents-gutter">
										{index + 1}
									</th>
									{row.map((cell, column) => (
										<td key={column} style={{ textAlign: alignment[column] }} data-plume-tip={cell.length > 32 ? cell : undefined}>
											{cell}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</Text>
			</Scroller>
			<Sideways trackRef={track} className="documents-tabs">
				{data.sheets.map((entry, index) => (
					<Button
						key={entry.name}
						variant="subtle"
						size="xs"
						pressed={index === active}
						onClick={() => setActive(index)}
						icon={data.kind === "tables" ? <Database size={11} /> : <Table2 size={11} />}
					>
						<span className="documents-tab-name">{entry.name}</span>
					</Button>
				))}
				<Text size="caption" tone="faint" numeric className="documents-count">
					{sheet.total > sheet.rows.length
						? text.rowsOf.replace("{shown}", String(sheet.rows.length)).replace("{total}", String(sheet.total))
						: text.rows.replace("{n}", String(sheet.total))}
				</Text>
			</Sideways>
		</div>
	);
}

export default {
	name: "plume.documents",
	apply(ui) {
		const style = window.document.createElement("style");
		style.dataset.pluginStyle = ui.name;
		style.textContent = css;
		window.document.head.append(style);
		ui.effect(() => style.remove());
		const api = ui.remote<DocumentsApi>();
		const open = (url: string) => void ui.openExternal(url).catch(() => {});
		ui.documentViewer([...WORKBOOKS, ...DATABASES, ...WORDS], (props) => <Viewer {...props} api={api} />);
		ui.documentViewer(PRESENTATIONS, (props) => <Slides {...props} open={open} />);
	},
} satisfies UiPlugin;
