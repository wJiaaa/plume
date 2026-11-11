/**
 * 环境卡片里「计划」那一节：这个会话批准过的计划，一份一行，写的是计划的标题，点了在右栏的计划面板里摊开那一份。
 *
 * 只列批准过的（`approvedPlans`），交给新会话的也列——计划文件就是交出去的那份，人回头要找的多半是它。
 * 打回的不列：那份改过以后又交了，批准的才是定稿。
 */

import type { EnvironmentSectionProps, UiContext } from "@plume/contract/ui";
import { ScrollText, Text, TimeAgo, useI18n } from "@plume/ui";
import { ListOrdered } from "@plume/ui/icons";
import { useMemo } from "react";
import { MESSAGES } from "./messages.ts";
import { approvedPlans, planTitle } from "./plan.ts";
import { viewPlan } from "./review.ts";

export function plansSection(ui: UiContext, panel: string) {
	return function PlansSection({ session }: EnvironmentSectionProps) {
		const t = MESSAGES[useI18n().resolvedLocale];
		const plans = useMemo(() => approvedPlans(session.messages), [session.messages]);
		if (plans.length === 0) return null;
		const sessionId = session.summary.id;
		return (
			<div data-plan-section="">
				<div className="plume-plan-section-label">
					<Text size="caption" tone="faint">
						{t.title}
					</Text>
				</div>
				{plans.map((plan) => (
					<button
						type="button"
						key={plan.approvedAt}
						className="plume-plan-section-row plume-scroll"
						data-plan-environment={plan.approvedAt}
						data-plume-tip={plan.handoff ? t.handedOff : undefined}
						onClick={() => {
							viewPlan(sessionId, plan.approvedAt);
							ui.openPanel(panel, sessionId);
						}}
					>
						<ListOrdered size={14} strokeWidth={1.8} aria-hidden className="plume-plan-section-icon" />
						<Text size="detail" className="plume-plan-section-grow">
							<ScrollText text={planTitle(plan.plan)} />
						</Text>
						<Text size="caption" tone="faint">
							<TimeAgo iso={new Date(plan.approvedAt).toISOString()} />
						</Text>
					</button>
				))}
			</div>
		);
	};
}
