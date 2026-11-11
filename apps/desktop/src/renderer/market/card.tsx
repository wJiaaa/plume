/**
 * 目录里的一个插件：它是什么，以及对它能做的那一件事。
 *
 * 卡片是在一格一格里扫着读的，所以只说四样——标记、名字、一句话、作者——右端一个动作。别的都在多点一下的
 * 详情页上，那里有地方把话说全。右端是它的状态，有事可做时是按钮：
 *
 *   - 没装：安装；
 *   - 装了、目录里有新版：更新，用强调色，因为这是唯一一个自己冒出来、不是人选的状态；
 *   - 装了、好好的：一个安静的 ✓；停用了写「已停用」，没加载起来写「加载失败」。
 *
 * 开关、卸载、打开目录都在详情页里。卡片是用来找东西的，管理在那一处。
 *
 * 技能合集的卡片多说两样——带几个技能、在哪个货架（技能那一类的网格不分架）——安装是一颗「+」：一格里要放下三样小字。
 */

import { useI18n } from "@plume/ui";
import { ArrowUp, Check, Layers, Plus, User } from "@plume/ui/icons";
import { ActionSpinner, Button, IconButton } from "@plume/ui";
import type { CSSProperties } from "react";
import { type CatalogItem, isEnabled, isInstalled, UNFILED } from "./catalog.ts";
import { PluginIcon } from "./plugin-icon.tsx";
import { type Install, useInstall } from "./use-install.ts";

export function CatalogCard({
	item,
	index = 0,
	onOpen,
}: {
	item: CatalogItem;
	/** 在这一组里第几个到，见 `.market-rise-in`。 */ index?: number;
	onOpen: () => void;
}) {
	const { t } = useI18n();
	const act = useInstall(item);
	const pack = item.kind === "skill";

	return (
		/*
		 * 点击区在下面而不是包在外面：按钮里不能再放按钮，所以卡片自己的按钮是内容后面的一层，右端的动作单独
		 * 接回指针事件。h-full 加一列把最后一行推到底：同一行的卡片一样高、页脚对齐。
		 */
		<div className="market-rise-in group/card relative h-full" data-card={item.key} style={{ "--market-i": index } as CSSProperties}>
			<button
				type="button"
				onClick={onOpen}
				aria-label={item.name}
				className="absolute inset-0 rounded-panel border border-line-soft/70 bg-card/30 transition-colors hover:border-line-soft hover:bg-card-hover/60 active:bg-elevated"
			/>

			<div className="pointer-events-none relative flex h-full items-start gap-3 px-3.5 py-3">
				<PluginIcon logo={item.logo} size={40} />

				<div className="flex min-h-full min-w-0 flex-1 flex-col">
					<div className="flex min-h-[26px] items-center gap-2">
						<span data-card-name="" className="truncate text-label font-medium text-ink">
							{item.name}
						</span>
						<div className="ml-auto shrink-0">
							<Action item={item} act={act} />
						</div>
					</div>

					<p className="line-clamp-2 text-detail text-ink-muted">{item.description || t("market.noTagline")}</p>

					{pack ? (
						<div className="mt-auto flex min-w-0 items-center gap-3 pt-1.5 text-caption text-ink-faint">
							{item.skills !== undefined && (
								<span className="flex shrink-0 items-center gap-1 tabular-nums">
									<Layers size={11} strokeWidth={2} aria-hidden />
									{t("market.skillsN", { n: item.skills })}
								</span>
							)}
							{item.author && (
								<span className="flex min-w-0 items-center gap-1">
									<User size={11} strokeWidth={2} aria-hidden className="shrink-0" />
									<span className="truncate">{item.author}</span>
								</span>
							)}
							{item.category !== UNFILED && <span className="shrink-0">{item.category}</span>}
						</div>
					) : (
						item.author && (
							<div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1.5 text-caption text-ink-faint">
								<span className="truncate">{item.author}</span>
							</div>
						)
					)}
				</div>
			</div>
		</div>
	);
}

/** 标题行的右端：状态，或者那一个要按的东西。 */
function Action({ item, act }: { item: CatalogItem; act: Install }) {
	const { t } = useI18n();

	if (!isInstalled(item)) {
		if (!item.entry) return null;
		if (item.kind === "skill") {
			return (
				<IconButton
					size="sm"
					label={act.busy === "install" ? t("market.installing") : t("common.install")}
					disabled={act.busy !== null}
					onClick={() => void act.install()}
					icon={act.busy === "install" ? <ActionSpinner size={11} /> : <Plus size={14} strokeWidth={2} />}
					className="pointer-events-auto border border-line"
				/>
			);
		}
		return (
			<Button
				size="sm"
				disabled={act.busy !== null}
				onClick={() => void act.install()}
				icon={act.busy === "install" ? <ActionSpinner size={11} /> : undefined}
				className="pointer-events-auto"
			>
				{act.busy === "install" ? t("market.installing") : t("common.install")}
			</Button>
		);
	}

	if (item.outdated && item.entry) {
		return (
			<Button
				variant="subtle"
				size="sm"
				disabled={act.busy !== null}
				onClick={() => void act.update()}
				label={item.entry.version ? t("catalogCard.updateTo", { version: `v${item.entry.version}` }) : t("catalogCard.updateToLatest")}
				icon={act.busy === "update" ? <ActionSpinner size={11} /> : <ArrowUp size={11} strokeWidth={2.2} aria-hidden />}
				className="pointer-events-auto bg-accent/12 text-accent hover:bg-accent/20 hover:text-accent"
			>
				{act.busy === "update" ? t("market.updating") : t("common.update")}
			</Button>
		);
	}

	if (item.status?.state === "failed") {
		return <span className="flex h-[24px] items-center text-caption whitespace-nowrap text-danger">{t("plugins.failed")}</span>;
	}

	const on = isEnabled(item);
	return (
		<span className="flex h-[24px] items-center gap-1 text-caption whitespace-nowrap text-ink-faint">
			{on && <Check size={11} strokeWidth={2.4} aria-hidden />}
			{on ? t("common.installed") : t("catalogCard.disabled")}
		</span>
	);
}
