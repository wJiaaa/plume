/**
 * 受限的 Windows 进程能以什么身份写，以及一条命令行怎么拼。
 *
 * 整个 Windows 后端立在两件不碰 Win32 就能说清的事上，所以单独放这里：一个代表某个目录写权限的*能力 SID*，
 * 和一条拆回参数后原样不变的*命令行*。两件都是纯字符串活，错了都无声且严重，也都能在任何机器上测，
 * 包括不是 Windows 的开发机。
 */

import { createHash } from "node:crypto";

/**
 * 一个工作区的写身份。
 *
 * `S-1-4-x-y` 是「非唯一授权机构」段：没人签发的 SID，正好是要的。它是*推出来的*而不是注册的：全部效力来自工作区目录上
 * 点名它的那条 ACE，在别处什么都不是。从路径推而不是随机生成，才稳定：同一个工作区跨会话、跨重启拿到同一个 SID，
 * 目录上的 ACE 只写一次，不是每次运行写一次。
 *
 * 路径必须已经规范化：同一个目录的两种写法会推出两个身份，第二个得再把整棵树走一遍才有意义。
 *
 * 子授权值保持在 2^30 以下且不为零：它们放在 SID 的 32 位字段里，而值为零的子授权 Windows 的工具处理得不一致。
 */
export function workspaceWriteSid(workspaceRoot: string): string {
	const digest = createHash("sha256").update(workspaceRoot, "utf8").digest();
	const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
	const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
	return `S-1-4-${first}-${second}`;
}

/**
 * 一个私有临时目录的写身份。
 *
 * 有意和工作区的身份分开：共用一个的话，任何会话都能写别的会话的临时目录，它们拿的是同一份能力。多出的末尾子授权让它
 * 不可能和两段的工作区 SID 撞上，哈希里的域分隔让两种推法不会碰巧算出同一个。
 */
export function tempWriteSid(tempDir: string): string {
	const digest = createHash("sha256").update("temp\0", "utf8").update(tempDir, "utf8").digest();
	const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
	const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
	return `S-1-4-${first}-${second}-1`;
}

/**
 * 一个参数，按 C 运行库拆回去的规则加引号。
 *
 * Windows 没有 argv：`CreateProcess` 只收一整串，每个程序自己再拆，几乎都按 CRT 的规则。所以这是那套拆法的逆运算，
 * 写错不会报引号错误，只会变成别的参数。
 *
 * 反斜杠的规则最出人意料：只有后面跟着引号时它才是转义。`C:\dir\` 是字面的，但同一串放在收尾引号前，会把那个引号转义掉、
 * 吞下整行剩下的部分。所以结尾的一串反斜杠加倍，字面引号前的一串加倍再加一。
 */
export function quoteArg(argument: string): string {
	if (argument === "") return '""';
	if (!/\s/u.test(argument) && !argument.includes('"')) return argument;

	let quoted = '"';
	for (let index = 0; index < argument.length; index++) {
		let backslashes = 0;
		while (index < argument.length && argument.charAt(index) === "\\") {
			backslashes++;
			index++;
		}
		if (index === argument.length) {
			quoted += "\\".repeat(backslashes * 2);
		} else if (argument.charAt(index) === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1) + '"';
		} else {
			quoted += "\\".repeat(backslashes) + argument.charAt(index);
		}
	}
	return `${quoted}"`;
}

/** `CreateProcess` 要的那一整串，由程序和它的参数拼成。 */
export function buildCommandLine(program: string, args: readonly string[]): string {
	return [program, ...args].map(quoteArg).join(" ");
}
