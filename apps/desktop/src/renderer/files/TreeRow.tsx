import { ChevronRight } from "@plume/ui/icons";

import type { FileEntry } from "@plume/contract";
import { iconColour, lookFor, ScrollText } from "@plume/ui";

import { NameEditor } from "./NameEditor.tsx";

const INDENT = 12;
const GUTTER = 6;

interface TreeRowProps {
	id: string;
	entry: FileEntry;
	depth: number;
	expanded: boolean;
	selected: boolean;

	focused: boolean;

	cut: boolean;

	dropping: boolean;
	renaming: boolean;
	onRename(name: string): void;
	onRenameCancel(): void;
	onClick(event: React.MouseEvent): void;
	onContextMenu(event: React.MouseEvent): void;
	onDragStart(event: React.DragEvent): void;
	onDragEnd(): void;
	onDragOver(event: React.DragEvent): void;
	onDragLeave(): void;
	onDrop(event: React.DragEvent): void;
}

export function TreeRow({
	id,
	entry,
	depth,
	expanded,
	selected,
	focused,
	cut,
	dropping,
	renaming,
	onRename,
	onRenameCancel,
	onClick,
	onContextMenu,
	onDragStart,
	onDragEnd,
	onDragOver,
	onDragLeave,
	onDrop,
}: TreeRowProps) {
	const look = lookFor(entry.name, entry.isDirectory, expanded);

	return (
		<div
			id={id}
			role="treeitem"
			aria-level={depth + 1}
			aria-selected={selected}
			aria-expanded={entry.isDirectory ? expanded : undefined}
			data-path={entry.path}
			tabIndex={-1}
			draggable={!renaming}
			data-plume-tip={renaming ? undefined : entry.path}
			onClick={onClick}
			onContextMenu={onContextMenu}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
			className={`plume-scroll flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-detail transition-colors ${
				selected ? "bg-card-hover text-ink" : "text-ink-muted hover:bg-card-hover/60"
			} ${focused ? "ring-1 ring-accent/50 ring-inset" : ""} ${dropping ? "bg-accent/12 ring-1 ring-accent ring-inset" : ""} ${cut ? "opacity-45" : ""}`}
			style={{ paddingLeft: GUTTER + depth * INDENT }}
		>
			{entry.isDirectory ? (
				<ChevronRight
					size={11}
					strokeWidth={2.2}
					className="shrink-0 text-ink-faint transition-transform duration-[var(--plume-t-quick)]"
					style={expanded ? { transform: "rotate(90deg)" } : undefined}
				/>
			) : (
				<span className="w-[11px] shrink-0" />
			)}

			<look.Icon size={12.5} strokeWidth={1.75} className="shrink-0" style={{ color: iconColour(look) }} />

			{renaming ? (
				<NameEditor initial={entry.name} onCommit={onRename} onCancel={onRenameCancel} />
			) : (
				<ScrollText text={entry.name} className="min-w-0 flex-1" />
			)}
		</div>
	);
}

export function NewRow({
	depth,
	isDirectory,
	onCommit,
	onCancel,
}: {
	depth: number;
	isDirectory: boolean;
	onCommit: (name: string) => void;
	onCancel: () => void;
}) {
	const look = lookFor("", isDirectory, false);
	return (
		<div className="flex w-full items-center gap-1 rounded-md py-1 pr-2" style={{ paddingLeft: GUTTER + depth * INDENT }}>
			<span className="w-[11px] shrink-0" />
			<look.Icon size={12.5} strokeWidth={1.75} className="shrink-0" style={{ color: iconColour(look) }} />
			<NameEditor initial="" selectStem={false} onCommit={onCommit} onCancel={onCancel} />
		</div>
	);
}
