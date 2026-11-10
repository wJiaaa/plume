/**
 * 加解密：AES-256-GCM，32 字节的钥匙是数据目录里的 `vault.key`（0600），第一次加密时才生成。
 *
 * 为什么不用系统钥匙串：macOS 的安装包是 ad-hoc 签的，钥匙串条目认的是可执行文件的哈希，每个新版本都是新哈希，
 * 每次更新都要重新授权；插件也跑在 agent 进程里，拿不到只在主进程能用的 safeStorage。以后能稳定签名了，
 * 换成钥匙串只是 `key()` 从哪拿字节的事，密文格式不用变。
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@plume/contract";
import type { Messages } from "./messages.ts";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 密文的前缀：它会和明文混在插件的配置里，前缀要认得出来；带版本号，以后换格式时分得开。 */
const PREFIX = "plume-sealed:v1:";
const SEALED = /^plume-sealed:v1:[A-Za-z0-9+/]+={0,2}$/;

export function createSealer(dir: string, text: () => Messages): SecretsService {
	const keyFile = join(dir, "vault.key");

	/** 读过一次就留着。 */
	let cached: Buffer | null = null;
	/**
	 * 正在读或生成的那把钥匙，同时来的调用共用它。两个首次加密撞在一起时各生成一把、各写一次，留在盘上的那把
	 * 就不是另一半密文用的那把——下次启动才发现，表现是存过的密钥全都打不开了。
	 */
	let pending: Promise<Buffer> | null = null;

	function key(): Promise<Buffer> {
		if (cached) return Promise.resolve(cached);
		pending ??= loadOrMakeKey().finally(() => {
			pending = null;
		});
		return pending;
	}

	async function loadOrMakeKey(): Promise<Buffer> {
		const existing = await readKeyFile();
		if (existing && existing.length === KEY_BYTES) return (cached = existing);
		// 被截短或手改过的钥匙不拿来用，也不覆盖：它是唯一的一份，挪到旁边。
		if (existing) await rename(keyFile, `${keyFile}.bad-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		return (cached = await publishKey(randomBytes(KEY_BYTES)));
	}

	/**
	 * 钥匙文件的字节；只有文件不存在时是 null。别的读错误（EACCES、被扫描软件占着的 EBUSY）都抛出去：
	 * 当成「没有钥匙」会生成一把新的盖掉旧的，存过的密文就永远打不开了。
	 */
	async function readKeyFile(): Promise<Buffer | null> {
		try {
			return await readFile(keyFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(text().keyUnreadable(keyFile, (error as Error).message), { cause: error });
		}
	}

	/**
	 * 没人放过钥匙时才放这一把，返回最终在那里的那把。同一个数据目录可能有两个 Plume 同时首次使用（开发版和安装版）：
	 * 先写临时文件再硬链接过去，`link` 遇到已有的名字会拒绝，放上去的又一定是写完的文件。
	 * 不支持硬链接的文件系统（FAT、部分网络盘）退回 `wx`。
	 */
	async function publishKey(fresh: Buffer): Promise<Buffer> {
		const tmp = `${keyFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			await writeFile(tmp, fresh, { mode: 0o600, flag: "wx" });
			await link(tmp, keyFile);
			return fresh;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") return theirKey();
			if (code !== "ENOTSUP" && code !== "EPERM" && code !== "ENOSYS" && code !== "EXDEV") throw error;
		} finally {
			await rm(tmp, { force: true }).catch(() => {});
		}
		try {
			await writeFile(keyFile, fresh, { mode: 0o600, flag: "wx" });
			return fresh;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return theirKey();
			throw error;
		}
	}

	/** 别的进程先放了钥匙：用它的。 */
	async function theirKey(): Promise<Buffer> {
		const theirs = await readKeyFile();
		if (theirs && theirs.length === KEY_BYTES) return theirs;
		throw new Error(text().keyInvalid(keyFile));
	}

	const isSealed = (value: string) => SEALED.test(value);

	return {
		async seal(value) {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv("aes-256-gcm", await key(), iv);
			const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
		},
		async unseal(sealed) {
			if (!isSealed(sealed)) return null;
			const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
			if (raw.length < IV_BYTES + TAG_BYTES) return null;
			// 从没加密过的数据目录没有钥匙：不为了解一段打不开的密文去生成一把。
			if (!cached && (await readKeyFile()) === null) return null;
			const k = await key();
			try {
				const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, IV_BYTES));
				decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
				return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
			} catch {
				return null;
			}
		},
		isSealed,
	};
}
