/**
 * 面板里的真 shell。
 *
 * 是伪终端而不是命令执行器：区别在于另一头的程序是否相信自己在和人说话。没有 pty 就没有颜色、提示符重画、
 * Ctrl-C，编辑器、分页器、交互式安装程序这类全屏程序根本用不了，而这些正是要一个终端的大部分理由。
 *
 * 面板区的一个标签就是一个 shell。shell 不归这个组件：它跑在 agent 进程里，这里连上这个标签的那个，所以组件
 * 挂上不是终端启动，卸掉也不是终端结束（见 registry.ts）；只有关标签和 shell 自己退出会结束它。
 */

import type { PanelProps, Remote } from "@plume/contract/ui";
import { Button, Text, useConfirmGate, useI18n } from "@plume/ui";
import { Plus, SquareTerminal } from "@plume/ui/icons";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalApi, TerminalTab } from "./api.ts";
import { dropText } from "./drop.ts";
import { terminalKey } from "./keys.ts";
import { type LinkActions, linkify } from "./links.ts";
import { paletteFromTheme, typography } from "./look.ts";
import { MESSAGES } from "./messages.ts";
import type { DirectoryRequest } from "./open-directory.ts";
import { TerminalMenu } from "./TerminalMenu.tsx";
import { TerminalSearch } from "./TerminalSearch.tsx";

/** 读不到 CSS 变量时的等宽字体和字号；正常情况下 typography 用的是 --plume-font-mono、--plume-code-size。 */
const CODE_DEFAULTS = {
	codeFont: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	codeFontSize: 12,
};

export function TerminalPane({
	api,
	cwd,
	tab,
	shown,
	setTitle,
	onClose,
	directoryRequest,
	takeDirectory,
	onDirectoryError,
	links,
	droppedPaths,
}: {
	api: Remote<TerminalApi>;
	cwd: string;
	directoryRequest: DirectoryRequest | null;
	takeDirectory(id: number): Promise<boolean>;
	onDirectoryError(error: unknown): void;
	/** 终端里的网址、路径点了怎么开；终端只建一次，点的时候读最新的这一份。 */
	links: LinkActions;
	/** 拖进来的东西带着的本机路径，见 `UiContext.droppedPaths`。 */
	droppedPaths(transfer: DataTransfer): string[] | null;
} & Omit<PanelProps, "session">) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const host = useRef<HTMLDivElement>(null);
	const term = useRef<Terminal | null>(null);
	const search = useRef<SearchAddon | null>(null);
	/**
	 * 量到的尺寸，给还没起的 shell 用。shell 按出生时的宽度折行，已经写出去的改不回来，所以必须是真宽度；
	 * 量尺寸的 layout effect 先于开 shell 的 effect 跑，80×24 实际用不上。
	 */
	const size = useRef({ cols: 80, rows: 24 });
	const replaying = useRef(false);
	/** agent 进程报来的所有 shell；还没报来时为空。 */
	const [tabs, setTabs] = useState<TerminalTab[] | null>(null);
	/** 这个标签连的 shell；还没开出来时为空。 */
	const [active, setActive] = useState("");
	const [ready, setReady] = useState("");
	const reopeningDirectory = useRef<number | undefined>(undefined);
	/** 数据回调在 React 重画之前就跑，所以另存一份。 */
	const activeRef = useRef(active);
	activeRef.current = active;
	const mine = tabs?.find((entry) => entry.id === active);
	const mineRef = useRef(mine);
	mineRef.current = mine;
	/** 连着的那个 shell 退出时的代码；换一个新的就清掉。 */
	const [exited, setExited] = useState<number | null>(null);
	/** 按过几次查找；0 是关着。见 TerminalSearch。 */
	const [finding, setFinding] = useState(0);
	/** 右键菜单：在哪、那一刻选中了什么。选中的字现在就读：菜单拿走焦点可能清掉它。 */
	const [menu, setMenu] = useState<{ at: { x: number; y: number }; selection: string } | null>(null);
	const closeGate = useConfirmGate();
	const linkActions = useRef(links);
	linkActions.current = links;

	const opening = useRef<Promise<string> | undefined>(undefined);
	const mounted = useRef(false);
	const generation = useRef(0);
	const closing = useRef(false);
	/** 逻辑入口按 tab 幂等接回；shell 已退出时才新开。 */
	const openHere = () => {
		if (closing.current) return;
		const current = generation.current;
		const pending = api.open(tab, cwd, Math.max(10, size.current.cols), Math.max(4, size.current.rows)).then((opened) => opened.id);
		opening.current = pending;
		void pending.then(
			(id) => {
				if (mounted.current && !closing.current && current === generation.current) setActive(id);
			},
			(error: unknown) => console.error("[plume.terminal] 没能打开终端：", error),
		);
	};

	// 前台程序、序号以 agent 进程为准；退出的从这里消失。
	useEffect(() => {
		const call = api.watch();
		void (async () => {
			try {
				for await (const next of call) setTabs(next);
			} catch {}
		})();
		return () => call.cancel();
	}, [api]);

	// 接回这个标签的 shell，第一次挂上才开新的。
	useEffect(() => {
		mounted.current = true;
		closing.current = false;
		openHere();
		return () => {
			mounted.current = false;
			// oxlint-disable-next-line react-hooks/exhaustive-deps -- generation 是作废计数，清理时加一正是要它的最新值
			generation.current++;
		};
		// openHere 每次渲染都是新的；cwd 只决定新 shell 起在哪，换了不重开。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [api, tab]);

	// 「终端 1 · node」：开着 dev server 的那个不用点开就认得出来。
	const title = mine && (mine.process ? `${text.tab(mine.number)} · ${mine.process}` : text.tab(mine.number));
	useEffect(() => setTitle(title), [setTitle, title]);

	/** 关标签就是结束它的 shell。前台跑着别的程序时先问一句：停在提示符上的照旧一点就关。 */
	useEffect(
		() =>
			onClose(async () => {
				const current = mineRef.current;
				if (current?.process) {
					const go = await closeGate.ask({
						title: text.closeRunning(current.process),
						detail: text.closeRunningDetail(current.process),
						confirmLabel: text.closeRunningConfirm,
					});
					if (!go) return false;
				}
				// 等还在开的调用落地，再按 tab 结束，不能留下没人能接回的 pty。
				closing.current = true;
				try {
					await opening.current?.catch(() => undefined);
					await api.close(tab);
					return true;
				} catch (error) {
					closing.current = false;
					throw error;
				}
			}),
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- closeGate 每次渲染都是新的，onClose 只登记一次
		[api, tab, onClose, closeGate.ask, text],
	);

	/*
	 * xterm 属于面板，不属于它正显示的那个 shell：先建好、量好，新 shell 才能按真宽度出生；换标签只是重置
	 * 再连上，不拆了重建。
	 */
	useLayoutEffect(() => {
		const element = host.current;
		if (!element) return;
		const theme = paletteFromTheme();
		// 格子外面那圈内边距是宿主元素的，它也要穿上终端的底色，不然四周露出一圈面板的底。
		element.style.background = theme?.background ?? "";
		const terminal = new Terminal({
			...typography(CODE_DEFAULTS),
			// 竖线不是方块：方块在高格子里是屏幕上最大的东西，读起来像选中而不是位置。失焦时变成空心框。
			cursorStyle: "bar",
			cursorInactiveStyle: "outline",
			cursorBlink: true,
			theme,
			allowProposedApi: true,
			scrollback: 5000,
		});
		// Windows 上 shell 在 ConPTY 里，要告诉 xterm 后端和系统版本（见 shell.ts 的 windowsPtyFor）。版本号只有逻辑入口
		// 读得到；xterm 每次改尺寸时现读这一项，shell 的输出也还要等它开出来，所以晚到这一下不碍事。
		void api.windowsPty().then(
			(pty) => {
				if (pty && term.current === terminal) terminal.options.windowsPty = pty;
			},
			() => undefined,
		);
		// 不归 xterm 的键在它拿到之前截下，见 terminalKey。返回 false 时 xterm 不把它变成控制字符吞掉。
		terminal.attachCustomKeyEventHandler((event) => {
			const action = terminalKey(event, terminal.hasSelection());
			if (action === "shell") return true;
			if (action === "find" && event.type === "keydown") {
				event.preventDefault();
				setFinding((count) => count + 1);
			}
			if (action === "copy" && event.type === "keydown") {
				event.preventDefault();
				const text = terminal.getSelection();
				if (text) void navigator.clipboard.writeText(text);
				terminal.clearSelection();
			}
			return false;
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		// xterm 自带 Unicode 6 的宽度表，👍、✅ 只占一格，shell 却算两格，后面的字就叠在 emoji 上。
		terminal.loadAddon(new Unicode11Addon());
		terminal.unicode.activeVersion = "11";
		linkify(terminal, {
			find: (path) => linkActions.current.find(path),
			openUrl: (url, external) => linkActions.current.openUrl(url, external),
			openFile: (path) => linkActions.current.openFile(path),
		});
		const searcher = new SearchAddon();
		terminal.loadAddon(searcher);
		search.current = searcher;
		terminal.open(element);
		term.current = terminal;

		/*
		 * 尺寸变了要告诉 pty，不然里面的程序都按旧宽度折行，看起来像乱码而不是尺寸没更新。量出 0 时不动：
		 * 收起的面板会量出一条缝，按它告诉 shell 就是把它缩成两列。
		 */
		const refit = () => {
			if (element.clientWidth === 0 || element.clientHeight === 0) return;
			const next = fit.proposeDimensions();
			if (!next) return;
			if (!replaying.current) terminal.resize(next.cols, next.rows);
			if (next.cols === size.current.cols && next.rows === size.current.rows) return;
			size.current = next;
			if (activeRef.current) void api.resize(activeRef.current, next.cols, next.rows);
		};
		refit();
		// 等宽字体晚到时格子会变宽，按建终端那一刻量的列数画就会超出面板；字体到齐后再量一次。
		void document.fonts.ready.then(() => {
			if (term.current === terminal) refit();
		});
		const observer = new ResizeObserver(refit);
		observer.observe(element);

		// 配色从 CSS 变量里读，跟着浅色、深色切换重读一次。
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const retheme = () => {
			const next = paletteFromTheme();
			terminal.options.theme = next;
			element.style.background = next?.background ?? "";
		};
		scheme.addEventListener("change", retheme);

		return () => {
			scheme.removeEventListener("change", retheme);
			observer.disconnect();
			terminal.dispose();
			term.current = null;
			search.current = null;
		};
	}, [api]);

	/*
	 * 连上这个标签的 shell。先回放它写过的全部输出（原样的字节流，xterm 重放出来就是那一屏），再接着收。
	 * 断开不结束 shell：换会话、去设置页都会走到这里，结束的话正在跑的构建就没了。
	 */
	useEffect(() => {
		const terminal = term.current;
		if (!terminal || !active) return;
		// 退出的那个 shell 留在屏幕上的不是新开这个的，它的查找结果也不是。
		terminal.reset();
		setReady("");
		setFinding(0);
		setExited(null);
		replaying.current = true;
		let stopped = false;
		const call = api.attach(active, size.current.cols, size.current.rows);
		const typing = terminal.onData((data) => {
			if (!replaying.current) void api.write(active, data);
		});
		void (async () => {
			try {
				for await (const output of call) {
					if (stopped) break;
					if (output.type === "data") {
						if (replaying.current) terminal.resize(output.cols, output.rows);
						// write 异步解析；必须写完再改尺寸，否则后面的 resize 会改变前一段的折行。
						await new Promise<void>((resolve) => terminal.write(output.data, resolve));
					} else if (output.type === "ready") {
						replaying.current = false;
						terminal.resize(size.current.cols, size.current.rows);
						setReady(active);
					} else {
						setReady("");
						setExited(output.code);
					}
				}
			} catch {}
		})();
		terminal.focus();
		return () => {
			// 先解绑键盘再断开，否则新开的那个 shell 的按键会送进这一个。
			stopped = true;
			replaying.current = false;
			typing.dispose();
			call.cancel();
		};
	}, [api, active]);

	/** shell 不在了，又不是看着它退出的（比如重开过 agent 进程）：说一声，给一个新开的出路。 */
	const gone = tabs !== null && active !== "" && !mine && exited === null;

	useEffect(() => {
		if (!shown || !directoryRequest) return;
		if (gone || exited !== null) {
			// 一次点击最多重开一次，原生组件不可用时不能反复起 shell。
			if (reopeningDirectory.current !== directoryRequest.id) {
				reopeningDirectory.current = directoryRequest.id;
				openHere();
			}
			return;
		}
		if (!active || ready !== active) return;
		void takeDirectory(directoryRequest.id)
			.then(async (taken) => {
				if (!taken) return;
				await api.write(active, directoryRequest.command);
				term.current?.focus();
			})
			.catch(onDirectoryError);
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- openHere 每次渲染都是新的，按请求 id 限定重开次数
	}, [api, active, ready, shown, directoryRequest, takeDirectory, onDirectoryError, gone, exited]);

	return (
		<div className="terminal-pane" data-terminal-pane="">
			<div className="terminal-body">
				{/*
				 * xterm 挂着的元素一直在，shell 不在时只是藏起来、盖上空状态。换成空状态的话，xterm 还握着那个被卸掉的
				 * 元素，再开一个时面板上就没有终端。
				 */}
				<div
					ref={host}
					data-terminal-id={active}
					data-terminal-ready={active !== "" && ready === active ? "true" : undefined}
					className="terminal-host"
					style={gone ? { visibility: "hidden" } : undefined}
					onContextMenu={(event) => {
						const terminal = term.current;
						if (!terminal || gone) return;
						event.preventDefault();
						setMenu({ at: { x: event.clientX, y: event.clientY }, selection: terminal.getSelection() });
					}}
					onDragOver={(event) => {
						if (gone || !droppedPaths(event.dataTransfer)) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
					}}
					onDrop={(event) => {
						const terminal = term.current;
						const paths = terminal && !gone ? droppedPaths(event.dataTransfer) : null;
						if (!terminal || !paths) return;
						event.preventDefault();
						// 经 paste，和右键粘贴一样：打在提示符上，不会直接执行。
						const typed = dropText(paths);
						if (typed) terminal.paste(typed);
						terminal.focus();
					}}
				/>
				{menu && (
					<TerminalMenu
						at={menu.at}
						canCopy={menu.selection.length > 0}
						onCopy={() => {
							void navigator.clipboard.writeText(menu.selection);
							term.current?.focus();
						}}
						onPaste={() => {
							// 经 xterm 自己的 paste：shell 开着括号粘贴模式时它会包好，粘进来的是打在提示符上的字，不会直接执行。
							void navigator.clipboard.readText().then((text) => {
								if (!text || !term.current) return;
								term.current.paste(text);
								term.current.focus();
							});
						}}
						onClose={() => setMenu(null)}
					/>
				)}
				{gone && (
					<div className="terminal-gone">
						<SquareTerminal size={30} strokeWidth={1.35} style={{ color: "var(--plume-ink-faint)" }} />
						<Text as="p" tone="muted">
							{text.gone}
						</Text>
						<Button icon={<Plus size={16} strokeWidth={1.9} aria-hidden />} onClick={openHere}>
							{text.new}
						</Button>
					</div>
				)}
				{finding > 0 && search.current && !gone && (
					<TerminalSearch
						search={search.current}
						request={finding}
						onClose={() => {
							setFinding(0);
							term.current?.focus();
						}}
					/>
				)}
				{exited !== null && (
					<div className="terminal-exited">
						<Text size="detail" tone="faint">
							{text.shellExitedCode(exited)}
						</Text>
						<Button icon={<Plus size={16} strokeWidth={1.9} aria-hidden />} onClick={openHere}>
							{text.new}
						</Button>
					</div>
				)}
			</div>
			{closeGate.element}
		</div>
	);
}
