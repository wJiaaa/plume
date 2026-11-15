/**
 * Windows 上新终端的环境：注册表里现在的，盖在本进程启动时拿到的那份上。
 *
 * 进程的环境是启动那一刻的一份拷贝。Plume 开着时装上 Node，之后开的每个终端标签仍然没有 `node`，要重启 Plume 才有；
 * 开始菜单里开的终端却有。所以每开一个标签，用注册表里的环境重建一次。别的平台不用：新 shell 会读自己的启动文件。
 *
 * 不碰 node-pty，也不碰 Electron，测试里直接调。
 */

import { execFile } from "node:child_process";
import { win32 } from "node:path";

/** Windows 的环境变量名不分大小写；普通对象（`{ ...process.env }`、测试里的）没有 `process.env` 那层代理。 */
function envValue(env: NodeJS.ProcessEnv | Record<string, string>, name: string): string | undefined {
	if (env[name] !== undefined) return env[name];
	const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

/**
 * 注册表的值盖在继承来的上面，用户的盖在机器的上面：Windows 拼登录环境就是这样。
 *
 * `PATH` 两头都例外：机器的在前、用户的在后，继承来的里多出来的目录接在最后，启动 Plume 的程序加的目录不丢。
 * `USERNAME` 跳过：机器那一份里写的是 `SYSTEM`。
 */
export function withRegistryEnv(inherited: NodeJS.ProcessEnv, machine: Record<string, string>, user: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...inherited };
	const keyOf = (name: string) => Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
	// 写在已有的拼法下：只差大小写的第二个键会让子进程两个都拿到，哪个生效由不得我们。
	const assign = (name: string, value: string) => {
		env[keyOf(name) ?? name] = value;
	};
	for (const source of [machine, user]) {
		for (const [name, value] of Object.entries(source)) {
			if (/^(path|username)$/i.test(name) || typeof value !== "string") continue;
			assign(name, value);
		}
	}
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const dir of [envValue(machine, "Path") ?? "", envValue(user, "Path") ?? "", envValue(inherited, "Path") ?? ""].join(";").split(";")) {
		const key = dir
			.trim()
			.replace(/[\\/]+$/, "")
			.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		dirs.push(dir.trim());
	}
	if (dirs.length > 0) assign("Path", dirs.join(";"));
	return env;
}

/** 注册表里的环境，已经展开；读不到时为 null。 */
type RegistryReader = () => Promise<{ machine: Record<string, string>; user: Record<string, string> } | null>;

/**
 * 用 PowerShell 读，不用 `reg query`：`reg` 按控制台代码页输出，中文 Windows 上是 GBK，中文用户名的目录读回来是乱码。
 * 这里按 UTF-8 打出 JSON，`GetEnvironmentVariables` 顺手展开 `%USERPROFILE%` 这类值。
 */
const READ_SCRIPT =
	"[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
	"@{machine=[Environment]::GetEnvironmentVariables('Machine');user=[Environment]::GetEnvironmentVariables('User')}|ConvertTo-Json -Compress -Depth 3";

export function readRegistryEnv(env: NodeJS.ProcessEnv = process.env): ReturnType<RegistryReader> {
	const root = envValue(env, "SystemRoot");
	const powershell = root ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
	return new Promise((resolve) => {
		execFile(
			powershell,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT],
			// agent 进程没有控制台，不带 windowsHide 每读一次就闪一个黑窗口。
			{ encoding: "utf8", timeout: 5_000, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve(null);
				try {
					const parsed = JSON.parse(stdout) as { machine?: Record<string, string>; user?: Record<string, string> };
					resolve({ machine: parsed.machine ?? {}, user: parsed.user ?? {} });
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/**
 * 注册表的环境，提前读好，新标签不用等 PowerShell 起来。
 *
 * 读一次要几百毫秒，每开一个标签现读太慢。所以提前读：插件启动时，和 Plume 的窗口拿到焦点时——装完东西从安装程序
 * 切回来，正是这一下。读到一半时开的标签等它一会儿；读失败或太慢就用上一次读到的，没有就用继承来的。
 */
export function createRegistryEnv(read: RegistryReader, wait = 1_500, every = 10_000) {
	let latest: { machine: Record<string, string>; user: Record<string, string> } | null = null;
	let inFlight: Promise<void> | null = null;
	let last = Number.NEGATIVE_INFINITY;

	// 不是每次拿到焦点都读：在窗口之间来回切不该每次起一个 PowerShell。从安装程序回来是几分钟以后的事，不是几秒。
	const refresh = (): void => {
		if (inFlight || Date.now() - last < every) return;
		last = Date.now();
		inFlight = read()
			.then((answer) => {
				if (answer) latest = answer;
			})
			.finally(() => {
				inFlight = null;
			});
	};

	/** 正在读的读完，或者等满 `wait`，先到哪个算哪个。 */
	const settled = async (): Promise<void> => {
		if (!inFlight) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([inFlight, new Promise<void>((done) => (timer = setTimeout(done, wait)))]);
		clearTimeout(timer);
	};

	const current = (inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv => (latest ? withRegistryEnv(inherited, latest.machine, latest.user) : inherited);

	return { refresh, settled, current };
}
