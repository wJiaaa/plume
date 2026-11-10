/**
 * 被拒之后申请更大的权限：这套流程只在这里写一次。
 *
 * 不先猜命令危不危险再问：那样凡是「像」风险的都要弹窗，而那几乎是所有命令；一直弹的窗不是保护，
 * 是大家学会不看就点的一步，真正要紧的那次来的时候和其余的看起来一模一样。
 *
 * 顺序反过来：命令先在沙箱里跑。被拒是事实而不是预测，模型被告知被拒了什么、可以带一句理由申请一次更宽的模式；
 * 这时才问用户，用户看到的是模型自己解释为什么，而不是一个要凭空判断的路径。
 *
 * 于是弹窗次数等于 agent 真正越线的次数，而不是我们怀疑它会越线的次数；批准只用在申请它的那一次调用上，
 * 什么都不累积，会话不会比开始时更宽。
 */

import type { SandboxMode } from "@plume/contract";

/**
 * 用户拒绝之后给模型的话：别原样重试，也别换个工具达到同样效果。
 *
 * 用英文写：它跟在各处拒绝文案后面，所有工具共用同一句，模型在哪看到都认得出。
 */
export const DECLINED =
	"Do not retry it unchanged or get the same effect another way — another tool, a shell command, a script. Change your approach; if the task cannot go on without it, say so.";

/**
 * 每个模式能提到哪些模式；没有键的不能提权。
 *
 * 只能严格变宽。不存在两个模式各自允许对方不允许的东西；允许不是变宽的「换模式」，批准的提权就可能悄悄拿走点什么，那不是任何人批准过的。
 */
const WIDER: Partial<Record<SandboxMode, readonly SandboxMode[]>> = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"],
};

/** 提权可能指向的所有模式。`read-only` 是底，没有什么会提权到它。 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ["workspace-write", "danger-full-access"];

/** 每个模式用文字说出来时的名字（拒绝标记、提权报错里都用它）。 */
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

/** 提权申请在问人之前就被拒了，以及为什么。 */
export class EscalationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EscalationError";
	}
}

/**
 * 检查 JSON schema 表达不了的配对。
 *
 * 两个参数要么一起来，要么都不来：没有理由的 `escalate` 弹窗时没东西给用户看；没有申请的 `justification`
 * 不改变任何行为，只是模型嘴上说「我需要写权限」却什么都没要。
 */
export function validateEscalationArgs(escalate: string | undefined, justification: string | undefined): void {
	// i18n-exempt：发给模型的，不随界面语言变。
	if (escalate !== undefined && justification === undefined) {
		throw new EscalationError("提权请求必须带上 justification：弹窗要有一句话告诉用户为什么。");
	}
	if (justification !== undefined && escalate === undefined) {
		throw new EscalationError("justification 只能和 escalate 一起用，单独给理由不会改变任何行为。");
	}
	if (justification !== undefined && justification.trim().length === 0) {
		throw new EscalationError("justification 不能是空的。");
	}
}

/**
 * 校验一次提权：要的模式必须严格比当前宽，否则抛 EscalationError。返回要提到的模式。
 *
 * 在问人之前判：不比当前宽的申请什么都不授予，没有可决定的，不该到用户面前。返回的模式只给这一次调用用，
 * 不记到任何地方：活得比调用长的提权，就是用户批准过一次、之后忘了的权限。
 */
export function escalationTarget(requested: string, current: SandboxMode): SandboxMode {
	const target = (WIDER[current] ?? []).find((mode) => mode === requested);
	// i18n-exempt：发给模型的，不随界面语言变。
	if (!target) throw new EscalationError(`「${requested}」不比当前的「${MODE_LABEL[current]}」更宽，提权请求无效。`);
	return target;
}

/** 用户拒绝提权时给模型的话：和「申请得不对」的报错分得开，模型才知道该换办法而不是改参数重试。 */
export function escalationDeclined(subject: string, target: SandboxMode): string {
	// i18n-exempt：发给模型的，不随界面语言变。
	return `用户拒绝了把这条${subject}提权到「${MODE_LABEL[target]}」。${DECLINED}`;
}
