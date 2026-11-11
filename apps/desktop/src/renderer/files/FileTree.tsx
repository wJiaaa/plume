import { useI18n, IconButton, Scroller, SearchField, useContextMenu, macKeyboard, shortcutLetter } from "@plume/ui";
import { ChevronsDownUp, FilePlus2, Filter, FolderPlus, X } from "@plume/ui/icons";
import { Fragment, useCallback, useId, useMemo, useRef, useState } from "react";

import type { FileEntry } from "@plume/contract";
import { openTargetId } from "./open-targets.ts";
import { openFile } from "./open-file.ts";
import { openInTerminal } from "./open-terminal.ts";
import { FileMenu } from "./FileMenu.tsx";
import { baseName, parentOf, isDescendantPath } from "./paths.ts";
import { NewRow, TreeRow } from "./TreeRow.tsx";
import { useFileActions } from "./useFileActions.ts";
import { useFileTree } from "./useFileTree.ts";
import { useTreeDrag } from "./useTreeDrag.ts";

export function FileTree({
	sessionId,
	root,
	roots: sourceRoots,
	openPath,
	onOpen: afterOpen,
	running,
}: {
	sessionId: string;
	root: string;
	roots?: readonly string[];
	openPath?: string;
	onOpen?: () => void;
	running?: boolean;
}) {
	const { t } = useI18n();
	const rootsKey = sourceRoots?.join("\0") ?? root;
	const roots = useMemo(() => rootsKey.split("\0"), [rootsKey]);
	const onOpen = useCallback(
		(entry: FileEntry) => {
			void openFile(entry.path, undefined, sessionId).then(afterOpen);
		},
		[sessionId, afterOpen],
	);
	const tree = useFileTree(sessionId, roots, running);
	const actions = useFileActions({ sessionId, roots, refresh: tree.refresh });

	const [selection, setSelection] = useState<string[]>([]);
	const [focus, setFocus] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [creating, setCreating] = useState<{ dir: string; kind: "file" | "directory" } | null>(null);
	const menu = useContextMenu<FileEntry | null>();
	const rowsHost = useRef<HTMLDivElement>(null);
	const treeId = useId();

	const chosen = useMemo(() => new Set(selection), [selection]);
	const cutSet = useMemo(() => new Set(actions.clipboard?.mode === "cut" ? actions.clipboard.paths : []), [actions.clipboard]);
	const byPath = useMemo(() => new Map(tree.rows.map(({ entry }) => [entry.path, entry])), [tree.rows]);

	const home = tree.scope ?? roots[0] ?? root;
	const targetDir = useMemo(() => {
		const last = selection.at(-1);
		if (!last) return home;
		const entry = byPath.get(last);
		return entry?.isDirectory ? last : parentOf(last);
	}, [selection, byPath, home]);

	const focusTree = useCallback(() => rowsHost.current?.focus(), []);

	const put = useCallback((path: string) => {
		setSelection([path]);
		setFocus(path);
	}, []);

	const moveTo = useCallback(
		(index: number) => {
			const row = tree.rows[Math.min(Math.max(index, 0), tree.rows.length - 1)];
			if (!row) return;
			put(row.entry.path);
			rowsHost.current?.querySelector(`[data-path="${CSS.escape(row.entry.path)}"]`)?.scrollIntoView({ block: "nearest" });
		},
		[tree.rows, put],
	);

	const activate = useCallback(
		(entry: FileEntry) => {
			if (entry.isDirectory) tree.toggle(entry.path);
			else onOpen(entry);
		},
		[tree, onOpen],
	);

	const startCreate = useCallback(
		(dir: string, kind: "file" | "directory") => {
			if (dir !== home || (roots.length > 1 && !tree.scope)) tree.expand(dir);
			setRenaming(null);
			setCreating({ dir, kind });
		},
		[home, tree, roots.length],
	);

	const commitCreate = useCallback(
		async (name: string) => {
			if (!creating) return;
			const { dir, kind } = creating;
			setCreating(null);
			const path = await actions.create(dir, name, kind);
			if (!path) return;
			put(path);
			if (kind === "file") onOpen({ name, path, isDirectory: false });
			else tree.expand(path);
		},
		[creating, actions, put, onOpen, tree],
	);

	const commitRename = useCallback(
		async (path: string, name: string) => {
			setRenaming(null);
			const next = await actions.rename(path, name);
			if (next) put(next);
		},
		[actions, put],
	);

	const removeSelected = useCallback(
		async (permanent: boolean) => {
			const doomed = selection.length > 0 ? selection : focus ? [focus] : [];
			if (doomed.length === 0 || doomed.some((path) => roots.includes(path))) return;
			const gone = new Set(doomed);
			const survivors = tree.rows.filter(({ entry }) => !doomed.some((path) => entry.path === path || isDescendantPath(path, entry.path)));
			const first = tree.rows.findIndex(({ entry }) => gone.has(entry.path));
			const next = survivors.find((row) => tree.rows.indexOf(row) > first) ?? survivors.at(-1);

			if (!(await actions.remove(doomed, permanent))) return;
			if (next) put(next.entry.path);
			else {
				setSelection([]);
				setFocus(null);
			}
		},
		[selection, focus, tree.rows, actions, put, roots],
	);

	const acted = useCallback(() => (selection.length > 0 ? selection : focus ? [focus] : []), [selection, focus]);

	const drag = useTreeDrag({
		root: home,
		pathsFor: (entry) => (chosen.has(entry.path) ? selection : [entry.path]),
		expand: tree.expand,
		isExpanded: (path) => tree.expanded.has(path),
		onTransfer: (paths, dir, mode) => void actions.transfer(paths, dir, mode),
		onImport: (sources, dir) => void actions.importInto(sources, dir),
	});

	function onRowClick(event: React.MouseEvent, entry: FileEntry, index: number) {
		focusTree();
		if (event.metaKey || event.ctrlKey) {
			setSelection((current) => (current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path]));
			setFocus(entry.path);
			return;
		}
		if (event.shiftKey && focus) {
			const from = tree.rows.findIndex((row) => row.entry.path === focus);
			if (from !== -1) {
				const [low, high] = from < index ? [from, index] : [index, from];
				setSelection(tree.rows.slice(low, high + 1).map((row) => row.entry.path));
				return;
			}
		}
		put(entry.path);
		activate(entry);
	}

	function onKeyDown(event: React.KeyboardEvent) {
		const mod = event.metaKey || event.ctrlKey;
		const index = tree.rows.findIndex((row) => row.entry.path === focus);
		const row = index === -1 ? null : tree.rows[index];

		const letter = shortcutLetter(event);
		const plain = mod && !event.altKey && !event.shiftKey;
		if (plain && letter === "c") return run(() => actions.copy(acted()));
		if (plain && letter === "x") return run(() => actions.cut(acted()));
		if (plain && letter === "v") return run(() => void actions.paste(targetDir));
		if (mod && event.altKey && letter === "c") return run(() => void actions.copyPath(acted(), event.shiftKey));

		const deleting = macKeyboard()
			? mod && (event.key === "Backspace" || event.key === "Delete")
			: event.key === "Delete" || (mod && event.key === "Backspace");
		if (deleting) {
			return run(() => void removeSelected(event.shiftKey));
		}

		switch (event.key) {
			case "ArrowDown":
				return run(() => moveTo(index + 1));
			case "ArrowUp":
				return run(() => moveTo(index === -1 ? 0 : index - 1));
			case "Home":
				return run(() => moveTo(0));
			case "End":
				return run(() => moveTo(tree.rows.length - 1));
			case "ArrowRight":
				if (row?.entry.isDirectory && !tree.expanded.has(row.entry.path)) {
					return run(() => tree.expand(row.entry.path));
				}
				return run(() => moveTo(index + 1));
			case "ArrowLeft": {
				if (row?.entry.isDirectory && tree.expanded.has(row.entry.path)) {
					return run(() => tree.collapse(row.entry.path));
				}
				if (!row) return;
				for (let i = index - 1; i >= 0; i--) {
					if (tree.rows[i]!.depth < row.depth) return run(() => moveTo(i));
				}
				return;
			}
			case "Enter":
			case " ":
				if (row) return run(() => activate(row.entry));
				return;
			case "F2":
				if (row && !roots.includes(row.entry.path)) return run(() => setRenaming(row.entry.path));
				return;
			case "Escape":
				if (creating) return run(() => setCreating(null));
				if (tree.filter || tree.scope) {
					return run(() => {
						tree.setFilter("");
						tree.setScope(null);
					});
				}
				return;
			default:
				return;
		}

		function run(action: () => void) {
			event.preventDefault();
			event.stopPropagation();
			action();
		}
	}

	const menuEntry = menu.target;
	const menuDir = menuEntry ? (menuEntry.isDirectory ? menuEntry.path : parentOf(menuEntry.path)) : home;
	const menuCount = menuEntry && chosen.has(menuEntry.path) ? selection.length : menuEntry ? 1 : 0;

	return (
		<div className="flex h-full min-h-0 flex-1 flex-col" data-file-tree="">
			<div className="flex h-[30px] shrink-0 items-center gap-0.5 px-1">
				<SearchField
					value={tree.filter}
					onChange={tree.setFilter}
					placeholder={t("fileTree.searchIn", { name: baseName(home) })}
					className="min-w-0 flex-1"
					onEscape={() => tree.setScope(null)}
				/>
				<IconButton size="sm" label={t("fileMenu.newFile")} icon={<FilePlus2 size={12.5} strokeWidth={1.8} />} onClick={() => startCreate(targetDir, "file")} />
				<IconButton
					size="sm"
					label={t("fileMenu.newFolder")}
					icon={<FolderPlus size={12.5} strokeWidth={1.8} />}
					onClick={() => startCreate(targetDir, "directory")}
				/>
				{tree.expanded.size > 0 && (
					<IconButton size="sm" label={t("fileMenu.collapseAll")} icon={<ChevronsDownUp size={12.5} strokeWidth={1.8} />} onClick={tree.collapseAll} />
				)}
			</div>
			{tree.scope && (
				<button
					type="button"
					data-plume-tip={t("fileTree.onlyThis", { name: baseName(tree.scope) })}
					aria-label={t("fileTree.onlyThis", { name: baseName(tree.scope) })}
					onClick={() => tree.setScope(null)}
					className="mx-1 mb-1 flex h-[20px] shrink-0 items-center gap-1 rounded-md bg-accent/12 px-1.5 text-caption text-accent transition-colors hover:bg-accent/20"
				>
					<Filter size={9.5} strokeWidth={2.2} className="shrink-0" aria-hidden />
					<span className="min-w-0 truncate">{baseName(tree.scope)}</span>
					<X size={9.5} strokeWidth={2.4} className="shrink-0" aria-hidden />
				</button>
			)}

			<Scroller className="flex-1" contentClassName="px-1 py-1">
				<div
					ref={rowsHost}
					role="tree"
					aria-label={t("fileTree.projectFiles")}
					aria-multiselectable
					aria-activedescendant={focus && byPath.has(focus) ? `${treeId}-${tree.rows.findIndex(({ entry }) => entry.path === focus)}` : undefined}
					tabIndex={0}
					data-plume-tree
					onKeyDown={(event) => {
						if (event.target === event.currentTarget) onKeyDown(event);
					}}
					onContextMenu={(event) => menu.show(event, null)}
					{...drag.backgroundProps()}
					className={`flex min-h-full flex-col rounded-md outline-none ${drag.dropTarget === home ? "bg-accent/8 ring-1 ring-accent ring-inset" : ""}`}
				>
					{creating?.dir === home && (roots.length === 1 || tree.scope) && (
						<NewRow depth={0} isDirectory={creating.kind === "directory"} onCommit={(name) => void commitCreate(name)} onCancel={() => setCreating(null)} />
					)}

					{tree.rows.map(({ entry, depth }, index) => (
						<Fragment key={entry.path}>
							<TreeRow
								id={`${treeId}-${index}`}
								entry={entry}
								depth={depth}
								expanded={tree.expanded.has(entry.path)}
								selected={chosen.has(entry.path) || openPath === entry.path}
								focused={focus === entry.path && selection.length > 1}
								cut={cutSet.has(entry.path)}
								dropping={entry.isDirectory && drag.dropTarget === entry.path}
								renaming={renaming === entry.path}
								onRename={(name) => void commitRename(entry.path, name)}
								onRenameCancel={() => setRenaming(null)}
								onClick={(event) => onRowClick(event, entry, index)}
								onContextMenu={(event) => {
									if (!chosen.has(entry.path)) put(entry.path);
									focusTree();
									menu.show(event, entry);
								}}
								{...drag.rowProps(entry)}
							/>
							{creating?.dir === entry.path && (
								<NewRow
									depth={depth + 1}
									isDirectory={creating.kind === "directory"}
									onCommit={(name) => void commitCreate(name)}
									onCancel={() => setCreating(null)}
								/>
							)}
						</Fragment>
					))}

					{tree.rows.length === 0 && !creating && (
						<p className="px-2 py-6 text-center text-detail text-ink-faint">{tree.filter ? t("fileTree.noMatch") : t("fileTree.emptyDir")}</p>
					)}
				</div>
			</Scroller>

			{menu.open && (
				<FileMenu
					anchor={menu.anchor}
					onClose={menu.close}
					entry={menuEntry}
					dir={menuDir}
					count={menuCount}
					canPaste={actions.clipboard !== null}
					protectedEntry={selection.some((path) => roots.includes(path))}
					actions={{
						open: activate,
						openWith: (path) => void window.plume.files.openIn(openTargetId(), path),
						reveal: (path) => void window.plume.files.reveal(path),
						openInTerminal: (dir) => {
							void openInTerminal(sessionId, dir);
						},
						newFile: (dir) => startCreate(dir, "file"),
						newFolder: (dir) => startCreate(dir, "directory"),
						cut: () => actions.cut(acted()),
						copy: () => actions.copy(acted()),
						paste: (dir) => void actions.paste(dir),
						copyPath: (relative) => void actions.copyPath(acted(), relative),
						rename: setRenaming,
						duplicate: (path) => void actions.duplicate(path).then((next) => next && put(next)),
						remove: (permanent) => void removeSelected(permanent),
						findInFolder: (dir) => {
							void tree.refresh([dir]).then(() => {
								tree.setScope(dir);
								tree.setFilter("");
							});
						},
						collapseAll: tree.collapseAll,
						refresh: () => void tree.refreshOpen(),
					}}
				/>
			)}
			{actions.prompt}
		</div>
	);
}
