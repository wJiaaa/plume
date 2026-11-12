/**
 * 搜索设置的读写：插件数据目录里的 `search.json`，权限 0600。API key 写盘前经 `ctx.secrets` 加密，读出来时解开；
 * 解不开的（钥匙换过）当成没填，要人重新填。
 *
 * 工具每次调用都现读一遍，设置页改了下一次搜索就生效，不用重启。
 */

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import type { PluginSecrets } from "@plume/contract";
import { KEY_IDS, type KeyId, type SearchKeys, type SearchSettings, type SearchSettingsView } from "./api.ts";

export interface SettingsFile {
	read(): Promise<SearchSettings>;
	/** 改几项，返回改完的整份。写一个接一个排队：连着改两项时后一次读到的是前一次写完的结果。 */
	update(change: (settings: SearchSettings) => SearchSettings): Promise<SearchSettings>;
}

/** 文件里的东西不一定是这一版写的（手改过、坏了一半）：认得的留下，别的丢掉。 */
function normalize(raw: unknown): SearchSettings {
	const data = (typeof raw === "object" && raw !== null ? raw : {}) as { provider?: unknown; keys?: unknown };
	const keysIn = (typeof data.keys === "object" && data.keys !== null ? data.keys : {}) as Record<string, unknown>;
	const keys: SearchKeys = {};
	for (const id of KEY_IDS) {
		const value = keysIn[id];
		if (typeof value === "string" && value.trim()) keys[id] = value.trim();
	}
	return { provider: typeof data.provider === "string" && data.provider ? data.provider : null, keys };
}

/** 每把 key 换一下：加密或解开。换成 null 的（解不开）那把丢掉。 */
async function mapKeys(keys: SearchKeys, map: (value: string) => Promise<string | null>): Promise<SearchKeys> {
	const out: SearchKeys = {};
	for (const id of KEY_IDS) {
		const value = keys[id];
		const mapped = value === undefined ? null : await map(value);
		if (mapped) out[id] = mapped;
	}
	return out;
}

export function settingsFile(path: string, secrets: PluginSecrets): SettingsFile {
	let queue: Promise<unknown> = Promise.resolve();

	async function read(): Promise<SearchSettings> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { provider: null, keys: {} };
			throw error;
		}
		const settings = normalize(JSON.parse(text));
		// 手写进文件的明文原样用，下次存设置时加密。钥匙文件读不出来时 `unseal` 抛错，这里不接：
		// 当成没填的话，下一次 `update` 就把还解得开的密文冲掉了。
		return { ...settings, keys: await mapKeys(settings.keys, async (value) => (secrets.isSealed(value) ? secrets.unseal(value) : value)) };
	}

	return {
		read: () => queue.then(read),
		update(change) {
			const next = queue.then(async () => {
				const settings = normalize(change(await read()));
				const sealed = { ...settings, keys: await mapKeys(settings.keys, (value) => secrets.seal(value)) };
				// 先写临时文件再改名：写到一半退出不留半个文件。临时文件可能是上次留下的，mode 只在新建时生效，再 chmod 一次。
				const temp = `${path}.tmp`;
				await writeFile(temp, JSON.stringify(sealed, null, "\t"), { mode: 0o600 });
				await chmod(temp, 0o600);
				await rename(temp, path);
				return settings;
			});
			queue = next.catch(() => undefined);
			return next;
		},
	};
}

export function viewOf(settings: SearchSettings): SearchSettingsView {
	const keys = {} as Record<KeyId, boolean>;
	for (const id of KEY_IDS) keys[id] = Boolean(settings.keys[id]);
	return { provider: settings.provider, keys };
}
