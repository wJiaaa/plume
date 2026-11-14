/**
 * 回复里的一条链接：网址开进系统浏览器（或插件接手的地方，见 `ui.linkOpener`），右键问开在哪；指着本机文件的画成文件签，
 * 悬停给出打开方式。
 */

import { ContextMenu, IconButton, iconColour, lookFor, MenuItem, MenuSeparator, translate, useContextMenu, useI18n } from "@plume/ui";
import { CornerUpRight, ExternalLink, Link2 } from "@plume/ui/icons";
import { type CSSProperties, isValidElement, type ReactNode, type SyntheticEvent, useEffect, useMemo, useState } from "react";

import { baseName, type LineRange, openFile } from "../files/open-file.ts";
import { type FileScopeValue, useFileScope } from "../files/scope.ts";
import { isAbsolutePath, resolveAsset } from "./assets.ts";
import { FileChoices } from "./FileChoices.tsx";
import { fileLinkCaption, filePathInUrl, splitLineSuffix } from "./file-link.ts";
import { awaitingPaths, useLocatedPaths } from "./located-path.ts";
import { revealKey } from "../files/open-targets.ts";
import { fileExits, usePathMenu } from "./PathMenu.tsx";
import { touchedFile } from "./touched-file.ts";
import { clickOpener, fileOpeners, type LinkChoice, usePluginUis, webOpeners } from "../plugins.tsx";
import { notify } from "../toast/store.ts";

function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

/**
 * 出口条要的空间：28px 的卡片（22px 的按钮、上下各 2px 内衬、1px 细线），4px 间隙，再留 2px。
 * 和 `markdown.css` 里 `[data-file-actions]` 是同一笔账——改了一边，另一边跟着改。
 */
const ACTIONS_CLEARANCE = 34;

/**
 * 会把伸出去的部分裁掉的 `overflow` 取值。列出来而不是写成「不是 visible 就算」：没有计算值时得到的是
 * 空串，那不是裁剪。
 */
const CLIPPING_OVERFLOW = /^(hidden|clip|auto|scroll|overlay)$/;

/**
 * 出口条放在签的上方还是下方。
 *
 * 默认上方：上一行已经读过了，盖住一截代价最小；下一行正要读，链接自己的路径提示也开在那里。但往上伸
 * 会撞上裁剪签的东西：滚动区的顶边、表格的横向滚动框，伸出去的那截画不出来。所以量一下：上方放不下、
 * 下方更宽就放下方。
 *
 * 只在指针或焦点到来时量一次，不留监听：那一刻签在哪，条就出现在哪。
 */
function actionsSide(chip: HTMLElement): "above" | "below" {
	const box = chip.getBoundingClientRect();
	let top = 0;
	let bottom = window.innerHeight;
	for (let el = chip.parentElement; el && el !== document.body; el = el.parentElement) {
		const style = getComputedStyle(el);
		const clips =
			CLIPPING_OVERFLOW.test(style.overflowX) ||
			CLIPPING_OVERFLOW.test(style.overflowY) ||
			/paint|strict|content/.test(style.contain) ||
			style.contentVisibility === "auto";
		if (!clips) continue;
		const edge = el.getBoundingClientRect();
		top = Math.max(top, edge.top);
		bottom = Math.min(bottom, edge.bottom);
	}
	const above = box.top - top;
	return above >= ACTIONS_CLEARANCE || above >= bottom - box.bottom ? "above" : "below";
}

/**
 * 条的左边离签的左边多远：在指针进来的位置正上方，但不越出签的两端。
 *
 * 钉在右上角的话，一个 300px 的文件名让指针从左端进来时要斜着走 250px 才够得着条，路上大半不在签上，
 * 只靠离开时的宽限撑着。放在指针上方，是直上 20px。
 *
 * 只在进来时放一次：追着指针走的条是在晃，不是在等人按。比条还窄的签让条左对齐，而不是挂出左边。
 */
function actionsOffset(chip: HTMLElement, pointerX: number): number {
	const box = chip.getBoundingClientRect();
	const width = chip.querySelector<HTMLElement>("[data-file-actions-bar]")?.offsetWidth ?? 0;
	return Math.round(Math.max(0, Math.min(pointerX - box.left - width / 2, box.width - width)));
}

/**
 * 一枚指着本机文件的签，外加指针过来才出现的两个出口。
 *
 * 点签本身在文件面板里打开，读 `.md`、`.ts` 最快的路。面板读不了的那些——一个 `.exe` 点开只换来一句
 * 「二进制文件」——人真正想做的是运行它、看它在哪，所以旁边留两个出口：用默认应用打开、在访达中显示。
 * 不改点击的意思：时而开面板时而开访达的链接让人不敢点，比多两个图标更糟。
 *
 * 出口只在悬停时出现：它们会在整页每个文件名旁边重复，常驻就和正文抢眼。位置是签*上方*的一张小卡片，
 * 不在签里：盖在文件名末尾时字和图标挤成一团；把签撑宽又会推着后面的字走、甚至重新折行。浮在文字流外，
 * 一个像素都不动。怎么出现、怎么消失见 `markdown.css` 的 `[data-file-actions]`。
 */
function FileLink({
	href,
	path,
	lines,
	choices,
	root,
	children,
}: {
	href: string;
	path: string;
	lines: LineRange | null;
	choices?: readonly string[];
	root: string;
	children: ReactNode;
}) {
	const caption = fileLinkCaption(textOf(children), path, lines);
	const scope = useFileScope();
	// 插件给的打开方式（内置浏览器开 `.html`）：多一个出口，点签本身的意思不变。
	usePluginUis();
	const openers = fileOpeners(path);
	const { resolvedLocale } = useI18n();
	// 只有结尾的分隔符不问磁盘就能说是文件夹——链接上的，或找到的路径上的。
	const look = lookFor(baseName(path), /[/\\]$/.test(href) || /[/\\]$/.test(path));
	const pathMenu = usePathMenu(root);
	/*
	 * 这个名字在工作目录里不止一份——三个模块各有一个 `ResponseSelector.java`。`path` 这时只是按工作目录拼的
	 * 猜测，什么都不指；点一下改成问是哪一个。
	 */
	const [picking, setPicking] = useState<HTMLElement | null>(null);
	const [side, setSide] = useState<"above" | "below">("above");
	/** 条的左边离签的左边几个像素；null 让它靠右，给没有指针可对的焦点。 */
	const [offset, setOffset] = useState<number | null>(null);
	const open = () => void openFile(path, caption.lines);
	const place = (event: SyntheticEvent<HTMLElement>, pointerX?: number) => {
		// 已经在条里了：留在原处，不然它从指针底下挪走。
		if (event.target instanceof Element && event.target.closest("[data-file-actions]")) return;
		setSide(actionsSide(event.currentTarget));
		setOffset(pointerX === undefined ? null : actionsOffset(event.currentTarget, pointerX));
	};
	// 提示朝远离条的方向开：条在上方时按钮的提示也往上，条在下方时链接自己的路径提示挪到上面，两样不叠。
	const buttonTip = side === "above" ? "top" : "bottom";

	return (
		// 几何在 `markdown.css` 的 `[data-file-link]`，这里只搭结构：链接、文件名、两个出口。名字太长由样式省略，不在这里截。
		<span
			data-file-link
			data-file-actions-side={side}
			style={offset === null ? undefined : ({ "--markdown-file-actions-x": `${offset}px` } as CSSProperties)}
			onPointerEnter={(event) => place(event, event.clientX)}
			/*
			 * 只认键盘带来的焦点。点链接也会让它获得焦点，那时指针已经在签上、条也对好了；再按没有指针的样子
			 * 放一次，条会在按下的那一刻跳到右端。
			 */
			onFocus={(event) => {
				if (!event.currentTarget.matches(":hover")) place(event);
			}}
		>
			<a
				href={href}
				data-plume-tip={caption.tip}
				data-plume-tip-side={side === "below" ? "top" : undefined}
				onClick={(event) => {
					event.preventDefault();
					if (choices) setPicking(event.currentTarget);
					else open();
				}}
				onContextMenu={(event) => {
					if (!choices) return pathMenu.onContextMenu(event, { path, onOpen: open });
					event.preventDefault();
					setPicking(event.currentTarget);
				}}
			>
				<look.Icon size={13} strokeWidth={1.9} style={{ color: iconColour(look) }} />
				<span data-file-name>{caption.text}</span>
				{caption.line && <span data-file-line>:{caption.line}</span>}
			</a>
			{/* 两个出口都只对一个文件，而是哪一个正是点击要问的。 */}
			{!choices && (
				<span data-file-actions>
					<span data-file-actions-bar>
						<FileLinkAction
							label={translate("openTarget.defaultApp")}
							tipSide={buttonTip}
							icon={<ExternalLink size={14} />}
							onClick={() => fileExits.openExternal(path)}
						/>
						<FileLinkAction label={translate(revealKey())} tipSide={buttonTip} icon={<CornerUpRight size={14} />} onClick={() => fileExits.reveal(path)} />
						{openers.map((opener) => (
							<FileLinkAction
								key={opener.key}
								label={opener.label(resolvedLocale)}
								tipSide={buttonTip}
								icon={opener.icon ? <opener.icon size={14} /> : <ExternalLink size={14} />}
								onClick={() => opener.open({ path }, scope?.sessionId)}
							/>
						))}
					</span>
				</span>
			)}
			{pathMenu.element}
			{choices && picking && (
				<FileChoices anchor={picking} paths={choices} root={root} onPick={(choice) => void openFile(choice, caption.lines)} onClose={() => setPicking(null)} />
			)}
		</span>
	);
}

/** 一个出口：应用里的小图标按钮，悬停提示和无障碍名一起给。 */
function FileLinkAction({ label, icon, tipSide, onClick }: { label: string; icon: ReactNode; tipSide: "top" | "bottom"; onClick: () => void }) {
	return (
		<IconButton
			size="sm"
			label={label}
			icon={icon}
			tipSide={tipSide}
			onClick={(event) => {
				// 停在这里：外面的链接和消息各自给点击另有意思。
				event.preventDefault();
				event.stopPropagation();
				onClick();
			}}
		/>
	);
}

/**
 * 回复里的一条链接，或是一枚看着像路径的行内代码（`Markdown.tsx` 里的 `filePathInCode`）。
 *
 * 网址在系统浏览器里打开。指着本机的地址只在对话里画成文件签（要知道是哪个会话、相对哪个目录，见
 * `files/scope.ts`），而且找到了才画：模型写的链接常指着别的机器（经 ssh 看过的服务器）或根本没有的
 * 文件，画成签只会让人点开一句「读不到」。没找到时、还在找时都是原来的字，找到了才换成签——不先画成
 * 签再撤回，那样找不到的那几枚每次挂上都闪一下。换的那一下怎么尽量不出现见 `located-path.ts`、
 * `awaitingLink`。别处画的 Markdown 里照旧是普通的字。
 */
export function Link({ href, children }: { href: string; children: ReactNode }) {
	const scope = useFileScope();
	if (/^https?:\/\//i.test(href)) {
		return (
			<WebLink href={href} sessionId={scope?.sessionId}>
				{children}
			</WebLink>
		);
	}
	if (!scope) return <>{children}</>;
	return (
		<LocalLink href={href} scope={scope}>
			{children}
		</LocalLink>
	);
}

/**
 * 一条链接指着本机的什么、要不要去找。不是本机路径（网址、锚点）时是 null。
 *
 * `query` 是拿去找的那条：`approvals.ts:125` 拼在工作目录上多半什么都不指，模型写的是裸名字，或相对某个
 * 子包的路径，所以相对路径照写的样子去目录里找；绝对路径照解析出的样子（解过码、规整过）只问在不在。
 * `touched` 是这场对话 read、edit、write 过的那个文件：路径是现成的，当场就画，不用等磁盘。
 */
function linkTarget(scope: FileScopeValue, href: string): { guess: string; query: string; touched: string | null; lines: LineRange | null } | null {
	const { path: written, lines } = splitLineSuffix(href);
	const target = filePathInUrl(written) ?? written;
	const guess = resolveAsset(scope.cwd, target);
	if (!guess) return null;
	if (isAbsolutePath(target)) return { guess, query: guess, touched: null, lines };
	return { guess, query: target, touched: touchedFile(scope.touched, scope.cwd, [scope.cwd], target), lines };
}

/**
 * 正在输出的回复要不要先停在这条链接前面：它指着本机、这场对话没碰过、还没找出结论。停着等结论，放出来
 * 时就是它最终的样子，不会先是字、随后跳成签。停多久、怎么等见 `awaitingPaths`。
 */
export function awaitingLink(scope: FileScopeValue, href: string): boolean {
	const target = linkTarget(scope, href);
	return !!target && !target.touched && awaitingPaths(scope.sessionId, target.query);
}

function LocalLink({ href, scope, children }: { href: string; scope: FileScopeValue; children: ReactNode }) {
	const target = useMemo(() => linkTarget(scope, href), [scope, href]);
	const located = useLocatedPaths(target && !target.touched ? scope.sessionId : null, target?.query ?? null);
	const found = target?.touched ? [target.touched] : located;
	// 同名的有几个就让人挑，见 `located-path.ts`。
	if (!target || !found?.length) return <>{children}</>;
	return (
		<FileLink
			href={href}
			path={found.length === 1 ? found[0]! : target.guess}
			lines={target.lines}
			root={scope.cwd}
			choices={found.length > 1 ? found : undefined}
		>
			{children}
		</FileLink>
	);
}

/**
 * 回复里的一个网址：点它开进系统浏览器，插件接手点击时（人在内置浏览器的设置里选的）开在插件那里，Shift 点照旧交给系统浏览器；
 * 右键列出能开它的地方，再加复制链接。
 */
function WebLink({ href, sessionId, children }: { href: string; sessionId: string | undefined; children: ReactNode }) {
	const menu = useContextMenu();
	return (
		<>
			<a
				href={href}
				data-plume-tip={href}
				onClick={(event) => {
					event.preventDefault();
					const opener = event.shiftKey ? undefined : clickOpener();
					if (opener) opener.open({ url: href }, sessionId);
					else void window.plume.openExternal(href);
				}}
				onContextMenu={(event) => menu.show(event, undefined)}
			>
				{children}
			</a>
			{/* 放在链接旁边而不是里面：React 的事件穿过 portal 冒泡，菜单里点一行也会点到链接。 */}
			{menu.open && <WebLinkMenu anchor={menu.anchor} href={href} openers={webOpeners()} sessionId={sessionId} onClose={menu.close} />}
		</>
	);
}

/** 默认浏览器开着菜单时不会变：每个窗口第一次右键时问一次。 */
let browserName: Promise<string> | null = null;

function useBrowserName(): string {
	const [name, setName] = useState("");
	useEffect(() => {
		let alive = true;
		browserName ??= window.plume.defaultBrowser().catch(() => "");
		void browserName.then((value) => alive && setName(value));
		return () => {
			alive = false;
		};
	}, []);
	return name;
}

function WebLinkMenu({
	anchor,
	href,
	openers,
	sessionId,
	onClose,
}: {
	anchor: { x: number; y: number } | null;
	href: string;
	openers: LinkChoice[];
	sessionId: string | undefined;
	onClose: () => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const browser = useBrowserName();
	const icon = { size: 13, strokeWidth: 1.8 } as const;
	return (
		// `wide`：第一行带着浏览器的名字，默认宽度下「在 Google Chrome 中打开」会被截掉。
		<ContextMenu anchor={anchor} onClose={onClose} width="wide">
			<MenuItem icon={<ExternalLink {...icon} />} onClick={() => void window.plume.openExternal(href)}>
				{browser ? t("link.openIn", { name: browser }) : t("link.openInSystem")}
			</MenuItem>
			{openers.map((opener) => (
				<MenuItem
					key={opener.key}
					icon={opener.icon ? <opener.icon size={13} /> : <ExternalLink {...icon} />}
					onClick={() => opener.open({ url: href }, sessionId)}
				>
					{opener.label(resolvedLocale)}
				</MenuItem>
			))}
			<MenuSeparator />
			<MenuItem
				icon={<Link2 {...icon} />}
				onClick={() =>
					void window.plume.files
						.copyText(href)
						.then(() => notify(t("link.copied")))
						.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"))
				}
			>
				{t("link.copy")}
			</MenuItem>
		</ContextMenu>
	);
}
