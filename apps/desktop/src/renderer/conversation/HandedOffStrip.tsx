/**
 * 输入框上方那一条：这个会话交出去的会话此刻怎么样了（计划交给新会话、建议的新会话、审阅会话，`handed-off.ts`）。
 *
 * 交出去以后这个会话多半停在那里，人盯着的是这个对话；那边在读什么、跑什么，不该要人去侧栏里找。
 * 它不画在转录里：转录记的是这个会话说过、做过的事，那边的进度不是这里发生的，钉在一处、聊到哪都看得见。
 * 只说一句（那边最近开始的那一步，和它自己转录里同一种说法），不画过程——过程在那个会话自己的转录里，点过去就是。
 * 本体按 `spawnedFrom` 画，不交给开会话的插件各画一份：三个插件画的是同一件事，开会话的插件也不该各自去读别的会话的事件。
 *
 * 外观跟着输入框上方的清单卡片走：同样的圆角、细边、一行 36px，不另加阴影。
 */

import type { SessionSummary } from "@plume/contract";
import { GLIDE, ScrollText, useI18n, useTickedAnimations } from "@plume/ui";
import { ChevronRight } from "@plume/ui/icons";
import { memo, useRef } from "react";
import { openReferencedSession } from "../plugins.tsx";
import { activityOf, useActivityVersion, waitingWords, waitOf } from "../sidebar/activity.ts";
import { SessionStatus } from "../sidebar/SessionRow.tsx";
import { notify } from "../toast/index.ts";
import { describeOne } from "./call-words.ts";
import { type HandedOff, handedOffFrom, useSessionDoing } from "./handed-off.ts";

const SAYS = { waiting: "sessionStatus.waiting", done: "sessionStatus.done", failed: "sessionStatus.failed" } as const;

export const HandedOffStrip = memo(function HandedOffStrip({ parentId, sessions }: { parentId: string; sessions: readonly SessionSummary[] }) {
	// 记号变了（等批准、跑完、看过）跟着重算；名单本身随会话列表来。
	useActivityVersion();
	const rows = handedOffFrom(sessions, activityOf, parentId);
	if (rows.length === 0) return null;
	return (
		<div data-handed-off="" className="pb-2">
			<div className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line-soft bg-card">
				{rows.map((row) => (
					<Row key={row.session.id} row={row} />
				))}
			</div>
		</div>
	);
});

function Row({ row }: { row: HandedOff }) {
	const { t } = useI18n();
	const { session } = row;
	const running = row.state === "running";
	const block = useSessionDoing(session.id, running);
	const state = running
		? block
			? describeOne(block, session.cwd)
			: undefined
		: row.state === "waiting"
			? waitingWords(waitOf(session.id), t)
			: t(SAYS[row.state as keyof typeof SAYS]);
	// 扫光按拍走，和转录里的运行行一样（`ticked.ts`）：每帧推会让整页跟着重画。
	const said = useRef<HTMLSpanElement>(null);
	useTickedAnimations(said, GLIDE, running);
	return (
		<button
			type="button"
			onClick={() => void openReferencedSession(session.id).catch(() => notify(t("peers.sessionGone"), "warn"))}
			data-handed-off-row={session.id}
			data-state={row.state}
			aria-label={state ? `${session.title} · ${state}` : session.title}
			className="plume-scroll flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-card-hover active:bg-elevated"
		>
			<SessionStatus session={session} running={running} />
			<ScrollText text={session.title} className="plume-fade-tail max-w-[45%] shrink-0 text-label text-ink-muted" />
			<span ref={said} className="min-w-0 flex-1" data-handed-off-state="">
				{state && <ScrollText text={state} className="plume-fade-tail text-label text-ink-faint" textClassName={running ? "plume-glide" : ""} />}
			</span>
			<ChevronRight size={12} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
		</button>
	);
}
