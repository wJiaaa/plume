import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { backgroundJobs, type BackgroundJob } from "../../src/tools/background-jobs.ts";
import { createJobsService } from "../../src/tools/jobs-service.ts";

it("界面读日志不消费模型未读状态，停止按会话和任务而不是 pid", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-job-view-"));
	try {
		const path = join(dir, "job.log");
		await writeFile(path, "完整输出\n");
		const state = new Map<string, unknown>();
		const registry = backgroundJobs(state);
		const job: BackgroundJob = {
			id: "job",
			command: "echo",
			startedAt: 1,
			exitCode: 0,
			finishedAt: 2,
			output: "截断的输出",
			outputPath: path,
			outputComplete: true,
			status: "exited",
		};
		const kill = vi.fn();
		registry.add(job, { kill, onOutput() {}, onExit() {}, onError() {} });
		const service = createJobsService(new Map([["a", state]]));
		expect(await service.output("a", "job")).toMatchObject({ text: "完整输出\n", done: true, truncated: false });
		expect(registry.isQuiet("job")).toBe(false);
		expect(service.list("b")).toEqual([]);
		await expect(service.output("b", "job")).rejects.toThrow();
		expect(service.stop("b", "job", true)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
		delete job.finishedAt;
		job.status = "running";
		expect(service.stop("a", "job", true)).toBe(true);
		expect(kill).toHaveBeenCalledWith("SIGKILL");
		await writeFile(path, "中".repeat(100_000));
		const tail = await service.output("a", "job");
		expect(tail.truncated).toBe(true);
		expect(tail.text).not.toContain("�");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
