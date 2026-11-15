/**
 * plume.terminal 的逻辑入口：shell 跑在 agent 进程里（见 registry.ts），经 ctx.serve 开给面板。
 */

import { createRequire } from "node:module";
import { release } from "node:os";
import type { Plugin } from "@plume/contract";
import type { TerminalApi, TerminalOutput, TerminalTab } from "./api.ts";
import { listen } from "./listen.ts";
import { MESSAGES } from "./messages.ts";
import { createDirectoryRequests, type DirectoryRequest } from "./open-directory.ts";
import { createTerminalRegistry, type SpawnPty } from "./registry.ts";
import { cdCommand, findExecutable, pickShell, windowsPtyFor } from "./shell.ts";
import { createRegistryEnv, readRegistryEnv } from "./windows-env.ts";

export default {
	name: "plume.terminal",
	apply(ctx) {
		/*
		 * node-pty 在第一个终端起来时才加载，不在 apply 里。
		 *
		 * 它是原生模块：架构不对、系统的 glibc 太旧，加载就抛错。在 apply 里加载，整个插件就 failed；在 agent
		 * 进程顶上静态导入，agent 进程都起不来——为一个面板赔上全部。推到起 shell 时，失败只是一个写着原因的
		 * 标签（见 registry.ts 的 openUnavailable）。加载失败不记下，装好以后不用重启。
		 */
		const require = createRequire(import.meta.url);
		let pty: typeof import("node-pty") | undefined;
		const spawnPty: SpawnPty = (file, args, options) => {
			if (!pty) {
				try {
					pty = require("node-pty") as typeof import("node-pty");
				} catch (error) {
					ctx.log.error(`node-pty 加载失败：${error instanceof Error ? error.message : String(error)}`);
					throw new Error(MESSAGES[ctx.locale()].unavailable, { cause: error });
				}
			}
			return pty.spawn(file, args, options);
		};
		// 只在 Windows 上：别处新 shell 会按自己的启动文件重建环境。
		const fresh = process.platform === "win32" ? createRegistryEnv(() => readRegistryEnv()) : undefined;
		fresh?.refresh();
		const registry = createTerminalRegistry({ spawnPty, currentEnv: fresh && (() => fresh.current(process.env)) });
		ctx.effect(() => registry.dispose());
		// 切目录那一行按新终端会起的 shell 写（和 registry.ts 选 shell 的方式一样）：Windows 上多半是 PowerShell，POSIX 的写法在那里会坏。
		const { platform, env } = process;
		const directories = createDirectoryRequests((directory) =>
			cdCommand(
				platform,
				pickShell(platform, env, (command) => findExecutable(command, platform, env)),
				directory,
			),
		);
		ctx.sessions.onDeleted((sessionId) => {
			const pending = directories.get(sessionId);
			if (pending) directories.take(sessionId, pending.id);
		});

		const api: TerminalApi = {
			openDirectory: (sessionId, directory) => directories.open(sessionId, directory),
			runCommand: (sessionId, command) => directories.run(sessionId, command),
			takeDirectory: (sessionId, id) => directories.take(sessionId, id),
			async *watchDirectory(sessionId, call) {
				const requests = listen<DirectoryRequest | null>(call.signal, (emit) => {
					emit(directories.get(sessionId));
					return directories.subscribe(() => emit(directories.get(sessionId)));
				});
				for await (const batch of requests) yield batch[batch.length - 1] ?? null;
			},
			async *watch(call) {
				const tabs = listen<TerminalTab[]>(call.signal, (emit) => {
					emit(registry.list());
					return registry.onChange(() => emit(registry.list()));
				});
				// 每次都是完整的一份，攒下好几份时只要最新的。
				for await (const batch of tabs) yield batch[batch.length - 1] ?? [];
			},
			async open(tab, cwd, cols, rows) {
				await fresh?.settled();
				return registry.openForTab(tab, cwd, cols, rows);
			},
			async *attach(id, cols, rows, call) {
				const output = listen<TerminalOutput>(call.signal, (emit, end) => {
					const detach = registry.attach(id, cols, rows, {
						data: (data, cols, rows) => emit({ type: "data", data, cols, rows }),
						exit: (code) => {
							emit({ type: "exit", code });
							end();
						},
					});
					if (!detach) end();
					else emit({ type: "ready" });
					return detach ?? (() => undefined);
				});
				for await (const batch of output) {
					let pending: Extract<TerminalOutput, { type: "data" }> | undefined;
					for (const item of batch) {
						if (item.type === "data" && pending?.cols === item.cols && pending.rows === item.rows) pending.data += item.data;
						else {
							if (pending) yield pending;
							pending = item.type === "data" ? { ...item } : undefined;
							if (item.type !== "data") yield item;
						}
					}
					if (pending) yield pending;
				}
			},
			windowsPty: () => windowsPtyFor(process.platform, release()) ?? null,
			refreshEnv: () => fresh?.refresh(),
			write: (id, data) => registry.write(id, data),
			resize: (id, cols, rows) => registry.resize(id, cols, rows),
			close: (tab) => registry.closeTab(tab),
		};
		ctx.serve(api);
	},
} satisfies Plugin;
