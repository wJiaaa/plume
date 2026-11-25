/**
 * __NAME__ 的逻辑入口，跑在 agent 进程。
 *
 * 模板生成的示例：注册工具 __TOOL__，结果的 details 交给界面入口画成卡片；test/ 里是它的测试。换成你自己的逻辑；写法见 skill plume-plugin。
 */

import type { Plugin } from "@plume/contract";
import type { GreetingDetails } from "./types.ts";

export default {
	name: "__NAME__",
	apply(ctx) {
		ctx.tools.register({
			name: "__TOOL__",
			description: "Greet someone by name.",
			parameters: {
				type: "object",
				properties: { name: { type: "string", description: "Who to greet." } },
				required: ["name"],
			},
			async execute(args) {
				// 类型本体已按 parameters 查过，不用再 typeof；缺了 required 的和空串本体不拦，要自己拦。
				const name = (args.name as string | undefined)?.trim();
				if (!name) return { output: "name must be a non-empty string", isError: true };
				return { output: `Hello, ${name}!`, details: { name } satisfies GreetingDetails };
			},
		});
	},
} satisfies Plugin;
