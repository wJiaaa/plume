/**
 * 冒烟超时时结束 Electron（scripts/stop-process.mjs）：要等它真的没了才返回，结束不掉时把原因报出来，而且不管成没成都放开管道。
 *
 * Windows 那半假装成 Windows、换掉 taskkill 来测：真的进程树和真的「已经退出了」的竞态在哪台机器上都没法按需复现。
 */

import assert from "node:assert/strict";
import childProcess, { ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { stopProcessTree } from "../scripts/stop-process.mjs";

test("结束一个不肯自己退出的子进程，而不是一直等下去", { skip: process.platform === "win32" }, async () => {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
	assert.ok(child.pid);
	const pid = child.pid;
	const started = Date.now();
	await stopProcessTree(child, 400);
	assert.ok(Date.now() - started < 3_000, `用了 ${Date.now() - started}ms`);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

function windowsFixture(t: TestContext) {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	const child = Object.assign(new ChildProcess(), { pid: 43210, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
	const killer = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
	const unref = t.mock.method(child, "unref", () => child);
	const spawned = t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
		assert.equal(command, "taskkill");
		assert.deepEqual(args, ["/PID", String(child.pid), "/T", "/F"]);
		assert.equal(options.timeout, 5_000);
		return killer;
	});
	// 内置模块的具名导入是一份拷贝，这一步才让它指向替身。
	syncBuiltinESMExports();
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => {
		spawned.mock.restore();
		syncBuiltinESMExports();
		Object.defineProperty(process, "platform", platform);
		for (const stream of [child.stdin, child.stdout, child.stderr, killer.stdout, killer.stderr]) stream.destroy();
	});
	return { child, killer, unref };
}

/** 让排着的 promise 走完，不推进假的计时器。 */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Windows：taskkill 先结束、目标的退出通知后到时，等它到了再返回", async (t) => {
	const { child, killer, unref } = windowsFixture(t);
	let settled = false;
	const outcome = stopProcessTree(child).then(
		() => {
			settled = true;
			return null;
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	killer.stderr.write("A process in the tree had already exited.");
	killer.emit("close", 128, null);
	await drained();
	assert.equal(settled, false, "taskkill 结束不等于目标已经退出");
	assert.equal(child.stdin.destroyed, false);
	// Node 先更新这个只读字段再发 exit 事件。
	Object.defineProperty(child, "exitCode", { value: 1 });
	child.emit("exit", 1, null);
	assert.equal(await outcome, null);
	assert.ok([child.stdin, child.stdout, child.stderr].every((stream) => stream.destroyed));
	assert.equal(unref.mock.callCount(), 1);
});

test("Windows：目标到点还没退出时，报出 taskkill 说了什么", async (t) => {
	const { child, killer, unref } = windowsFixture(t);
	let settled = false;
	const outcome = stopProcessTree(child).then(
		() => {
			settled = true;
			return null;
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	killer.stdout.write("Failed PID 43210. ");
	killer.stderr.write("Access is denied.");
	killer.emit("close", 1, null);
	await drained();
	t.mock.timers.tick(999);
	await drained();
	assert.equal(settled, false);
	t.mock.timers.tick(1);
	const error = await outcome;
	assert.ok(error instanceof Error);
	assert.match(error.message, /taskkill 没能结束进程 43210（退出码 1，信号 null）：Failed PID 43210\. Access is denied\./);
	assert.ok([child.stdin, child.stdout, child.stderr].every((stream) => stream.destroyed));
	assert.equal(unref.mock.callCount(), 1);
});

test("Windows：taskkill 起不来时报错，管道照样放开", async (t) => {
	const { child, killer, unref } = windowsFixture(t);
	const failure = new Error("taskkill spawn failed");
	const result = assert.rejects(stopProcessTree(child), (error) => error === failure);
	killer.emit("error", failure);
	await result;
	assert.ok([child.stdin, child.stdout, child.stderr].every((stream) => stream.destroyed));
	assert.equal(unref.mock.callCount(), 1);
});
