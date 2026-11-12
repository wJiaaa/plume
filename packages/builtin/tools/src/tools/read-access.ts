/**
 * 一个路径能不能读：不管哪个工具来读，都是同一个答案。
 *
 * 只有一个答案，是因为两个答案就有一条绕过去的路：文件工具拒了的，换个工具读得到，模型就学会去绕。
 * 判断不看是谁在问：
 *
 *   - 放行：工作区、同项目的其他目录、会话的临时目录、用户拖进来的文件、工具链本来就要读的系统目录。不问，
 *     因为 `ls /usr/bin` 也弹的提示，人会学会不看就点。
 *   - 问人：别的地方。不是拒绝：拒绝让人没法说「对，读我另一个项目」，也给了模型去找 shell 的理由。
 *     批准的是一个目录而不是一个文件，批准一次就打开了人说的那个项目。
 *
 * 密钥在工作区之前判：密钥读了不是坏了，是用掉了，「碰巧在项目里」不是不问就交出去的理由。
 * 密钥的批准只管这一个文件，绝不扩大到放着其他密钥的目录。
 */

import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { words } from "../messages.ts";
import { home, scratchHome } from "./home.ts";
import { displayPath, toAbsolute } from "./paths.ts";
import { commandDialects, commandShell, dialectsOf, withinOrIs, splitCommands, splitWords, type Dialect } from "@plume/platform";
import { DECLINED } from "./result.ts";
import type { ToolContext } from "./types.ts";

export { toAbsolute } from "./paths.ts";

/** 本机的密钥文件（引号写成 `\x27\x22\x60`：直接写的话文案检查会把它当成字符串的开头）：Plume 的模型设置（Magpie 网关的 key 明文在里面）、加密存放供应商 key 的 `credentials.json` 和它的钥匙 `vault.key`（插件的 `ctx.secrets` 也用它）、ssh 私钥、云服务的凭据、gpg、netrc、gh 的登录。 */
const SECRET_PATH =
	/(?:^|[/\\\s\x27\x22\x60=@:<>(|;&])(?:\.(?:plume[/\\](?:settings\.json|credentials\.json|vault\.key)|ssh[/\\]id_[A-Za-z0-9_]+|aws[/\\]credentials|gnupg\b|netrc|config[/\\]gh[/\\]hosts\.yml))(?=$|[/\\\s\x27\x22\x60;&|<>)])/i;

export type ReadVerdict =
	| { decision: "allow" }
	| {
			/** 要人点头。`reason` 是交给模型的结果里的说法。 */
			decision: "ask";
			reason: string;
			/** `file` 只批准这一个文件，给密钥用。 */
			scope: "file" | "tree";
	  };

export interface ReadAccessOptions {
	/** 这一轮明确交给它的工作区外的文件，见 `ToolContext.allowedPaths`。 */
	allowedPaths?: ReadonlySet<string> | readonly string[];
	/** 同一个项目的其他源码目录：放进同一个项目，就是说它们属于一起。 */
	projectRoots?: readonly string[];
}

/**
 * 工具链本来就要读的目录，不是「别人的另一个项目」。
 *
 * 分的是机器和人的工作：`ls /usr/bin`、`cat /etc/hosts` 是在看它跑在什么机器上，`cat ~/Developer/thing/x` 是在看你的东西。
 * 只有后者值得问。家目录不在这里：家目录下被写在命令行上的，正是值得问的那些。
 */
const SYSTEM_ROOTS = [
	"/usr",
	"/bin",
	"/sbin",
	"/opt",
	"/etc",
	// macOS 上 `/etc` 是指向这里的链接，判定看的是解析后的路径（`resolveForReading`）。
	"/private/etc",
	"/dev",
	"/proc",
	"/sys",
	"/System",
	"/Library",
	"/Applications",
	"/var/folders",
	"/private/var/folders",
	"/tmp",
	"/private/tmp",
	"C:\\Windows",
	"C:\\Program Files",
	"C:\\Program Files (x86)",
];

/**
 * 读这个路径要不要人点头，点头覆盖什么。
 *
 * 纯函数，收的是已经是绝对路径的：调用方知道 `~` 指的是谁，自己解析路径的判断离开家目录就没法测。
 */
export function assessRead(absolute: string, cwd: string, options: ReadAccessOptions = {}): ReadVerdict {
	// 人交过来的就是人给的。在密钥规则之前：把密钥拖进对话是被保护的人自己做的，再让他确认一遍只会让保护变成走过场。
	if (options.allowedPaths) {
		const allowed = options.allowedPaths instanceof Set ? options.allowedPaths : new Set(options.allowedPaths);
		if (allowed.has(absolute)) return { decision: "allow" };
	}

	// i18n-exempt：交给模型的结果里用的说法；审批卡上的标题另走 i18n。
	if (SECRET_PATH.test(absolute)) return { decision: "ask", reason: "读取本机密钥文件", scope: "file" };

	if (withinOrIs(cwd, absolute)) return { decision: "allow" };
	// 在密钥规则之后，和工作区一样：把一个目录放进项目是说「这是我要做的」，不是「读我放在里面的密钥」。
	for (const root of options.projectRoots ?? []) if (withinOrIs(root, absolute)) return { decision: "allow" };
	/*
	 * 模型自己的草稿：太大没交给它的图、截断前的全文都存在这里，让它读回来还要问人，只会让人替它点头。读不分是哪个会话的：
	 * 子智能体的报告、别的对话存下的全文，读都不问。写只限同一脉的会话的，见 `paths.ts` 的 `scratchDirsOf`。
	 */
	if (withinOrIs(scratchHome(), absolute)) return { decision: "allow" };

	const temp = tmpdir();
	if (withinOrIs(temp, absolute)) return { decision: "allow" };
	for (const root of SYSTEM_ROOTS) if (withinOrIs(root, absolute)) return { decision: "allow" };

	// i18n-exempt：交给模型的结果里用的说法；审批卡上的标题另走 i18n。
	return { decision: "ask", reason: "读取当前项目之外的位置", scope: "tree" };
}

/**
 * 批准覆盖的目录：往上走到它所属的项目。
 *
 * 要碰文件系统，所以和 `assessRead` 分开。人说「读我另一个项目」，想的是仓库根，只批准一个文件所在的目录，
 * 下一个文件又得问。走到家目录为止：覆盖 `~` 的批准不是谁想给的。
 */
export function readGrantRoot(absolute: string, isDirectory: boolean, exists: (path: string) => boolean): string {
	const start = isDirectory ? absolute : resolve(absolute, "..");
	const ceiling = resolve(home());
	const root = resolve(start, "/");

	// 家目录和根目录永远不当批准范围：直接放在它们下面的文件，上一级就是它们，「以后不再问」就成了整台机器。
	// 找不到项目时只批准这个文件，而不是扩大到上面的一切。
	if (start === ceiling || start === root) return absolute;

	let current = start;
	for (let depth = 0; depth < 40; depth++) {
		if (current === ceiling || current === resolve(current, "..")) break;
		if (exists(join(current, ".git"))) return current;
		const parent = resolve(current, "..");
		if (parent === ceiling || parent === root) break;
		current = parent;
	}
	return start;
}

/**
 * 一行命令写明的路径，好对 shell 用同一个判断。
 *
 * 只认字面写法：要 shell 才知道是什么的词——`$DIR/key`、通配符、替换——不在这里解，猜的结果既会误放也会误问。
 * 抓到的是模型实际会写的东西：直接写出来的路径。heredoc 的正文是喂给命令的数据，不是它要打开的路径
 * （`python3 - <<'EOF'`、`cat > file <<'EOF'` 里带着整段程序和文件内容），`splitCommands` 照 bash 的读法把它去掉。
 */
export function commandReadTargets(command: string, cwd: string, dialects: readonly Dialect[] = commandDialects()): string[] {
	const found = new Set<string>();
	/*
	 * 按 shell 可能读这一行的每种语法各读一遍，哪种读法找到的路径都留着。shell 是 PowerShell 的地方，
	 * `C:\Users\me\.ssh\id_rsa` 是一个路径，而 bash 的读法把反斜杠当转义，永远看不到它。知道由哪个 shell 跑的调用方
	 * 传它的语法（`authorizeCommandReads` 就是），否则按每种可能的都读。
	 */
	for (const dialect of dialects)
		for (const piece of splitCommands(command, dialect)) {
			const words = splitWords(piece, dialect);
			// 第一个词是程序，不是它读的东西。
			for (let i = 1; i < words.length; i++) {
				const word = words[i]!;
				/*
				 * 重定向的目标是被写的，不是被读的：`echo hi > ~/notes.txt` 写明了工作区外的路径，却什么都没读。
				 * 在这里判它，会对一个正要被创建的文件问「能不能读」，还抢在真正守边界的沙箱之前回答了。写有它自己的规则。
				 */
				if (REDIRECT_WRITE.test(word)) continue;
				if (REDIRECT_WRITE.test(words[i - 1]!)) continue;
				// `< input` 是读，操作符可能和路径连着写。
				const bare = word.replace(/^<+/, "");
				if (!bare || bare.startsWith("-")) continue;
				// shell 会改写的词判不了，见上。
				if (/[$*?\x60]/.test(bare)) continue;
				// 脚本不是路径：`python3 -c "<二十行>"` 对拆分来说是一个词。带换行的、比任何真实路径都长的都不判。
				if (bare.includes("\n") || bare.length > 400) continue;
				found.add(toAbsolute(cwd, bare));
			}
		}
	return [...found];
}

/** `>`、`>>`、`2>`、`&>`：单独写或连着后面的路径。 */
const REDIRECT_WRITE = /^\d*(>>?|&>)/;

export type ReadAuthorization = { ok: true; absolute: string } | { ok: false; message: string };

/**
 * 「以后不再问」记在什么名下。加 `read:` 前缀，免得和 bash 记的命令原文撞上。
 */
function readGrantSubject(grant: string): string {
	return `read:${grant}`;
}

/**
 * 解析一个工具要读的路径，出了工作区就问人。
 *
 * read、ls、grep、glob 都经这里：一个判断，用在每个开始读的地方，哪个工具都不是绕过另一个的捷径。
 * 没有问人的入口时拒绝而不是放行：没人可问，就是没人同意过。
 */
export async function authorizeRead(ctx: ToolContext, input: string): Promise<ReadAuthorization> {
	// i18n-exempt：发给模型的话。
	if (!input || typeof input !== "string") return { ok: false, message: "A path is required." };
	const literal = toAbsolute(ctx.cwd, input);
	const absolute = attached(ctx, literal) ? literal : await resolveForReading(ctx.cwd, literal);
	const verdict = assessRead(absolute, ctx.cwd, {
		...(ctx.allowedPaths ? { allowedPaths: ctx.allowedPaths } : {}),
		projectRoots: await realProjectRoots(ctx),
	});
	if (verdict.decision === "allow" || !worthAsking(absolute, verdict)) return { ok: true, absolute };

	const approved = await askForRead(ctx, absolute, verdict);
	return approved.ok ? { ok: true, absolute } : approved;
}

/** 源目录自身可以是链接；按真实根授权，仍让文件的真实路径先经过密钥判断。 */
async function realProjectRoots(ctx: ToolContext): Promise<string[]> {
	return Promise.all((ctx.projectRoots ?? []).map((root) => realpath(root).catch(() => root)));
}

/**
 * 判定前先解析符号链接：否则工作区里一个指向外面的链接，不经询问就能读到外面。
 *
 * 解析后仍在工作区里的，换回 cwd 下的写法：工作区自己在链接后面时（`~/code` 指向另一块盘），
 * 真实路径不以 cwd 字面开头，按真实路径判会把自己的项目当成外面。不存在的路径原样返回：
 * 没有东西可读，`worthAsking` 也不会为它问。
 */
async function resolveForReading(cwd: string, absolute: string): Promise<string> {
	let real: string;
	try {
		real = await realpath(absolute);
	} catch {
		return absolute;
	}
	if (withinOrIs(cwd, real)) return real;
	// read 传进来的已是真实路径，所以这一步不以「解析前后不同」为前提。
	const realCwd = await realpath(cwd).catch(() => cwd);
	return withinOrIs(realCwd, real) ? resolve(cwd, relative(realCwd, real)) : real;
}

/** 用户拖进来的就是用户给的，哪怕它是一个链接：判定照字面，见 `assessRead` 开头。 */
function attached(ctx: ToolContext, literal: string): boolean {
	return ctx.allowedPaths?.has(literal) ?? false;
}

/**
 * 那里有没有东西可透露。
 *
 * 不存在的路径读不了，为它问换不来安全，只多一次提示；工具自己的「找不到」才是诚实的回答。
 * 密钥不管在不在都问：「不在」只和这里解析路径的方式一样可靠，一次多余的提问比漏掉一把钥匙便宜。
 */
function worthAsking(absolute: string, verdict: ReadVerdict): boolean {
	if (verdict.decision === "ask" && verdict.scope === "file") return true;
	return existsSync(absolute);
}

/**
 * 同一个判断，用在 shell 命令写明的路径上。
 *
 * 在只读命令表之前判，顺序就是要点：那张表说的是命令改不改东西，对 `cat` 它不管指向哪都答「不改」，判成只读的命令
 * 根本不问人。不先判读的话，bash 就成了绕过 read 的工作区边界和密钥规则的路：`cat ~/.ssh/id_ed25519` 直接过去。
 *
 * 一个批准范围只问一次，不是一个路径问一次：`grep -r x ../other/a ../other/b` 写了同一个项目里的两个文件。
 * 返回要报的拒绝，全部放行或批准了是 null。
 */
export async function authorizeCommandReads(command: string, ctx: ToolContext): Promise<string | null> {
	const asked = new Map<string, { absolute: string; verdict: Extract<ReadVerdict, { decision: "ask" }> }>();
	const projectRoots = await realProjectRoots(ctx);
	/*
	 * 按会话里真正跑这条命令的 shell 的语法读（`ToolRun.shell()`）：Windows 上受约束时是 PowerShell，不受约束时是 Git Bash。
	 * 那里不管哪个跑都按两种读的话，Git Bash 下的 bash heredoc 也会被 PowerShell 读一遍，而 PowerShell 没有 heredoc：
	 * `<<'EOF'` 里不会跑的正文成了活代码，人被问到一个什么都不会打开的文件。
	 */
	for (const literal of commandReadTargets(command, ctx.cwd, dialectsOf(ctx.shell ?? commandShell()))) {
		// 和文件工具同一判定：链接按它指向的地方算，见 `resolveForReading`。
		const absolute = attached(ctx, literal) ? literal : await resolveForReading(ctx.cwd, literal);
		const verdict = assessRead(absolute, ctx.cwd, {
			...(ctx.allowedPaths ? { allowedPaths: ctx.allowedPaths } : {}),
			projectRoots,
		});
		if (verdict.decision === "allow" || !worthAsking(absolute, verdict)) continue;
		const grant = grantFor(absolute, verdict);
		if (!asked.has(grant)) asked.set(grant, { absolute, verdict });
	}
	for (const { absolute, verdict } of asked.values()) {
		const approved = await askForRead(ctx, absolute, verdict);
		if (!approved.ok) return approved.message;
	}
	return null;
}

/**
 * 密钥按它自己批准，别的按它所属的项目批准。
 *
 * 不对称是有意的：「读我另一个项目」指的是整个项目，逐个文件问只会让人把提示关掉；
 * 「读这把钥匙」指的就是这一把，扩大到 `~/.ssh` 等于一次点击交出所有钥匙。
 */
function grantFor(absolute: string, verdict: Extract<ReadVerdict, { decision: "ask" }>): string {
	if (verdict.scope === "file") return absolute;
	return readGrantRoot(absolute, directoryLike(absolute), (path) => existsSync(path));
}

async function askForRead(
	ctx: ToolContext,
	absolute: string,
	verdict: Extract<ReadVerdict, { decision: "ask" }>,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const shown = displayPath(ctx.cwd, absolute);
	if (!ctx.requestApproval) {
		// i18n-exempt：交给模型的结果。
		return { ok: false, message: `${verdict.reason}需要用户批准，而这个会话没有可以询问的人：${shown}` };
	}

	const grant = grantFor(absolute, verdict);
	// 标题只给文件名（整条绝对路径会折成两行），正文给那条路径（卡片上是等宽字体），
	// `reason` 说批准意味着什么，不复述标题。
	const name = basename(absolute) || shown;
	const decision = await ctx.requestApproval({
		kind: "view",
		title: verdict.scope === "file" ? words().readSecret(name) : words().readOutside(name),
		detail: absolute,
		reason: verdict.scope === "file" ? words().readSecretScope : words().readTreeScope(grant),
		subject: readGrantSubject(grant),
	});
	if (decision === "once" || decision === "always") return { ok: true };
	// i18n-exempt：交给模型的结果。
	return { ok: false, message: `用户拒绝了这次读取：${shown}。${DECLINED}` };
}

/** 批准时把这个路径当不当目录；不存在的不当。 */
function directoryLike(absolute: string): boolean {
	try {
		return statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}
