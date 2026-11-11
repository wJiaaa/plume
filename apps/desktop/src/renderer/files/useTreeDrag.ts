import { useCallback, useEffect, useRef, useState } from "react";

import type { FileEntry } from "@plume/contract";
import { DRAGGED_PATHS as PATHS, droppedPaths, isDescendantPath, parentOf } from "./paths.ts";

import { macKeyboard } from "@plume/ui";

function copiesOnDrop(held: { altKey: boolean; ctrlKey: boolean }, platform = navigator.platform): boolean {
	return macKeyboard(platform) ? held.altKey : held.ctrlKey;
}

const SPRING_MS = 550;

interface TreeDrag {
	dropTarget: string | null;

	rowProps(entry: FileEntry): {
		onDragStart(event: React.DragEvent): void;
		onDragEnd(): void;
		onDragOver(event: React.DragEvent): void;
		onDragLeave(): void;
		onDrop(event: React.DragEvent): void;
	};

	backgroundProps(): {
		onDragOver(event: React.DragEvent): void;
		onDragLeave(): void;
		onDrop(event: React.DragEvent): void;
	};
}

export function useTreeDrag({
	root,
	pathsFor,
	expand,
	isExpanded,
	onTransfer,
	onImport,
}: {
	root: string;

	pathsFor(entry: FileEntry): string[];
	expand(path: string): void;
	isExpanded(path: string): boolean;
	onTransfer(paths: string[], dir: string, mode: "copy" | "cut"): void;
	onImport(sources: string[], dir: string): void;
}): TreeDrag {
	const [dragging, setDragging] = useState<string[]>([]);
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	const spring = useRef<{ path: string; timer: number } | null>(null);

	const cancelSpring = useCallback(() => {
		if (spring.current) window.clearTimeout(spring.current.timer);
		spring.current = null;
	}, []);

	useEffect(() => cancelSpring, [cancelSpring]);

	const allows = useCallback(
		(dir: string, external: boolean) => {
			if (external) return true;
			if (dragging.length === 0) return false;
			return !dragging.some((path) => path === dir || isDescendantPath(path, dir));
		},
		[dragging],
	);

	const springOpen = useCallback(
		(entry: FileEntry) => {
			if (!entry.isDirectory || isExpanded(entry.path)) return cancelSpring();
			if (spring.current?.path === entry.path) return;
			cancelSpring();
			spring.current = {
				path: entry.path,
				timer: window.setTimeout(() => expand(entry.path), SPRING_MS),
			};
		},
		[cancelSpring, expand, isExpanded],
	);

	const accept = useCallback(
		(event: React.DragEvent, dir: string) => {
			const external = event.dataTransfer.types.includes("Files") && !event.dataTransfer.types.includes(PATHS);
			if (!allows(dir, external)) {
				event.dataTransfer.dropEffect = "none";
				setDropTarget(null);
				return false;
			}
			event.preventDefault();
			event.dataTransfer.dropEffect = external || copiesOnDrop(event) ? "copy" : "move";
			setDropTarget(dir);
			return true;
		},
		[allows],
	);

	const finish = useCallback(
		(event: React.DragEvent, dir: string) => {
			event.preventDefault();
			event.stopPropagation();
			cancelSpring();
			setDropTarget(null);

			const paths = droppedPaths(event.dataTransfer, (file) => window.plume.files.pathFor(file)) ?? [];
			if (event.dataTransfer.types.includes(PATHS)) {
				if (paths.length > 0 && allows(dir, false)) onTransfer(paths, dir, copiesOnDrop(event) ? "copy" : "cut");
				setDragging([]);
				return;
			}
			if (paths.length > 0) onImport(paths, dir);
		},
		[allows, cancelSpring, onImport, onTransfer],
	);

	const rowProps = useCallback(
		(entry: FileEntry) => ({
			onDragStart: (event: React.DragEvent) => {
				const paths = pathsFor(entry);
				setDragging(paths);
				event.dataTransfer.setData(PATHS, JSON.stringify(paths));
				event.dataTransfer.setData("text/plain", paths.join("\n"));
				event.dataTransfer.effectAllowed = "copyMove";
			},
			onDragEnd: () => {
				setDragging([]);
				setDropTarget(null);
				cancelSpring();
			},
			onDragOver: (event: React.DragEvent) => {
				const dir = entry.isDirectory ? entry.path : parentOf(entry.path);
				if (accept(event, dir)) springOpen(entry);
				event.stopPropagation();
			},
			onDragLeave: cancelSpring,
			onDrop: (event: React.DragEvent) => finish(event, entry.isDirectory ? entry.path : parentOf(entry.path)),
		}),
		[accept, cancelSpring, finish, pathsFor, springOpen],
	);

	const backgroundProps = useCallback(
		() => ({
			onDragOver: (event: React.DragEvent) => void accept(event, root),
			onDragLeave: () => setDropTarget(null),
			onDrop: (event: React.DragEvent) => finish(event, root),
		}),
		[accept, finish, root],
	);

	return { dropTarget, rowProps, backgroundProps };
}
