import type { ProjectEntry } from "@plume/contract";
import type { WelcomeLine } from "@plume/contract/ui";
import { Scroller, useI18n } from "@plume/ui";
import { Bug, Hammer, RefreshCw, Telescope } from "@plume/ui/icons";
import { type ReactNode, useEffect, useState } from "react";
import { hasWelcomeLine, usePluginRegistrations, welcomeLine } from "../plugins.tsx";
/*
 * 趴在输入框右上沿的插图：透明底的半身像（480px，显示 128px 的三倍还有余）。不用应用图标：那张带浅色圆角底，
 * 放在页面里像一块贴上去的方片。
 */
import mark from "../../assets/welcome-mark.png";

const PROMPTS = [
	{ icon: Telescope, label: "empty.explore", prompt: "empty.explorePrompt" },
	{ icon: Hammer, label: "empty.build", prompt: "empty.buildPrompt" },
	{ icon: RefreshCw, label: "empty.review", prompt: "empty.reviewPrompt" },
	{ icon: Bug, label: "empty.fix", prompt: "empty.fixPrompt" },
] as const;

/** 按本机时间问候。 */
function greetingKey(hour: number) {
	if (hour < 5) return "welcome.lateNight";
	if (hour < 9) return "welcome.morning";
	if (hour < 11) return "welcome.forenoon";
	if (hour < 13) return "welcome.noon";
	if (hour < 18) return "welcome.afternoon";
	return "welcome.evening";
}

/**
 * 问候下面那一行：没有插件登记 `ui.welcomeLine` 时就是产品默认的那一句；有就等它的答复（这时先空着），
 * 它没给、出错时退回默认的。插件登记变了、换了界面语言时重问。
 */
function useWelcomeLine(fallback: WelcomeLine): WelcomeLine | undefined {
	const { resolvedLocale } = useI18n();
	const registrations = usePluginRegistrations();
	const asked = `${registrations}/${resolvedLocale}`;
	const [answer, setAnswer] = useState<{ asked: string; line: WelcomeLine | undefined }>();
	useEffect(() => {
		if (!hasWelcomeLine()) return;
		let alive = true;
		void welcomeLine(resolvedLocale).then((line) => {
			if (alive) setAnswer({ asked, line });
		});
		return () => {
			alive = false;
		};
	}, [asked, resolvedLocale]);
	if (!hasWelcomeLine()) return fallback;
	if (answer?.asked !== asked) return undefined;
	return answer.line ?? fallback;
}

/**
 * 欢迎页：左上是按本机时间的问候和下面那一行（默认问要在哪个项目里做什么，插件可以换掉），和输入框左边对齐；
 * 插图趴在输入框右上沿；建议在输入框下面靠左。
 * 可滚动：最小窗口里输入框长高后，建议和发送按钮仍然能到达。
 */
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
	const line = useWelcomeLine({ text: project ? t("empty.projectQuestion", { project: project.name }) : t("empty.chat") });
	const size = compact ? 96 : 128;
	return (
		<Scroller className="flex-1" contentClassName="flex flex-col items-center px-6 pb-4 after:min-h-4 after:flex-1 after:content-['']">
			<div aria-hidden className="w-full shrink" style={{ flexBasis: "max(1rem, calc(40dvh - 150px))" }} />
			{/* 右边让出插图的宽度，长句换行也不压到它。 */}
			<div className={`w-full max-w-2xl shrink-0 pl-0.5 ${compact ? "pr-32" : "pr-44"}`}>
				<h1 className={`font-medium text-balance text-ink ${compact ? "text-display" : "text-hero"}`}>{t(greetingKey(new Date().getHours()))}</h1>
				{/* 先占好一行：插件的答复可能要等一会儿（比如现让模型写），回来了在原地淡入，不把输入框往下推。 */}
				<p data-welcome-line className={`mt-2 min-h-[1lh] text-balance text-ink-muted ${compact ? "text-body" : "text-title"}`}>
					{line && (
						<span key={line.text} className="plume-welcome-line">
							{line.text}
							{line.source && <span className="ml-2.5 text-detail whitespace-nowrap text-ink-faint">{line.source}</span>}
						</span>
					)}
				</p>
			</div>
			<div className="relative mt-7 w-full max-w-2xl shrink-0">
				{/* 外框只露出肩膀以上，下沿就是输入框的上沿，像从输入框后面探出头来。 */}
				<div aria-hidden data-compact={compact || undefined} className="plume-welcome-peek pointer-events-none absolute bottom-full overflow-hidden">
					<img src={mark} alt="" draggable={false} width={size} height={size} className="plume-welcome-mark block select-none" />
				</div>
				{children}
			</div>
			<div className="mt-6 flex w-full max-w-2xl shrink-0 flex-wrap items-center gap-x-4 gap-y-3">
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
