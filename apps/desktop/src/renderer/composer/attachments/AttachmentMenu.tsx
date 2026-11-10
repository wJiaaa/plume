/**
 * 一份附件能拿去做什么。
 *
 * 输入框上那一排、句子里那枚标记、气泡外那一排、气泡里那枚标记，右键出来的都是这一份；差别只有一处：已经发出去
 * 的那一份没有「剪切」和「移除」，那是记录。
 *
 * 只列做得到的：一张七行的单子上五行是灰的，读的人第一眼看到的是「这东西基本没用」。一行都没有就不弹。
 * 「打开」就叫打开：用设置 › 常规里的默认文件打开目标。
 */

import { ContextMenu, MenuItem, MenuSeparator, useI18n, type MessageKey } from "@plume/ui";
import { Copy, CornerUpRight, ExternalLink, Eye, Link2, Scissors, Trash2 } from "@plume/ui/icons";
import { attachmentActions } from "./actions.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

/** 「在访达中显示」按这个平台自己的说法。 */
function revealKey(): MessageKey {
	const platform = window.plume.platform;
	return platform === "darwin" ? "openTarget.revealFinder" : platform === "win32" ? "openTarget.revealExplorer" : "openTarget.reveal";
}

/** 菜单要认识这份附件的哪几件事。 */
export interface MenuTarget {
	name: string;
	/** 磁盘上的位置，粘贴进来的图片没有。 */
	path?: string;
	/** 图片的像素：复制一张图，人要的是粘得进聊天窗口的那种复制。 */
	src?: string;
	/** 在应用里看一眼；没有就说明这一份在应用里看不了。 */
	onPreview?: () => void;
}

export function AttachmentMenu({
	anchor,
	file,
	onClose,
	onRemove,
}: {
	anchor: { x: number; y: number } | null;
	file: MenuTarget | null;
	onClose: () => void;
	/** 只有还没发出去的那一份给得出这个。 */
	onRemove?: () => void;
}) {
	const { t } = useI18n();
	if (!anchor || !file) return null;

	const onDisk = attachmentActions.onDisk(file.path);
	/** 图片的像素在手上就能复制；文件得先在磁盘上找得到。 */
	const canCopy = Boolean(file.src) || onDisk;
	if (!file.onPreview && !onDisk && !canCopy && !onRemove) return null;

	/** 复制一份出去：图片是图片，文件是它的路径。 */
	const copy = () => {
		if (file.src) attachmentActions.copyImage(file.src);
		else attachmentActions.copyPath(file);
	};

	return (
		<ContextMenu anchor={anchor} onClose={onClose} width="default">
			{file.onPreview && (
				<MenuItem icon={<Eye {...ICON} />} onClick={file.onPreview}>
					{t("attachment.preview")}
				</MenuItem>
			)}

			{onDisk && (
				<MenuItem icon={<ExternalLink {...ICON} />} onClick={() => attachmentActions.openExternal(file)}>
					{t("common.open")}
				</MenuItem>
			)}

			{onDisk && (
				<MenuItem icon={<CornerUpRight {...ICON} />} onClick={() => attachmentActions.reveal(file)}>
					{t(revealKey())}
				</MenuItem>
			)}

			{canCopy && <MenuSeparator />}

			{canCopy && (
				<MenuItem icon={<Copy {...ICON} />} onClick={copy}>
					{file.src ? t("attachment.copyImage") : t("fileMenu.copyPath")}
				</MenuItem>
			)}

			{/* 图片那一行复制的是像素；它同时来自磁盘的话，路径另给一行：两样都常要。 */}
			{Boolean(file.src) && onDisk && (
				<MenuItem icon={<Link2 {...ICON} />} onClick={() => attachmentActions.copyPath(file)}>
					{t("fileMenu.copyPath")}
				</MenuItem>
			)}

			{onRemove && (
				<>
					<MenuSeparator />
					{/* 剪切 = 复制一份出去，再从这条消息里拿掉；磁盘上那一份一个字节都不动。 */}
					{canCopy && (
						<MenuItem
							icon={<Scissors {...ICON} />}
							onClick={() => {
								copy();
								onRemove();
							}}
						>
							{t("attachment.cut")}
						</MenuItem>
					)}
					<MenuItem icon={<Trash2 {...ICON} />} danger onClick={onRemove}>
						{t("common.remove")}
					</MenuItem>
				</>
			)}
		</ContextMenu>
	);
}
