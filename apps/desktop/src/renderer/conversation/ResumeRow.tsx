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
import type { Resume } from "./turn-stop.ts";

/** `resume` 由 `Transcript` 算好传进来：运行行要按同一个判断决定收起时当不当帧。 */
export function ResumeRow({ view, resume, onCarryOn }: { view: SessionView; resume: Resume; onCarryOn: (prompt: string) => void }) {
	const { t } = useI18n();
	const edits = useMessageEdits();
	const confirm = useConfirmer();
	const { stop, unfinished, prompt } = resume;
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
		// 8px 加 20px 高的按钮，和运行行一样高：停下、继续时两行同一帧一出一进，字不上下错。见 `RunningIndicator`。
		<div className="mt-2 flex items-center gap-2 text-detail text-ink-faint" data-resume={stop ?? "unfinished"}>
			<span className="shrink-0 whitespace-nowrap">{note}</span>
			<span className="shrink-0 text-line">·</span>
			<IconButton
				size="xs"
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
					size="xs"
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
