/**
 * 让某样东西跟着正在干活的 agent 走，而不是等它这一轮结束。
 *
 * 每个汇报工作区状态的界面原本都是同一个形状——`running` 变回 false 时重读一次——也都有同一个毛病：
 * 一轮花四分钟改文件，git 面板和改动计数显示的是四分钟前的样子。说明「积了多少没看过」的那个数，
 * 反倒是窗口里最后一个知道的。
 *
 * 轮询，而不是从工具结果驱动，这是有意的。写文件的不只是工具：跑格式化的 `bash`、agent 写完又执行的
 * 脚本、窗口旁边开着的编辑器。问一次 git 很便宜，而且对所有这些都对；一张「会写文件的工具」清单是
 * 猜测，下次加一个工具它就过时了。
 *
 * 挂载时刷新一次，一轮结束时再刷新一次，所以最终状态不会落后一个轮询间隔；`touchWorkingTree` 时也刷新，
 * 管两轮之间改动工作区的事。窗口回到前台时也刷新：在旁边终端里切分支、改文件时没有东西在轮询，而回来
 * 正是人要看的时候。
 */

import { useEffect } from "react";

/** 一轮运行中多久重读一次。快到读起来是实时的，便宜到可以一直开着。 */
const LIVE_POLL_MS = 1500;

/** 现在挂着的每个界面，各是一次重读。 */
const mounted = new Set<() => void>();

/**
 * 工作区刚被不是一轮对话的东西改过——比如撤销把文件放了回去。
 *
 * 空闲时没有东西轮询，没有这个的话，改动计数会一直停在文件放回去之前的数，直到下一轮结束。
 */
export function touchWorkingTree(): void {
	for (const reread of mounted) reread();
}

export function useLiveRefresh(refresh: () => void | Promise<void>, running: boolean, ms = LIVE_POLL_MS): void {
	/*
	 * `refresh` 是依赖项，所以它必须稳定——每个调用处都要 `useCallback`。
	 *
	 * 有意不放进 ref：它闭包里的是正在读哪个仓库，放进 ref 的话换了工作区之后还会继续轮询旧的那个。
	 * 依赖它意味着一切换就立刻重读，这也是谁都会期待的行为。代价是不稳定的回调每次渲染都会重建定时器，
	 * 所以这里写明了。
	 */
	useEffect(() => {
		/*
		 * 两道防线，都是为了不让活儿在自己身后堆起来。
		 *
		 * `inFlight`：大仓库上的 `git status` 可能比间隔还长，没有它的话每一拍都会在上一次之上再起一次——
		 * 一个随这一轮运行时长不断增长的队列，轮询就是这样变成泄漏的。
		 *
		 * `alive`：effect 拆掉之后不再起新的。已经在路上的那次会落到一个已卸载组件的 `setState` 上，
		 * React 直接丢掉，不会告警——但卸载之后再起*新*的活儿，是这里要防的。
		 */
		let alive = true;
		let inFlight = false;

		const tick = async () => {
			if (!alive || inFlight) return;
			inFlight = true;
			try {
				await refresh();
			} catch {
				// 读失败一次不值得打断一轮；下一拍再试。
			} finally {
				inFlight = false;
			}
		};

		const reread = () => void tick();
		mounted.add(reread);
		window.addEventListener("focus", reread);
		void tick();
		if (!running)
			return () => {
				alive = false;
				mounted.delete(reread);
				window.removeEventListener("focus", reread);
			};

		const timer = setInterval(() => void tick(), ms);
		return () => {
			alive = false;
			mounted.delete(reread);
			window.removeEventListener("focus", reread);
			clearInterval(timer);
		};
	}, [refresh, running, ms]);
}
