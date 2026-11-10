/**
 * 在 Linux 上用 Landlock 约束命令的写入：不要命名空间、不要特权、不要辅助程序。
 *
 * 只有 `bwrap` 时，人们实际用的机器上常常用不了它。在一台原装 Ubuntu 24.04（内核 6.8）上量过：没装 `bwrap`，
 * 而且 `apparmor_restrict_unprivileged_userns=1`，就算装了，它要的用户命名空间也被拒。沙箱按设计 fail-closed，
 * 于是在最常见的 Linux 桌面上，默认权限档的每条命令都报「没有沙箱后端」，什么都跑不了。
 *
 * Landlock 在 Ubuntu、Fedora、Debian 的默认 LSM 列表里，无特权进程可以把它加在自己身上。它回答的正是这个沙箱要问的
 * ——哪些目录可写——而且答案由每个子进程继承、撤不掉。所以这里是和 Windows 那个同样形状的 runner：后端在 shell 前面起它，
 * 它约束自己，用同样的 stdio 起命令，以命令的退出状态退出。
 *
 * 管什么：这个内核认识的每一种写类文件系统权限（`handled`），只在策略给的可写根下面放回来。读和执行不处理，也就不受限，
 * 和 Seatbelt 的 `(deny file-write*)` 承诺一样。设备文件在每种模式下都可写（首先是 `/dev/null`，shell 离不开它），
 * 在 `/dev` 里建、删节点不行。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writableRoots } from "../policy.ts";
import { libc } from "./libc.ts";

// 系统调用号：asm-generic 的，x86_64 和 aarch64 一样——5.13 加进来时两张表已经合并了。
const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;
const PR_SET_NO_NEW_PRIVS = 38;
// fcntl.h：通用值，x86_64 和 aarch64 都用它。
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;

/** `linux/landlock.h` 的 `LANDLOCK_ACCESS_FS_*`，注明是哪一版 ABI 引入的。 */
const FS = {
	WRITE_FILE: 1n << 1n,
	REMOVE_DIR: 1n << 4n,
	REMOVE_FILE: 1n << 5n,
	MAKE_CHAR: 1n << 6n,
	MAKE_DIR: 1n << 7n,
	MAKE_REG: 1n << 8n,
	MAKE_SOCK: 1n << 9n,
	MAKE_FIFO: 1n << 10n,
	MAKE_BLOCK: 1n << 11n,
	MAKE_SYM: 1n << 12n,
	/** ABI 2：把文件移动或链接到另一个目录。 */
	REFER: 1n << 13n,
	/** ABI 3：按路径 `truncate(2)`。 */
	TRUNCATE: 1n << 14n,
} as const;

/**
 * 这个内核能管的写类权限，也就是规则集处理的那些。
 *
 * 处理内核不认识的权限是 `EINVAL`；不处理它认识的，那项就不受限。所以集合严格跟着 ABI 走。ABI 2 以下，Landlock 下文件根本不能在目录之间移动
 * （工作区里面也不行），所以 runner 拒绝 ABI 1，而不是管得那么糟；ABI 3 以下不管按路径的 `truncate`，所以那种内核的执行程度报 partial。
 */
export function writeRights(abi: number): bigint {
	let rights =
		FS.WRITE_FILE | FS.REMOVE_DIR | FS.REMOVE_FILE | FS.MAKE_CHAR | FS.MAKE_DIR | FS.MAKE_REG | FS.MAKE_SOCK | FS.MAKE_FIFO | FS.MAKE_BLOCK | FS.MAKE_SYM;
	if (abi >= 2) rights |= FS.REFER;
	if (abi >= 3) rights |= FS.TRUNCATE;
	return rights;
}

/** 设备文件上放回来的权限：写进去可以，建、删不行。 */
export function deviceRights(abi: number): bigint {
	return FS.WRITE_FILE | (abi >= 3 ? FS.TRUNCATE : 0n);
}

/** runner 收到的参数：和别的后端同一套说法。 */
interface LandlockArgs {
	workspace: string;
	mode: "read-only" | "workspace-write";
	command: string[];
}

/** 一条规则：一个目录（或文件），和它下面放回来的权限。 */
interface LandlockRule {
	path: string;
	rights: bigint;
}

/**
 * 一个策略对应的规则，作为数据：在没有 Landlock 的机器上也值得测的那部分。
 *
 * 临时目录可写的地方 `/dev/shm` 也可写：POSIX 共享内存就是换了个名字的临时文件，Python 的 `multiprocessing`、agent 起的每个 Chromium
 * 都要它；给了 `/tmp` 不给 `/dev/shm` 的沙箱，会无缘无故弄坏它们。
 */
export function landlockRules(args: Pick<LandlockArgs, "workspace" | "mode">, abi: number): LandlockRule[] {
	const rules: LandlockRule[] = [{ path: "/dev", rights: deviceRights(abi) }];
	if (args.mode !== "workspace-write") return rules;
	for (const root of writableRoots({ mode: "workspace-write", workspaceRoot: args.workspace })) {
		rules.push({ path: root, rights: writeRights(abi) });
	}
	if (existsSync("/dev/shm")) rules.push({ path: "/dev/shm", rights: writeRights(abi) });
	return rules;
}

/**
 * 这个内核提供的 Landlock ABI；没有（没编进去、没启用、不是 Linux）是 0。
 *
 * 问版本不施加任何约束，所以在应用自己的进程里问也安全：后端靠它决定值不值得探测这个 runner、执行程度有多完整。
 */
export function landlockAbi(): number {
	if (process.platform !== "linux") return 0;
	try {
		const version = libc().syscall(SYS_LANDLOCK_CREATE_RULESET, null, 0, LANDLOCK_CREATE_RULESET_VERSION);
		return version > 0 ? version : 0;
	} catch {
		return 0;
	}
}

/** 读 argv 约定，对不上的一律拒绝。 */
// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
export function parseLandlockArgs(argv: readonly string[]): LandlockArgs {
	const separator = argv.indexOf("--");
	if (separator === -1) throw new Error("缺少 `--`：它后面才是要运行的命令");
	const command = argv.slice(separator + 1);
	if (command.length === 0) throw new Error("`--` 后面没有命令");
	const options = new Map<string, string>();
	for (let index = 0; index < separator; index += 2) {
		const flag = argv[index]!;
		const value = argv[index + 1];
		if (!flag.startsWith("--")) throw new Error(`认不出的参数：${flag}`);
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 后面缺少值`);
		options.set(flag.slice(2), value);
	}
	const workspace = options.get("workspace");
	const mode = options.get("mode");
	if (!workspace) throw new Error("缺少 --workspace");
	if (mode !== "read-only" && mode !== "workspace-write") throw new Error(`--mode 只能是 read-only 或 workspace-write，收到 ${mode}`);
	return { workspace, mode, command };
}

/** 把策略加在这个进程上。之后它起的一切都继承，撤不掉。 */
// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
function restrictSelf(args: LandlockArgs): void {
	const api = libc();
	const abi = landlockAbi();
	if (abi < 2) throw new Error(`这个内核的 Landlock ABI 是 ${abi}，不足以约束写入（需要 2 以上）`);

	const attr = Buffer.alloc(8);
	attr.writeBigUInt64LE(writeRights(abi), 0);
	const ruleset = api.syscall(SYS_LANDLOCK_CREATE_RULESET, attr, attr.length, 0);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
	if (ruleset < 0) throw new Error(`landlock_create_ruleset 失败（errno ${api.errno()}）`);

	try {
		for (const rule of landlockRules(args, abi)) {
			const fd = api.open(rule.path, O_PATH | O_CLOEXEC);
			// 不存在的根什么都还没授权，这是保守的结果。
			if (fd < 0) continue;
			try {
				// `struct landlock_path_beneath_attr` 是紧凑的：一个 u64 加一个 s32，12 字节。
				const beneath = Buffer.alloc(12);
				beneath.writeBigUInt64LE(rule.rights, 0);
				beneath.writeInt32LE(fd, 8);
				const added = api.syscall(SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_PATH_BENEATH, beneath, 0);
				// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
				if (added < 0) throw new Error(`landlock_add_rule 失败：${rule.path}（errno ${api.errno()}）`);
			} finally {
				api.close(fd);
			}
		}
		// 无特权调用方必须先设它，也是它让 setuid 程序撤不掉这一切。
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
		if (api.prctl(PR_SET_NO_NEW_PRIVS, "unsigned long", 1, "unsigned long", 0, "unsigned long", 0, "unsigned long", 0) !== 0) {
			throw new Error(`prctl(PR_SET_NO_NEW_PRIVS) 失败（errno ${api.errno()}）`);
		}
		if (api.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0) < 0) throw new Error(`landlock_restrict_self 失败（errno ${api.errno()}）`);
	} finally {
		api.close(ruleset);
	}
}

/** runner 自己的每条失败都带这个前缀，和命令自己的输出分得开。 */
const LANDLOCK_FAILURE_PREFIX = "landlock-run:";

/**
 * 入口：约束这个进程，在约束下跑命令，并以它的状态退出。
 *
 * 在约束了自己的那个线程上 `spawnSync`：Landlock 绑定的是调用线程的凭据，子进程从这个线程 fork 出去。子进程被信号杀死时，
 * 这里死于同一个信号，等这个进程的人看到的就是他本该看到的。
 */
export function main(argv: readonly string[]): number {
	let args: LandlockArgs;
	try {
		args = parseLandlockArgs(argv);
		restrictSelf(args);
	} catch (error) {
		process.stderr.write(`${LANDLOCK_FAILURE_PREFIX} ${error instanceof Error ? error.message : String(error)}\n`);
		return 127;
	}
	delete process.env.ELECTRON_RUN_AS_NODE;
	const result = spawnSync(args.command[0]!, args.command.slice(1), { stdio: "inherit" });
	if (result.error) {
		process.stderr.write(`${LANDLOCK_FAILURE_PREFIX} ${result.error.message}\n`);
		return 127;
	}
	if (result.signal) {
		process.kill(process.pid, result.signal);
		return 128;
	}
	return result.status ?? 1;
}
