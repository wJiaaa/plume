/**
 * 把 git 远端操作的报错翻成人该做什么。
 *
 * git 的原话是写给终端前的人的：三行 `hint:` 加一条建议命令。面板上按钮没成，要的是「为什么、怎么办」。
 * 认不出的原样透传前三行：一句没翻译的英文能拿去搜，一句说错原因的中文只会把人领到别处。
 */

import { say } from "./say.ts";
import type { LogicMessages } from "../messages.ts";

/**
 * 值得点名的几种失败，按顺序试，先中先用。
 *
 * 有重叠：落后被拒的推送同时带 `[rejected]` 和 `non-fast-forward`，连不上的主机可能同时提到网址和解析，
 * 所以更具体的排在前面。
 */
const KNOWN: { match: (text: string) => boolean; say: keyof LogicMessages }[] = [
	{
		// 两边都动过的分支上 `pull --ff-only`。
		match: (t) => t.includes("Diverging branches can't be fast-forwarded") || t.includes("Not possible to fast-forward"),
		say: "diverged",
	},
	{ match: (t) => t.includes("no tracking information"), say: "noTracking" },
	{
		// 别人先推了。
		match: (t) => t.includes("non-fast-forward") || (t.includes("[rejected]") && t.includes("fetch first")),
		say: "rejected",
	},
	{
		// 不是密码错，是没地方问（见 `runRemote`）。`unable to get password from user` 是新版 GCM 在
		// `credential.interactive=false` 且没存凭据时的说法。
		match: (t) => t.includes("could not read Username") || t.includes("terminal prompts disabled") || t.includes("unable to get password from user"),
		say: "needLogin",
	},
	{ match: (t) => t.includes("Authentication failed") || t.includes("Permission denied"), say: "authRejected" },
	{
		match: (t) => t.includes("Could not resolve host") || t.includes("unable to access") || t.includes("Connection refused"),
		say: "unreachable",
	},
	{ match: (t) => t.includes("does not appear to be a git repository") || t.includes("Repository not found"), say: "repoMissing" },
];

/** 红字里写什么。认不出时只给前三行：git 的建议块动辄十几行，会把面板撑满。 */
export function explainGitFailure(stderr: string): string {
	const text = stderr.trim();
	const words = say();
	if (!text) return words.actionFailed;
	for (const entry of KNOWN) {
		if (entry.match(text)) return words[entry.say] as string;
	}
	return text.split("\n").slice(0, 3).join("\n");
}
