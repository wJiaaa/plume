/**
 * 每个风险问题都由这几样拼成：一个判断、做出判断的两种办法，以及「这里是不是干活的地方」。
 *
 * 放在这里而不是命令规则或路径规则里，是为了谁都不用引用谁：命令规则和路径规则是兄弟，不是上下层。
 */

import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { RiskCode, RiskParams } from "./messages.ts";
import { within } from "./paths.ts";

export interface RiskVerdict {
	risky: boolean;
	/** 哪条规则说的。审批卡按它、用界面语言写理由（`riskText`）。 */
	code?: RiskCode;
	/** 那条规则的句子要填的值。 */
	params?: RiskParams;
}

export const SAFE: RiskVerdict = { risky: false };

export const risky = (code: RiskCode, params?: RiskParams): RiskVerdict => ({ risky: true, code, ...(params ? { params } : {}) });

/**
 * 正在判定的这次调用所在会话同一脉的临时目录（`ToolApproval.scratchDirs`），只在 `withScratchDirs` 里有值。
 *
 * 不一层层传参：从 `assess` 往下十来个判定函数都只带着 `cwd`，草稿区和它是同一件事。判定是同步的，设上、跑完、复原，
 * 中间插不进别的会话的判定。别的会话的临时目录不在里面：往那里写、删那里的东西是动别的对话的草稿，要问。
 */
let sessionScratch: readonly string[] = [];

export function withScratchDirs<T>(dirs: readonly string[], judge: () => T): T {
	const previous = sessionScratch;
	sessionScratch = dirs;
	try {
		return judge();
	} finally {
		sessionScratch = previous;
	}
}

/**
 * 正当干活的地方：项目、系统临时目录，和同一脉的会话的临时目录。
 *
 * 临时目录算进来，是因为 agent 本来就往那里放草稿：一个预览、一份日志、一个用完就扔的脚本。问人「agent 能不能写它的草稿」
 * 不是安全问题，是毛病，而且会让一次无人值守的运行停在第一份草稿上。
 *
 * `~/.plume` 的其余部分不在里面：模型设置、加密的 key 和它的钥匙、会话都在那里，值得问一句。
 */
export function scratchRoots(cwd?: string): string[] {
	/*
	 * `/tmp` 按名字也算，不只认 API 给的那个。
	 *
	 * macOS 上 `tmpdir()` 是每个用户自己的 `/var/folders/...`，而人和模型实际敲的都是 `/tmp`：路径不同，一样是临时的。
	 * 只认 API 给的，测试里看着对，真命令照样被拦。
	 */
	const roots = [tmpdir(), "/tmp", "/private/tmp"];
	roots.push(...sessionScratch);
	if (cwd) roots.push(cwd);
	// 根是 `/` 会让整台机器都成了「草稿」：丢掉它，不信它。
	return roots.map((root) => root.replace(/\/+$/, "")).filter((root) => root.length > 1);
}

/**
 * 整个清空一个草稿目录的通配符。
 *
 * `/tmp/inkwell-*.log` 是 agent 自己的文件，`/tmp/*` 是所有人的。系统临时目录和机器上每个进程共用，
 * 「可以写的地方」不等于「可以清空的地方」：和 `rm -rf dist` 对 `rm -rf *` 是同一个区别。
 *
 * 界线是通配的那一段有没有说出点什么：光一个 `*` 什么都没指名，带了字面字符的模式指的是一类文件。
 */
export function wipesScratchRoot(target: string, cwd?: string): boolean {
	// 引号写成 \x27\x22：直接写的话，文案检查会把正则里的它们当成字符串的开头。
	const path = target.replace(/^[\x27\x22]|[\x27\x22]$/g, "");
	const segments = path.split("/");
	const last = segments[segments.length - 1] ?? "";
	if (!/^\*+$/.test(last)) return false;
	const prefix = segments.slice(0, -1).join("/");
	return scratchRoots(cwd).includes(prefix);
}

/**
 * 草稿正当待着的地方：项目或系统临时目录下面。
 *
 * 让 agent 收拾自己的草稿（`rm -f /tmp/its-own-log-*.log`）不是哪个人能比规则判得更好的决定。
 * 根本身从不算在里面：`/tmp/x` 是收拾，`/tmp` 里还有别人的文件；这两棵树之外的（家目录、`/etc`、别的项目）也不算。
 */
export function underScratchRoot(target: string, cwd?: string): boolean {
	const path = target.replace(/^[\x27\x22]|[\x27\x22]$/g, "");
	if (!isAbsolute(path)) return false;
	return scratchRoots(cwd).some((root) => within(root, path));
}
