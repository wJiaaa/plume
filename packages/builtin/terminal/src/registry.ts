/**
 * 终端的 shell，跑在 agent 进程里，活得比显示它的面板长。
 *
 * 面板来来去去：收起面板区、切到别的面板、去设置页再回来，都会把它卸掉。shell 的命跟着面板走的话，每一次
 * 都会结束它，回来是同一个目录里一个新 shell：历史没了，跑着的 dev server 没了，打到一半的命令也没了，
 * 看起来就是终端自己重启了。真正的终端窗口不在眼前时也照样在跑。
 *
 * 所以面板只是连上、断开，只有 kill 和 shell 自己退出会结束它。断开时 shell 照常跑、照常记下输出，下次
 * 连上时把记下的原样回放进新的 xterm，画出来就是离开前的那一屏。
 *
 * 可以同时开好几个，面板区一个标签一个：open 总是新起一个，list 列出所有 shell，attach 按 id 连上一个。
 * shell 起在某个目录里，但不归那个目录：换个会话不会让一个还在跑的终端消失。
 *
 * 不碰 node-pty 本身，起 shell 的函数由外面传进来，测试里直接驱动。
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { IPty } from "node-pty";
import type { TerminalTab } from "./api.ts";
import { findExecutable, pickShell, shellArgs, shellEnv, watchForeground } from "./shell.ts";

/** 注册表用到的那几样；测试里的假 pty 实现这些就够。 */
export type Pty = Pick<IPty, "pid" | "process" | "onData" | "onExit" | "write" | "resize" | "kill">;

export type SpawnPty = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => Pty;

/** 连上的面板：收输出和退出。 */
export interface TerminalSink {
	data(chunk: string, cols: number, rows: number): void;
	exit(code: number): void;
}

interface Live {
	pty: Pty;
	cwd: string;
	number: number;
	cols: number;
	rows: number;
	/** 同时记录输出时的尺寸，避免跨窗口回放的光标控制覆盖旧内容。 */
	scrollback: Array<{ data: string; cols: number; rows: number }>;
	bytes: number;
	sinks: Set<TerminalSink>;
	/** 起不来的标签没有。 */
	foreground?: ReturnType<typeof watchForeground>;
}

export interface RegistryDeps {
	/** 起不来时抛错，错误信息写进那个标签。 */
	spawnPty: SpawnPty;
	platform?: string;
	env?: NodeJS.ProcessEnv;
	/** 现在的环境，在应用开着时会变的地方（Windows 的注册表，见 windows-env.ts）；没有就用 `env`。 */
	currentEnv?: () => NodeJS.ProcessEnv;
	home?: string;
	isDirectory?(path: string): boolean;
}

/**
 * 留多少输出给回来的面板重画。
 *
 * 够一次长构建的好几屏，又小到一个跑了一夜 `yes` 的 shell 也撑不大 agent 进程。按整块丢而不是按字节：
 * 半截转义序列回放出来是乱码。
 */
const SCROLLBACK_BYTES = 256 * 1024;

const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

export function createTerminalRegistry(deps: RegistryDeps) {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const directory = deps.isDirectory ?? isDirectory;
	const terminals = new Map<string, Live>();
	/** renderer 共用同一份绑定；取消 attach 不能释放它。 */
	const tabs = new Map<string, string>();
	const closed = new Set<string>();
	const watchers = new Set<() => void>();

	const changed = () => {
		for (const watcher of watchers) watcher();
	};
	const tabOf = (id: string, live: Live): TerminalTab => ({ id, number: live.number, cwd: live.cwd, process: live.foreground?.current ?? null });
	/** shell 实际起在哪：会话的目录还在就是它，否则（没有会话、目录被删了）是主目录，和别处开一个终端一样。 */
	const resolve = (cwd: string): string => (cwd && directory(cwd) ? cwd : home);

	const record = (live: Live, chunk: string) => {
		live.scrollback.push({ data: chunk, cols: live.cols, rows: live.rows });
		live.bytes += chunk.length;
		while (live.bytes > SCROLLBACK_BYTES && live.scrollback.length > 1) live.bytes -= live.scrollback.shift()?.data.length ?? 0;
	};

	const list = (): TerminalTab[] => [...terminals].map(([id, live]) => tabOf(id, live));

	/** 在这里新起一个 shell。总是新的，这就是标签条上的「+」；接上已有的是 attach。 */
	const open = (cwd: string, cols: number, rows: number): TerminalTab => {
		const dir = resolve(cwd);
		const id = randomUUID();
		const shell = pickShell(platform, env, (command) => findExecutable(command, platform, env));
		let pty: Pty;
		try {
			pty = deps.spawnPty(shell, shellArgs(platform, shell), {
				name: "xterm-256color",
				cols: Math.max(2, cols),
				rows: Math.max(2, rows),
				cwd: dir,
				env: shellEnv(platform, deps.currentEnv?.() ?? env),
			});
		} catch (error) {
			return openUnavailable(id, dir, error, Math.max(2, cols), Math.max(2, rows));
		}

		const live: Live = { pty, cwd: dir, number: nextNumber(), cols: Math.max(2, cols), rows: Math.max(2, rows), scrollback: [], bytes: 0, sinks: new Set() };
		live.foreground = watchForeground(pty, shell, changed);
		pty.onData((chunk) => {
			live.foreground?.poke();
			record(live, chunk);
			for (const sink of live.sinks) sink.data(chunk, live.cols, live.rows);
		});
		pty.onExit(({ exitCode }) => {
			live.foreground?.dispose();
			for (const sink of live.sinks) sink.exit(exitCode);
			live.sinks.clear();
			if (terminals.get(id) === live) terminals.delete(id);
			changed();
		});
		terminals.set(id, live);
		changed();
		return tabOf(id, live);
	};

	/**
	 * 一个起不来的 shell 也是一个标签，里面写着原因。
	 *
	 * 最可能的原因是 node-pty 没能加载，而面板正是找终端的人会看的地方；报成调用失败的话，面板上什么都
	 * 没有，也不说为什么。它从不报退出（退出的标签会被拿掉，原因也就跟着没了），和别的标签一样关掉。
	 */
	const openUnavailable = (id: string, dir: string, error: unknown, cols: number, rows: number): TerminalTab => {
		const message = error instanceof Error ? error.message : String(error);
		const text = `\x1b[31m${message.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`;
		const live: Live = {
			pty: inertPty(),
			cwd: dir,
			number: nextNumber(),
			cols,
			rows,
			scrollback: [{ data: text, cols, rows }],
			bytes: text.length,
			sinks: new Set(),
		};
		terminals.set(id, live);
		changed();
		return tabOf(id, live);
	};

	/**
	 * 把面板连到一个已有的 shell：先回放它写过的全部输出，之后的输出接着送过来。返回断开的函数；shell 不在
	 * 了返回 null，面板自己决定怎么办，而不是被塞一个新 shell。
	 */
	const attach = (id: string, cols: number, rows: number, sink: TerminalSink): (() => void) | null => {
		const live = terminals.get(id);
		if (!live) return null;
		/*
		 * 回来时的面板未必是离开时的尺寸，不告诉 shell 的话它按一个已经不存在的宽度折行。还没量到尺寸的
		 * 调用方传 0，不许把 shell 缩成一条缝。
		 */
		if (cols > 0 && rows > 0) resize(id, cols, rows);
		for (const chunk of live.scrollback) sink.data(chunk.data, chunk.cols, chunk.rows);
		live.sinks.add(sink);
		return () => void live.sinks.delete(sink);
	};

	/**
	 * 往 shell 里写。shell 关掉自己那头和退出事件到达之间有一个空当，这时写会抛 EPIPE；那头已经没有人收了，
	 * 丢掉这次写不损失什么。resize 同理。
	 */
	const write = (id: string, data: string): void => {
		try {
			terminals.get(id)?.pty.write(data);
		} catch {}
	};

	// 布局到一半时可能量出 0，pty 收到 0 会出错。
	const resize = (id: string, cols: number, rows: number): void => {
		try {
			const live = terminals.get(id);
			if (!live) return;
			const width = Math.max(2, cols),
				height = Math.max(2, rows);
			if (live.cols === width && live.rows === height) return;
			live.pty.resize(width, height);
			live.cols = width;
			live.rows = height;
		} catch {}
	};

	const end = (id: string, live: Live): void => {
		// 结束一个已经结束了的不算失败：要的是之后它不在了，它确实不在了。
		try {
			live.pty.kill();
		} catch {}
		live.foreground?.dispose();
		terminals.delete(id);
	};

	const kill = (id: string): void => {
		const live = terminals.get(id);
		if (!live) return;
		end(id, live);
		changed();
	};

	/** 同一个 tab 的重复挂载（包括不同 renderer）只会起一个 shell。 */
	const openForTab = (tab: string, cwd: string, cols: number, rows: number): TerminalTab => {
		// i18n-exempt：迟到的界面调用只记日志，不显示为产品文案。
		if (closed.has(tab)) throw new Error("Terminal tab is closed");
		const id = tabs.get(tab);
		const live = id ? terminals.get(id) : undefined;
		if (id && live) return tabOf(id, live);
		const opened = open(cwd, cols, rows);
		tabs.set(tab, opened.id);
		return opened;
	};

	const closeTab = (tab: string): void => {
		closed.add(tab);
		const id = tabs.get(tab);
		tabs.delete(tab);
		if (id) kill(id);
	};

	/** 1、2、……，不重用还开着的标签的号。所有 shell 一起编号：标签条把它们并排列着，靠名字来挑。 */
	const nextNumber = (): number => {
		const taken = new Set([...terminals.values()].map((live) => live.number));
		for (let n = 1; ; n++) if (!taken.has(n)) return n;
	};

	return {
		list,
		open,
		openForTab,
		closeTab,
		attach,
		write,
		resize,
		kill,
		/** shell 增减、前台程序变了时调用；返回取消订阅的函数。 */
		onChange(listener: () => void): () => void {
			watchers.add(listener);
			return () => void watchers.delete(listener);
		},
		/** 插件停用、应用退出：全部结束。 */
		dispose(): void {
			for (const entry of [...terminals]) end(...entry);
			tabs.clear();
			closed.clear();
			watchers.clear();
		},
	};
}

/** 代替一个没起来的 pty：注册表对它做的每件事都什么也不发生。 */
function inertPty(): Pty {
	const nothing = { dispose() {} };
	return { pid: 0, process: "", onData: () => nothing, onExit: () => nothing, write() {}, resize() {}, kill() {} };
}
