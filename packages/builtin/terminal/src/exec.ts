/**
 * 服务 `terminal.exec` 的实现：按会话在终端标签里执行命令，处理 shell 就绪探测、前导空格抑制历史、
 * 复用空闲终端时的切目录与环境变量应用，以及 `waitForExit` 随机 token 退出码哨兵观测。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { TerminalExecService, TerminalRunOptions, TerminalRunResult } from "@plume/contract";
import type { ShellDialect, TerminalPanelSignal } from "./api.ts";
import type { createTerminalRegistry } from "./registry.ts";
import { cdCommand } from "./shell.ts";

const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const DEFAULT_QUIET_MS = 2_000;
const POSIX_MAX_LINE_BYTES = 1_023;
const PARTIAL_LINE_MAX = 4_096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const utf8 = new TextEncoder();

/** 剥离 ECMA-48 CSI / OSC / 转义序列与控制字符，用于安全匹配哨兵行。 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function isFishShell(shell: string): boolean {
	return (
		basename(shell.replace(/\\/g, "/"))
			.replace(/\.exe$/i, "")
			.toLowerCase() === "fish"
	);
}

/** 编码 POSIX 脚本字节，供 `printf '%b_'` 在子 shell 里原样还原。 */
function encodePosixScript(text: string): string {
	let encoded = "";
	for (const character of text) {
		const code = character.charCodeAt(0);
		if (character === "'") {
			encoded += "'\\''";
		} else if (character === "\\" || code <= 0x1f || code === 0x7f) {
			encoded += `\\0${code.toString(8).padStart(3, "0")}`;
		} else {
			encoded += character;
		}
	}
	return encoded;
}

/** 将 POSIX 命令安全封装为单行或受限于规范 TTY 缓冲的多行，支持可选退出码哨兵。 */
export function wrapPosixCommand(command: string, token?: string): string {
	const normalized = command.replace(/\r\n/g, "\n");
	// 命令行原文将前缀与 token 拆为 printf 格式串与参数，避免 PTY 回显误触发哨兵匹配。
	const suffix = token ? `; __plume_rc=$?; printf '\\n__PLUME_EXIT_%s__:%d\\n' '${token}' "$__plume_rc"` : "";
	const evaluate = (payload: string) => `( __plume_cmd=$(printf '%b_' ${payload}); eval "\${__plume_cmd%_}" )${suffix}`;
	const inline = evaluate(`'${encodePosixScript(normalized)}'`);
	if (utf8.encode(` ${inline}\r`).byteLength <= POSIX_MAX_LINE_BYTES) return inline;

	const appendPrefix = '__plume_cmd="$__plume_cmd"';
	const maxChunkBytes = POSIX_MAX_LINE_BYTES - utf8.encode(` ${appendPrefix}''\r`).byteLength;
	const lines: string[] = [];
	let prefix = "__plume_cmd=";
	let chunk = "";
	let chunkBytes = 0;
	for (const character of normalized) {
		const encoded = encodePosixScript(character);
		const bytes = utf8.encode(encoded).byteLength;
		if (chunkBytes + bytes > maxChunkBytes) {
			lines.push(`${prefix}'${chunk}'`);
			prefix = appendPrefix;
			chunk = "";
			chunkBytes = 0;
		}
		chunk += encoded;
		chunkBytes += bytes;
	}
	lines.push(`${prefix}'${chunk}'`, `${evaluate('"$__plume_cmd"')}; unset __plume_cmd`);
	return lines.join("\r ");
}

/** 构造带退出码哨兵的命令行；cmd.exe 不支持返回 null。 */
export function wrapWaitForExitCommand(command: string, dialect: ShellDialect, shell: string, token: string): string | null {
	if (dialect === "cmd") return null;
	if (dialect === "powershell") {
		const body = command.replace(/\r?\n/g, "\r");
		return `$global:LASTEXITCODE = $null; & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__plume_rc = $LASTEXITCODE } elseif ($?) { $__plume_rc = 0 } else { $__plume_rc = 1 }; Write-Host ("__PLUME_EXIT_" + "${token}" + "__:" + $__plume_rc)`;
	}
	if (isFishShell(shell)) {
		const body = command.replace(/\r?\n/g, "\r");
		return `begin\r${body}\rend; set __plume_rc $status; printf '\\n__PLUME_EXIT_%s__:%d\\n' '${token}' $__plume_rc`;
	}
	return wrapPosixCommand(command, token);
}

/** 生成环境变量赋值语句，给复用空闲终端时应用。 */
function envStatements(dialect: ShellDialect, shell: string, env?: Record<string, string>): string[] {
	if (!env) return [];
	const statements: string[] = [];
	const fish = dialect === "posix" && isFishShell(shell);
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_NAME.test(key)) continue;
		if (dialect === "powershell") {
			statements.push(`$env:${key} = '${value.replace(/[\u0027\u2018-\u201b]/g, "$&$&")}'`);
		} else if (dialect === "cmd") {
			const clean = value.replace(/[\r\n"]/g, "");
			statements.push(`set "${key}=${clean}"`);
		} else if (fish) {
			statements.push(`set -gx ${key} '${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`);
		} else {
			statements.push(`export ${key}='${value.replaceAll("'", "'\\''")}'`);
		}
	}
	return statements;
}

/** 复用空闲终端时拼出切目录 + 环境变量 + 命令。 */
export function composeReusedCommand(
	platform: string,
	shell: string,
	dialect: ShellDialect,
	cwd: string,
	command: string,
	env?: Record<string, string>,
): string {
	const parts: string[] = [];
	if (cwd) parts.push(cdCommand(platform, shell, cwd));
	parts.push(...envStatements(dialect, shell, env));
	if (parts.length === 0) return command;
	if (dialect === "cmd") return [...parts, command].join(" && ");
	const prelude = parts.join("; ");
	return /[\r\n]/.test(command) ? `${prelude}\n${command}` : `${prelude}; ${command}`;
}

/** 生成直接写入 PTY 的命令字节，始终带前导空格以抑制 shell 历史记录。 */
export function formatShellInput(command: string, dialect: ShellDialect, shell: string, bracketed: boolean): string {
	const hasNewline = /[\r\n]/.test(command);
	if (!hasNewline) return ` ${command}\r`;
	if (dialect === "posix") {
		if (bracketed) {
			const body = command.replace(/\r?\n/g, "\r");
			return `\x1b[200~ ${body}\x1b[201~\r`;
		}
		if (isFishShell(shell)) return ` ${command.replace(/\r?\n/g, "\r")}\r`;
		return ` ${wrapPosixCommand(command)}\r`;
	}
	return ` ${command.replace(/\r?\n/g, "\r")}\r`;
}

function lineEditorReading(text: string, previous: boolean): boolean {
	const on = text.lastIndexOf(BRACKETED_PASTE_ON);
	const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
	return on === off ? previous : on > off;
}

type Registry = ReturnType<typeof createTerminalRegistry>;

/**
 * 等待新开 PTY 的 shell 进入可输入状态：
 * - POSIX 监听括号粘贴开启序列 `\x1b[?2004h`，配合静默回退与前台子进程活跃度检测；
 * - PowerShell / cmd 无行编辑器就绪信号，直接视为就绪。
 */
function waitShellReady(
	registry: Registry,
	id: string,
	dialect: ShellDialect,
	options: { signal?: AbortSignal; quietMs?: number } = {},
): Promise<{ status: "ready" | "exited" | "aborted"; bracketed: boolean }> {
	if (options.signal?.aborted) return Promise.resolve({ status: "aborted", bracketed: false });
	if (dialect !== "posix") return Promise.resolve({ status: "ready", bracketed: false });

	const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
	return new Promise((resolve) => {
		let settled = false;
		let reading = false;
		let carry = "";
		let timer: ReturnType<typeof setTimeout> | null = null;
		let unsub: (() => void) | null = null;

		const finish = (result: { status: "ready" | "exited" | "aborted"; bracketed: boolean }) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			timer = null;
			unsub?.();
			unsub = null;
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => finish({ status: "aborted", bracketed: false });
		const armQuiet = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				if (settled) return;
				const current = registry.info(id);
				if (!current) {
					finish({ status: "exited", bracketed: false });
					return;
				}
				if (current.foreground === null) {
					finish({ status: "ready", bracketed: false });
					return;
				}
				// 启动脚本还在跑子进程（如 nvm/fnm 初始化），继续等待。
				armQuiet();
			}, quietMs);
			timer.unref?.();
		};

		options.signal?.addEventListener("abort", onAbort, { once: true });
		unsub = registry.observe(id, {
			data(chunk) {
				const text = carry + chunk;
				carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
				reading = lineEditorReading(text, reading);
				if (reading) {
					finish({ status: "ready", bracketed: true });
					return;
				}
				armQuiet();
			},
			exit() {
				finish({ status: "exited", bracketed: false });
			},
		});
		if (!unsub) {
			finish({ status: "exited", bracketed: false });
			return;
		}
		armQuiet();
	});
}

/** 观测单次命令的随机 token 哨兵退出码。调用方必须在写入 PTY 之前挂载。 */
function observeExitSentinel(
	registry: Registry,
	id: string,
	token: string,
	signal?: AbortSignal,
): { promise: Promise<{ exitCode: number | null }>; cancel(): void } {
	const pattern = new RegExp(`__PLUME_EXIT_${token}__:(-?\\d+)`);
	let settled = false;
	let unsub: (() => void) | null = null;
	let lineBuffer = "";
	let resolveDone!: (result: { exitCode: number | null }) => void;
	const promise = new Promise<{ exitCode: number | null }>((resolve) => {
		resolveDone = resolve;
	});

	const finish = (exitCode: number | null) => {
		if (settled) return;
		settled = true;
		unsub?.();
		unsub = null;
		signal?.removeEventListener("abort", onAbort);
		resolveDone({ exitCode });
	};
	const onAbort = () => finish(null);

	if (signal?.aborted) {
		finish(null);
		return { promise, cancel: () => finish(null) };
	}

	const checkLine = (raw: string) => {
		const cleaned = stripAnsi(raw);
		const match = pattern.exec(cleaned);
		if (!match) return;
		const parsed = Number(match[1]);
		finish(Number.isFinite(parsed) ? parsed : null);
	};

	signal?.addEventListener("abort", onAbort, { once: true });
	unsub = registry.observe(id, {
		data(chunk) {
			lineBuffer += chunk;
			const lines = lineBuffer.split(/\r\n|\r|\n/);
			lineBuffer = lines.pop() ?? "";
			if (lineBuffer.length > PARTIAL_LINE_MAX) lineBuffer = lineBuffer.slice(-PARTIAL_LINE_MAX);
			for (const line of lines) {
				checkLine(line);
				if (settled) return;
			}
			// 若哨兵恰好停在缓冲尾部且无后续换行也检查一次。
			if (!settled && lineBuffer.includes(`__PLUME_EXIT_${token}__:`)) checkLine(lineBuffer);
		},
		exit() {
			if (!settled && lineBuffer) checkLine(lineBuffer);
			finish(null);
		},
	});
	if (!unsub) finish(null);

	return { promise, cancel: () => finish(null) };
}

export interface TerminalExecDeps {
	registry: Registry;
	emitPanel: (signal: TerminalPanelSignal) => void;
	platform?: string;
	unsupportedMessage: () => string;
	quietMs?: number;
	beforeOpen?: () => Promise<void>;
}

export function createTerminalExec(deps: TerminalExecDeps): TerminalExecService {
	const platform = deps.platform ?? process.platform;
	return {
		async run(options: TerminalRunOptions): Promise<TerminalRunResult> {
			const reveal = options.reveal ?? true;
			const idle = options.reuseIdle && !options.tag ? deps.registry.findIdleForSession(options.sessionId) : null;

			if (idle) {
				if (options.waitForExit && idle.dialect === "cmd") {
					throw new Error(deps.unsupportedMessage());
				}
				if (options.title) deps.registry.updateMetadata(idle.id, { title: options.title });
				const command = composeReusedCommand(platform, idle.shell, idle.dialect, options.cwd, options.command, options.env);
				let completion: Promise<{ exitCode: number | null }> | undefined;
				let payload: string;
				if (options.waitForExit) {
					const token = randomBytes(12).toString("hex");
					const wrapped = wrapWaitForExitCommand(command, idle.dialect, idle.shell, token);
					if (!wrapped) throw new Error(deps.unsupportedMessage());
					// 写入 PTY 之前先挂载哨兵观测。
					const observed = observeExitSentinel(deps.registry, idle.id, token, options.signal);
					completion = observed.promise;
					payload = ` ${wrapped}\r`;
				} else {
					payload = formatShellInput(command, idle.dialect, idle.shell, false);
				}
				deps.emitPanel({ type: "open", sessionId: options.sessionId, tab: idle.tab, reveal });
				deps.registry.write(idle.id, payload);
				return completion ? { tab: idle.tab, completion } : { tab: idle.tab };
			}

			await deps.beforeOpen?.();
			const tab = randomUUID();
			const opened = deps.registry.openForTab(tab, options.cwd, 80, 24, {
				sessionId: options.sessionId,
				...(options.title ? { title: options.title } : {}),
				...(options.tag ? { tag: options.tag } : {}),
				...(options.env ? { extraEnv: options.env } : {}),
			});
			const meta = deps.registry.info(opened.id);
			if (!meta || meta.unavailable) {
				deps.emitPanel({ type: "open", sessionId: options.sessionId, tab, reveal });
				return options.waitForExit ? { tab, completion: Promise.resolve({ exitCode: null }) } : { tab };
			}
			if (options.waitForExit && meta.dialect === "cmd") {
				deps.registry.closeTab(tab);
				throw new Error(deps.unsupportedMessage());
			}

			const readyPromise = waitShellReady(deps.registry, opened.id, meta.dialect, {
				signal: options.signal,
				quietMs: deps.quietMs,
			});

			let observed: { promise: Promise<{ exitCode: number | null }>; cancel(): void } | undefined;
			let wrappedCommand: string | null = null;
			if (options.waitForExit) {
				const token = randomBytes(12).toString("hex");
				wrappedCommand = wrapWaitForExitCommand(options.command, meta.dialect, meta.shell, token);
				if (!wrappedCommand) {
					deps.registry.closeTab(tab);
					throw new Error(deps.unsupportedMessage());
				}
				// 写入 PTY 之前挂载哨兵监听。
				observed = observeExitSentinel(deps.registry, opened.id, token, options.signal);
			}

			deps.emitPanel({ type: "open", sessionId: options.sessionId, tab, reveal });

			void readyPromise.then((ready) => {
				if (ready.status !== "ready") {
					observed?.cancel();
					return;
				}
				const payload = wrappedCommand !== null ? ` ${wrappedCommand}\r` : formatShellInput(options.command, meta.dialect, meta.shell, ready.bracketed);
				deps.registry.write(opened.id, payload);
			});

			return observed ? { tab, completion: observed.promise } : { tab };
		},
		async reveal(sessionId: string, tab: string): Promise<void> {
			deps.emitPanel({ type: "open", sessionId, tab, reveal: true });
		},
		async closeByTag(sessionId: string, tag: string): Promise<void> {
			const closedTabs = deps.registry.closeByTag(sessionId, tag);
			for (const tab of closedTabs) deps.emitPanel({ type: "close", sessionId, tab });
		},
	};
}
