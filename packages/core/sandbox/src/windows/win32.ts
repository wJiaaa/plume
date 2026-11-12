/**
 * 受限令牌沙箱要调的 Win32 接口，以及围着它们的缓冲区活。
 *
 * 只在 Windows 上、用到时才加载。`koffi` 是真正的原生模块，在 macOS 进程里去开 `advapi32.dll` 不值得冒险，何况那里整个模块都走不到。
 *
 * 每个绑定都写 `__stdcall`：x86 上 Win32 ABI 用它，x64 上 koffi 无害地忽略它，写明了两边的声明都老实。koffi 把指针还成 BigInt 地址；
 * 只有下面这几个辅助函数可以在意这件事。
 *
 * 这里不解释任何失败。每个调用都查，每次失败都带着接口名和 Win32 错误码抛出：这个文件绝不能有的行为，就是在一个没做成的调用之后接着往下走，
 * 那样进程会拿着完整令牌跑，上游却都以为它受限了。
 */

import { koffi as loadKoffi } from "../native.ts";
import * as abi from "./abi.ts";

/** koffi 交回来的原生指针。 */
export type Ptr = bigint;

export interface Win32 {
	openProcess(access: number, inherit: number, pid: number): Ptr | null;
	openProcessToken(process: Ptr, access: number, tokenOut: Buffer): number;
	closeHandle(handle: Ptr): number;
	getLastError(): number;
	formatMessageW(flags: number, source: Ptr | null, id: number, lang: number, buffer: Buffer, size: number, args: Ptr | null): number;
	localFree(memory: Ptr): Ptr | null;
	convertStringSidToSidW(sid: string, sidOut: Buffer): number;
	createWellKnownSid(type: number, domain: Ptr | null, sid: Buffer, size: Buffer): number;
	getLengthSid(sid: Ptr): number;
	copySid(length: number, destination: Buffer, source: Ptr): number;
	getTokenInformation(token: Ptr, cls: number, info: Buffer | null, length: number, needed: Buffer): number;
	setTokenInformation(token: Ptr, cls: number, info: Buffer, length: number): number;
	createRestrictedToken(
		token: Ptr,
		flags: number,
		disableCount: number,
		disable: Buffer | null,
		deleteCount: number,
		remove: Buffer | null,
		restrictCount: number,
		restrict: Buffer | null,
		tokenOut: Buffer,
	): number;
	setEntriesInAclW(count: number, entries: Buffer, oldAcl: Ptr | null, newAcl: Buffer): number;
	setNamedSecurityInfoW(name: string, type: number, info: number, owner: Ptr | null, group: Ptr | null, dacl: Ptr | null, sacl: Ptr | null): number;
	getNamedSecurityInfoW(
		name: string,
		type: number,
		info: number,
		owner: Buffer | null,
		group: Buffer | null,
		dacl: Buffer,
		sacl: Buffer | null,
		descriptor: Buffer,
	): number;
	createProcessAsUserW(
		token: Ptr,
		applicationName: string | null,
		commandLine: Buffer,
		processAttributes: Ptr | null,
		threadAttributes: Ptr | null,
		inheritHandles: number,
		creationFlags: number,
		environment: Ptr | null,
		currentDirectory: string | null,
		startupInfo: Buffer,
		processInformation: Buffer,
	): number;
	waitForSingleObject(handle: Ptr, ms: number): number;
	getExitCodeProcess(handle: Ptr, codeOut: Buffer): number;
	getStdHandle(which: number): Ptr;
	setHandleInformation(handle: Ptr, mask: number, flags: number): number;
	getAclInformation(acl: Ptr, info: Buffer, length: number, cls: number): number;
	getAce(acl: Ptr, index: number, aceOut: Buffer): number;
	equalSid(a: Ptr, b: Ptr): number;
	/** 从只拿着指针的内存里拷字节出来：DACL 里的一条 ACE。 */
	rtlMoveMemory(destination: Buffer, source: Ptr, length: number): void;
}

let cached: Win32 | null = null;

/**
 * 绑定 Win32 入口，只绑一次。
 *
 * 不在 Windows 上就抛错，而不是还一个什么都不做的东西：在 macOS 上走到这里的调用方有 bug，返回 null 会让它接着走下去。
 */
export function win32(): Win32 {
	if (cached) return cached;
	if (process.platform !== "win32") {
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
		throw new Error("Windows 沙箱只能在 Windows 上加载");
	}

	const koffi = loadKoffi();
	const PVOID = koffi.pointer("void");
	const PPVOID = koffi.pointer(PVOID);

	const kernel32 = koffi.load("kernel32.dll");
	const advapi32 = koffi.load("advapi32.dll");
	type Lib = ReturnType<typeof koffi.load>;
	type Spec = Parameters<Lib["func"]>[2];
	const bind = (lib: Lib, name: string, result: Spec, args: Spec[]) => lib.func("__stdcall", name, result, args);

	cached = {
		openProcess: bind(kernel32, "OpenProcess", PVOID, ["uint32", "int", "uint32"]),
		openProcessToken: bind(advapi32, "OpenProcessToken", "int", [PVOID, "uint32", PPVOID]),
		closeHandle: bind(kernel32, "CloseHandle", "int", [PVOID]),
		getLastError: bind(kernel32, "GetLastError", "uint32", []),
		formatMessageW: bind(kernel32, "FormatMessageW", "uint32", ["uint32", PVOID, "uint32", "uint32", PVOID, "uint32", PVOID]),
		localFree: bind(kernel32, "LocalFree", PVOID, [PVOID]),
		convertStringSidToSidW: bind(advapi32, "ConvertStringSidToSidW", "int", ["str16", PPVOID]),
		createWellKnownSid: bind(advapi32, "CreateWellKnownSid", "int", ["int", PVOID, PVOID, koffi.pointer("uint32")]),
		getLengthSid: bind(advapi32, "GetLengthSid", "uint32", [PVOID]),
		copySid: bind(advapi32, "CopySid", "int", ["uint32", PVOID, PVOID]),
		getTokenInformation: bind(advapi32, "GetTokenInformation", "int", [PVOID, "int", PVOID, "uint32", koffi.pointer("uint32")]),
		setTokenInformation: bind(advapi32, "SetTokenInformation", "int", [PVOID, "int", PVOID, "uint32"]),
		createRestrictedToken: bind(advapi32, "CreateRestrictedToken", "int", [PVOID, "uint32", "uint32", PVOID, "uint32", PVOID, "uint32", PVOID, PPVOID]),
		setEntriesInAclW: bind(advapi32, "SetEntriesInAclW", "uint32", ["uint32", PVOID, PVOID, PPVOID]),
		setNamedSecurityInfoW: bind(advapi32, "SetNamedSecurityInfoW", "uint32", ["str16", "int", "uint32", PVOID, PVOID, PVOID, PVOID]),
		getNamedSecurityInfoW: bind(advapi32, "GetNamedSecurityInfoW", "uint32", ["str16", "int", "uint32", PPVOID, PPVOID, PPVOID, PPVOID, PPVOID]),
		createProcessAsUserW: bind(advapi32, "CreateProcessAsUserW", "int", [PVOID, "str16", PVOID, PVOID, PVOID, "int", "uint32", PVOID, "str16", PVOID, PVOID]),
		waitForSingleObject: bind(kernel32, "WaitForSingleObject", "uint32", [PVOID, "uint32"]),
		getExitCodeProcess: bind(kernel32, "GetExitCodeProcess", "int", [PVOID, koffi.pointer("uint32")]),
		getStdHandle: bind(kernel32, "GetStdHandle", PVOID, ["int"]),
		setHandleInformation: bind(kernel32, "SetHandleInformation", "int", [PVOID, "uint32", "uint32"]),
		getAclInformation: bind(advapi32, "GetAclInformation", "int", [PVOID, PVOID, "uint32", "int"]),
		getAce: bind(advapi32, "GetAce", "int", [PVOID, "uint32", PPVOID]),
		equalSid: bind(advapi32, "EqualSid", "int", [PVOID, PVOID]),
		rtlMoveMemory: bind(kernel32, "RtlMoveMemory", "void", [PVOID, PVOID, "size_t"]),
	} as unknown as Win32;
	return cached;
}

// ---------------------------------------------------------------------------
// 缓冲区、指针、失败
// ---------------------------------------------------------------------------

/** 收一个指针的槽。 */
export function ptrSlot(): Buffer {
	return Buffer.alloc(8);
}

/** 读出调用写进槽里的指针；什么都没写时是 null。 */
export function readPtr(slot: Buffer, offset = 0): Ptr | null {
	const value = slot.readBigUInt64LE(offset);
	return value === 0n ? null : value;
}

/** 收一个 DWORD 的槽。 */
export function uint32Slot(value = 0): Buffer {
	const slot = Buffer.alloc(4);
	slot.writeUInt32LE(value, 0);
	return slot;
}

/** 指针是不是表示「没有」的那几种样子。 */
export function isNull(value: Ptr | null | undefined): boolean {
	return value === null || value === undefined || value === 0n;
}

/**
 * 系统自己对一个 Win32 错误码的说法。
 *
 * 值得多调一次：`CreateRestrictedToken failed (1314)` 让人去搜，「客户端没有所需的特权」直接说了该怎么办。
 */
function describeError(api: Win32, code: number): string {
	const buffer = Buffer.alloc(1024);
	const length = api.formatMessageW(abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS, null, code, 0, buffer, 512, null);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (length === 0) return `Win32 错误 ${code}`;
	return `${buffer.toString("utf16le", 0, length * 2).trim()} (${code})`;
}

/** 带着失败的接口、它在做什么、Windows 怎么说，抛出。 */
export function fail(api: Win32, apiName: string, context: string, code = api.getLastError()): never {
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	throw new Error(`${apiName} 失败：${describeError(api, code)} — ${context}`);
}
