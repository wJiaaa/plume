/**
 * 列表怎么排、项目开着多少：收在「项目」标题上的一个菜单里，而不是在侧栏上多摆几个按钮。
 * 排序和折叠是偶尔改一下、平时不看的设置，常驻的按钮只会把会话往下挤。
 */

import { type Anchor, MenuBody, MenuItem, MenuLabel, MenuSeparator, Popover, useI18n } from "@plume/ui";
import { CalendarPlus, Check, ChevronsDownUp, ChevronsUpDown, Clock, GripVertical } from "@plume/ui/icons";
import type { SessionSort } from "./grouping.ts";

const SORTS = [
	{ value: "manual", label: "sidebar.manual", Icon: GripVertical },
	{ value: "updatedAt", label: "sidebar.updated", Icon: Clock, GripVertical },
	{ value: "createdAt", label: "sidebar.created", Icon: CalendarPlus },
] as const;

export function ListMenu({
	anchor,
	sort,
	onSort,
	canFold,
	allFolded,
	onFoldAll,
	onClose,
}: {
	anchor: Anchor;
	sort: SessionSort;
	onSort: (sort: SessionSort) => void;
	/** 有没有项目可折。 */
	canFold: boolean;
	/** 项目是不是全折着：全折着时这一项是「展开全部」，否则是「收起全部」——一项而不是两项。 */
	allFolded: boolean;
	onFoldAll: (folded: boolean) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	return (
		<Popover anchor={anchor} onClose={onClose} placement="bottom" width="compact" label={t("sidebar.listSettings")}>
			<MenuBody insetIcons>
				<MenuLabel>{t("sidebar.sortBy")}</MenuLabel>
				{SORTS.map(({ value, label, Icon }) => (
					<MenuItem
						key={value}
						icon={<Icon size={14} strokeWidth={1.8} />}
						selected={sort === value}
						trailing={sort === value ? <Check size={13} strokeWidth={2.2} /> : undefined}
						onClick={() => {
							onSort(value);
							onClose();
						}}
					>
						{t(label)}
					</MenuItem>
				))}
				{/* 没有项目时不放：按了没反应的一项，看着像功能坏了。 */}
				{canFold && (
					<>
						<MenuSeparator />
						<MenuItem
							icon={allFolded ? <ChevronsUpDown size={14} strokeWidth={1.8} /> : <ChevronsDownUp size={14} strokeWidth={1.8} />}
							onClick={() => {
								onFoldAll(!allFolded);
								onClose();
							}}
						>
							{allFolded ? t("sidebar.expandProjects") : t("sidebar.collapseProjects")}
						</MenuItem>
					</>
				)}
			</MenuBody>
		</Popover>
	);
}
