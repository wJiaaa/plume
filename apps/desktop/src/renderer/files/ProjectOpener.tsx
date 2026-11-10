import { IconButton, MenuBody, MenuItem, Popover, useI18n, usePopover } from "@plume/ui";
import { ChevronDown, FolderOpen } from "@plume/ui/icons";
import { attachmentActions } from "../composer/attachments/actions.ts";
import { openLabel, setOpenTarget, targetLabel, useOpenTarget, useOpenTargets } from "./open-targets.ts";

/** 环境入口和文件预览共享默认目标，选择后立即打开当前目录。 */
export function ProjectOpener({ path }: { path: string }) {
	const { t } = useI18n();
	const menu = usePopover();
	const current = useOpenTarget();
	const targets = useOpenTargets();
	const open = (id: string) => attachmentActions.openIn({ name: path.split(/[\\/]/).pop() ?? path, path }, id);
	return (
		<div className="flex min-w-0 items-center gap-0.5">
			<button
				type="button"
				className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-field px-2 text-left text-label hover:bg-card-hover active:bg-elevated"
				data-plume-tip={path}
				onClick={() => open(current.id)}
			>
				{current.icon ? <img src={current.icon} width={16} height={16} alt="" /> : <FolderOpen size={14} />}
				<span className="truncate">{openLabel(current)}</span>
			</button>
			<IconButton size="sm" label={t("sessionMenu.openIn")} icon={<ChevronDown size={13} />} onClick={menu.toggle} />
			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end">
					<MenuBody>
						{targets.map((target) => (
							<MenuItem
								key={target.id}
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
			)}
		</div>
	);
}
