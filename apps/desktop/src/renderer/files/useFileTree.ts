/** 文件面板和文件名下拉共用目录缓存、展开状态；筛选和范围只属于当前视图。 */
import type { FileEntry } from "@plume/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { baseName, listDirectory } from "./open-file.ts";
import { isDescendantPath } from "./paths.ts";
import { notify } from "../toast/store.ts";

interface TreeState {
	children: Record<string, FileEntry[]>;
	expanded: Set<string>;
}
const sessions = new Map<string, { state: TreeState; listeners: Set<() => void> }>();
function storeFor(sessionId: string) {
	let store = sessions.get(sessionId);
	if (!store) {
		store = { state: { children: {}, expanded: new Set() }, listeners: new Set() };
		sessions.set(sessionId, store);
	}
	return store;
}
const complain = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error");

export function treeRows({ roots, scope, children, expanded, filter }: TreeState & { roots: string[]; scope: string | null; filter: string }) {
	const bases = scope ? [scope] : roots;
	const needle = filter.trim().toLowerCase();
	const rows: Array<{ entry: FileEntry; depth: number }> = [];
	const matches = (entry: FileEntry) => entry.name.toLowerCase().includes(needle);
	const below = (dir: string): boolean => (children[dir] ?? []).some((entry) => matches(entry) || (entry.isDirectory && below(entry.path)));
	const walk = (dir: string, depth: number) => {
		for (const entry of children[dir] ?? []) {
			const deeper = needle && entry.isDirectory && below(entry.path);
			if (needle && !matches(entry) && !deeper) continue;
			rows.push({ entry, depth });
			if (entry.isDirectory && (needle ? deeper : expanded.has(entry.path))) walk(entry.path, depth + 1);
		}
	};
	if (bases.length === 1) walk(bases[0]!, 0);
	else
		for (const root of bases) {
			if (needle && !below(root)) continue;
			rows.push({ entry: { path: root, name: baseName(root), isDirectory: true }, depth: 0 });
			if (needle || expanded.has(root)) walk(root, 1);
		}
	return rows;
}

export function useFileTree(sessionId: string, roots: string[], running = false) {
	const store = useMemo(() => storeFor(sessionId), [sessionId]);
	const subscribe = useCallback(
		(listener: () => void) => {
			store.listeners.add(listener);
			return () => {
				store.listeners.delete(listener);
			};
		},
		[store],
	);
	const state = useSyncExternalStore(subscribe, () => store.state);
	const [filter, setFilter] = useState("");
	const [scope, setScope] = useState<string | null>(null);
	const methods = useMemo(() => {
		const set = (patch: Partial<TreeState>) => {
			store.state = { ...store.state, ...patch };
			for (const listener of store.listeners) listener();
		};
		const refresh = async (dirs: Iterable<string>) => {
			const unique = [...new Set(dirs)];
			const read = await Promise.allSettled(unique.map((dir) => listDirectory(sessionId, dir)));
			const children = { ...store.state.children };
			const expanded = new Set(store.state.expanded);
			const forget = (path: string) => {
				for (const dir of Object.keys(children))
					if (dir === path || isDescendantPath(path, dir)) {
						delete children[dir];
						expanded.delete(dir);
					}
			};
			for (let index = 0; index < read.length; index++) {
				const result = read[index]!;
				const dir = unique[index]!;
				if (result.status === "fulfilled") {
					for (const previous of children[dir] ?? []) {
						if (previous.isDirectory && !result.value.some((entry) => entry.path === previous.path && entry.isDirectory)) forget(previous.path);
					}
					children[dir] = result.value;
				} else {
					if (!(dir in children)) complain(result.reason);
					forget(dir);
				}
			}
			set({ children, expanded });
		};
		const expand = (path: string) => {
			set({ expanded: new Set(store.state.expanded).add(path) });
			void refresh([path]).catch(complain);
		};
		const collapse = (path: string) => {
			const next = new Set(store.state.expanded);
			next.delete(path);
			set({ expanded: next });
		};
		return { refresh, expand, collapse, toggle: (path: string) => (store.state.expanded.has(path) ? collapse(path) : expand(path)), set };
	}, [store, sessionId]);
	const refreshOpen = useCallback(
		() => methods.refresh([...roots, ...[...store.state.expanded].filter((path) => roots.some((root) => path === root || isDescendantPath(root, path)))]),
		[roots, store, methods],
	);
	const wasRunning = useRef(running);
	useEffect(() => {
		if (roots.length > 1 && roots.every((root) => !(root in store.state.children))) methods.set({ expanded: new Set(store.state.expanded).add(roots[0]!) });
		void refreshOpen().catch(complain);
	}, [roots, methods, store, refreshOpen]);
	useEffect(() => {
		if (wasRunning.current && !running) void refreshOpen().catch(complain);
		wasRunning.current = running;
	}, [running, refreshOpen]);
	useEffect(() => {
		const refresh = () => {
			void refreshOpen().catch(complain);
		};
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refreshOpen]);
	useEffect(() => {
		if (scope && !(scope in state.children)) setScope(null);
	}, [scope, state.children]);
	return {
		...state,
		...methods,
		filter,
		setFilter,
		scope,
		setScope,
		refreshOpen,
		rows: treeRows({ ...state, roots, scope, filter }),
		collapseAll: () =>
			methods.set({ expanded: new Set([...store.state.expanded].filter((path) => !roots.some((root) => path === root || isDescendantPath(root, path)))) }),
	};
}
