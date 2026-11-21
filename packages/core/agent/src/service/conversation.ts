import type { AgentService, OutgoingMessage, UserMessage } from "@plume/contract";
import { text } from "../i18n.ts";
import type { Lifecycle } from "../session/lifecycle.ts";
import type { Messages } from "../session/messages.ts";
import type { Occupancy } from "../session/occupancy.ts";
import type { Queueing } from "../session/queueing.ts";
import type { Registry } from "../session/registry.ts";

export interface ConversationServiceDeps {
	registry: Pick<Registry, "find">;
	messages: Pick<Messages, "sentAt" | "rewindFiles" | "rewind">;
	lifecycle: Pick<Lifecycle, "stopSession">;
	occupancy: Pick<Occupancy, "held" | "begin" | "looping">;
	queueing: Pick<Queueing, "handed" | "queues" | "steer" | "enqueue" | "enqueueTask" | "queuedPrompt">;
	userMessage(input: OutgoingMessage): UserMessage;
	quitting(): boolean;
}

export function conversationService(
	deps: ConversationServiceDeps,
): Pick<
	AgentService,
	| "send"
	| "queue"
	| "sendQueued"
	| "steerQueued"
	| "removeQueued"
	| "moveQueued"
	| "queueTask"
	| "retryTask"
	| "dismissTask"
	| "editMessage"
	| "revertMessage"
	| "revertPlan"
	| "stop"
	| "respond"
	| "answer"
> {
	const {
		registry: { find },
		messages: { sentAt, rewindFiles, rewind },
		lifecycle: { stopSession },
		occupancy: { held, begin, looping },
		queueing: { handed, queues, steer, enqueue, enqueueTask, queuedPrompt },
		userMessage,
		quitting,
	} = deps;
	return {
		send(sessionId, message) {
			const session = find(sessionId);
			// 子会话里只有建它的插件能发起一轮（`ctx.sessions.send`），界面的输入框也经插件。
			if (session.summary.owner) throw new Error(text("session.pluginOwned", { plugin: session.summary.owner }));
			if (quitting()) throw new Error(text("session.parentStopped"));
			// 一轮收尾后的压缩不挡人：新的一轮停下它，开头照常再看一次要不要压，缓存还热就照样分叉。
			if (session.controller && message?.interrupt !== true && session.controller !== session.idleHold) {
				if (message?.steer !== true) throw new Error(text("session.running"));
				steer(session, message);
				return;
			}
			const prompt = userMessage(message);
			// 打断：停下正在跑的那一轮，等它把没答的调用补完、写完会话，再开新的一轮。
			begin(session, prompt);
		},
		async queue(sessionId, message, preview) {
			return enqueue(find(sessionId), message, typeof preview === "string" ? preview : "");
		},
		async sendQueued(sessionId, id) {
			const session = find(sessionId);
			if (session.summary.owner) throw new Error(text("session.pluginOwned", { plugin: session.summary.owner }));
			if (quitting()) throw new Error(text("session.parentStopped"));
			const entry = queues.take(session.summary.id, String(id));
			// 打断：停下正在跑的那一轮，等它把没答的调用补完、写完会话，再拿这一条开新的一轮。
			if (entry) begin(session, queuedPrompt(entry, session.controller !== undefined));
		},
		async steerQueued(sessionId, id) {
			const session = find(sessionId);
			if (session.summary.owner) throw new Error(text("session.pluginOwned", { plugin: session.summary.owner }));
			const entry = queues.list(session.summary.id).find((each) => each.id === String(id));
			// 子会话交过来的、代管插件转来的是一件要单独开一轮、单独落定的事，不插进别的轮里。
			if (!entry || !held(session)) return;
			queues.promote(session.summary.id, entry.id, looping(session) && !entry.origin);
		},
		async removeQueued(sessionId, id) {
			return queues.take(find(sessionId).summary.id, String(id));
		},
		async moveQueued(sessionId, id, targetId, placement) {
			queues.move(find(sessionId).summary.id, String(id), String(targetId), placement === "after" ? "after" : "before");
		},
		async queueTask(sessionId, instruction) {
			const child = find(sessionId);
			if (!child.summary.parentId) throw new Error(text("session.notChild"));
			enqueueTask(child, instruction);
		},
		async retryTask(sessionId, taskId) {
			const child = find(sessionId);
			if (!child.summary.parentId) throw new Error(text("session.notChild"));
			if (quitting()) throw new Error(text("session.parentStopped"));
			const task = handed.takeResumable(child.summary.id, String(taskId));
			if (!task) return false;
			enqueueTask(child, task.text);
			return true;
		},
		async dismissTask(sessionId, taskId) {
			return handed.dismiss(find(sessionId).summary.id, String(taskId));
		},
		async editMessage(sessionId, index, message, options) {
			const session = find(sessionId);
			// 最后一个参数可能是运行时追加的 CallContext：`files` 只认明确的 true，`timestamp` 只认数字。
			const at = await sentAt(session, index, { reask: true, timestamp: options?.timestamp });
			const prompt = userMessage(message);
			if (quitting()) throw new Error(text("session.parentStopped"));
			// 文件先退回去，退不回去就整件不做：对话不截、也不重发。插件的子会话不退文件（界面也不问），见 `sentAt`。
			if (options?.files === true) {
				if (session.summary.owner) throw new Error(text("session.pluginOwned", { plugin: session.summary.owner }));
				await rewindFiles(session, at, true);
			}
			// 中间等过读库：再看一眼，这期间开始的一轮不能被截掉一半。
			if (held(session)) throw new Error(text("session.running"));
			await rewind(session, at);
			begin(session, prompt);
		},
		async revertMessage(sessionId, index, options) {
			const session = find(sessionId);
			const at = await sentAt(session, index, { timestamp: options?.timestamp });
			// 先文件后对话：文件退不回去，对话也不截，人看到的还是撤回之前的样子。
			if (options?.files === true) await rewindFiles(session, at, true);
			if (held(session)) throw new Error(text("session.running"));
			await rewind(session, at);
		},
		async revertPlan(sessionId, index, options) {
			const session = find(sessionId);
			// 不带 `options` 时这一位是运行时追加的 CallContext，`timestamp` 只认数字。
			const at = await sentAt(session, index, { timestamp: options?.timestamp });
			return rewindFiles(session, at, false);
		},
		stop(sessionId) {
			stopSession(find(sessionId));
		},
		respond(sessionId, toolCallId, decision) {
			const pending = find(sessionId).approvals?.[0];
			if (pending?.request.toolCallId !== toolCallId) return;
			// 等人给数据的卡上「允许」没有意思：人只能交数据（`answer`）或不答。
			if (pending.request.type === "request") {
				if (decision === "reject") pending.settle({ decision: "reject" });
				return;
			}
			pending.settle({ decision: decision === "once" || decision === "always" ? decision : "reject" });
		},
		answer(sessionId, toolCallId, value) {
			const pending = find(sessionId).approvals?.[0];
			if (pending?.request.type !== "request" || pending.request.toolCallId !== toolCallId) return;
			pending.settle({ value });
		},
	};
}
