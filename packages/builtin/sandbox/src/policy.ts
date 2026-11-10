/**
 * 受限命令能碰什么：写一次，再按平台翻译。
 *
 * 这里全是纯函数：进来的是模式和工作区根目录，出去的是可写列表或 profile 字符串。
 * 沙箱里最容易悄悄出错的就是「哪些路径可写」，纯函数才测得了它；探测后端、包装 argv 这些不纯的事在 `backend.ts`。
 *
 * 模式只管文件效果，任何模式下命令都能联网；进程可见性不在这套词里。
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import type { SandboxMode } from "@plume/contract";

/**
 * 命令能改多少文件系统。
 *
 * `read-only` 除了 shell 离不开的 `/dev/null` 一概不许写：管道要用它，连它都拒，「不能写」就成了「不能跑」。
 * `workspace-write` 再加上项目目录和临时目录。`danger-full-access` 是没有沙箱，起个名字是为了让「不要沙箱」必须被明确选上。
 */

/**
 * 后端能兑现多少承诺，如实报告而不是默认全兑现。
 *
 * `partial` 表示只管住了模式承诺的一部分；需要绝对边界的调用方得能把它和 `full` 区分开，所以是值而不是布尔。
 */
export type SandboxEnforcement = "full" | "partial";

export interface SandboxPolicy {
	mode: SandboxMode;
	/** `workspace-write` 可写的绝对路径。由这里规范化，调用方不用管。 */
	workspaceRoot: string;
}

/**
 * 执行层实际比对的路径。
 *
 * macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接，Seatbelt 按解析后的路径匹配：按调用方的写法授权，
 * profile 里有这条，运行时却没有任何进程会落在那个路径上，等于没授权。
 *
 * 用 `realpathSync.native` 而不是 JS 版：JS 版会先按字面折叠 `..` 再解析前面的符号链接，`link/..` 可能被解析到内核根本不会去的地方；
 * native 版逐段走，和 `chdir`、`spawn` 一致。
 *
 * 解析不了的路径原样返回：它现在什么都不指向，也就什么都没授权，这是保守的结果；另造一个回退路径反而会授权没人要的地方。
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * 受限命令可写的根目录，规范化并去重。
 *
 * `/tmp` 和 `os.tmpdir()` 规范化后通常是同一个目录，但只是通常：macOS 上 `TMPDIR` 按用户挪走了后者，
 * `mkstemp` 一类工具写的是它而不是 `/tmp`。只给一个，就会在恰好用另一个的工具上拒掉模式承诺过的写入。
 *
 * 被另一个根包含的根去掉：重叠的授权不算错，但 profile 会把同一件事说两遍，没人会仔细读一份自我重复的 profile。
 */
export function writableRoots(policy: SandboxPolicy): string[] {
	if (policy.mode !== "workspace-write") return [];
	const canonical = [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))];
	return canonical.filter((root) => !canonical.some((other) => other !== root && contains(other, root)));
}

/** `parent` 是否包含 `child`，按整段路径比较，`/a/bc` 不在 `/a/b` 下。 */
function contains(parent: string, child: string): boolean {
	if (parent === child) return false;
	const base = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(base);
}

/**
 * 一个路径写成 SBPL 字符串字面量。
 *
 * 转义是安全边界，不是排版细节：profile 是内核要解析的字符串，目录名里一个 `"` 就会提前结束字面量，
 * 路径剩下的部分被当成 profile 读，成了没人写过的授权。先转反斜杠，否则转引号时加的反斜杠会被再转一次。
 */
function sbplString(path: string): string {
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 一个策略对应的 macOS Seatbelt profile，作为 `sandbox-exec` 的参数。
 *
 * 先 `(allow default)` 再拒一条，而不是全拒再逐项放行：默认拒绝的 profile 得列全 shell 碰到的每类系统调用
 * （dyld、mach 端口、终端……），漏一类就有一种命令莫名失败。这套模式承诺的是文件效果，拒掉 `file-write*` 正好就是这个承诺。
 *
 * `/dev/null` 在每种模式下都放行：shell 时时往它重定向，跑不了 `command 2>/dev/null` 的只读沙箱不是只读，是坏了。
 *
 * `file-write*` 只管本进程自己的写。有两个守护进程会替它在 profile 之外写，都关掉（`HANDS_OFF`）。
 */
export function seatbeltArgs(policy: SandboxPolicy): string[] {
	const forms = ["(version 1)", "(allow default)"];
	if (policy.mode !== "danger-full-access") {
		forms.push("(deny file-write*)", `(allow file-write* (literal ${sbplString("/dev/null")}))`);
		const roots = writableRoots(policy);
		if (roots.length > 0) {
			forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
		}
		forms.push(HANDS_OFF);
	}
	return ["-p", forms.join(" ")];
}

/**
 * 会替命令做被拒写入的服务，按名字拒掉。
 *
 * - **LaunchServices**：`open -g P.app`（P 里 `touch ~/x`）写进了主目录：应用由 launchd 在用户会话里启动，不是这里的子进程，profile 管不到它。
 *   只拒 `launchservicesd` 不够，`open` 会退到 quarantine resolver 照样启动（macOS 27 上实测）；两个一起拒，再加 `com.apple.lsd.*`，
 *   才挡住 `open` 应用、`.command`、URL handler、`-a`、`-b` 和 `osascript … to launch`。代价是 `open` 文档、网页在这里也会失败（是同一个请求），
 *   `looksDenied` 把这种失败认作沙箱拒绝，模型会被告知可以申请提权，而不是对着一个莫名的错误。
 * - **cfprefsd**：`defaults write` 把修改交给偏好设置守护进程，由它写 `~/Library/Preferences`。拒掉它以后 CFPreferences 直接读 plist，
 *   `defaults read`、`xcrun`、`xcodebuild`、git、node、pnpm、python 实测表现不变，只是写会失败。
 *
 * Linux 有同样形状的缺口，尚未堵上：bwrap 下命令可以请会话总线（`systemd-run --user`、D-Bus 激活的服务）在沙箱外跑东西。
 * 没堵是因为没有能验证修法的环境。
 */
const HANDS_OFF =
	"(deny mach-lookup" +
	' (global-name "com.apple.coreservices.launchservicesd")' +
	' (global-name "com.apple.coreservices.quarantine-resolver")' +
	' (global-name-prefix "com.apple.lsd.")' +
	' (global-name "com.apple.cfprefsd.daemon")' +
	' (global-name "com.apple.cfprefsd.agent"))';

/**
 * 一个策略对应的 Linux `bwrap` 参数。
 *
 * 整个文件系统只读绑定，再把可写根绑回去，这是挂载命名空间里对 Seatbelt profile 那句话的同义表述。
 * `--die-with-parent` 让被杀掉的一轮不留下还在跑的命令；`--dev`、`--proc` 是因为缺了它们，几乎每个程序都会少两样默认存在的东西。
 */
export function bwrapArgs(policy: SandboxPolicy): string[] {
	const args = [policy.mode === "danger-full-access" ? "--bind" : "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
	for (const root of writableRoots(policy)) args.push("--bind", root, root);
	return args;
}
