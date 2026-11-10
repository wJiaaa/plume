/**
 * MCP 服务中途要人填表（`elicitation/create`）：经正在调它的那次工具调用的 `run.ask` 弹一张审批卡（`kind` 是 `mcp-form`，
 * 界面入口按它认出来画成表），人在卡上填的值经 `answer` 先交到这里，卡片再 `respond`；`run.ask` 返回后取走。
 *
 * 只在恰好一个调用在等这台服务时问：没有调用在跑（服务自己冒出来的请求），或者几个会话同时在调它，都说不清该问谁，
 * 答「不给」。同一台服务的表一张一张来：服务连着要两样东西时，人不该同时面对两张卡。
 */

import { randomUUID } from "node:crypto";
import type { ToolRun } from "@plume/contract";
import { checkFormValues, FORM_KIND, type FormAnswer, type FormField, type FormRequest } from "./form.ts";

/** 协议的回答。 */
export type ElicitAnswer = { action: "accept"; content: Record<string, string | number | boolean> } | { action: "decline" } | { action: "cancel" };

export class Forms {
	private readonly pending = new Map<string, { fields: FormField[]; answer?: FormAnswer }>();
	private readonly queues = new Map<string, Promise<unknown>>();
	/** 等人填表时那句状态（`ApprovalRequest.waiting`）。 */
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
		const form = randomUUID();
		this.pending.set(form, { fields });
		try {
			const request: FormRequest = { form, message, fields };
			// `userOnly`：填什么是人的决定，完全访问、「以后不再问」都不替人答。
			const waiting = this.waiting();
			await run.ask({ kind: FORM_KIND, title: server, detail: JSON.stringify(request), userOnly: true, ...(waiting ? { waiting } : {}) });
			const answer = this.pending.get(form)?.answer;
			// 卡上没交回答（产品的通用卡、停下了这一轮）：人没做决定。
			if (!answer) return { action: "cancel" };
			return answer.action === "accept" ? { action: "accept", content: answer.values } : answer;
		} finally {
			this.pending.delete(form);
		}
	}

	/** 卡片交来的回答。渲染进程交来的，按字段再核一遍。`gone`：这张表已经不等了（这一轮停了）；`invalid`：和表对不上。 */
	answer(form: unknown, raw: unknown): "gone" | "invalid" | undefined {
		const entry = typeof form === "string" ? this.pending.get(form) : undefined;
		if (!entry) return "gone";
		const action = raw && typeof raw === "object" ? (raw as { action?: unknown }).action : undefined;
		if (action === "decline" || action === "cancel") {
			entry.answer = { action };
			return undefined;
		}
		const checked = checkFormValues(entry.fields, (raw as { values?: unknown } | undefined)?.values);
		if (action !== "accept" || !checked.ok) return "invalid";
		entry.answer = { action: "accept", values: checked.values };
		return undefined;
	}
}
