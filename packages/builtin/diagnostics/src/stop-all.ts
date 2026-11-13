import type { SessionAccess } from "@plume/contract";

/**
 * 环境卡片的「全部停止」：停掉一个会话还在跑的后台任务、取消它待触发的定时唤醒，和人在卡片里逐项点停止、取消是同一回事。
 *
 * 不另要本体接口：停一项的语义本体已经定了（`stopJob` 交给登记它的工具去停，人停掉的结束时送不送回会话归那件工具，
 * plume.tools 的后台命令和监视停了就不再送达；`cancelWakeup` 取消了就不会再到点），全部停止只是把列着的每一项各做一次。
 * `ctx.sessions` 的这几样都是同步的，一次调用里做完，中间不会有唤醒到点、任务结束插进来。
 *
 * 停的是普通停止（不强杀）：和每一行的停止键一样；停不下来的留在「正在停止」，到任务面板里强制结束。已经在停的不再叫一遍。
 * 一项停不掉不挡其余的，全都做完再把第一个错交出去。
 */
export function stopAll(sessions: Pick<SessionAccess, "jobs" | "stopJob" | "wakeups" | "cancelWakeup">, sessionId: string): { jobs: number; wakeups: number } {
	let jobs = 0;
	let wakeups = 0;
	let failure: unknown;
	for (const job of sessions.jobs(sessionId)) {
		if (job.finishedAt !== undefined || job.status === "stopping") continue;
		try {
			if (sessions.stopJob(sessionId, job.id, false)) jobs++;
		} catch (error) {
			failure ??= error;
		}
	}
	for (const wakeup of sessions.wakeups(sessionId)) if (sessions.cancelWakeup(sessionId, wakeup.id)) wakeups++;
	if (failure !== undefined) throw failure;
	return { jobs, wakeups };
}
