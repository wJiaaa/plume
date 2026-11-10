/**
 * 插件的 README，画出来——详情页「介绍」一栏。
 *
 * readme-parse.ts 把源文读成一棵树，这里把树变成 React 元素。没有 `dangerouslySetInnerHTML`，也不从字符串拼标记，
 * README 里的任何东西都不会变成这里没打算造的元素；解析器已经拒掉了所有不跟的 URL。
 *
 * 链接在默认浏览器里打开，README 自己的目录（`#小节`）在本页里滚过去。图片经主进程取：页面的安全策略不许直接取
 * 远程图片，https 的走文档图片的通道（`files.remoteImage`），相对路径是插件目录里的文件（`market.readmeImage`）；
 * 带深色版本的 `<picture>` 在这里按窗口的明暗选。样式见 market.css 的 `.readme`。
 */

import { CopyMark, type MessageKey, motionReduced, translate } from "@plume/ui";
import { Check, ChevronRight, Info, Lightbulb, Link as LinkIcon, type LucideIcon, MessageSquareWarning, OctagonAlert, TriangleAlert } from "@plume/ui/icons";
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type AlertKind, type Block, type Inline, parseMarkdown } from "./readme-parse.ts";

/** 标题的 id 加上和 GitHub 一样的前缀，README 盖不掉应用自己的 id。 */
const PREFIX = "user-content-";

/** 这份 README 是哪个插件的：相对路径的图片从它的目录里读。 */
const PluginOf = createContext("");

export function Readme({ plugin, markdown }: { plugin: string; markdown: string }) {
	const blocks = useMemo(() => parseMarkdown(markdown, { base: { dir: "" } }), [markdown]);
	const root = useRef<HTMLDivElement>(null);

	// 文档里的链接都在这里接住：`#小节` 把本页滚到那个标题，别的在默认浏览器里打开，不让应用自己的窗口跳走。
	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || event.button !== 0) return;
		const anchor = (event.target as Element | null)?.closest?.("a");
		const href = anchor?.getAttribute("href");
		if (!anchor || !href) return;
		event.preventDefault();
		if (href.startsWith("#")) {
			if (!root.current) return;
			findSection(root.current, href.slice(1))?.scrollIntoView({ behavior: motionReduced() ? "auto" : "smooth", block: "start" });
			return;
		}
		void window.plume.openExternal(href);
	};

	return (
		// 这里只读里面链接的点击，能交互的是那些链接本身。
		<div className="readme" ref={root} onClick={onClick} data-readme="">
			<PluginOf.Provider value={plugin}>{renderBlocks(blocks, false)}</PluginOf.Provider>
		</div>
	);
}

function findSection(root: HTMLElement, raw: string): HTMLElement | null {
	let name = raw;
	try {
		name = decodeURIComponent(raw);
	} catch {
		// 转义写坏了，只是一个找不到的名字。
	}
	for (const candidate of [name, name.toLowerCase()]) {
		const found = root.querySelector<HTMLElement>(`[id="${CSS.escape(PREFIX + candidate)}"]`);
		if (found) return found;
	}
	return null;
}

function renderBlocks(blocks: readonly Block[], tight: boolean): ReactNode[] {
	return blocks.map((block, index) => renderBlock(block, index, tight));
}

function alignClass(align: string | undefined): string | undefined {
	return align === "center" ? "readme-center" : align === "right" ? "readme-right" : undefined;
}

function renderBlock(block: Block, key: number, tight: boolean): ReactNode {
	switch (block.type) {
		case "heading": {
			const Tag = `h${block.level}` as "h2";
			return (
				<Tag key={key} id={PREFIX + block.id} className={alignClass(block.align)}>
					<a className="readme-anchor" href={`#${block.id}`} aria-hidden="true" tabIndex={-1}>
						<LinkIcon size={13} strokeWidth={2} />
					</a>
					{renderInline(block.children)}
				</Tag>
			);
		}
		case "paragraph": {
			// 紧凑列表里，一项的文字就是这一项，不是项里的一段。
			if (tight) return <span key={key}>{renderInline(block.children)}</span>;
			const badges = isBadgeRow(block.children);
			const className = [alignClass(block.align), badges ? "readme-badges" : undefined].filter(Boolean).join(" ") || undefined;
			return (
				<p key={key} className={className}>
					{renderInline(badges ? block.children.filter((node) => node.type !== "text" && node.type !== "break") : block.children)}
				</p>
			);
		}
		case "code":
			return (
				<div key={key} className="readme-code group/copy">
					<pre>
						<code>{block.value}</code>
					</pre>
					<CopyMark text={block.value} />
				</div>
			);
		case "quote":
			return <blockquote key={key}>{renderBlocks(block.children, false)}</blockquote>;
		case "alert":
			return (
				<Alert key={key} kind={block.kind}>
					{renderBlocks(block.children, false)}
				</Alert>
			);
		case "list": {
			const items = block.items.map((item, index) => (
				<li key={index} className={item.checked === undefined ? undefined : "readme-task"}>
					{item.checked !== undefined && (
						<span
							className="readme-check"
							data-checked={item.checked || undefined}
							role="img"
							aria-label={translate(item.checked ? "readme.done" : "readme.todo")}
						>
							{item.checked && <Check size={11} strokeWidth={2.6} />}
						</span>
					)}
					{renderBlocks(item.children, block.tight)}
				</li>
			));
			return block.ordered ? (
				<ol key={key} start={block.start === 1 ? undefined : block.start}>
					{items}
				</ol>
			) : (
				<ul key={key} className={block.items.some((item) => item.checked !== undefined) ? "readme-tasks" : undefined}>
					{items}
				</ul>
			);
		}
		case "table":
			return (
				<div key={key} className="readme-table">
					<table>
						<thead>
							<tr>
								{block.head.map((cell, index) => (
									<th key={index} style={block.align[index] ? { textAlign: block.align[index] } : undefined}>
										{renderInline(cell)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, index) => (
										<td key={index} style={block.align[index] ? { textAlign: block.align[index] } : undefined}>
											{renderInline(cell)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "grid":
			return (
				<div key={key} className={["readme-table", "readme-grid", alignClass(block.align)].filter(Boolean).join(" ")}>
					<table>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, index) => {
										const Cell = cell.header ? "th" : "td";
										const width = cell.width ? (cell.width.endsWith("%") ? cell.width : `${cell.width}px`) : undefined;
										return (
											<Cell key={index} style={cell.align || width ? { textAlign: cell.align, width } : undefined}>
												{renderBlocks(cell.children, false)}
											</Cell>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "details":
			return (
				<details key={key} className="readme-details" open={block.open || undefined}>
					<summary>
						<ChevronRight size={14} strokeWidth={2} className="readme-details-caret" />
						<span>{block.summary.length ? renderInline(block.summary) : translate("readme.details")}</span>
					</summary>
					<div className="readme-details-body">{renderBlocks(block.children, false)}</div>
				</details>
			);
		case "group":
			return (
				<div key={key} className={alignClass(block.align)}>
					{renderBlocks(block.children, false)}
				</div>
			);
		case "rule":
			return <hr key={key} />;
		default:
			return null;
	}
}

/** 一行全是徽章：按字高画，间距一致。 */
function isBadgeRow(nodes: readonly Inline[]): boolean {
	let badges = 0;
	for (const node of nodes) {
		if (node.type === "break" || (node.type === "text" && !node.value.trim())) continue;
		if (node.type === "image" && node.badge) {
			badges += 1;
			continue;
		}
		if (node.type === "link" && node.children.length > 0 && node.children.every((child) => child.type === "image" && child.badge)) {
			badges += 1;
			continue;
		}
		return false;
	}
	return badges > 0;
}

function renderInline(nodes: readonly Inline[]): ReactNode[] {
	return nodes.map((node, key) => {
		switch (node.type) {
			case "text":
				return node.value;
			case "code":
				return <code key={key}>{node.value}</code>;
			case "strong":
				return <strong key={key}>{renderInline(node.children)}</strong>;
			case "em":
				return <em key={key}>{renderInline(node.children)}</em>;
			case "del":
				return <del key={key}>{renderInline(node.children)}</del>;
			case "kbd":
				return <kbd key={key}>{renderInline(node.children)}</kbd>;
			case "sup":
				return <sup key={key}>{renderInline(node.children)}</sup>;
			case "sub":
				return <sub key={key}>{renderInline(node.children)}</sub>;
			case "mark":
				return <mark key={key}>{renderInline(node.children)}</mark>;
			case "break":
				return <br key={key} />;
			case "image":
				return <ReadmeImage key={key} node={node} />;
			case "link":
				// 由 Readme 的点击处理打开：`#…` 在本页里，别的在浏览器里。
				return (
					<a key={key} href={node.href} data-plume-tip={node.title ?? (node.internal ? undefined : node.href)}>
						{renderInline(node.children)}
					</a>
				);
			default:
				return null;
		}
	});
}

const ALERTS: Record<AlertKind, { label: MessageKey; Icon: LucideIcon }> = {
	note: { label: "readme.note", Icon: Info },
	tip: { label: "readme.tip", Icon: Lightbulb },
	important: { label: "readme.important", Icon: MessageSquareWarning },
	warning: { label: "readme.warning", Icon: TriangleAlert },
	caution: { label: "readme.caution", Icon: OctagonAlert },
};

function Alert({ kind, children }: { kind: AlertKind; children: ReactNode }) {
	const { label, Icon } = ALERTS[kind];
	return (
		<div className={`readme-alert readme-alert-${kind}`}>
			<p className="readme-alert-title">
				<Icon size={14} strokeWidth={2} />
				{translate(label)}
			</p>
			{children}
		</div>
	);
}

/**
 * README 里的一张图：真的到了才淡入，取不到就不画。
 *
 * 路径挪走了、徽章服务挂了，画一个破图标加替代文字最像「README 坏了」；什么都不画更接近作者的本意。
 */
function ReadmeImage({ node }: { node: Extract<Inline, { type: "image" }> }) {
	const plugin = useContext(PluginOf);
	const url = pictureFor(node, useDarkPage());
	const data = usePicture(plugin, url);
	const [loaded, setLoaded] = useState<string | null>(null);
	if (!data) return null;

	const className = ["readme-img", node.badge ? "readme-img-badge" : undefined, node.round ? "readme-img-round" : undefined].filter(Boolean).join(" ");
	const width = node.width && !node.width.endsWith("%") ? Number(node.width) : undefined;
	const height = node.height && !node.height.endsWith("%") ? Number(node.height) : undefined;
	const style = node.width?.endsWith("%") ? { width: node.width } : width ? { width } : height && !node.badge ? { height, width: "auto" } : undefined;
	return (
		<img
			className={className}
			src={data}
			alt={node.alt}
			data-plume-tip={node.title}
			width={width}
			height={height}
			style={style}
			decoding="async"
			data-loaded={loaded === data || undefined}
			// 同一张图页面别处已经解码过，`onLoad` 挂上之前就好了。
			ref={(element) => {
				if (element?.complete && element.naturalWidth > 0 && loaded !== data) setLoaded(data);
			}}
			onLoad={() => setLoaded(data)}
		/>
	);
}

/** 要取的那张：深色页面取 `<picture>` 的深色版本，否则就是图本身。 */
function pictureFor(node: Extract<Inline, { type: "image" }>, dark: boolean): string {
	const wanted = dark ? "dark" : "light";
	const source = node.sources?.find((candidate) => new RegExp(`prefers-color-scheme\\s*:\\s*${wanted}`, "i").test(candidate.media));
	// `srcset` 可以列好几个候选，第一个是按 1× 写的。
	const first = source?.srcSet.split(",")[0]?.trim().split(/\s+/)[0];
	return first || node.src;
}

/**
 * 这个窗口已经取到的图，按插件和地址：同一份 README 打开两次不问两次。
 *
 * 按大小限着、先进先出：一张图可能几兆，在市场里翻久了不该一直攒着。只记取到的——取不到的由主进程记一分钟，
 * 启动慢时没取到的那张，下次打开这页再问一次。
 */
const PICTURES = new Map<string, string>();
const PICTURE_BUDGET = 48 * 1024 * 1024;
let pictureBytes = 0;

function rememberPicture(key: string, data: string): void {
	pictureBytes -= PICTURES.get(key)?.length ?? 0;
	PICTURES.delete(key);
	PICTURES.set(key, data);
	pictureBytes += data.length;
	for (const [old, value] of PICTURES) {
		if (pictureBytes <= PICTURE_BUDGET) break;
		PICTURES.delete(old);
		pictureBytes -= value.length;
	}
}

/** 还在路上是 `undefined`，取不到是 `null`，取到了是 data URL。 */
function usePicture(plugin: string, url: string): string | null | undefined {
	const key = `${plugin}\n${url}`;
	const [value, setValue] = useState<string | null | undefined>(() => PICTURES.get(key));
	useEffect(() => {
		const known = PICTURES.get(key);
		if (known !== undefined) return setValue(known);
		// 解析器只放行 https 和插件目录里的相对路径；别的协议到不了这里。
		const remote = url.startsWith("https://");
		if (!remote && /^[a-z][a-z0-9+.-]*:/i.test(url)) return setValue(null);
		setValue(undefined);
		let alive = true;
		(remote ? window.plume.files.remoteImage(url) : window.plume.market.readmeImage(plugin, url)).then(
			(data) => {
				if (data) rememberPicture(key, data);
				if (alive) setValue(data);
			},
			() => alive && setValue(null),
		);
		return () => {
			alive = false;
		};
	}, [key, plugin, url]);
	return value;
}

/** 窗口此刻是不是深色，页面开着时跟着切。 */
function useDarkPage(): boolean {
	const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
	useEffect(() => {
		const query = matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setDark(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return dark;
}
