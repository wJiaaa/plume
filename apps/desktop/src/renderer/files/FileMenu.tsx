import { useI18n, ContextMenu, MenuItem, MenuSeparator, macKeyboard } from "@plume/ui";
import {
	ClipboardPaste,
	Copy,
	CopyMinus,
	CornerUpRight,
	ExternalLink,
	FilePlus2,
	FolderOpen,
	FolderPlus,
	FolderSearch,
	Link2,
	Pencil,
	RefreshCw,
	Scissors,
	SquareTerminal,
	Trash2,
} from "@plume/ui/icons";

import type { FileEntry } from "@plume/contract";
import { openLabel, useOpenTarget, revealLabel } from "./open-targets.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

interface FileMenuActions {
	open(entry: FileEntry): void;
	openWith(path: string): void;
	reveal(path: string): void;
	openInTerminal(dir: string): void;
	newFile(dir: string): void;
	newFolder(dir: string): void;
	cut(): void;
	copy(): void;
	paste(dir: string): void;
	copyPath(relative: boolean): void;
	rename(path: string): void;
	duplicate(path: string): void;
	remove(permanent: boolean): void;
	findInFolder(dir: string): void;
	collapseAll(): void;
	refresh(): void;
}

export function FileMenu({
	anchor,
	onClose,

	entry,

	dir,

	count,
	canPaste,
	protectedEntry,
	actions,
}: {
	anchor: { x: number; y: number } | null;
	onClose: () => void;
	entry: FileEntry | null;
	dir: string;
	count: number;
	canPaste: boolean;
	protectedEntry: boolean;
	actions: FileMenuActions;
}) {
	const { t } = useI18n();
	const openTarget = useOpenTarget();
	const reveal = revealLabel();
	const many = count > 1;

	const what = many ? t("fileMenu.theseN", { n: count }) : "";

	return (
		<ContextMenu anchor={anchor} onClose={onClose} width="default">
			{entry && !many && (
				<>
					{!entry.isDirectory && (
						<MenuItem icon={<FolderOpen {...ICON} />} onClick={() => actions.open(entry)}>
							{t("common.open")}
						</MenuItem>
					)}
					<MenuItem icon={<ExternalLink {...ICON} />} onClick={() => actions.openWith(entry.path)}>
						{openLabel(openTarget)}
					</MenuItem>
				</>
			)}
			<MenuItem icon={<CornerUpRight {...ICON} />} onClick={() => actions.reveal(entry?.path ?? dir)}>
				{reveal}
			</MenuItem>
			<MenuItem icon={<SquareTerminal {...ICON} />} onClick={() => actions.openInTerminal(dir)}>
				{t("fileMenu.openInTerminal")}
			</MenuItem>

			<MenuSeparator />
			<MenuItem icon={<FilePlus2 {...ICON} />} onClick={() => actions.newFile(dir)}>
				{t("fileMenu.newFile")}
			</MenuItem>
			<MenuItem icon={<FolderPlus {...ICON} />} onClick={() => actions.newFolder(dir)}>
				{t("fileMenu.newFolder")}
			</MenuItem>

			<MenuSeparator />

			{entry && (
				<>
					<MenuItem icon={<Scissors {...ICON} />} hint="⌘X" disabled={protectedEntry} onClick={actions.cut}>
						{t("fileMenu.cut", { what })}
					</MenuItem>
					<MenuItem icon={<Copy {...ICON} />} hint="⌘C" onClick={actions.copy}>
						{t("fileMenu.copy", { what })}
					</MenuItem>
				</>
			)}
			<MenuItem
				icon={<ClipboardPaste {...ICON} />}
				hint="⌘V"
				disabled={!canPaste}
				title={canPaste ? undefined : t("fileMenu.clipboardEmpty")}
				onClick={() => actions.paste(dir)}
			>
				{t("common.paste")}
			</MenuItem>

			{entry && (
				<>
					<MenuSeparator />
					<MenuItem icon={<Link2 {...ICON} />} hint="⌥⌘C" onClick={() => actions.copyPath(false)}>
						{t("fileMenu.copyPath")}
					</MenuItem>
					<MenuItem icon={<Link2 {...ICON} />} hint="⌥⇧⌘C" onClick={() => actions.copyPath(true)}>
						{t("fileMenu.copyRelativePath")}
					</MenuItem>

					<MenuSeparator />
					{!many && (
						<>
							<MenuItem icon={<Pencil {...ICON} />} hint="F2" disabled={protectedEntry} onClick={() => actions.rename(entry.path)}>
								{t("common.rename")}
							</MenuItem>
							<MenuItem icon={<Copy {...ICON} />} disabled={protectedEntry} onClick={() => actions.duplicate(entry.path)}>
								{t("fileMenu.duplicate")}
							</MenuItem>
						</>
					)}
					<MenuItem icon={<Trash2 {...ICON} />} hint={macKeyboard() ? "⌘⌫" : "Delete"} danger disabled={protectedEntry} onClick={() => actions.remove(false)}>
						{t("fileMenu.delete", { what })}
					</MenuItem>
					<MenuItem
						icon={<Trash2 {...ICON} />}
						hint={macKeyboard() ? "⇧⌘⌫" : "Shift+Delete"}
						danger
						disabled={protectedEntry}
						onClick={() => actions.remove(true)}
					>
						{t("fileMenu.deleteForever", { what })}
					</MenuItem>
				</>
			)}

			<MenuSeparator />
			{entry?.isDirectory && !many && (
				<MenuItem icon={<FolderSearch {...ICON} />} onClick={() => actions.findInFolder(entry.path)}>
					{t("fileMenu.searchHere")}
				</MenuItem>
			)}
			<MenuItem icon={<CopyMinus {...ICON} />} onClick={actions.collapseAll}>
				{t("fileMenu.collapseAll")}
			</MenuItem>
			<MenuItem icon={<RefreshCw {...ICON} />} onClick={actions.refresh}>
				{t("common.refresh")}
			</MenuItem>
		</ContextMenu>
	);
}
