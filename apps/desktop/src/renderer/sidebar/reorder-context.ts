import { createContext, useContext, useSyncExternalStore } from "react";

type DragKind = "project" | "session";

export interface DraggingItem {
	kind: DragKind;
	id: string;
	title: string;
	project?: string;
}

export interface DropTarget {
	kind: DragKind;
	id: string;
	placement: "before" | "after";
}

export interface ReorderState {
	dragging: DraggingItem | null;
	dropTarget: DropTarget | null;
	pointer: { x: number; y: number };
}

export interface SidebarReorderContextValue {
	startDrag: (item: DraggingItem, event: React.PointerEvent) => void;
	registerTarget: (kind: DragKind, id: string, rect: DOMRect, clientY: number, project?: string) => void;
	clearTarget: (id: string) => void;
	getState: () => ReorderState;
	subscribe: (listener: () => void) => () => void;
}

export const SidebarReorderContext = createContext<SidebarReorderContextValue | null>(null);

export function useSidebarReorderContext(): SidebarReorderContextValue | null {
	return useContext(SidebarReorderContext);
}

const IDLE: ReorderState = { dragging: null, dropTarget: null, pointer: { x: 0, y: 0 } };
const NO_SUBSCRIPTION = () => () => {};

export function useReorderState<T>(select: (state: ReorderState) => T): T {
	const context = useContext(SidebarReorderContext);
	return useSyncExternalStore(context?.subscribe ?? NO_SUBSCRIPTION, () => select(context ? context.getState() : IDLE));
}
