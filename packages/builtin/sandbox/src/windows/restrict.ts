/**
 * 造受限令牌，并给它唯一能写的那个目录授权。
 *
 * 原理：`WRITE_RESTRICTED` 令牌带着第二张 SID 列表，它尝试的每次写都要*既*被对象的 DACL 允许、*又*被这张列表里的某项允许。
 * 把列表压到没人给授权的身份，再在一个目录上给一个编出来的身份写授权，那个目录就是进程唯一能写的地方。
 *
 * 编出来的身份是从工作区路径推出的能力 SID（`identity.ts`）。Windows 自己的记录里没有它，它的全部含义就是我们放在目录上的那条 ACE：
 * 正好是要的性质，只授予一件事，也借不走。
 *
 * 这里的一切都 fail-closed：没能受限的令牌不能拿来起进程，所以每次失败都抛错，调用方拿不到句柄。
 */

import { koffi } from "../native.ts";
import * as abi from "./abi.ts";
import { fail, isNull, ptrSlot, readPtr, uint32Slot, type Ptr, type Win32 } from "./win32.ts";

/** 以 `CreateRestrictedToken` 要的权限打开本进程的令牌。 */
export function openOwnToken(api: Win32): Ptr {
	// 用真句柄而不是 `GetCurrentProcess()` 的伪句柄：那是个常量，FFI 层没法寻址。
	const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid);
	if (processHandle === null || isNull(processHandle)) fail(api, "OpenProcess", `pid ${process.pid}`);

	const slot = ptrSlot();
	const opened = api.openProcessToken(processHandle, abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY, slot);
	if (opened === 0) {
		const code = api.getLastError();
		api.closeHandle(processHandle);
		fail(api, "OpenProcessToken", `pid ${process.pid}`, code);
	}
	api.closeHandle(processHandle);
	const token = readPtr(slot);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (token === null) fail(api, "OpenProcessToken", "拿到的是空令牌句柄");
	return token;
}

/**
 * 从令牌的组里找出登录会话 SID。
 *
 * 要它是因为按登录会话分的对象（窗口站、桌面）是授权给它的，够不着它们的令牌造出的进程会死在加载器初始化里。
 */
export function findLogonSid(api: Win32, token: Ptr): Buffer {
	const needed = uint32Slot();
	// 预期以 ERROR_INSUFFICIENT_BUFFER 失败；要的是它写回来的大小。
	api.getTokenInformation(token, abi.TokenGroups, null, 0, needed);
	const size = needed.readUInt32LE(0);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (size === 0) fail(api, "GetTokenInformation", "TokenGroups 大小查询");
	if (size < abi.TOKEN_GROUPS_OFFSET) fail(api, "GetTokenInformation", `TokenGroups 大小不合理：${size}`);

	const groups = Buffer.alloc(size);
	if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, needed) === 0) {
		fail(api, "GetTokenInformation", "TokenGroups");
	}

	const count = groups.readUInt32LE(0);
	for (let index = 0; index < count; index++) {
		const base = abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE;
		const sid = readPtr(groups, base);
		const attributes = groups.readUInt32LE(base + 8);
		// `>>> 0`：SE_GROUP_LOGON_ID 的第 31 位是 1，JS 的位运算是有符号的。
		if (sid === null || (attributes & abi.SE_GROUP_LOGON_ID) >>> 0 !== abi.SE_GROUP_LOGON_ID >>> 0) continue;

		const length = api.getLengthSid(sid);
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
		if (length === 0) fail(api, "GetLengthSid", `登录 SID（第 ${index} 组）`);
		const copy = Buffer.alloc(length);
		if (api.copySid(length, copy, sid) === 0) fail(api, "CopySid", `登录 SID（第 ${index} 组）`);
		return copy;
	}
	throw new Error(`令牌的 ${count} 个组里没有登录 SID，受限令牌建不出来`);
}

/** Everyone（`S-1-1-0`），受限列表离不开它。 */
export function worldSid(api: Win32): Buffer {
	const sid = Buffer.alloc(abi.SECURITY_MAX_SID_SIZE);
	const size = uint32Slot(abi.SECURITY_MAX_SID_SIZE);
	if (api.createWellKnownSid(abi.WinWorldSid, null, sid, size) === 0) fail(api, "CreateWellKnownSid", "Everyone");
	return sid;
}

/** 把 `S-1-4-x-y` 转成 SID。指针是 `LocalAlloc` 出来的，要释放。 */
export function sidFromString(api: Win32, sddl: string): Ptr {
	const slot = ptrSlot();
	if (api.convertStringSidToSidW(sddl, slot) === 0) fail(api, "ConvertStringSidToSidW", sddl);
	const sid = readPtr(slot);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (sid === null) fail(api, "ConvertStringSidToSidW", `${sddl} 转出来是空的`);
	return sid;
}

/** 一个 `EXPLICIT_ACCESS_W`，手工拼：布局固定且小。 */
export function explicitAccess(sid: Ptr | Buffer, mode: number, permissions: number, inheritance: number): Buffer {
	const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE);
	entry.writeUInt32LE(permissions, 0);
	entry.writeUInt32LE(mode, 4);
	entry.writeUInt32LE(inheritance, 8);
	// TRUSTEE_W：pMultipleTrustee（null）、MultipleTrusteeOperation、TrusteeForm、TrusteeType、ptstrName。
	const trustee = abi.TRUSTEE_W_OFFSET;
	entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, trustee + 8);
	entry.writeUInt32LE(abi.TRUSTEE_IS_SID, trustee + 12);
	entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, trustee + 16);
	/*
	 * 从受托者算偏移，不是从整个条目算。
	 *
	 * 只按受托者内的偏移 24 写，落在条目的 `MultipleTrusteeOperation` 和 `TrusteeForm` 上：SID 地址盖了这两项，`ptstrName`
	 * 还是 null，`SetEntriesInAclW` 只回 ERROR_INVALID_PARAMETER，第一条要建条目的调用就失败，没有一条受限命令起得来。
	 */
	const address = Buffer.isBuffer(sid) ? bufferAddress(sid) : sid;
	entry.writeBigUInt64LE(address, trustee + abi.TRUSTEE_W_PTSTRNAME_OFFSET);
	return entry;
}

/**
 * 地址被写进另一个缓冲区交给 Windows 的缓冲区，留到进程退出。
 *
 * 作为*参数*传的 Buffer，koffi 在调用期间保它活着。地址被写进结构体的那个它看不见，V8 也看不见：最后一个 JS 引用一没就可能被回收，
 * 不管原生那边还要读多少。拷进 Buffer、只靠 `SID_AND_ATTRIBUTES` 数组里的地址引用的 SID 正是这种。runner 只活一条命令，
 * 把这些 Buffer 都留到它退出不花什么。
 */
const pinned: Buffer[] = [];

/**
 * Buffer 字节的地址，并让这个 Buffer 在地址可能被读的这段时间里活着。
 *
 * koffi 按指针传 Buffer，但*内嵌*指针的结构体要把地址写进去。`koffi.address` 是拿地址的正规方式。
 */
function bufferAddress(buffer: Buffer): bigint {
	pinned.push(buffer);
	return koffi().address(buffer);
}

/**
 * DACL 上是不是已经有这个能力的、写在这里的可继承写授权。
 *
 * 每次授权前先问，因为没变化时写 DACL 也不便宜：`SetNamedSecurityInfoW` 每次调用都会走遍整棵树重新传播继承。runner 每条命令都授权，
 * 不先问的话，一个有 `node_modules` 的项目里每个 `ls` 都要先改写十万个文件的安全设置。现在只有一个工作区里的第一条命令付这个代价。
 *
 * 只算显式的允许条目，带完整的写掩码和两个继承位：子目录上继承来的副本、别人写的更窄的授权，都不是这个目录要的那条。
 */
function hasGrant(api: Win32, dacl: Ptr | null, capabilitySid: Ptr): boolean {
	if (dacl === null) return false;
	const info = Buffer.alloc(abi.ACL_SIZE_INFORMATION_SIZE);
	if (api.getAclInformation(dacl, info, info.length, abi.AclSizeInformation) === 0) return false;
	const count = info.readUInt32LE(0);
	const slot = ptrSlot();
	const head = Buffer.alloc(abi.ACE_SID_OFFSET);
	for (let index = 0; index < count; index++) {
		if (api.getAce(dacl, index, slot) === 0) continue;
		const ace = readPtr(slot);
		if (ace === null) continue;
		api.rtlMoveMemory(head, ace, head.length);
		const type = head.readUInt8(0);
		const flags = head.readUInt8(1);
		const mask = head.readUInt32LE(4);
		if (type !== abi.ACCESS_ALLOWED_ACE_TYPE || (flags & abi.INHERITED_ACE) !== 0) continue;
		if ((flags & abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT) !== abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT) continue;
		if ((mask & abi.GRANT_MASK) >>> 0 !== abi.GRANT_MASK >>> 0) continue;
		if (api.equalSid(ace + BigInt(abi.ACE_SID_OFFSET), capabilitySid) !== 0) return true;
	}
	return false;
}

/**
 * 在一个目录上给一个能力 SID 写授权，可继承。
 *
 * 在要紧的意义上是幂等的：`SetEntriesInAclW` 是合并，对已经带着这条 ACE 的目录再跑一遍，得到等价的 DACL。授权在进程退出后留着：
 * 它点名的身份只有这个工作区的令牌才带，留着不等于把权限丢在外面；每次启动都把一棵大树重新传播一遍，是看得见的代价、换不来什么。
 */
export function grantWrite(api: Win32, directory: string, capabilitySid: Ptr): void {
	const daclSlot = ptrSlot();
	const descriptorSlot = ptrSlot();
	const read = api.getNamedSecurityInfoW(directory, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION, null, null, daclSlot, null, descriptorSlot);
	if (read !== abi.ERROR_SUCCESS) fail(api, "GetNamedSecurityInfoW", directory, read);

	const oldDacl = readPtr(daclSlot);
	const descriptor = readPtr(descriptorSlot);
	if (hasGrant(api, oldDacl, capabilitySid)) {
		if (descriptor !== null) api.localFree(descriptor);
		return;
	}
	const merged = ptrSlot();
	const result = api.setEntriesInAclW(
		1,
		explicitAccess(capabilitySid, abi.GRANT_ACCESS, abi.GRANT_MASK, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT),
		oldDacl,
		merged,
	);
	if (result !== abi.ERROR_SUCCESS) {
		if (descriptor !== null) api.localFree(descriptor);
		fail(api, "SetEntriesInAclW", directory, result);
	}
	const newDacl = readPtr(merged);
	if (newDacl === null) {
		if (descriptor !== null) api.localFree(descriptor);
		// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
		fail(api, "SetEntriesInAclW", `${directory} 合并出空 DACL`, result);
	}

	const applied = api.setNamedSecurityInfoW(directory, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION, null, null, newDacl, null);
	api.localFree(newDacl);
	if (descriptor !== null) api.localFree(descriptor);
	if (applied !== abi.ERROR_SUCCESS) fail(api, "SetNamedSecurityInfoW", directory, applied);
}

/**
 * 给令牌的*默认* DACL 加上给定 SID 的完全访问条目。
 *
 * 不起眼但必需。默认 DACL 是进程新建的、没自带 DACL 的对象拿到的那份：它自己的进程和线程对象，Node 给子进程 stdio 建的匿名管道。
 * 写受限令牌只有*两次*检查都过才通过：一次对照令牌的组，一次对照它的受限 SID。所以这里的条目得点名一个两次检查都认的 SID。
 *
 * 只有登录 SID 两张表里都有，所以它总在。只放能力 SID（以前 `workspace-write` 下就这么做）过得了第二次检查、过不了第一次：
 * 它不是令牌的组。在继承来的默认 DACL 本来就授权给用户的地方看不出来，在不授权的地方就失败：以管理员身份运行时默认 DACL 点名的是
 * Administrators 和 SYSTEM（令牌过滤后 Administrators 只剩拒绝），命令打不开自己的进程对象，在第一条指令之前就死在加载器初始化里
 * （`0xC0000142`）：以管理员身份运行时每条受限命令都是这样。Git Bash 会把自己的默认 DACL 改写成授权给用户，它底下起的都继承这一份，
 * 所以只有在 PowerShell 下才看得出来。
 *
 * 从不放 Everyone：那会把命令建的每个对象都开给这台机器上的每个账号；登录 SID 够不到这次登录以外。不可继承：默认 DACL 不是容器的，
 * 条目没有东西可以继承给。
 */
export function extendDefaultDacl(api: Win32, token: Ptr, sids: readonly (Ptr | Buffer)[]): void {
	const needed = uint32Slot();
	api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, needed);
	const size = needed.readUInt32LE(0);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (size === 0) fail(api, "GetTokenInformation", "TokenDefaultDacl 大小查询");

	const buffer = Buffer.alloc(size);
	if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, needed) === 0) {
		fail(api, "GetTokenInformation", "TokenDefaultDacl");
	}
	// 指针指向的 ACL 就在这同一个缓冲区里，在指针之后。
	pinned.push(buffer);
	const current = readPtr(buffer, 0);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (current === null) throw new Error("令牌没有默认 DACL 可以扩展");

	const merged = ptrSlot();
	const entries = Buffer.concat(sids.map((sid) => explicitAccess(sid, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS, abi.NO_INHERITANCE)));
	const result = api.setEntriesInAclW(sids.length, entries, current, merged);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (result !== abi.ERROR_SUCCESS) fail(api, "SetEntriesInAclW", "默认 DACL 合并", result);
	const newDacl = readPtr(merged);
	if (newDacl === null) fail(api, "SetEntriesInAclW", "默认 DACL 合并结果为空", result);

	// TOKEN_DEFAULT_DACL 就是一个指针；SetTokenInformation 会拷走 ACL。
	const info = Buffer.alloc(8);
	info.writeBigUInt64LE(newDacl, 0);
	if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
		const code = api.getLastError();
		api.localFree(newDacl);
		fail(api, "SetTokenInformation", "TokenDefaultDacl", code);
	}
	api.localFree(newDacl);
}

/** 打包 `SID_AND_ATTRIBUTES[]`，属性按 `CreateRestrictedToken` 的要求留零。 */
function packSids(sids: readonly (Ptr | Buffer)[]): Buffer {
	const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length);
	sids.forEach((sid, index) => {
		const address = Buffer.isBuffer(sid) ? bufferAddress(sid) : sid;
		buffer.writeBigUInt64LE(address, abi.SID_AND_ATTRIBUTES_SIZE * index);
	});
	return buffer;
}

/**
 * 造受限令牌。
 *
 * 受限列表（登录 SID、Everyone，加上给它的写能力）就是沙箱：`WRITE_RESTRICTED` 令牌每次写都查两遍：一遍照常对照对象的 DACL，一遍对照*这张*列表，两遍都过才放行。
 * 所以这张表完整回答了「这个进程能改什么」。
 *
 * 总在里面的两项，是这里报 `partial` 而不是 `full` 的原因：
 *
 * - **登录 SID** 和 **Everyone** 必须在，否则进程起不来。Windows 加载器初始化和 CNG 都要写按登录会话分的对象，缺了它们的令牌
 *   在我们的任何代码跑之前就死在 `0xC0000142`。有 Everyone 意味着 DACL 给 Everyone 写权限的对象都还能写：这是写在文档里的缺口，
 *   只要还想有个进程就堵不上。
 * - `Authenticated Users`、`INTERACTIVE`、`LOCAL` 有意**不在**。默认安装的 Windows 上它们各在某处有写权限（`C:\` 根、Public 目录），
 *   放进任何一个，沙箱拿走的大半又还回去了。
 *
 * `read-only` 下一个写能力都不加：之前 `workspace-write` 会话留在工作区上的 ACE 因此就是死的，不用去找、去撤。
 *
 * `DISABLE_MAX_PRIVILEGE` 去掉能让子进程绕过这一切提权的特权，`LUA_TOKEN` 把管理员令牌过滤成受限的那一种。
 */
export function createRestrictedToken(api: Win32, source: Ptr, logonSid: Buffer, world: Buffer, capabilitySids: readonly Ptr[]): Ptr {
	const restricting = packSids([logonSid, world, ...capabilitySids]);
	const slot = ptrSlot();
	const created = api.createRestrictedToken(
		source,
		abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
		0,
		null,
		0,
		null,
		restricting.length / abi.SID_AND_ATTRIBUTES_SIZE,
		restricting,
		slot,
	);
	// i18n-exempt：runner 的诊断，经 stderr 写进发给模型的报错，见 `windows/runner.ts` 文件头。
	if (created === 0) fail(api, "CreateRestrictedToken", `${capabilitySids.length + 2} 个限制 SID`);
	const token = readPtr(slot);
	if (token === null) fail(api, "CreateRestrictedToken", "拿到的是空令牌句柄");
	return token;
}
