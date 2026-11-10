/**
 * 模型选择器左边那一列厂商标。
 *
 * 长列表以前只能搜或者滚，两样都得从名字开始：先知道中转把模型拼成什么样才找得到。人带着来的问题通常是「哪个 Claude」，
 * 标在读任何名字之前就回答了——按一下就把列表收窄到一家，跨所有提供它的供应商。
 */

import { IconButton, useI18n } from "@plume/ui";
import { Grid2x2, Star } from "@plume/ui/icons";
import type { ReactNode } from "react";
import { ModelIcon } from "./ModelIcon.tsx";
import { brandName } from "./model-brand.ts";
import type { House } from "./model-grouping.ts";

/** 左侧那一列能收窄到什么：全部、星标的常用列表，或一家厂商。 */
export type RailPick = "all" | "favourites" | House;

export function ModelRail({
	houses,
	favourites,
	value,
	onChange,
}: {
	houses: House[];
	/** 有没有星标；常用列表有行时才在这一列占一格。 */
	favourites: boolean;
	value: RailPick;
	onChange: (pick: RailPick) => void;
}) {
	const { t } = useI18n();
	const name = (house: House) => (house === "other" ? t("modelMenu.otherHouse") : brandName(house));

	return (
		// 滚动条是藏起来而不是没有：厂商多到放不下时照样能用滚轮滚。
		<nav aria-label={t("modelMenu.houses")} className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto p-1.5 [scrollbar-width:none]">
			<RailButton label={t("modelMenu.allModels")} pressed={value === "all"} onPress={() => onChange("all")}>
				<Grid2x2 size={15} strokeWidth={1.8} />
			</RailButton>
			{favourites && (
				<RailButton label={t("modelMenu.favourite")} pressed={value === "favourites"} onPress={() => onChange("favourites")}>
					<Star size={15} strokeWidth={1.8} />
				</RailButton>
			)}
			<div aria-hidden className="my-1 h-px w-5 shrink-0 bg-line-float" />
			{houses.map((house) => (
				<RailButton key={house} label={name(house)} pressed={value === house} onPress={() => onChange(house)}>
					<ModelIcon brand={house === "other" ? null : house} size={16} />
				</RailButton>
			))}
		</nav>
	);
}

function RailButton({ label, pressed, onPress, children }: { label: string; pressed: boolean; onPress: () => void; children: ReactNode }) {
	return (
		<IconButton
			label={label}
			icon={children}
			active={pressed}
			onClick={(event) => {
				onPress();
				// 焦点回到搜索框，按过这里以后方向键和回车照样能用。
				event.currentTarget.closest("[data-plume-popover]")?.querySelector("input")?.focus();
			}}
		/>
	);
}
