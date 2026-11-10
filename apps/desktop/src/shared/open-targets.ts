/** 「默认文件打开目标」的一项：主进程按这台机器装了什么列出来（main/open-targets.ts）。 */
export interface OpenTarget {
	/** 和平台无关的 id（`vscode`、`zed`……）；`reveal` 是在文件管理器里指出它。 */
	id: string;
	/** 应用的名字；reveal 的由界面按平台和语言写，这里是空的。 */
	label: string;
	/** 应用自己的图标（data URL）。 */
	icon?: string;
}
