import { expect, it } from "vitest";
import type { BackgroundJobInfo, SessionWakeup } from "@plume/contract";
import { stopAll } from "../src/stop-all.ts";

const job = (id: string, extra: Partial<BackgroundJobInfo> = {}): BackgroundJobInfo => ({
	id,
	command: id,
	startedAt: 0,
	exitCode: null,
	status: "running",
	...extra,
});
const wakeup = (id: string): SessionWakeup => ({ id, kind: "wakeup", prompt: id, createdAt: 0, fired: 0, recurring: false, nextAt: 1 });

it("停掉还在跑的任务、取消全部唤醒；结束了的、正在停的不再叫；一项停不掉不挡别的，做完再报错", () => {
	const calls: string[] = [];
	const sessions = {
		jobs: (sessionId: string) =>
			sessionId === "s"
				? [
						job("server"),
						job("ended", { finishedAt: 1, status: "exited" }),
						job("stuck"),
						job("stopping", { status: "stopping" }),
						job("monitor", { wakes: true }),
					]
				: [],
		stopJob: (sessionId: string, jobId: string, force: boolean) => {
			calls.push(`stop:${sessionId}:${jobId}:${force}`);
			if (jobId === "stuck") throw new Error("停不掉");
			return true;
		},
		wakeups: (sessionId: string) => (sessionId === "s" ? [wakeup("wake-1"), wakeup("cron-2")] : []),
		cancelWakeup: (sessionId: string, id: string) => {
			calls.push(`cancel:${sessionId}:${id}`);
			return true;
		},
	};
	expect(() => stopAll(sessions, "s")).toThrow("停不掉");
	expect(calls).toEqual(["stop:s:server:false", "stop:s:stuck:false", "stop:s:monitor:false", "cancel:s:wake-1", "cancel:s:cron-2"]);

	calls.length = 0;
	expect(stopAll({ ...sessions, stopJob: (...args) => (calls.push(args[1]), args[1] !== "monitor") }, "s")).toEqual({ jobs: 2, wakeups: 2 });
	expect(stopAll(sessions, "别的会话")).toEqual({ jobs: 0, wakeups: 0 });
});
