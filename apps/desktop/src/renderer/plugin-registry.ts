/**
 * 插件界面入口登记的两类表，存取和按插件撤销收在这里，各扩展点的参数校验、报错和日志留在 plugins.tsx 的 `registerXxx` 里：
 * - 槽位（`Slot`）：一个位置，各插件各放一项、全部显示，按 `order` 排；同一 key 再放就换掉前一次。
 * - 接手者（`Handlers`）：按名字认（工具名、`HumanRequest.kind`、语言），同名的 `order` 小的在前，相同时后登记的在前。
 * 两类都从同一个 `createPluginRegistry()` 建出来，插件停用时它的 `removePlugin` 一次撤掉该插件在每张表里登记的；
 * 有自己特殊逻辑的表（面板的快捷键、页面角标、@ 提及……）不在这里，仍由 `unloadPluginUi` 逐个撤。
 * 纯数据，不碰 React、DOM：排序和撤销在测试里直接跑。
 */

/** 接手者的一项。`seq` 是登记先后，order 相同时大的在前。 */
interface Ranked {
	plugin: string;
	order: number;
	seq: number;
}

interface Placed<E> {
	plugin: string;
	key: string;
	order: number;
	value: E;
}

class Slot<E> {
	#placed: Placed<E>[] = [];
	#values: readonly E[] = [];

	/**
	 * 同 key 的先拿掉，新的追加到末尾，再按 order 稳定排序：order 相同的保持放入先后，重放的排到同 order 的最后。
	 * 没给 key 时按插件认（一个插件一项）；没给 order 时是 0，等于只按放入先后。
	 */
	put(plugin: string, value: E, placement: { key?: string; order?: number } = {}): void {
		const key = placement.key ?? plugin;
		const placed = [...this.#placed.filter((each) => each.key !== key), { plugin, key, order: placement.order ?? 0, value }];
		this.#set(placed.sort((a, b) => a.order - b.order));
	}

	has(key: string): boolean {
		return this.#placed.some((each) => each.key === key);
	}

	/** 排好的各项。每次放入、撤销都换成新数组，读的一方可以拿数组本身当依赖。 */
	list(): readonly E[] {
		return this.#values;
	}

	removePlugin(name: string): void {
		this.#set(this.#placed.filter((each) => each.plugin !== name));
	}

	#set(placed: Placed<E>[]): void {
		this.#placed = placed;
		this.#values = placed.map((each) => each.value);
	}
}

class Handlers<E extends Ranked> {
	#byName = new Map<string, E[]>();

	/** 名字 → 排好的接手者，按名字第一次登记的先后迭代。只读：改动走下面的方法。 */
	get table(): ReadonlyMap<string, E[]> {
		return this.#byName;
	}

	get(name: string): E[] | undefined {
		return this.#byName.get(name);
	}

	/** order 小的在前，相同时后登记的在前；前面的渲染出错就让给后面的（plugins.tsx 的 `Chain`）。 */
	register(name: string, entry: E): void {
		this.#byName.set(
			name,
			[...(this.#byName.get(name) ?? []), entry].sort((a, b) => a.order - b.order || b.seq - a.seq),
		);
	}

	/** 整个名字拿掉；之后再登记这个名字排到 `table` 的最后。 */
	delete(name: string): void {
		this.#byName.delete(name);
	}

	removePlugin(name: string): void {
		for (const [key, list] of this.#byName) {
			const kept = list.filter((entry) => entry.plugin !== name);
			if (kept.length > 0) this.#byName.set(key, kept);
			else this.#byName.delete(key);
		}
	}
}

export type { Handlers };

/** 一组表：从这里建出来的槽位和接手者都记在一起，`removePlugin` 一次撤掉一个插件在每张表里的登记。 */
export function createPluginRegistry() {
	const tables: Array<{ removePlugin(name: string): void }> = [];
	return {
		slot<E>(): Slot<E> {
			const table = new Slot<E>();
			tables.push(table);
			return table;
		},
		handlers<E extends Ranked>(): Handlers<E> {
			const table = new Handlers<E>();
			tables.push(table);
			return table;
		},
		removePlugin(name: string): void {
			for (const table of tables) table.removePlugin(name);
		},
	};
}
