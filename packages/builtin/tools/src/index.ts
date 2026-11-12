/**
 * 工具：read、write、edit、ls、glob、grep、bash、bash_output、monitor（见 `tools.ts`），和定时唤醒 schedule_wakeup、cron_create、cron_list、
 * cron_delete（见 `tools/wakeups.ts`）。monitor 和定时唤醒只列给顶层会话。命令经本体的 `ToolRun.exec` 跑，沙箱档由本体按权限模式定。
 * 提供服务 `session.wakeups`（待触发的定时唤醒）、`file.changes`（改动快照和撤销）、`file.read`（读取授权）、`project.files`（项目里该看哪些文件）、`resources`（资源地址，见 `resources/`）；
 * 地址清单经 `model.context` 加成系统提示词的 `resources` 段。
 *
 * 状态按会话放在内存里（读过哪些文件、后台任务）：会话删掉时停掉它的后台任务、清掉它的状态，插件停用（退出应用）时全部停掉。
 */

import type { Plugin, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import { setLocaleSource, words } from "./messages.ts";
import { ArtifactStore, artifactResource, pluginResource, scratchResource, sessionResource } from "./resources/handlers.ts";
import { readOnly, ResourceRouter } from "./resources/router.ts";
import { TOOLS } from "./tools.ts";
import { disposeBackgroundJobs } from "./tools/background-jobs.ts";
import { existingWakeups, WAKEUP_TOOLS } from "./tools/wakeups.ts";
import { createJobsService } from "./tools/jobs-service.ts";
import { setDataDir } from "./tools/home.ts";
import { beginPrompt, waitForChangesIdle } from "./tools/change-lock.ts";
import { createFileChangesService, removeFileChanges } from "./tools/file-changes.ts";
import { gitListedFiles } from "./tools/project-files.ts";
import { authorizeRead } from "./tools/read-access.ts";
import { translatedShellCommand } from "./tools/reroute.ts";
import { toDefinition, toolContext } from "./tools/types.ts";

/** 只列给顶层会话的工具，见 `model.context` 那一层。 */
const TOP_LEVEL_ONLY = new Set(["monitor", ...WAKEUP_TOOLS.map((tool) => tool.name)]);

export default {
	name: "plume.tools",
	// 定时唤醒可能排在任何会话里，要知道每个会话的一轮什么时候收场（见下面的 `running`）：要看全部会话。
	observe: "all",
	apply(ctx) {
		// 文件工具不写 Plume 的数据目录：那里有设置和会话，见 `tools/home.ts`。
		setDataDir(ctx.appDataDir);
		setLocaleSource(() => ctx.locale());
		const states = new Map<string, Map<string, unknown>>();
		const state = (sessionId: string) => {
			let found = states.get(sessionId);
			if (!found) states.set(sessionId, (found = new Map()));
			return found;
		};
		ctx.provide("file.changes", createFileChangesService(ctx.dataDir, ctx.sessions));
		ctx.provide("project.files", { list: gitListedFiles });
		ctx.provide("background.jobs", createJobsService(states));
		ctx.provide("session.wakeups", {
			list: (sessionId) => existingWakeups(states.get(sessionId))?.list() ?? [],
			cancel: (sessionId, id) => existingWakeups(states.get(sessionId))?.cancel(id) ?? false,
		});
		// 到点送进去的那一轮收场以后，循环任务下次到点才照常送（见 `SessionWakeups.turnEnded`）。
		ctx.sessions.observe(({ sessionId, event }) => {
			if (event.type === "running" && !event.running) existingWakeups(states.get(sessionId))?.turnEnded();
		});
		/*
		 * 人按停，定时唤醒一起取消（续跑是模型的决定，按停就是收回它），取消了就说一声：那是模型说过「过一会儿再看」的事，
		 * 悄悄没了，人会一直等。撤回、删会话不走这里。
		 */
		ctx.sessions.onStopped((sessionId) => {
			const cancelled = existingWakeups(states.get(sessionId))?.cancelAll() ?? 0;
			if (cancelled > 0) ctx.notice(sessionId, words().wakeupsCancelled(cancelled));
		});

		const resources = new ResourceRouter();
		const artifacts = new ArtifactStore();
		for (const handler of [scratchResource, artifactResource(artifacts), sessionResource(ctx.sessions), pluginResource(() => ctx.plugins.list())])
			resources.register(handler);
		ctx.provide("resources", {
			register: (handler) => resources.register(readOnly(handler)),
			keepArtifact: (sessionId, tool, content) => artifacts.keep(sessionId, tool, content),
		});
		ctx.hook("model.context", async (input, next) => {
			const text = addressesSection(resources.schemes());
			/*
			 * 子会话和插件的独立会话拿不到后台送达的渠道（`ToolRun.background`），monitor 和定时唤醒在那里送不出任何东西：不列给模型，而不是等它调了再报错——
			 * 没见过的工具模型不会要，一个错误却要白花一轮才知道此路不通。
			 */
			const tools = input.session.kind !== "top" ? input.tools.filter((tool) => !TOP_LEVEL_ONLY.has(tool.name)) : input.tools;
			return next({ ...input, tools, ...(text ? { sections: [...input.sections, { id: "resources", text }] } : {}) });
		});
		ctx.hook(
			"prompt.submit",
			async (input, next) => {
				const release = beginPrompt();
				if (!release) return { block: true, reason: words().undoBusy };
				try {
					return await next(input);
				} finally {
					release();
				}
			},
			{ order: -10_000 },
		);
		const env = { state, dataDir: ctx.dataDir, resources };
		ctx.provide("file.read", { authorize: (run, path) => authorizeRead(toolContext(run, env), path) });
		const own = new Map([...TOOLS, ...WAKEUP_TOOLS].map((tool) => [tool.name, toDefinition(tool, env)]));
		for (const definition of own.values()) ctx.tools.register(definition.name === "bash" ? withShortcut(definition, own, ctx.name) : definition);

		const stop = (sessionId: string, found: Map<string, unknown>) => {
			existingWakeups(found)?.dispose();
			for (const error of disposeBackgroundJobs(found))
				ctx.log.warn(`会话 ${sessionId} 的后台任务停不掉：${error instanceof Error ? error.message : String(error)}`);
		};
		ctx.sessions.onDeleted(async (sessionId) => {
			const found = states.get(sessionId);
			if (found) stop(sessionId, found);
			states.delete(sessionId);
			artifacts.forget(sessionId);
			await removeFileChanges(ctx.dataDir, sessionId, found);
		});
		// 后台任务（开发服务器之类）跟着停：它们的进程组是分离的，agent 进程退出不会带走它们。
		ctx.effect(async () => {
			for (const [sessionId, found] of states) stop(sessionId, found);
			await waitForChangesIdle();
			states.clear();
		});
	},
} satisfies Plugin;

/**
 * 地址清单，只在有地址时写。说成「凡是能写路径的地方都能用」：模型本来就会 read，地址空间比一个命名空间一个工具好，
 * 就好在不用学新东西。
 */
function addressesSection(schemes: { scheme: string; describe: string; writable: boolean }[]): string {
	if (schemes.length === 0) return "";
	// i18n-exempt：写进系统提示词、给模型看的。
	const lines = schemes.map((s) => `- \`${s.scheme}://\` ${s.describe}${s.writable ? "（可写）" : ""}`);
	return (
		"## Addresses\n\n" +
		"These work wherever a file path does — in `read`, and in `write` where marked writable:\n" +
		`${lines.join("\n")}\n\n` +
		"A trailing `:10-40` selects lines; a bare `scheme://` lists what is in it. Use these instead of guessing at filenames on disk."
	);
}

/**
 * 无歧义的 `cat a`、`ls d`、`rg x d` 当场改用 read、ls、grep 执行：回一个「请用 read」的错误再等一轮，白花一整个请求。
 * 只换执行的那一下，钩子仍按模型调用的 bash 跑：转录里、模型眼里、写钩子的人对着的都是那条命令。
 * 提权、后台运行的不改道；目标工具被别的插件覆盖了也不改道，那是它的工具，不归这里替它决定。
 */
function withShortcut(bash: ToolDefinition, own: ReadonlyMap<string, ToolDefinition>, plugin: string): ToolDefinition {
	return {
		...bash,
		async execute(args, run): Promise<ToolOutput> {
			const swap = shortcut(args, run, own, plugin);
			if (!swap) return bash.execute(args, run);
			const result = await swap.tool.execute(swap.args, run);
			return { ...result, output: `${result.output}\n[Executed with ${swap.tool.name}; use that tool directly next time.]` };
		},
	};
}

function shortcut(
	args: Record<string, unknown>,
	run: ToolRun,
	own: ReadonlyMap<string, ToolDefinition>,
	plugin: string,
): { tool: ToolDefinition; args: Record<string, unknown> } | undefined {
	const { command, escalate, run_in_background } = args;
	if (typeof command !== "string" || escalate !== undefined || run_in_background === true) return undefined;
	const target = translatedShellCommand(command);
	if (!target || !run.tools().some((entry) => entry.name === target.name && entry.plugin === plugin)) return undefined;
	const tool = own.get(target.name);
	return tool ? { tool, args: target.args } : undefined;
}
