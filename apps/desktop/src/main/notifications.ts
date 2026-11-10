/** 主进程独占系统通知：不随渲染窗口数目重复发送，隐藏窗口时仍能收到。 */
import type { AgentEvent, Locale, SessionSummary } from "@plume/contract";
import { notificationBody } from "./i18n.ts";

interface Notice {
	title: string;
	body: string;
	silent: boolean;
}
interface Notification {
	on(event: "click", listener: () => void): void;
	show(): void;
}
export function createNotifications(deps: {
	active(): boolean;
	supported(): boolean;
	locale(): Locale;
	create(options: Notice): Notification;
	open(sessionId: string): void;
}) {
	let sessions = new Map<string, SessionSummary>();
	const approvals = new Map<string, string>();
	const rootOf = (id: string): SessionSummary | undefined => {
		const seen = new Set<string>();
		let session = sessions.get(id);
		while (session?.parentId && !seen.has(session.id)) {
			seen.add(session.id);
			session = sessions.get(session.parentId);
		}
		return session;
	};
	const show = (id: string, kind: "done" | "approval" | "question", detail?: string) => {
		if (!deps.supported() || deps.active()) return;
		const session = rootOf(id);
		// 插件的独立会话画在插件自己的页面里，点通知打不开它；要人来看由插件在页面那一行挂提醒（`ui.pageBadge`）。
		if (session?.owner) return;
		const notification = deps.create({ title: "Plume", body: notificationBody(deps.locale(), kind, session?.title.trim(), detail), silent: false });
		notification.on("click", () => deps.open(session?.id ?? id));
		notification.show();
	};
	return (event: AgentEvent): void => {
		if (event.type === "approval") {
			if (!event.approval) {
				approvals.delete(event.sessionId);
				return;
			}
			if (approvals.get(event.sessionId) === event.approval.toolCallId) return;
			approvals.set(event.sessionId, event.approval.toolCallId);
			// 只能由人答的（提问、表单、计划）说「等待回复」，其余是批准。正文是插件给的那句状态，没给就用卡片标题；
			// 不拿 `detail`：那是卡片正文，插件的卡多半在里面放 JSON。
			const question = event.approval.userOnly === true;
			show(event.sessionId, question ? "question" : "approval", event.approval.waiting ?? event.approval.title);
		}
		if (event.type === "idle") show(event.sessionId, "done");
		if (event.type === "sessions") {
			sessions = new Map(event.sessions.map((session) => [session.id, session]));
			for (const id of approvals.keys()) if (!sessions.has(id)) approvals.delete(id);
		}
	};
}
