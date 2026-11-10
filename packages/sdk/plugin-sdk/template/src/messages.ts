/** 界面上给人看的文字，两种界面语言写在一起；界面入口用 @plume/ui 的 useI18n() 取当前语言。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	greeting: "问候",
	hello: (name: string) => `你好，${name}！`,
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		greeting: "Greeting",
		hello: (name: string) => `Hello, ${name}!`,
	},
};
