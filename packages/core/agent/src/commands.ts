/**
 * 替模型跑命令时本体守的线：权限模式对应哪一档沙箱，提权只认人答、批了才换档，只读（`ToolExecution.readOnly`）一律只读。
 *
 * 权限模式不只是问几次，也是命令碰得到哪些文件。这件事原来由跑命令的插件自己按权限模式选沙箱、自己决定提权以后用哪一档，
 * 换掉那个插件，界面上「请求批准」「帮我批准」说的就不再成立；系统提示词点名 shell 时又得另抄一份对应表。现在都在这里：
 * 工具经 `ToolRun` 上的 `shell`、`exec`、`escalate`（`commandAccess` 为每次调用造一份）用，系统提示词经 `ModelContext.shell`。
 * 沙箱本身（seatbelt、受限令牌、登录 shell 的环境）在 `@plume/sandbox`；循环（`tool-run.ts`）不认识这些档位，只经
 * `ToolScope.commands` 把它们挂到 `run` 上。
 *
 * 不先猜命令危不危险再提权：命令先在沙箱里跑，被拒是事实而不是预测，模型被告知被拒了、可以带一句理由申请一次更宽的模式，这时才问人。
 * 于是提权卡的次数等于 agent 真正越线的次数；批准只用在申请它的那一次调用上，什么都不累积，会话不会比开始时更宽。
 */

import type { ModelContext, PermissionMode, RunProcess, SandboxMode, ShellInfo, ToolRun } from "@plume/contract";
import { commandShell } from "@plume/platform";
import { looksDenied, runCommand, selectRunner } from "@plume/sandbox";
import { DECLINED } from "./declined.ts";
import type { CallCommands } from "./tool-run.ts";

/**
 * 每个权限模式下命令跑在哪个沙箱模式里。请求批准只读，什么都不经人同意就写不了；帮我批准能写项目目录和临时目录，项目随便改，
 * `~/.ssh` 碰不到；完全访问不设沙箱。三个模式都写全：新加一个模式时 TypeScript 会指到这张表，不会因为没查到就悄悄落到最宽的那个。
 */
const SANDBOX_BY_PERMISSION: Record<PermissionMode, SandboxMode> = {
	ask: "read-only",
	auto: "workspace-write",
	full: "danger-full-access",
};

/** 会话宣布的那一档：外层要求只读时不看权限模式，一律只读。 */
function sandboxFor(mode: PermissionMode, readOnly: boolean): SandboxMode {
	return readOnly ? "read-only" : SANDBOX_BY_PERMISSION[mode];
}

/**
 * 这一档的命令跑在哪个 shell 里（`@plume/platform` 的 `commandShell`）：Windows 上受约束的跑 PowerShell，完全访问跑 Git Bash；
 * 别的平台每档都是同一个 shell。
 */
function shellFor(mode: PermissionMode, readOnly: boolean): ShellInfo {
	const sandbox = sandboxFor(mode, readOnly);
	const { kind, label } = commandShell(sandbox);
	return { kind, label, sandbox };
}

/**
 * `ModelContext.shell` 跟着 `permissionMode`、`readOnly` 走：开头算一次，每层交接时重算，外层（计划模式）设了 `readOnly`，
 * 里层点名 shell 的那一层拿到的就是只读那一档的。
 */
export function settleShell<T extends ModelContext>(context: T): T {
	if (!context || typeof context !== "object" || !(context.permissionMode in SANDBOX_BY_PERMISSION)) return context;
	const shell = shellFor(context.permissionMode, context.readOnly === true);
	const same = context.shell?.kind === shell.kind && context.shell.label === shell.label && context.shell.sandbox === shell.sandbox;
	return same ? context : { ...context, shell };
}

/** `ModelContext` 开头的那一份。 */
export function contextShell(mode: PermissionMode): ShellInfo {
	return shellFor(mode, false);
}

/**
 * 每个模式能提到哪些模式；没有键的不能提权。
 *
 * 只能严格变宽。不存在两个模式各自允许对方不允许的东西；允许不是变宽的「换模式」，批准的提权就可能悄悄拿走点什么，那不是任何人批准过的。
 */
const WIDER: Partial<Record<SandboxMode, readonly Exclude<SandboxMode, "read-only">[]>> = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"],
};

/** 每个模式用文字说出来时的名字（提权的报错里用它）。 */
// i18n-exempt：发给模型的，不随界面语言变。
const MODE_LABEL: Record<SandboxMode, string> = {
	"read-only": "只读",
	"workspace-write": "可写项目目录",
	"danger-full-access": "完全访问",
};

// i18n-exempt：下面这些都是交给模型的工具结果，不随界面语言变。
const READ_ONLY =
	"Not run: this conversation may not change files right now, so commands run in a read-only sandbox and may not leave it. Run it without `escalate`.";
const NO_JUSTIFICATION = "提权请求必须带上 justification：弹窗要有一句话告诉用户为什么。";
const EMPTY_JUSTIFICATION = "justification 不能是空的。";
const notWider = (requested: string, current: SandboxMode) => `「${requested}」不比当前的「${MODE_LABEL[current]}」更宽，提权请求无效。`;
/** 人拒绝提权时给模型的话：和「申请得不对」分得开，模型才知道该换办法而不是改参数重试。 */
const declined = (target: SandboxMode) => `用户拒绝了把这条命令提权到「${MODE_LABEL[target]}」。${DECLINED}`;

/** 一次调用的 `ToolRun.shell`、`exec`、`escalate`。提权批下来的那一档只记在这里，调用答完就随它没了。 */
export function commandAccess(call: CallCommands): Pick<ToolRun, "shell" | "exec" | "escalate"> {
	let granted: SandboxMode | undefined;
	const announced = async () => sandboxFor(await call.permission(), call.readOnly);
	return {
		shell: async () => shellFor(await call.permission(), call.readOnly),

		/*
		 * 先查后问：不比现在宽的申请什么都不授予，没东西可决定，不到人面前；到人面前的是模型自己说的理由。
		 * 卡带着 `escalation`，经 `ask` 走过闸：完全访问、外层放行、钩子的放行、「以后不再问」都不算数，只有人（或代管插件转达）答应了才换档。
		 */
		async escalate(request) {
			call.alive("ToolRun.escalate");
			const { mode, justification, title, detail } = request ?? ({} as Partial<typeof request>);
			// 外层要求这次不改工作区（计划模式）时命令一律在只读沙箱里跑，提权就是要离开它：不到人面前，直接拒。
			if (call.readOnly) return { granted: false, message: READ_ONLY };
			// 没有理由的提权弹出来没东西给人看。
			if (justification === undefined) return { granted: false, message: NO_JUSTIFICATION };
			if (typeof justification !== "string" || justification.trim().length === 0) return { granted: false, message: EMPTY_JUSTIFICATION };
			const current = granted ?? (await announced());
			const target = (WIDER[current] ?? []).find((wider) => wider === mode);
			if (!target) return { granted: false, message: notWider(String(mode), current) };
			const decision = await call.ask({ kind: "command", title: String(title), detail: String(detail ?? ""), reason: justification, escalation: target });
			if (decision === "reject") return { granted: false, message: declined(target) };
			granted = target;
			return { granted: true };
		},

		async exec(command, options = {}) {
			call.alive("ToolRun.exec");
			/*
			 * 命令是照哪个 shell 写的，就用哪个跑：按会话宣布的那一档选（系统提示词里告诉模型的那个），不按提权到的那一档。
			 * Windows 上提权成完全访问的 PowerShell 命令仍是 PowerShell。
			 */
			const shellMode = await announced();
			const mode = granted ?? shellMode;
			const process = runCommand(command, { cwd: options.cwd ?? call.cwd, ...(options.env ? { env: options.env } : {}), mode, shellMode });
			const run: RunProcess = Object.assign(process, {
				mode,
				denied: (output: string) => mode !== "danger-full-access" && looksDenied(output, selectRunner()),
			});
			return run;
		},
	};
}
