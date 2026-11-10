/**
 * 受限令牌沙箱依赖的 Win32 数值和结构体大小。
 *
 * 这里每个值都是 Windows 头文件里的常量，每一个错了都看不出来：抄错的标志位不会编译失败，只会造出一个约束得比它
 * 声称的少的令牌。按来自哪个头文件分组，名字照头文件写，读的人可以拿 SDK 核对，而不是信这个文件自己的说法。
 *
 * 末尾的结构体大小是 x64 的布局。接这些结构体的调用按固定偏移读固定字节数：大小错了，就是在边界另一侧越界读写。
 */

// --- 令牌访问权限（winnt.h） ---
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
export const TOKEN_DUPLICATE = 0x0002;
export const TOKEN_QUERY = 0x0008;
export const TOKEN_ADJUST_DEFAULT = 0x0080;

/** 标出令牌组里的登录会话 SID。第 31 位是 1：JS 的位运算是有符号的，用时要当心。 */
export const SE_GROUP_LOGON_ID = 0xc0000000;

// --- 文件访问权限（winnt.h） ---
const STANDARD_RIGHTS_WRITE = 0x00020000;
const FILE_GENERIC_WRITE = 0x00120116;
const DELETE = 0x00010000;
const FILE_DELETE_CHILD = 0x0040;

/**
 * 写授权实际给出去的权限。
 *
 * 有意去掉 `READ_CONTROL`：它捆在 `FILE_GENERIC_WRITE` 里，持有者能读对象的安全描述符。这份能力说的是写，
 * 顺带给出读 ACL 的能力，授权就比它说的宽了。
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;

/** 完全访问，只用在令牌自己的默认 DACL 上。 */
export const FILE_ALL_ACCESS = 0x1f01ff;

// --- CreateRestrictedToken 的标志（securitybaseapi.h） ---
/** 去掉最高权限的提升，受限的子进程没法提权。 */
export const DISABLE_MAX_PRIVILEGE = 0x1;
/** 造出受限用户（过滤后的管理员）令牌。 */
export const LUA_TOKEN = 0x4;
/** 机制本身：写入还要再对照一遍受限 SID 列表。 */
export const WRITE_RESTRICTED = 0x8;

// --- 知名 SID 和令牌信息类 ---
/** `S-1-1-0`，Everyone。 */
export const WinWorldSid = 1;
export const TokenGroups = 2;
export const TokenDefaultDacl = 6;

// --- ACL 和受托者（accctrl.h、aclapi.h） ---
export const DACL_SECURITY_INFORMATION = 0x00000004;
/*
 * 这张表里有几个常量没有调用点，留着是有意的。
 *
 * 它照着 Windows 的头文件抄，一半给 `koffi` 用，一半让下一个读这个文件的人不必去翻 `aclapi.h`。`GRANT_ACCESS = 1`
 * 旁边缺了 `REVOKE_ACCESS = 4`，读的人不会以为「不需要」，会以为「是不是抄漏了」，然后去翻头文件确认。完整的枚举比精简的省事。
 *
 * 没有 `export`（`knip` 会说没人用，它说得对），所以下面那行压一条 oxlint 的未用告警。
 */
export const SE_FILE_OBJECT = 1;
export const TRUSTEE_IS_UNKNOWN = 0;
export const TRUSTEE_IS_SID = 0;
export const NO_MULTIPLE_TRUSTEE = 0;
export const GRANT_ACCESS = 1;
// oxlint-disable-next-line no-unused-vars -- 见上面那段：这张表要完整
const REVOKE_ACCESS = 4;
/** `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`：授权覆盖整棵树。 */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
/** 只作用于所在对象、不往下传的条目。 */
export const NO_INHERITANCE = 0x0;
/** 普通允许条目的 `ACE_HEADER.AceType`。 */
export const ACCESS_ALLOWED_ACE_TYPE = 0;
/** `ACE_HEADER.AceFlags` 里的这一位：条目是从父级继承下来的，不是写在这里的。 */
export const INHERITED_ACE = 0x10;
/** 让 `GetAclInformation` 报 ACE 个数的 `ACL_INFORMATION_CLASS`。 */
export const AclSizeInformation = 2;
/** `ACL_SIZE_INFORMATION`：AceCount、AclBytesInUse、AclBytesFree，三个 DWORD。 */
export const ACL_SIZE_INFORMATION_SIZE = 12;
/** `ACCESS_ALLOWED_ACE` 里 SID 的起点：4 字节的头和 4 字节的掩码之后。 */
export const ACE_SID_OFFSET = 8;

// --- 进程和句柄（processthreadsapi.h、winbase.h） ---
export const PROCESS_QUERY_INFORMATION = 0x0400;
export const STARTF_USESTDHANDLES = 0x00000100;
/**
 * 没有控制台的进程起控制台程序时，子进程会拿到一个自己的控制台*窗口*。
 *
 * runner 是 Node 模式下的 Electron，图形子系统的可执行文件，没有控制台；它起的每个 shell 都是控制台程序。
 * 不带这个标志，每条命令都在桌面上闪一个黑窗口，还把焦点抢走。
 */
export const CREATE_NO_WINDOW = 0x08000000;
/**
 * 环境块是 UTF-16。即使环境块是 null、沿用本进程的，`CreateProcessAsUserW` 也要这个标志：本进程的环境块是 UTF-16，
 * 文档说不带它，子进程的环境会按 ANSI 读。
 */
export const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
/** `SetHandleInformation` 的标志：带 `bInheritHandles` 建的子进程会拿到这个句柄。 */
export const HANDLE_FLAG_INHERIT = 0x1;
/** 根本没有这个句柄时 `GetStdHandle` 的回答。 */
export const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
export const INFINITE = 0xffffffff;
export const STD_INPUT_HANDLE = -10;
export const STD_OUTPUT_HANDLE = -11;
export const STD_ERROR_HANDLE = -12;

// --- 错误 ---
export const ERROR_SUCCESS = 0;
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;

// --- 大小和偏移，x64 ---
/** SID 最大能有多大。 */
export const SECURITY_MAX_SID_SIZE = 68;
/** `SID_AND_ATTRIBUTES`：指针 + DWORD + 填充。 */
export const SID_AND_ATTRIBUTES_SIZE = 16;
/** `TOKEN_GROUPS.Groups` 的起点，在 DWORD 计数和它的填充之后。 */
export const TOKEN_GROUPS_OFFSET = 8;
/** `EXPLICIT_ACCESS_W`。 */
export const EXPLICIT_ACCESS_W_SIZE = 48;
/** 内嵌的 `TRUSTEE_W` 在它里面的起点。 */
export const TRUSTEE_W_OFFSET = 16;
/** `TRUSTEE_W.ptstrName`（SID 指针）在受托者里的偏移。 */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24;
/** `STARTUPINFOW`。 */
export const STARTUPINFOW_SIZE = 104;
/** `PROCESS_INFORMATION`。 */
export const PROCESS_INFORMATION_SIZE = 24;
