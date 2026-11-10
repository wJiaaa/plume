/**
 * 回复里只写了文件名，而工作目录里同名的不止一份：点链接时列出来让人选。
 *
 * 不替人挑（见 `located-path.ts`），也不退回按工作目录拼——那条路径不存在，点了只会说「读不到」。
 */

import { iconColour, lookFor, MENU_MAX_HEIGHT, MenuBody, MenuItem, MenuLabel, Popover, useI18n } from "@plume/ui";

import { baseName } from "../files/open-file.ts";
import { directoryOf, relativeTo } from "./assets.ts";

/** 比动作菜单宽：每行是 `eim-ecom/src/main/java/com/…/handle` 这样的目录，窄了恰好裁掉能分辨它们的那段。 */
const WIDTH = 420;

export function FileChoices({
	anchor,
	paths,
	root,
	onPick,
	onClose,
}: {
	anchor: HTMLElement;
	/** 绝对路径。 */
	paths: readonly string[];
	/** 会话的工作目录，每行只写它下面那段，正是能分辨它们的部分。 */
	root: string;
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const label = t("markdown.fileChoices", { n: paths.length });
	const look = lookFor(baseName(paths[0] ?? ""), false);
	return (
		<Popover anchor={anchor} onClose={onClose} placement="bottom" align="start" width={WIDTH} maxHeight={MENU_MAX_HEIGHT} role="menu" label={label}>
			<MenuBody>
				<MenuLabel>{label}</MenuLabel>
				{paths.map((path) => {
					// 名字每行都一样，回复里也写着了：一行写的是它在哪。工作目录根下的那一个没有上级可写，写目录自己的名字。
					const shown = directoryOf(relativeTo(root, path) ?? path) || baseName(root);
					return (
						<MenuItem
							key={path}
							icon={<look.Icon size={13} strokeWidth={1.9} style={{ color: iconColour(look) }} />}
							onClick={() => {
								onClose();
								onPick(path);
							}}
						>
							{shown}
						</MenuItem>
					);
				})}
			</MenuBody>
		</Popover>
	);
}
