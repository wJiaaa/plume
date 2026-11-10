/** 样式表按文字引入（插件构建给 .css 用 text 加载器），由 ui.tsx 挂到页面上。 */
declare module "*.css" {
	const css: string;
	export default css;
}
