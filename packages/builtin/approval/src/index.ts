/**
 * 内置插件 plume.approval：钩子 tool.approve 上的一层，帮我批准（`auto`）档下按风险规则判一次操作要不要弹给人。
 *
 * 权限模式的含义在本体（完全访问放行、提权和 `userOnly` 只能由人答、`approved` 和「以后不再问」放行），到这里的都是本体要问人的。
 * 这里只判风险（`assess.ts`、`risk.ts`）：看不出风险的放行，命中规则的把理由写进卡片（按界面语言，`messages.ts` 的 `riskText`）
 * 再交给里层。请求批准档、层自己问的（`byLayer`，那个层自己要人点头，规则替人答了等于没问）、没有 `subject` 的、提权和
 * `userOnly` 都不归规则判，原样交给里层把审批卡弹给人。
 *
 * 挂在里层（order 1000）：别的插件在外层能先替人答，或者整个换掉这套规则。
 */

import type { Plugin } from "@plume/contract";
import { assess } from "./assess.ts";
import { riskText } from "./messages.ts";
import { withScratchDirs } from "./risk-shared.ts";

export default {
	name: "plume.approval",
	apply(ctx) {
		ctx.hook(
			"tool.approve",
			async (input, next) => {
				const { request } = input;
				if (input.permissionMode !== "auto" || input.byLayer || request.escalation !== undefined || request.userOnly || request.subject === undefined)
					return next(input);
				const { kind, subject } = request;
				const verdict = withScratchDirs(input.scratchDirs ?? [], () => assess(kind, subject, input.cwd));
				if (!verdict.risky) return "once";
				// 卡片上已有的理由（读项目外时说批准意味着什么）留着；规则说不出名字的，卡片照常画。
				if (request.reason !== undefined || verdict.code === undefined) return next(input);
				return next({ ...input, request: { ...request, reason: riskText(verdict.code, verdict.params, ctx.locale()) } });
			},
			{ order: 1000 },
		);
	},
} satisfies Plugin;
