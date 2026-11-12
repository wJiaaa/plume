/**
 * MCP 服务中途要人填表（`elicitation/create`）：经正在调它的那次工具调用的 `run.request` 弹一张表（`kind` 是 `mcp-form`，
 * 界面入口按它画成表），人填的值从 `run.request` 回来，按字段再核一遍才交给服务。
 *
 * 只在恰好一个调用在等这台服务时问：没有调用在跑（服务自己冒出来的请求），或者几个会话同时在调它，都说不清该问谁，
 * 答「不给」。同一台服务的表一张一张来：服务连着要两样东西时，人不该同时面对两张卡。
 */

import type { ToolRun } from "@plume/contract";
import { checkFormValues, FORM_KIND, type FormField, type FormRequest } from "./form.ts";

/** 协议的回答。 */
export type ElicitAnswer = { action: "accept"; content: Record<string, string | number | boolean> } | { action: "decline" } | { action: "cancel" };

export class Forms {
	private readonly queues = new Map<string, Promise<unknown>>();
	/** 等人填表时那句状态（`HumanRequest.waiting`）。 */
	private readonly waiting: () => string | undefined;

	constructor(waiting: () => string | undefined = () => undefined) {
		this.waiting = waiting;
	}

	/** 弹一张表，等人填完。`server` 是服务名，卡片标题写它。 */
	ask(run: ToolRun, server: { id: string; name: string }, message: string, fields: FormField[]): Promise<ElicitAnswer> {
		const turn = (this.queues.get(server.id) ?? Promise.resolve()).then(() =>
			run.signal.aborted ? { action: "cancel" as const } : this.askNow(run, server.name, message, fields),
		);
		const tail = turn.catch(() => {});
		this.queues.set(server.id, tail);
		void tail.then(() => {
			if (this.queues.get(server.id) === tail) this.queues.delete(server.id);
		});
		return turn;
	}

	private async askNow(run: ToolRun, server: string, message: string, fields: FormField[]): Promise<ElicitAnswer> {
		const waiting = this.waiting();
		const reply = await run.request({ kind: FORM_KIND, title: server, payload: { message, fields } satisfies FormRequest, ...(waiting ? { waiting } : {}) });
		// 人没做决定（关了卡、停下这一轮、到时没人答），或者交回来的和表对不上：都是 cancel。
		if (!reply.answered) return { action: "cancel" };
		const value = (reply.value && typeof reply.value === "object" ? reply.value : {}) as { action?: unknown; values?: unknown };
		if (value.action === "decline") return { action: "decline" };
		if (value.action !== "accept") return { action: "cancel" };
		const checked = checkFormValues(fields, value.values);
		return checked.ok ? { action: "accept", content: checked.values } : { action: "cancel" };
	}
}
