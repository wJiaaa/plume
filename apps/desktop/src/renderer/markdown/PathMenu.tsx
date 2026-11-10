/**
 * 右键回复里的一枚文件签给出的菜单。
 *
 * 这是对话提到的路径，不是文件树的一行——这里不改名、不删除、不粘贴——所以只有前一半：在面板里打开、
 * 用默认文件打开目标打开、「打开方式」里挑别的、在文件管理器里指出它、抄下它的位置。
 *
 * 「打开所在文件夹」就是「在访达中显示」：后者打开文件夹并选中文件，再来一行只打开文件夹的，读起来是
 * 一句话说了两遍。
 */

import type { OpenTarget } from "../../shared/open-targets.ts";
import { ContextMenu, MenuBody, MenuItem, MenuSeparator, Popover, useContextMenu, useI18n, translate } from "@plume/ui";
import { AppWindow, ChevronRight, CornerUpRight, ExternalLink, FolderOpen, Link2 } from "@plume/ui/icons";
import { type ReactNode, useRef, useState } from "react";

import { baseName } from "../files/open-file.ts";
import { openLabel, revealLabel, targetLabel, useOpenTarget, useOpenTargets } from "../files/open-targets.ts";
import { attachmentActions } from "../composer/attachments/actions.ts";
import { relativeTo } from "./assets.ts";
import { notify } from "../toast/store.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

/**
 * 交给系统做的那几件，和附件走同一份实现：先确认文件还在，直接打开会运行它时改成在文件夹里显示，
 * 两种情况都说一声。
 */
export const fileExits = {
	/** 交给系统默认的应用（文件签悬停的「用默认应用打开」）。 */
	openExternal: (path: string) => attachmentActions.openDefault({ name: baseName(path), path }),
	openIn: (path: string, target: string) => attachmentActions.openIn({ name: baseName(path), path }, target),
	reveal: (path: string) => attachmentActions.reveal({ name: baseName(path), path }),
	copy: (text: string, relative = false) =>
		void window.plume.files
			.copyText(text)
			.then(() => notify(translate(relative ? "fileAction.relativePathCopied" : "fileAction.pathCopied")))
			.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error")),
};

/** 右键的是什么。 */
export interface PathMenuTarget {
	/** 绝对路径。 */
	path: string;
	/** 在应用里打开，就是点一下做的那件事。 */
	onOpen?: () => void;
}

/** 文件签的右键处理和它的菜单。`root` 是会话的工作目录，给「复制相对路径」用。 */
export function usePathMenu(root: string) {
	const menu = useContextMenu<PathMenuTarget>();
	return {
		onContextMenu: menu.show,
		open: menu.open,
		element: menu.open && menu.target ? <PathMenu anchor={menu.anchor} target={menu.target} root={root} onClose={menu.close} /> : null,
	};
}

function appIcon(target: OpenTarget, fallback: ReactNode): ReactNode {
	return target.icon ? <img src={target.icon} alt="" className="size-4.5 shrink-0 rounded-sm" /> : fallback;
}

function PathMenu({ anchor, target, root, onClose }: { anchor: { x: number; y: number } | null; target: PathMenuTarget; root: string; onClose: () => void }) {
	const { t } = useI18n();
	const editor = useOpenTarget();
	const targets = useOpenTargets();
	const relative = relativeTo(root, target.path);
	// 选中的编辑器自己一行，文件管理器自己一行，其余的进「打开方式」。
	const others = targets.filter((one) => one.id !== "reveal" && one.id !== editor.id);
	return (
		<ContextMenu anchor={anchor} onClose={onClose}>
			{target.onOpen && (
				<MenuItem icon={<FolderOpen {...ICON} />} onClick={target.onOpen}>
					{t("common.open")}
				</MenuItem>
			)}
			{editor.id !== "reveal" && (
				<MenuItem icon={appIcon(editor, <ExternalLink {...ICON} />)} onClick={() => fileExits.openIn(target.path, editor.id)}>
					{openLabel(editor)}
				</MenuItem>
			)}
			<OpenWith
				targets={others}
				onPick={(id) => {
					onClose();
					fileExits.openIn(target.path, id);
				}}
				onDefault={() => {
					onClose();
					fileExits.openExternal(target.path);
				}}
			/>
			<MenuItem icon={<CornerUpRight {...ICON} />} onClick={() => fileExits.reveal(target.path)}>
				{revealLabel()}
			</MenuItem>
			<MenuSeparator />
			<MenuItem icon={<Link2 {...ICON} />} onClick={() => fileExits.copy(target.path)}>
				{t("fileMenu.copyPath")}
			</MenuItem>
			{relative && (
				<MenuItem icon={<Link2 {...ICON} />} onClick={() => fileExits.copy(relative, true)}>
					{t("fileMenu.copyRelativePath")}
				</MenuItem>
			)}
		</ContextMenu>
	);
}

/** 「打开方式 ▸」：悬停展开一张子菜单，列别的应用和「用默认应用打开」。 */
function OpenWith({ targets, onPick, onDefault }: { targets: OpenTarget[]; onPick: (id: string) => void; onDefault: () => void }) {
	const { t } = useI18n();
	const row = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const leave = useRef(0);
	const show = () => {
		window.clearTimeout(leave.current);
		setOpen(true);
	};
	// 留一点余地，指针从这一行移进子菜单的路上它不会关掉。
	const hide = () => {
		leave.current = window.setTimeout(() => setOpen(false), 160);
	};
	return (
		<div ref={row} data-plume-open-with="" onMouseEnter={show} onMouseLeave={hide} onClick={(event) => event.stopPropagation()}>
			<MenuItem icon={<AppWindow {...ICON} />} trailing={<ChevronRight size={13} strokeWidth={1.8} className="text-ink-faint" />} onClick={show}>
				{t("pathMenu.openWith")}
			</MenuItem>
			{open && row.current && (
				<Popover
					anchor={row.current}
					onClose={() => setOpen(false)}
					placement="right"
					align="start"
					width="compact"
					label={t("pathMenu.openWith")}
					onMouseEnter={show}
					onMouseLeave={hide}
				>
					<MenuBody insetIcons>
						{targets.map((one) => (
							<MenuItem key={one.id} icon={appIcon(one, <ExternalLink {...ICON} />)} onClick={() => onPick(one.id)}>
								{targetLabel(one)}
							</MenuItem>
						))}
						{targets.length > 0 && <MenuSeparator />}
						<MenuItem icon={<ExternalLink {...ICON} />} onClick={onDefault}>
							{t("openTarget.defaultApp")}
						</MenuItem>
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}
