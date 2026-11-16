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
import { text } from "./i18n.ts";
import type { JsonFiles } from "./json-files.ts";

interface Source {
	/** 现在的值；还在读（`sessionStore` 的 `load`）时是 undefined，读完叫醒订阅者。 */
	read(sessionId: string): { value: unknown } | undefined;
	/** 按会话的来源：会话删掉时丢掉它那份。 */
	forget?(sessionId: string): void;
	/** 按会话的来源：这个会话最后一个订阅者走了。 */
	release?(sessionId: string): void;
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
				const current = source && watch.version !== seen ? source.read(id) : undefined;
				if (!current) {
					await new Promise<void>((resolve) => (wake = resolve));
					wake = undefined;
					continue;
				}
				seen = watch.version;
				yield current.value;
			}
		} finally {
			watch.wakers.delete(waker);
			signal.removeEventListener("abort", waker);
			if (watch.wakers.size === 0) {
				watches.delete(id);
				this.sources.get(base)?.release?.(id);
			}
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
		this.declare(plugin, base, { read: () => ({ value }) }, own);
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
		this.declare(plugin, base, { read: () => ({ value }) }, own);
		const set = (next: T) => {
			value = next;
			this.changed(base);
		};
		return { get: () => value, set, update: (change) => set(change(value)) };
	}

	createSessionStore<T>(
		plugin: string,
		key: string,
		initial: T,
		load: ((sessionId: string) => Promise<T>) | undefined,
		own: Own,
		log: (message: string) => void,
	): PluginSessionStore<T> {
		const base = baseOf(plugin, "session", checkedKey(key));
		if (load !== undefined && typeof load !== "function") throw new Error(text("plugin.listenerNotFunction"));
		const values = new Map<string, T>();
		/** 正在读的会话；读完前又被 `set` 过的，读到的旧值不要。 */
		const loading = new Set<string>();
		/**
		 * 值是 `load` 读回来的会话（插件没 `set` 过）：没人看着时丢掉，下次订阅再读，不然翻过的会话一个个都留在内存里。
		 * 插件 `set` 的不丢：它不一定读得回来。
		 */
		const loaded = new Set<string>();
		const watched = (sessionId: string) => this.watches.get(base)?.has(sessionId) === true;
		const release = (sessionId: string) => {
			if (!loaded.delete(sessionId)) return;
			values.delete(sessionId);
		};
		const get = (sessionId: string) => (values.has(sessionId) ? (values.get(sessionId) as T) : initial);
		const read = (sessionId: string): { value: unknown } | undefined => {
			if (values.has(sessionId) || !load) return { value: get(sessionId) };
			if (!loading.has(sessionId)) {
				loading.add(sessionId);
				void Promise.resolve()
					.then(() => load(sessionId))
					.then(
						(value) => {
							if (!values.has(sessionId)) {
								values.set(sessionId, value);
								loaded.add(sessionId);
							}
						},
						(error: unknown) => {
							log(text("plugin.storeLoad", { key, error: errorText(error) }));
							if (!values.has(sessionId)) {
								values.set(sessionId, initial);
								loaded.add(sessionId);
							}
						},
					)
					.finally(() => {
						loading.delete(sessionId);
						// 读的时候订阅者已经走了：没人要这份，不留。
						if (watched(sessionId)) this.changed(base, sessionId);
						else release(sessionId);
					});
			}
			return undefined;
		};
		const forget = (sessionId: string) => {
			loaded.delete(sessionId);
			if (!values.delete(sessionId)) return;
			this.changed(base, sessionId);
		};
		this.declare(plugin, base, { read, forget, release }, own);
		const set = (sessionId: string, value: T) => {
			values.set(String(sessionId), value);
			loaded.delete(String(sessionId));
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
