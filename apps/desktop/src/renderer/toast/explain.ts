/**
 * 一次失败是什么意思，用读的人的语言说。
 *
 * 报到这里的错误是抛出它的东西原样给的：Chromium 的一句英文、供应商的一段 JSON、文件系统的一个 errno。原样贴出来，
 * 好的时候没用，坏的时候误导人。所以认得出的几种换个说法：发生了什么、该怎么办。认不出的原样放过去——翻错了比不翻更糟，
 * 原文至少还搜得到。
 *
 * 写成纯函数，`node --test` 能逐条验证。词条由调用方的 `translate` 查，见 `groupNotices`。
 */

import type { MessageKey } from "@plume/ui";

export interface Explained {
	/** 标题，读的人的语言。 */
	message: string;
	/** 该怎么办，有的话。 */
	hint?: string;
	/**
	 * 说不说。
	 *
	 * 有些失败系统已经在说了，而且说得更好：macOS 自己弹对话框，点名是哪个应用、给出去设置的入口。旁边再来一条提示条是同一件事的第二个声音。
	 */
	silent?: boolean;
}

/**
 * 一条规则：认什么，换成什么说。存词条而不是句子：这张表在模块加载时就定了，句子写死在这里就成了第一次加载时窗口的语言。
 */
interface Rule {
	match: RegExp;
	message: MessageKey;
	hint?: MessageKey;
	silent?: boolean;
}

const RULES: Rule[] = [
	{
		/*
		 * 没给屏幕录制权限时截屏被拒：macOS 正弹着自己的对话框解释这件事，Chromium 抛的 `Failed to get sources.` 读起来像个故障，
		 * 不像一个还没给的权限。不说。
		 */
		match: /failed to get sources/i,
		message: "toastHelp.screenRecording",
		hint: "toastHelp.screenRecordingFix",
		silent: true,
	},
	{ match: /\bEACCES\b|\bEPERM\b|operation not permitted/i, message: "toastHelp.noAccess", hint: "toastHelp.noAccessFix" },
	{ match: /\bENOENT\b|no such file or directory/i, message: "toastHelp.notFound", hint: "toastHelp.notFoundFix" },
	{ match: /\bENOSPC\b|no space left/i, message: "toastHelp.diskFull", hint: "toastHelp.diskFullFix" },
	{ match: /\bECONNREFUSED\b/i, message: "toastHelp.refused", hint: "toastHelp.refusedFix" },
	{ match: /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|timed? ?out/i, message: "toastHelp.timeout", hint: "toastHelp.timeoutFix" },
	{ match: /\bENOTFOUND\b|getaddrinfo/i, message: "toastHelp.dns", hint: "toastHelp.dnsFix" },
	{ match: /\bECONNRESET\b|\bEPIPE\b|socket hang up/i, message: "toastHelp.reset", hint: "toastHelp.resetFix" },
	{
		// 供应商自己的 5xx，通常是一大段 JSON。一眼值得看的只有状态码，其余的该在对话里那行错误里展开看，不该在提示条上。
		match: /HTTP 5\d\d|internal_server_error|"type"\s*:\s*"server_error"/i,
		message: "toastHelp.upstream",
		hint: "toastHelp.upstreamFix",
	},
	{ match: /HTTP 429|rate.?limit/i, message: "toastHelp.rateLimited", hint: "toastHelp.rateLimitedFix" },
	{ match: /HTTP 401|HTTP 403|invalid.?api.?key|unauthorized/i, message: "toastHelp.badKey", hint: "toastHelp.badKeyFix" },
];

/** 换个说法，或者原样交回。第一条匹配的规则生效，所以上面从具体排到宽泛。 */
export function explain(message: string, translate: (key: MessageKey) => string): Explained {
	const text = message.trim();
	for (const rule of RULES) {
		if (!rule.match.test(text)) continue;
		return {
			message: translate(rule.message),
			...(rule.hint ? { hint: translate(rule.hint) } : {}),
			...(rule.silent ? { silent: true } : {}),
		};
	}
	return { message: text };
}
