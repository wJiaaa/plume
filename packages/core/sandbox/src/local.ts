/**
 * 在这台机器上跑一条命令，套上这台机器能给的约束。
 *
 * 不给模式就是用户自己的 shell、目录和环境（测试直接调工具时）。给了模式就经 `confine` 包一层，
 * 这台机器给不了就抛错，不悄悄不加沙箱就跑：界面说受限、日志说受限，实际什么都没限住，比没有沙箱更糟。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { SandboxMode, SandboxProcess } from "@plume/contract";
import { commandShell, type CommandShell } from "@plume/platform";
import { confine } from "./backend.ts";
import { commandEnv } from "./login-path.ts";

/**
 * 设进子进程环境的：没人在那里回答提问。
 *
 * 等按键的分页器会卡住这一轮，颜色码到了模型那里是要跳过去读的噪音；`TERM=dumb` 一次说清两件事。其余是命令等一个
 * 不在场的人的别的方式：`GIT_EDITOR=true` 让 `git merge`、`git commit --amend` 不去开编辑器等它关；
 * `GIT_TERMINAL_PROMPT=0` 让没凭据的 HTTPS 远端立刻失败而不是提问；`AWS_PAGER` 让 AWS 命令行别把结果塞进 `less`；
 * `DEBIAN_FRONTEND` 让 apt 别在不存在的终端上提问；`PYTHONIOENCODING` 让 Python 往管道里写 UTF-8。
 */
const QUIET_ENV = {
	TERM: "dumb",
	NO_COLOR: "1",
	GIT_PAGER: "cat",
	PAGER: "cat",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	AWS_PAGER: "",
	DEBIAN_FRONTEND: "noninteractive",
	PYTHONIOENCODING: "utf-8",
};

/**
 * shell 退出后再读多久。
 *
 * 没重定向的 `npm run dev &` 让开发服务器拿着 shell 的 stdout，管道永远不关，已经跑完的命令就要等满整个超时，
 * 超时到了还把服务器一起杀掉——那正是 `&` 要的东西。shell 自己的退出就是命令完了：之前写下的输出几毫秒内就到，
 * 再晚到的属于被放到后台的那个。
 */
const DRAIN_AFTER_EXIT_MS = 250;

export function runCommand(
	command: string,
	options: { cwd: string; env?: Record<string, string>; mode?: SandboxMode; shellMode?: SandboxMode; shell?: CommandShell },
): SandboxProcess {
	/*
	 * 命令是照哪个 shell 写的，就用哪个跑：按会话宣布的模式选（系统提示词里告诉模型的那个），不按这一次提权到的模式。
	 * Windows 上受约束的命令跑在 PowerShell 里、不受约束的跑在 Git Bash 里，提权成完全访问的 PowerShell 命令仍是 PowerShell。
	 */
	const shell = options.shell ?? commandShell(options.shellMode ?? options.mode);
	// 登录 shell 的环境，再是安静设置，再是调用方要的。`commandEnv` 补回从图标启动时缺的 `PATH` 和启动文件导出的变量。
	const env: NodeJS.ProcessEnv = { ...commandEnv(process.env), ...QUIET_ENV, ...options.env };
	// 沙箱包在 shell 外面：shell 一启动就已经在里面，而不是围着一个已经在跑的 shell。
	const wrap = options.mode ? confine({ mode: options.mode, workspaceRoot: options.cwd }) : null;
	/*
	 * stdin 是 `/dev/null` 而不是管道：读 stdin 的命令（`read`、裸 `cat`、问「继续吗 [y/N]」的安装程序）
	 * 立刻读到文件尾，接着做或者报它自己的错，而不是对着没人写的管道等满超时。
	 * detached：命令自成一个进程组，停的时候连它起的子进程一起停。Windows 上没有进程组，detached 反而会给它开一个新控制台，
	 * 停整棵树靠 taskkill（见 `killTree`）。windowsHide：agent 进程没有控制台，起控制台程序不带它就闪一个黑窗口、抢走焦点。
	 */
	const spawnOptions = {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
		env,
	};
	const child: ChildProcess = wrap
		? // 我们自己的 runner 要 `ELECTRON_RUN_AS_NODE`，别的包装什么都不加。
			spawn(wrap.command, [...wrap.args, shell.file, ...shell.args(command)], { ...spawnOptions, env: { ...env, ...wrap.env } })
		: spawn(shell.file, shell.args(command), spawnOptions);
	// 交给流来解码而不是一段一段 `toString`：跨段的汉字会被切成两个替换字符。
	const streams: Readable[] = [child.stdout, child.stderr].filter((stream): stream is Readable => stream !== null && stream !== undefined);
	for (const stream of streams) stream.setEncoding("utf8");

	/*
	 * 退出只报一次：输出齐了，或者输出已经不归这条命令了的时候。
	 *
	 * 通常是 shell 退出、每条流都读到了尾。退出了还有流开着，就是上面 `DRAIN_AFTER_EXIT_MS` 说的后台进程：
	 * 宽限期过后报退出，还拿着输出的东西作为 `lingering` 交出去。宽限期到了之后再让一次事件循环：
	 * 进程忙得超过宽限期时，计时器会抢在 shell 退出前写下的输出之前触发，丢掉结尾。
	 */
	const exitListeners: Parameters<SandboxProcess["onExit"]>[0][] = [];
	let reported = false;
	let lingering = false;
	let drain: ReturnType<typeof setTimeout> | undefined;
	const report = (code: number | null, signal: NodeJS.Signals | null, rest?: SandboxProcess) => {
		if (reported) return;
		reported = true;
		if (drain) clearTimeout(drain);
		for (const listener of exitListeners) listener(code, signal, rest);
	};
	const killTree = (signal: "SIGTERM" | "SIGKILL") => {
		if (!child.pid) return;
		// shell 有一棵进程树，只杀 shell 会把它起的开发服务器留下。
		if (process.platform === "win32") {
			// Windows 没有 POSIX 的 SIGTERM；不带 /F 的 taskkill 停不了控制台程序。停不掉而进程还活着时报出来。
			execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
				if (error && child.exitCode === null && child.signalCode === null) child.emit("error", error);
			});
			return;
		}
		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
		}
	};
	/** shell 走了以后还拿着管道的东西。 */
	const rest: SandboxProcess = {
		get pid() {
			return child.pid;
		},
		onOutput(listener) {
			for (const stream of streams) stream.on("data", listener);
		},
		onExit(listener) {
			let open = streams.length;
			const closed = () => {
				if (--open === 0) listener(null, null);
			};
			for (const stream of streams) stream.once("close", closed);
		},
		onError() {},
		kill(signal = "SIGKILL") {
			// shell 已经不在了，它的进程组还在，信号是给进程组的。
			if (streams.some((stream) => !stream.closed)) killTree(signal);
		},
	};
	let exited: [number | null, NodeJS.Signals | null] | undefined;
	const ended = () => streams.every((stream) => stream.readableEnded || stream.destroyed);
	const settle = () => {
		if (exited && ended()) report(...exited);
	};
	for (const stream of streams) {
		stream.once("end", settle);
		stream.once("close", settle);
	}
	// 没能启动的命令不报退出，它的流也不该留下来。
	child.on("error", () => {
		for (const stream of streams) stream.destroy();
	});
	child.on("exit", (code, signal) => {
		exited = [code, signal];
		// 没人读的流永远等不到文件尾，读进空里。
		for (const stream of streams) if (!stream.readableFlowing) stream.resume();
		if (ended()) return report(code, signal);
		drain = setTimeout(
			() =>
				setImmediate(() => {
					if (reported) return;
					if (ended()) return report(code, signal);
					lingering = true;
					for (const stream of streams) {
						stream.removeAllListeners("data");
						// 读空，话多的后台任务不会因为管道满而卡住；不占引用，不会因此拖住进程退出。
						stream.resume();
						(stream as { unref?: () => void }).unref?.();
					}
					report(code, signal, rest);
				}),
			DRAIN_AFTER_EXIT_MS,
		);
		drain.unref?.();
	});

	return {
		get pid() {
			return child.pid;
		},
		onOutput(listener) {
			for (const stream of streams) stream.on("data", listener);
		},
		onExit(listener) {
			exitListeners.push(listener);
		},
		onError(listener) {
			child.on("error", listener);
		},
		kill(signal = "SIGKILL") {
			if (lingering) return rest.kill(signal);
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			killTree(signal);
		},
	};
}
