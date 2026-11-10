/**
 * 后台任务监听的端口：问系统哪些进程在监听，挑出这个任务进程树里的，再用它自己打印过的本机地址补上。
 *
 * 系统表是准的，但会失败（Windows 没权限、慢机器超时）；任务输出里的 `http://127.0.0.1:5173/` 是它自己说的，
 * 系统表缺席时照样能用。两边都只认本机地址，免得把文档里的 `example.com:3000` 认成服务。
 */

import { execFile } from "node:child_process";
import { request } from "node:http";
import { promisify } from "node:util";
import type { BackgroundJobInfo } from "@plume/contract";
import type { ServiceEndpoint } from "./api.ts";

export interface ProcessEntry {
	pid: number;
	parent: number;
}

export function parseProcesses(text: string): ProcessEntry[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const parts = line.trim().split(/\s+/).map(Number);
		const [pid = 0, parent = -1] = parts;
		return parts.length === 2 && parts.every(Number.isSafeInteger) && pid > 0 && parent >= 0 ? [{ pid, parent }] : [];
	});
}

/** 一个进程和它的全部子孙：开发服务器多半是 `npm run dev` 底下再起的 node。 */
export function descendants(root: number, processes: ProcessEntry[]): Set<number> {
	const owned = new Set([root]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of processes)
			if (owned.has(entry.parent) && !owned.has(entry.pid)) {
				owned.add(entry.pid);
				changed = true;
			}
	}
	return owned;
}

function endpoint(pid: number, name: string): ServiceEndpoint[] {
	const match = /^(.*):(\d+)$/.exec(name);
	if (!match || pid <= 0) return [];
	const port = Number(match[2]);
	const address = (match[1] ?? "").replace(/^\[|\]$/g, "");
	return port > 0 && port <= 65535 ? [{ pid, address, port }] : [];
}

export function parseLsof(text: string): ServiceEndpoint[] {
	let pid = 0;
	return text.split(/\r?\n/).flatMap((line) => {
		if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
		return line.startsWith("n") ? endpoint(pid, line.slice(1)) : [];
	});
}

export function parseSs(text: string): ServiceEndpoint[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== "LISTEN") return [];
		return [...line.matchAll(/pid=(\d+)/g)].flatMap((match) => endpoint(Number(match[1]), fields[3] ?? ""));
	});
}

/** PowerShell 交回的 JSON；形状不对就整份不要，不拿半份去猜。 */
export function parseWindowsListeners(value: unknown, invalid: string): { processes: ProcessEntry[]; listeners: ServiceEndpoint[] } {
	const table = value as { processes?: unknown; listeners?: unknown } | null;
	if (!table || typeof table !== "object" || !Array.isArray(table.processes) || !Array.isArray(table.listeners)) throw new Error(invalid);
	const processes: ProcessEntry[] = [];
	const listeners: ServiceEndpoint[] = [];
	for (const row of table.processes as unknown[]) {
		const entry = row as { pid?: unknown; parent?: unknown } | null;
		if (!entry || typeof entry.pid !== "number" || typeof entry.parent !== "number" || !Number.isSafeInteger(entry.pid) || !Number.isSafeInteger(entry.parent))
			throw new Error(invalid);
		processes.push({ pid: entry.pid, parent: entry.parent });
	}
	for (const row of table.listeners as unknown[]) {
		const entry = row as { pid?: unknown; address?: unknown; port?: unknown } | null;
		if (!entry || typeof entry.pid !== "number" || typeof entry.address !== "string" || typeof entry.port !== "number") throw new Error(invalid);
		listeners.push(...endpoint(entry.pid, `${entry.address}:${entry.port}`));
	}
	return { processes, listeners };
}

function localHost(address: string): string {
	return ["*", "0.0.0.0", "::"].includes(address) ? "127.0.0.1" : address;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"];

/** 输出里和这个监听对得上的地址（端口相同、主机是本机），带上它打印的路径。 */
export function serviceUrl(listener: ServiceEndpoint, output: string): string | undefined {
	const host = localHost(listener.address);
	// oxlint-disable-next-line no-control-regex -- 终端里的颜色转义会截断地址。
	for (const match of output.matchAll(/https?:\/\/[^\s\x1b<>\x22\x27]+/g)) {
		try {
			const url = new URL(match[0]);
			if (Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== listener.port) continue;
			const advertised = url.hostname.replace(/^\[|\]$/g, "");
			if (![host, ...LOCAL_HOSTS].includes(advertised)) continue;
			url.hostname = host.includes(":") ? `[${host}]` : host;
			return url.href;
		} catch {
			/* 终端输出里常有写了一半的地址。 */
		}
	}
	return undefined;
}

/** 进程自己打印的本机地址，系统表缺席时用；只认写明端口的本机主机。 */
export function advertisedEndpoints(pid: number, output: string): ServiceEndpoint[] {
	if (pid <= 0) return [];
	const found: ServiceEndpoint[] = [];
	const seen = new Set<string>();
	// oxlint-disable-next-line no-control-regex -- 终端里的颜色转义会截断地址。
	for (const match of output.matchAll(/https?:\/\/[^\s\x1b<>\x22\x27]+/g)) {
		try {
			const url = new URL(match[0]);
			if (!url.port) continue;
			const host = url.hostname.replace(/^\[|\]$/g, "");
			if (!LOCAL_HOSTS.includes(host)) continue;
			const port = Number(url.port);
			if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) continue;
			const address = localHost(host === "localhost" ? "0.0.0.0" : host);
			const key = `${address}:${port}`;
			if (seen.has(key)) continue;
			seen.add(key);
			url.hostname = address.includes(":") ? `[${address}]` : address;
			found.push({ pid, address, port, url: url.href });
		} catch {
			/* 终端输出里常有写了一半的地址。 */
		}
	}
	return found;
}

function mergeEndpoints(fromOs: ServiceEndpoint[], fromLog: ServiceEndpoint[]): ServiceEndpoint[] {
	const seen = new Set(fromOs.map((entry) => `${localHost(entry.address)}:${entry.port}`));
	const extra = fromLog.filter((entry) => !seen.has(`${localHost(entry.address)}:${entry.port}`));
	return [...fromOs, ...extra].slice(0, 16);
}

const exec = promisify(execFile);
async function command(file: string, args: string[], timeout = 4000): Promise<string> {
	return (await exec(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
}

async function listeners(invalid: string): Promise<{ processes: ProcessEntry[]; listeners: ServiceEndpoint[] }> {
	if (process.platform === "win32") {
		// 单个进程出错不让整张表作废（Continue 而不是 Stop）；查全部进程在忙的机器上会超过 4 秒，给 15 秒，输出里的地址兜底。
		const script =
			"$p=@(); $l=@(); try { $p=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId} }) } catch {}; try { $l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $null -ne $_.OwningProcess } | ForEach-Object { @{pid=[int]$_.OwningProcess; address=[string]$_.LocalAddress; port=[int]$_.LocalPort} }) } catch {}; @{processes=$p; listeners=$l} | ConvertTo-Json -Depth 4 -Compress";
		return parseWindowsListeners(JSON.parse(await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000)), invalid);
	}
	const [processes, sockets] = await Promise.all([
		command("ps", ["-axo", "pid=,ppid="]),
		process.platform === "darwin" ? command("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]) : command("ss", ["-H", "-ltnp"]),
	]);
	return { processes: parseProcesses(processes), listeners: process.platform === "darwin" ? parseLsof(sockets) : parseSs(sockets) };
}

/** 没打印地址的监听，问一声是不是 HTTP：答了就给一个能点开的地址。 */
async function httpUrl(endpoint: ServiceEndpoint): Promise<string | undefined> {
	const host = localHost(endpoint.address);
	const url = `http://${host.includes(":") ? `[${host}]` : host}:${endpoint.port}/`;
	return new Promise((resolve) => {
		const req = request(url, { method: "HEAD" }, (response) => {
			response.resume();
			resolve(url);
		});
		const timer = setTimeout(() => req.destroy(), 700);
		req.once("close", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		req.once("error", () => resolve(undefined));
		req.end();
	});
}

export type JobWithEndpoints = BackgroundJobInfo & { endpoints: ServiceEndpoint[] };

/**
 * 给在跑、有 pid 的任务找端口。系统表一轮只问一次，几个面板同时刷新时共用同一次。
 * 问不到时 `error` 说原因，端口退回只看输出里打印的地址。
 */
export function createEndpointFinder(output: (jobId: string, sessionId: string) => Promise<string>, invalid: () => string) {
	let pending: Promise<{ processes: ProcessEntry[]; listeners: ServiceEndpoint[] }> | undefined;
	const snapshot = () => {
		pending ??= listeners(invalid()).finally(() => {
			pending = undefined;
		});
		return pending;
	};
	return async (sessionId: string, jobs: BackgroundJobInfo[]): Promise<{ jobs: JobWithEndpoints[]; error?: string }> => {
		const result: JobWithEndpoints[] = jobs.map((job) => ({ ...job, endpoints: [] }));
		const live = result.filter((job) => job.pid && job.finishedAt === undefined);
		if (!live.length) return { jobs: result };
		let table: { processes: ProcessEntry[]; listeners: ServiceEndpoint[] } = { processes: [], listeners: [] };
		let error: string | undefined;
		try {
			table = await snapshot();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		await Promise.all(
			live.map(async (job) => {
				const text = await output(job.id, sessionId).catch(() => "");
				const owned = descendants(job.pid!, table.processes);
				const fromOs = await Promise.all(
					table.listeners
						.filter((entry) => owned.has(entry.pid))
						.slice(0, 16)
						.map(async (entry) => ({ ...entry, url: serviceUrl(entry, text) ?? (await httpUrl(entry)) })),
				);
				job.endpoints = mergeEndpoints(fromOs, advertisedEndpoints(job.pid!, text));
			}),
		);
		return { jobs: result, ...(error ? { error } : {}) };
	};
}
