import { translate, claimHoverSuppression } from "@plume/ui";
import { notify } from "../toast/index.ts";
import type { SidebarActions } from "./actions.ts";
import { moveBeforeOrAfter, orderedSessions, type SessionSort } from "./order.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { withSpawned, type nestSpawned } from "./grouping.ts";
import type { DraggingItem, DropTarget, ReorderState, SidebarReorderContextValue } from "./reorder-context.ts";

const DRAG_THRESHOLD = 5;

export function useSidebarReorder(
	groups: ReturnType<typeof nestSpawned>,
	/** 各项目实际的排法：拖动前的顺序要和画出来的一样。 */
	sortOf: (projectId: string) => SessionSort,
	actions: SidebarActions,
	onReordered: (projectId: string) => void,
): {
	contextValue: SidebarReorderContextValue;
	dragging: DraggingItem | null;
} {
	const [dragging, setDragging] = useState<DraggingItem | null>(null);
	useEffect(() => {
		if (dragging) return claimHoverSuppression();
	}, [dragging]);
	const store = useRef<ReorderState>({ dragging: null, dropTarget: null, pointer: { x: 0, y: 0 } });
	const listeners = useRef(new Set<() => void>());
	const update = useCallback((patch: Partial<ReorderState>) => {
		store.current = { ...store.current, ...patch };
		for (const listener of listeners.current) listener();
	}, []);
	const candidateRef = useRef<{ item: DraggingItem; originX: number; originY: number; pointerId: number } | null>(null);
	const suppressClick = useRef(false);
	const saving = useRef(false);

	const sorting = useRef(sortOf);
	sorting.current = sortOf;
	const reordered = useRef(onReordered);
	reordered.current = onReordered;
	const callbacks = useRef(actions);
	callbacks.current = actions;

	const grouping = useRef(groups);
	grouping.current = groups;

	const eligible = useCallback((kind: "project" | "session", id: string, project?: string) => {
		const groups = grouping.current;
		if (kind === "session") return groups.projects.some((group) => group.id === project && group.sessions.some((session) => session.id === id));
		return groups.projects.some((group) => group.id === id);
	}, []);

	const reset = useCallback(() => {
		candidateRef.current = null;
		if (store.current.dragging || store.current.dropTarget) update({ dragging: null, dropTarget: null });
		setDragging(null);
	}, [update]);

	const startDrag = useCallback(
		(item: DraggingItem, event: React.PointerEvent) => {
			if (event.button !== 0 || event.pointerType !== "mouse" || saving.current || !eligible(item.kind, item.id, item.project)) return;
			candidateRef.current = { item, originX: event.clientX, originY: event.clientY, pointerId: event.pointerId };
			update({ pointer: { x: event.clientX, y: event.clientY } });
		},
		[eligible, update],
	);

	const registerTarget = useCallback(
		(kind: "project" | "session", id: string, rect: DOMRect, clientY: number, project?: string) => {
			const active = store.current.dragging;
			if (!active || active.kind !== kind || active.id === id || !eligible(kind, id, project)) return;
			if (kind === "session" && active.project !== project) return;
			const placement = clientY < rect.top + rect.height / 2 ? "before" : "after";
			const current = store.current.dropTarget;
			if (!current || current.id !== id || current.placement !== placement) {
				const next: DropTarget = { kind, id, placement };
				update({ dropTarget: next });
			}
		},
		[eligible, update],
	);

	const clearTarget = useCallback(
		(id: string) => {
			if (store.current.dropTarget?.id === id) update({ dropTarget: null });
		},
		[update],
	);

	useEffect(() => {
		const handlePointerDown = () => {
			suppressClick.current = false;
		};
		const handlePointerMove = (event: PointerEvent) => {
			const candidate = candidateRef.current;
			if (!candidate || event.pointerId !== candidate.pointerId) return;
			if (!(event.buttons & 1)) {
				reset();
				return;
			}
			if (!store.current.dragging && Math.hypot(event.clientX - candidate.originX, event.clientY - candidate.originY) >= DRAG_THRESHOLD) {
				suppressClick.current = true;
				update({ dragging: candidate.item });
				setDragging(candidate.item);
			}
			if (store.current.dragging) {
				event.preventDefault();
				update({ pointer: { x: event.clientX, y: event.clientY } });
			}
		};
		const commit = async (active: DraggingItem, target: DropTarget) => {
			saving.current = true;
			try {
				if (active.kind === "project") await callbacks.current.reorderProjects(active.id, target.id, target.placement);
				else if (active.project) {
					const group = grouping.current.projects.find((group) => group.id === active.project);
					// 隐藏的后续会话也保留原来的排序位置，归档来源以后不会突然跳到列表最前面。
					const all = group ? orderedSessions(withSpawned(group.sessions, grouping.current.spawned), sorting.current(group.id), group.sessionOrder) : [];
					const ids = moveBeforeOrAfter(
						all.map((session) => session.id),
						active.id,
						target.id,
						target.placement,
					);
					if (ids) {
						await callbacks.current.reorderSessions(active.project, ids);
						reordered.current(active.project);
					}
				}
			} catch (cause) {
				notify(translate("reorder.saveFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
			} finally {
				saving.current = false;
			}
		};
		const handlePointerUp = (event: PointerEvent) => {
			if (event.pointerId !== candidateRef.current?.pointerId) return;
			const { dragging: active, dropTarget: target } = store.current;
			reset();
			if (active && target) void commit(active, target);
		};
		const cancelPointer = (event: PointerEvent) => {
			if (event.pointerId === candidateRef.current?.pointerId) reset();
		};
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && candidateRef.current) {
				event.preventDefault();
				reset();
			}
		};
		const handleClick = (event: MouseEvent) => {
			if (suppressClick.current && event.detail > 0) {
				suppressClick.current = false;
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const preventSelection = (event: Event) => {
			if (candidateRef.current) event.preventDefault();
		};
		const clearScrolledTarget = () => {
			if (store.current.dropTarget) update({ dropTarget: null });
		};
		window.addEventListener("pointerdown", handlePointerDown, true);
		window.addEventListener("pointermove", handlePointerMove, true);
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", cancelPointer);
		window.addEventListener("keydown", handleKey, true);
		window.addEventListener("click", handleClick, true);
		window.addEventListener("selectstart", preventSelection);
		window.addEventListener("blur", reset);
		window.addEventListener("scroll", clearScrolledTarget, true);
		return () => {
			window.removeEventListener("pointerdown", handlePointerDown, true);
			window.removeEventListener("pointermove", handlePointerMove, true);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", cancelPointer);
			window.removeEventListener("keydown", handleKey, true);
			window.removeEventListener("click", handleClick, true);
			window.removeEventListener("selectstart", preventSelection);
			window.removeEventListener("blur", reset);
			window.removeEventListener("scroll", clearScrolledTarget, true);
		};
	}, [reset, update]);

	const contextValue = useMemo<SidebarReorderContextValue>(
		() => ({
			startDrag,
			registerTarget,
			clearTarget,
			getState: () => store.current,
			subscribe: (listener) => {
				listeners.current.add(listener);
				return () => {
					listeners.current.delete(listener);
				};
			},
		}),
		[startDrag, registerTarget, clearTarget],
	);
	return { contextValue, dragging };
}
