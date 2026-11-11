import type { Remote } from "@plume/contract/ui";
import { assignAvatars, formatAvatar } from "@plume/ui";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { BUILTIN_AGENTS } from "./agents.ts";
import type { SubagentsApi } from "./api.ts";
import type { Face, TaskRecord } from "./types.ts";

type Snapshot = { tasks: TaskRecord[]; ready: boolean; error?: string };
type Roster = { snapshot: Snapshot; listeners: Set<() => void>; cancel?: () => void };
const EMPTY: Snapshot = { tasks: [], ready: false };
const rosters = new Map<string, Roster>();
const choices = new Map<string, string>();
const choiceListeners = new Set<() => void>();
let api: Remote<SubagentsApi>;

export function connect(remote: Remote<SubagentsApi>): void {
	api = remote;
}

function roster(parent: string): Roster {
	let state = rosters.get(parent);
	if (!state) {
		state = { snapshot: EMPTY, listeners: new Set() };
		rosters.set(parent, state);
	}
	return state;
}

function watch(parent: string, state: Roster): void {
	const stream = api.watch(parent);
	let alive = true;
	state.cancel = () => {
		alive = false;
		stream.cancel();
		state.cancel = undefined;
	};
	void (async () => {
		try {
			for await (const tasks of stream) {
				if (!alive) break;
				state.snapshot = { tasks, ready: true };
				for (const listener of state.listeners) listener();
			}
		} catch (error) {
			if (!alive) return;
			state.snapshot = { ...state.snapshot, ready: true, error: error instanceof Error ? error.message : String(error) };
			for (const listener of state.listeners) listener();
		}
	})();
}

export function useRoster(parent: string | undefined): Snapshot {
	const subscribe = useCallback(
		(listener: () => void) => {
			if (!parent) return () => {};
			const state = roster(parent);
			state.listeners.add(listener);
			if (!state.cancel) watch(parent, state);
			return () => {
				state.listeners.delete(listener);
				if (!state.listeners.size) state.cancel?.();
			};
		},
		[parent],
	);
	const snapshot = useCallback(() => (parent ? roster(parent).snapshot : EMPTY), [parent]);
	return useSyncExternalStore(subscribe, snapshot);
}

export function retryRoster(parent: string): void {
	const state = roster(parent);
	state.cancel?.();
	watch(parent, state);
}

export type Avatars = ReturnType<typeof assignAvatars>;

/** 还没读到名单时先按内置的排：内置的几个脸是写死的，读到以后不会换。 */
const BUILTIN_FACES: Avatars = assignAvatars(BUILTIN_AGENTS);
const faces = new Map<string, Avatars>();
const asked = new Set<string>();
const faceListeners = new Set<() => void>();

function loadFaces(parent: string): void {
	asked.add(parent);
	void api.faces(parent).then(
		(list: Face[]) => {
			faces.set(parent, assignAvatars(list));
			for (const listener of faceListeners) listener();
		},
		() => asked.delete(parent),
	);
}

/** 设置页存了、删了定义以后，各会话的名单重新读。 */
export function refreshFaces(): void {
	for (const parent of [...asked]) loadFaces(parent);
}

/** 这个父会话的名单里每个名字的脸；名单外的名字（删掉的定义）由 `avatarOf` 另算。 */
export function useAvatars(parent: string | undefined): Avatars {
	useEffect(() => {
		if (parent && !asked.has(parent)) loadFaces(parent);
	}, [parent]);
	return useSyncExternalStore(
		(listener) => {
			faceListeners.add(listener);
			return () => {
				faceListeners.delete(listener);
			};
		},
		() => (parent && faces.get(parent)) || BUILTIN_FACES,
	);
}

export function avatarOf(avatars: Avatars, name: string) {
	return avatars.get(name) ?? assignAvatars([...[...avatars].map(([known, face]) => ({ name: known, avatar: formatAvatar(face) })), { name }]).get(name)!;
}

export function choose(parent: string, session: string): void {
	choices.set(parent, session);
	for (const listener of choiceListeners) listener();
}

export function useChosen(parent: string | undefined): string | undefined {
	return useSyncExternalStore(
		(listener) => {
			choiceListeners.add(listener);
			return () => {
				choiceListeners.delete(listener);
			};
		},
		() => (parent ? choices.get(parent) : undefined),
	);
}
