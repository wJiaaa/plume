import { EnvironmentSplitRow, IconButton, MenuBody, MenuItem, Popover, useI18n, usePopover } from "@plume/ui";
import { ChevronDown, FolderOpen, SquareArrowOutUpRight } from "@plume/ui/icons";
import { attachmentActions } from "../composer/attachments/actions.ts";
import { openLabel, setOpenTarget, targetLabel, useOpenTarget, useOpenTargets } from "./open-targets.ts";

function targetIcon(target: { id: string; icon?: string }, size: number) {
	if (target.icon) return <img src={target.icon} width={16} height={16} className="size-4 shrink-0 object-contain" alt="" />;
	return target.id === "reveal" ? <FolderOpen size={size} strokeWidth={1.8} /> : <SquareArrowOutUpRight size={size} strokeWidth={1.8} />;
}

/**
 * 环境入口和文件预览共享默认目标，选择后立即打开当前目录。整行形态直接使用 `@plume/ui` 的 `EnvironmentSplitRow`：
 * 平时是一整行无框按钮，悬停或展开菜单时浮出中间竖线，右端下拉切换默认应用；`compact` 放进紧凑栏头时只写应用名；
 * `compact: "icon"` 只剩应用图标和下拉箭头，一颗带框（和 ghost 按钮同一道线、同一档 26px 高）的分体按钮，放进面板顶栏那排图标按钮里。
 */
export function ProjectOpener({ path, compact = false }: { path: string; compact?: boolean | "icon" }) {
	const { t } = useI18n();
	const menu = usePopover();
	const current = useOpenTarget();
	const targets = useOpenTargets();
	const open = (id: string) => attachmentActions.openIn({ name: path.split(/[\\/]/).pop() ?? path, path }, id);
	const toggleMenu = (anchor: HTMLElement) => {
		if (menu.open) menu.close();
		else menu.openAt(anchor);
	};
	const menuWidth = !compact && menu.anchor instanceof HTMLElement && menu.anchor.offsetWidth > 0 ? menu.anchor.offsetWidth : "default";
	const menuPopover = menu.open && (
		<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width={menuWidth}>
			<MenuBody insetIcons>
				{targets.map((target) => (
					<MenuItem
						key={target.id}
						icon={targetIcon(target, 14)}
						selected={target.id === current.id}
						onClick={() => {
							menu.close();
							setOpenTarget(target.id);
							open(target.id);
						}}
					>
						{targetLabel(target)}
					</MenuItem>
				))}
			</MenuBody>
		</Popover>
	);

	if (compact === "icon") {
		return (
			<div
				role="group"
				aria-label={t("sessionMenu.openIn")}
				data-open={menu.open || undefined}
				className="flex h-6.5 shrink-0 items-center overflow-hidden rounded-lg border border-line text-ink-muted"
			>
				<button
					type="button"
					className="flex h-full w-7.5 items-center justify-center transition-colors hover:bg-card-hover hover:text-ink active:bg-elevated"
					aria-label={openLabel(current)}
					data-plume-tip={`${openLabel(current)}\n${path}`}
					onClick={() => open(current.id)}
				>
					{targetIcon(current, 14)}
				</button>
				<span aria-hidden className="h-3.5 w-px shrink-0 bg-line" />
				<button
					type="button"
					className="flex h-full w-6 items-center justify-center transition-colors hover:bg-card-hover hover:text-ink active:bg-elevated data-[open=true]:bg-card-hover"
					aria-label={t("sessionMenu.openIn")}
					aria-haspopup="menu"
					aria-expanded={menu.open}
					data-open={menu.open || undefined}
					data-plume-tip={t("sessionMenu.openIn")}
					onClick={(event) => toggleMenu(event.currentTarget)}
				>
					<ChevronDown size={13} strokeWidth={1.8} />
				</button>
				{menuPopover}
			</div>
		);
	}

	if (compact) {
		return (
			<div className="flex min-w-0 shrink-0 items-center">
				<button
					type="button"
					className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-field pr-1.5 pl-1 text-left text-detail text-ink-muted hover:bg-card-hover hover:text-ink active:bg-elevated"
					data-plume-tip={`${openLabel(current)}\n${path}`}
					onClick={() => open(current.id)}
				>
					{current.icon ? <img src={current.icon} width={16} height={16} alt="" /> : <FolderOpen size={14} />}
					<span className="truncate">{targetLabel(current)}</span>
				</button>
				<IconButton size="xs" label={t("sessionMenu.openIn")} icon={<ChevronDown size={12} />} onClick={(event) => toggleMenu(event.currentTarget)} />
				{menuPopover}
			</div>
		);
	}

	return (
		<>
			<EnvironmentSplitRow
				icon={targetIcon(current, 15)}
				title={openLabel(current)}
				tip={path}
				ariaLabel={t("sessionMenu.openIn")}
				menuLabel={t("sessionMenu.openIn")}
				open={menu.open}
				onClick={() => open(current.id)}
				onMenuClick={toggleMenu}
			/>
			{menuPopover}
		</>
	);
}
