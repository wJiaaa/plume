/**
 * 「帮我批准」档下的一次判断：这件事要不要问人。
 *
 * `subject` 是命令、路径这类决定真正关于的东西，不是模型包在外面的说明文字。
 */

import type { RiskCode, RiskParams } from "./messages.ts";
import { assessCommand, assessWrite } from "./risk.ts";
import { SECRET_PATH } from "./risk-tables.ts";

export interface AssessVerdict {
	risky: boolean;
	/** 哪条规则说的，有的话。审批卡按它用界面语言写理由（`riskText`）。 */
	code?: RiskCode;
	/** `code` 的句子要填的值。 */
	params?: RiskParams;
}

/** `kind` 是审批请求说的那一类事（`ApprovalRequest.kind`）：跑命令、写出或改文件、读文件，不认是哪个工具问的。 */
export function assess(kind: string, subject: string, cwd: string): AssessVerdict {
	if (kind === "command") return assessCommand(subject, cwd);
	if (kind === "create" || kind === "modify") return assessWrite(subject, cwd);
	if (kind === "view") return assessView(subject);
	// 没见过的种类，这个判断不是为它写的，交给人。
	return { risky: true };
}

/**
 * 读：本体的读边界（`run.files` 读出了工作区、命令里写明了工作区外的路径）问过来的，`subject` 是 `read:<批准范围>`。
 *
 * 帮我批准下读哪里都不问，只有本机的密钥文件（供应商 key、Plume 的设置、ssh 私钥、云凭据……）要人点头：读别的项目、系统文件
 * 是 agent 正常看环境，读了也读不坏；钥匙读了就是交出去了。密钥的批准范围就是那个文件本身，所以按 `subject` 认得出来。
 * 认不出 `read:` 的读（插件的工具自己写的 `view`）交给人。
 */
function assessView(subject: string): AssessVerdict {
	if (!subject.startsWith("read:")) return { risky: true };
	return { risky: SECRET_PATH.test(subject.slice("read:".length)) };
}
