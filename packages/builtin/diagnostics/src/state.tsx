import type { Remote, UiContext } from "@plume/contract/ui";
import { useEffect, useSyncExternalStore } from "react";
import type { DiagnosticsApi, DiagnosticSnapshot, TraceObservation } from "./api.ts";

export interface Snapshot extends DiagnosticSnapshot {
	/** 轨迹还没读过时是空串。 */
	version: string;
	observations: TraceObservation[];
	prompts: Record<string, string>;
	error?: string;
	loading: boolean;
}
const EMPTY: Snapshot = { version: "", observations: [], prompts: {}, jobs: [], children: [], wakeups: [], loading: true };
export type Selection = { job?: string; call?: string; child?: string; file?: Awaited<ReturnType<DiagnosticsApi["fullOutput"]>> };
const NONE: Selection = {};

export function createState(api: Remote<DiagnosticsApi>, ui: UiContext) {
	const snapshots = new Map<string, Snapshot>();
	const selections = new Map<string, Selection>();
	const listeners = new Set<() => void>();
	const watching = new Map<string, number>();
	/** 要画端口的几处：端口要问系统，只在有人画得出来时查（任务面板、开着的环境卡片），标题栏按钮那份计数不要。 */
	const ports = new Map<string, number>();
	/** 要轨迹的几处（轨迹、任务面板）：观察记录只给它们读，标题栏按钮和环境卡片只看任务和唤醒，不每两秒拉一遍。 */
	const traces = new Map<string, number>();
	const pending = new Set<string>();
	let disposed = false;
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const refresh = async (id: string) => {
		if (disposed || pending.has(id) || document.hidden) return;
		pending.add(id);
		try {
			const previous = snapshots.get(id) ?? EMPTY;
			const next = await api.read(id, (traces.get(id) ?? 0) > 0 ? previous.version : null, (ports.get(id) ?? 0) > 0);
			const version = next.version ?? previous.version;
			if (!disposed && watching.has(id))
				snapshots.set(id, {
					...next,
					version,
					observations: next.observations ?? previous.observations,
					prompts: next.prompts ?? previous.prompts,
					// 读的时候还没人要轨迹、读完时有了：轨迹还没到，仍算加载中。
					loading: !version && (traces.get(id) ?? 0) > 0,
				});
		} catch (error) {
			if (!disposed) snapshots.set(id, { ...(snapshots.get(id) ?? EMPTY), loading: false, error: String(error) });
		} finally {
			pending.delete(id);
			if (!disposed) emit();
		}
	};
	const refreshVisible = () => {
		for (const id of watching.keys()) void refresh(id);
	};
	const timer = setInterval(refreshVisible, 2000);
	window.addEventListener("focus", refreshVisible);
	document.addEventListener("visibilitychange", refreshVisible);
	ui.effect(() => {
		disposed = true;
		clearInterval(timer);
		window.removeEventListener("focus", refreshVisible);
		document.removeEventListener("visibilitychange", refreshVisible);
		listeners.clear();
		snapshots.clear();
	});
	return {
		refresh,
		select(id: string, selection: Selection) {
			selections.set(id, { ...selections.get(id), ...selection });
			emit();
		},
		useSelection(id: string) {
			return useSyncExternalStore(subscribe, () => selections.get(id) ?? NONE);
		},
		useSnapshot(id: string, shown: boolean, withPorts = false, withTrace = false) {
			useEffect(() => {
				if (!shown) return;
				watching.set(id, (watching.get(id) ?? 0) + 1);
				if (withPorts) ports.set(id, (ports.get(id) ?? 0) + 1);
				if (withTrace) {
					traces.set(id, (traces.get(id) ?? 0) + 1);
					// 别处已经读过任务、还没读过轨迹：读到之前算加载中，不先画成「还没有运行记录」。
					const current = snapshots.get(id);
					if (current && !current.version) {
						snapshots.set(id, { ...current, loading: true });
						emit();
					}
				}
				void refresh(id);
				return () => {
					if (withPorts) {
						const left = (ports.get(id) ?? 1) - 1;
						if (left) ports.set(id, left);
						else ports.delete(id);
					}
					if (withTrace) {
						const left = (traces.get(id) ?? 1) - 1;
						if (left) traces.set(id, left);
						else traces.delete(id);
					}
					const remaining = (watching.get(id) ?? 1) - 1;
					if (remaining) watching.set(id, remaining);
					else {
						watching.delete(id);
						snapshots.delete(id);
					}
				};
			}, [id, shown, withPorts, withTrace]);
			return useSyncExternalStore(subscribe, () => snapshots.get(id) ?? EMPTY);
		},
	};
}
type DiagnosticState = ReturnType<typeof createState>;
export interface Runtime {
	ui: UiContext;
	api: Remote<DiagnosticsApi>;
	state: DiagnosticState;
	openTrace(sessionId: string, call?: string): void;
	openJob(sessionId: string, job: string): void;
	openOutput(sessionId: string, callId: string): void;
}
