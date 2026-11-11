/**
 * 上一轮停在了没做完的地方，这里给一个接着做的入口。按了停、退出应用、请求失败，都会留下做到一半的活，
 * 重新打一遍「继续」是唯一的另一条路，而它正是这个按钮做的事。
 * 刻意做成页面上最安静的东西：和时间戳一样的灰、一样的字号，它是一句注脚，不是警报。
 */

import type { SessionView } from "@plume/contract";
import { IconButton, useConfirmer, useI18n } from "@plume/ui";
import { Play, RotateCcw } from "@plume/ui/icons";
import { useMessageEdits } from "./message-edits.ts";
import { lastUserIndex } from "./revert-draft.ts";
import { carryOnPrompt, howItStopped, unfinishedTodos } from "./turn-stop.ts";

export function ResumeRow({ view, onCarryOn }: { view: SessionView; onCarryOn: (prompt: string) => void }) {
	const { t } = useI18n();
	const edits = useMessageEdits();
	const confirm = useConfirmer();
	// 派出去的后台运行还没回来，活就没停：它们回来，主会话接着干。先判这条，跑着时每一拍都不用扫整份转录。
	if (view.summary.running || view.summary.background || view.messages.length === 0) return null;
	const stop = howItStopped(view.summary, view.messages);
	const unfinished = unfinishedTodos(view.messages);
	const prompt = carryOnPrompt(stop, unfinished);
	if (!prompt) return null;
	// 失败那件事，上面的连接记录已经讲完了，还带着它自己的「继续」，这里不再讲一遍。
	if (stop === "error" && view.hiccups.some((hiccup) => hiccup.outcome === "gave_up")) return null;
	const note =
		stop === "user"
			? t("common.paused")
			: stop === "error"
				? t("resume.lastFailed")
				: stop === "interrupt"
					? t("resume.lastAborted")
					: t("resume.unfinished", { n: unfinished });
	// 重试从最近一条人说的话重问；转录里一条都没有时，它是个按了什么都不做的按钮，不如不摆。
	const retryAt = lastUserIndex(view.messages);
	const retryFrom = edits && retryAt >= 0 ? view.messages[retryAt] : undefined;
	return (
		<div className="mt-2.5 flex items-center gap-2 text-detail text-ink-faint" data-resume={stop ?? "unfinished"}>
			<span className="shrink-0 whitespace-nowrap">{note}</span>
			<span className="shrink-0 text-line">·</span>
			<IconButton
				size="sm"
				label={t("resume.carryOn")}
				ariaLabel={t("resume.continueLabel")}
				data-resume-continue
				onClick={() => onCarryOn(prompt)}
				icon={<Play size={11} strokeWidth={2} fill="currentColor" aria-hidden />}
			/>
			{/*
			 * 不是另一种「继续」：它丢掉这一轮的回复重问一遍。和「继续」并排正好覆盖一轮停下的两种读法：
			 * 做到的值得留、把剩下的做完，或者前面就走偏了、整个回答重来。提示里说清是哪一种，因为其中一种会丢东西。
			 */}
			{edits && retryFrom?.role === "user" && (
				<IconButton
					size="sm"
					label={t("resume.regenerateHint")}
					ariaLabel={t("resume.retryLabel")}
					data-resume-retry
					// 先问一句：「继续」留下这一轮做过的全部，重试全丢掉再花一遍；一轮读了几十万 token 的代码时按错就是再花一遍。
					onClick={() =>
						confirm.ask({
							title: t("resume.regenerateConfirm"),
							detail: (
								<>
									{t("resume.retryDetail")}
									<br />
									{t("resume.retryKeep")}
								</>
							),
							confirmLabel: t("resume.regenerate"),
							onConfirm: () => void edits.retry(retryAt, retryFrom),
						})
					}
					icon={<RotateCcw size={11} strokeWidth={2} aria-hidden />}
				/>
			)}
			{confirm.element}
		</div>
	);
}
