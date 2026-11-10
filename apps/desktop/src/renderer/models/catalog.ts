/**
 * 界面的模型目录跟 agent 进程对齐。
 *
 * 目录是 `@plume/llm` 的模块状态，两个进程各有一份：agent 进程会从 pi.dev 更新，界面这边只有打包的快照。编辑器搜索、
 * 导入填值都在界面查目录，所以要换上 agent 进程那份。带上本地版本号去问，版本相同时回 null，随时问一句也不必每次传整份。
 */

import { activeModelCatalog, installModelCatalog } from "@plume/llm/model-catalog";
import { useSyncExternalStore } from "react";
import { modelsAgent } from "./store.ts";

const listeners = new Set<() => void>();

/** 换上 agent 进程的目录，返回当前版本号；拿不到就还是本地那份。 */
export async function pullModelCatalog(): Promise<string> {
	try {
		const document = await modelsAgent().modelCatalog(activeModelCatalog().source.revision);
		if (document && installModelCatalog(document)) for (const listener of listeners) listener();
	} catch {
		// 打包的快照照样能用。
	}
	return activeModelCatalog().source.revision;
}

/** 订阅目录版本：换了就按新目录重新渲染。 */
export function useCatalogRevision(): string {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => activeModelCatalog().source.revision,
	);
}
