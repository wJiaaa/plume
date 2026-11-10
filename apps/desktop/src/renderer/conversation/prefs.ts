/**
 * 转录的显示偏好：画不画推理。只在界面里生效，记在 localStorage 里，和外观偏好一样。
 */

import { useSyncExternalStore } from "react";

export interface TranscriptPrefs {
	/** 推理默认不画，见 `withoutThinking`。 */
	showThinking: boolean;
}

const KEY = "plume.transcript";
const listeners = new Set<() => void>();
let current = read();

function read(): TranscriptPrefs {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<TranscriptPrefs>;
		return { showThinking: raw.showThinking === true };
	} catch {
		return { showThinking: false };
	}
}

export function setTranscriptPrefs(patch: Partial<TranscriptPrefs>): void {
	current = { ...current, ...patch };
	localStorage.setItem(KEY, JSON.stringify(current));
	for (const listener of listeners) listener();
}

export function useTranscriptPrefs(): TranscriptPrefs {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
}
