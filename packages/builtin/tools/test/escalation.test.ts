/**
 * 被拒之后申请更大的权限：两个参数一起来或都不来，不比当前宽的申请到不了人面前，
 * 每种拒绝的说法都分得开，模型才知道是「申请错了」还是「用户不同意」。
 */

import { describe, expect, it } from "vitest";
import {
	DECLINED,
	ESCALATION_TARGETS,
	EscalationError,
	escalationDeclined,
	escalationHint,
	escalationTarget,
	MODE_LABEL,
	sandboxDenialMarker,
	validateEscalationArgs,
} from "../src/escalation.ts";

describe("validateEscalationArgs", () => {
	it("两个参数要么一起来，要么都不来", () => {
		// 没理由的提权弹窗时没东西给人看；没申请的理由只是嘴上说说。
		expect(() => validateEscalationArgs("workspace-write", undefined)).toThrow(EscalationError);
		expect(() => validateEscalationArgs(undefined, "because")).toThrow(EscalationError);
		expect(() => validateEscalationArgs("workspace-write", "   ")).toThrow(EscalationError);
		expect(() => validateEscalationArgs(undefined, undefined)).not.toThrow();
		expect(() => validateEscalationArgs("workspace-write", "需要写构建产物")).not.toThrow();
	});
});

describe("escalationTarget", () => {
	it("不比当前宽的申请无效", () => {
		expect(() => escalationTarget("workspace-write", "workspace-write")).toThrow(EscalationError);
		expect(() => escalationTarget("workspace-write", "workspace-write")).toThrow(/不比当前的「可写项目目录」更宽/);
		// 伪装成提权的收窄。
		expect(() => escalationTarget("read-only", "workspace-write")).toThrow(EscalationError);
		// 已经是完全访问，没有更宽的了。
		expect(() => escalationTarget("danger-full-access", "danger-full-access")).toThrow(EscalationError);
		expect(() => escalationTarget("bogus", "read-only")).toThrow(EscalationError);
	});

	it("每一步变宽都可以", () => {
		expect(escalationTarget("workspace-write", "read-only")).toBe("workspace-write");
		expect(escalationTarget("danger-full-access", "read-only")).toBe("danger-full-access");
		expect(escalationTarget("danger-full-access", "workspace-write")).toBe("danger-full-access");
	});

	it("可提权的目标不含 read-only", () => {
		expect(ESCALATION_TARGETS).toEqual(["workspace-write", "danger-full-access"]);
	});
});

describe("给模型的话", () => {
	it("拒绝标记说明是策略拒绝，不是命令坏了", () => {
		const marker = sandboxDenialMarker("workspace-write");
		expect(marker).toMatch(/策略拒绝/);
		expect(marker).toMatch(/换个写法重试没有用/);
		expect(marker).toContain(MODE_LABEL["workspace-write"]);
	});

	it("提示跟着拒绝一起到，说清怎么申请", () => {
		// 放在结果里：刚被拒的模型读的是这里，不会回头重读一百条消息之前的 schema。
		expect(escalationHint("命令")).toMatch(/escalate/);
		expect(escalationHint("命令")).toMatch(/justification/);
		expect(escalationHint("命令")).toMatch(/弹窗问用户/);
	});

	it("用户拒绝用自己的说法，并接上别绕过去的话", () => {
		const text = escalationDeclined("命令", "danger-full-access");
		expect(text).toMatch(/^用户拒绝了把这条命令提权到「完全访问」。/);
		expect(text.endsWith(DECLINED)).toBe(true);
	});
});
