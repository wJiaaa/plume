/**
 * 环境卡片“产出”里的计划行：只列批准过的定稿，点了在计划面板摊开。分组标题和行骨架由环境卡片宿主统一画。
 */

import type { EnvironmentSectionProps, UiContext } from "@plume/contract/ui";
import { EnvironmentRow, TimeAgo, useI18n } from "@plume/ui";
import { ListChecks } from "@plume/ui/icons";
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
			<>
				{plans.map((plan) => (
					<EnvironmentRow
						key={plan.approvedAt}
						icon={<ListChecks size={14} strokeWidth={1.8} />}
						title={planTitle(plan.plan)}
						fact={<TimeAgo iso={new Date(plan.approvedAt).toISOString()} />}
						tip={plan.handoff ? t.handedOff : undefined}
						onClick={() => {
							viewPlan(sessionId, plan.approvedAt);
							ui.openPanel(panel, sessionId);
						}}
						data-plan-environment={String(plan.approvedAt)}
					/>
				))}
			</>
		);
	};
}
