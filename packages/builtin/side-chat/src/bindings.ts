import { readFile, rename, writeFile } from "node:fs/promises";
import type { SessionChoice } from "@plume/contract/ui";
import type { SideChatEntry } from "./api.ts";

interface BindingDeps {
	file: string;
	parentOf(sideId: string): string | undefined;
	list(parentId: string): Promise<SideChatEntry[]>;
	open(parentId: string, choice?: SessionChoice): Promise<string>;
	close(sideId: string): Promise<void>;
	missing(): Error;
}

/** 标签绑定属于插件，不属于某个 renderer；认领、新建、关闭串行，避免两个窗口抢到同一段。 */
export async function createSideChatBindings(deps: BindingDeps) {
	const stored: unknown = await readFile(deps.file, "utf8").then(
		(body) => JSON.parse(body) as unknown,
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return {};
			throw error;
		},
	);
	if (!stored || typeof stored !== "object" || Array.isArray(stored) || Object.values(stored).some((id) => id !== null && typeof id !== "string"))
		throw deps.missing();
	// null 也落盘：空标签恢复后不能认领后来由 /btw 新开的另一段。
	let bound = new Map(Object.entries(stored) as [string, string | null][]);
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
	const save = async (next: Map<string, string | null>): Promise<void> => {
		await writeFile(`${deps.file}.tmp`, JSON.stringify(Object.fromEntries(next)));
		await rename(`${deps.file}.tmp`, deps.file);
		bound = next;
	};
	const resolve = async (tab: string, parentId: string, create?: () => Promise<string>): Promise<string | undefined> => {
		if (closed.has(tab)) throw deps.missing();
		const known = bound.get(tab);
		if (known) {
			if (deps.parentOf(known) !== parentId) throw deps.missing();
			return known;
		}
		const taken = new Set(bound.values());
		const free = bound.has(tab) ? undefined : (await deps.list(parentId)).find((entry) => !taken.has(entry.id));
		const id = free?.id ?? (create ? await create() : undefined);
		if (id || !bound.has(tab)) {
			const next = new Map(bound);
			next.set(tab, id ?? null);
			// 先落盘再交给界面；写失败也不能让新 renderer 误认另一段会话。
			await save(next);
		}
		return id;
	};

	return {
		bind: (tab: string, parentId: string) => run(() => resolve(tab, parentId)),
		open: (tab: string, parentId: string, choice?: SessionChoice) =>
			run(async () => {
				const id = await resolve(tab, parentId, () => deps.open(parentId, choice));
				if (!id) throw deps.missing();
				return id;
			}),
		close: (tab: string) =>
			run(async () => {
				const id = bound.get(tab);
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
					const tab = [...bound].find(([key, id]) => id === entry.id && !closed.has(key))?.[0];
					if (tab) return tab;
				}
				return undefined;
			}),
		forget: (sideId: string) =>
			run(async () => {
				const next = new Map(bound);
				for (const [tab, id] of bound) if (id === sideId) next.set(tab, null);
				if ([...bound.values()].includes(sideId)) await save(next);
			}),
	};
}
