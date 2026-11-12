import { translate, hoverLayersSuppressed, onHoverLayersDismissed, chromeTop, portal, useI18n, type ResolvedUiLocale } from "@plume/ui";
import { ArrowDownToLine, ArrowUpFromLine, Bot, FolderOpen, MessageSquare, MessagesSquare, Plug } from "@plume/ui/icons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionStats, SessionSummary, SessionUsage } from "@plume/contract";
import { usePluginDisplayName } from "../market/store.ts";

function formatTokens(count: number): string {
	for (const [size, suffix] of [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "k"],
	] as const)
		if (count >= size) return `${(count / size).toFixed(1)}${suffix}`;
	return String(count);
}
const freshTokens = (usage: SessionUsage) => usage.input + usage.output + usage.cacheWrite;
const hourStyle = (locale: ResolvedUiLocale) =>
	new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ? ("numeric" as const) : ("2-digit" as const);
const EMPTY: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };

const OPEN_DELAY_MS = 420;

const LEAVE_MS = 150;

const GAP = 8;

export const CARD_Z = 210;

function when(at: number, locale: ResolvedUiLocale): string {
	const days = Math.floor((Date.now() - at) / 86_400_000);
	if (days === 0) {
		return new Date(at).toLocaleTimeString(locale, { hour: hourStyle(locale), minute: "2-digit" });
	}
	if (days === 1) return translate("sessionCard.yesterday");
	if (days < 30) return translate("sessionCard.daysAgo", { n: days });
	return new Date(at).toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

function cacheHitRate(usage: SessionStats["replyUsage"]): number | null {
	const sent = usage.input + usage.cacheRead + usage.cacheWrite;
	return sent > 0 ? usage.cacheRead / sent : null;
}
function plus(a: SessionUsage, b: SessionUsage): SessionUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		unpriced: a.unpriced + b.unpriced,
	};
}
function costText(spent: SessionUsage): { text: string; priced: boolean } {
	if (spent.cost > 0.0001)
		return { text: spent.cost < 0.005 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(spent.cost), priced: true };
	return { text: freshTokens(spent) > 0 ? translate("sessionCard.unpriced") : "–", priced: false };
}

function startedAt(at: number, locale: ResolvedUiLocale): string {
	const time = new Date(at).toLocaleTimeString(locale, { hour: hourStyle(locale), minute: "2-digit" });
	if (new Date(at).toDateString() === new Date().toDateString()) return time;
	return `${new Date(at).toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${time}`;
}

const tokensOrDash = (n: number) => (n > 0 ? formatTokens(n) : "–");

function turnsText(session: Pick<SessionStats, "turns" | "steps">): string {
	return translate("sessionCard.turnsSteps", { turns: session.turns, n: session.steps });
}

function percent(rate: number): string {
	const whole = Math.round(rate * 100);
	return whole === 100 && rate < 1 ? `${(Math.floor(rate * 1000) / 10).toFixed(1)}%` : `${whole}%`;
}

function folderName(path: string): string {
	return path.split(/[\\/]/).findLast(Boolean) || path;
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
	return (
		<div className="flex min-w-0 flex-col items-center gap-0.5">
			<span className="flex max-w-full items-center gap-1 text-caption text-ink-faint">
				<span className="shrink-0">{icon}</span>
				<span className="truncate">{label}</span>
			</span>
			<span className="max-w-full truncate text-detail text-ink tabular-nums">{value}</span>
		</div>
	);
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-1.5 text-detail text-ink-muted">
			<span className="shrink-0 text-ink-faint">{icon}</span>
			<span className="min-w-0 truncate">{children}</span>
		</div>
	);
}

export function useCardPlacement(anchor: DOMRect): { card: React.RefObject<HTMLDivElement | null>; at: { left: number; top: number } | null } {
	const card = useRef<HTMLDivElement>(null);
	const [at, setAt] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		const box = card.current?.getBoundingClientRect();
		if (!box) return;
		const right = anchor.right + GAP;
		const left = right + box.width > window.innerWidth - GAP ? anchor.left - GAP - box.width : right;

		const top = Math.max(chromeTop() + GAP, Math.min(Math.max(GAP, anchor.top - 6), window.innerHeight - box.height - GAP));
		setAt({ left: Math.max(GAP, left), top });
	}, [anchor]);
	return { card, at };
}

export function SessionCard({
	session,
	load,
	anchor,
	project,
	leaving,
}: {
	session: SessionSummary;
	load: (id: string) => Promise<SessionStats>;

	anchor: DOMRect;

	project?: string;

	leaving?: boolean;
}) {
	const { resolvedLocale } = useI18n();
	const { card, at } = useCardPlacement(anchor);

	const [stats, setStats] = useState<SessionStats>();
	useEffect(() => {
		let cancelled = false;
		void load(session.id)
			.then((value) => {
				if (!cancelled) setStats(value);
			})
			.catch(() => {
				if (!cancelled) setStats(undefined);
			});
		return () => {
			cancelled = true;
		};
	}, [load, session.id, session.updatedAt]);
	const main = stats?.usage ?? EMPTY;
	const children = stats?.children ?? [];
	const spent = children.reduce((usage, child) => plus(usage, child.usage), main);
	const cost = costText(spent);
	const hit = cacheHitRate(stats?.replyUsage ?? EMPTY);
	// 子会话的用量按建它的插件分开，一个插件一格，名字用插件市场里的显示名；停用、卸载了查不到时用插件名。
	const displayName = usePluginDisplayName();
	const byOwner = new Map<string, number>();
	for (const child of children) if (child.owner) byOwner.set(child.owner, (byOwner.get(child.owner) ?? 0) + freshTokens(child.usage));
	const owners = [...byOwner].map(([owner, tokens]) => ({ owner, tokens, label: displayName(owner) ?? owner }));

	return portal(
		<div
			ref={card}
			role="tooltip"
			data-plume-session-card=""
			style={{ zIndex: CARD_Z, left: at?.left ?? -9999, top: at?.top ?? -9999, opacity: at ? undefined : 0 }}
			className={`bg-float shadow-menu pointer-events-none fixed w-[248px] overflow-hidden rounded-xl border border-line-soft ${
				leaving ? "sidebar-card-out" : "sidebar-card-in"
			}`}
		>
			<div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
				<p className="line-clamp-3 min-w-0 flex-1 text-label leading-snug text-ink">{session.title}</p>
				<span className="mt-[1px] shrink-0 text-caption text-ink-faint tabular-nums">{when(session.updatedAt, resolvedLocale)}</span>
			</div>
			<div className="flex flex-col gap-1 px-3 py-2">
				<Row icon={<FolderOpen size={11.5} strokeWidth={1.9} />}>{project ?? folderName(session.cwd)}</Row>
				{session.steward && (
					<Row icon={<Plug size={11.5} strokeWidth={1.9} />}>
						{translate("sessionCard.stewardedBy", { name: displayName(session.steward) ?? session.steward })}
					</Row>
				)}
			</div>
			<div className="flex items-baseline justify-between gap-2 px-3 pt-1.5 pb-0.5">
				<span data-plume-session-cost="" className={cost.priced ? "text-heading font-semibold text-ink tabular-nums" : "text-body text-ink-faint"}>
					{cost.text}
				</span>
				<span className="text-right text-caption leading-snug text-ink-faint">
					<span className="font-medium text-ink-muted tabular-nums">{formatTokens(freshTokens(spent))}</span> {translate("sessionCard.tokens")}
					<br />
					{translate("sessionCard.mainCache")} <span className="font-medium text-ink-muted tabular-nums">{hit === null ? "–" : percent(hit)}</span>
				</span>
			</div>
			<div data-plume-session-figures="" className="grid grid-cols-[repeat(3,auto)] justify-between gap-x-2 gap-y-2 px-3 py-2">
				<Stat icon={<MessagesSquare size={11} strokeWidth={2} />} label={translate("sessionCard.turns")} value={stats ? turnsText(stats) : "–"} />
				<Stat
					icon={<ArrowDownToLine size={11} strokeWidth={2} />}
					label={translate("sessionCard.input")}
					value={formatTokens(spent.input + spent.cacheWrite)}
				/>
				<Stat icon={<ArrowUpFromLine size={11} strokeWidth={2} />} label={translate("sessionCard.output")} value={formatTokens(spent.output)} />
				<Stat icon={<MessageSquare size={11} strokeWidth={2} />} label={translate("sessionCard.partMain")} value={tokensOrDash(freshTokens(main))} />
				{owners.map(({ owner, tokens, label }) => (
					<Stat key={owner} icon={<Bot size={11} strokeWidth={2} />} label={label} value={tokensOrDash(tokens)} />
				))}
			</div>

			<p data-plume-session-foot="" className="truncate px-3 pb-2.5 text-caption text-ink-faint tabular-nums">
				{translate("sessionCard.started", { at: startedAt(session.createdAt, resolvedLocale) })} ·{" "}
				{translate("sessionCard.readCache", { n: formatTokens(spent.cacheRead) })}
			</p>
		</div>,
	);
}

export function useSessionCard(): {
	anchor: DOMRect | null;
	leaving: boolean;
	bind: {
		onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void;
		onMouseLeave: () => void;
		onClick: () => void;
	};
	dismiss: () => void;
} {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);

	const [leaving, setLeaving] = useState(false);

	const [engaged, setEngaged] = useState(false);
	const open = useRef<number | undefined>(undefined);
	const close = useRef<number | undefined>(undefined);

	const dismiss = useCallback(() => {
		window.clearTimeout(open.current);
		window.clearTimeout(close.current);
		setAnchor(null);
		setLeaving(false);
		setEngaged(false);
	}, []);

	useEffect(
		() => () => {
			window.clearTimeout(open.current);
			window.clearTimeout(close.current);
		},
		[],
	);

	useEffect(() => {
		if (!engaged) return;
		const hide = () => dismiss();
		window.addEventListener("scroll", hide, true);
		window.addEventListener("wheel", hide, true);
		window.addEventListener("blur", hide);

		const unsubscribe = onHoverLayersDismissed(dismiss);
		return () => {
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("wheel", hide, true);
			window.removeEventListener("blur", hide);
			unsubscribe();
		};
	}, [engaged, dismiss]);

	return {
		anchor,
		leaving,
		dismiss,
		bind: {
			onMouseEnter: (event) => {
				if (hoverLayersSuppressed()) return;
				const box = event.currentTarget.getBoundingClientRect();
				window.clearTimeout(open.current);
				window.clearTimeout(close.current);
				setEngaged(true);

				setLeaving(false);
				open.current = window.setTimeout(() => {
					if (hoverLayersSuppressed()) return;
					setAnchor(box);
				}, OPEN_DELAY_MS);
			},
			onMouseLeave: () => {
				window.clearTimeout(open.current);
				setLeaving(true);
				close.current = window.setTimeout(() => {
					setAnchor(null);
					setLeaving(false);
					setEngaged(false);
				}, LEAVE_MS);
			},
			onClick: () => {
				dismiss();
			},
		},
	};
}
