/**
 * 被沙箱拒了之后申请更大的权限：工具这边给模型看的话。申请合不合规矩、弹卡、换档、被拒的那句说明归本体，
 * 在 `packages/core/agent/test/commands.test.ts` 里测。
 */

import { describe, expect, it } from "vitest";
import { ESCALATION_TARGETS, escalationHint, JUSTIFICATION_ALONE } from "../src/escalation.ts";

describe("给模型的话", () => {
	it("可提权的目标不含 read-only", () => {
		expect(ESCALATION_TARGETS).toEqual(["workspace-write", "danger-full-access"]);
	});

	it("提示跟着拒绝一起到，说清怎么申请", () => {
		// 放在结果里：刚被拒的模型读的是这里，不会回头重读一百条消息之前的 schema。
		expect(escalationHint("命令")).toMatch(/escalate/);
		expect(escalationHint("命令")).toMatch(/justification/);
		expect(escalationHint("命令")).toMatch(/弹窗问用户/);
	});

	it("只给理由不申请：说清它不改变任何行为", () => {
		expect(JUSTIFICATION_ALONE).toMatch(/只能和 escalate 一起用/);
	});
});
