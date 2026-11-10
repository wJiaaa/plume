/**
 * 文件面板顶上那一行：文件名（悬停看完整路径），和读这个文件的几样开关。
 *
 * 面板区的标签上只写得下名字，同名的文件靠这里的路径分开。
 */

import type { FileContents } from "@plume/contract";
import { IconButton, Popover, iconColour, lookFor, useI18n, usePopover } from "@plume/ui";
import { ChevronDown, ChevronRight, Code, ExternalLink, Eye, FolderOpen, WrapText } from "@plume/ui/icons";

import { attachmentActions } from "../composer/attachments/actions.ts";
import { FileTree } from "./FileTree.tsx";
import { fileKind } from "./FileViewer.tsx";
import { openLabel, revealKey, useOpenTarget } from "./open-targets.ts";
import { isDescendantPath } from "./paths.ts";
import { setShowSource, setWrap, useReading } from "./open-file.ts";

const ICON = { size: 12, strokeWidth: 1.9 } as const;

export function FileHeader({
	path,
	name,
	contents,
	sessionId,
	cwd,
	running,
	roots,
}: {
	path: string;
	name: string;
	contents: FileContents;
	sessionId?: string;
	cwd?: string;
	running?: boolean;
	roots?: readonly string[];
}) {
	const { t } = useI18n();
	const { wrap, showSource } = useReading();
	const kind = fileKind(name, contents);
	const look = lookFor(name, false);
	const target = { name, path };
	const opener = useOpenTarget();
	const tree = usePopover();
	const displayRoot = [...(roots ?? (cwd ? [cwd] : []))].sort((a, b) => b.length - a.length).find((root) => isDescendantPath(root, path)) ?? cwd;
	// 会话目录外的文件（「记忆文件」里只读打开的那些）没有相对位置可写，写它所在的文件夹，不借工作目录的名字。
	const crumb =
		displayRoot && isDescendantPath(displayRoot, path)
			? path
					.slice(displayRoot.length + 1)
					.split(/[/\\]/)
					.slice(0, -1)
					.join(" / ") || displayRoot.split(/[/\\]/).pop()
			: path.split(/[/\\]/).at(-2);

	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-b border-line-soft pr-2 pl-3">
			<look.Icon size={14} strokeWidth={1.9} className="shrink-0" style={{ color: iconColour(look) }} />
			<div className="flex min-w-0 flex-1 items-center gap-1 text-detail">
				{cwd && (
					<span className="min-w-0 truncate text-ink-muted" data-plume-tip={path}>
						{crumb}
					</span>
				)}
				{cwd && <ChevronRight size={11} className="shrink-0 text-ink-faint" />}
				<span className="min-w-0 truncate text-ink" data-plume-tip={path}>
					{name}
				</span>
				{sessionId && cwd && (
					<IconButton size="xs" label={t("fileTree.projectFiles")} expanded={tree.open} icon={<ChevronDown size={11} />} onClick={tree.toggle} />
				)}
			</div>
			{tree.open && sessionId && cwd && (
				<Popover
					anchor={tree.anchor}
					onClose={tree.close}
					placement="bottom"
					align="start"
					width={320}
					role="group"
					label={t("fileTree.projectFiles")}
					bodyClassName="p-0"
				>
					<div className="h-[340px]">
						<FileTree sessionId={sessionId} root={cwd} roots={roots} running={running} openPath={path} onOpen={tree.close} />
					</div>
				</Popover>
			)}
			{/* 读到上限截断了：屏幕上是文件的开头，不是全部。 */}
			{contents.truncated && <span className="shrink-0 px-1 text-caption text-ink-faint">{t("fileActions.tooBig")}</span>}
			{kind === "markdown" && (
				<IconButton
					size="xs"
					label={showSource ? t("common.preview") : t("fileActions.viewSource")}
					active={showSource}
					icon={showSource ? <Eye {...ICON} /> : <Code {...ICON} />}
					onClick={() => setShowSource(!showSource)}
				/>
			)}
			{/* Markdown 预览是正文，本来就换行，不给这个开关。 */}
			{(kind === "json" || kind === "text" || (kind === "markdown" && showSource)) && (
				<IconButton size="xs" label={t("fileActions.wrap")} active={wrap} icon={<WrapText {...ICON} />} onClick={() => setWrap(!wrap)} />
			)}
			<IconButton size="xs" label={openLabel(opener)} icon={<ExternalLink {...ICON} />} onClick={() => attachmentActions.openIn(target, opener.id)} />
			<IconButton size="xs" label={t(revealKey())} icon={<FolderOpen {...ICON} />} onClick={() => attachmentActions.reveal(target)} />
		</div>
	);
}
