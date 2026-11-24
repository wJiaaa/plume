import type { Locale } from "@plume/contract";

const zhCN = {
	environment: "环境",
	sections: "显示哪些内容",
	chooseSections: "选择显示的内容",
	sectionOpenIn: "打开方式",
	references: "引用",
	more: (n: number) => `还有 ${n} 项`,
};
export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		environment: "Environment",
		sections: "Visible sections",
		chooseSections: "Choose what to show",
		sectionOpenIn: "Open with",
		references: "References",
		more: (n: number) => `${n} more`,
	},
};
