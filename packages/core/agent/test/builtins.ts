/**
 * 随应用发的内置插件（`packages/builtin/` 下的那些）。端到端的测试按产品真实的样子带上它们：
 * 工具、沙箱、帮我批准的风险规则、向人提问、系统提示词、压缩这些不在本体里，不带的话测到的是一个用户永远用不到的 agent。
 * 只带循环离不开的这几样：待办清单、技能、命令、网页、用量、智能标题也随应用发，但它们往工具表、系统提示词里加东西，
 * 智能标题还在后台另发一次模型请求，技能会读本机的 ~/.claude/skills；各自在自己的目录里测，要用的测试单独带上（如 todo）。
 */

import type { PluginEntry } from "@plume/contract";
import approval from "../../../builtin/approval/src/index.ts";
import askUser from "../../../builtin/ask-user/src/index.ts";
import compaction from "../../../builtin/compaction/src/index.ts";
import diagnostics from "../../../builtin/diagnostics/src/index.ts";
import delivery from "../../../builtin/delivery/src/index.ts";
import prompt from "../../../builtin/prompt/src/index.ts";
import sandbox from "../../../builtin/sandbox/src/index.ts";
import tools from "../../../builtin/tools/src/index.ts";

export const BUILTINS: PluginEntry[] = [sandbox, tools, approval, askUser, prompt, compaction, delivery, diagnostics].map((plugin) => ({
	key: plugin.name,
	builtin: true,
	load: async () => plugin,
}));
