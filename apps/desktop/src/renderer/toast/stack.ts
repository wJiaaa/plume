/**
 * 一摞提示条是什么样，在画出来之前就定下的规矩。
 *
 * 要紧的决定都关于「很多条」而不是一条，放在组件里最容易悄悄写错：五个文件因为同一个原因删不掉，应该是一张卡片
 * 写着 ×5，不是五张一样的叠在一起；同一句话再来一次，卡片不该跳到队尾、从指针底下挪走；一阵连发也得按时散掉，
 * 不能攒着过后再冒出来。
 *
 * 写成纯函数，`node --test` 能逐条验证。
 */

import type { MessageKey } from "@plume/ui";
import { explain } from "./explain.ts";

export type ToastLevel = "info" | "warn" | "error";

export interface Notice {
	id: string;
	level: ToastLevel;
	message: string;
	/** 说的是另一个会话的事（后台那个跑完了）：卡片上可以跳过去。 */
	sessionId?: string;
	/** 刚写到磁盘上的文件：卡片上可以在访达 / 资源管理器里指给人看。 */
	reveal?: string;
}

/** 一张卡片：一句话，和眼下正在说这句话的每一条提示。 */
export interface ToastGroup {
	/** 重复来的也不变，React 留着同一张卡片，不换掉它。 */
	key: string;
	level: ToastLevel;
	message: string;
	/** 认得出来的失败附带的一句「怎么办」，见 `explain`。 */
	hint?: string;
	/** 点了跳过去的会话。 */
	sessionId?: string;
	/** 在系统文件管理器里指出来的文件。 */
	reveal?: string;
	/** 新的在后。不止一个就是同一件事又发生了。 */
	ids: string[];
}

/**
 * 每一种留多久，到时自己走。
 *
 * 错误也会走。窗口顶上一列没人关的提示比漏看一条更糟，而这些说的都是刚刚做的事——不再是眼下的事时，人也已经往下走了。
 * 指针停在上面时计时暂停，长的那条因此读得完，又不必常驻。
 */
export const TOAST_LIFETIME: Record<ToastLevel, number> = { info: 6000, warn: 9000, error: 9000 };

/**
 * 同时画几张。
 *
 * 超过三张就不是反馈，是挡在应用前面的一堵墙。多出来的不丢：计时照走、按顺序散掉，一阵连发会排空，而不是排在看得见的那几张后面。
 */
export const TOAST_LIMIT = 3;

/**
 * 盖在一切上面，而且留足余量。
 *
 * 提示条常常就是上面那层东西刚做的事的回答，被它自己盖住的失败等于没报。产品自己的层最高到看图器的工具栏，
 * 但给层编号的不只产品：CodeMirror 的行号栏在 200，第三方的样式表不是该和它比大一号的东西；平手时看文档顺序，
 * 那是没人打算改却常常变了的东西。写成数字放在这里，加新层时只看一处，测试也能盯住它。
 *
 * 唯一高过它的是悬停提示（`@plume/ui` 的 `TIP_Z`）：卡片上的按钮也带提示，气泡得画在卡片上面。
 */
export const TOAST_Z = 1000;

/**
 * 把提示折成卡片。
 *
 * 级别相同、说法相同，就是同一件事又发生了：并成一张，记上次数。并进去的卡片留在它第一条的位置——挪到队尾会让整列
 * 在有人伸手去点关闭的那一刻从指针底下滑上去。
 *
 * `translate` 由调用方给：界面里是当前语言的 `t`，测试里是固定语言的那一份。
 */
export function groupNotices(notices: readonly Notice[], translate: (key: MessageKey) => string): ToastGroup[] {
	const byKey = new Map<string, ToastGroup>();
	for (const notice of notices) {
		/*
		 * 先换成人话，再决定说不说、算不算同一句：按原文并的话，同一个连接断两次带着两个不同的 errno，在读的人看来是同一句话，
		 * 却成了两张卡片。
		 */
		const said = explain(notice.message, translate);
		if (said.silent) continue;
		// 两个会话各自跑完、两次导出到不同的文件，是两件事，各自指向自己那一处。
		const key = `${notice.level}:${notice.sessionId ?? ""}:${notice.reveal ?? ""}:${said.message}`;
		const existing = byKey.get(key);
		if (existing) existing.ids.push(notice.id);
		else
			byKey.set(key, {
				key,
				level: notice.level,
				message: said.message,
				...(said.hint ? { hint: said.hint } : {}),
				...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
				...(notice.reveal ? { reveal: notice.reveal } : {}),
				ids: [notice.id],
			});
	}
	return [...byKey.values()];
}

/** 卡片什么时候走，以及定下这个时间时它见过的最新一条。 */
export interface Deadline {
	at: number;
	last: string;
}

/**
 * 让到期时间跟上卡片。
 *
 * 只有卡片没见过的新一条才重新计时——重复来一次，这句话又成了眼下的事。列表在别的卡片来去时也会变，按那个重新计时的话，
 * 只要一直有事发生，整列就一直挂着。
 */
export function schedule(due: ReadonlyMap<string, Deadline>, groups: readonly ToastGroup[], now: number): Map<string, Deadline> {
	const next = new Map<string, Deadline>();
	for (const group of groups) {
		const last = group.ids[group.ids.length - 1]!;
		const existing = due.get(group.key);
		next.set(group.key, existing?.last === last ? existing : { at: now + TOAST_LIFETIME[group.level], last });
	}
	return next;
}

/** 画哪几张，新的在后。超出上限的照样存在、照样到期，见 `TOAST_LIMIT`；这里只管屏幕上有什么。 */
export function visibleToasts(groups: readonly ToastGroup[], limit = TOAST_LIMIT): ToastGroup[] {
	return groups.slice(-limit);
}
