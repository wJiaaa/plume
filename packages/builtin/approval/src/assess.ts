/**
 * 「帮我批准」档下的一次判断：这件事要不要问人。
 *
 * `subject` 是命令、路径这类决定真正关于的东西，不是模型包在外面的说明文字。
 */

import type { RiskCode, RiskParams } from "./messages.ts";
import { assessCommand, assessWrite } from "./risk.ts";

export interface AssessVerdict {
	risky: boolean;
	/** 哪条规则说的，有的话。审批卡按它用界面语言写理由（`riskText`）。 */
	code?: RiskCode;
	/** `code` 的句子要填的值。 */
	params?: RiskParams;
}

export function assess(kind: string, subject: string, cwd: string): AssessVerdict {
	if (kind === "bash") return assessCommand(subject, cwd);
	if (kind === "edit" || kind === "write") return assessWrite(subject, cwd);
	/*
	 * 读走到这里，已经被读的工具自己判过了（`assessRead`）。
	 *
	 * 命令和写文件不一样：对它们，这里就是判断本身；而读的工具只有路径出了工作区才会来问。在这里重新判只可能推翻那个结论，
	 * 而 `risky: false` 意味着问题拟好了、没给任何人看，就被本该发问的这一方答了「行」。
	 *
	 * 下面兜底的那一行本来也会这么答。单写出来，是因为两者一致是巧合而不是设计：兜底说的是「这个判断没听说过的种类」，
	 * 而 read 是它认识的。以后有人收窄兜底时，得是有意删掉这一行才行。
	 */
	if (kind === "read") return { risky: true };
	// 没见过的种类，这个判断不是为它写的，交给人。
	return { risky: true };
}
