/**
 * 每个文件标签看着哪个文件，以及怎么读（换不换行、Markdown 看不看源码）。
 *
 * 一个文件一个标签，各看各的，按标签 id 记。只在内存里：和面板区的标签一样，重开应用就没了。
 * 读文件经 agent 进程（`AgentService.readFile`），它只认会话工作目录里的路径。
 */

import type { AgentService, FileContents, FileEntry } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { useSyncExternalStore } from "react";

/** 一个链接指着的那几行，从 1 数起，`from <= to`。 */
export interface LineRange {
	from: number;
	to: number;
}

export interface OpenFile {
	path: string | null;
	/** 读它的那个会话。图片、PDF、音视频按会话的工作目录发（见 `mediaUrl`），和读文件是同一道边界。 */
	sessionId: string | null;
	/** 文件自己的名字，内容到之前标签就能先写上。 */
	name: string | null;
	contents: FileContents | null;
	/**
	 * 正在读、还没换上来的那个文件。
	 *
	 * 和屏幕上的文件分开记：换文件时内容区先留着旧的，新的读到了 `path` 和 `contents` 一起换，
	 * 不会有一刻是这个文件的名字配着那个文件的内容，也不会为几毫秒的读取闪一下「读取中」。
	 */
	opening: string | null;
	loading: boolean;
	/**
	 * 打开时要滚到、要亮一下的那几行——回复里 `a.ts:42` 那种链接带来的。
	 *
	 * `at` 每次打开都换一个：同一个文件同一行再点一次，也要再跳一次，而对象内容一样时看不出这是新的一次。
	 */
	reveal: (LineRange & { at: number }) | null;
}

const EMPTY: OpenFile = { path: null, sessionId: null, name: null, contents: null, opening: null, loading: false, reveal: null };

interface State {
	files: Record<string, OpenFile>;
	/**
	 * 换行、看 Markdown 源码。不按文件记：它们是**你**想怎么读，不是被读的东西的属性，
	 * 每换一个文件都要重设一遍就成了设置每次都在请示。
	 */
	wrap: boolean;
	showSource: boolean;
}

let state: State = { files: {}, wrap: false, showSource: false };
const listeners = new Set<() => void>();
let agent: Remote<AgentService> | null = null;
let reveals = 0;

function set(next: Partial<State>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

function patch(tab: string, next: Partial<OpenFile>): void {
	set({ files: { ...state.files, [tab]: { ...fileOf(tab), ...next } } });
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function fileOf(tab: string): OpenFile {
	return state.files[tab] ?? EMPTY;
}

/** 启动时交过来的 agent 服务，读文件、找文件都经它。 */
export function connectFiles(service: Remote<AgentService>): void {
	agent = service;
}

export function useOpenFile<T>(tab: string, pick: (file: OpenFile) => T): T {
	return useSyncExternalStore(subscribe, () => pick(fileOf(tab)));
}

export function useReading(): { wrap: boolean; showSource: boolean } {
	const wrap = useSyncExternalStore(subscribe, () => state.wrap);
	const showSource = useSyncExternalStore(subscribe, () => state.showSource);
	return { wrap, showSource };
}

export function setWrap(wrap: boolean): void {
	set({ wrap });
}

export function setShowSource(showSource: boolean): void {
	set({ showSource });
}

/** 这个标签现在看着（或正要看）的文件。 */
export function shownPath(tab: string): string | null {
	const file = fileOf(tab);
	return file.opening ?? file.path;
}

/**
 * 把这个文件读进这个标签，替换它原来看着的。
 *
 * 读不到返回 false，标签保留原来的内容，由调用方说一声。给了 `lines` 时 Markdown 也以源码打开：
 * 渲染出来的页面上没有行。
 */
export async function openFileIn(tab: string, sessionId: string, path: string, lines?: LineRange | null): Promise<boolean> {
	if (!agent) return false;
	patch(tab, { opening: path, loading: true });
	try {
		// 调用失败和读不到是同一个回答：没有可显示的。
		const read = await agent.readFile(sessionId, path).catch(() => null);
		// 读的途中这个标签又打开了别的文件，以后来的为准。
		if (fileOf(tab).opening !== path) return true;
		if (!read) return false;
		patch(tab, { path, sessionId, name: baseName(path), contents: read, reveal: lines ? { ...lines, at: ++reveals } : null });
		if (lines) set({ showSource: true });
		return true;
	} finally {
		if (fileOf(tab).opening === path) patch(tab, { loading: false, opening: null });
	}
}

/** 标签关掉了：它看着的文件一起放下。 */
export function dropFile(tab: string): void {
	if (!(tab in state.files)) return;
	const { [tab]: _, ...rest } = state.files;
	set({ files: rest });
}

/**
 * 这个路径是不是会话目录里的一个文件夹。
 *
 * 只放在读不成文件之后问：回复里 `[素材原图](../x/)` 这样的链接指的是文件夹，不是坏文件，多走这一趟
 * 换来打开它；正常的文件在读的时候就办完了，不必多问。问 agent 而不问主进程：能看哪些目录和读文件
 * 是同一道边界。
 */
export async function isFolder(sessionId: string, path: string): Promise<boolean> {
	if (!agent) return false;
	try {
		await agent.listDirectory(sessionId, path);
		return true;
	} catch {
		return false;
	}
}

/** 在会话工作目录里找一个写得不全的路径，见 `AgentService.locateFiles`。 */
export function locateFiles(sessionId: string, relative: string): Promise<string[]> {
	return agent ? agent.locateFiles(sessionId, relative).catch(() => []) : Promise.resolve([]);
}

/**
 * 纯文字里印出来的一条路径（终端输出）在会话里指的那个文件，见 `UiContext.findFile`。
 *
 * 绝对路径列它所在的目录来认：问 agent 而不是主进程，文件面板打不开的（会话目录外）就不算。相对路径交给
 * `locateFiles`，它先按原样拼、再按结尾找；文件夹带着结尾的分隔符，不算。不止一个时不替人挑。
 */
export async function findFile(sessionId: string, written: string): Promise<string | null> {
	if (!agent || !written) return null;
	if (/^([A-Za-z]:)?[\\/]/.test(written)) {
		const parent = written.slice(0, Math.max(written.lastIndexOf("/"), written.lastIndexOf("\\"))) || written.slice(0, 1);
		const entries = await agent.listDirectory(sessionId, parent).catch(() => []);
		const name = baseName(written);
		return entries.some((entry) => !entry.isDirectory && entry.name === name) ? written : null;
	}
	const files = (await locateFiles(sessionId, written)).filter((path) => !/[/\\]$/.test(path));
	return files.length === 1 ? files[0]! : null;
}

/** 图片仍走读文件的权限检查；修改时间让同名图片改写后重新取像素。 */
export async function localImageUrl(sessionId: string, path: string): Promise<string | null> {
	const contents = await agent?.readFile(sessionId, path).catch(() => null);
	return contents ? mediaUrl(sessionId, path, contents.modifiedAt ?? 0) : null;
}

/**
 * 图片、PDF、音视频在界面里的地址：主进程每次请求都先问 agent 进程这个路径在不在会话的工作目录里。
 *
 * 带上修改时间：同一个地址 Chromium 整个页面期间都复用已经取过的图，原地改写过的文件（agent 往同一个名字写了
 * 新图）会一直显示旧的。主进程只看路径。
 */
export function mediaUrl(sessionId: string, path: string, version?: number): string {
	const query = version === undefined ? "" : `?v=${version}`;
	return `plume-media://f/${encodeURIComponent(sessionId)}/${encodeURIComponent(path)}${query}`;
}

export function baseName(path: string): string {
	return (
		path
			.replace(/[/\\]+$/, "")
			.split(/[/\\]/)
			.pop() || path
	);
}

/**
 * 按路径打开文件：已经有标签看着它就切过去，不然新开一个。读不到不开标签，说一声。
 *
 * 标签由 `app/panels.ts` 管，启动时（`app/start.ts`）把它的实现交进来；回复里的文件签从这里调，不回头 import `app/`。
 */
let opener: ((path: string, lines?: LineRange | null, sessionId?: string) => Promise<void>) | null = null;

export function setFileOpener(open: (path: string, lines?: LineRange | null, sessionId?: string) => Promise<void>): void {
	opener = open;
}

export function openFile(path: string, lines?: LineRange | null, sessionId?: string): Promise<void> {
	return opener ? opener(path, lines, sessionId) : Promise.resolve();
}

/** 文档插件只得到这一次读取的数据，不能凭文件名扩大目录权限。 */
export async function readFileBytes(sessionId: string, path: string, modifiedAt: number | undefined, signal: AbortSignal): Promise<Uint8Array> {
	signal.throwIfAborted();
	if (!agent) throw new Error("Agent is unavailable");
	const call = agent.readFileBytes(sessionId, path, modifiedAt);
	const cancel = () => call.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		return await call;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

export async function listDirectory(sessionId: string, path: string): Promise<FileEntry[]> {
	if (!agent) return Promise.reject(new Error("Agent is unavailable"));
	return await agent.listDirectory(sessionId, path);
}

let onMoved: ((from: string, to: string) => void) | undefined;
export function setFileMovedHandler(handler: (from: string, to: string) => void): void {
	onMoved = handler;
}
export function movedPath(path: string, from: string, to: string): string {
	return path === from ? to : path.startsWith(`${from}/`) || path.startsWith(`${from}\\`) ? to + path.slice(from.length) : path;
}

export function moveFiles(path: string, to: string): void {
	for (const [tab, file] of Object.entries(state.files)) {
		if (!file.path) continue;
		const next = movedPath(file.path, path, to);
		if (next !== file.path) patch(tab, { path: next, name: baseName(next), opening: null, loading: false });
	}
	onMoved?.(path, to);
}

/** 文件树的所有写操作走与文件读取相同的会话边界。 */
export async function fileOperation(sessionId: string, operation: import("@plume/contract").FileOperation): Promise<import("@plume/contract").FileOpResult> {
	if (!agent) return { ok: false, error: "Agent is unavailable" };
	try {
		return await agent.fileOperation(sessionId, operation);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

let onRemoved: ((paths: string[]) => void) | undefined;
export function setFileRemovedHandler(handler: (paths: string[]) => void): void {
	onRemoved = handler;
}
export function removeFiles(paths: string[]): void {
	onRemoved?.(paths);
	for (const [tab, file] of Object.entries(state.files)) {
		const path = file.opening ?? file.path;
		if (path && paths.some((removed) => path === removed || path.startsWith(`${removed}/`) || path.startsWith(`${removed}\\`))) dropFile(tab);
	}
}
