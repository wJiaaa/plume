/**
 * 别的应用点名要打开的会话：`plume://open-session?id=<会话 id>`。
 *
 * macOS 把这种地址交给主进程（`open-url`），这里只认出它说的是哪个会话。地址是外面来的，谁都能在浏览器地址栏里敲一个，
 * 所以只认这一种形状，id 也只放行会话 id 用得到的字符：它接下来要拼进 `open-session:<id>` 这条命令，冒号之类的不该进去。
 * 认不出的一律当没看见。
 *
 * scheme 写在两处：这里，和 `electron-builder.yml` 的 `mac.protocols`。包里没声明的话系统根本不会把地址送过来，
 * 而这在开发环境里看不出来，所以有一条测试守着两处一致（test/tray.test.ts）。
 */
export const APP_SCHEME = "plume";

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function sessionFromUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== "open-session") return null;
	const id = parsed.searchParams.get("id") ?? "";
	return SESSION_ID.test(id) ? id : null;
}
