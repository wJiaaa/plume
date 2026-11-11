/**
 * 请求重试：两种故障，两条规则，都摆在页面上。
 *
 * 断网和上游限流是两件事，答案也不同：网络多半会回来，值得多等；一直报 503 的服务一分钟后还不好，这一轮等不起。
 * 一种一行、默认折起，右边写着它现在怎么做；展开是决定它的四个字段。
 *
 * 没有保存按钮：这一页别的设置都是改了就存，这里也一样。改动立即生效，正在重试的请求从下一次等待起就用新值
 * （agent 进程把策略当函数交给 `@plume/llm`，见 `RetryPolicySource`）。
 */

import { Disclosure, Input, isLegalDraft, type MessageKey, translate, useI18n } from "@plume/ui";
import { normalizeRetryPolicy, type RetryFailure, type RetryRule } from "@plume/llm/retry-policy";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { modelsAgent, refreshModels, settingsView } from "../models/store.ts";
import { Card, InlineSelect, saveFailed, SectionTitle, Toggle } from "./controls.tsx";

/* 存 key 不存译好的字：这张表在模块加载时就成型了，之后换语言它不会重算。 */
const FAULTS: { kind: RetryFailure; titleKey: MessageKey; detailKey: MessageKey }[] = [
	{ kind: "network", titleKey: "retry.network", detailKey: "retry.networkDetail" },
	{ kind: "upstream", titleKey: "retry.upstream", detailKey: "retry.upstreamDetail" },
];

const seconds = (ms: number) => Math.round(ms / 1000);

/** 这条规则做什么，用人描述它的话说——折起时那一行的右边。 */
function summarize(rule: RetryRule): string {
	const count =
		rule.retries === null ? translate("retry.forever") : rule.retries === 0 ? translate("retry.never") : translate("retry.count", { count: rule.retries });
	if (rule.retries === 0) return count;
	const pace =
		rule.strategy === "fixed"
			? translate("retry.everyN", { n: seconds(rule.intervalMs) })
			: translate("retry.backoff", { from: seconds(rule.intervalMs), max: seconds(rule.maxIntervalMs) });
	return `${count} · ${pace}`;
}

export function RetrySettings({ policy: stored }: { policy: unknown }) {
	const { t } = useI18n();
	const policy = normalizeRetryPolicy(stored);
	const [open, setOpen] = useState<RetryFailure | null>(null);

	/*
	 * 写的时候取最新的，不用渲染时那份：两条规则存在同一个对象里，一个字段停手 300ms 才提交，那时另一条可能刚改过，
	 * 合进渲染时闭包里的旧值会把那次改动悄悄撤掉。
	 */
	const write = (kind: RetryFailure, patch: Partial<RetryRule>) => {
		const base = normalizeRetryPolicy(settingsView()?.retryPolicy);
		void modelsAgent()
			.setRetryPolicy({ ...base, [kind]: { ...base[kind], ...patch } })
			.then(refreshModels)
			.catch(saveFailed);
	};

	return (
		<section data-retry-settings="">
			<SectionTitle>{t("retry.title")}</SectionTitle>
			{/* 说一次，放在两条规则上面，而不是在两条里各说一遍。 */}
			<p className="-mt-1 mb-3 text-label leading-relaxed text-ink-muted">{t("retry.intro")}</p>
			<Card className="px-4">
				{FAULTS.map((fault) => {
					const rule = policy[fault.kind];
					const patch = (next: Partial<RetryRule>) => write(fault.kind, next);
					const linear = rule.strategy === "linear";
					return (
						<Disclosure
							key={fault.kind}
							open={open === fault.kind}
							onToggle={() => setOpen((was) => (was === fault.kind ? null : fault.kind))}
							title={
								<span className="block font-normal">
									<span className="block text-body text-ink">{t(fault.titleKey)}</span>
									<span className="mt-0.5 block text-label text-ink-faint">{t(fault.detailKey)}</span>
								</span>
							}
							trailing={
								<span data-retry-summary={fault.kind} className="shrink-0 pl-3 text-label text-ink-muted tabular-nums">
									{summarize(rule)}
								</span>
							}
						>
							{/* 缩进对齐标题而不是箭头，展开的部分读起来是一块。 */}
							<div className="flex flex-wrap items-start gap-x-6 gap-y-3 pb-1 pl-5">
								<NumberField
									label={t("retry.times")}
									ariaLabel={t("retry.timesAria", { fault: t(fault.titleKey) })}
									value={rule.retries}
									min={0}
									max={1_000_000}
									unit={t("common.times")}
									onCommit={(retries) => patch({ retries })}
								>
									{/* 放在它替代的那个数旁边：是同一个决定。 */}
									<Toggle
										ariaLabel={t("retry.unlimitedAria", { fault: t(fault.titleKey) })}
										checked={rule.retries === null}
										onChange={(on) => patch({ retries: on ? null : 10 })}
									/>
									<span className="text-label text-ink-muted">{t("common.unlimited")}</span>
								</NumberField>
								{rule.retries !== 0 && (
									<>
										<Labeled label={t("retry.spacing")}>
											<InlineSelect
												ariaLabel={t("retry.spacingAria", { fault: t(fault.titleKey) })}
												value={rule.strategy}
												options={[
													{ value: "fixed", label: t("retry.fixed") },
													{ value: "linear", label: t("retry.growing") },
												]}
												onChange={(strategy) => patch({ strategy })}
											/>
										</Labeled>
										<NumberField
											label={linear ? t("retry.firstWait") : t("retry.interval")}
											ariaLabel={t("retry.intervalAria", { fault: t(fault.titleKey) })}
											value={seconds(rule.intervalMs)}
											min={1}
											max={3600}
											unit={t("common.seconds")}
											onCommit={(value) => patch({ intervalMs: value * 1000, maxIntervalMs: Math.max(rule.maxIntervalMs, value * 1000) })}
										/>
										{linear && (
											<NumberField
												label={t("retry.maxWait")}
												ariaLabel={t("retry.maxWaitAria", { fault: t(fault.titleKey) })}
												value={seconds(rule.maxIntervalMs)}
												min={seconds(rule.intervalMs)}
												max={3600}
												unit={t("common.seconds")}
												onCommit={(value) => patch({ maxIntervalMs: value * 1000 })}
											/>
										)}
									</>
								)}
							</div>
							<p className="pl-5 text-detail leading-relaxed text-ink-faint">
								{rule.retries === 0
									? t("retry.failFast")
									: linear
										? t("retry.growingDetail", {
												a: seconds(rule.intervalMs),
												b: seconds(rule.intervalMs) * 2,
												c: seconds(rule.intervalMs) * 3,
												max: seconds(rule.maxIntervalMs),
											})
										: t("retry.fixedDetail")}
							</p>
						</Disclosure>
					);
				})}
			</Card>
		</section>
	);
}

/** 字段的名字和控件上下叠放，一排字段共用一条基线。 */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-detail text-ink-muted">{label}</span>
			<div className="flex h-7.5 items-center">{children}</div>
		</div>
	);
}

/**
 * 停手后自己存的数字。
 *
 * 每敲一下就存，会在打 `10` 的路上存下 `1`，而策略是实时生效的，正在等的请求会短暂地照它办；只在失焦时存，
 * 改完直接关窗口的人就丢了这次改动。所以：有焦点时打的字只在本地，停手 300ms 后提交，失焦时立刻提交，
 * 框里回到存下的、收好范围的值。
 */
function NumberField({
	label,
	ariaLabel,
	value,
	min,
	max,
	unit,
	onCommit,
	children,
}: {
	label: string;
	ariaLabel: string;
	/** `null` 是不限次数，没有数可显示。 */
	value: number | null;
	min: number;
	max: number;
	unit: string;
	onCommit: (value: number) => void;
	/** 和这个数是同一个决定的东西：「不限」开关。 */
	children?: ReactNode;
}) {
	const [typed, setTyped] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const bounds = { min, max, step: 1 };
	const shown = typed ?? (value === null ? "" : String(value));
	const commit = (raw: string, now: boolean) => {
		clearTimeout(timer.current);
		const parsed = Number(raw);
		if (raw.trim() === "" || !Number.isFinite(parsed)) return;
		const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
		if (now) onCommit(clamped);
		else timer.current = setTimeout(() => onCommit(clamped), 300);
	};

	return (
		<Labeled label={label}>
			<div className="flex items-center gap-2">
				<Input
					type="text"
					inputMode="numeric"
					aria-label={ariaLabel}
					disabled={value === null}
					value={shown}
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => {
						const next = event.target.value;
						if (!isLegalDraft(next, bounds)) {
							event.currentTarget.value = shown;
							return;
						}
						setTyped(next);
						commit(next, false);
					}}
					onBlur={(event) => {
						commit(event.target.value, true);
						setTyped(null);
					}}
					className="plume-field plume-number-field w-18 justify-center px-2 text-center tabular-nums disabled:opacity-40"
				/>
				<span className={`text-label text-ink-muted ${value === null ? "opacity-40" : ""}`}>{unit}</span>
				{children}
			</div>
		</Labeled>
	);
}
