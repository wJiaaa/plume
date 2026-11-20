import { readFile, rename, writeFile } from "node:fs/promises";
import type { SideChatEntry } from "./api.ts";

interface BindingDeps {
	file: string;
	parentOf(sideId: string): string | undefined;
	list(parentId: string): Promise<SideChatEntry[]>;
	open(parentId: string): Promise<string>;
	close(sideId: string): Promise<void>;
	missing(): Error;
}

/** 一个标签接着哪段侧边聊天（`side`，还没有、或那段删了时是 null），开在哪个主会话旁边（`parent`）：主会话删掉时连这一条一起删。 */
interface Binding {
	side: string | null;
	parent: string;
}

const isBinding = (value: unknown): value is Binding =>
	!!value &&
	typeof value === "object" &&
	typeof (value as Binding).parent === "string" &&
	((value as Binding).side === null || typeof (value as Binding).side === "string");

/** 标签绑定属于插件，不属于某个 renderer；认领、新建、关闭串行，避免两个窗口抢到同一段。 */
export async function createSideChatBindings(deps: BindingDeps) {
	const stored: unknown = await readFile(deps.file, "utf8").then(
		(body) => JSON.parse(body) as unknown,
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return {};
			throw error;
		},
	);
	if (!stored || typeof stored !== "object" || Array.isArray(stored) || !Object.values(stored).every(isBinding)) throw deps.missing();
	// null 也落盘：空标签恢复后不能认领后来由 /btw 新开的另一段。
	let bound = new Map(Object.entries(stored) as [string, Binding][]);
	const closed = new Set<string>();
	let pending = Promise.resolve();
	const run = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = pending.then(operation);
		pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const save = async (next: Map<string, Binding>): Promise<void> => {
		await writeFile(`${deps.file}.tmp`, JSON.stringify(Object.fromEntries(next)));
		await rename(`${deps.file}.tmp`, deps.file);
		bound = next;
	};
	const resolve = async (tab: string, parentId: string, create?: () => Promise<string>): Promise<string | undefined> => {
		if (closed.has(tab)) throw deps.missing();
		const known = bound.get(tab)?.side;
		if (known) {
			if (deps.parentOf(known) !== parentId) throw deps.missing();
			return known;
		}
		const taken = new Set([...bound.values()].map((binding) => binding.side));
		const free = bound.has(tab) ? undefined : (await deps.list(parentId)).find((entry) => !taken.has(entry.id));
		const id = free?.id ?? (create ? await create() : undefined);
		if (id || !bound.has(tab)) {
			const next = new Map(bound);
			next.set(tab, { side: id ?? null, parent: parentId });
			// 先落盘再交给界面；写失败也不能让新 renderer 误认另一段会话。
			await save(next);
		}
		return id;
	};

	return {
		bind: (tab: string, parentId: string) => run(() => resolve(tab, parentId)),
		open: (tab: string, parentId: string) =>
			run(async () => {
				const id = await resolve(tab, parentId, () => deps.open(parentId));
				if (!id) throw deps.missing();
				return id;
			}),
		close: (tab: string) =>
			run(async () => {
				const id = bound.get(tab)?.side;
				if (id && deps.parentOf(id)) await deps.close(id);
				if (bound.has(tab)) {
					const next = new Map(bound);
					next.delete(tab);
					await save(next);
				}
				// 同一轮关闭后才到达的旧 renderer 请求不能复活资源。
				closed.add(tab);
			}),
		/** 最早开的那段接在哪个标签上：排队条上「在侧边聊天中打开」问的是它。 */
		first: (parentId: string) =>
			run(async () => {
				for (const entry of (await deps.list(parentId)).toReversed()) {
					const tab = [...bound].find(([key, binding]) => binding.side === entry.id && !closed.has(key))?.[0];
					if (tab) return tab;
				}
				return undefined;
			}),
		/**
		 * 一个会话删掉了：是侧边聊天的话，接着它的标签留一条 null（主会话还在，那个标签不能认领别的一段）；
		 * 是主会话的话，开在它旁边的标签连同记录一起删（标签跟着主会话没了）。
		 */
		forget: (sessionId: string) =>
			run(async () => {
				let changed = false;
				const next = new Map<string, Binding>();
				for (const [tab, binding] of bound) {
					if (binding.parent === sessionId) changed = true;
					else if (binding.side === sessionId) {
						changed = true;
						next.set(tab, { ...binding, side: null });
					} else next.set(tab, binding);
				}
				if (changed) await save(next);
			}),
		/** 只留开在这些会话旁边的：删会话时插件没在跑（停用着、删到一半退出）留下的，加载时清掉。 */
		keepOnly: (live: Iterable<string>) =>
			run(async () => {
				const kept = new Set(live);
				const next = new Map([...bound].filter(([, binding]) => kept.has(binding.parent)));
				if (next.size !== bound.size) await save(next);
			}),
	};
}
