/**
 * 连接抖了一下，在它发生的那个位置说一句，用它该有的音量：等待时数着秒，接上了留一行灰字，
 * 真没救了才换成一句失败，配一个中性的底和唯一的下一步。没有红字，因为这多半不是谁做错了什么。
 */

import type { Hiccup } from "@plume/contract";
import { IconButton, StatusSpinner, useI18n, useNow } from "@plume/ui";
import { ArrowLeftRight, ChevronRight, CircleAlert, CircleCheck, CircleStop, Play, Settings2 } from "@plume/ui/icons";
import { useState } from "react";
import { describeHiccup, hiccupTip } from "./hiccup-text.ts";

export function HiccupRow({ hiccup, onCarryOn, onOpenSettings }: { hiccup: Hiccup; onCarryOn?: () => void; onOpenSettings: () => void }) {
	// 只有还在等的那条要数秒，其余的一次都不用重画。
	const now = useNow(hiccup.outcome === "waiting", 500);
	const [open, setOpen] = useState(false);
	const line = describeHiccup(hiccup, now);
	const tip = hiccupTip(hiccup);
	const failed = hiccup.outcome === "gave_up";
	const expandable = Boolean(hiccup.detail && hiccup.detail !== hiccup.summary);
	// 放弃了的那条给一个边界，否则它看起来仍像随时会自己好；等待和恢复是过程里的事，不比旁边的正文显眼。
	const shell = failed
		? "flex w-full max-w-[62ch] flex-col gap-1.5 rounded-panel border border-line bg-card px-3.5 py-3"
		: "flex w-fit max-w-full flex-col gap-1.5 px-0.5";

	const lead = (
		<>
			<Icon outcome={hiccup.outcome} />
			{/* `min-w-0` 让 truncate 真能截：flex 子项默认不肯缩到内容宽度以下，一句长错误会把转录顶宽。 */}
			<span
				data-plume-tip={tip}
				data-plume-tip-side="top"
				className={`min-w-0 flex-1 truncate tabular-nums ${failed ? "text-label text-ink-muted" : "text-detail text-ink-faint"}`}
			>
				{line}
			</span>
		</>
	);

	return (
		<div className={shell} data-hiccup={hiccup.outcome}>
			<div className="flex min-w-0 items-center gap-2.5">
				{/* 有原文可看时整段是一颗按钮，点在字上也能展开；下一步留在按钮外面，按钮里不能再套按钮。 */}
				{expandable ? (
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen((was) => !was)}
						className="group/hiccup flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
					>
						{lead}
						<span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-faint transition-colors group-hover/hiccup:text-ink-muted">
							<ChevronRight size={10} strokeWidth={2} aria-hidden className={`transition-transform ${open ? "rotate-90" : ""}`} />
						</span>
					</button>
				) : (
					lead
				)}
				{failed && <Next hint={hiccup.hint} onCarryOn={onCarryOn} onOpenSettings={onOpenSettings} />}
			</div>
			{/* 中转的错误体动辄一整页 JSON：给它一个限高、可滚的盒子，不把上面的对话推出屏幕。 */}
			{open && hiccup.detail && (
				<pre className="max-h-[10lh] overflow-y-auto rounded-field bg-input px-2.5 py-2 text-detail whitespace-pre-wrap text-ink-faint">{hiccup.detail}</pre>
			)}
		</div>
	);
}

function Icon({ outcome }: { outcome: Hiccup["outcome"] }) {
	if (outcome === "waiting") return <StatusSpinner size={13} className="text-ink-faint" />;
	if (outcome === "recovered") return <CircleCheck size={13} strokeWidth={2} className="shrink-0 text-ink-faint" />;
	// 换了模型：没接上、也没放弃，是换了个人接着问，跟对勾一样安静，但不是对勾。
	if (outcome === "switched") return <ArrowLeftRight size={13} strokeWidth={2} className="shrink-0 text-ink-faint" />;
	// 人按了停：这一停是人的决定，不是故障，和对勾一样安静。
	if (outcome === "stopped") return <CircleStop size={13} strokeWidth={2} className="shrink-0 text-ink-faint" />;
	return <CircleAlert size={15} strokeWidth={1.8} className="shrink-0 text-ink-muted" />;
}

/** 停下来之后唯一的那个下一步：密钥、模型不对就去设置，别的（没有提示的失败）接着做。 */
function Next({ hint, onCarryOn, onOpenSettings }: { hint?: string; onCarryOn?: () => void; onOpenSettings: () => void }) {
	const { t } = useI18n();
	if (hint === "check-key" || hint === "check-model") {
		return <IconButton size="sm" label={t("common.goSettings")} onClick={onOpenSettings} icon={<Settings2 size={11.5} strokeWidth={1.9} aria-hidden />} />;
	}
	// 插件的子会话里没有「继续」：那里的一轮只有插件能发起。
	if (hint || !onCarryOn) return null;
	return (
		<IconButton
			size="sm"
			label={t("composer.finishUnfinished")}
			ariaLabel={t("common.continue")}
			data-resume-continue
			onClick={onCarryOn}
			icon={<Play size={11} strokeWidth={2} fill="currentColor" aria-hidden />}
		/>
	);
}
