/**
 * Windows 上代替命令运行的那层包装。
 *
 * macOS 约束一条命令，是在它前面放一个程序：`sandbox-exec -p … --`。Windows 没有这样的程序：
 * 在那里约束意味着自己造令牌、自己调 `CreateProcessAsUserW`，这么多 FFI 不该在还要转发输出的 agent 进程里做。
 *
 * 所以这个文件*就是*那个程序。后端像起另外两种包装一样起它，它做 Win32 的活，再让真正的命令继承调用方的 stdio 句柄跑起来：
 * 字节直通，上游照旧把它当一个普通子进程。它的退出码就是子进程的。
 *
 * argv 的约定（后端拼）：
 *
 *     <node> <入口> --plume-sandbox-runner --workspace <dir> --mode <read-only|workspace-write>
 *                   [--write-sid <S-1-4-…>] [--temp <dir> --temp-sid <S-1-4-…-1>] -- <command...>
 *
 * 这里和 `restrict.ts`、`win32.ts`、`identity.ts`、`runner-entry.ts` 的报错只经 stderr 交给后端，探测失败时作为原因写进发给模型的报错
 * （`backend.ts` 的 `confine`）。runner 是单独的进程，拿不到界面语言，所以这些字不走 i18n，各处标着 `i18n-exempt`。
 *
 * 失败的约定：这里出的任何错都打印 `windows-acl-run: <详情>` 并以 127 退出，命令**绝不**不受限地跑。后端靠这个前缀
 * 把「没能约束」和「命令自己失败」分开。
 */

import { mkdirSync } from "node:fs";
import * as abi from "./abi.ts";
import { buildCommandLine } from "./identity.ts";
import { createRestrictedToken, extendDefaultDacl, findLogonSid, grantWrite, openOwnToken, sidFromString, worldSid } from "./restrict.ts";
import { fail, isNull, readPtr, uint32Slot, win32, type Ptr, type Win32 } from "./win32.ts";

interface Args {
	workspace: string;
	mode: "read-only" | "workspace-write";
	writeSid?: string;
	/** 命令能写的私有临时目录，和点名它的能力。 */
	temp?: string;
	tempSid?: string;
	command: string[];
}

/** `S-1-4-x-y`，临时目录的身份是 `S-1-4-x-y-1`：`identity.ts` 只推出这两种形状。 */
const CAPABILITY_SID = /^S-1-4-\d+-\d+(-\d+)?$/;

/** 读 argv 约定，有一点对不上就拒绝。 */
export function parseArgs(argv: readonly string[]): Args {
	const separator = argv.indexOf("--");
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (separator === -1) throw new Error("缺少 `--`：它后面才是要运行的命令");
	const command = argv.slice(separator + 1);
	if (command.length === 0) throw new Error("`--` 后面没有命令");

	const options = new Map<string, string>();
	for (let index = 0; index < separator; index += 2) {
		const flag = argv[index]!;
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
		if (!flag.startsWith("--")) throw new Error(`认不出的参数：${flag}`);
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`${flag} 后面缺少值`);
		/*
		 * 值从不以 `--` 开头。
		 *
		 * 不查这个，`--workspace --mode read-only` 会把 `--mode` 读成工作区路径接着走。按现在的顺序它碰巧会在后面失败，但那是运气：
		 * 配对错了应该在出错的地方拒绝，而不是等下游另一条规则碰巧接住。
		 */
		if (value.startsWith("--")) throw new Error(`${flag} 后面缺少值（读到的是另一个参数 ${value}）`);
		options.set(flag.slice(2), value);
	}

	const workspace = options.get("workspace");
	const mode = options.get("mode");
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (!workspace) throw new Error("缺少 --workspace");
	if (mode !== "read-only" && mode !== "workspace-write") throw new Error(`--mode 只能是 read-only 或 workspace-write，收到 ${mode}`);

	const writeSid = options.get("write-sid");
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (mode === "workspace-write" && !writeSid) throw new Error("workspace-write 必须带 --write-sid");
	// 来路不可信的能力 SID 可能点名别人的身份。
	if (writeSid && !CAPABILITY_SID.test(writeSid)) throw new Error(`--write-sid 格式不对：${writeSid}`);

	const temp = options.get("temp");
	const tempSid = options.get("temp-sid");
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (Boolean(temp) !== Boolean(tempSid)) throw new Error("--temp 和 --temp-sid 必须一起给");
	// 两种模式都带一个：没有可写的临时目录，PowerShell 会以受限语言模式运行。见后端的 `runnerArgv`。
	if (tempSid && !CAPABILITY_SID.test(tempSid)) throw new Error(`--temp-sid 格式不对：${tempSid}`);

	return { workspace, mode, ...(writeSid ? { writeSid } : {}), ...(temp && tempSid ? { temp, tempSid } : {}), command };
}

/**
 * 造令牌、给目录授权、起命令，返回它的退出码。
 *
 * 顺序保证约束就位之前什么都不跑：授权和令牌都在走到 `CreateProcessAsUserW` 之前完成，那之前的任何失败都抛错。
 */
function runConfined(args: Args): number {
	const api: Win32 = win32();

	const source = openOwnToken(api);
	const logon = findLogonSid(api, source);
	const world = worldSid(api);

	const capabilities: Ptr[] = [];
	if (args.mode === "workspace-write" && args.writeSid) {
		const capability = sidFromString(api, args.writeSid);
		// 只能写这个目录的令牌要写得了任何东西，目录得先带着授权。
		grantWrite(api, args.workspace, capability);
		capabilities.push(capability);
	}
	/*
	 * 临时目录：每个平台的 `workspace-write` 都承诺了它。
	 *
	 * Seatbelt 授权 `/tmp` 和 `os.tmpdir()`；只授权工作区的话，受限命令连一个临时文件都建不了：Git Bash 里每个 heredoc 都失败
	 * （`cannot create temp file for here-document`），经 `%TEMP%` 中转的工具也一样。不授权用户自己的临时目录：它被用户跑的每样东西共用，
	 * 授权会在其他程序的文件上活过这个会话。这里按工作区建一个私有的，授权给它自己的身份，作为命令的 `TEMP`、`TMP`、`TMPDIR` 交出去
	 * （也是 Git Bash 挂 `/tmp` 的地方）。
	 */
	if (args.temp && args.tempSid) {
		mkdirSync(args.temp, { recursive: true });
		const capability = sidFromString(api, args.tempSid);
		grantWrite(api, args.temp, capability);
		capabilities.push(capability);
		for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = args.temp;
	}
	/*
	 * 本进程是怎么起来的，不该被命令继承。
	 *
	 * runner 是带 `ELECTRON_RUN_AS_NODE=1` 的 Electron，子进程拿到的环境块就是本进程的。留着的话，命令跑的每个 Electron 程序
	 * （VS Code 的 `code`）都会以裸 Node 启动。
	 */
	delete process.env.ELECTRON_RUN_AS_NODE;

	const token = createRestrictedToken(api, source, logon, world, capabilities);
	// 不加的话子进程打不开自己的进程对象、建不了 stdio 管道，见 `extendDefaultDacl`。
	extendDefaultDacl(api, token, [logon, ...capabilities]);

	return spawnUnder(api, token, args);
}

/** 用令牌、带着本进程的 stdio 句柄跑命令，等它结束。 */
function spawnUnder(api: Win32, token: Ptr, args: Args): number {
	const startupInfo = Buffer.alloc(abi.STARTUPINFOW_SIZE);
	startupInfo.writeUInt32LE(abi.STARTUPINFOW_SIZE, 0);
	startupInfo.writeUInt32LE(abi.STARTF_USESTDHANDLES, 60);
	// 继承本进程的句柄：父进程已经在读它们，经这里转一道只是多一个没人要的缓冲。
	startupInfo.writeBigUInt64LE(handleOf(api, abi.STD_INPUT_HANDLE), 80);
	startupInfo.writeBigUInt64LE(handleOf(api, abi.STD_OUTPUT_HANDLE), 88);
	startupInfo.writeBigUInt64LE(handleOf(api, abi.STD_ERROR_HANDLE), 96);

	// CreateProcessW 可能原地改命令行，所以给它一份可写的副本。
	const commandLine = buildCommandLine(args.command[0]!, args.command.slice(1));
	const buffer = Buffer.from(`${commandLine}\0`, "utf16le");
	const info = Buffer.alloc(abi.PROCESS_INFORMATION_SIZE);

	const created = api.createProcessAsUserW(
		token,
		null,
		buffer,
		null,
		null,
		1,
		abi.CREATE_NO_WINDOW | abi.CREATE_UNICODE_ENVIRONMENT,
		// null 环境块表示「沿用本进程的」。经 FFI 显式传一个会触发 ERROR_INVALID_PARAMETER。
		null,
		args.workspace,
		startupInfo,
		info,
	);
	if (created === 0) fail(api, "CreateProcessAsUserW", commandLine.slice(0, 120));

	const processHandle = readPtr(info, 0);
	const threadHandle = readPtr(info, 8);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (processHandle === null) fail(api, "CreateProcessAsUserW", "拿到的是空进程句柄");
	if (threadHandle !== null) api.closeHandle(threadHandle);

	api.waitForSingleObject(processHandle, abi.INFINITE);
	const code = uint32Slot();
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (api.getExitCodeProcess(processHandle, code) === 0) fail(api, "GetExitCodeProcess", "子进程退出码");
	api.closeHandle(processHandle);
	return code.readUInt32LE(0);
}

/**
 * 本进程的一个标准句柄，设成可继承，命令才真的拿得到。
 *
 * `STARTF_USESTDHANDLES` 只给出句柄的值，子进程是经继承拿到句柄本身的，不可继承的句柄到了那边只是个没意义的数字。Node 启动时把自己的
 * stdio 设成不可继承（`uv_disable_stdio_inheritance`），不设的话每条命令都没有 stdout、stderr：`cmd /c echo` 以 1 退出、什么都不打印，
 * Git Bash 来不及说为什么就死了。设在 runner 自己的句柄上：这个进程不起别的东西，不会有谁误拿到它们。
 */
function handleOf(api: Win32, which: number): bigint {
	const handle = api.getStdHandle(which);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见文件头。
	if (isNull(handle) || BigInt.asUintN(64, BigInt(handle)) === abi.INVALID_HANDLE_VALUE) fail(api, "GetStdHandle", `标准句柄 ${which}`);
	if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
		fail(api, "SetHandleInformation", `标准句柄 ${which} 设为可继承`);
	}
	return handle;
}

/** runner 这边每次失败都带的前缀，后端靠它和命令自己的失败分开。 */
export const RUNNER_FAILURE_PREFIX = "windows-acl-run:";

/** 没能约束时的退出码。受限命令自己的退出从不用它。 */
export const RUNNER_FAILURE_EXIT = 127;

/** 作为程序运行时的入口。导出而不是在导入时执行：测试也导入这个模块，它们不该起任何东西。 */
export function main(argv: readonly string[]): number {
	try {
		return runConfined(parseArgs(argv));
	} catch (error) {
		process.stderr.write(`${RUNNER_FAILURE_PREFIX} ${error instanceof Error ? error.message : String(error)}\n`);
		return RUNNER_FAILURE_EXIT;
	}
}
