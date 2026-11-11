/**
 * 主进程给人看的文字：菜单栏图标、系统通知、应用更新的进度和失败原因、agent 起不来时的对话框和插件装卸失败的原因。中文、英文两份，调用方按界面语言设置（locale.ts 的 resolvedLocale）传进来；
 * 菜单在打开的那一刻才生成，改了语言，下一次打开就是新的。
 *
 * 不引用 electron，测试才能直接加载它。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	"tray.show": "打开 Plume",
	"tray.hide": "隐藏 Plume",
	"tray.newChat": "新对话",
	"tray.recent": "最近会话",
	"tray.noChats": "还没有会话",
	"tray.settings": "设置…",
	"tray.updates": "检查更新…",
	"tray.launchAtLogin": "开机时启动",
	"tray.quit": "退出 Plume",
	"update.partialMismatch": "已下载的部分和这个版本对不上",
	"update.downloadStatus": "下载失败：{status}",
	"update.noChecksums": "这个版本没有发布校验文件，无法确认安装包完整。请到发布页手动下载。",
	"update.checksumsUnreachable": "没能取到校验文件（{reason}），这次不安装。",
	"update.incomplete": "下载不完整：拿到 {received} 字节，应为 {expected}",
	"update.emptyBody": "下载没有返回内容",
	"update.interruptedKept": "下载中断了。已经下好的部分留着，继续会接着下。",
	"update.interrupted": "下载中断了，可以重试。",
	"update.unreachable": "连不上下载地址，检查一下网络再试。",
	"update.notWritable": "无法写入更新文件。请检查更新目录的写入权限，并确认文件没有被其他程序占用，再点重试。",
	"update.notWritableKept": "无法写入更新文件。请检查更新目录的写入权限，并确认文件没有被其他程序占用，再点重试。已经下好的部分还在。",
	"update.downloadFailed": "下载失败",
	"update.checksumsMissing": "这个版本没有发布校验文件（SHA256SUMS），无法确认安装包是否完整。",
	"update.checksumNotListed": "校验文件里没有 {name} 这一项。",
	"update.checksumMismatch": "安装包的校验和与发布的不一致（应为 {expected}…，实为 {actual}…）。已删除下载的文件。",
	"update.noAsset": "没有找到适用于这台机器的安装包",
	"update.devMode": "开发模式下不做就地更新",
	"update.notInApplications": "这个副本不是从「应用程序」运行的，无法就地更新",
	"update.noAppInPackage": "下载的更新包里没有找到应用",
	"update.installFailed": "安装没有完成：{reason}",
	"update.installFailedPlain": "安装失败",
	// 装、更新、卸载插件时它目录里有文件正被占用（Windows），什么都没改。Plume 自己不占着：插件的原生模块是复制一份再加载的（native-cache.ts）。
	"market.filesInUse": "插件的文件正被占用（多半是它启动的程序，或打开着它的编辑器），什么都没有改动。关掉占用它的程序后再试。",
	// 从插件市场下载的包和索引里登记的大小、SHA-256 对不上（下载坏了，或者被换了），没装。
	"market.badDownload": "下载的插件包和市场登记的不一致，没有安装。可以稍后再试。",
	// 包解不开或解出来不是构建好的插件；reason 是 tar 给的原因。
	"market.badPackage": "插件包解不开或内容不完整（{reason}），没有安装。",
	// 启动时会话库打不开；reason 是 SQLite 或结构版本检查给的原因。
	"sessions.unavailableTitle": "Plume 打不开会话记录",
	"sessions.unavailable":
		"会话库 {path} 打不开：{reason}\n\nPlume 没有动这个文件。它可能正被另一个 Plume 占用，或者是别的版本的 Plume 写的。先退出其他 Plume 再打开；仍然打不开，就把 sessions.db 连同旁边同名的 -wal、-shm 文件一起挪到别处，Plume 会新建一个。",
};

export type NativeKey = keyof typeof zhCN;

const en: Record<NativeKey, string> = {
	"tray.show": "Open Plume",
	"tray.hide": "Hide Plume",
	"tray.newChat": "New chat",
	"tray.recent": "Recent chats",
	"tray.noChats": "No chats yet",
	"tray.settings": "Settings…",
	"tray.updates": "Check for updates…",
	"tray.launchAtLogin": "Launch at login",
	"tray.quit": "Quit Plume",
	"update.partialMismatch": "The part already downloaded does not match this version",
	"update.downloadStatus": "Download failed: {status}",
	"update.noChecksums": "This release has no checksum file, so the package cannot be confirmed intact. Download it by hand from the release page.",
	"update.checksumsUnreachable": "Could not fetch the checksum file ({reason}), so this update will not be installed.",
	"update.incomplete": "Download incomplete: got {received} bytes, expected {expected}",
	"update.emptyBody": "The download returned nothing",
	"update.interruptedKept": "The download was interrupted. What is already down is kept, and resuming carries on from there.",
	"update.interrupted": "The download was interrupted. You can try again.",
	"update.unreachable": "Could not reach the download address. Check the network and try again.",
	"update.notWritable":
		"The update file could not be written. Check that the update folder is writable and that no other program is holding the file, then press Try again.",
	"update.notWritableKept":
		"The update file could not be written. Check that the update folder is writable and that no other program is holding the file, then press Try again. What is already down is kept.",
	"update.downloadFailed": "Download failed",
	"update.checksumsMissing": "This release has no checksum file (SHA256SUMS), so the package cannot be confirmed intact.",
	"update.checksumNotListed": "The checksum file has no entry for {name}.",
	"update.checksumMismatch": "The package's checksum does not match the one released (expected {expected}…, got {actual}…). The download has been deleted.",
	"update.noAsset": "No installer for this machine was found",
	"update.devMode": "Updates are not installed in place in development mode",
	"update.notInApplications": "This copy is not running from Applications, so it cannot be updated in place",
	"update.noAppInPackage": "The downloaded update has no app in it",
	"update.installFailed": "The installation did not finish: {reason}",
	"update.installFailedPlain": "The installation failed",
	"market.filesInUse":
		"Some of the plugin's files are in use (most likely by a program it started, or an editor that has them open), so nothing was changed. Close whatever is using them and try again.",
	"market.badDownload": "The downloaded plugin package does not match what the marketplace lists, so it was not installed. Try again later.",
	"market.badPackage": "The plugin package could not be unpacked or is incomplete ({reason}), so it was not installed.",
	"sessions.unavailableTitle": "Plume can't open your conversations",
	"sessions.unavailable":
		"The session database at {path} would not open: {reason}\n\nPlume has left the file as it is. Another copy of Plume may have it open, or a different version of Plume may have written it. Quit any other copy and try again. If it still won't open, move sessions.db somewhere else together with the -wal and -shm files beside it, and Plume will start a new one.",
};

/** `variables` 填进文案里的 `{名字}`。 */
export function nativeText(locale: Locale, key: NativeKey, variables?: Record<string, string>): string {
	const template = (locale === "en" ? en : zhCN)[key];
	if (!variables) return template;
	// 用函数替换：路径和原因里的 `$&` 照原样留着，不被当成替换模式。
	return template.replace(/\{([^}]+)\}/g, (slot, name: string) => variables[name] ?? slot);
}

export function notificationBody(locale: Locale, kind: "done" | "approval" | "question", title?: string, detail?: string): string {
	const zh = locale === "zh-CN";
	const name = title ? (zh ? `「${title}」` : `“${title}”`) : "";
	const status =
		kind === "done"
			? zh
				? name
					? `${name}已完成`
					: "任务已完成"
				: name
					? `${name} finished`
					: "Task finished"
			: kind === "approval"
				? zh
					? `${name}等待批准`
					: name
						? `${name} needs your approval`
						: "Approval needed"
				: zh
					? `${name}等待回复`
					: name
						? `${name} needs your input`
						: "Input needed";
	const clean = detail?.trim().replace(/\s+/g, " ");
	const brief = clean && clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
	return brief ? `${status}${zh ? "：" : ": "}${brief}` : status;
}
