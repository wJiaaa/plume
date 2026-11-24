/**
 * 多文件 diff：顶上一条工具栏，下面每个文件一行，点开是它的 diff。Git 面板的改动、历史、分支，交付卡的审核面板都用这一套，
 * 长得一样，统一 / 分栏、换不换行也是同一份习惯。
 *
 * diff 正文由调用方画（插件给 `ui.FileDiff`，带上 `DiffViewOptions` 里的 `layout`、`wrap`）：语法高亮在宿主里，
 * 二进制、还在读、行评论这些各家也不一样。
 */

import type { FileDiffLayout } from "@plume/contract/ui";
import { type MouseEvent, type ReactNode, useState, useSyncExternalStore } from "react";
import { iconColour, lookFor } from "../fileIcon.tsx";
import { formatStatCount, splitPath } from "./format.ts";
import { useCopied } from "../hooks/useCopied.ts";
import { useNarrow } from "../hooks/useNarrow.ts";
import { useI18n } from "../i18n/context.tsx";
import { Check, ChevronsDownUp, ChevronsUpDown, Columns2, Copy, Rows3, WrapText } from "../icons/index.ts";
import { Segmented } from "../inputs/Segmented.tsx";
import { Caret } from "../primitives/Caret.tsx";
import { IconButton } from "../primitives/IconButton.tsx";
import { Text } from "../primitives/Text.tsx";

/** 文件在这次改动里怎么了，行尾画成一个字母标（A / U / M / D / R）。 */
export type DiffFileStatus = "added" | "untracked" | "modified" | "deleted" | "renamed";

/** 多文件 diff 里的一个文件。插件自己的字段（hunks、二进制……）放在扩展出来的类型上，组件原样交回 `renderDiff`、`actions`。 */
export interface DiffFileEntry {
	/** 唯一键：展开状态、`actions`、右键都按它认。 */
	path: string;
	/** 行上显示、「复制路径」复制的写法，一般是相对工作目录的路径；不给时用 `path`。 */
	label?: string;
	added: number;
	removed: number;
	/** 不给就不画状态标。 */
	status?: DiffFileStatus;
}

/** 画 diff 正文用的视图：原样传给 `ui.FileDiff` 的 `layout`、`wrap`。 */
export interface DiffViewOptions {
	layout: FileDiffLayout;
	wrap: boolean;
}

/** 窄过这个宽度两栏放不下：列表按统一视图画，工具栏不给切换。 */
const SPLIT_MIN_WIDTH = 540;
const LAYOUT_KEY = "plume.diff.layout";
const WRAP_KEY = "plume.diff.wrap";

// 记的是这个人习惯怎么读 diff：所有多文件 diff 共用一份，关掉面板、换会话、重启都留着；一处改了，开着的几处一起换。
let stored: DiffViewOptions | null = null;
const listeners = new Set<() => void>();

function storedView(): DiffViewOptions {
	stored ??= { layout: localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified", wrap: localStorage.getItem(WRAP_KEY) === "1" };
	return stored;
}

function setStoredView(next: Partial<DiffViewOptions>) {
	stored = { ...storedView(), ...next };
	localStorage.setItem(LAYOUT_KEY, stored.layout);
	localStorage.setItem(WRAP_KEY, stored.wrap ? "1" : "0");
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * 人在 `DiffToolbar` 上选的统一 / 分栏和换行。`DiffFileList` 自己会读；自己画文件行（`DiffFileItem`）的地方用它拿到同一份，
 * 容器窄于 540px 时按 `unified` 画（`useNarrow(540)`）。
 */
export function useDiffView(): DiffViewOptions {
	return useSyncExternalStore(subscribe, storedView);
}

/**
 * `+增 −删`，等宽数字，上万缩成 `12k`。为 0 的那一半不画，两个都是 0 时什么都不画。
 * 文件行尾用 `align="end"`：右对齐、占一个最小宽度，一列文件的数字对得齐；跟在一句话后面用默认的 `inline`。
 */
export function DiffStat({
	added,
	removed,
	align = "inline",
	className = "",
}: {
	added: number;
	removed: number;
	align?: "inline" | "end";
	/** 只放布局。 */
	className?: string;
}) {
	if (added <= 0 && removed <= 0) return null;
	return (
		<Text size="caption" mono numeric className={`plume-diff-stat${align === "end" ? " plume-diff-stat-end" : ""} ${className}`.trim()}>
			{added > 0 && <span className="plume-diff-add">+{formatStatCount(added)}</span>}
			{removed > 0 && <span className="plume-diff-remove">−{formatStatCount(removed)}</span>}
		</Text>
	);
}

/**
 * 多文件 diff 顶上那一条：文件数、总增删，全部展开 / 折叠，统一 / 分栏，自动换行。放在滚动面外面、列表上方，滚长 diff 时一直够得着。
 * 统一 / 分栏和换行改的是 `useDiffView` 那一份，不用调用方接；面板窄于 540px 时不给切换。
 */
export function DiffToolbar({
	files,
	added,
	removed,
	expanded,
	onToggleAll,
	children,
}: {
	/** 一共几个文件。 */
	files: number;
	added: number;
	removed: number;
	/** 现在有没有文件开着：决定那颗按钮是「全部折叠」还是「全部展开」。 */
	expanded?: boolean;
	/** 全部展开 / 折叠；不给就没有这颗按钮。 */
	onToggleAll?: () => void;
	/** 排在换行后面的别的开关（`sm` 的 `IconButton`），比如平铺 / 树。 */
	children?: ReactNode;
}) {
	const { t } = useI18n();
	const view = useDiffView();
	const [narrow, ref] = useNarrow(SPLIT_MIN_WIDTH);
	return (
		<div ref={ref} className="plume-diff-bar">
			<Text size="caption" tone="muted" numeric className="plume-diff-bar-count">
				{t("diff.fileCount", { n: files })}
			</Text>
			<DiffStat added={added} removed={removed} />
			<div className="plume-diff-bar-controls">
				{onToggleAll && (
					<IconButton
						size="sm"
						label={expanded ? t("diff.collapseAll") : t("diff.expandAll")}
						icon={expanded ? <ChevronsDownUp size={13} strokeWidth={1.9} /> : <ChevronsUpDown size={13} strokeWidth={1.9} />}
						onClick={onToggleAll}
					/>
				)}
				{!narrow && (
					<Segmented
						compact
						ariaLabel={t("diff.layout")}
						value={view.layout}
						onChange={(layout) => setStoredView({ layout })}
						options={[
							{ value: "unified", label: t("diff.unified"), icon: <Rows3 size={12.5} strokeWidth={1.9} /> },
							{ value: "split", label: t("diff.split"), icon: <Columns2 size={12.5} strokeWidth={1.9} /> },
						]}
					/>
				)}
				<IconButton
					size="sm"
					label={view.wrap ? t("diff.unwrap") : t("diff.wrap")}
					icon={<WrapText size={13} strokeWidth={1.9} />}
					active={view.wrap}
					onClick={() => setStoredView({ wrap: !view.wrap })}
				/>
				{children}
			</div>
		</div>
	);
}

const STATUS_GLYPH: Record<DiffFileStatus, string> = { added: "A", untracked: "U", modified: "M", deleted: "D", renamed: "R" };

function CopyPath({ path }: { path: string }) {
	const { t } = useI18n();
	const { copied, mark } = useCopied();
	return (
		<IconButton
			size="sm"
			icon={copied ? <Check size={12} strokeWidth={2.2} className="plume-diff-copied" /> : <Copy size={12} strokeWidth={1.9} />}
			label={copied ? t("diff.copiedPath") : t("diff.copyPath")}
			onClick={() =>
				void navigator.clipboard.writeText(path).then(
					() => mark(true),
					() => undefined,
				)
			}
		/>
	);
}

/**
 * 一个文件：钉在顶上的那一行（箭头、文件图标、文件名在前目录在后、悬停才出的动作、行尾增删数和状态标），展开时下面是 `children`。
 * 一般用 `DiffFileList`；自己排文件的（按目录排成树）才直接用它，`indent` 给缩进、`showDir={false}` 只写文件名。
 * 每个文件带 `data-diff-file={path}`。
 */
export function DiffFileItem({
	file,
	open,
	onToggle,
	actions,
	onContextMenu,
	indent,
	showDir = true,
	children,
}: {
	file: DiffFileEntry;
	open: boolean;
	onToggle: () => void;
	/** 悬停这一行时出现的按钮（`sm` 的 `IconButton`），排在「复制路径」后面。 */
	actions?: ReactNode;
	onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
	/** 行首缩进，单位 px。 */
	indent?: number;
	showDir?: boolean;
	/** 展开时画在行下面：一般是 `ui.FileDiff`，也可以是占位或一句说明。 */
	children?: ReactNode;
}) {
	const { t } = useI18n();
	const shown = file.label ?? file.path;
	const { dir, name } = splitPath(shown);
	const look = lookFor(name.replace(/[\\/]$/, ""), /[\\/]$/.test(name));
	const deleted = file.status === "deleted";
	return (
		<section data-diff-file={file.path} data-expanded={open || undefined} className="plume-diff-file">
			{/* 读到三百行深处，问题变成「我在哪个文件里」：文件名钉在顶上，下一个文件经过时把它推走。 */}
			<div className="plume-diff-pin">
				<div className="plume-diff-head" style={indent === undefined ? undefined : { paddingLeft: indent }} onContextMenu={onContextMenu}>
					<button type="button" data-plume-tip={shown} aria-expanded={open} className="plume-diff-toggle" onClick={onToggle}>
						<Caret open={open} from="right" size={12} strokeWidth={2} className="plume-diff-chevron" />
						<look.Icon size={13} strokeWidth={1.75} className="plume-diff-icon" style={{ color: iconColour(look) }} />
						<span className="plume-diff-path">
							<Text size="detail" tone={deleted ? "muted" : "default"} weight="medium" className={`plume-diff-name${deleted ? " plume-diff-deleted" : ""}`}>
								{name}
							</Text>
							{showDir && dir && (
								<Text size="caption" tone="faint" className="plume-diff-dir">
									{dir}
								</Text>
							)}
						</span>
					</button>
					<div className="plume-diff-actions">
						<CopyPath path={shown} />
						{actions}
					</div>
					<div className="plume-diff-meta">
						<DiffStat added={file.added} removed={file.removed} align="end" />
						{file.status && (
							<Text
								as="span"
								size="caption"
								mono
								weight="medium"
								data-diff-status={file.status}
								data-plume-tip={t(`diff.status.${file.status}`)}
								className="plume-diff-status"
							>
								{STATUS_GLYPH[file.status]}
							</Text>
						)}
					</div>
				</div>
			</div>
			{open && <div className="plume-diff-body">{children}</div>}
		</section>
	);
}

/**
 * 一列文件，各自展开成自己的 diff（手风琴：能把两个文件同时开着往下读）。放在 `Scroller` 里，上方配 `DiffToolbar`。
 * 展开哪些可以交给它自己记（`initiallyOpen` 定开头全开还是全关），要配「全部展开 / 折叠」时用 `open`、`onToggle` 自己管。
 * `renderDiff` 拿到的视图已经按人选的和容器宽窄算好，原样交给 `ui.FileDiff`。
 */
export function DiffFileList<F extends DiffFileEntry>({
	files,
	renderDiff,
	open,
	onToggle,
	initiallyOpen = false,
	actions,
	onFileContextMenu,
	emptyLabel,
}: {
	files: readonly F[];
	renderDiff: (file: F, view: DiffViewOptions) => ReactNode;
	open?: ReadonlySet<string>;
	onToggle?: (path: string) => void;
	initiallyOpen?: boolean;
	actions?: (file: F) => ReactNode;
	onFileContextMenu?: (event: MouseEvent<HTMLElement>, file: F) => void;
	/** 一个文件都没有时说的话；不给就什么都不画。 */
	emptyLabel?: string;
}) {
	const stored = useDiffView();
	const [narrow, ref] = useNarrow(SPLIT_MIN_WIDTH);
	const [localOpen, setLocalOpen] = useState<ReadonlySet<string>>(() => new Set(initiallyOpen ? files.map((file) => file.path) : []));
	const opened = open ?? localOpen;
	const view: DiffViewOptions = { layout: narrow ? "unified" : stored.layout, wrap: stored.wrap };
	const toggle = (path: string) => {
		if (onToggle) return onToggle(path);
		setLocalOpen((current) => {
			const next = new Set(current);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	};
	if (!files.length)
		return emptyLabel ? (
			<Text as="p" size="label" tone="faint" className="plume-diff-empty">
				{emptyLabel}
			</Text>
		) : null;
	return (
		<div ref={ref} className="plume-diff-list">
			{files.map((file) => {
				const isOpen = opened.has(file.path);
				return (
					<DiffFileItem
						key={file.path}
						file={file}
						open={isOpen}
						onToggle={() => toggle(file.path)}
						actions={actions?.(file)}
						onContextMenu={onFileContextMenu && ((event) => onFileContextMenu(event, file))}
					>
						{isOpen && renderDiff(file, view)}
					</DiffFileItem>
				);
			})}
		</div>
	);
}
