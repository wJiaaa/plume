import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { backgroundJobs, type BackgroundJob } from "../../src/tools/background-jobs.ts";
import { readJobOutput } from "../../src/tools/job-output.ts";

it("界面读日志不消费模型未读状态，只读尾部、不截开字符", async () => {
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
		registry.add(job, { kill: vi.fn(), onOutput() {}, onExit() {}, onError() {} });
		expect(await readJobOutput(job)).toMatchObject({ text: "完整输出\n", done: true, truncated: false });
		expect(registry.isQuiet("job")).toBe(false);
		await writeFile(path, "中".repeat(100_000));
		const tail = await readJobOutput(job);
		expect(tail.truncated).toBe(true);
		expect(tail.text).not.toContain("�");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
