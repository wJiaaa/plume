/**
 * 插件登记给界面入口看的值：设置（`ctx.settings`，存盘）、运行状态（`ctx.store`）、按会话的运行状态（`ctx.sessionStore`）。
 * 界面经 `AgentService.watchPluginValue` 订阅，经 `setPluginSettings` 改设置。
 *
 * 来源和订阅分开记：界面入口可能比逻辑入口先起来，插件重新加载时也有一段没登记的空当。订阅者挂在「插件 + 种类 + 键 + 会话」上，
 * 来源没登记时等着，登记了（或重新登记了）就推当前值；插件停用时来源撤下，订阅者留着等下一次登记。
 *
 * 只推最新的那份：订阅者来不及取的中间值跳过，界面画的总是当前状态，不是一串事件。
 */

import type { PluginSessionStore, PluginSettings, PluginStore, PluginValueKind } from "@plume/contract";
import { errorText } from "@plume/loop";
import { text } from "./i18n.ts";
import type { JsonFiles } from "./json-files.ts";

interface Source {
	/** 现在的值。 */
	read(sessionId: string): unknown;
	/** 按会话的来源：会话删掉时丢掉它那份。 */
	forget?(sessionId: string): void;
}

interface Watch {
	/** 每次值变了加一，订阅者按它判断有没有新值。 */
	version: number;
	wakers: Set<() => void>;
}

/** 插件撤下时要做的清理（宿主的 `own`）。 */
type Own = (dispose: () => void) => void;

const baseOf = (plugin: string, kind: PluginValueKind, key: string) => JSON.stringify([plugin, kind, key]);

export class PluginValues {
	private readonly sources = new Map<string, Source>();
	/** 来源 → 会话 id（不分会话的是 ""）→ 订阅。 */
	private readonly watches = new Map<string, Map<string, Watch>>();
	/** 插件名 → 改设置的入口（`setPluginSettings` 找它）。 */
	private readonly settings = new Map<string, (patch: Record<string, unknown>) => Promise<unknown>>();

	constructor(private readonly files: JsonFiles) {}

	/** 值变了：叫醒订阅者。不给 `sessionId` 时叫醒这个来源下的全部（登记、撤下）。 */
	private changed(base: string, sessionId?: string): void {
		const watches = this.watches.get(base);
		if (!watches) return;
		for (const [id, watch] of watches) {
			if (sessionId !== undefined && id !== sessionId) continue;
			watch.version++;
			for (const wake of [...watch.wakers]) wake();
		}
	}

	private declare(plugin: string, base: string, source: Source, own: Own): void {
		if (this.sources.has(base)) throw new Error(text("plugin.valueTaken", { plugin }));
		this.sources.set(base, source);
		this.changed(base);
		own(() => {
			if (this.sources.get(base) !== source) return;
			this.sources.delete(base);
			this.changed(base);
		});
	}

	async *watch(plugin: string, kind: PluginValueKind, key: string, sessionId: string | undefined, signal: AbortSignal): AsyncGenerator<unknown, void> {
		if (kind !== "settings" && kind !== "store" && kind !== "session") throw new Error(text("plugin.valueKind", { kind: String(kind) }));
		if (kind === "session" && (typeof sessionId !== "string" || sessionId === "")) throw new Error(text("plugin.valueSession"));
		const base = baseOf(String(plugin), kind, kind === "settings" ? "" : String(key));
		const id = kind === "session" ? String(sessionId) : "";
		let watches = this.watches.get(base);
		if (!watches) this.watches.set(base, (watches = new Map()));
		let watch = watches.get(id);
		if (!watch) watches.set(id, (watch = { version: 0, wakers: new Set() }));
		let wake: (() => void) | undefined;
		const waker = () => wake?.();
		watch.wakers.add(waker);
		signal.addEventListener("abort", waker);
		let seen = -1;
		try {
			while (!signal.aborted) {
				const source = this.sources.get(base);
				if (!source || watch.version === seen) {
					await new Promise<void>((resolve) => (wake = resolve));
					wake = undefined;
					continue;
				}
				seen = watch.version;
				yield source.read(id);
			}
		} finally {
			watch.wakers.delete(waker);
			signal.removeEventListener("abort", waker);
			if (watch.wakers.size === 0) watches.delete(id);
			if (watches.size === 0) this.watches.delete(base);
		}
	}

	async setSettings(plugin: string, patch: unknown): Promise<unknown> {
		const set = this.settings.get(String(plugin));
		if (!set) throw new Error(text("plugin.noSettings", { plugin: String(plugin) }));
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error(text("plugin.settingsPatch"));
		return set(patch as Record<string, unknown>);
	}

	/** 会话删掉了：每个按会话的来源丢掉它那份。 */
	forgetSession(sessionId: string): void {
		for (const source of this.sources.values()) source.forget?.(sessionId);
	}

	async createSettings<T extends object>(
		plugin: string,
		file: string,
		defaults: T,
		normalize: ((saved: Record<string, unknown>) => T) | undefined,
		own: Own,
		log: (message: string) => void,
	): Promise<PluginSettings<T>> {
		if (!isRecord(defaults)) throw new Error(text("plugin.settingsDefaults"));
		if (normalize !== undefined && typeof normalize !== "function") throw new Error(text("plugin.settingsNormalize"));
		const base = baseOf(plugin, "settings", "");
		if (this.sources.has(base)) throw new Error(text("plugin.settingsTwice", { plugin }));
		const allowed = new Set(Object.keys(defaults));
		const shape = (merged: Record<string, unknown>): T =>
			normalize ? normalize(merged) : (Object.fromEntries(Object.entries(merged).filter(([name]) => allowed.has(name))) as T);
		let value: T;
		try {
			const saved = await this.files.read<unknown>(file);
			value = shape({ ...defaults, ...(isRecord(saved) ? saved : {}) });
		} catch (error) {
			// 文件坏了、校验不过：用缺省值接着跑，下一次改的时候整份重写。
			log(text("plugin.settingsUnreadable", { file, error: errorText(error) }));
			value = shape({ ...defaults });
		}
		const listeners = new Set<(value: T) => void>();
		let alive = true;
		let queue: Promise<unknown> = Promise.resolve();
		const set = (patch: Record<string, unknown>): Promise<T> => {
			const next = queue.then(async () => {
				if (!alive) throw new Error(text("plugin.disposed", { name: plugin }));
				// 轮到时才和当时的值合并：连着改两项，后一次看得到前一次的结果。
				const changed = shape({ ...value, ...patch });
				await this.files.write(file, changed);
				value = changed;
				this.changed(base);
				for (const listener of [...listeners]) {
					try {
						listener(value);
					} catch (error) {
						log(text("plugin.settingsListener", { error: errorText(error) }));
					}
				}
				return value;
			});
			queue = next.catch(() => undefined);
			return next;
		};
		this.declare(plugin, base, { read: () => value }, own);
		this.settings.set(plugin, set);
		own(() => {
			alive = false;
			listeners.clear();
			if (this.settings.get(plugin) === set) this.settings.delete(plugin);
		});
		return {
			get: () => value,
			set: (patch) => set(patch as Record<string, unknown>),
			onChange: (listener) => {
				if (typeof listener !== "function") throw new Error(text("plugin.listenerNotFunction"));
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
	}

	createStore<T>(plugin: string, key: string, initial: T, own: Own): PluginStore<T> {
		const base = baseOf(plugin, "store", checkedKey(key));
		let value = initial;
		this.declare(plugin, base, { read: () => value }, own);
		const set = (next: T) => {
			value = next;
			this.changed(base);
		};
		return { get: () => value, set, update: (change) => set(change(value)) };
	}

	createSessionStore<T>(plugin: string, key: string, initial: T, own: Own): PluginSessionStore<T> {
		const base = baseOf(plugin, "session", checkedKey(key));
		const values = new Map<string, T>();
		const get = (sessionId: string) => (values.has(sessionId) ? (values.get(sessionId) as T) : initial);
		const forget = (sessionId: string) => {
			if (!values.delete(sessionId)) return;
			this.changed(base, sessionId);
		};
		this.declare(plugin, base, { read: get, forget }, own);
		const set = (sessionId: string, value: T) => {
			values.set(String(sessionId), value);
			this.changed(base, String(sessionId));
		};
		return {
			get: (sessionId) => get(String(sessionId)),
			set,
			update: (sessionId, change) => set(sessionId, change(get(String(sessionId)))),
			delete: (sessionId) => forget(String(sessionId)),
		};
	}
}

function checkedKey(key: unknown): string {
	if (typeof key !== "string" || key === "") throw new Error(text("plugin.valueKey"));
	return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
