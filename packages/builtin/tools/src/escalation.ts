/**
 * 被沙箱拒了之后申请更大的权限：给模型看的那几句话。
 *
 * 不先猜命令危不危险再问：命令先在沙箱里跑，被拒是事实而不是预测，模型被告知被拒了什么、可以带一句理由申请一次更宽的模式；
 * 这时才问用户，用户看到的是模型自己解释为什么，而不是一个要凭空判断的路径。
 *
 * 申请本身归本体（`ToolRun.escalate`）：查申请合不合规矩、弹提权卡、只认人答、批了才换档，都在那里，这里只有工具自己的说法。
 */

import type { SandboxMode } from "@plume/contract";

/**
 * 用户拒绝之后给模型的话：别原样重试，也别换个工具达到同样效果。
 *
 * 用英文写：它跟在各处拒绝文案后面，所有工具共用同一句，模型在哪看到都认得出。
 */
export const DECLINED =
	"Do not retry it unchanged or get the same effect another way — another tool, a shell command, a script. Change your approach; if the task cannot go on without it, say so.";

/** 提权可能指向的所有模式（bash 的 `escalate` 参数能填的）。`read-only` 是底，没有什么会提权到它。 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ["workspace-write", "danger-full-access"];

/** 每个模式用文字说出来时的名字（拒绝标记里用它）。 */
// i18n-exempt：发给模型的，不随界面语言变。
export const MODE_LABEL: Record<SandboxMode, string> = {
	"read-only": "只读",
	"workspace-write": "可写项目目录",
	"danger-full-access": "完全访问",
};

/**
 * 说明这是策略拒绝、不是命令出错的那一行。
 *
 * 所有会被拒的工具共用一种措辞：模型要在任何地方都能一眼、一样地认出它；同一件事两种说法，它哪种都学不牢。
 * 不只是写文件：setuid 程序（`top`、`sudo`）在 Seatbelt 下起不来，报的也是被拒写入时那句「Operation not permitted」。
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
	// i18n-exempt：发给模型的，不随界面语言变。
	return `[sandbox: 被沙箱拒绝（当前模式：${MODE_LABEL[mode]}；写文件、运行 top、sudo 这类 setuid 程序都会被拒）——这是策略拒绝，不是命令本身出错，换个写法重试没有用]`;
}

/**
 * 跟着拒绝一起给出的提示。
 *
 * 放在被拒的地方而不是工具说明里：刚被拒的模型读的是这条结果，不会回头重读一百条消息之前给它的 schema。
 */
export function escalationHint(subject: string): string {
	// i18n-exempt：发给模型的，不随界面语言变。
	return `[sandbox: 可以申请——用完全相同的参数把这条${subject}重试一次，带上 escalate（够用的最窄模式）和 justification（一句话说明为什么需要），会弹窗问用户]`;
}

/**
 * 只给了理由、没申请提权：不改变任何行为，只是模型嘴上说「我需要写权限」却什么都没要。提权和理由一起来时的规矩
 * （理由不能缺、不能是空的）由本体查。
 */
// i18n-exempt：发给模型的，不随界面语言变。
export const JUSTIFICATION_ALONE = "justification 只能和 escalate 一起用，单独给理由不会改变任何行为。";
