/**
 * 开始了的建议，第一轮跑完以后交不交回、交什么。
 *
 * 只交第一轮：那是卡片交给它的那件事。之后人在它里面接着聊，每说完一轮都往回送，就是拿别人的对话去叫醒提建议的那个。
 * 交，要等交给它的那件事做完：第一轮结束以后，会话还得真闲下来（`LaunchedSession.idle`：它派出去的子 Agent、后台命令都回来了，
 * 问别的会话的话也有了答复，送回的结果、答复叫起的几轮也做完了）。问是发出即返回的，问完收尾等着的会话这时已经闲了，
 * 把它那句「在等答复」交回去，拿到答复以后做的那一轮就送不回来了。派了子 Agent 的那一轮当场就收尾，那时最后一句是「已派出，等结果」，真正的结论在之后那几轮里。
 * 所以送的是最后那一轮的话，收场也按最后那一轮算；这段时间里人在它里面说的话也算进这件事。
 *
 * 交不交在第一轮结束那一刻定下，之后改不了。被人停下的不交——停下是人的决定，叫醒提建议的那个去处理半截结果是在和这个决定争。
 * 出错、跑到上限的照样交，标成没跑完：那边在等它，该知道它没做成。
 *
 * 账只在内存里：应用退出时第一轮也停了，按「被人停下」不交，用不着记到磁盘上。
 */

import type { LaunchedSession, TurnStop } from "@plume/contract";
import { reportText } from "./prompt.ts";

export interface Following {
	reportBack: boolean;
	firstTurn: boolean;
}

export interface FollowDeps {
	/** 它此刻的标题：可能是这段时间里才起好的。 */
	title(sessionId: string): Promise<string | undefined>;
	warn(message: string): void;
}

export class Followers {
	private readonly entries = new Map<string, Following>();
	private readonly deps: FollowDeps;

	constructor(deps: FollowDeps) {
		this.deps = deps;
	}

	get(sessionId: string): Following | undefined {
		return this.entries.get(sessionId);
	}

	deleted(sessionId: string): void {
		this.entries.delete(sessionId);
	}

	/** 第一轮还在跑时改主意。 */
	set(sessionId: string, on: boolean): boolean {
		const entry = this.entries.get(sessionId);
		if (!entry?.firstTurn) return false;
		entry.reportBack = on;
		return true;
	}

	/** 跟着一个刚开出来的会话，到时候交回。 */
	follow(launched: LaunchedSession, options: { title: string; reportBack: boolean }): void {
		const id = launched.session.id;
		const entry: Following = { reportBack: options.reportBack, firstTurn: true };
		this.entries.set(id, entry);
		const report = async () => {
			await launched.done.catch((): TurnStop => ({ reason: "aborted" }));
			entry.firstTurn = false;
			if (!entry.reportBack) return;
			const { stop, reply } = await launched.idle;
			if (!stop || !this.entries.has(id) || stop.reason === "aborted") return;
			const status = stop.reason === "done" ? "done" : "failed";
			const title = (await this.deps.title(id)) || options.title;
			launched.reportBack(reportText({ sessionId: id, title, status, reply }), status);
		};
		// i18n-exempt：日志
		void report().catch((error: unknown) => this.deps.warn(`新会话 ${id} 没交回去：${String(error)}`));
	}
}
