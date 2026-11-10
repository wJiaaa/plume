/**
 * 主进程和界面之间关于更新的两样东西：查到的最新版本（`UpdateInfo`）和下载走到哪了（`UpdatePhase`）。
 *
 * 只在桌面应用自己的两个进程之间传，插件用不到，所以不放 `@plume/contract`。
 */

/**
 * 更新的下载走到哪了，一个值说完。`received`/`total` 跟着每个有它们的阶段走，停着的也带：暂停了的下载说不出自己下到哪，
 * 界面就得自己记一个主进程本来就知道的数。
 */
export type UpdatePhase =
	| { at: "idle" }
	| { at: "downloading"; received: number; total: number }
	| { at: "paused"; received: number; total: number }
	/** 下完了，在校验、解包或交给系统；还不知道是哪种收尾。 */
	| { at: "preparing"; received: number; total: number }
	/** 好了。`relaunch` 分开两种收尾：能自己换上新版本重启的，和安装程序已经交给系统的。 */
	| { at: "ready"; relaunch: boolean }
	| { at: "failed"; error: string; received: number; total: number };

export interface UpdateInfo {
	current: string;
	latest: string;
	available: boolean;
	/**
	 * 这个回答是真查到的，还是查不了时的说法。查不了时把正在跑的版本当成最新的报回去，和「查过了、已是最新」分不开，
	 * 设置 › 关于就会对没网的人说「已是最新版本」。角标两种都当「没什么可说」，只有被问到的那一处要分清。
	 */
	checked: boolean;
	/** release 的正文，原样，Markdown。 */
	notes: string;
	url: string;
	publishedAt: number | null;
	/** 这台机器能装的那个安装包。 */
	asset: { name: string; url: string; size: number } | null;
	/** release 发布的 `SHA256SUMS` 在哪；没有时下载完拒绝安装。 */
	checksums: string | null;
}
