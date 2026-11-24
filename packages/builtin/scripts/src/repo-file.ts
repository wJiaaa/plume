/**
 * 逻辑入口专用的 `.plume/scripts.json` 文件读取：只读解析，绝不自动执行。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRepoScripts } from "./store.ts";
import type { RepoScriptsResult } from "./types.ts";

/** 只读读取 `<projectRoot>/.plume/scripts.json`；缺失返回 missing，解析失败返回 invalid。 */
export async function readRepoScripts(projectRoot: string): Promise<RepoScriptsResult> {
	const file = join(projectRoot, ".plume", "scripts.json");
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
		return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
	return parseRepoScripts(text);
}
