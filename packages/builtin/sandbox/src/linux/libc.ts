/**
 * Linux 这边要用、Node 又没给的几个 libc 调用，经 koffi。
 */

import { koffi } from "../native.ts";

/** 系统调用的一个参数：数字，或者按指针传的 buffer（或 null）。 */
type SyscallArg = number | Buffer | null;

export interface Libc {
	/** `syscall(2)`，六个参数槽总是填满，见 `syscallThrough`。 */
	syscall: (number: number, ...args: SyscallArg[]) => number;
	open: (path: string, flags: number) => number;
	close: (fd: number) => number;
	prctl: (...args: unknown[]) => number;
	errno: () => number;
}

let cached: Libc | undefined;

/**
 * `syscall(2)`：声明六个参数槽，调用时也传六个。
 *
 * glibc 在 x86_64 上的 `syscall` 是几行汇编，不管调用方传没传第六个参数，都从栈上的 `8(%rsp)` 读它。C 编译器下这无害，
 * 那个槽在调用方自己的栈帧里；koffi 下不然：koffi 每次外部调用用它自己的一块栈，没有栈上参数时返回地址占着这块栈的最上面八字节，
 * 那个槽就是映射区外的第一个字节。那里有没有映射全看内核把栈放在哪，于是问内核要 Landlock 版本时，有的进程 SIGSEGV、有的不会，
 * 只在 x86_64 上（aarch64 的 `syscall` 不读栈），每条受限命令都跟着死。
 *
 * 号码之后六个参数一共七个，第七个落在 koffi 的栈上，汇编读的那个槽就是分配过、写过的。每种参数形状（哪几个槽是指针）第一次用到时声明一次。
 */
function syscallThrough(lib: ReturnType<ReturnType<typeof koffi>["load"]>): Libc["syscall"] {
	const shapes = new Map<string, (...args: SyscallArg[]) => number | bigint>();
	return (number, ...args) => {
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
		if (args.length > 6) throw new Error(`syscall 最多六个参数，收到 ${args.length} 个`);
		const filled: SyscallArg[] = [...args, ...Array<number>(6 - args.length).fill(0)];
		const params = filled.map((arg) => (arg === null || Buffer.isBuffer(arg) ? "void *" : "long"));
		const key = params.join(",");
		let call = shapes.get(key);
		if (!call) {
			call = lib.func("syscall", "long", ["long", ...params]) as (...args: SyscallArg[]) => number | bigint;
			shapes.set(key, call);
		}
		return Number(call(number, ...filled));
	};
}

/** 按 soname 找 libc：先 glibc，再 musl。都加载不了就抛错。 */
export function libc(): Libc {
	if (cached) return cached;
	const ffi = koffi();
	let lib: ReturnType<typeof ffi.load> | undefined;
	for (const name of ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`]) {
		try {
			lib = ffi.load(name);
			break;
		} catch {
			// 换另一种 libc。
		}
	}
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错。
	if (!lib) throw new Error("找不到 libc");
	cached = {
		syscall: syscallThrough(lib),
		open: lib.func("int open(const char *path, int flags, ...)") as Libc["open"],
		close: lib.func("int close(int fd)") as Libc["close"],
		prctl: lib.func("int prctl(int option, ...)") as Libc["prctl"],
		errno: () => ffi.errno(),
	};
	return cached;
}
