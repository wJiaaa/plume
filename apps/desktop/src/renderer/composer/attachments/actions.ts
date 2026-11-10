/**
 * 拿一份附件去做点什么：打开它、在文件夹里指出它、把路径或图片抄下来。
 *
 * 格子、句子里的标记、菜单都走这里：「先确认文件还在」这种只在出错时才看得出来的一步，只有一份实现。
 * 这一层不画任何东西。
 */

import { translate } from "@plume/ui";
import { openFile } from "../../files/open-file.ts";
import { openTargetId } from "../../files/open-targets.ts";
import { notify } from "../../toast/store.ts";

/** 动作要认识这份附件的哪几件事。 */
export interface ActionTarget {
	/** 屏幕上叫什么：出错的那句话里用它，而不是一串路径。 */
	name: string;
	path?: string;
}

export interface OpenTarget extends ActionTarget {
	src?: string;
	isImage?: boolean;
	/** 一个文件夹：打开它本身。 */
	isFolder?: boolean;
	onPreviewImage?: (originRect?: DOMRect) => void;
	/** 当前会话的工作目录：文件在它里面时在文件面板里打开（面板只读得了这里面的），别处的在文件夹里指出来。 */
	cwd?: string;
}

/** `path` 在 `dir` 里面（或就是它）。两边都是绝对路径。 */
function within(path: string, dir: string): boolean {
	const root = dir.replace(/[/\\]+$/, "");
	return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/**
 * 动手之前先确认文件还在：转录活得比文件久，一条消息记下的是发送那一刻的位置；不问就去「在访达中显示」一个
 * 不在了的路径，系统会打开它的上级目录，看起来像是指错了文件。
 */
async function withFileThere(file: ActionTarget, act: (path: string) => Promise<unknown>): Promise<void> {
	const path = file.path;
	if (!path) return;
	if (!(await window.plume.files.exists(path).catch(() => false))) {
		notify(translate("attachment.gone", { name: file.name }), "warn");
		return;
	}
	try {
		// 直接打开会运行它时，主进程改成在文件夹里显示——说出来，不然这一下看起来像点错了。
		if ((await act(path)) === "revealed") notify(translate("attachment.revealedInstead", { name: file.name }), "warn");
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error), "error");
	}
}

/** 剪贴板要的是 `data:` URL；发出去的大图是 `plume-media://` 地址，先取回像素。 */
async function asDataUrl(src: string): Promise<string> {
	if (src.startsWith("data:")) return src;
	const blob = await (await fetch(src)).blob();
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

export const attachmentActions = {
	/** 磁盘上真有这么一个文件。粘贴进来的图片只有内存里的像素，没有。 */
	onDisk: (path: string | undefined): boolean => Boolean(path),
	/** 用「默认文件打开目标」打开（设置 › 常规），标签由 `openLabel` 给。 */
	openExternal: (file: ActionTarget) => void withFileThere(file, (path) => window.plume.files.openIn(openTargetId(), path)),
	/** 交给系统默认的应用。 */
	openDefault: (file: ActionTarget) => void withFileThere(file, (path) => window.plume.files.open(path)),
	/** 用指定的目标打开（「打开方式」里挑的那个）。 */
	openIn: (file: ActionTarget, target: string) => void withFileThere(file, (path) => window.plume.files.openIn(target, path)),
	/** 在这个平台的文件管理器里指出它：打开目录并把它选中。 */
	reveal: (file: ActionTarget) => void withFileThere(file, (path) => window.plume.files.reveal(path)),
	/** 路径进剪贴板。不碰磁盘，所以不先问文件在不在：人要的就是那串字。 */
	copyPath: (file: ActionTarget) => {
		if (file.path)
			void window.plume.files
				.copyText(file.path)
				.then(() => notify(translate("attachment.pathCopied")))
				.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
	},
	/** 图片作为图片进剪贴板，粘得进聊天窗口。 */
	copyImage: (src: string) => {
		void asDataUrl(src)
			.then((url) => window.plume.files.copyImage(url))
			.then((copied) => notify(translate(copied ? "viewer.copied" : "viewer.exportFailed"), copied ? "info" : "error"))
			.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
	},
	/** 点一下：文件夹打开它本身，图片进看图器，会话目录里的文件在文件面板里打开，其余有路径的在文件夹里指出来。 */
	openOrPreview: (target: OpenTarget, originRect?: DOMRect) => {
		if (target.isFolder && target.path) {
			void withFileThere(target, (path) => window.plume.files.open(path));
			return;
		}
		if ((target.isImage || target.src) && target.onPreviewImage) {
			target.onPreviewImage(originRect);
			return;
		}
		if (target.path && target.cwd && within(target.path, target.cwd)) {
			void withFileThere(target, async (path) => await openFile(path));
			return;
		}
		if (target.path) {
			void withFileThere(target, (path) => window.plume.files.reveal(path));
			return;
		}
		target.onPreviewImage?.(originRect);
	},
};
