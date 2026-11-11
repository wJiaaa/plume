/** `<webview>` 是 Electron 给渲染进程的标签，React 的类型里有它的属性，没有 guest 的方法。宿主在主窗口里开着它（见 `ctx.pages` 的说明）。 */

declare global {
	/** 挂上以后才读得到 guest 的 id，挂上之前调会抛错。 */
	interface HTMLWebViewElement {
		getWebContentsId(): number;
	}
}

// 有 declare global 的声明文件必须是模块，全局扩展才生效。
// oxlint-disable-next-line unicorn/require-module-specifiers
export {};
