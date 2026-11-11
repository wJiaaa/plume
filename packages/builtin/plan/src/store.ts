/**
 * 哪些会话开着计划模式，存在插件数据目录的 `state.json`，重启后还在。
 *
 * 开关按会话记，不做成第四档权限：「计划中 + 完全访问」是成立的组合（看的时候不用每次点头，批准后也不用），
 * 权限是全局的，一个对话进计划模式不该让别的窗口跟着进去。新对话还没有会话可记，开关先记在 `draft`（不落盘），
 * 第一句话建出会话时交给它：不能建完再补，第一轮是照常跑的。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallContext } from "@plume/contract";
import type { PlanState } from "./api.ts";

export class PlanStore {
	private readonly on = new Set<string>();
	private draft = false;
	private readonly listeners = new Set<() => void>();
	private saving: Promise<void> = Promise.resolve();
	private readonly file: string;
	private readonly warn: (message: string) => void;

	private constructor(file: string, warn: (message: string) => void) {
		this.file = file;
		this.warn = warn;
	}

	static async open(dataDir: string, warn: (message: string) => void): Promise<PlanStore> {
		const store = new PlanStore(join(dataDir, "state.json"), warn);
		const saved = await readFile(store.file, "utf8").then(
			(text) => JSON.parse(text) as { sessions?: unknown },
			() => ({ sessions: [] }),
		);
		if (Array.isArray(saved.sessions)) for (const id of saved.sessions) if (typeof id === "string") store.on.add(id);
		return store;
	}

	has(sessionId: string): boolean {
		return this.on.has(sessionId);
	}

	/** 有没有哪个会话开着：都没开时不用为子会话去查父会话。 */
	get any(): boolean {
		return this.on.size > 0;
	}

	get drafted(): boolean {
		return this.draft;
	}

	/** `sessionId` 为 null 时拨新对话的开关。 */
	set(sessionId: string | null, on: boolean): void {
		if (sessionId === null) {
			if (this.draft === on) return;
			this.draft = on;
		} else {
			if (this.on.has(sessionId) === on) return;
			if (on) this.on.add(sessionId);
			else this.on.delete(sessionId);
			this.save();
		}
		for (const listener of this.listeners) listener();
	}

	/** 新对话的开关交给第一句话建出来的会话。 */
	takeDraft(sessionId: string): void {
		if (!this.draft) return;
		this.draft = false;
		this.set(sessionId, true);
	}

	forget(sessionId: string): void {
		this.set(sessionId, false);
	}

	snapshot(): PlanState {
		return { sessions: [...this.on], draft: this.draft };
	}

	async *watch(call: CallContext): AsyncGenerator<PlanState, void> {
		let dirty = true;
		let wake: (() => void) | undefined;
		const changed = () => {
			dirty = true;
			wake?.();
		};
		this.listeners.add(changed);
		call.signal.addEventListener("abort", changed, { once: true });
		try {
			while (!call.signal.aborted) {
				if (!dirty) await new Promise<void>((resolve) => (wake = resolve));
				wake = undefined;
				if (call.signal.aborted) break;
				dirty = false;
				yield this.snapshot();
			}
		} finally {
			this.listeners.delete(changed);
			call.signal.removeEventListener("abort", changed);
		}
	}

	private save(): void {
		const body = JSON.stringify({ sessions: [...this.on] });
		this.saving = this.saving
			.then(async () => {
				await writeFile(`${this.file}.tmp`, body);
				await rename(`${this.file}.tmp`, this.file);
			})
			// i18n-exempt：插件数据写入失败的日志。
			.catch((error: unknown) => this.warn(`计划模式的开关没存上：${String(error)}`));
	}
}
