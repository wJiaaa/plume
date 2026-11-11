/**
 * 下载更新，活得比发起它的窗口长。
 *
 * 下载是一个有状态的东西，状态放在主进程，不放在某个窗口里：窗口订阅它、画它，几个窗口画同一个，关掉再开的窗口问一句就知道
 * 走到哪了。所以下载中途能关掉对话框，能暂停；暂停后继续是对已经在磁盘上的字节发 `Range` 请求，接着下，不从零开始。
 * 不理会这个头的服务器答 200 而不是 206，那就从头写，两种都对，只是慢一点。
 *
 * 不引用 electron，测试能直接加载。
 */

import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpdatePhase } from "../../shared/update.ts";
import { renameWithRetry } from "../rename-retry.ts";
import { say } from "./say.ts";
import { parseChecksums, sha256, type Verdict, verify } from "./update-checksum.ts";

/** 这里自己报的错，已经写成给人看的话；`describe` 按类型认出它们，不按文字。 */
export class DownloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DownloadError";
	}
}

/**
 * 手里的半截文件和这次的响应说该怎么办。单独拿出来，因为续传里只有这一处是判断，错了也最安静：往一个 200 后面追加，
 * 得到长度可能对、内容全错的文件。
 */
export function resumePlan(have: number, status: number): { append: boolean; from: number } | { error: string } {
	// 磁盘上什么都没有：普通下载，不管服务器以为我们要什么。
	if (have === 0) return { append: false, from: 0 };
	// 206：区间被照办了，来的接着手里的。
	if (status === 206) return { append: true, from: have };
	// 200：区间被忽略，整个文件又来一遍。从头写，不拼接。
	if (status === 200) return { append: false, from: 0 };
	// 416：要的超过了末尾，即半截文件不比安装包短。多半是同名的 release 重新构建过，不能续也不可信，调用方删掉重来。
	if (status === 416) return { error: say("update.partialMismatch") };
	return { error: say("update.downloadStatus", { status }) };
}

export type Watcher = (phase: UpdatePhase) => void;

export interface DownloadTarget {
	url: string;
	/** 下完放在哪。半截文件是旁边的 `download.part`，完整的文件永远不是半截的。 */
	file: string;
	/** release 说下完有多大，出口处核对。 */
	size: number;
	/** 发作 `User-Agent`。 */
	agent: string;
	/** release 发布的 `SHA256SUMS` 在哪；没有时下载完拒绝安装，不装没核对过的东西。 */
	checksums: string | null;
}

/**
 * 一个下载，能开始、暂停、继续。写成类：同一时刻只有一个，它是个连着网络连接的状态机，写成模块变量上的函数只会让状态更难找。
 */
export class UpdateDownload {
	private phase: UpdatePhase = { at: "idle" };
	private watchers = new Set<Watcher>();
	/** 只在字节流动时有；暂停和取消都经它 abort。 */
	private aborter: AbortController | null = null;
	/**
	 * abort 前记下「这是暂停」，后面的 catch 读它：被 abort 的流和断掉的网络抛的是同一种异常，一个是人的决定、要留着半截文件，
	 * 一个是失败、要告诉窗口，错误本身分不出来。
	 */
	private pausing = false;
	// 不写成构造参数属性：`node --test` 剥类型时那种写法会生成代码，Node 直接拒绝。
	private target: DownloadTarget;
	/** 正在跑的那一轮，`pause` 等它真的停下（阶段在它的 catch 里才变成 paused）。 */
	private running: Promise<UpdatePhase> | null = null;
	/** 正在做的下载之后那一步，见 `install`。 */
	private installing: Promise<void> | null = null;

	constructor(target: DownloadTarget) {
		this.target = target;
	}

	get state(): UpdatePhase {
		return this.phase;
	}

	watch(watcher: Watcher): () => void {
		this.watchers.add(watcher);
		// 马上说一次：刚开的窗口不用等下一块数据，暂停着的下载不会再有事件，也能画出来。
		watcher(this.phase);
		return () => this.watchers.delete(watcher);
	}

	private set(phase: UpdatePhase): void {
		this.phase = phase;
		for (const watcher of this.watchers) watcher(phase);
	}

	private get partial(): string {
		return partialPath(this.target.file);
	}

	/** 下下来的字节对 release 自己的摘要。用到时才取校验文件，它只有几百字节，不必带着走过暂停、继续。 */
	private async check(): Promise<Verdict> {
		if (!this.target.checksums) return { ok: false, reason: "no-checksums", message: say("update.noChecksums") };

		let text: string;
		try {
			const response = await fetch(this.target.checksums, { headers: { "User-Agent": this.target.agent } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			text = await response.text();
		} catch (error) {
			// 取不到摘要不等于摘要不对；分开说，不然网络问题会被报成「安装包坏了」。
			return {
				ok: false,
				reason: "no-checksums",
				message: say("update.checksumsUnreachable", { reason: error instanceof Error ? error.message : String(error) }),
			};
		}

		return verify(parseChecksums(text), basename(this.target.file), await sha256(this.partial));
	}

	private async have(): Promise<number> {
		return (await stat(this.partial).catch(() => null))?.size ?? 0;
	}

	/**
	 * 开始，或从暂停处接着下。字节下完就返回，安装是调用方的下一步。正在跑时再调答的是正在跑的那一轮：两个写入方往同一个文件
	 * 追加，得到的文件长度正好对，长度检查查不出来。
	 */
	async start(): Promise<UpdatePhase> {
		if (this.running) return this.running;
		if (this.phase.at === "preparing") return this.phase;

		this.running = this.run().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async run(): Promise<UpdatePhase> {
		// 早先那轮已经下完：不用再取，调用方还得安装。
		const done = await stat(this.target.file).catch(() => null);
		if (done && done.size === this.target.size) {
			this.set({ at: "preparing", received: this.target.size, total: this.target.size });
			return this.phase;
		}

		const have = await this.have();

		const aborter = new AbortController();
		this.aborter = aborter;
		this.pausing = false;
		this.set({ at: "downloading", received: have, total: this.target.size });

		try {
			// 已经全在了：上一轮写完了每个字节，却没能把文件挪到位（Windows 上杀毒软件还在扫刚写完的安装程序）。这时再要
			// `bytes=<size>-` 会得到 416、被当成别的 release 的半截删掉；直接去核对，对不上它自然会被删。
			if (have !== this.target.size) await this.fetchRest(have, aborter);

			// 短了是失败，不是下完：不然断在 90% 的文件会被挪到位、解包，报出来的是「更新包里没有应用」，让人去查 release 而不是网络。
			const written = await this.have();
			if (written !== this.target.size) throw new DownloadError(say("update.incomplete", { received: written, expected: this.target.size }));

			// 在半截文件上核对、对了才改名：核对不过的文件从没在最终路径上出现过，也不留给下一轮续。
			// 核对算一两秒，报成 preparing，不另立阶段。
			this.set({ at: "preparing", received: written, total: this.target.size });
			const verdict = await this.check();
			if (!verdict.ok) {
				await rm(this.partial, { force: true });
				throw new Error(verdict.message);
			}

			// 等得比设置文件久（约 7 秒）：扫描器打开刚写完的安装程序，要扫完上百兆才放手。还不放就留着核对过的半截文件，重试直接回到这一行。
			await renameWithRetry(this.partial, this.target.file, { attempts: 8, stepMs: 250 });
			this.aborter = null;
			this.set({ at: "preparing", received: this.target.size, total: this.target.size });
			return this.phase;
		} catch (error) {
			// 磁盘出错时也要停掉剩下不会再读的响应。
			aborter.abort();
			this.aborter = null;
			const received = await this.have();
			if (this.pausing) {
				// 字节留在磁盘上，半截文件有名字就是为了这个。
				this.pausing = false;
				this.set({ at: "paused", received, total: this.target.size });
				return this.phase;
			}
			this.set({ at: "failed", error: describe(error, received), received, total: this.target.size });
			return this.phase;
		}
	}

	/** 把磁盘上还没有的取进半截文件，服务器允许时接着写。 */
	private async fetchRest(have: number, aborter: AbortController): Promise<void> {
		await mkdir(dirname(this.partial), { recursive: true, mode: 0o700 });

		const response = await fetch(this.target.url, {
			signal: aborter.signal,
			headers: {
				"User-Agent": this.target.agent,
				// 有东西可接时才带：无条件的 `bytes=0-` 会让新下载也拿到 206。
				...(have > 0 ? { Range: `bytes=${have}-` } : {}),
			},
		});

		const plan = resumePlan(have, response.status);
		if ("error" in plan) {
			// 接不上的半截文件比没有更糟：下次还会去接，还会以同样的方式失败。
			await rm(this.partial, { force: true });
			throw new DownloadError(plan.error);
		}
		if (!response.body) throw new DownloadError(say("update.emptyBody"));

		// 206 的 content-length 是这一段的长度，加上已有的才是总长；都没有就用 release 说的大小。
		const chunkLength = Number(response.headers.get("content-length")) || 0;
		const total = plan.append && chunkLength > 0 ? plan.from + chunkLength : chunkLength || this.target.size;

		let received = plan.from;
		this.set({ at: "downloading", received, total });

		const sink = await openPartial(this.partial, plan.append ? "a" : "w");
		const reader = response.body.getReader();
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				// 先写完这一块再报进度；abort 读取不能丢掉已经读到的。
				await sink.writeFile(chunk.value);
				received += chunk.value.byteLength;
				this.set({ at: "downloading", received, total });
			}
			aborter.signal.throwIfAborted();
		} finally {
			reader.releaseLock();
			await sink.close();
		}
	}

	/** 停下，留着已经下好的。阶段定下来才返回；不在下载时暂停不算错，按钮画的可能是晚了一拍的状态。 */
	async pause(): Promise<void> {
		if (this.phase.at !== "downloading") return;
		this.pausing = true;
		this.aborter?.abort();
		await this.running?.catch(() => {});
	}

	/** 停下并忘掉，连半截文件一起。「取消」和「暂停」的区别。 */
	async cancel(): Promise<void> {
		this.pausing = false;
		this.aborter?.abort();
		await this.running?.catch(() => {});
		this.aborter = null;
		// 等那一轮停了再删，不然它还开着的写入会把文件再建出来。
		await rm(this.partial, { force: true }).catch(() => {});
		this.set({ at: "idle" });
	}

	/**
	 * 下完之后的那一步（macOS 先删掉再解开应用包）。同时来的几次等同一次：双击「下载」、两个窗口各点一次，都会让两次解包
	 * 往同一个目录里写，一边删一边写，得到 ENOTEMPTY 或缺文件的应用包。做完了再来的照常再做一次。
	 */
	install(job: () => Promise<void>): Promise<void> {
		this.installing ??= job().finally(() => {
			this.installing = null;
		});
		return this.installing;
	}

	/** 安装那一步备好了能换上的东西后调。 */
	finish(): void {
		this.set({ at: "ready" });
	}

	/** 下载之后的那一步失败了。 */
	fail(error: string): void {
		this.set({ at: "failed", error, received: this.target.size, total: this.target.size });
	}
}

const PREFIX = "plume-update-";

/** 一个版本的文件放在哪，一个版本一个目录，不会混。 */
export function downloadDir(root: string, version: string): string {
	return join(root, `${PREFIX}${version}`);
}

/**
 * `downloadDir` 建过的、`keep` 以外的目录。`keep` 是复数：下载途中发了新版本时，「最新的」和「正在下的」不是同一个，
 * 只按最新的清会把正在写的目录删掉。
 */
export function staleDownloads(entries: string[], keep: string | string[]): string[] {
	const kept = new Set((Array.isArray(keep) ? keep : [keep]).map((version) => `${PREFIX}${version}`));
	return entries.filter((name) => name.startsWith(PREFIX) && !kept.has(name));
}

/** 删掉已经不是最新版本的下载。尽力而为：删不掉的目录不值得告诉谁，更不值得让更新失败。 */
export async function sweepDownloads(root: string, keep: string | string[]): Promise<void> {
	const entries = await readdir(root).catch((): string[] => []);
	for (const name of staleDownloads(entries, keep)) {
		await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * 把失败说成看的人能照着做的话。undici 连接中途断了说 `terminated`、没连上说 `fetch failed`，都没说要紧的那句：
 * 已经下好的留着，「继续」会接着下。
 */
export function describe(error: unknown, received: number): string {
	if (error instanceof DownloadError) return error.message;
	const raw = error instanceof Error ? error.message : String(error);

	if (/terminated|ECONNRESET|socket hang up|aborted|other side closed/i.test(raw)) return say(received > 0 ? "update.interruptedKept" : "update.interrupted");
	if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i.test(raw)) return say("update.unreachable");
	if (isBlockedWrite(raw)) return say(received > 0 ? "update.notWritableKept" : "update.notWritable");
	return raw || say("update.downloadFailed");
}

/** 最终文件旁边的半截文件，故意不叫 `*.exe.part`。 */
export function partialPath(file: string): string {
	return join(dirname(file), "download.part");
}

function isBlockedWrite(raw: string): boolean {
	return /UNKNOWN|EPERM|EACCES|EBUSY|ELOCKED|EIO/i.test(raw) && /open/i.test(raw);
}

/** 打开半截文件；Windows 上杀毒软件可能正开着它，被拒时等一会儿再试几次。 */
async function openPartial(path: string, flags: "a" | "w") {
	for (let attempt = 0; ; attempt++) {
		try {
			return await open(path, flags, 0o600);
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			if (!isBlockedWrite(raw) || attempt === 4) throw error;
			await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
		}
	}
}
