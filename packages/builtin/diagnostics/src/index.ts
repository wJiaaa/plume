import { open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { Plugin } from "@plume/contract";
import type { DiagnosticsApi } from "./api.ts";
import { createEndpointFinder } from "./endpoints.ts";
import { DiagnosticStore } from "./store.ts";
import { MESSAGES } from "./messages.ts";

export default {
	name: "plume.diagnostics",
	inject: ["background.jobs", "session.wakeups"],
	apply(ctx) {
		const store = new DiagnosticStore(join(ctx.dataDir, "diagnostics.db"));
		const jobs = ctx.use("background.jobs");
		const wakeups = ctx.use("session.wakeups");
		ctx.effect(() => store.close());
		const words = () => MESSAGES[ctx.locale()];
		const findEndpoints = createEndpointFinder(
			async (jobId, sessionId) => (await jobs.output(sessionId, jobId)).text,
			() => words().invalidListeners,
		);
		ctx.sessions.observe((value) => store.append(value));
		ctx.sessions.onDeleted((id) => store.delete(id));
		const session = async (id: string) => {
			if (typeof id !== "string" || !id) throw new Error(words().missingSession);
			const all = await ctx.sessions.list();
			if (!all.some((entry) => entry.id === id)) throw new Error(words().missingSession);
			return all;
		};
		const api: DiagnosticsApi = {
			async read(id, version, ports) {
				const all = await session(id);
				const current = store.version(id);
				const list = jobs.list(id);
				const found = ports ? await findEndpoints(id, list) : { jobs: list.map((job) => ({ ...job, endpoints: [] })) };
				return {
					version: current,
					...(current === version ? {} : { observations: store.read(id) }),
					jobs: found.jobs,
					...(found.error ? { discoveryError: found.error } : {}),
					children: all.filter((entry) => entry.parentId === id),
					wakeups: wakeups.list(id),
				};
			},
			async output(id, jobId) {
				await session(id);
				return jobs.output(id, jobId);
			},
			async stop(id, jobId, force) {
				await session(id);
				if (typeof force !== "boolean" || !jobs.stop(id, jobId, force)) throw new Error(words().exited);
			},
			async fullOutput(id, toolCallId) {
				await session(id);
				const messages = await ctx.sessions.messages(id);
				const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
				const details = result?.role === "toolResult" ? result.details : undefined;
				const path = details && typeof details === "object" && "outputPath" in details ? details.outputPath : undefined;
				if (typeof path !== "string") throw new Error(words().outputGone);
				const root = await realpath(join(ctx.appDataDir, "scratch", id, "tool-output"));
				const actual = await realpath(path);
				const part = relative(root, actual);
				if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error(words().outputGone);
				const file = await open(actual, "r");
				try {
					const stat = await file.stat();
					// 和文件预览一样限定一次读入量；完整日志仍保存在路径上，可从标题栏交给编辑器。
					const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
					const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
					return {
						path: actual,
						contents: { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: stat.size, modifiedAt: stat.mtimeMs, truncated: stat.size > bytesRead },
					};
				} finally {
					await file.close();
				}
			},
			async cancelWakeup(id, wakeupId) {
				await session(id);
				return typeof wakeupId === "string" && wakeups.cancel(id, wakeupId);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
