import type { AgentEvent, AlwaysAllow, ApprovalDecision, ApprovalRequest, HumanAnswer, HumanRequest, Log, PendingRequest } from "@plume/contract";
import { errorText, sameGrant } from "@plume/loop";
import type { ModelSettings } from "../model-settings.ts";
import type { PendingApproval, Session, Settled } from "./session.ts";

/** 权限请求没人答时等多久：等这么久没动静，多半没人在电脑前，按拒绝收场不放出任何本来没放的东西。 */
const PERMISSION_TIMEOUT_MS = 5 * 60_000;
/**
 * 等人给答案（`ToolRun.request`：提问、表单、计划）等得久得多：没答不是拒绝，多半是人走开了一会儿。
 * 照样有个头，无人值守的一轮不该卡在第一个问题上一整夜；卡片上有倒计时，截止时刻看得见。
 */
const QUESTION_TIMEOUT_MS = 30 * 60_000;

export interface ApprovalsDeps {
	approvalTimeoutMs: { permission?: number; question?: number } | undefined;
	modelSettings: Pick<ModelSettings, "change">;
	emit(event: AgentEvent): void;
	log: Log;
}

export interface Approvals {
	askUser(session: Session, request: ApprovalRequest, grant: AlwaysAllow | undefined, signal: AbortSignal): Promise<ApprovalDecision>;
	requestUser(session: Session, request: HumanRequest, signal: AbortSignal): Promise<HumanAnswer>;
}

export function createApprovals(deps: ApprovalsDeps): Approvals {
	const { approvalTimeoutMs, modelSettings, emit, log } = deps;

	/**
	 * 弹审批卡等人决定。同时跑的几个调用都要问时排队，一次只弹一张（等人给数据的 `request` 也排在同一队）：界面上同一时刻只有一张卡，
	 * 人一次也只回答一个问题；卡上写着后面还排着几张（+N）。
	 * 每张从问出来起计时，没人答到时按拒绝收场（时长见 `PERMISSION_TIMEOUT_MS`；`request` 的见 `QUESTION_TIMEOUT_MS`），排着的也在走：
	 * 截止时刻随卡片发给界面画倒计时。这一轮停了，排着的、弹着的一起收掉，都得到拒绝。
	 * 答「以后不再问」的把 `grant`（`tool-run.ts` 的 `approve` 已经按发起审批的一方归好名下）记进设置再放行；没有 `grant` 的
	 * （提权、层自己问的、没给 subject 的）只管这一次，不记。
	 */
	async function askUser(session: Session, request: ApprovalRequest, grant: AlwaysAllow | undefined, signal: AbortSignal): Promise<ApprovalDecision> {
		const outcome = await waitForAnswer(session, request, approvalTimeoutMs?.permission ?? PERMISSION_TIMEOUT_MS, signal);
		relayedBy(session, request.toolCallId, outcome);
		const decision = "decision" in outcome ? outcome.decision : "reject";
		if (decision === "always" && grant) {
			await modelSettings
				.change((settings) => {
					const granted = settings.alwaysAllow ?? [];
					if (!granted.some((one) => sameGrant(one, grant))) settings.alwaysAllow = [...granted, grant];
				})
				.catch((error: unknown) => log("agent", "error", `「以后不再问」没存上：${errorText(error)}`));
		}
		return decision;
	}

	/** 等人给一份数据（`ToolRun.request`）：和审批同一队、同一套撤卡规则，等得比审批久（`QUESTION_TIMEOUT_MS`）。 */
	async function requestUser(session: Session, request: HumanRequest, signal: AbortSignal): Promise<HumanAnswer> {
		const outcome = await waitForAnswer(session, request, approvalTimeoutMs?.question ?? QUESTION_TIMEOUT_MS, signal);
		relayedBy(session, request.toolCallId, outcome);
		if ("value" in outcome) return { answered: true, value: outcome.value };
		return { answered: false, reason: "gone" in outcome ? outcome.gone : "declined" };
	}

	/** 卡是代管插件替人答的：记下来，这次调用收场时写进结果（`ToolScope.answeredBy`）。 */
	function relayedBy(session: Session, toolCallId: string, outcome: Settled): void {
		if ("by" in outcome && outcome.by) (session.answeredBy ??= new Map()).set(toolCallId, outcome.by);
	}

	function waitForAnswer(session: Session, request: PendingRequest, timeout: number, signal: AbortSignal): Promise<Settled> {
		if (signal.aborted) return Promise.resolve({ gone: "stopped" });
		return new Promise((resolve) => {
			const entry: PendingApproval = {
				request: { ...request, expiresAt: Date.now() + timeout },
				settle: (outcome) => {
					const queue = session.approvals ?? [];
					const at = queue.indexOf(entry);
					if (at === -1) return;
					queue.splice(at, 1);
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					showApprovals(session);
					resolve(outcome);
				},
			};
			const onAbort = () => entry.settle({ gone: "stopped" });
			const timer = setTimeout(() => entry.settle({ gone: "expired" }), timeout);
			signal.addEventListener("abort", onAbort, { once: true });
			(session.approvals ??= []).push(entry);
			showApprovals(session);
		});
	}

	/** 告诉界面现在弹的是哪张、后面还排着几张。 */
	function showApprovals(session: Session): void {
		const [first, ...rest] = session.approvals ?? [];
		emit({
			type: "approval",
			sessionId: session.summary.id,
			approval: first?.request,
			...(rest.length > 0 ? { queuedApprovals: rest.length } : {}),
		});
	}

	return { askUser, requestUser };
}
