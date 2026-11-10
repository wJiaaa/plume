/** 钥匙出问题时的报错，两种界面语言写在一起；会经调用的插件显示在它的设置页上。 */

import type { Locale } from "@plume/contract";

const zhCN = {
	keyUnreadable: (path: string, error: string) => `读不出密钥加密用的钥匙 ${path}：${error}`,
	keyInvalid: (path: string) => `密钥加密用的钥匙 ${path} 不是 32 字节，无法使用`,
};

export type Messages = typeof zhCN;

export const MESSAGES: Record<Locale, Messages> = {
	"zh-CN": zhCN,
	en: {
		keyUnreadable: (path, error) => `Can’t read the key that encrypts plugin secrets (${path}): ${error}`,
		keyInvalid: (path) => `The key that encrypts plugin secrets (${path}) isn’t 32 bytes long and can’t be used`,
	},
};
