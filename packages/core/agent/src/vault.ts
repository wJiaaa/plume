/**
 * 供应商的 API key 存在哪：数据目录的 `credentials.json`（加密），密钥是同目录的 `vault.key`，两个文件都是 0600。
 * `settings.json` 里不再有 key。
 *
 * 为什么不用系统钥匙串（Electron 的 safeStorage）：macOS 的安装包是 ad-hoc 签的，钥匙串条目的访问控制认的是
 * 可执行文件的哈希，每个新版本都是一个新哈希，在 macOS 看来就是另一个应用来要别人的密钥——每次更新都要重新
 * 授权或重填。而且 settings 归 agent 进程读写，safeStorage 只在主进程能用，还得把钥匙再递过来。
 *
 * 这样换来的保护和它的边界：
 * - 防的是：`settings.json` 会被同步、在机器之间拷、贴进问题报告，以前它带着所有 key、谁都能读（0644）。
 *   现在 key 不在任何会被分享的文件里，存它的两个文件只有本人可读。
 * - 不防的是：密钥就放在密文旁边，读得到家目录的程序两样都读得到。
 *
 * 以后用开发者证书签名了，钥匙串就稳定了，值得换回去：那只是 `key()` 从哪拿字节的事，下面的格式不用变。
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renameWithRetry } from "./atomic-write.ts";
import { text } from "./i18n.ts";
import type { StoredSettings } from "./models.ts";

/** AES-256-GCM：32 字节的密钥，12 字节的 nonce，16 字节的 tag。 */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Vault {
	/** `id` 下存的密钥；没有，或者这把钥匙打不开时是 null。钥匙文件读不出来时抛错（见 `unseal`）。 */
	secret(id: string): Promise<string | null>;
	/** 一次写进几条；值是空串的那条删掉，不存一个没有意义的东西。 */
	putSecrets(entries: Record<string, string>): Promise<void>;
	/** 不满足 `keep` 的都删掉：删掉的供应商，它的 key 一起忘掉。 */
	keepSecrets(keep: (id: string) => boolean): Promise<void>;
}

export function createVault(dir: string): Vault {
	const keyFile = join(dir, "vault.key");
	const file = join(dir, "credentials.json");

	/** 读过一次就留着。第一次用到时才生成：从没存过 key 的数据目录不会多出一个钥匙文件。 */
	let cached: Buffer | null = null;
	/**
	 * 正在读或生成的那把钥匙，同时来的调用共用它。两个首次使用撞在一起时各生成一把、各写一次，留在盘上的那把
	 * 就不是另一半密钥封进去时用的那把——下次启动才发现，表现是存过的 key 全都打不开了。
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
		if (existing) {
			// 被截短或手改过的钥匙不拿来用（每次都会抛错，看起来像「所有密钥都坏了」），也不覆盖：它是唯一的一份，挪到旁边。
			await rename(keyFile, `${keyFile}.bad-${Date.now()}`);
		}
		await mkdir(dir, { recursive: true });
		return (cached = await publishKey(randomBytes(KEY_BYTES)));
	}

	/**
	 * 钥匙文件的字节；只有文件不存在时是 null。别的读错误（EACCES、被扫描软件占着的 EBUSY、EMFILE）都抛出去：
	 * 当成「没有钥匙」的话会生成一把新的盖掉旧的，存过的密钥就永远打不开了。抛出去，下次调用再试，旧钥匙还在盘上。
	 */
	async function readKeyFile(): Promise<Buffer | null> {
		try {
			return await readFile(keyFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(text("vault.keyUnreadable", { path: keyFile, error: (error as Error).message }), { cause: error });
		}
	}

	/**
	 * 没人放过钥匙时才放这一把，返回最终在那里的那把。
	 *
	 * 同一个数据目录可能有两个 Plume 同时首次使用（开发版和安装版）。先写临时文件再硬链接过去：`link` 遇到已有的名字
	 * 会拒绝（EEXIST），放上去的又一定是写完的文件；直接 `wx` 建会让对方在建好和写完之间读到零字节、当成坏钥匙挪走。
	 * 不支持硬链接的文件系统（FAT、部分网络盘）退回 `wx`，那一小段窗口在那里接受。
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

	/** 别的进程先放了钥匙：用它的，绝不再来第二把。 */
	async function theirKey(): Promise<Buffer> {
		const theirs = await readKeyFile();
		if (theirs && theirs.length === KEY_BYTES) return theirs;
		throw new Error(text("vault.keyInvalid", { path: keyFile, bytes: KEY_BYTES }));
	}

	/** 一条密钥，写成能落盘的字符串。带 `v1:` 前缀：以后换格式时分得开，不是密文的值也认得出来，不拿去解。 */
	async function seal(value: string): Promise<string> {
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv("aes-256-gcm", await key(), iv);
		const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
	}

	/**
	 * 解回来；这把钥匙打不开（钥匙文件换过、密文是别的机器上来的）时是 null，调用方都把它当成「要重新填」。
	 * 钥匙文件读不出来时抛错而不是 null：null 告诉调用方密钥没了，保存设置时会把空 key 写回去、删掉那一条，
	 * 等钥匙文件过一会儿又读得出来，已经没有东西可解了。
	 */
	async function unseal(sealed: string): Promise<string | null> {
		if (!sealed.startsWith("v1:")) return null;
		const k = await key();
		try {
			const raw = Buffer.from(sealed.slice(3), "base64");
			const decipher = createDecipheriv("aes-256-gcm", k, raw.subarray(0, IV_BYTES));
			decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
			return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
		} catch {
			return null;
		}
	}

	/** `{ secrets: { [id]: 密文 } }`；读不到或读不懂都当作空的。 */
	async function read(): Promise<Record<string, string>> {
		const raw = await readFile(file, "utf8").catch(() => null);
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw) as { secrets?: unknown };
			const secrets: Record<string, string> = {};
			for (const [id, value] of Object.entries(parsed.secrets ?? {})) {
				if (typeof value === "string") secrets[id] = value;
			}
			return secrets;
		} catch {
			return {};
		}
	}

	async function write(secrets: Record<string, string>): Promise<void> {
		await mkdir(dir, { recursive: true });
		// 临时文件各用各的名字：两个 Plume 同时写时，共用一个名字会让后换名的那个找不到文件。
		const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify({ secrets }, null, 2), { mode: 0o600 });
		await renameWithRetry(tmp, file);
	}

	/** 每次写都是读、改、整份写回，排成一队，后一次不会把前一次刚写进的那条盖掉。 */
	let writing: Promise<unknown> = Promise.resolve();
	function serially(job: () => Promise<void>): Promise<void> {
		const run = writing.then(job);
		writing = run.catch(() => {});
		return run;
	}

	return {
		async secret(id) {
			const stored = (await read())[id];
			return stored === undefined ? null : unseal(stored);
		},
		putSecrets: (entries) =>
			serially(async () => {
				const secrets = await read();
				for (const [id, value] of Object.entries(entries)) {
					if (value) secrets[id] = await seal(value);
					else delete secrets[id];
				}
				await write(secrets);
			}),
		keepSecrets: (keep) =>
			serially(async () => {
				const secrets = await read();
				const kept = Object.fromEntries(Object.entries(secrets).filter(([id]) => keep(id)));
				if (Object.keys(kept).length !== Object.keys(secrets).length) await write(kept);
			}),
	};
}

/** 供应商的 key 在 vault 里的位置。 */
const providerSecretId = (providerId: string): string => `provider:${providerId}`;

/**
 * 供应商的 key 怎么进出 vault：读设置时填回 `provider.apiKey`，写设置时拿出来。
 *
 * 其余地方照旧读 `provider.apiKey`：存的位置换了，改动就停在读写设置这一处，不波及发请求和设置页。
 */
export function providerKeys(vault: Vault) {
	/**
	 * 上次读设置时因为钥匙文件读不出来而没取到的那几条（`unseal` 抛错）。这时手里的设置带着空 key，
	 * 原样写回去就会删掉存着的那份；写的时候先留着它们，等下次读出来或者有人填了新的值。
	 */
	const unreadable = new Set<string>();

	async function stored(id: string): Promise<string | null> {
		try {
			const value = await vault.secret(id);
			unreadable.delete(id);
			return value;
		} catch {
			// 设置照样读出来：少一个供应商的 key，好过应用起不来。
			unreadable.add(id);
			return null;
		}
	}

	return {
		/**
		 * 把 key 填回供应商。vault 里有的为准（两边都有时它是新的那份）；手写进 `settings.json` 的 key 照样能用，
		 * 下次保存设置时挪进 vault。Magpie 的 key 在它自己的块里，写盘时不进 vault（`fileSettings` 先拿掉了它），这里也就取不到。
		 */
		async withKeys(settings: StoredSettings): Promise<StoredSettings> {
			if (settings.providers.length === 0) return settings;
			const providers = await Promise.all(
				settings.providers.map(async (provider) => {
					const key = await stored(providerSecretId(provider.id));
					return key === null ? provider : { ...provider, apiKey: key };
				}),
			);
			return { ...settings, providers };
		},
		/**
		 * 把 key 存进 vault，返回不带 key 的设置（要写进文件的那份）。删掉的供应商、清空了的 key 同一次忘掉。
		 * `settings` 是写盘的样子（`fileSettings`），Magpie 的供应商已经不在里面。
		 */
		async takeKeys(settings: StoredSettings): Promise<StoredSettings> {
			const keys: Record<string, string> = {};
			const held = new Set<string>();
			for (const provider of settings.providers) {
				const id = providerSecretId(provider.id);
				if (!provider.apiKey && unreadable.has(id)) held.add(id);
				else keys[id] = provider.apiKey ?? "";
			}
			await vault.putSecrets(keys);
			for (const id of Object.keys(keys)) unreadable.delete(id);
			await vault.keepSecrets((id) => !id.startsWith("provider:") || id in keys || held.has(id));
			return { ...settings, providers: settings.providers.map(({ apiKey: _apiKey, ...provider }) => provider) };
		},
	};
}
