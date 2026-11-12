/**
 * 认出一个后台任务是长跑的服务（开发服务器）：它打印出了本机带端口的地址（`Local: http://localhost:5173/` 这一行）。
 *
 * 认出来就经 `TrackedJob.stand` 标成挂着的，会话不再等它结束才算闲：服务不会自己做完。起的时候和一次性的后台命令分不出来，
 * 只能看它跑起来以后说了什么。只看输出、不问系统谁在监听端口：问系统（环境卡片的端口签那样）要按平台起 ps、lsof、ss、PowerShell，
 * 还得一直轮询。已知的边界：起来不打印地址的服务认不出，照旧算在等，直到人停掉它；一次性的命令打印了本机地址（对着已有服务跑的
 * 端到端测试）会被当成服务，会话提前算闲，它结束时照样送达、叫醒会话。
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

/** 输出里有没有本机带端口的 http 地址。终端颜色先去掉：有的服务把端口单独染色，地址会被转义截断。 */
export function advertisesLocalUrl(output: string): boolean {
	// oxlint-disable-next-line no-control-regex -- 去掉终端的颜色转义。
	const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
	// oxlint-disable-next-line no-control-regex -- 终端里的其余转义同样会截断地址。
	for (const match of plain.matchAll(/https?:\/\/[^\s\x1b<>"']+/g)) {
		try {
			const url = new URL(match[0]);
			if (url.port && LOCAL_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""))) return true;
		} catch {
			// 写了一半的地址。
		}
	}
	return false;
}
