import { describe, expect, it } from "vitest";
import { listen } from "../src/listen.ts";
import { createTerminalRegistry, type Pty, type SpawnPty, type TerminalSink } from "../src/registry.ts";

interface FakePty extends Pty {
	say(chunk: string): void;
	quit(code: number): void;
	killed: boolean;
	size: [number, number];
	typed: string[];
}

function fakeSpawn() {
	const spawned: Array<{ pty: FakePty; cwd: string }> = [];
	const spawn: SpawnPty = (_file, _args, options) => {
		const data = new Set<(chunk: string) => void>();
		const exit = new Set<(event: { exitCode: number; signal?: number }) => void>();
		const pty: FakePty = {
			pid: spawned.length + 1,
			process: "zsh",
			killed: false,
			size: [options.cols, options.rows],
			typed: [],
			onData: (listener) => (data.add(listener), { dispose: () => data.delete(listener) }),
			onExit: (listener) => (exit.add(listener), { dispose: () => exit.delete(listener) }),
			write: (chunk: string) => void pty.typed.push(chunk),
			resize: (cols, rows) => void (pty.size = [cols, rows]),
			kill: () => {
				pty.killed = true;
			},
			say: (chunk) => data.forEach((listener) => listener(chunk)),
			quit: (code) => exit.forEach((listener) => listener({ exitCode: code })),
		};
		spawned.push({ pty, cwd: options.cwd });
		return pty;
	};
	return { spawn, spawned };
}

function registry(spawn: SpawnPty) {
	return createTerminalRegistry({
		spawnPty: spawn,
		platform: "darwin",
		env: { SHELL: "/bin/zsh" },
		home: "/home",
		isDirectory: (path) => path.startsWith("/work"),
	});
}

function sink() {
	const seen: string[] = [];
	let code: number | undefined;
	const target: TerminalSink = { data: (chunk) => void seen.push(chunk), exit: (exitCode) => void (code = exitCode) };
	return { target, seen, exited: () => code };
}

describe("终端注册表", () => {
	it("断开不结束 shell：断开期间的输出照样记下，再连上时整段回放", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		const tab = terminals.open("/work/a", 100, 30);
		expect(tab).toMatchObject({ number: 1, cwd: "/work/a", process: null });
		const pty = spawned[0]!.pty;
		pty.say("$ ");

		const first = sink();
		const detach = terminals.attach(tab.id, 120, 40, first.target);
		expect(first.seen).toEqual(["$ "]);
		expect(pty.size).toEqual([120, 40]);
		pty.say("ls\r\n");
		expect(first.seen).toEqual(["$ ", "ls\r\n"]);

		detach?.();
		pty.say("a.txt\r\n");
		expect(first.seen).toHaveLength(2);
		expect(pty.killed).toBe(false);

		// 尺寸给 0 是还没量到：不动 shell 的尺寸。
		const second = sink();
		terminals.attach(tab.id, 0, 0, second.target);
		expect(second.seen.join("")).toBe("$ ls\r\na.txt\r\n");
		expect(pty.size).toEqual([120, 40]);

		terminals.write(tab.id, "x");
		expect(pty.typed).toEqual(["x"]);
	});

	it("跨尺寸接回时，每段历史保留产生时的尺寸，而不是用新窗口宽度重放", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		const tab = terminals.open("/work/a", 80, 24);
		const pty = spawned[0]!.pty;
		pty.say("old");
		terminals.resize(tab.id, 120, 30);
		pty.say("wide");
		const output: Array<[string, number, number]> = [];
		terminals.attach(tab.id, 60, 20, {
			data: (...chunk) => {
				output.push(chunk);
			},
			exit: () => {},
		});
		pty.say("new");
		expect(output).toEqual([
			["old", 80, 24],
			["wide", 120, 30],
			["new", 60, 20],
		]);
		terminals.dispose();
	});

	it("shell 退出：连着的面板收到退出码，标签拿掉，订阅的人被告知", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		let changes = 0;
		terminals.onChange(() => void changes++);
		const tab = terminals.open("/work/a", 80, 24);
		const watching = sink();
		terminals.attach(tab.id, 80, 24, watching.target);
		spawned[0]!.pty.quit(3);
		expect(watching.exited()).toBe(3);
		expect(terminals.list()).toEqual([]);
		expect(changes).toBe(2);
		expect(terminals.attach(tab.id, 80, 24, sink().target)).toBeNull();
	});

	it("目录不在了起在主目录；序号不重用还开着的", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		terminals.open("/work/a", 80, 24);
		const gone = terminals.open("/deleted", 80, 24);
		terminals.open("", 80, 24);
		expect(spawned.map((entry) => entry.cwd)).toEqual(["/work/a", "/home", "/home"]);
		expect(terminals.list().map((tab) => tab.cwd)).toEqual(["/work/a", "/home", "/home"]);
		terminals.kill(gone.id);
		expect(spawned[1]!.pty.killed).toBe(true);
		expect(terminals.open("/work/a", 80, 24).number).toBe(2);
	});

	it("起不来时也是一个标签，回放出原因；不报退出", () => {
		const terminals = registry(() => {
			throw new Error("node-pty 没能加载\n第二行");
		});
		const tab = terminals.open("/work/a", 80, 24);
		const watching = sink();
		terminals.attach(tab.id, 80, 24, watching.target);
		expect(watching.seen.join("")).toContain("node-pty 没能加载\r\n第二行");
		expect(watching.exited()).toBeUndefined();
		expect(terminals.list()).toHaveLength(1);
	});

	it("跨 renderer 重复挂载按 tab 接回同一 shell，断开和新开别的标签都不回收它", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		const first = terminals.openForTab("tab-a", "/work/a", 80, 24);
		const detach = terminals.attach(first.id, 80, 24, sink().target);
		detach?.();
		spawned[0]!.pty.say("还在跑\r\n");
		expect(terminals.openForTab("tab-a", "/work/b", 100, 30)).toEqual(first);
		expect(spawned).toHaveLength(1);
		const second = sink();
		terminals.attach(first.id, 100, 30, second.target);
		expect(second.seen).toEqual(["还在跑\r\n"]);
		Array.from({ length: 20 }, (_, index) => terminals.openForTab(`other-${index}`, "/work/b", 80, 24));
		expect(spawned.every((entry) => !entry.pty.killed)).toBe(true);
		terminals.closeTab("tab-a");
		expect(spawned[0]!.pty.killed).toBe(true);
		expect(() => terminals.openForTab("tab-a", "/work/a", 80, 24)).toThrow("closed");
		terminals.dispose();
		expect(spawned.every((entry) => entry.pty.killed)).toBe(true);
	});

	it("shell 退出后可在原 tab 新开；agent 重启后也按原 tab 新建", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		const first = terminals.openForTab("stable-tab", "/work/a", 80, 24);
		spawned[0]!.pty.quit(0);
		const second = terminals.openForTab("stable-tab", "/work/a", 80, 24);
		expect(second.id).not.toBe(first.id);
		expect(terminals.openForTab("stable-tab", "/work/a", 80, 24).id).toBe(second.id);
		terminals.dispose();
		const restarted = registry(spawn);
		expect(restarted.openForTab("stable-tab", "/work/a", 80, 24).id).not.toBe(second.id);
		expect(spawned).toHaveLength(3);
		restarted.dispose();
	});

	it("关闭先于迟到的 open 时也不能留下无主 shell", () => {
		const { spawn, spawned } = fakeSpawn();
		const terminals = registry(spawn);
		terminals.closeTab("closed-tab");
		expect(() => terminals.openForTab("closed-tab", "/work/a", 80, 24)).toThrow("closed");
		expect(spawned).toHaveLength(0);
	});
});

describe("listen", () => {
	it("攒下的一批一起给；取消后送完已攒的就结束并退订", async () => {
		const controller = new AbortController();
		let emit: (value: number) => void = () => undefined;
		let unsubscribed = false;
		const stream = listen<number>(controller.signal, (push) => {
			emit = push;
			push(1);
			push(2);
			return () => void (unsubscribed = true);
		});
		const batches: number[][] = [];
		const done = (async () => {
			for await (const batch of stream) batches.push(batch);
		})();
		await new Promise((resolve) => setTimeout(resolve, 0));
		emit(3);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		await done;
		expect(batches).toEqual([[1, 2], [3]]);
		expect(unsubscribed).toBe(true);
	});
});
