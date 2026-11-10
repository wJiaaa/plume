/** 通知只指向仍需处理或还没读过的会话，打开会话沿用侧栏的清除规则。 */
import { MenuBody, Popover, ScrollText, TimeAgo, useI18n, type Anchor } from "@plume/ui";
import { AlertTriangle, Bell, Check, Hand } from "@plume/ui/icons";
import type { SessionActivity } from "./activity.ts";

export interface Notice {
	id: string;
	state: SessionActivity;
	title: string;
	project?: string;
	updatedAt?: number;
	run(): void;
}
const TILE = {
	waiting: { Icon: Hand, tint: "bg-warning/12 text-warning" },
	failed: { Icon: AlertTriangle, tint: "bg-danger/10 text-danger" },
	done: { Icon: Check, tint: "bg-ok/12 text-ok" },
};
export function NotificationsMenu({ anchor, notices, onClose }: { anchor: Anchor; notices: Notice[]; onClose: () => void }) {
	const { t } = useI18n();
	return (
		<Popover anchor={anchor} onClose={onClose} placement="bottom" align="end" width="panel" role="menu" label={t("sidebar.notifications")}>
			<MenuBody>
				<div className="flex items-baseline gap-1.5 px-2.5 pb-2 pt-1.5">
					<span className="text-label font-semibold text-ink">{t("sidebar.notifications")}</span>
					{notices.length > 0 && <span className="text-caption tabular-nums text-ink-faint">{notices.length}</span>}
				</div>
				{!notices.length && (
					<div data-plume-notifications-empty="" className="flex flex-col items-center gap-2 pb-5 pt-3 text-detail text-ink-faint">
						<span className="grid size-9 place-items-center rounded-full bg-card-hover text-ink-muted">
							<Bell size={16} strokeWidth={1.8} />
						</span>
						{t("notifications.empty")}
					</div>
				)}
				{notices.map((notice) => {
					const { Icon, tint } = TILE[notice.state];
					return (
						<button
							key={notice.id}
							type="button"
							role="menuitem"
							data-plume-notice={notice.state}
							onClick={() => {
								onClose();
								notice.run();
							}}
							className="plume-scroll plume-item flex w-full items-center gap-2.5 px-2 py-2 text-left"
						>
							<span className={`grid size-7 shrink-0 place-items-center rounded-lg ${tint}`}>
								<Icon size={14} strokeWidth={2} />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block" data-plume-notice-title="">
									<ScrollText text={notice.title} className="text-label text-ink" />
								</span>
								<span className="mt-0.5 block truncate text-caption text-ink-faint">
									{notice.state === "waiting" && <span className="text-warning">{t("notifications.waiting")} · </span>}
									{notice.project && `${notice.project} · `}
									{notice.updatedAt && <TimeAgo iso={new Date(notice.updatedAt).toISOString()} />}
								</span>
							</span>
						</button>
					);
				})}
			</MenuBody>
		</Popover>
	);
}
export function NoticeDot({ top }: { top?: SessionActivity }) {
	return top ? (
		<span
			aria-hidden
			data-plume-notice-dot={top}
			className={`pointer-events-none absolute right-1 top-1 size-1.5 rounded-full ${top === "waiting" ? "bg-warning" : top === "failed" ? "bg-danger" : "bg-ok"}`}
		/>
	) : null;
}
