/**
 * plume.plan 的界面入口：
 *
 * - 输入框底下那排的开关（`ui.composerItem`），挨着权限：关着是一颗淡色图标，开着带字、用强调色。新对话里拨的是
 *   逻辑入口记着的新对话开关，第一句话发出去时交给建出来的会话。
 * - 计划卡（`ui.requestCard`，`PlanApproval.tsx`）：等人拍板，拒绝、修改、接受、接受并开启自动模式。摆在转录里、接着这一轮的回复
 *   （`place: "transcript"`），不压在输入框上方。
 * - 计划面板（`PlanPanel.tsx`）：计划在右栏按 Markdown 读，等审批时划线评论。计划交上来时由计划卡替人打开一次。
 * - `submit_plan` 在转录里读成一行「提交计划 标题」（`ui.toolLine`；等人拍板时扫着光说「正在提交计划」，计划卡就接在它下面），和别的工具一样并进一段活：批没批、交给了谁，
 *   计划卡（接在回复后面）和交出去的会话那一条（宿主画在输入框上方）已经说了。
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
		// 摆在转录里：计划是这一轮回复的结论，批它时要对着回复读，卡接在回复后面，而不是和提问卡一样压在输入框上方。
		ui.requestCard(SUBMIT_PLAN, planApproval(ui, api, PANEL), { place: "transcript" });
		ui.toolLine(SUBMIT_PLAN, {
			verb: (locale) => MESSAGES[locale].submitted,
			// 等人拍板时还在进行：这一行扫着光说「正在提交计划」，计划卡就在它下面；答完了才是「提交计划」。
			verbFor: ({ live }, locale) => (live ? MESSAGES[locale].submitting : undefined),
			subject: planSubject,
			// 和输入框上计划模式那颗开关同一枚。
			icon: ListOrdered,
		});
		ui.environmentSection("plans", plansSection(ui, PANEL), { label: (locale) => MESSAGES[locale].title, place: "output", order: 30 });
	},
} satisfies UiPlugin;
