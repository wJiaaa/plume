/**
 * plume.plan 的界面入口：
 *
 * - 输入框底下那排的开关（`ui.composerItem`），挨着权限：关着是一颗淡色图标，开着带字、用强调色。新对话里拨的是
 *   逻辑入口记着的新对话开关，第一句话发出去时交给建出来的会话。
 * - 计划卡（`ui.requestCard`，`PlanApproval.tsx`）：等人拍板，拒绝、修改、接受、接受并开启自动模式。
 * - 计划面板（`PlanPanel.tsx`）：计划在右栏按 Markdown 读，等审批时划线评论。计划交上来时由计划卡替人打开一次。
 * - `submit_plan` 在转录里读成一行「提交计划 标题」（`ui.toolLine`），和别的工具一样并进一段活：批没批、交给了谁，
 *   审批卡和交出去的会话那一条（宿主画在输入框上方）已经说了。
 * - 环境卡片里「计划」一节（`ui.environmentSection`，`PlansSection.tsx`）：批准过的每一份一行，点了在面板里摊开那一份。
 */

import type { ComposerItemProps, UiPlugin } from "@plume/contract/ui";
import { ComposerToggle, useI18n } from "@plume/ui";
import { ListOrdered } from "@plume/ui/icons";
import { useSyncExternalStore } from "react";
import type { PlanApi, PlanState } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { planSubject, SUBMIT_PLAN } from "./plan.ts";
import planCss from "./plan.css";
import { planApproval } from "./PlanApproval.tsx";
import { planPanel } from "./PlanPanel.tsx";
import { plansSection } from "./PlansSection.tsx";

const NAME = "plume.plan";
const PANEL = "plan";

function mountStyles(): void {
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${NAME}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = NAME;
		document.head.append(style);
	}
	style.textContent = planCss;
}

export default {
	name: NAME,
	apply(ui) {
		mountStyles();
		const api = ui.remote<PlanApi>();

		/** 开关的状态全窗口一份：有人看时连着逻辑入口的 `watch`，没人看了就断开。 */
		let state: PlanState = { sessions: [], draft: false };
		const listeners = new Set<() => void>();
		let cancel: (() => void) | undefined;
		function subscribe(listener: () => void): () => void {
			listeners.add(listener);
			if (!cancel) {
				const stream = api.watch();
				let alive = true;
				cancel = () => {
					alive = false;
					stream.cancel();
					cancel = undefined;
				};
				void (async () => {
					try {
						for await (const next of stream) {
							if (!alive) break;
							state = next;
							for (const notify of listeners) notify();
						}
					} catch {
						// 逻辑入口停了：开关停在最后知道的样子，插件重新加载时界面入口也会重来。
					}
				})();
			}
			return () => {
				listeners.delete(listener);
				if (!listeners.size) cancel?.();
			};
		}

		function PlanToggle({ sessionId }: ComposerItemProps) {
			const text = MESSAGES[useI18n().resolvedLocale];
			const current = useSyncExternalStore(subscribe, () => state);
			const on = sessionId ? current.sessions.includes(sessionId) : current.draft;
			const toggle = (next: boolean) => {
				api
					.set(sessionId ?? null, next)
					.then(undefined, (error: unknown) => ui.notify(text.toggleFailed(error instanceof Error ? error.message : String(error)), "error"));
			};
			return (
				<ComposerToggle on={on} onChange={toggle} icon={<ListOrdered size={16} strokeWidth={1.9} />} label={text.chip} tip={on ? text.exit : text.enter} />
			);
		}

		// 排在插件那一组的最前面：挨着权限，计划和权限说的都是「这一轮能做什么」。
		ui.composerItem("plan", PlanToggle, { order: -10 });
		ui.panel(PANEL, planPanel(ui), {
			title: (locale) => MESSAGES[locale].title,
			description: (locale) => MESSAGES[locale].description,
			icon: ListOrdered,
			// 没交过计划的对话里没什么可看：只从计划卡、环境卡片打开，不在开始页列出。
			listed: false,
		});
		ui.requestCard(SUBMIT_PLAN, planApproval(ui, api, PANEL));
		ui.toolLine(SUBMIT_PLAN, {
			verb: (locale) => MESSAGES[locale].submitted,
			subject: planSubject,
			// 和输入框上计划模式那颗开关同一枚。
			icon: ListOrdered,
		});
		// 30：环境卡片里排在子会话之后、建议的新会话之前。
		ui.environmentSection("plans", plansSection(ui, PANEL), { label: (locale) => MESSAGES[locale].title, order: 30 });
	},
} satisfies UiPlugin;
