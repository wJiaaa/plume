import type { Message } from "@plume/contract";
import { motionReduced } from "@plume/ui";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RunningIndicator } from "./RunningIndicator.tsx";
import { answeredCleanly, leadsTheTurn, looksLikeAnswer, proseLength } from "./running-line.ts";

/** 结论停多久，运行行回来：等屏幕上的字也停稳了；再短，服务商一阵一停的正常节奏会让它在结论底下一闪一闪。 */
const STALL_MS = 2000;

/**
 * 转录底下的「运行中」那一行，跟着这一轮展开、收起。
 *
 * 显示的东西比这一轮多活一次收起：收起开始那一帧就清空的话，收起没东西可演，贴底的转录一下子掉掉整行的高度。
 *
 * 结论流进来时它只是看不见，位置照旧占着（`looksLikeAnswer`）：挂在结论底下的话，表格、代码块每长出一截它就被推下去一截。
 * 这一轮调工具之前的话也藏（`leadsTheTurn`）。看不见是当帧的，不淡出；工具调用接上来、它重新出现时照旧淡入。
 * 结论停住了（`STALL_MS` 没长）它也回来：字不动就没什么可跳的，一直藏着又看不出是在写还是卡住了。
 *
 * 回答写完（`answeredCleanly`）以后它先只是看不见，等 `running` 落下那一次提交才当帧收起，不走过渡。
 * 展开是当帧的，只淡入：发送时这一行和那条消息在同一次提交里出现，转录当帧贴底。
 */
export const RunningRow = memo(function RunningRow({
	running,
	compacting,
	messages,
	startedAt,
	waiting,
	waitingText,
	retrying,
}: {
	running: boolean;
	compacting: boolean;
	/** 转录加上正在写的那条回复。 */
	messages: readonly Message[];
	/** 正在执行的调用开始的时刻。 */
	startedAt: Readonly<Record<string, number>>;
	waiting: "approval" | "answer" | undefined;
	/** 插件给的「在等什么」（`ApprovalRequest.waiting`）。 */
	waitingText?: string | undefined;
	retrying: boolean;
}) {
	const open = running && !compacting;
	const answering = looksLikeAnswer(messages) || leadsTheTurn(messages);
	const answered = answeredCleanly(messages);
	const stalled = useStalled(proseLength(messages), open && answering);
	// 收起时沿用收起前那一刻的隐/显：结论写到一半被停下时这一行正隐着，不能在往下收的那一阵把运行中淡入回来。
	const quietNow = open && ((answering && !stalled) || answered);
	const [foldQuiet, setFoldQuiet] = useState(quietNow);
	if (open && foldQuiet !== quietNow) setFoldQuiet(quietNow);
	const [retained, setRetained] = useState(open);
	const quiet = open ? quietNow : foldQuiet && retained;
	useLayoutEffect(() => {
		if (open) setRetained(true);
		else if (answered || motionReduced()) setRetained(false);
	}, [open, answered]);
	return (
		<div
			className="plume-reveal"
			data-open={open}
			aria-hidden={!open || quiet}
			// 过渡按变化之后的样式取：打开时只剩透明度，收起时回到 `.plume-reveal` 的整套。
			style={answered ? { transition: "none" } : open ? { transition: "opacity var(--plume-t-base) var(--plume-e-out)" } : undefined}
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "grid-template-rows" && !open) setRetained(false);
			}}
		>
			<div>
				<div
					data-plume-running-quiet={quiet || undefined}
					className={`transition-opacity ${quiet ? "opacity-0 duration-0" : "duration-[var(--plume-t-base)]"}`}
				>
					{(open || retained) && <RunningIndicator messages={messages} startedAt={startedAt} waiting={waiting} waitingText={waitingText} retrying={retrying} />}
				</div>
			</div>
		</div>
	);
});

/**
 * 末尾那段正文已经 `STALL_MS` 没长了。在渲染时现读时钟：字一长，同一次渲染里就不再算停。停住那一刻什么都不变，由计时器叫醒一次。
 * 正文写完、在等这条回复收尾的时候 `length` 是空的，不算停住。
 */
function useStalled(length: number | undefined, watching: boolean): boolean {
	const grew = useRef<{ length: number | undefined; at: number }>({ length, at: Date.now() });
	if (grew.current.length !== length) grew.current = { length, at: Date.now() };
	const [, wake] = useState(0);
	const at = grew.current.at;
	useEffect(() => {
		if (!watching || length === undefined) return;
		const left = STALL_MS - (Date.now() - at);
		if (left <= 0) return;
		const timer = setTimeout(() => wake((n) => n + 1), left);
		return () => clearTimeout(timer);
	}, [at, length, watching]);
	return watching && length !== undefined && Date.now() - at >= STALL_MS;
}
