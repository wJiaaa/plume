/**
 * 回复里的一条路径在会话里对应的文件：相对路径在工作目录里找（怎么找见 agent 的 `locateSessionFiles`），
 * 绝对路径看这台机器上有没有。
 *
 * 不替人挑：两个 `tool-run.ts` 时挑哪个都是猜，猜错了点开的是另一份代码，比读不到更糟。拿到全部候选，
 * 同名的多份让人自己选（见 `FileChoices`）。
 *
 * **结论记下来，下次一挂上就是对的。** 链接画成文件签还是字，要等这个结论；挂上时没有结论就先是字，
 * 找到了再换成签，字会跳一下——重启后打开旧会话，整段回复里的链接一起跳。所以找过的结论（找到了哪些，
 * 或者哪里都没有）按会话记在 localStorage 里，挂上时先照它画，再在后台核对，磁盘真变了才改。
 *
 * 核对的时机：找到过的，每个窗口核对一次；没找到的，过了 `MISS_TTL` 再挂上就再找——可能只是文件
 * 还没写出来（回复里先提、随后才建）。
 */

import { useEffect, useSyncExternalStore } from "react";

import { locateFiles } from "../files/open-file.ts";

type Paths = readonly string[];

const STORAGE_KEY = "plume.located-paths";
/** 最多记这么多条，多了丢最久没核对过的：丢了只是那条链接下次挂上要先等一下。 */
const LIMIT = 2000;
/** 攒一阵再写：打开一段长对话时几十条链接一起核对完。 */
const SAVE_DELAY = 1000;
const MISS_TTL = 5_000;
/**
 * 正在输出的回复最多为一条还没结论的路径停多久，见 `awaitingPaths`。
 *
 * 多数链接在屏幕放到它之前就找完了（屏幕落后模型几十到几百毫秒）。几十万个文件的仓库列一遍要更久，
 * 不能让后面整段字跟着卡住：停够了先放成字，找到了再换成签。
 */
const HOLD = 300;

const known = load();
/** 这个窗口里哪条什么时候问完的。问不到的也记，免得一帧问一遍。 */
const checked = new Map<string, number>();
/** 正在问的，什么时候开始问的。 */
const asking = new Map<string, number>();
const unsaved = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let saveTimer = 0;

const keyOf = (sessionId: string, written: string) => `${sessionId}\0${written}`;

function load(): Map<string, Paths> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		if (Array.isArray(value)) return new Map(value.filter(isEntry));
	} catch {
		/* 坏了的记录当作没记：只是这次挂上时没有现成的结论。 */
	}
	return new Map();
}

function isEntry(entry: unknown): entry is [string, string[]] {
	return (
		Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && Array.isArray(entry[1]) && entry[1].every((path) => typeof path === "string")
	);
}

function save(): void {
	saveTimer = 0;
	// 独立的会话窗也在记：读回别的窗口写下的再合上自己的，不然后写的窗口把先写的整份盖掉。
	const stored = load();
	for (const key of unsaved) {
		stored.delete(key);
		const paths = known.get(key);
		if (paths) stored.set(key, paths);
	}
	unsaved.clear();
	for (const key of stored.keys()) {
		if (stored.size <= LIMIT) break;
		stored.delete(key);
	}
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...stored]));
	} catch {
		/* 存满了：下次挂上照旧去找。 */
	}
}

function changed(): void {
	version++;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function settle(key: string, paths: Paths): void {
	const before = known.get(key);
	const same = before?.length === paths.length && before.every((path, index) => path === paths[index]);
	// 没变就留着原来那份：读它的组件按引用比，换一份一样的也会重画。
	known.set(key, same ? before : paths);
	unsaved.add(key);
	saveTimer ||= window.setTimeout(save, SAVE_DELAY);
}

/** 该问就问：没问过，或者上次没找到、已经过了 `MISS_TTL`。 */
function refresh(sessionId: string, written: string): void {
	const key = keyOf(sessionId, written);
	if (asking.has(key)) return;
	const at = checked.get(key);
	if (at !== undefined && (known.get(key)?.length || Date.now() - at < MISS_TTL)) return;
	asking.set(key, performance.now());
	// 到点叫醒为它停着的回复，见 `awaitingPaths`。
	window.setTimeout(changed, HOLD);
	void locateFiles(sessionId, written).then((paths) => {
		asking.delete(key);
		checked.set(key, Date.now());
		// 问不到（agent 进程不在、调用失败）不是没有：不改结论。
		if (paths) settle(key, paths);
		changed();
	});
}

/**
 * `written` 在这个会话里对得上的全部文件（绝对路径），文件夹带着结尾的分隔符。
 *
 * null 是还没有结论（或 `sessionId`、`written` 为 null，不用找）；空数组是找过了、哪里都没有。
 * 有记下的结论就先给它，后台核对完变了再换。
 */
export function useLocatedPaths(sessionId: string | null, written: string | null): Paths | null {
	const key = sessionId && written ? keyOf(sessionId, written) : null;
	const paths = useSyncExternalStore(subscribe, () => (key ? (known.get(key) ?? null) : null));
	useEffect(() => {
		if (sessionId && written) refresh(sessionId, written);
	}, [sessionId, written]);
	return paths;
}

/**
 * 正在输出的回复要不要先停在这条路径前面：还没有结论、正在找、找了不到 `HOLD`。没开始找的这时开始找。
 * 停在哪由 `stream-tail.ts` 定；停着的回复用 `useLocatedVersion` 等结论。
 */
export function awaitingPaths(sessionId: string, written: string): boolean {
	const key = keyOf(sessionId, written);
	if (known.has(key)) return false;
	refresh(sessionId, written);
	const since = asking.get(key);
	return since !== undefined && performance.now() - since < HOLD;
}

/** 有了新结论、或者有一条停够了 `HOLD` 时变。`on` 为假时恒为 0，不跟着重画。 */
export function useLocatedVersion(on: boolean): number {
	return useSyncExternalStore(subscribe, () => (on ? version : 0));
}
