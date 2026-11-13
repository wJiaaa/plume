/**
 * 工具：read、write、edit、ls、glob、grep、bash、bash_output、monitor（见 `tools.ts`），和定时唤醒 schedule_wakeup、cron_create、cron_list、
 * cron_delete（见 `tools/wakeups.ts`）。monitor 和定时唤醒只列给顶层会话。命令经本体的 `ToolRun.exec` 跑，沙箱档由本体按权限模式定；
 * 后台任务经 `ToolRun.track` 登记进本体，定时唤醒经 `ToolRun.schedule` 交给本体调度。
 * 读写文件经本体的 `ToolRun.files`（读写边界、问人、资源地址、改动快照），可能改文件的命令带 `recordChanges` 交给本体观测，
 * 项目文件清单用本体的 `ctx.workspace.files`。本体登记着的资源地址（`ctx.resources.list()`）经 `model.context` 写成系统提示词的 `resources` 段。
 *
 * 状态按会话放在内存里（读过哪些文件、后台任务的输出读到哪了）：会话删掉时清掉。后台任务的进程由本体按登记停（删会话、退出应用、本插件停用）。
 */

import type { Plugin, ToolDefinition, ToolOutput, ToolRun } from "@plume/contract";
import { setLocaleSource } from "./messages.ts";
import { TOOLS } from "./tools.ts";
import { WAKEUP_TOOLS } from "./tools/wakeups.ts";
import { translatedShellCommand } from "./tools/reroute.ts";
import { toDefinition } from "./tools/types.ts";

/** 只列给顶层会话的工具，见 `model.context` 那一层。 */
const TOP_LEVEL_ONLY = new Set(["monitor", ...WAKEUP_TOOLS.map((tool) => tool.name)]);

export default {
	name: "plume.tools",
	apply(ctx) {
		setLocaleSource(() => ctx.locale());
		const states = new Map<string, Map<string, unknown>>();
		const state = (sessionId: string) => {
			let found = states.get(sessionId);
			if (!found) states.set(sessionId, (found = new Map()));
			return found;
		};

		ctx.hook("model.context", async (input, next) => {
			const text = addressesSection(ctx.resources.list());
			/*
			 * 子会话和插件的独立会话拿不到后台送达的渠道（`ToolRun.background`），monitor 和定时唤醒在那里送不出任何东西：不列给模型，而不是等它调了再报错——
			 * 没见过的工具模型不会要，一个错误却要白花一轮才知道此路不通。
			 */
			const tools = input.session.kind !== "top" ? input.tools.filter((tool) => !TOP_LEVEL_ONLY.has(tool.name)) : input.tools;
			return next({ ...input, tools, ...(text ? { sections: [...input.sections, { id: "resources", text }] } : {}) });
		});
		const env = { state, resources: ctx.resources, workspace: ctx.workspace, sessions: ctx.sessions };
		const own = new Map([...TOOLS, ...WAKEUP_TOOLS].map((tool) => [tool.name, toDefinition(tool, env)]));
		for (const definition of own.values()) ctx.tools.register(definition.name === "bash" ? withShortcut(definition, own, ctx.name) : definition);

		ctx.sessions.onDeleted((sessionId) => {
			states.delete(sessionId);
		});
		ctx.effect(() => {
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
