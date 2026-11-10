/**
 * 搜索设置的读写：插件数据目录里的 `search.json`，权限 0600（里面是明文的 API key）。
 *
 * 工具每次调用都现读一遍，设置页改了下一次搜索就生效，不用重启。
 */

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
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

export function settingsFile(path: string): SettingsFile {
	let queue: Promise<unknown> = Promise.resolve();

	async function read(): Promise<SearchSettings> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { provider: null, keys: {} };
			throw error;
		}
		return normalize(JSON.parse(text));
	}

	return {
		read: () => queue.then(read),
		update(change) {
			const next = queue.then(async () => {
				const settings = normalize(change(await read()));
				// 先写临时文件再改名：写到一半退出不留半个文件。临时文件可能是上次留下的，mode 只在新建时生效，再 chmod 一次。
				const temp = `${path}.tmp`;
				await writeFile(temp, JSON.stringify(settings, null, "\t"), { mode: 0o600 });
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
