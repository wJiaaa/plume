/**
 * 回复里一条相对路径在会话工作目录里对应的文件。怎么找见 agent 的 `locateSessionFiles`。
 *
 * 不替人挑：两个 `tool-run.ts` 时挑哪个都是猜，猜错了点开的是另一份代码，比读不到更糟。拿到全部候选，
 * 同名的多份让人自己选（见 `FileChoices`）。
 */

import { useEffect, useState } from "react";

import { locateFiles } from "../files/open-file.ts";

/*
 * 找到了的一直记着：同一条路径在长对话里出现多次、滚出去再滚回来都会再问。没找到的只记几秒——可能只是
 * 文件还没写出来（回复里先提、随后才建），记死了就再也点不开；不记的话每次挂载都要再起一遍 git。
 */
const found = new Map<string, readonly string[]>();
const missed = new Map<string, number>();
const pending = new Map<string, Promise<readonly string[]>>();
const MISS_TTL = 5_000;
const NONE: readonly string[] = [];

const keyOf = (sessionId: string, relative: string) => `${sessionId}\0${relative}`;

function locate(sessionId: string, relative: string): Promise<readonly string[]> {
	const key = keyOf(sessionId, relative);
	const hit = found.get(key);
	if (hit) return Promise.resolve(hit);
	const at = missed.get(key);
	if (at !== undefined && Date.now() - at < MISS_TTL) return Promise.resolve(NONE);
	let ask = pending.get(key);
	if (!ask) {
		ask = locateFiles(sessionId, relative).then((matches) => {
			pending.delete(key);
			if (matches.length) found.set(key, matches);
			else missed.set(key, Date.now());
			return matches;
		});
		pending.set(key, ask);
	}
	return ask;
}

/**
 * 在这个会话的工作目录里找 `relative`，返回对得上的全部文件（绝对路径）。
 *
 * null 是还没找完（或 `sessionId` 为 null、不用找），调用方照旧按工作目录拼；空数组是找完了、哪里都没有。
 */
export function useLocatedPaths(sessionId: string | null, relative: string): readonly string[] | null {
	const [located, setLocated] = useState<{ sessionId: string; relative: string; paths: readonly string[] } | null>(null);
	useEffect(() => {
		if (!sessionId || found.has(keyOf(sessionId, relative))) return;
		let alive = true;
		void locate(sessionId, relative).then((paths) => {
			if (alive) setLocated({ sessionId, relative, paths });
		});
		return () => {
			alive = false;
		};
	}, [sessionId, relative]);
	if (!sessionId) return null;
	return found.get(keyOf(sessionId, relative)) ?? (located?.sessionId === sessionId && located.relative === relative ? located.paths : null);
}
