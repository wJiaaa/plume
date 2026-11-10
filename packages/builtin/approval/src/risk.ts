/**
 * 一次操作有多危险，好让「帮我批准」名副其实。
 *
 * 白名单的做法行不通：只放行第一个词是几十个只读程序之一的命令，再见到任何 shell 元字符就一律拦下，单看每条都有道理
 * （`ls && rm -rf /` 确实以 `ls` 开头），合起来却让一个号称「只问危险操作」的档几乎什么都问，因为模型写的是
 * `cd x && git log; echo ---`，不是光秃秃的 `ls`。一直弹的审批卡不是安全措施，是人学会不看就点的东西，比没有还糟。
 *
 * 所以反过来：什么都放行，除非碰上真正有破坏性的东西。下面的表不是「会写的东西」（写就是 agent 的活），而是「收不回来的事」：
 * 删除、强制推送、改写历史、提权、把网络上的东西直接喂给 shell、碰项目以外的任何东西。
 */

import { isAbsolute } from "node:path";
import { commandDialects } from "@plume/platform";
import { withinOrIs } from "./paths.ts";
import { WINDOWS_DELETERS, climbsOut, findExec, judgeFind, judgeRm, judgeWindowsDelete } from "./risk-delete.ts";
import { judgeGit } from "./risk-git.ts";
import { judgeOpen } from "./risk-open.ts";
import { SAFE, risky, scratchRoots, underScratchRoot, type RiskVerdict } from "./risk-shared.ts";
import {
	COMMAND_PREFIXES,
	FETCHERS,
	INTERPRETERS,
	NEVER_UNATTENDED,
	PLACES_FILES,
	PROTECTED_PATH,
	RISKY_SUBCOMMANDS,
	SECRET_PATH,
	SHELLS,
} from "./risk-tables.ts";
import { pipelines, splitCommands, splitWords, substitutionHosts, type Dialect } from "./shell-split.ts";

export { assessWrite } from "./risk-paths.ts";

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * shell 要跑的那些词：引号已解，开头的 `VAR=value` 赋值已去。
 *
 * 每条规则都读这一份。各自按空白切的话和 shell 不一致：`'rm' -rf ~` 就是 `rm`，`rm -rf '/'` 删的是 `/`，
 * `HUSKY=0 git push --force` 是一次强制推送，只是第一个词是 `HUSKY=0`。这几条都曾被判成无害。
 */
function argvOf(command: string, dialect: Dialect): string[] {
	const words = splitWords(command, dialect);
	let i = 0;
	while (i < words.length && ASSIGNMENT.test(words[i]!)) i += 1;
	return words.slice(i);
}

/** `/usr/bin/open` 就是 `open`；`C:\Windows\System32\format.com`、`rm.exe` 就是 `format`、`rm`。 */
const programName = (word = "") => word.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com)$/i, "");

function firstWord(command: string, dialect: Dialect = "posix"): string {
	return programName(argvOf(command, dialect)[0]);
}

/**
 * 查表，也认大小写不同的写法。
 *
 * macOS 的文件系统默认不分大小写，`SUDO`、`Rm` 找到的就是 `/usr/bin/sudo`、`/bin/rm`：只按原样查，换个大小写就绕过了表。
 */
function lookup<T>(table: Map<string, T>, name: string): T | undefined {
	return table.get(name) ?? table.get(name.toLowerCase());
}

/**
 * 一个包装命令包着的命令；不是包装命令时为 null。
 *
 * `firstWord` 回答「这是哪个程序」，而对 `env`、`xargs`、`nohup`、`timeout` 和 shell 本身，这个答案不是真正干活的程序。
 * 不拆开的话，下面每条规则看的都是包装：`env rm -rf ~` 按 `env` 判，`bash -c "rm -rf ~"` 按 `bash` 判，哪张表上都没有，
 * 于是都无害。这不是表的漏洞（表是关于 `rm` 的），是「查什么」的漏洞。
 */
function wrappedCommand(command: string, dialect: Dialect = "posix"): string | null {
	const words = argvOf(command, dialect);
	if (words.length < 2) return null;
	const head = programName(words[0]);
	const lower = head.toLowerCase();

	/*
	 * PowerShell 的命令跟在 `-Command` 后面（任何不歧义的前缀，大小写随意），或者是 `-EncodedCommand` 后面 UTF-16 的
	 * base64：这正是一条命令躲开阅读的办法，所以解出来再判。cmd 的命令是 `/c` 或 `/k` 后面的整行。
	 */
	if (lower === "powershell" || lower === "pwsh") {
		const encoded = words.findIndex((word, index) => index > 0 && /^-e(c|nc|ncodedcommand)?$/i.test(word));
		if (encoded !== -1 && words[encoded + 1]) return Buffer.from(words[encoded + 1]!, "base64").toString("utf16le");
		const at = words.findIndex((word, index) => index > 0 && /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(word));
		return at === -1 || at + 1 >= words.length ? null : words.slice(at + 1).join(" ");
	}
	if (lower === "cmd") {
		const at = words.findIndex((word, index) => index > 0 && /^\/[ck]$/i.test(word));
		return at === -1 || at + 1 >= words.length ? null : words.slice(at + 1).join(" ");
	}

	// shell 把命令当成一个字符串，放在 `-c` 后面。`-lc`、`-ec` 这类也算。
	if (SHELLS.has(head)) {
		const at = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c$/.test(word));
		return at === -1 || at + 1 >= words.length ? null : words[at + 1]!;
	}
	// `eval` 把这一行剩下的都当命令，不管有几个词。
	if (head === "eval") return words.slice(1).join(" ");
	if (head === "find") return findExec(words.slice(1));

	if (!COMMAND_PREFIXES.has(head)) return null;

	let i = 1;
	// 包装命令自己的选项，以及它设的 `VAR=value`。
	while (i < words.length && (words[i]!.startsWith("-") || ASSIGNMENT.test(words[i]!))) {
		// `nice -n 10 cmd`、`timeout -k 5 …`、`xargs -n 1 cmd`：这个选项带一个参数。
		if (/^-[nPILsEek]$/.test(words[i]!) && i + 1 < words.length) i += 1;
		i += 1;
	}
	// `timeout 30s cmd`、`watch 2 cmd`：光秃秃的时长属于包装命令。
	if ((head === "timeout" || head === "watch") && i < words.length && /^\d+(\.\d+)?[smhd]?$/.test(words[i]!)) i += 1;
	if (i >= words.length) return null;

	const inner = words.slice(i).join(" ");
	// 只包着它自己的包装命令会无限递归下去。
	return inner === command.trim() ? null : inner;
}

/** 判断单独一条命令：没有串联、没有替换，`assessCommand` 已经先拆好了。 */
function judgeSingle(command: string, contained = false, cwd?: string, dialect: Dialect = "posix"): RiskVerdict {
	const argv = argvOf(command, dialect);
	const head = programName(argv[0]);
	if (!head) return SAFE;
	const args = argv.slice(1);

	const never = lookup(NEVER_UNATTENDED, head);
	if (never) return risky(never);

	if (WINDOWS_DELETERS.has(head.toLowerCase())) {
		const verdict = judgeWindowsDelete(args, contained);
		if (verdict.risky) return verdict;
	}

	// `iex (irm https://…)`：下载并执行，却没有管道，下面管道那条规则看不到。
	if (/\b(iex|invoke-expression)\b/i.test(command) && /\b(irm|iwr|invoke-(webrequest|restmethod)|downloadstring|net\.webclient)\b/i.test(command)) {
		return risky("download-and-run");
	}
	// `Start-Process … -Verb RunAs` 就是 Windows 的 `sudo`。
	if (head.toLowerCase() === "start-process" && /-verb\s+[\x27\x22]?runas\b/i.test(command)) return risky("run-as-admin");

	if (head === "rm") {
		const verdict = judgeRm(args, contained, cwd);
		if (verdict.risky) return verdict;
	}
	if (head === "find") {
		const verdict = judgeFind(args, contained, cwd);
		if (verdict.risky) return verdict;
	}
	if (head === "git") return judgeGit(argv);
	// LaunchServices 启动的东西跑在这条命令所在的沙箱外面，见 `risk-open.ts`。
	if (head === "open") {
		const verdict = judgeOpen(args);
		if (verdict.risky) return verdict;
	}
	// 清理卷会删掉卷里的数据；`docker volume ls`、`create` 不会。
	if (head === "docker" && args[0] === "volume" && args[1] === "prune") return risky("docker-prune");

	const table = lookup(RISKY_SUBCOMMANDS, head);
	if (table) {
		// 第一个操作数，所以 `pnpm -r publish` 也是发布。
		const code = lookup(table, args.find((word) => !word.startsWith("-")) ?? "");
		if (code) return risky(code);
	}

	/*
	 * 命令里任何地方点名了一个凭据，读也好写也好。
	 *
	 * 放在写的规则前面单独判、不并进去，是因为对钥匙来说读就是损失：`cat ~/.plume/settings.json` 什么都没弄坏，却交出了
	 * 存着的 API key；`curl -d @~/.ssh/id_ed25519` 是同一句话，多了个寄去的地方。只在重定向时才查路径的话，这两条都是无害。
	 */
	if (SECRET_PATH.test(command)) return risky("secret-file");

	// 重定向进系统位置，或者改 shell 自己的启动文件。
	if (/>\s*[^&\s]/.test(command) && PROTECTED_PATH.test(command)) return risky("write-system-path");
	if (/>\s*~?\/?\.(zshrc|bashrc|profile|zprofile)\b/.test(command)) return risky("shell-startup");
	// 不经重定向到达同样的地方：`cp payload /usr/local/bin/git`。
	if ((PLACES_FILES.has(head) || PLACES_FILES.has(head.toLowerCase())) && PROTECTED_PATH.test(command)) return risky("write-system-path");

	/*
	 * 本机的文件经网络出去。
	 *
	 * 上传不是写代码的步骤，而且是这张表上唯一用什么办法都收不回来的：离开了机器的文件就是离开了。
	 * `@` 是 curl 的「从文件里读」标记，它区分了发一个文件和发一段模型自己写的字符串。
	 */
	if (head === "curl" || head === "wget") {
		/*
		 * `@` 要在文件名该在的位置：值的开头，或者 curl `-F name=@file` 里字段名的后面。别处的 `@` 只是普通文字，
		 * `-d 'email=a@b.test'` 是在提交一个字符串，不是在上传文件。
		 */
		const uploads = /(^|\s)(-d|--data(-binary|-raw)?|-F|--form)(\s+|=)[\x27\x22]?([A-Za-z0-9_.-]+=)?@/;
		const puts = /(^|\s)(-T|--upload-file)(\s|=)/;
		if (uploads.test(command) || puts.test(command)) return risky("upload-file");
	}

	return SAFE;
}

const fetches = (head: string) => FETCHERS.has(head.toLowerCase());
const interprets = (head: string) => INTERPRETERS.has(head) || INTERPRETERS.has(head.toLowerCase());
/** 把给它的参数当代码跑的内建命令，和解释器一样。 */
const SOURCES = new Set(["eval", "source", "."]);

/**
 * 判断整行命令，包括它串起来的、替换出来的一切。
 *
 * 管道里任何一级危险，整条就危险：`cat x | sudo tee /etc/hosts` 不会因为以 `cat` 开头就变得无害。
 */
export function assessCommand(command: string, cwd?: string, depth = 0, dialects: readonly Dialect[] = commandDialects()): RiskVerdict {
	/*
	 * 按 shell 可能读它的每种语法各判一遍，见 `commandDialects`。有 PowerShell 的地方，一行既按 bash 读也按 PowerShell 读，
	 * 哪种读出危险都算：`echo "a\"; rm -rf ~; echo"` 在 bash 眼里是一个带引号的字符串（反斜杠转义了引号），在 PowerShell
	 * 眼里是两条命令（反斜杠是普通字符）。
	 */
	for (const dialect of dialects) {
		const verdict = assessIn(command, cwd, depth, dialect, dialects);
		if (verdict.risky) return verdict;
	}
	return SAFE;
}

function assessIn(command: string, cwd: string | undefined, depth: number, dialect: Dialect, dialects: readonly Dialect[]): RiskVerdict {
	/*
	 * 下载一个东西再交给解释器。
	 *
	 * 跑没人看过的代码的经典办法，一行摊平了就看不出来：`curl url` 和 `python3` 各自都平平无奇，危险在接起来的那一下，
	 * 所以这里问管道的视角，不对整行用正则。只认管道后面紧跟 shell 的正则管得了 `curl u | sh`，管不了 `curl u | python3`
	 * （别的解释器）和 `curl u | tail -n +2 | sh`（中间隔着东西），而它们是同一句话。
	 */
	for (const stages of pipelines(command, dialect)) {
		const heads = stages.map((stage) => firstWord(stage, dialect));
		const fetched = heads.findIndex(fetches);
		if (fetched === -1) continue;
		const ran = heads.findIndex((head, index) => index > fetched && interprets(head));
		if (ran !== -1) return risky("download-and-run");
	}
	// 同样的接法，只是没有管道：`sh -c "$(curl u)"`、`bash <(curl u)`、`source <(curl u)`。
	for (const { host, inner } of substitutionHosts(command, dialect)) {
		const head = firstWord(host, dialect);
		if ((interprets(head) || SOURCES.has(head)) && inner.some((piece) => fetches(firstWord(piece, dialect)))) return risky("download-and-run");
	}

	/*
	 * 命令是不是待在项目里。
	 *
	 * 让相对路径说不清的是 `cd`：`rm -f build/*` 是收拾，`cd /etc && rm -f *` 是同样几个字符出现在绝不能出现的地方。
	 * 这一串里每个 `cd` 都落在工作区里的话，相对路径就是工作区里的路径。
	 */
	const contained = cwd ? staysInside(command, cwd) : false;

	for (const piece of splitCommands(command, dialect)) {
		const verdict = judgeSingle(piece, contained, cwd, dialect);
		if (verdict.risky) return verdict;

		/*
		 * 以及这一条包着的东西。
		 *
		 * 设上限是因为嵌套可以没完：`bash -c "bash -c '…'"` 是合法的，模型不小心写出来时该得到一个答案而不是栈溢出。
		 * 四层已经超过任何有意写出来的；停下来靠的是深度，不是形状。
		 */
		if (depth >= 4) continue;
		const inner = wrappedCommand(piece, dialect);
		if (!inner) continue;
		const nested = assessCommand(inner, cwd, depth + 1, dialects);
		if (nested.risky) return nested;
	}
	return SAFE;
}

/**
 * 这条命令 `cd` 进的每个目录是不是都在工作区里。
 *
 * 生来就保守：目的地没法照字面读出来的 `cd`（变量、替换、`-`）算作离开，因为它会落到哪里在这里不可知。
 */
function staysInside(command: string, cwd: string): boolean {
	const root = cwd.replace(/\/+$/, "");
	for (const piece of splitCommands(command)) {
		const match = /^\s*cd\s+(\S+)/.exec(piece);
		if (!match) continue;
		// 引号写成 \x27\x22、反引号写成 \x60：直接写的话，文案检查会把正则里的它们当成字符串的开头。
		const target = match[1]!.replace(/^[\x27\x22]|[\x27\x22]$/g, "");
		if (target.startsWith("~") || target === "-" || /[$\x60]/.test(target)) return false;
		if (isAbsolute(target)) {
			if (withinOrIs(root, target)) continue;
			/*
			 * 草稿目录是正当干活的地方，不是逃出去的地方，而且这里根本身也算：`cd /tmp` 是在那里干活，
			 * `rm -rf /tmp` 完全是另一回事，那个另外判。
			 */
			if (underScratchRoot(target, cwd) || scratchRoots(cwd).includes(target.replace(/\/+$/, ""))) continue;
			return false;
		}
		// 相对的 `cd` 也能用 `..` 爬出去。
		if (climbsOut(target)) return false;
	}
	return true;
}
