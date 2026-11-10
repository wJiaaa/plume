/**
 * 界面入口调逻辑入口的那一个对象。`apply` 时拿到一次，组件从这里取。
 */

import type { Remote } from "@plume/contract/ui";
import type { GitApi, OpResult } from "../api.ts";

let current: Remote<GitApi> | null = null;

export function setGit(remote: Remote<GitApi>): void {
	current = remote;
}

export function git(): Remote<GitApi> {
	if (!current) throw new Error("plume.git: remote not ready");
	return current;
}

/** 调用本身失败（逻辑入口没起来、停用了）也折成一个结果，面板按同一条路报出来。 */
export async function settle<T extends OpResult>(call: PromiseLike<T>): Promise<T | OpResult> {
	try {
		return await call;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 路径的最后一段；没跟踪的目录以 `/` 结尾，也取得到它的名字。 */
export function baseName(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? path;
}
