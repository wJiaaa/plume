import type { ProjectEntry } from "@plume/contract";
import { Scroller, useI18n } from "@plume/ui";
import { Bug, Hammer, RefreshCw, Telescope } from "@plume/ui/icons";
import type { ReactNode } from "react";
/*
 * 标题上方的插图：透明底的半身像（480px，常规 200px 的两倍还有余）。不用应用图标：那张带浅色圆角底，
 * 放在页面中间像一块贴上去的方片。
 */
import mark from "../../assets/welcome-mark.png";

const PROMPTS = [
	{ icon: Telescope, label: "empty.explore", prompt: "empty.explorePrompt" },
	{ icon: Hammer, label: "empty.build", prompt: "empty.buildPrompt" },
	{ icon: RefreshCw, label: "empty.review", prompt: "empty.reviewPrompt" },
	{ icon: Bug, label: "empty.fix", prompt: "empty.fixPrompt" },
] as const;

/** 欢迎页可滚动：最小窗口里输入框长高后，建议和发送按钮仍然能到达。 */
export function Welcome({
	project,
	compact,
	children,
	onDraft,
}: {
	project?: ProjectEntry;
	compact: boolean;
	children: ReactNode;
	onDraft: (text: string) => void;
}) {
	const { t } = useI18n();
	const size = compact ? 160 : 200;
	return (
		<Scroller className="flex-1" contentClassName="flex flex-col items-center px-6 pb-4 after:min-h-4 after:flex-1 after:content-['']">
			<div aria-hidden className="w-full shrink" style={{ flexBasis: `max(1rem, calc(29dvh - ${size + 24}px))` }} />
			<img src={mark} alt="" aria-hidden draggable={false} width={size} height={size} className="plume-welcome-mark shrink-0 select-none" />
			<h1 className={`mt-6 w-full shrink-0 text-center font-medium text-balance text-ink ${compact ? "text-heading" : "text-display"}`}>
				{project ? t("empty.projectQuestion", { project: project.name }) : t("empty.chat")}
			</h1>
			<div className="mt-11 w-full max-w-2xl shrink-0">{children}</div>
			<div className="mt-6 flex w-full max-w-2xl shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-3">
				{PROMPTS.map(({ icon: Icon, label, prompt }) => (
					<button
						key={label}
						type="button"
						className="plume-draft-chip group flex h-8 min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border px-3 text-left"
						onClick={() => onDraft(t(prompt))}
					>
						<Icon size={16} strokeWidth={2} aria-hidden className="shrink-0 text-ink opacity-70 transition-opacity group-hover:opacity-100" />
						<span className="max-w-64 min-w-0 truncate text-label text-ink opacity-70 transition-opacity group-hover:opacity-100">{t(label)}</span>
					</button>
				))}
			</div>
		</Scroller>
	);
}
