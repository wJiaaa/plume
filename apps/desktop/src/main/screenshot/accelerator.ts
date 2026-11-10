/**
 * 插件给的截屏快捷键怎么规整成 Electron 认的 accelerator。
 *
 * 插件存下来的快捷键可能是在 Mac 上录的，写成 `Cmd` / `Command`；Windows、Linux 上 Electron 把它们当成 Win / Super 键，
 * 于是注册不上（Win+Shift+S 还是系统自己的截图键）。本意是「Mac 上 ⌘、别处 Ctrl」，那就是 `CommandOrControl`。
 * `Option` 是 macOS 对 Alt 的叫法，Electron 不认。
 */
export function normalizeShortcut(raw: string): string {
	return raw
		.trim()
		.split("+")
		.map((token) => {
			const name = token.trim();
			if (/^(cmd|command)$/i.test(name)) return "CommandOrControl";
			if (/^option$/i.test(name)) return "Alt";
			return name;
		})
		.join("+");
}
